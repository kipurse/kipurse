// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// V5.5 (decision 99/decision 100): owner signs ONE OwnerSignerTrust grant for merchant M's order signer; later orders signed by
/// that signer pay the order's own per-order payee (no payee binding) within the grant caps. Everything else as V5.2.
/// Port of KipurseV54SignerTrust to V5.5; the phone path runs through the V2 key seat (wallet owners [owner, seat, SPM]).
contract KipurseV55SignerTrustTest is V55Base {
    uint256 kShop = 0x5109;                                // e.g. shop.example's published order signer (= V55Base.K_SHOP)
    string constant NAME = "shop.example"; bytes32 constant M = keccak256("shop.example");
    uint256 constant PK = 0xA11CE0FF1CE;
    uint256 oid;

    function setUp() public override {
        super.setUp();
        useSeatWallet();          // production layout: owners [owner, key seat V2, SPM]; ExampleShop stored trust (fallback tests)
        seatSetKey(PK);
        p = grant(4, 30, pol(address(registry), TERM));
    }

    // ---------------- helpers ----------------
    function st(uint160 s, uint160 d) internal view returns (KipurseTrustV55.SignerTrust memory t) {
        t = KipurseTrustV55.SignerTrust({merchant: M, name: NAME, signers: arr(shopSigner), single: s, daily: d, expiry: uint64(block.timestamp + 90 days)});
    }
    function grantDigest(CoinbaseSmartWallet w, KipurseTrustV55.SignerTrust memory t, bytes32 n, uint256 dline) internal view returns (bytes32) {
        return t5.ownerDigest(t5.signerTrustStructHash(address(w), t, n, dline));
    }
    function ownerGrant(KipurseTrustV55.SignerTrust memory t) internal view returns (bytes memory) {
        return abi.encode(t, bytes32("g1"), uint256(t.expiry), walletSig(wallet, ownerKey, grantDigest(wallet, t, bytes32("g1"), t.expiry)));
    }
    function phoneGrant(KipurseTrustV55.SignerTrust memory t, uint256 pk) internal view returns (bytes memory) {
        bytes32 n = keccak256("phone"); uint256 dline = t.expiry;
        bytes memory sig = seatSig(5, abi.encode(t, n, dline), grantDigest(wallet, t, n, dline), pk);
        return abi.encode(t, n, dline, sig);
    }
    function ord(address payee, uint256 amount) internal returns (KipurseAdapterV55.PaymentOrder memory) {
        return KipurseAdapterV55.PaymentOrder({payee: payee, amount: amount, orderId: keccak256(abi.encode("pi_", ++oid)),
            deadline: block.timestamp + 1800, chainId: block.chainid, adapter: address(a5), payer: address(wallet)});
    }
    function sign(uint256 k, KipurseAdapterV55.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, a5.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function payT(KipurseAdapterV55.PaymentOrder memory o, bytes memory sig, bytes memory g) internal {
        vm.prank(executor); a5.paySignedTrusted(p, o, sig, g, nf, dl());
    }
    function payTRevert(KipurseAdapterV55.PaymentOrder memory o, bytes memory sig, bytes memory g, bytes4 sel) internal {
        vm.prank(executor); vm.expectRevert(sel); a5.paySignedTrusted(p, o, sig, g, nf, dl());
    }
    function fresh(uint256 i) internal pure returns (address) { return address(uint160(uint256(keccak256(abi.encode("deposit", i))))); }

    // ---------------- happy path ----------------
    function test_valid_signature_pays_per_order_payees_without_binding() public {
        bytes memory g = ownerGrant(st(6e6, withFee(12e6)));
        uint256 w0 = token.balanceOf(address(wallet));
        KipurseAdapterV55.PaymentOrder memory o1 = ord(fresh(1), 5e6); payT(o1, sign(kShop, o1), g);
        KipurseAdapterV55.PaymentOrder memory o2 = ord(fresh(2), 5e6); payT(o2, sign(kShop, o2), g);  // another fresh address
        assertEq(token.balanceOf(fresh(1)), 5e6); assertEq(token.balanceOf(fresh(2)), 5e6);
        assertEq(w0 - token.balanceOf(address(wallet)), 10e6 + 2 * fee(5e6) + 2 * nf, "amount + 0.1% + network fee only (fee model unchanged)");
        (,, bool active,,) = t5.trustOf(address(wallet), M); assertFalse(active, "grant is inline: nothing stored, no trust tx");
        assertTrue(a5.orderUsed(shopSigner, o1.orderId)); assertTrue(a5.purchaseUsed(address(wallet), a5.signedPurchaseKey(M, o1.orderId)));
    }
    function test_phone_face_id_grant_kind5_works_and_wrong_phone_key_fails() public {
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(3), 5e6);
        payTRevert(o, sign(kShop, o), phoneGrant(st(6e6, 12e6), PK + 1), Approval.selector);
        payT(o, sign(kShop, o), phoneGrant(st(6e6, 12e6), PK));
        assertEq(token.balanceOf(fresh(3)), 5e6);
    }

    // ---------------- replay / dedupe ----------------
    function test_replay_same_order_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(4), 1e6); bytes memory s = sign(kShop, o);
        payT(o, s, g);
        payTRevert(o, s, g, Duplicate.selector);
        o.payee = fresh(5); payTRevert(o, sign(kShop, o), g, Duplicate.selector);  // same orderId, re-signed to another payee
    }
    function test_same_order_via_paySigned_after_trusted_refused() public {
        // bidSigner is store-trusted (V5.2, bound payee bidPayee) AND granted: one order, two entry points -> paid once only
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6); t.signers = arr(bidSigner);
        bytes memory g = ownerGrant(t);
        KipurseAdapterV55.PaymentOrder memory o = ord(bidPayee, 1e6); bytes memory s = sign(kBid, o);
        payT(o, s, g);
        KipurseAdapterV5.PaymentOrder memory o5 = KipurseAdapterV5.PaymentOrder({payee: o.payee, amount: o.amount, orderId: o.orderId,
            deadline: o.deadline, chainId: o.chainId, adapter: o.adapter, payer: o.payer});
        vm.prank(executor); vm.expectRevert(Duplicate.selector); adapter.paySigned(p, o5, s, nf, dl());
        assertEq(token.balanceOf(bidPayee), 1e6);
    }

    // ---------------- tampering ----------------
    function test_tampered_amount_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(7), 1e6); bytes memory s = sign(kShop, o);
        o.amount = 2e6; payTRevert(o, s, g, Signer.selector);   // recovers some other address: not in the grant
    }
    function test_tampered_payee_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(8), 1e6); bytes memory s = sign(kShop, o);
        o.payee = attacker; payTRevert(o, s, g, Signer.selector);
    }
    function test_tampered_grant_caps_refused() public {
        KipurseTrustV55.SignerTrust memory t = st(2e6, 5e6);
        bytes memory sig = walletSig(wallet, ownerKey, grantDigest(wallet, t, bytes32("g1"), t.expiry));
        t.single = 6e6; t.daily = 12e6;
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(9), 5e6);
        payTRevert(o, sign(kShop, o), abi.encode(t, bytes32("g1"), uint256(t.expiry), sig), Approval.selector);
    }
    function test_tampered_grant_signers_refused() public {
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6);
        bytes memory sig = walletSig(wallet, ownerKey, grantDigest(wallet, t, bytes32("g1"), t.expiry));
        t.signers = arr(evilSigner);
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(10), 1e6);
        payTRevert(o, sign(kEvil, o), abi.encode(t, bytes32("g1"), uint256(t.expiry), sig), Approval.selector);
    }
    function test_forged_grant_and_other_wallet_grant_refused() public {
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6);
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(11), 1e6); bytes memory s = sign(kShop, o);
        payTRevert(o, s, abi.encode(t, bytes32("g1"), uint256(t.expiry), walletSig(wallet, kEvil, grantDigest(wallet, t, bytes32("g1"), t.expiry))), Approval.selector);
        uint256 k2 = 0xBEEF; bytes[] memory ow = new bytes[](1); ow[0] = abi.encode(vm.addr(k2));
        CoinbaseSmartWallet w2 = factory.createAccount(ow, 7);
        payTRevert(o, s, abi.encode(t, bytes32("g1"), uint256(t.expiry), walletSig(w2, k2, grantDigest(w2, t, bytes32("g1"), t.expiry))), Approval.selector);
    }
    function test_payee_trust_signature_cannot_be_used_as_signer_grant() public {
        // type confusion: an OwnerTrust (payee trust) signature over the same merchant never validates as OwnerSignerTrust
        KipurseTrustV5.TrustParams memory pt = trustParams(NAME, arr(fresh(12)), arr(shopSigner), 6e6, 12e6, uint64(block.timestamp + 90 days));
        bytes memory psig = ownerSig(trustDigest(address(wallet), pt, bytes32("g1"), pt.expiry));
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6); t.expiry = pt.expiry;
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(13), 1e6);
        payTRevert(o, sign(kShop, o), abi.encode(t, bytes32("g1"), uint256(pt.expiry), psig), Approval.selector);
    }

    // ---------------- wrong signer / binding / domain ----------------
    function test_wrong_signer_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(14), 1e6);
        payTRevert(o, sign(kEvil, o), g, Signer.selector);
    }
    function test_unbound_or_foreign_payer_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(15), 1e6); o.payer = address(0);
        payTRevert(o, sign(kShop, o), g, Payer.selector);
        o.payer = attacker; payTRevert(o, sign(kShop, o), g, Payer.selector);
    }
    function test_wrong_chain_or_adapter_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(16), 1e6); o.chainId = 8453;
        payTRevert(o, sign(kShop, o), g, Domain.selector);
        o = ord(fresh(16), 1e6); o.adapter = address(0x0532);
        payTRevert(o, sign(kShop, o), g, Domain.selector);
    }

    // ---------------- expiry ----------------
    function test_expired_order_refused() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(17), 1e6); bytes memory s = sign(kShop, o);
        vm.warp(o.deadline); payTRevert(o, s, g, Expired.selector);
    }
    function test_expired_grant_refused() public {
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6); t.expiry = uint64(block.timestamp + 1 hours);
        bytes memory g = ownerGrant(t);
        warpBy(1 hours);
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(18), 1e6);
        payTRevert(o, sign(kShop, o), g, TrustExpiry.selector);
    }
    function test_grant_expiry_beyond_max_trust_refused() public {
        KipurseTrustV55.SignerTrust memory t = st(6e6, 12e6); t.expiry = uint64(block.timestamp + 366 days);
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(19), 1e6);
        payTRevert(o, sign(kShop, o), ownerGrant(t), TrustExpiry.selector);
    }

    // ---------------- caps ----------------
    function test_over_grant_single_refused() public {
        bytes memory g = ownerGrant(st(2e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(20), 2e6 + 1);
        payTRevert(o, sign(kShop, o), g, MerchantCap.selector);
    }
    function test_over_policy_single_refused() public {
        bytes memory g = ownerGrant(st(50e6, 50e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(21), uint256(SINGLE) + 1);
        payTRevert(o, sign(kShop, o), g, Amount.selector);
    }
    function test_grant_daily_cap_then_next_day() public {
        bytes memory g = ownerGrant(st(5e6, withFee(5e6)));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(22), 5e6); payT(o, sign(kShop, o), g);
        o = ord(fresh(23), 1); payTRevert(o, sign(kShop, o), g, MerchantDailyCap.selector);
        warpBy(1 days);
        o = ord(fresh(24), 5e6); payT(o, sign(kShop, o), g);
    }
    function test_policy_daily_cap_still_applies() public {
        bytes memory g = ownerGrant(st(6e6, 100e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(25), 6e6); payT(o, sign(kShop, o), g);
        o = ord(fresh(26), 6e6); payTRevert(o, sign(kShop, o), g, DailyCap.selector);  // 12e6 policy daily incl. fees
    }

    // ---------------- owner revoke / pause / deny ----------------
    function test_owner_untrust_merchant_kills_grant() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(27), 1e6); payT(o, sign(kShop, o), g);
        ownerCall(abi.encodeCall(trustC.untrust, (M)));
        o = ord(fresh(28), 1e6); payTRevert(o, sign(kShop, o), g, Approval.selector);
    }
    function test_owner_deny_signer_kills_grant() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        ownerCall(abi.encodeCall(trustC.setDeniedSigner, (shopSigner, true)));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(29), 1e6);
        payTRevert(o, sign(kShop, o), g, BadSignerDenied.selector);
    }
    function test_owner_pause_and_denied_payee_still_apply() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        ownerCall(abi.encodeCall(trustC.setDeniedPayee, (fresh(30), true)));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(30), 1e6);
        payTRevert(o, sign(kShop, o), g, Denied.selector);
        ownerCall(abi.encodeCall(trustC.setPaused, (true)));
        o = ord(fresh(31), 1e6); payTRevert(o, sign(kShop, o), g, WalletPaused.selector);
    }
    function test_only_executor_can_pay() public {
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(32), 1e6); bytes memory s = sign(kShop, o);
        vm.prank(attacker); vm.expectRevert(BadExecutor.selector); a5.paySignedTrusted(p, o, s, g, nf, dl());
    }

    // ---------------- untrusted signer -> the old (V5.2) paths, unchanged ----------------
    function test_untrusted_signer_old_path_unchanged() public {
        // paySigned (V5.2): ungranted signer -> Signer(); owner-trusted signer + bound payee pays; unbound payee -> PayeeBinding
        expectSignedRevert(kShop, fresh(33), 1e6, 9001, abi.encodeWithSelector(Signer.selector));
        paySigned(kBid, bidPayee, 1e6, 9002);
        assertEq(token.balanceOf(bidPayee), 1e6);
        expectSignedRevert(kBid, fresh(34), 1e6, 9003, abi.encodeWithSelector(PayeeBinding.selector));
        // and the new entry point without a grant for this signer refuses (caller must use the card / per-payment approval)
        bytes memory g = ownerGrant(st(6e6, 12e6));
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(35), 1e6);
        payTRevert(o, sign(kBid, o), g, Signer.selector);
    }
    function test_garbage_grant_reverts() public {
        KipurseAdapterV55.PaymentOrder memory o = ord(fresh(36), 1e6); bytes memory s = sign(kShop, o);
        vm.prank(executor); vm.expectRevert(); a5.paySignedTrusted(p, o, s, hex"", nf, dl());
    }
}
