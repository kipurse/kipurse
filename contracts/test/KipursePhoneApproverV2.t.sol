// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import "../src/KipurseErrors.sol";
import {KipursePhoneApproverV2} from "../src/KipursePhoneApproverV2.sol";

/// V2 = V1 scope + KIND_PAY (one owner-initiated payDirect approval signed by the phone's Secure Enclave key).
contract KipursePhoneApproverV2Test is V5Base {
    uint256 constant PK = 0xA11CE0FF1CE; uint256 px; uint256 py; KipursePhoneApproverV2 ap; uint256 idx;
    uint160 constant MAX1 = 5e6; uint160 constant MAXD = 8e6;
    function setUp() public override {
        super.setUp();
        (px, py) = vm.publicKeyP256(PK);
        ap = new KipursePhoneApproverV2(address(wallet), address(trustC), px, py, MAX1, MAXD);
        vm.prank(owner); wallet.addOwnerAddress(address(ap)); idx = wallet.nextOwnerIndex() - 1;
    }
    function _key(KipurseAdapterV5.Direct memory d) internal view returns (bytes32) { return adapter.purchaseKey(d.payee, d.merchantRef, d.repeatKey); }
    function _paySig(KipurseAdapterV5.Direct memory d, uint256 pk) internal view returns (bytes memory) {
        bytes32 key = _key(d);
        bytes32 h = wallet.replaySafeHash(adapter.approvalDigest(address(wallet), key, d.payee, d.amount, d.deadline));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        return abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(4), abi.encode(key, d.payee, d.amount, d.deadline), uint256(r), uint256(s))));
    }
    function test_v2_phonePay_works_feesCharged_singleUse() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 501);
        uint256 w0 = token.balanceOf(address(wallet));
        bytes memory sig = _paySig(d, PK);
        vm.prank(executor); adapter.payDirect(p, d, sig, nf, dl());
        assertEq(token.balanceOf(stranger), 3e6);
        assertEq(w0 - token.balanceOf(address(wallet)), 3e6 + fee(3e6) + nf, "amount + protocol fee + network fee from the payer");
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, sig, nf, dl()); // same purchase key cannot be paid twice
    }
    function test_v2_phonePay_boundToPayeeAmountKeyDeadline() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 502); bytes memory sig = _paySig(d, PK);
        KipurseAdapterV5.Direct memory d2 = direct(attacker, 3e6, 502);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
        d2 = direct(stranger, 3e6 + 1, 502);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
        d2 = direct(stranger, 3e6, 503);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
        d2 = KipurseAdapterV5.Direct(d.payee, d.amount, d.merchantRef, d.repeatKey, d.deadline + 1);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
    }
    function test_v2_phonePay_wrongKey_rejected() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 1e6, 504);
        bytes memory sig = _paySig(d, PK + 1);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, sig, nf, dl());
    }
    function test_v2_phonePay_aboveApproverSingle_rejected() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, uint256(MAX1) + 1, 505);
        bytes memory sig = _paySig(d, PK);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, sig, nf, dl());
    }
    function test_v2_phonePay_expired_rejected() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 1e6, 506); bytes memory sig = _paySig(d, PK);
        warpBy(601);
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, sig, nf, dl());
    }
    function test_v2_phonePay_revokedPhone_rejected() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 1e6, 507); bytes memory sig = _paySig(d, PK);
        vm.prank(owner); wallet.removeOwnerAtIndex(idx, abi.encode(address(ap)));
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, sig, nf, dl());
    }
    function test_v2_phonePay_otherWallet_rejected() public {
        // an approver bound to ANOTHER wallet cannot approve for this one
        KipursePhoneApproverV2 other = new KipursePhoneApproverV2(address(0xBEEF), address(trustC), px, py, MAX1, MAXD);
        bytes32 h = keccak256("x"); (bytes32 r, bytes32 s) = vm.signP256(PK, h);
        try other.isValidSignature(h, abi.encode(uint8(4), abi.encode(bytes32(uint256(1)), stranger, uint256(1e6), block.timestamp + 60), uint256(r), uint256(s))) returns (bytes4 v) { assertTrue(v != bytes4(0x1626ba7e)); } catch {}
    }
    function test_v2_cannotSignArbitraryHashes() public {
        bytes32 h = keccak256("permit or userop"); (bytes32 r, bytes32 s) = vm.signP256(PK, wallet.replaySafeHash(h));
        for (uint8 k = 0; k < 6; k++) {
            bytes memory w = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(k, bytes(""), uint256(r), uint256(s))));
            try this.callIsValid(h, w) returns (bytes4 v) { assertTrue(v != bytes4(0x1626ba7e)); } catch {}
        }
        // a well-formed pay body whose digest does not match the asked hash
        bytes memory body = abi.encode(bytes32(uint256(1)), stranger, uint256(1e6), block.timestamp + 60);
        try this.callIsValid(h, abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(4), body, uint256(r), uint256(s))))) returns (bytes4 v) { assertTrue(v != bytes4(0x1626ba7e)); } catch {}
    }
    function test_v2_trustKindsStillWork() public {
        bytes32 n = keccak256("u"); uint256 dline = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(trustC.UNTRUST_TYPEHASH(), address(wallet), EXAMPLESHOP, n, dline));
        bytes32 h = wallet.replaySafeHash(trustC.ownerDigest(sh)); (bytes32 r, bytes32 s) = vm.signP256(PK, h);
        vm.prank(executor); trustC.untrustBySig(address(wallet), EXAMPLESHOP, n, dline, abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(2), abi.encode(EXAMPLESHOP, n, dline), uint256(r), uint256(s)))));
        (bytes32 m,,) = trustC.payeeTrust(address(wallet), bidPayee); assertEq(m, bytes32(0));
    }
    function testFuzz_v2_payAmountCap(uint256 amt) public {
        amt = bound(amt, 1, 50e6);
        bytes memory body = abi.encode(bytes32(uint256(9)), stranger, amt, block.timestamp + 60);
        bytes32 sh = ap.structHashOf(4, body);
        if (amt > MAX1) assertEq(sh, bytes32(0)); else assertTrue(sh != bytes32(0));
    }
    function callIsValid(bytes32 h, bytes memory w) external view returns (bytes4) { return wallet.isValidSignature(h, w); }
}
