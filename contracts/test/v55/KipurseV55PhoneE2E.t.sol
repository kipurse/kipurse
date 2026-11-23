// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// Port of KipurseV54RegressPhoneE2E to V5.5 with the V2 key seat (the V3/V4 phone approvers are bound to older trust
/// contracts and cannot sign V5.5 digests). approve & remember (KIND_INLINE_TRUST, reusable) -> auto-pay x2 (no trust tx)
/// -> phone revoke (KIND_UNTRUST) -> pay rejected.
contract KipurseV55PhoneE2ETest is V55Base {
    uint256 constant PK = 0xA11CE0FF1CE;
    address shop = address(0x5409); uint256 ref;
    function setUp() public override {
        super.setUp();
        useSeatWallet(); seatSetKey(PK);
        p = grant(9, 30, pol(address(registry), TERM));
    }
    function phoneTrust(KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, uint256 pk) internal view returns (bytes memory) {
        bytes memory sig = seatSig(6, abi.encode(t, n, dline), inlineDigest(address(wallet), t, n, dline), pk);
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
        bytes32 un = keccak256("u"); uint256 ud = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(trustC.UNTRUST_TYPEHASH(), address(wallet), t.merchant, un, ud));
        trustC.untrustBySig(address(wallet), t.merchant, un, ud, seatSig(2, abi.encode(t.merchant, un, ud), trustC.ownerDigest(sh), PK));
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function test_e2e_no_expiry_remember_until_revoke() public {
        // owner t553/t554: "approve & remember" may have no expiry (2^64-1); only revoke (or a key change) ends it
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, type(uint64).max);
        bytes memory a = phoneTrust(t, keccak256("n"), type(uint64).max, PK);
        pay(1e6, a);
        vm.warp(block.timestamp + 3650 days); p = grant(10, 30, pol(address(registry), TERM));
        pay(1e6, a);
        vm.prank(owner); wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.clearKey, ()));
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function test_e2e_wrong_phone_key_rejected() public {
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
        bytes memory a = phoneTrust(t, keccak256("n"), t.expiry, PK + 1);
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function test_e2e_v54_style_kind1_inline_rejected() public {
        // the V5.4 inline form (kind 1 over OwnerTrust) is refused by V5.5 (KR-01)
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
        bytes memory sig = seatSig(1, abi.encode(t, keccak256("n"), uint256(t.expiry)), trustDigest(address(wallet), t, keccak256("n"), t.expiry), PK);
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector);
        adapter.payDirect(p, d, abi.encodePacked(bytes4(0x4b505452), abi.encode(t, keccak256("n"), uint256(t.expiry), sig)), nf, dl());
    }
}
