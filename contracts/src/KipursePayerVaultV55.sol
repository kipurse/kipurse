// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";
import "./KipurseErrorsV55.sol";

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {PackedUserOperation, IEIP3009} from "./KipurseAdapterV5.sol";
import {KipurseTrustV55} from "./KipurseTrustV55.sol";
import {KipurseFloatVaultV55} from "./KipurseFloatVaultV55.sol";

/// Per-owner payer vault, V5.5 (NOT audited). Same role as PayerVaultV5 (one EIP-1167 clone per agent wallet; every payment
/// leaves from here; ERC-1271 for adapter-reserved EIP-3009 digests and session-signed paymaster permits; ERC-4337 v0.7
/// account whose gas is paid in USDC through an allowlisted paymaster; owner exit via withdraw / sweep). Changes:
///  - KR-02 / KR-08: each x402 reservation is stored with its EIP-3009 nonce. `reserved()` (used by pay / withdraw / sweep /
///    refund / execute, i.e. never inside ERC-4337 validation) counts only reservations whose nonce the token has NOT yet
///    marked used (`authorizationState(this, nonce)`), so a reservation the facilitator already settled stops blocking
///    payments, withdrawals and cancels at once, before anyone calls adapter.markSettled.
///  - V55-05 (ERC-7562): the ERC-1271 permit path runs inside the paymaster's validation, so it reads only the vault's own
///    cached `reservedTotal` (sum of all tracked reservations, settled-but-not-yet-pruned ones included: conservative) and
///    USDC balanceOf(vault) (associated storage) - no external call in a loop. Settled entries leave the cache through
///    adapter.markSettled, a new reservation (pruning) or the permissionless `sync()`.
///  - V55-06: at most MAX_OPEN unexpired reservations and MAX_TRACKED tracked entries; expired unsettled ones are released by
///    anyone with adapter.reclaim.
///  - V55-03: `refund` (adapter only) sends min(amount, unreserved) and reports what was available and whether the wallet
///    accepted it, so the owner's cancel / anyone's reclaim never gets stuck; the owner's withdraw / sweep also resets the
///    paymaster allowances to 0 so a stale gas allowance can never pull USDC that backs a reservation (I-8).
///  - KR-03 / V55-02: the vault is bound to ONE permission hash and its end (set with the session by
///    adapter.registerPermission); the adapter only accepts the vault as executor for that permission.
contract PayerVaultV55 {
    using SafeERC20 for IERC20;
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 internal constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    /// Unexpired x402 reservations a vault may hold at once.
    uint256 public constant MAX_OPEN = 16;
    /// Tracked entries in total (unexpired + expired-not-yet-reclaimed + settled-not-yet-pruned); bounds every loop.
    uint256 public constant MAX_TRACKED = 48;
    address public immutable adapter;
    IERC20 public immutable token;
    address public immutable entryPoint;
    address public immutable paymaster;   // allowlisted USDC paymaster (Circle v0.7 on Base / Base Sepolia)
    address public immutable paymaster2;  // optional second (e.g. Circle v0.8); 0 = none
    address internal immutable TRUST;     // adapter.trust(), cached
    address internal immutable FACTORY;
    bytes32 internal immutable TOKEN_DOMAIN;

    struct Res { bytes32 nonce; uint64 validBefore; uint32 slot; uint128 value; } // slot = index + 1 in openList (0 = none)
    address public account;               // the owner's agent wallet (set once by the factory at clone time)
    mapping(bytes32 => Res) internal res_; // EIP-3009 digest => reservation
    bytes32[] internal openList;
    address public sessionSigner; // = Policy.executor of the registered permission (signs userOps; holds no funds)
    uint256 public maxGasPerOp;   // = Policy.maxNetworkFee (owner-signed ceiling of USDC gas per userOp)
    bytes32 public permissionHash; // KR-03: the one SPM permission this vault executes for
    uint48 public permissionEnd;   // V55-02: end of that permission
    uint256 public reservedTotal;  // V55-05: sum of the values of all tracked reservations (own storage; read in validation)
    address public bundlerFeeTo;  // optional, OWNER-set: bundler operator paid per op (0 = off)
    uint96 public maxBundlerFee;  // OWNER-set ceiling of that per-op fee (atomic USDC)
    bool private transient feePaid; // at most one bundler fee per userOp execution
    /// Session userOps per UTC day; 0 = DEFAULT_OPS_PER_DAY. Enforced in validation without reading the clock (ERC-7562): the
    /// nonce key must be the UTC day index and the EntryPoint checks the returned validAfter/validUntil window of that day.
    uint32 public maxOpsPerDay;
    uint256 public constant DEFAULT_OPS_PER_DAY = 500;
    uint256 public constant MAX_OPS_PER_DAY = 100_000;

    event Swept(uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Session(address indexed signer, uint256 maxGasPerOp, bytes32 indexed permissionHash);
    event BundlerFee(address indexed to, uint256 maxPerOp);
    event OpsCapSet(uint256 opsPerDay);

    constructor(IERC20 token_, address adapter_, address trust_) {
        adapter = adapter_; token = token_; TRUST = trust_; FACTORY = msg.sender;
        PayerVaultFactoryV55 f = PayerVaultFactoryV55(msg.sender);
        entryPoint = f.entryPoint(); paymaster = f.paymaster(); paymaster2 = f.paymaster2();
        bytes32 d;
        try IEIP3009(address(token_)).DOMAIN_SEPARATOR() returns (bytes32 x) { d = x; } catch {}
        TOKEN_DOMAIN = d;
    }
    /// @notice Factory only, once per clone: bind the clone to the owner's wallet.
    function init(address account_) external {
        require(msg.sender == FACTORY && account == address(0) && account_ != address(0), Vault());
        account = account_;
    }

    modifier onlyAdapter() { require(msg.sender == adapter, BadAdapter()); _; }

    /// @notice Adapter only (registerPermission): session signer, per-op USDC gas ceiling, bound permission hash and its end.
    function setSession(address signer, uint256 maxGas, bytes32 ph, uint48 end) external onlyAdapter {
        sessionSigner = signer; maxGasPerOp = maxGas; permissionHash = ph; permissionEnd = end; emit Session(signer, maxGas, ph);
    }
    /// @notice Owner wallet only: optional per-op bundler fee pass-through (to = 0 disables).
    function setBundlerFee(address to, uint96 maxPerOp) external {
        require(msg.sender == account, NotAccount());
        bundlerFeeTo = to; maxBundlerFee = maxPerOp; emit BundlerFee(to, maxPerOp);
    }

    // ---------------- ERC-4337 v0.7 account ----------------
    /// @notice EntryPoint only: valid iff the session signer signed userOpHash (EIP-191) and gas is paid by an allowlisted
    ///  paymaster. Never pays ETH: a non-zero missingAccountFunds (no paymaster) reverts.
    function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingAccountFunds) external returns (uint256) {
        require(msg.sender == entryPoint, NotEntryPoint());
        require(missingAccountFunds == 0, NoEth());
        require(op.paymasterAndData.length >= 20 && _isPaymaster(address(bytes20(op.paymasterAndData[:20]))), Target());
        uint256 day = op.nonce >> 64; // nonce key = UTC day index
        uint256 cap = maxOpsPerDay == 0 ? DEFAULT_OPS_PER_DAY : maxOpsPerDay;
        require(day != 0 && day < 1e9 && uint64(op.nonce) < cap, OpsPerDay());
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(h, op.signature);
        uint256 sigFailed = e == ECDSA.RecoverError.NoError && r != address(0) && r == sessionSigner ? 0 : 1;
        uint256 validAfter = day * 1 days; uint256 validUntil = validAfter + 1 days - 1;
        return sigFailed | (validUntil << 160) | (validAfter << 208);
    }
    /// @notice Owner wallet only: session userOps allowed per UTC day (0 = default 500, at most MAX_OPS_PER_DAY).
    function setOpsPerDay(uint32 n) external {
        require(msg.sender == account, NotAccount());
        require(n <= MAX_OPS_PER_DAY, OpsPerDay());
        maxOpsPerDay = n; emit OpsCapSet(n == 0 ? DEFAULT_OPS_PER_DAY : n);
    }
    /// @notice Effective session userOps per UTC day (what validateUserOp enforces).
    function opsPerDay() external view returns (uint256) { return maxOpsPerDay == 0 ? DEFAULT_OPS_PER_DAY : maxOpsPerDay; }
    /// @notice EntryPoint only: one allowed call (adapter, the trust contract's three BySig relays, USDC approve of an
    ///  allowlisted paymaster <= maxGasPerOp, or the owner-configured bundler fee).
    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        feePaid = false;
        _exec(target, value, data);
    }
    struct Call { address target; uint256 value; bytes data; }
    /// @notice EntryPoint only: several allowed calls, atomically.
    function executeBatch(Call[] calldata calls) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        feePaid = false;
        for (uint256 i; i < calls.length; i++) _exec(calls[i].target, calls[i].value, calls[i].data);
    }
    function _exec(address target, uint256 value, bytes calldata data) internal {
        require(value == 0, NoEth());
        if (target == TRUST && target != address(0)) { // only the owner-signed BySig relays, nothing else on TRUST
            require(data.length >= 4, Target());
            bytes4 sel = bytes4(data[:4]);
            require(sel == KipurseTrustV55.trustBySig.selector || sel == KipurseTrustV55.untrustBySig.selector
                || sel == KipurseTrustV55.denySignerBySig.selector, Target());
        }
        if (target != adapter && (target != TRUST || target == address(0))) {
            require(target == address(token) && data.length == 68, Target());
            (address to, uint256 amt) = abi.decode(data[4:], (address, uint256));
            address replaced; // R2-01: an approve REPLACES that paymaster's allowance; every other outstanding allowance counts
            if (bytes4(data[:4]) == IERC20.approve.selector) {
                require(_isPaymaster(to), Target());
                require(amt <= maxGasPerOp, GasCap());
                replaced = to;
            } else {
                require(bytes4(data[:4]) == IERC20.transfer.selector && to != address(0) && to == bundlerFeeTo && !feePaid, Target());
                require(amt <= maxBundlerFee, GasCap());
                feePaid = true;
            }
            // gas never eats unsettled x402 funds: balance >= reserved + this outflow + what the paymasters may still pull
            require(token.balanceOf(address(this)) >= reserved() + amt + _allowanceOut(replaced), Reserved());
        }
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    function _allowanceOut(address except) internal view returns (uint256 a) {
        if (paymaster != except) a = token.allowance(address(this), paymaster);
        if (paymaster2 != address(0) && paymaster2 != except) a += token.allowance(address(this), paymaster2);
    }
    function _isPaymaster(address a) internal view returns (bool) { return a != address(0) && (a == paymaster || a == paymaster2); }
    /// @notice True for an allowlisted USDC paymaster.
    function isPaymaster(address a) external view returns (bool) { return _isPaymaster(a); }

    // ---------------- x402 reservations (KR-02 / KR-08) ----------------
    /// @notice USDC that still backs open x402 reservations the facilitator has NOT settled yet.
    function reserved() public view returns (uint256 r) {
        uint256 n = openList.length;
        for (uint256 i; i < n; ++i) {
            Res storage x = res_[openList[i]];
            if (!IEIP3009(address(token)).authorizationState(address(this), x.nonce)) r += x.value;
        }
    }
    /// @notice Vault balance not backing an unsettled reservation (the amount anyone may sweep back to the owner).
    function unreserved() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this)); uint256 r = reserved();
        return bal > r ? bal - r : 0;
    }
    /// @notice validBefore of an open reservation digest (0 = none).
    function approvedUntil(bytes32 digest) external view returns (uint256) { return res_[digest].validBefore; }
    /// @notice Stored reservation of a digest (nonce, validBefore, value); zero when none / closed / pruned after settlement.
    function reservation(bytes32 digest) external view returns (bytes32 nonce, uint256 validBefore, uint256 value) {
        Res storage x = res_[digest]; return (x.nonce, x.validBefore, x.value);
    }
    /// @notice Number of reservations tracked by the vault (unsettled ones plus settled ones not yet pruned / closed).
    function openCount() external view returns (uint256) { return openList.length; }

    /// @notice Adapter only: reserve `value` for one EIP-3009 authorization digest (nonce = `nonce`) until `validBefore`.
    function approveDigest(bytes32 digest, uint256 validBefore, uint256 value, bytes32 nonce) external onlyAdapter {
        require(res_[digest].slot == 0 && validBefore != 0 && validBefore <= type(uint64).max && value <= type(uint128).max, Digest());
        uint256 live = _prune();
        require(live < MAX_OPEN && openList.length < MAX_TRACKED, TooManyReservations());
        openList.push(digest);
        res_[digest] = Res(nonce, uint64(validBefore), uint32(openList.length), uint128(value));
        reservedTotal += value;
    }
    /// @notice Anyone: drop reservations the facilitator already settled from the tracked list / cached total (never in
    ///  validation). Returns the number of unexpired, unsettled entries left.
    function sync() external returns (uint256 live) { return _prune(); }
    function _prune() internal returns (uint256 live) {
        for (uint256 i = openList.length; i > 0; --i) {
            bytes32 d = openList[i - 1];
            Res storage x = res_[d];
            if (IEIP3009(address(token)).authorizationState(address(this), x.nonce)) _remove(d);
            else if (x.validBefore > block.timestamp) ++live;
        }
    }
    /// @notice Adapter only: release the reservation for `digest` (settled, reclaimed or cancelled). No-op if already pruned.
    function close(bytes32 digest) external onlyAdapter { _remove(digest); }
    function _remove(bytes32 digest) internal {
        uint256 slot = res_[digest].slot;
        if (slot == 0) return;
        uint256 last = openList.length;
        if (slot != last) { bytes32 m = openList[last - 1]; openList[slot - 1] = m; res_[m].slot = uint32(slot); }
        openList.pop();
        reservedTotal -= res_[digest].value;
        delete res_[digest];
    }

    // ---------------- outgoing ----------------
    /// Adapter-only outgoing transfer. Can never touch funds backing unsettled reservations.
    function pay(address to, uint256 amount) external onlyAdapter {
        require(amount <= unreserved(), Reserved());
        token.safeTransfer(to, amount);
    }
    /// @notice Adapter only (V55-03): refund up to `amount` to `to` from unreserved USDC; never reverts for lack of funds.
    ///  `paid` = min(amount, unreserved()) (the caller reports any shortfall); `delivered` = false if the token refused the
    ///  transfer (e.g. blocklisted `to`): `paid` then stays here, unreserved, withdrawable by the owner.
    function refund(address to, uint256 amount) external onlyAdapter returns (uint256 paid, bool delivered) {
        uint256 u = unreserved();
        paid = amount < u ? amount : u;
        if (paid == 0) return (0, true);
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, paid)));
        delivered = ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
    /// V55-03: the owner's withdraw / sweep revokes any outstanding paymaster allowance, so gas can never be pulled later from
    /// USDC that backs a reservation.
    function _resetGasAllowance() internal {
        if (token.allowance(address(this), paymaster) != 0) token.forceApprove(paymaster, 0);
        if (paymaster2 != address(0) && token.allowance(address(this), paymaster2) != 0) token.forceApprove(paymaster2, 0);
    }

    /// @notice ERC-1271, two paths: (a) an open, unexpired digest the adapter reserved (x402; signature ignored);
    ///  (b) a USDC EIP-2612 permit for an allowlisted paymaster, value <= maxGasPerOp, signed by the session signer.
    ///  Permit signature = abi.encode(spender, value, nonce, deadline, ecdsaSig); the vault recomputes the digest.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        // ERC-7562 (OP-011): TIMESTAMP is read ONLY for a stored x402 reservation digest (never on the permit path, which runs
        // inside paymaster validation). Such a digest is never a permit digest, so an expired one is simply invalid.
        uint256 vb = res_[hash].validBefore;
        if (vb != 0) return vb > block.timestamp ? MAGIC : bytes4(0xffffffff);
        if (signature.length < 192 || TOKEN_DOMAIN == bytes32(0)) return bytes4(0xffffffff);
        (address sp, uint256 value, uint256 nonce, uint256 deadline, bytes memory sig) = abi.decode(signature, (address, uint256, uint256, uint256, bytes));
        if (!_isPaymaster(sp) || value > maxGasPerOp) return bytes4(0xffffffff);
        // the paymaster pulls at most `value`: it must come from USDC that does not back an unsettled reservation.
        if (token.balanceOf(address(this)) < reservedTotal + value) return bytes4(0xffffffff); // V55-05: no external loop here
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", TOKEN_DOMAIN, keccak256(abi.encode(PERMIT_TYPEHASH, address(this), sp, value, nonce, deadline))));
        if (d != hash) return bytes4(0xffffffff);
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, sig);
        return e == ECDSA.RecoverError.NoError && r != address(0) && r == sessionSigner ? MAGIC : bytes4(0xffffffff);
    }

    /// Anyone: return unreserved USDC (merchant refunds, stray transfers) to the owner's wallet. A third party leaves the
    /// USDC gas buffer (4 x maxGasPerOp) so it cannot strand the vault; the owner's wallet sweeps everything (exit).
    function sweep() external returns (uint256 amount) {
        address acct = account;
        amount = unreserved();
        uint256 keep = msg.sender == acct ? 0 : 4 * maxGasPerOp;
        amount = amount > keep ? amount - keep : 0;
        if (msg.sender == acct) _resetGasAllowance();
        if (amount != 0) token.safeTransfer(acct, amount);
        emit Swept(amount);
    }

    /// Owner exit path (msg.sender must be the agent wallet, i.e. the owner via execute). Works with our service down.
    /// For USDC only the unreserved part is withdrawable; open reservations are closed via adapter.cancelReservation
    /// (owner, any time) or adapter.reclaim (anyone, after expiry). Other tokens sent here can always be withdrawn.
    function withdraw(IERC20 t, address to, uint256 amount) external {
        require(msg.sender == account, NotAccount());
        if (address(t) == address(token)) { require(amount <= unreserved(), Reserved()); _resetGasAllowance(); }
        t.safeTransfer(to, amount);
        emit Withdrawn(address(t), to, amount);
    }
}

