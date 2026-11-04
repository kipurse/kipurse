// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {FCL_ecdsa} from "FreshCryptoLib/FCL_ecdsa.sol";

interface IKipurseTrustV5View {
    struct TrustRecord { uint64 epoch; uint64 expiry; bool active; uint160 single; uint160 daily; }
    function trustOf(address account, bytes32 merchant) external view returns (uint64 epoch, uint64 expiry, bool active, uint160 single, uint160 daily);
    function ownerDigest(bytes32 structHash) external view returns (bytes32);
    function TRUST_TYPEHASH() external view returns (bytes32);
    function UNTRUST_TYPEHASH() external view returns (bytes32);
    function DENY_SIGNER_TYPEHASH() external view returns (bytes32);
}
interface ICbswReplaySafe { function replaySafeHash(bytes32 hash) external view returns (bytes32); }

/// Kipurse PHONE APPROVER V2 (development; NOT audited). V1 + KIND_PAY: one owner-initiated payment through the adapter's
/// payDirect step-up approval (OwnerApproval digest), capped per payment by maxSingle. Daily/term caps are enforced by the
/// adapter policy on chain (this contract is view-only and keeps no state).
/// V1: Added as an ADDRESS owner of ONE Coinbase Smart Wallet, it lets a
/// Secure Enclave P-256 key (iPhone, Face ID-gated) approve ONLY Kipurse V5 owner-by-signature actions on that wallet:
/// trustBySig (capped by maxSingle/maxDaily), untrustBySig and denySignerBySig on ONE trust contract.
/// How the scope is enforced: the wallet asks isValidSignature(hash, data) for every owner check (ERC-1271 AND UserOps).
/// This contract only answers "valid" when `data` carries the full preimage of a Kipurse trust/untrust/deny-signer digest
/// for this wallet and `hash == wallet.replaySafeHash(trust.ownerDigest(structHash))`, plus a P-256 signature over `hash`.
/// Any other hash (a UserOp, a token permit, a spend permission, an owner change) has no such preimage -> invalid.
/// It has no function that calls the wallet, so it can never use the owner's msg.sender powers (execute, add/remove owner).
contract KipursePhoneApproverV2 {
    uint8 public constant KIND_TRUST = 1;
    uint8 public constant KIND_UNTRUST = 2;
    uint8 public constant KIND_DENY_SIGNER = 3;
    uint8 public constant KIND_PAY = 4;
    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)");
    struct TrustParams { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }

    address public immutable wallet;
    IKipurseTrustV5View public immutable trust;
    uint256 public immutable x;
    uint256 public immutable y;
    uint160 public immutable maxSingle;
    uint160 public immutable maxDaily;

    constructor(address wallet_, address trust_, uint256 x_, uint256 y_, uint160 maxSingle_, uint160 maxDaily_) {
        require(wallet_ != address(0) && trust_ != address(0) && x_ != 0 && y_ != 0 && maxSingle_ != 0 && maxSingle_ <= maxDaily_, "args");
        wallet = wallet_; trust = IKipurseTrustV5View(trust_); x = x_; y = y_; maxSingle = maxSingle_; maxDaily = maxDaily_;
    }

    /// data = abi.encode(uint8 kind, bytes body, uint256 r, uint256 s)
    ///   kind 1: body = abi.encode(TrustParams t, bytes32 nonce, uint256 deadline)
    ///   kind 2: body = abi.encode(bytes32 merchant, bytes32 nonce, uint256 deadline)
    ///   kind 3: body = abi.encode(address signer, bytes32 nonce, uint256 deadline)
    ///   kind 4: body = abi.encode(bytes32 purchaseKey, address payee, uint256 amount, uint256 deadline)
    function isValidSignature(bytes32 hash, bytes calldata data) external view returns (bytes4) {
        (uint8 kind, bytes memory body, uint256 r, uint256 s) = abi.decode(data, (uint8, bytes, uint256, uint256));
        bytes32 sh = structHashOf(kind, body);
        if (sh == bytes32(0)) return 0xffffffff;
        if (hash != ICbswReplaySafe(wallet).replaySafeHash(trust.ownerDigest(sh))) return 0xffffffff;
        if (!_p256(hash, r, s)) return 0xffffffff;
        return 0x1626ba7e;
    }

    /// The Kipurse struct hash for an allowed action (0 if not allowed). Mirrors KipurseTrustV5 exactly.
    function structHashOf(uint8 kind, bytes memory body) public view returns (bytes32) {
        if (kind == KIND_TRUST) {
            (TrustParams memory t, bytes32 nonce, uint256 deadline) = abi.decode(body, (TrustParams, bytes32, uint256));
            if (t.single > maxSingle || t.daily > maxDaily) return bytes32(0);
            (uint64 epoch,,,,) = trust.trustOf(wallet, t.merchant);
            return keccak256(abi.encode(trust.TRUST_TYPEHASH(), wallet, t.merchant, keccak256(bytes(t.name)), epoch,
                keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, nonce, deadline));
        }
        if (kind == KIND_UNTRUST) {
            (bytes32 merchant, bytes32 nonce, uint256 deadline) = abi.decode(body, (bytes32, bytes32, uint256));
            return keccak256(abi.encode(trust.UNTRUST_TYPEHASH(), wallet, merchant, nonce, deadline));
        }
        if (kind == KIND_DENY_SIGNER) {
            (address signer, bytes32 nonce, uint256 deadline) = abi.decode(body, (address, bytes32, uint256));
            return keccak256(abi.encode(trust.DENY_SIGNER_TYPEHASH(), wallet, signer, nonce, deadline));
        }
        if (kind == KIND_PAY) {
            (bytes32 key, address payee, uint256 amount, uint256 deadline) = abi.decode(body, (bytes32, address, uint256, uint256));
            if (key == bytes32(0) || payee == address(0) || payee == wallet || amount == 0 || amount > maxSingle || block.timestamp >= deadline) return bytes32(0);
            return keccak256(abi.encode(APPROVAL_TYPEHASH, wallet, key, payee, amount, deadline));
        }
        return bytes32(0);
    }

    function _p256(bytes32 h, uint256 r, uint256 s) internal view returns (bool) {
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(h, r, s, x, y)); // RIP-7212 (Base)
        if (ok && ret.length == 32) return abi.decode(ret, (uint256)) == 1;
        return FCL_ecdsa.ecdsa_verify(h, r, s, x, y);
    }
}
