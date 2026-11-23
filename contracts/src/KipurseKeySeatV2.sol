// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {FCL_ecdsa} from "FreshCryptoLib/FCL_ecdsa.sol";
import {FCL_Elliptic_ZZ} from "FreshCryptoLib/FCL_elliptic.sol";
import {ICbswReplaySafe} from "./KipursePhoneApproverV4.sol";

interface ICbswFactoryViewV2 { function getAddress(bytes[] calldata owners, uint256 nonce) external view returns (address); }
/// The ONLY things the seat reads from the trust contract: the adapter it belongs to (once, at construction) and the
/// per-merchant trust epoch. Typehashes, struct hashing and the EIP-712 domain are built inside the seat (V55-01).
interface IKipurseTrustV55Epoch {
    function core() external view returns (address);
    function trustOf(address account, bytes32 merchant) external view returns (uint64 epoch, uint64 expiry, bool active, uint160 single, uint160 daily);
}

/// Kipurse FACE ID KEY SEAT V2 (V5.5, handbook §6#119; NOT audited). = KipurseKeySeatV1 plus:
///  - KL-5: setKey only accepts a P-256 public key that is on the curve (and not the zero / "no key" value); signatures
///    must be canonical low-s (0 < r < n, 0 < s <= n/2), so a signature can never be re-presented in its malleable form.
///  - KIND_INLINE_TRUST (6): the phone may approve a V5.5 inline payee trust (KipurseTrustV55 OwnerInlineTrust). Kind 1
///    (KIND_TRUST) stays the stored-trust form for trustBySig; the two digests differ, so neither can be used as the other.
///  - V55-01: the seat builds EVERY digest itself: the six Kipurse typehashes and the EIP-712 domain
///    ("Kipurse Owner", "5", block.chainid, ADAPTER) are hard-coded; the trust contract and its adapter are immutable (fixed at
///    construction and part of the CREATE2 address). The only value read from the trust contract per signature is the merchant
///    trust epoch, which can change a field inside a Kipurse struct but never turn the digest into anything else (a UserOp,
///    permit, spend permission or owner change). There is no way to repoint the seat: a later Kipurse version needs a new wallet.
///
/// ONE permanent owner per Kipurse wallet, set when the wallet is CREATED by the Coinbase factory with owners
/// [owner's Base Account, this seat, SpendPermissionManager]. After that no owner is ever added or removed. The seat holds the
/// CURRENT phone P-256 key (iPhone Secure Enclave, Face ID-gated). New phone / reinstall / Face ID off = the WALLET itself
/// (the owner confirming a normal call in the Coinbase popup) calls setKey / clearKey. Old keys stop working at once, and
/// with them every inline trust / signer grant / approval signed by the old key (THREAT_MODEL I-7).
///
/// Scope: the wallet asks isValidSignature(hash, data) for every owner check. The seat only answers "valid" when `data`
/// carries the full preimage of a Kipurse trust / untrust / deny-signer / pay / signer-trust / inline-trust digest for THIS
/// wallet on the fixed V5.5 adapter and `hash == wallet.replaySafeHash(seat.ownerDigest(structHash))`, plus a P-256
/// signature over `hash` by the current key. A UserOp, token permit, spend permission or owner change has no such preimage
/// -> invalid. It has no function that calls the wallet, so it can never use an owner's msg.sender powers.
///
/// Address: CREATE2 through the deterministic deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C with
///   salt = keccak256("kipurse-key-seat-v2"), initcode = type(KipurseKeySeatV2).creationCode ‖ abi.encode(cbswFactory, owner, SPM, trustV55)
/// (NO phone key), so the seat and the wallet address [owner, seat, SPM] are fixed by the owner's Base Account before opening.
contract KipurseKeySeatV2 {
    uint8 public constant KIND_TRUST = 1;
    uint8 public constant KIND_UNTRUST = 2;
    uint8 public constant KIND_DENY_SIGNER = 3;
    uint8 public constant KIND_PAY = 4;
    uint8 public constant KIND_SIGNER_TRUST = 5;
    uint8 public constant KIND_INLINE_TRUST = 6;
    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)");
    bytes32 public constant TRUST_TYPEHASH = keccak256(
        "OwnerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)");
    bytes32 public constant INLINE_TRUST_TYPEHASH = keccak256(
        "OwnerInlineTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)");
    bytes32 public constant UNTRUST_TYPEHASH = keccak256("OwnerUntrust(address account,bytes32 merchant,bytes32 nonce,uint256 deadline)");
    bytes32 public constant DENY_SIGNER_TYPEHASH = keccak256("OwnerDenySigner(address account,address signer,bytes32 nonce,uint256 deadline)");
    bytes32 public constant SIGNER_TRUST_TYPEHASH = keccak256(
        "OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)");
    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 internal constant N = FCL_Elliptic_ZZ.n;
    uint256 internal constant HALF_N = FCL_Elliptic_ZZ.n / 2;
    struct SignerTrust { bytes32 merchant; string name; address[] signers; uint160 single; uint160 daily; uint64 expiry; }
    struct TrustParams { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }

    /// The one Coinbase Smart Wallet this seat serves: factory address for owners [owner, this, spm], nonce 0.
    address public immutable wallet;
    /// Kipurse V5.5 trust contract (epoch source) and its adapter (= EIP-712 verifyingContract), both fixed forever.
    IKipurseTrustV55Epoch public immutable trust;
    address public immutable adapter;
    /// Current phone key (0,0 = Face ID off: nothing is valid). `keyEpoch` counts every change (for the app / server to follow).
    uint256 public x;
    uint256 public y;
    uint64 public keyEpoch;

    event KeySet(uint64 indexed epoch, uint256 x, uint256 y);
    event KeyCleared(uint64 indexed epoch);
    error OnlyWallet();
    error BadKey();

    constructor(address factory_, address owner_, address spm_, address trust_) {
        require(factory_ != address(0) && owner_ != address(0) && spm_ != address(0) && trust_ != address(0), "args");
        bytes[] memory owners = new bytes[](3);
        owners[0] = abi.encode(owner_); owners[1] = abi.encode(address(this)); owners[2] = abi.encode(spm_);
        wallet = ICbswFactoryViewV2(factory_).getAddress(owners, 0);
        trust = IKipurseTrustV55Epoch(trust_);
        adapter = IKipurseTrustV55Epoch(trust_).core();
        require(adapter != address(0), "core");
    }

    modifier onlyWallet() { if (msg.sender != wallet) revert OnlyWallet(); _; }

    /// Register / replace the phone key. Only the wallet itself (owner confirms wallet.execute(seat, 0, setKey(...))).
    /// KL-5: the key must be a valid P-256 point (on the curve, coordinates < p, neither coordinate 0).
    function setKey(uint256 x_, uint256 y_) external onlyWallet {
        if (x_ == 0 || y_ == 0 || (x_ == x && y_ == y) || !FCL_Elliptic_ZZ.ecAff_isOnCurve(x_, y_)) revert BadKey();
        x = x_; y = y_; emit KeySet(++keyEpoch, x_, y_);
    }
    /// Face ID off / phone lost: no phone signature is valid any more.
    function clearKey() external onlyWallet { x = 0; y = 0; emit KeyCleared(++keyEpoch); }

    /// data = abi.encode(uint8 kind, bytes body, uint256 r, uint256 s).
    function isValidSignature(bytes32 hash, bytes calldata data) external view returns (bytes4) {
        if (x == 0) return 0xffffffff;
        (uint8 kind, bytes memory body, uint256 r, uint256 s) = abi.decode(data, (uint8, bytes, uint256, uint256));
        if (r == 0 || r >= N || s == 0 || s > HALF_N) return 0xffffffff; // KL-5: canonical low-s only
        bytes32 sh = structHashOf(kind, body);
        if (sh == bytes32(0)) return 0xffffffff;
        if (hash != ICbswReplaySafe(wallet).replaySafeHash(ownerDigest(sh))) return 0xffffffff;
        if (!_p256(hash, r, s)) return 0xffffffff;
        return 0x1626ba7e;
    }

    /// @notice EIP-712 digest of a Kipurse owner struct, built here (domain "Kipurse Owner" / "5" / chainId / ADAPTER).
    function ownerDigest(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01",
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Kipurse Owner"), keccak256("5"), block.chainid, adapter)), structHash));
    }

    /// The Kipurse struct hash for an allowed action (0 if not allowed). Same as KipurseTrustV55's own hashing.
    function structHashOf(uint8 kind, bytes memory body) public view returns (bytes32) {
        if (kind == KIND_TRUST || kind == KIND_INLINE_TRUST) {
            (TrustParams memory t, bytes32 nonce, uint256 deadline) = abi.decode(body, (TrustParams, bytes32, uint256));
            (uint64 epoch,,,,) = trust.trustOf(wallet, t.merchant);
            bytes32 th = kind == KIND_TRUST ? TRUST_TYPEHASH : INLINE_TRUST_TYPEHASH;
            return keccak256(abi.encode(th, wallet, t.merchant, keccak256(bytes(t.name)), epoch,
                keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
        }
        if (kind == KIND_UNTRUST) {
            (bytes32 merchant, bytes32 nonce, uint256 deadline) = abi.decode(body, (bytes32, bytes32, uint256));
            return keccak256(abi.encode(UNTRUST_TYPEHASH, wallet, merchant, nonce, deadline));
        }
        if (kind == KIND_DENY_SIGNER) {
            (address signer, bytes32 nonce, uint256 deadline) = abi.decode(body, (address, bytes32, uint256));
            return keccak256(abi.encode(DENY_SIGNER_TYPEHASH, wallet, signer, nonce, deadline));
        }
        if (kind == KIND_PAY) {
            (bytes32 key, address payee, uint256 amount, uint256 deadline) = abi.decode(body, (bytes32, address, uint256, uint256));
            if (key == bytes32(0) || payee == address(0) || payee == wallet || amount == 0 || block.timestamp >= deadline) return bytes32(0);
            return keccak256(abi.encode(APPROVAL_TYPEHASH, wallet, key, payee, amount, deadline));
        }
        if (kind == KIND_SIGNER_TRUST) {
            (SignerTrust memory t, bytes32 nonce, uint256 deadline) = abi.decode(body, (SignerTrust, bytes32, uint256));
            (uint64 epoch,,,,) = trust.trustOf(wallet, t.merchant);
            return keccak256(abi.encode(SIGNER_TRUST_TYPEHASH, wallet, t.merchant, keccak256(bytes(t.name)), epoch,
                keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
        }
        return bytes32(0);
    }

    function _p256(bytes32 h, uint256 r, uint256 s) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(h, r, s, x, y)); // RIP-7212 (Base)
        if (ok && ret.length == 32) return abi.decode(ret, (uint256)) == 1;
        return FCL_ecdsa.ecdsa_verify(h, r, s, x, y);
    }
}