/// Vault deployer, V5.5. Each adapter calls `prepare` once (from its constructor) to create the two shared implementations;
/// vaults are then EIP-1167 minimal-proxy clones (CREATE2, salt = account). The caller becomes the adapter, so only vaults
/// created BY the adapter sit at adapter.vaultAddress(account).
contract PayerVaultFactoryV55 {
    address public immutable entryPoint;
    address public immutable paymaster;
    address public immutable paymaster2;
    mapping(address => address) public vaultImpl; // adapter => PayerVaultV55 implementation
    mapping(address => address) public floatImpl; // adapter => KipurseFloatVaultV55 implementation
    constructor(address entryPoint_, address paymaster_, address paymaster2_) { entryPoint = entryPoint_; paymaster = paymaster_; paymaster2 = paymaster2_; }
    /// @notice Once per adapter (msg.sender): deploy the shared payer-vault and float-vault implementations.
    function prepare(IERC20 token, address trust_) external {
        require(vaultImpl[msg.sender] == address(0), Vault());
        vaultImpl[msg.sender] = address(new PayerVaultV55(token, msg.sender, trust_));
        floatImpl[msg.sender] = address(new KipurseFloatVaultV55(token, msg.sender));
    }
    /// @notice Clone (CREATE2) the per-account payer vault for the calling adapter. `token` is fixed by the implementation.
    function deploy(address account, IERC20) external returns (address v) {
        address impl = vaultImpl[msg.sender];
        require(impl != address(0), Vault());
        v = Clones.cloneDeterministic(impl, bytes32(uint256(uint160(account))));
        PayerVaultV55(v).init(account);
    }
    /// @notice Deterministic payer-vault address for an account (0 if the adapter never prepared).
    function vaultAddress(address adapter, address account, IERC20) external view returns (address) {
        address impl = vaultImpl[adapter];
        return impl == address(0) ? address(0) : Clones.predictDeterministicAddress(impl, bytes32(uint256(uint160(account))));
    }
    /// @notice Clone (CREATE2) the per-account float vault for the calling adapter.
    function deployFloat(address account, IERC20) external returns (address v) {
        address impl = floatImpl[msg.sender];
        require(impl != address(0), Vault());
        v = Clones.cloneDeterministic(impl, bytes32(uint256(uint160(account))));
        KipurseFloatVaultV55(v).init(account);
    }
    /// @notice Deterministic float-vault address for an account.
    function floatAddress(address adapter, address account, IERC20) external view returns (address) {
        address impl = floatImpl[adapter];
        return impl == address(0) ? address(0) : Clones.predictDeterministicAddress(impl, bytes32(uint256(uint160(account))));
    }
}
