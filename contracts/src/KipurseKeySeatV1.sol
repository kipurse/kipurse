// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {FCL_ecdsa} from "FreshCryptoLib/FCL_ecdsa.sol";
import {IKipurseTrustV54View, ICbswReplaySafe} from "./KipursePhoneApproverV4.sol";

interface ICbswFactoryView { function getAddress(bytes[] calldata owners, uint256 nonce) external view returns (address); }

/// Kipurse FACE ID KEY SEAT V1 (handbook §6#108, 2026-11-20; development only, NOT audited, NOT deployed).
///
/// Why: since ~2026-11-19 Coinbase's Base Account popup refuses ANY owner change on a smart wallet ("Account owner or upgrade calls
/// are not allowed.", also inside wallet.execute). Every phone change used to be "add a new approver owner, remove the old one".
///
/// What: ONE permanent owner per Kipurse wallet, set when the wallet is CREATED by the Coinbase factory with owners
/// [owner's Base Account, this seat, SpendPermissionManager]. After that no owner is ever added or removed. The seat holds the
/// CURRENT phone P-256 key (iPhone Secure Enclave, Face ID-gated). New phone / reinstall / Face ID off = the WALLET itself
/// (the owner confirming a normal call in the Coinbase popup) calls setKey / clearKey. Old keys stop working at once.
///
/// Scope (identical to KipursePhoneApproverV4): the wallet asks isValidSignature(hash, data) for every owner check. The seat only
/// answers "valid" when `data` carries the full preimage of a Kipurse trust / untrust / deny-signer / pay / signer-trust digest
/// for THIS wallet on ONE trust contract and `hash == wallet.replaySafeHash(trust.ownerDigest(structHash))`, plus a P-256
/// signature over `hash` by the current key. A UserOp, token permit, spend permission or owner change has no such preimage ->
/// invalid. It has no function that calls the wallet, so it can never use an owner's msg.sender powers.
///
/// Address: CREATE2 (deterministic deployer) of this code with (factory, owner, spm, trust) only, NO phone key, so the seat and
/// the wallet address are fixed by the owner's Base Account before opening (handbook 0A #1).
contract KipurseKeySeatV1 {
    uint8 public constant KIND_TRUST = 1;
    uint8 public constant KIND_UNTRUST = 2;
    uint8 public constant KIND_DENY_SIGNER = 3;
    uint8 public constant KIND_PAY = 4;
    uint8 public constant KIND_SIGNER_TRUST = 5;
    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)");
    struct SignerTrust { bytes32 merchant; string name; address[] signers; uint160 single; uint160 daily; uint64 expiry; }
    struct TrustParams { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }

    /// The one Coinbase Smart Wallet this seat serves: factory address for owners [owner, this, spm], nonce 0.
    address public immutable wallet;
    IKipurseTrustV54View public immutable trust;
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
        wallet = ICbswFactoryView(factory_).getAddress(owners, 0);
        trust = IKipurseTrustV54View(trust_);
    }

    modifier onlyWallet() { if (msg.sender != wallet) revert OnlyWallet(); _; }

    /// Register / replace the phone key. Only the wallet itself (owner confirms wallet.execute(seat, 0, setKey(...))).
    function setKey(uint256 x_, uint256 y_) external onlyWallet {
        if (x_ == 0 || y_ == 0 || (x_ == x && y_ == y)) revert BadKey();
        x = x_; y = y_; emit KeySet(++keyEpoch, x_, y_);
    }
    /// Face ID off / phone lost: no phone signature is valid any more.
    function clearKey() external onlyWallet { x = 0; y = 0; emit KeyCleared(++keyEpoch); }

    /// data = abi.encode(uint8 kind, bytes body, uint256 r, uint256 s); kinds and bodies exactly as KipursePhoneApproverV4.
    function isValidSignature(bytes32 hash, bytes calldata data) external view returns (bytes4) {
        if (x == 0) return 0xffffffff;
        (uint8 kind, bytes memory body, uint256 r, uint256 s) = abi.decode(data, (uint8, bytes, uint256, uint256));
        bytes32 sh = structHashOf(kind, body);
        if (sh == bytes32(0)) return 0xffffffff;
        if (hash != ICbswReplaySafe(wallet).replaySafeHash(trust.ownerDigest(sh))) return 0xffffffff;
        if (!_p256(hash, r, s)) return 0xffffffff;
        return 0x1626ba7e;
    }

    /// The Kipurse struct hash for an allowed action (0 if not allowed). Same as KipursePhoneApproverV4 / KipurseTrustV5(4).
    function structHashOf(uint8 kind, bytes memory body) public view returns (bytes32) {
        if (kind == KIND_TRUST) {
            (TrustParams memory t, bytes32 nonce, uint256 deadline) = abi.decode(body, (TrustParams, bytes32, uint256));
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
            if (key == bytes32(0) || payee == address(0) || payee == wallet || amount == 0 || block.timestamp >= deadline) return bytes32(0);
            return keccak256(abi.encode(APPROVAL_TYPEHASH, wallet, key, payee, amount, deadline));
        }
        if (kind == KIND_SIGNER_TRUST) {
            (SignerTrust memory t, bytes32 nonce, uint256 deadline) = abi.decode(body, (SignerTrust, bytes32, uint256));
            (uint64 epoch,,,,) = trust.trustOf(wallet, t.merchant);
            return keccak256(abi.encode(trust.SIGNER_TRUST_TYPEHASH(), wallet, t.merchant, keccak256(bytes(t.name)), epoch,
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
