// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import "../src/KipurseErrors.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import {KipursePhoneApproverV3} from "../src/KipursePhoneApproverV3.sol";

/// E2E: V52 + the UNCHANGED V3 phone approver (P-256, Face ID key) bound to V52's trust contract.
/// approve&remember (KIND_TRUST, reusable) -> auto-pay x2 (no trust tx) -> phone revoke (KIND_UNTRUST) -> pay rejected.
contract KipurseV52PhoneE2ETest is V5Base {
    uint256 constant PK = 0xA11CE0FF1CE; uint256 idx; KipursePhoneApproverV3 ap;
    address shop = address(0x5409); uint256 ref;
    function setUp() public override {
        super.setUp();
        KipurseAdapterV52 a2 = new KipurseAdapterV52(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        adapter = KipurseAdapterV5(address(a2)); trustC = adapter.trust();
        p = grant(9, 30, pol(address(registry), TERM));
        (uint256 px, uint256 py) = vm.publicKeyP256(PK);
        ap = new KipursePhoneApproverV3(address(wallet), address(trustC), px, py);
        vm.prank(owner); wallet.addOwnerAddress(address(ap)); idx = wallet.nextOwnerIndex() - 1;
    }
    function phoneTrust(KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, uint256 pk) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, wallet.replaySafeHash(trustDigest(address(wallet), t, n, dline)));
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(1), abi.encode(t, n, dline), uint256(r), uint256(s))));
        return abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
    }
    function pay(uint256 amt, bytes memory a) internal { vm.prank(executor); adapter.payDirect(p, direct(shop, amt, ++ref), a, nf, dl()); }
    function test_e2e_phone_remember_pay2_revoke() public {
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
        bytes memory a = phoneTrust(t, keccak256("n"), t.expiry, PK);   // deadline == expiry (reusable)
        uint256 w0 = token.balanceOf(address(wallet));
        pay(1e6, a); warpBy(1 hours); pay(1e6, a);
        assertEq(token.balanceOf(shop), 2e6);
        assertEq(w0 - token.balanceOf(address(wallet)), 2e6 + 2 * fee(1e6) + 2 * nf, "only amount + 0.1% + gas, no trust tx");
        (,, bool active,,) = trustC.trustOf(address(wallet), t.merchant); assertFalse(active);
        // revoke from the phone (KIND_UNTRUST), relayed once (user-paid gas in production)
        bytes32 un = keccak256("u"); uint256 ud = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(trustC.UNTRUST_TYPEHASH(), address(wallet), t.merchant, un, ud));
        (bytes32 r, bytes32 s) = vm.signP256(PK, wallet.replaySafeHash(trustC.ownerDigest(sh)));
        trustC.untrustBySig(address(wallet), t.merchant, un, ud, abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(2), abi.encode(t.merchant, un, ud), uint256(r), uint256(s)))));
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function test_e2e_wrong_phone_key_rejected() public {
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
        bytes memory a = phoneTrust(t, keccak256("n"), t.expiry, PK + 1);
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function test_e2e_old_approver_bound_to_old_trust_rejected() public {
        // a V3 approver bound to a DIFFERENT trust contract (e.g. today's V5) can't authorize V52 inline trust -> migration needs a new approver
        KipurseAdapterV5 old = new KipurseAdapterV5(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        (uint256 px, uint256 py) = vm.publicKeyP256(PK + 7);
        KipursePhoneApproverV3 ap2 = new KipursePhoneApproverV3(address(wallet), address(old.trust()), px, py);
        vm.prank(owner); wallet.addOwnerAddress(address(ap2)); uint256 i2 = wallet.nextOwnerIndex() - 1;
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
        (bytes32 r, bytes32 s) = vm.signP256(PK + 7, wallet.replaySafeHash(trustDigest(address(wallet), t, keccak256("n"), t.expiry)));
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(i2, abi.encode(uint8(1), abi.encode(t, keccak256("n"), uint256(t.expiry)), uint256(r), uint256(s))));
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector);
        adapter.payDirect(p, d, abi.encodePacked(bytes4(0x4b505452), abi.encode(t, keccak256("n"), uint256(t.expiry), sig)), nf, dl());
    }
}
