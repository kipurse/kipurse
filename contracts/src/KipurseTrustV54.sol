// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";
import {KipurseTrustV5} from "./KipurseTrustV5.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/// Kipurse V5.4 owner controls (development only; NOT audited) = KipurseTrustV5 (unchanged) + INLINE SIGNER TRUST
/// (handbook §6#99 / §6#100, owner 2026-11-19 21:20 / 21:28 CT): the owner signs ONCE "trust the order signer(s) of merchant M,
/// any per-order payee the signer names, within single / daily caps, until expiry". Nothing is stored; the signed grant rides
/// along with each order (adapter.paySignedTrusted) and is re-verified every time:
///   - typed data OwnerSignerTrust (distinct from OwnerTrust: a payee-trust signature can never be read as a signer grant);
///   - bound to the CURRENT trust epoch of M: untrust(M) / untrustBySig kills every grant for M at once;
///   - deniedSigner (setDeniedSigner / denySignerBySig) kills it for one signer (checked here, first);
///   - expiry <= MAX_TRUST from now, deadline, merchant == keccak256(name), 1..16 non-zero signers, 0 < single <= daily.
contract KipurseTrustV54 is KipurseTrustV5 {
    struct SignerTrust { bytes32 merchant; string name; address[] signers; uint160 single; uint160 daily; uint64 expiry; }
    bytes32 public constant SIGNER_TRUST_TYPEHASH = keccak256(
        "OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
    );

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
}
