// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";

import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/// Kipurse V5 owner controls (development only; NOT audited). Split out of the payment core to fit EIP-170.
/// Created by KipurseAdapterV5's constructor, so `core` is the adapter and owner typed data keeps the adapter as
/// verifyingContract ("Kipurse Owner" v5). Every setter acts on msg.sender = the agent wallet itself (owner via execute),
/// or on an owner EIP-712 signature checked through the wallet's ERC-1271 (anyone, normally the executor, relays).
contract KipurseTrustV5 {
    struct TrustParams { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }
    struct TrustRecord { uint64 epoch; uint64 expiry; bool active; uint160 single; uint160 daily; }
    struct Binding { bytes32 merchant; uint64 epoch; }

    uint256 public constant MAX_TRUST = 365 days;
    uint256 public constant EXECUTOR_PAUSE = 24 hours;
    bytes32 public constant TRUST_TYPEHASH = keccak256(
        "OwnerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
    );
    bytes32 public constant UNTRUST_TYPEHASH = keccak256("OwnerUntrust(address account,bytes32 merchant,bytes32 nonce,uint256 deadline)");
    bytes32 public constant DENY_SIGNER_TYPEHASH = keccak256("OwnerDenySigner(address account,address signer,bytes32 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public immutable core;

    mapping(address => bool) public paused;          // owner / guardian pause (until the owner unpauses)
    mapping(address => uint256) public pausedUntil;  // executor pause (expires by itself)
    mapping(address => mapping(address => bool)) public deniedPayee;
    mapping(address => mapping(address => bool)) public deniedSigner;
    mapping(address => bool) public registryOptOut;
    /// M3 micropayment float: max USDC the executor may move into the float vault per day (0 = float disabled). Owner-set.
    mapping(address => uint160) public floatCap;
    event FloatCapSet(address indexed account, uint160 cap);
    mapping(address => mapping(bytes32 => TrustRecord)) public trustOf;
    mapping(address => mapping(address => Binding)) public trustedPayee;
    mapping(address => mapping(address => Binding)) public trustedSigner;
    mapping(address => mapping(bytes32 => bool)) public ownerNonceUsed;

    event Paused(address indexed account, bool paused, address by, uint256 until);
    event PayeeDenied(address indexed account, address indexed payee, bool denied);
    event SignerDenied(address indexed account, address indexed signer, bool denied);
    event RegistryOptOut(address indexed account, bool optOut);
    event Trusted(address indexed account, bytes32 indexed merchant, string name, uint64 epoch, address[] payees, address[] signers, uint160 single, uint160 daily, uint64 expiry);
    event Untrusted(address indexed account, bytes32 indexed merchant, uint64 epoch);

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

    // ---------------- owner by signature ----------------
    /// @notice Relayed owner signature: trust a merchant (nonce + deadline, replay-safe).
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
    /// @notice Replay-safe owner digest for BySig actions (domain bound to this contract and chain).
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
        require(t.expiry > block.timestamp && t.expiry <= block.timestamp + MAX_TRUST, TrustExpiry()); // never permanent
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
