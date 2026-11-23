// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import "../src/KipurseErrors.sol";
import {KipursePhoneApprover} from "../src/KipursePhoneApprover.sol";

contract KipursePhoneApproverTest is V5Base {
    uint256 constant PK = 0xA11CE0FF1CE; uint256 px; uint256 py; KipursePhoneApprover ap; uint256 idx;
    function setUp() public override {
        super.setUp();
        (px, py) = vm.publicKeyP256(PK);
        ap = new KipursePhoneApprover(address(wallet), address(trustC), px, py, 10.05e6, 12.012e6);
        vm.prank(owner); wallet.addOwnerAddress(address(ap)); idx = wallet.nextOwnerIndex() - 1;
    }
    function _tp(string memory name, address payee, uint160 s1, uint160 d) internal view returns (KipursePhoneApprover.TrustParams memory t) {
        t.merchant = keccak256(bytes(name)); t.name = name; t.payees = arr(payee); t.signers = new address[](0); t.single = s1; t.daily = d; t.expiry = uint64(block.timestamp + 30 days);
    }
    function _cast(KipursePhoneApprover.TrustParams memory a) internal pure returns (KipurseTrustV5.TrustParams memory t) {
        t.merchant = a.merchant; t.name = a.name; t.payees = a.payees; t.signers = a.signers; t.single = a.single; t.daily = a.daily; t.expiry = a.expiry;
    }
    function _wrap(uint8 kind, bytes memory body, bytes32 sh, uint256 pk) internal view returns (bytes memory) {
        bytes32 h = wallet.replaySafeHash(trustC.ownerDigest(sh)); (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        return abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(kind, body, uint256(r), uint256(s))));
    }
    function _trustSh(KipursePhoneApprover.TrustParams memory t, bytes32 n, uint256 dl) internal view returns (bytes32) {
        (uint64 ep,,,,) = trustC.trustOf(address(wallet), t.merchant);
        return keccak256(abi.encode(trustC.TRUST_TYPEHASH(), address(wallet), t.merchant, keccak256(bytes(t.name)), ep, keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, n, dl));
    }
    function test_phoneTrustBySig_works_singleUse() public {
        KipursePhoneApprover.TrustParams memory t = _tp("self", address(0x5E1F), 0.05e6, 0.05e6); bytes32 n = keccak256("p1"); uint256 dl = block.timestamp + 600;
        bytes memory sig = _wrap(1, abi.encode(t, n, dl), _trustSh(t, n, dl), PK);
        vm.prank(executor); trustC.trustBySig(address(wallet), _cast(t), n, dl, sig);
        (bytes32 m,,) = trustC.payeeTrust(address(wallet), address(0x5E1F)); assertEq(m, t.merchant);
        vm.prank(executor); vm.expectRevert(SigNonce.selector); trustC.trustBySig(address(wallet), _cast(t), n, dl, sig);
    }
    function test_phone_wrongKey_or_mismatchedPreimage_rejected() public {
        KipursePhoneApprover.TrustParams memory t = _tp("self", address(0x5E1F), 0.05e6, 0.05e6); bytes32 n = keccak256("p2"); uint256 dl = block.timestamp + 600;
        bytes memory bad = _wrap(1, abi.encode(t, n, dl), _trustSh(t, n, dl), PK + 1);
        vm.prank(executor); vm.expectRevert(OwnerSig.selector); trustC.trustBySig(address(wallet), _cast(t), n, dl, bad);
        // preimage says payee A, relayed call trusts payee B
        KipursePhoneApprover.TrustParams memory t2 = _tp("self", address(0xBAD), 0.05e6, 0.05e6);
        bytes memory sigA = _wrap(1, abi.encode(t, n, dl), _trustSh(t, n, dl), PK);
        vm.prank(executor); vm.expectRevert(OwnerSig.selector); trustC.trustBySig(address(wallet), _cast(t2), n, dl, sigA);
    }
    function test_phone_capsAboveCeiling_rejected() public {
        KipursePhoneApprover.TrustParams memory t = _tp("big", address(0xB16), 11e6, 12e6); bytes32 n = keccak256("p3"); uint256 dl = block.timestamp + 600;
        bytes memory sig = _wrap(1, abi.encode(t, n, dl), _trustSh(t, n, dl), PK);
        vm.prank(executor); vm.expectRevert(OwnerSig.selector); trustC.trustBySig(address(wallet), _cast(t), n, dl, sig);
    }
    function test_phone_untrust_and_denySigner() public {
        bytes32 n = keccak256("u"); uint256 dl = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(trustC.UNTRUST_TYPEHASH(), address(wallet), EXAMPLESHOP, n, dl));
        vm.prank(executor); trustC.untrustBySig(address(wallet), EXAMPLESHOP, n, dl, _wrap(2, abi.encode(EXAMPLESHOP, n, dl), sh, PK));
        (bytes32 m,,) = trustC.payeeTrust(address(wallet), bidPayee); assertEq(m, bytes32(0));
        bytes32 n2 = keccak256("d"); bytes32 sh2 = keccak256(abi.encode(trustC.DENY_SIGNER_TYPEHASH(), address(wallet), evilSigner, n2, dl));
        vm.prank(executor); trustC.denySignerBySig(address(wallet), evilSigner, n2, dl, _wrap(3, abi.encode(evilSigner, n2, dl), sh2, PK));
        assertTrue(trustC.deniedSigner(address(wallet), evilSigner));
    }
    /// OUT OF SCOPE: the phone key cannot sign anything else for the wallet (arbitrary 1271 hash, UserOp-style hash, kind 0).
    function test_phone_cannotSignArbitraryHashes() public {
        bytes32 h = keccak256("permit or userop"); (bytes32 r, bytes32 s) = vm.signP256(PK, wallet.replaySafeHash(h));
        for (uint8 k = 0; k < 5; k++) {
            bytes memory w = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(k, bytes(""), uint256(r), uint256(s))));
            try this.callIsValid(h, w) returns (bytes4 v) { assertTrue(v != bytes4(0x1626ba7e)); } catch {}
        }
        // a UserOp-style raw hash signed directly
        (r, s) = vm.signP256(PK, h);
        assertEq(ap.isValidSignature(h, abi.encode(uint8(2), abi.encode(bytes32(0), bytes32(0), uint256(0)), uint256(r), uint256(s))), bytes4(0xffffffff));
    }
    function callIsValid(bytes32 h, bytes memory w) external view returns (bytes4) { return wallet.isValidSignature(h, w); }
    /// The approver can never act as msg.sender owner: it has no call path; removal by the owner works.
    function test_ownerCanRevokePhone() public {
        vm.prank(owner); wallet.removeOwnerAtIndex(idx, abi.encode(address(ap)));
        KipursePhoneApprover.TrustParams memory t = _tp("self", address(0x5E1F), 0.05e6, 0.05e6); bytes32 n = keccak256("p9"); uint256 dl = block.timestamp + 600;
        bytes memory sig = _wrap(1, abi.encode(t, n, dl), _trustSh(t, n, dl), PK);
        vm.prank(executor); vm.expectRevert(); trustC.trustBySig(address(wallet), _cast(t), n, dl, sig);
    }
}
