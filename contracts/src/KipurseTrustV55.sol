// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";

import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/// Kipurse V5.5 owner controls (NOT audited) = KipurseTrustV5 + KipurseTrustV54 (inline signer grant) in one contract, plus:
///  - KR-01: the inline payee trust ("approve & remember", ownerApproval tag KPTR) is signed over its OWN typed data
///    OwnerInlineTrust. trustBySig only accepts OwnerTrust, the inline path only accepts OwnerInlineTrust, so an inline
///    signature can never be landed as a stored trust record (and a trustBySig signature can never be used inline). Inline
///    trusts are re-verified on every payment through the wallet's ERC-1271, i.e. through the CURRENT phone key of the key
///    seat: setKey / clearKey revoke every inline trust signed by the old key (THREAT_MODEL I-7).
///  - KR-05: the inline payee trust gets the same record checks as setTrust (merchant == keccak256(name), name non-empty,
///    1..16 non-zero payees, 0 < single <= daily). Expiry: either NO_EXPIRY (see inlinePayeeTrust) or a finite expiry at most
///    MAX_TRUST (365 days, the same bound as stored trusts) from now (V55-07).
///  - KR-07: owner-designated recovery address (setRecovery, msg.sender = the wallet only) used by the adapter when a
///    transfer to the wallet itself fails (e.g. the wallet is USDC-blocklisted) while reconciling the float.
/// Created by KipurseAdapterV55's constructor, so `core` is the adapter and owner typed data keeps the adapter as
/// verifyingContract (domain "Kipurse Owner", version "5", unchanged from V5 / V5.4). Every setter acts on msg.sender = the
/// agent wallet itself (owner via execute), or on an owner EIP-712 signature checked through the wallet's ERC-1271.
contract KipurseTrustV55 {
    struct TrustParams { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }
    struct TrustRecord { uint64 epoch; uint64 expiry; bool active; uint160 single; uint160 daily; }
    struct Binding { bytes32 merchant; uint64 epoch; }
    struct SignerTrust { bytes32 merchant; string name; address[] signers; uint160 single; uint160 daily; uint64 expiry; }

    uint256 public constant MAX_TRUST = 365 days;
    uint64 public constant NO_EXPIRY = type(uint64).max;
    uint256 public constant EXECUTOR_PAUSE = 24 hours;
    bytes32 public constant TRUST_TYPEHASH = keccak256(
        "OwnerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
    );
    /// KR-01: the inline payee trust's own primary type (same fields as OwnerTrust, different type name => different hash).
    bytes32 public constant INLINE_TRUST_TYPEHASH = keccak256(
        "OwnerInlineTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant UNTRUST_TYPEHASH = keccak256("OwnerUntrust(address account,bytes32 merchant,bytes32 nonce,uint256 deadline)");
    bytes32 public constant DENY_SIGNER_TYPEHASH = keccak256("OwnerDenySigner(address account,address signer,bytes32 nonce,uint256 deadline)");
    bytes32 public constant SIGNER_TRUST_TYPEHASH = keccak256(
        "OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public immutable core;

    mapping(address => bool) public paused;          // owner / guardian pause (until the owner unpauses)
    mapping(address => uint256) public pausedUntil;  // executor pause (expires by itself)
    mapping(address => mapping(address => bool)) public deniedPayee;
    mapping(address => mapping(address => bool)) public deniedSigner;
    mapping(address => bool) public registryOptOut;
    /// M3 micropayment float: max USDC the executor may move into the float vault per day (0 = float disabled). Owner-set.
    mapping(address => uint160) public floatCap;
    mapping(address => mapping(bytes32 => TrustRecord)) public trustOf;
    mapping(address => mapping(address => Binding)) public trustedPayee;
    mapping(address => mapping(address => Binding)) public trustedSigner;
    mapping(address => mapping(bytes32 => bool)) public ownerNonceUsed;
    /// KR-07: owner-designated fallback recipient for float returns when the wallet itself cannot receive USDC (0 = the payer vault).
    mapping(address => address) public recoveryOf;

    event Paused(address indexed account, bool paused, address by, uint256 until);
    event PayeeDenied(address indexed account, address indexed payee, bool denied);
    event SignerDenied(address indexed account, address indexed signer, bool denied);
    event RegistryOptOut(address indexed account, bool optOut);
    event FloatCapSet(address indexed account, uint160 cap);
    event Trusted(address indexed account, bytes32 indexed merchant, string name, uint64 epoch, address[] payees, address[] signers, uint160 single, uint160 daily, uint64 expiry);
    event Untrusted(address indexed account, bytes32 indexed merchant, uint64 epoch);
    event RecoverySet(address indexed account, address recovery);

    constructor() { core = msg.sender; }

    // ---------------- owner (msg.sender = the wallet) ----------------
    /// @notice Owner (msg.sender is the wallet): pause or unpause all payments; unpausing also clears an executor pause.
    function setPaused(bool v) external { paused[msg.sender] = v; if (!v) pausedUntil[msg.sender] = 0; emit Paused(msg.sender, v, msg.sender, 0); }
    /// @notice Owner: deny or allow a payee address.
    function setDeniedPayee(address payee, bool v) external { deniedPayee[msg.sender][payee] = v; emit PayeeDenied(msg.sender, payee, v); }
    /// @notice Owner: deny or allow a merchant order signer.
    function setDeniedSigner(address signer, bool v) external { deniedSigner[msg.sender][signer] = v; emit SignerDenied(msg.sender, signer, v); }
    /// @notice Owner: set the daily float cap (0 disables the float).
    function setFloatCap(uint160 cap) external { floatCap[msg.sender] = cap; emit FloatCapSet(msg.sender, cap); }
    /// @notice Owner: ignore the shared merchant registry (only own trust applies).
    function setRegistryOptOut(bool v) external { registryOptOut[msg.sender] = v; emit RegistryOptOut(msg.sender, v); }
    /// @notice Owner: trust a merchant (payees, signers, single and daily caps, expiry).
    function setTrust(TrustParams calldata t) external { _setTrust(msg.sender, t); }
    /// @notice Owner: remove trust in a merchant.
    function untrust(bytes32 merchant) external { _untrust(msg.sender, merchant); }
    /// @notice Owner only (no BySig form): where float returns go if the wallet cannot receive USDC (0 = the payer vault).
    function setRecovery(address to) external { recoveryOf[msg.sender] = to; emit RecoverySet(msg.sender, to); }

    // ---------------- owner by signature ----------------
    /// @notice Relayed owner signature: trust a merchant (OwnerTrust; nonce + deadline, replay-safe).
    function trustBySig(address account, TrustParams calldata t, bytes32 nonce, uint256 deadline, bytes calldata sig) external {
        bytes32 sh = keccak256(abi.encode(TRUST_TYPEHASH, account, t.merchant, keccak256(bytes(t.name)), trustOf[account][t.merchant].epoch,
            keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
        _consumeOwnerSig(account, sh, nonce, deadline, sig);
        _setTrust(account, t);
    }
    /// @notice Relayed owner signature: remove trust in a merchant.
    function untrustBySig(address account, bytes32 merchant, bytes32 nonce, uint256 deadline, bytes calldata sig) external {
        _consumeOwnerSig(account, keccak256(abi.encode(UNTRUST_TYPEHASH, account, merchant, nonce, deadline)), nonce, deadline, sig);
        _untrust(account, merchant);
    }
    /// @notice Relayed owner signature: deny a merchant signer.
    function denySignerBySig(address account, address signer, bytes32 nonce, uint256 deadline, bytes calldata sig) external {
        _consumeOwnerSig(account, keccak256(abi.encode(DENY_SIGNER_TYPEHASH, account, signer, nonce, deadline)), nonce, deadline, sig);
        deniedSigner[account][signer] = true;
        emit SignerDenied(account, signer, true);
    }

    // ---------------- core-only: pause on behalf of a live permission's executor / guardian ----------------
    /// @notice Adapter only: executor pause of 24h (or permanent when the owner asked for it).
    function pauseFor(address account, address by, bool permanent) external returns (uint256 until) {
        require(msg.sender == core, Core());
        if (permanent) paused[account] = true;
        else { until = block.timestamp + EXECUTOR_PAUSE; pausedUntil[account] = until; }
        emit Paused(account, true, by, until);
    }

    // ---------------- inline (stateless) owner authorizations ----------------
    /// @notice Struct hash of an inline payee trust (OwnerInlineTrust) at the CURRENT trust epoch of t.merchant.
    function inlineTrustStructHash(address account, TrustParams memory t, bytes32 nonce, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(INLINE_TRUST_TYPEHASH, account, t.merchant, keccak256(bytes(t.name)), trustOf[account][t.merchant].epoch,
            keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
    }
    /// @notice Verify an inline payee trust for `payee`; reverts unless valid. data = abi.encode(TrustParams, nonce, deadline, sig).
    ///  Reusable until min(expiry, deadline), the owner's untrust(merchant) (epoch bump) or a phone-key change (ERC-1271).
    ///  Expiry is finite (<= MAX_TRUST from now, like stored trusts) or exactly NO_EXPIRY = 2^64-1. NO_EXPIRY is the owner's
    ///  product decision (t553 / t554, kept for V5.5 in handbook §6#119): "approve & remember" has no time limit and ends only
    ///  when the owner revokes it - untrust(merchant) / untrustBySig, setDeniedPayee, pause, or a phone-key change
    ///  (seat.setKey / clearKey). Together with an unbounded deadline it is a reusable bearer approval within its caps
    ///  (THREAT_MODEL KL-2); per-payment and daily caps, policy caps, pause and deny lists still apply to every use.
    function inlinePayeeTrust(address account, address payee, bytes calldata data) external view returns (bytes32 merchant, uint160 single, uint160 daily) {
        (TrustParams memory t, bytes32 nonce, uint256 dline, bytes memory sig) = abi.decode(data, (TrustParams, bytes32, uint256, bytes));
        require(bytes(t.name).length != 0 && t.merchant == keccak256(bytes(t.name)), TrustName());
        require(t.signers.length == 0 && t.payees.length != 0 && t.payees.length <= 16, Trust());
        require(t.single != 0 && t.single <= t.daily, TrustCaps());
        require(block.timestamp < t.expiry && (t.expiry == NO_EXPIRY || t.expiry <= block.timestamp + MAX_TRUST), TrustExpiry());
        require(block.timestamp < dline, SigExpired());
        bool listed;
        for (uint256 i; i < t.payees.length; ++i) {
            require(t.payees[i] != address(0), TrustPayee());
            if (t.payees[i] == payee) listed = true;
        }
        require(listed, PayeeBinding());
        require(SignatureChecker.isValidSignatureNow(account, ownerDigest(inlineTrustStructHash(account, t, nonce, dline)), sig), Approval());
        return (t.merchant, t.single, t.daily);
    }

    /// @notice Struct hash of an owner signer-trust grant at the CURRENT epoch (what the owner / phone signs via ownerDigest).
    function signerTrustStructHash(address account, SignerTrust memory t, bytes32 nonce, uint256 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(SIGNER_TRUST_TYPEHASH, account, t.merchant, keccak256(bytes(t.name)), trustOf[account][t.merchant].epoch,
            keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
    }
    /// @notice Verify an inline signer-trust grant for `signer`; reverts unless valid. data = abi.encode(SignerTrust, nonce, deadline, sig).
    function inlineSignerTrust(address account, address signer, bytes calldata data) external view returns (bytes32 merchant, uint160 single, uint160 daily) {
        require(!deniedSigner[account][signer], BadSignerDenied()); // owner deny-list wins over any grant
        (SignerTrust memory t, bytes32 nonce, uint256 dline, bytes memory sig) = abi.decode(data, (SignerTrust, bytes32, uint256, bytes));
        require(bytes(t.name).length != 0 && t.merchant == keccak256(bytes(t.name)), TrustName());
        require(t.signers.length != 0 && t.signers.length <= 16, Trust());
        require(t.single != 0 && t.single <= t.daily, TrustCaps());
        require(block.timestamp < t.expiry && t.expiry <= block.timestamp + MAX_TRUST, TrustExpiry());
        require(block.timestamp < dline, SigExpired());
        bool listed;
        for (uint256 i; i < t.signers.length; ++i) {
            require(t.signers[i] != address(0), TrustSigner());
            if (t.signers[i] == signer) listed = true;
        }
        require(listed && signer != address(0), Signer());
        require(SignatureChecker.isValidSignatureNow(account, ownerDigest(signerTrustStructHash(account, t, nonce, dline)), sig), Approval());
        return (t.merchant, t.single, t.daily);
    }

    // ---------------- views for the core ----------------
    /// @notice True while the owner pause or a timed executor pause is active.
    function isPaused(address account) public view returns (bool) { return paused[account] || block.timestamp < pausedUntil[account]; }
    /// (paused, payee denied, registry opt-out) in one call.
    function gate(address account, address payee) external view returns (bool, bool, bool) {
        return (isPaused(account), deniedPayee[account][payee], registryOptOut[account]);
    }
    /// Live owner trust of a payee: merchant = 0 if none / expired / stale.
    function payeeTrust(address account, address payee) external view returns (bytes32 m, uint160 single, uint160 daily) {
        Binding memory b = trustedPayee[account][payee];
        TrustRecord memory t;
        if (_live(account, b)) { t = trustOf[account][b.merchant]; return (b.merchant, t.single, t.daily); }
    }
    /// Live owner trust of a signer: merchant = 0 if none; bound = the payee belongs to the SAME merchant record (C2).
    function signerTrust(address account, address signer, address payee) external view returns (bytes32 m, uint160 single, uint160 daily, bool bound) {
        Binding memory sb = trustedSigner[account][signer];
        if (!_live(account, sb)) return (bytes32(0), 0, 0, false);
        TrustRecord memory t = trustOf[account][sb.merchant];
        Binding memory pb = trustedPayee[account][payee];
        return (sb.merchant, t.single, t.daily, pb.merchant == sb.merchant && pb.epoch == sb.epoch);
    }
    /// @notice Replay-safe owner digest for BySig / inline actions (domain bound to the adapter and chain).
    function ownerDigest(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01",
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Kipurse Owner"), keccak256("5"), block.chainid, core)), structHash));
    }

    // ---------------- internals ----------------
    function _live(address account, Binding memory b) internal view returns (bool) {
        if (b.merchant == bytes32(0)) return false;
        TrustRecord memory t = trustOf[account][b.merchant];
        return t.active && t.epoch == b.epoch && block.timestamp < t.expiry;
    }
    function _setTrust(address account, TrustParams calldata t) internal {
        require(t.merchant == keccak256(bytes(t.name)) && bytes(t.name).length != 0, TrustName());
        require(t.payees.length != 0 && t.payees.length <= 16 && t.signers.length <= 16, Trust());
        require(t.single != 0 && t.single <= t.daily, TrustCaps());
        require(t.expiry > block.timestamp && t.expiry <= block.timestamp + MAX_TRUST, TrustExpiry()); // stored records never permanent
        TrustRecord storage r = trustOf[account][t.merchant];
        uint64 epoch = r.epoch + 1;
        r.epoch = epoch; r.active = true; r.expiry = t.expiry; r.single = t.single; r.daily = t.daily;
        for (uint256 i; i < t.payees.length; i++) {
            require(t.payees[i] != address(0), TrustPayee());
            trustedPayee[account][t.payees[i]] = Binding(t.merchant, epoch);
        }
        for (uint256 i; i < t.signers.length; i++) {
            require(t.signers[i] != address(0), TrustSigner());
            trustedSigner[account][t.signers[i]] = Binding(t.merchant, epoch);
        }
        emit Trusted(account, t.merchant, t.name, epoch, t.payees, t.signers, t.single, t.daily, t.expiry);
    }
    function _untrust(address account, bytes32 merchant) internal {
        TrustRecord storage r = trustOf[account][merchant];
        r.epoch += 1; r.active = false;
        emit Untrusted(account, merchant, r.epoch);
    }
    function _consumeOwnerSig(address account, bytes32 structHash, bytes32 nonce, uint256 deadline, bytes calldata sig) internal {
        require(block.timestamp < deadline, SigExpired());
        require(!ownerNonceUsed[account][nonce], SigNonce());
        ownerNonceUsed[account][nonce] = true;
        require(SignatureChecker.isValidSignatureNow(account, ownerDigest(structHash), sig), OwnerSig());
    }
}
