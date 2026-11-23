// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// Registry fixtures for I-11: one reverts, one burns all forwarded gas, one blocks everybody.
contract RevertingRegistry {
    function blocked(address) external pure returns (bool) { revert("down"); }
    function lookupPayee(address) external pure returns (bytes32, uint160, uint160) { revert("down"); }
    function lookupSigner(address) external pure returns (bytes32, uint160, uint160) { revert("down"); }
    function isPayeeOf(bytes32, address) external pure returns (bool) { revert("down"); }
}
/// Burns every unit of forwarded gas (runs out of gas inside the adapter's REGISTRY_GAS stipend).
contract GasBurnRegistry {
    uint256 public x;
    function _burn() internal view { uint256 i; while (true) { i += x + 1; } }
    function blocked(address) external view returns (bool) { _burn(); return true; }
    function lookupPayee(address) external view returns (bytes32, uint160, uint160) { _burn(); return (bytes32(uint256(1)), 1e12, 1e12); }
    function lookupSigner(address) external view returns (bytes32, uint160, uint160) { _burn(); return (bytes32(uint256(1)), 1e12, 1e12); }
    function isPayeeOf(bytes32, address) external view returns (bool) { _burn(); return true; }
}
contract BlockAllRegistry {
    function blocked(address) external pure returns (bool) { return true; }
    function lookupPayee(address) external pure returns (bytes32, uint160, uint160) { return (bytes32(0), 0, 0); }
    function lookupSigner(address) external pure returns (bytes32, uint160, uint160) { return (bytes32(0), 0, 0); }
    function isPayeeOf(bytes32, address) external pure returns (bool) { return false; }
}

/// Stateless fuzz tests for the V5.5 adapter / trust (port of test/invariant/V54Fuzz.t.sol). Each test maps to THREAT_MODEL ids.
contract V55FuzzTest is V55Base {
    uint256 ref_;

    // ======================= I-1 / I-3: _policy rejects every malformed or out-of-bounds call =======================
    function _polWith(uint256 which) internal view returns (KipurseAdapterV5.Policy memory q) {
        q = polStruct(address(registry), TERM55);
        if (which == 6) q.executor = address(0);
        if (which == 8) q.term = 0;
        if (which == 10) q.daily = 0;
        if (which == 11) q.single = 0;
        if (which == 12) { q.single = q.daily + 1; }
        if (which == 13) { q.daily = q.term + 1; }
        if (which == 14) q.openSingle = q.single + 1;
        if (which == 15) q.openDaily = q.daily + 1;
        if (which == 16) q.verifiedSingle = q.single + 1;
        if (which == 17) q.verifiedDaily = q.daily + 1;
        if (which == 18) q.maxFeePpm = FEE_PPM - 1;
    }
    /// Every executor entry point runs _policy first: each single malformed field reverts with its specific error.
    function testFuzz_policyRejectsMalformed(uint8 whichSeed, uint8 entrySeed, uint256 x) public {
        uint256 which = whichSeed % 27;
        uint256 entry = entrySeed % 4;
        ISpendPermissionManager.SpendPermission memory q = p;
        KipurseAdapterV5.Policy memory pl = _polWith(which);
        q.extraData = abi.encode(pl);
        q.allowance = pl.term;
        uint256 amount = 1e6; address payee = bidPayee; uint256 nfee = 0; uint48 txd = dl(); address caller = executor;
        bytes4 err;
        if (which == 0) { q.spender = address(uint160(bound(x, 1, type(uint160).max))); if (q.spender == address(a5)) q.spender = attacker; err = Scope.selector; }
        else if (which == 1) { q.token = attacker; err = Scope.selector; }
        else if (which == 2) { q.end = q.start; err = Term.selector; }
        else if (which == 3) { q.period = q.period + uint48(bound(x, 1, 1000)); err = Term.selector; }
        else if (which == 4) { q.end = q.start + 366 days; q.period = 366 days; err = Term.selector; }
        else if (which == 5) { q.extraData = abi.encodePacked(q.extraData, uint8(0)); err = BadPolicy.selector; }
        else if (which == 6) err = BadExecutor.selector;
        else if (which == 7) { caller = address(uint160(bound(x, 1, type(uint160).max))); if (caller == executor) caller = attacker; err = BadExecutor.selector; }
        else if (which == 8) err = Allowance.selector;
        else if (which == 9) { q.allowance = pl.term + uint160(bound(x, 1, 1e12)); err = Allowance.selector; }
        else if (which <= 17) err = BadPolicy.selector;
        else if (which == 18) err = Fee.selector;
        else if (which == 19) { nfee = bound(x, MAX_NF + 1, type(uint128).max); err = NetworkFee.selector; }
        else if (which == 20) { txd = uint48(vm.getBlockTimestamp() - bound(x, 0, 1000)); err = Operation.selector; }
        else if (which == 21) { txd = uint48(vm.getBlockTimestamp() + bound(x, 301, 1e6)); err = Operation.selector; }
        else if (which == 22) { ownerExec(address(t5), abi.encodeCall(t5.setPaused, (true))); err = WalletPaused.selector; }
        else if (which == 23) { amount = 0; err = Amount.selector; }
        else if (which == 24) { amount = bound(x, uint256(SINGLE) + 1, 1e30); err = Amount.selector; }
        else if (which == 25) {
            address[6] memory bad = [address(0), address(a5), address(wallet), address(manager), address(token), vaultV()];
            payee = bad[x % 6]; err = Payee.selector;
        }
        else { ownerExec(address(t5), abi.encodeCall(t5.setDeniedPayee, (bidPayee, true))); err = Denied.selector; }
        _callEntry(entry, q, payee, amount, nfee, txd, caller, err);
    }
    function _callEntry(uint256 entry, ISpendPermissionManager.SpendPermission memory q, address payee, uint256 amount, uint256 nfee,
        uint48 txd, address caller, bytes4 err) internal
    {
        if (entry == 0) {
            KipurseAdapterV55.Direct memory d = dirV(payee, amount, ++ref_);
            vm.prank(caller); vm.expectRevert(err); a5.payDirect(q, d, "", nfee, txd);
        } else if (entry == 1) {
            KipurseAdapterV55.PaymentOrder memory o = ordV(payee, amount, ++ref_, address(0));
            bytes memory sig = signOrdV(kBid, o);
            vm.prank(caller); vm.expectRevert(err); a5.paySigned(q, o, sig, nfee, txd);
        } else if (entry == 2) {
            KipurseAdapterV55.PaymentOrder memory o = ordV(payee, amount, ++ref_, address(wallet));
            bytes memory sig = signOrdV(K_SHOP, o);
            bytes memory g = grantBlob(ownerKey, grantParams(arr(shopSigner), GS, GD), bytes32("g"), vm.getBlockTimestamp() + 1 days);
            vm.prank(caller); vm.expectRevert(err); a5.paySignedTrusted(q, o, sig, g, nfee, txd);
        } else {
            KipurseAdapterV55.Auth memory au = authV(payee, amount, ++ref_);
            vm.prank(caller); vm.expectRevert(err); a5.prepareAuthorization(q, au, "", nfee, txd);
        }
    }

    // ======================= signed-order envelope (domain / payer / expiry) =======================
    function testFuzz_orderEnvelopeChecks(uint8 whichSeed, bool trusted, uint256 x) public {
        uint256 which = whichSeed % 5;
        KipurseAdapterV55.PaymentOrder memory o = ordV(trusted ? address(0xDE90) : bidPayee, 1e6, ++ref_, trusted ? address(wallet) : address(0));
        bytes4 err = Domain.selector;
        if (which == 0) { o.chainId = bound(x, 0, type(uint64).max); if (o.chainId == block.chainid) o.chainId++; }
        else if (which == 1) { o.adapter = address(uint160(bound(x, 1, type(uint160).max))); if (o.adapter == address(a5)) o.adapter = attacker; }
        else if (which == 2) { o.payer = address(uint160(bound(x, 1, type(uint160).max))); if (o.payer == address(wallet)) o.payer = attacker; err = Payer.selector; }
        else if (which == 3) { o.orderId = bytes32(0); err = Expired.selector; }
        else { o.deadline = vm.getBlockTimestamp() - bound(x, 0, 1e6); err = Expired.selector; }
        bytes memory sig = signOrdV(trusted ? K_SHOP : kBid, o);
        bytes memory g = grantBlob(ownerKey, grantParams(arr(shopSigner), GS, GD), bytes32("g"), vm.getBlockTimestamp() + 1 days);
        vm.prank(executor); vm.expectRevert(err);
        if (trusted) a5.paySignedTrusted(p, o, sig, g, 0, dl()); else a5.paySigned(p, o, sig, 0, dl());
    }

    // ======================= I-2 / I-7 / I-12: V5.5 inline signer grant validation =======================
    function testFuzz_signerGrantRejectsBadGrants(uint8 whichSeed, uint256 x) public {
        uint256 which = whichSeed % 13;
        KipurseTrustV55.SignerTrust memory t = grantParams(arr(shopSigner), GS, GD);
        uint256 dline = vm.getBlockTimestamp() + 1 days; uint256 k = ownerKey;
        bytes4 err;
        if (which == 0) { t.name = ""; t.merchant = keccak256(""); err = TrustName.selector; }
        else if (which == 1) { t.merchant = bytes32(x == uint256(GM) ? x + 1 : x); err = TrustName.selector; }
        else if (which == 2) { t.signers = none(); err = Trust.selector; }
        else if (which == 3) { address[] memory s17 = new address[](17); for (uint256 i; i < 17; i++) s17[i] = shopSigner; t.signers = s17; err = Trust.selector; }
        else if (which == 4) { t.single = 0; err = TrustCaps.selector; }
        else if (which == 5) { t.single = uint160(bound(x, uint256(t.daily) + 1, type(uint160).max)); err = TrustCaps.selector; }
        else if (which == 6) { t.expiry = uint64(vm.getBlockTimestamp() - bound(x, 0, 1e6)); err = TrustExpiry.selector; }
        else if (which == 7) { t.expiry = uint64(vm.getBlockTimestamp() + 365 days + bound(x, 1, 1e8)); err = TrustExpiry.selector; }
        else if (which == 8) { dline = vm.getBlockTimestamp() - bound(x, 0, 1e6); err = SigExpired.selector; }
        else if (which == 9) { t.signers = arr2(address(0), shopSigner); err = TrustSigner.selector; }
        else if (which == 10) { t.signers = arr(evilSigner); err = Signer.selector; }
        else if (which == 11) { ownerExec(address(t5), abi.encodeCall(t5.setDeniedSigner, (shopSigner, true))); err = BadSignerDenied.selector; }
        else { k = bound(x, 1, 1e30); if (k == ownerKey) k++; err = Approval.selector; }
        bytes memory g = grantBlob(k, t, bytes32("n"), dline);
        KipurseAdapterV55.PaymentOrder memory o = ordV(address(0xDE90), 1e6, ++ref_, address(wallet));
        bytes memory sig = signOrdV(K_SHOP, o);
        vm.prank(executor); vm.expectRevert(err); a5.paySignedTrusted(p, o, sig, g, 0, dl());
    }
    /// I-1: a signer-grant payment succeeds iff amount <= min(grant single, policy single) and the charge fits the grant daily
    /// and the policy daily; the per-order payee receives exactly the amount.
    function testFuzz_signerGrantCaps(uint256 amount, uint160 gs, uint160 gd, uint256 nfee) public {
        gs = uint160(bound(gs, 1, 20e6)); gd = uint160(bound(gd, gs, 30e6));
        amount = bound(amount, 1, 13e6); nfee = bound(nfee, 0, MAX_NF);
        bytes memory g = grantBlob(ownerKey, grantParams(arr(shopSigner), gs, gd), bytes32("n"), vm.getBlockTimestamp() + 1 days);
        address payee = address(uint160(uint256(keccak256(abi.encode("pi", amount)))));
        KipurseAdapterV55.PaymentOrder memory o = ordV(payee, amount, ++ref_, address(wallet));
        bytes memory sig = signOrdV(K_SHOP, o);
        uint256 charge = amount + fee(amount) + nfee;
        bool ok = amount <= gs && amount <= SINGLE && charge <= gd && charge <= DAILY;
        uint256 w0 = token.balanceOf(address(wallet));
        vm.prank(executor);
        if (!ok) vm.expectRevert();
        a5.paySignedTrusted(p, o, sig, g, nfee, dl());
        if (ok) {
            assertEq(token.balanceOf(payee), amount);
            assertEq(w0 - token.balanceOf(address(wallet)), charge, "payer debit == amount + fee + networkFee");
            assertEq(a5.merchantDaySpent(phV(), GM, 0), charge);
        }
    }
    /// I-5: one payment per (merchant, orderId) even across two signers of the same grant, and per (signer, orderId).
    function testFuzz_orderIdOncePerMerchantAcrossSigners(uint256 id, uint256 a1, uint256 a2) public {
        id = bound(id, 1, type(uint128).max); a1 = bound(a1, 1, GS); a2 = bound(a2, 1, GS);
        bytes memory g = grantBlob(ownerKey, grantParams(arr2(shopSigner, regSigner), GS, GD), bytes32("n"), vm.getBlockTimestamp() + 1 days);
        KipurseAdapterV55.PaymentOrder memory o1 = ordV(address(0xA1), a1, id, address(wallet));
        KipurseAdapterV55.PaymentOrder memory o2 = ordV(address(0xA2), a2, id, address(wallet));
        bytes memory s1 = signOrdV(K_SHOP, o1); bytes memory s2 = signOrdV(kReg, o2);
        vm.prank(executor); a5.paySignedTrusted(p, o1, s1, g, 0, dl());
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); a5.paySignedTrusted(p, o2, s2, g, 0, dl());
        vm.prank(executor); vm.expectRevert(Duplicate.selector); a5.paySignedTrusted(p, o1, s1, g, 0, dl());
        assertEq(token.balanceOf(address(0xA2)), 0);
    }

    // ======================= I-2 / I-7: inline payee trust (KPTR) =======================
    /// V5.5 (KR-05): the inline form now has the setTrust record checks, each with its specific error.
    function testFuzz_inlinePayeeTrustRejects(uint8 whichSeed, uint256 x) public {
        uint256 which = whichSeed % 13;
        KipurseTrustV5.TrustParams memory t = inlineParams();
        uint256 dline = vm.getBlockTimestamp() + 1 days; uint256 k = ownerKey; address payee = INLINE_PAYEE;
        bytes4 err = Approval.selector;
        if (which == 0) { t.merchant = bytes32(0); err = TrustName.selector; }
        else if (which == 1) { t.signers = arr(shopSigner); err = Trust.selector; }
        else if (which == 2) { t.expiry = uint64(vm.getBlockTimestamp() - bound(x, 0, 1e6)); err = TrustExpiry.selector; }
        else if (which == 3) { dline = vm.getBlockTimestamp() - bound(x, 0, 1e6); err = SigExpired.selector; }
        else if (which == 4) { payee = stranger; err = PayeeBinding.selector; }
        else if (which == 5) { k = bound(x, 1, 1e30); if (k == ownerKey) k++; }
        else if (which == 7) { t.merchant = bytes32(x == uint256(IM) ? x + 1 : x); err = TrustName.selector; }
        else if (which == 8) { t.single = uint160(bound(x, uint256(t.daily) + 1, type(uint160).max)); err = TrustCaps.selector; }
        else if (which == 9) { t.single = 0; err = TrustCaps.selector; }
        else if (which == 10) { t.expiry = uint64(vm.getBlockTimestamp() + 366 days + bound(x, 1, 1e9)); err = TrustExpiry.selector; }
        else if (which == 11) { t.payees = none(); err = Trust.selector; }
        else if (which == 12) { t.payees = arr2(address(0), INLINE_PAYEE); err = TrustPayee.selector; }
        bytes memory blob = inlineBlob(k, t, bytes32("n"), dline);
        if (which == 6) ownerExec(address(t5), abi.encodeCall(t5.untrust, (IM))); // epoch bump kills the stored signature
        KipurseAdapterV55.Direct memory d = dirV(payee, 1e6, ++ref_);
        vm.prank(executor); vm.expectRevert(err); a5.payDirect(p, d, blob, 0, dl());
    }
    /// I-1: inline trust is bounded by min(trust single, policy single) and its own daily.
    function testFuzz_inlinePayeeTrustCaps(uint256 a, uint160 s, uint160 dly) public {
        s = uint160(bound(s, 1, 20e6)); dly = uint160(bound(dly, s, 30e6)); a = bound(a, 1, 8e6);
        KipurseTrustV5.TrustParams memory t = inlineParams(); t.single = s; t.daily = dly;
        bytes memory blob = inlineBlob(ownerKey, t, bytes32("n"), vm.getBlockTimestamp() + 1 days);
        KipurseAdapterV55.Direct memory d = dirV(INLINE_PAYEE, a, ++ref_);
        bool ok = a <= s && a <= SINGLE && a + fee(a) <= dly;
        vm.prank(executor); if (!ok) vm.expectRevert();
        a5.payDirect(p, d, blob, 0, dl());
        assertEq(token.balanceOf(INLINE_PAYEE), ok ? a : 0);
    }

    // ======================= I-2 / I-5: one-time owner approval =======================
    function testFuzz_ownerApprovalBoundToEverything(uint8 whichSeed, uint256 x) public {
        uint256 which = whichSeed % 5;
        KipurseAdapterV55.Direct memory d = dirV(stranger, 3e6, ++ref_);
        bytes32 key = a5.purchaseKey(stranger, d.merchantRef, d.repeatKey);
        address apPayee = stranger; uint256 apAmount = 3e6; uint256 apDl = d.deadline; bytes32 apKey = key; uint256 k = ownerKey;
        if (which == 0) apPayee = attacker;
        else if (which == 1) apAmount = bound(x, 1, 1e12) == 3e6 ? 4e6 : bound(x, 1, 1e12);
        else if (which == 2) apDl = d.deadline + bound(x, 1, 1e6);
        else if (which == 3) apKey = keccak256(abi.encode(x));
        else { k = bound(x, 1, 1e30); if (k == ownerKey) k++; }
        bytes memory ap = approvalBy(k, apKey, apPayee, apAmount, apDl);
        vm.prank(executor); vm.expectRevert(Approval.selector); a5.payDirect(p, d, ap, 0, dl());
    }
    /// I-5: the purchase key ignores the amount and is shared by direct and x402 (one purchase, one payment).
    function testFuzz_purchaseKeySharedAcrossModes(bytes32 mref, uint256 a1, uint256 a2, bool x402First) public {
        vm.assume(mref != bytes32(0));
        a1 = bound(a1, 1, 5e6); a2 = bound(a2, 1, 5e6);
        KipurseAdapterV55.Direct memory d = KipurseAdapterV55.Direct(bidPayee, a1, mref, bytes32(0), vm.getBlockTimestamp() + 600);
        KipurseAdapterV55.Auth memory au = KipurseAdapterV55.Auth(bidPayee, a2, vm.getBlockTimestamp() - 1, vm.getBlockTimestamp() + 100, mref, bytes32(0));
        vm.startPrank(executor);
        if (x402First) { a5.prepareAuthorization(p, au, "", 0, dl()); vm.expectRevert(DuplicatePurchase.selector); a5.payDirect(p, d, "", 0, dl()); }
        else { a5.payDirect(p, d, "", 0, dl()); vm.expectRevert(DuplicatePurchase.selector); a5.prepareAuthorization(p, au, "", 0, dl()); }
        vm.stopPrank();
    }

    // ======================= x402 window / lifecycle =======================
    function testFuzz_x402Window(uint256 va, uint256 vb) public {
        uint256 nowTs = vm.getBlockTimestamp();
        va = bound(va, 0, nowTs + 1000); vb = bound(vb, 0, nowTs + 2000);
        KipurseAdapterV55.Auth memory au = KipurseAdapterV55.Auth(bidPayee, 1e6, va, vb, bytes32(++ref_), bytes32(0));
        bool ok = va < nowTs && vb > nowTs && vb - nowTs <= 600;
        vm.prank(executor); if (!ok) vm.expectRevert(Window.selector);
        a5.prepareAuthorization(p, au, "", 0, dl());
        au.merchantRef = bytes32(0);
        vm.prank(executor); vm.expectRevert(Expired.selector); a5.prepareAuthorization(p, au, "", 0, dl());
    }
    /// Reclaim / cancel / markSettled branches and the fee-claim window (fees can never get stuck; K-1 never reverts).
    function testFuzz_x402Lifecycle(uint256 a, uint256 dt, uint8 blockMode) public {
        a = bound(a, 1, 5e6); dt = bound(dt, 0, 10 days); blockMode %= 3;
        KipurseAdapterV55.Auth memory au = authV(bidPayee, a, ++ref_);
        vm.prank(executor); (address v, bytes32 dg, bytes32 n) = a5.prepareAuthorization(p, au, "", 0, dl());
        uint256 f = fee(a);
        vm.expectRevert(BadReservation.selector); a5.reclaim(keccak256("nope"));
        vm.expectRevert(NotExpired.selector); a5.reclaim(dg);
        vm.prank(attacker); vm.expectRevert(BadReservation.selector); a5.cancelReservation(dg);
        vm.prank(facilitator); token.transferWithAuthorization(v, bidPayee, a, au.validAfter, au.validBefore, n, hex"00");
        warpBy(120 + dt);
        vm.expectRevert(Settled.selector); a5.reclaim(dg);
        vm.prank(address(wallet)); vm.expectRevert(Settled.selector); a5.cancelReservation(dg);
        if (blockMode >= 1) token.setBlocklisted(address(wallet), true);
        if (blockMode == 2) token.setBlocklisted(v, true);
        uint256 acc0 = a5.accruedFees(); uint256 w0 = token.balanceOf(address(wallet)); uint256 v0 = token.balanceOf(v);
        bytes32[] memory ds = new bytes32[](2); ds[0] = dg; ds[1] = dg; // duplicate in batch is skipped
        assertEq(a5.markSettled(ds), 1);
        bool late = vm.getBlockTimestamp() >= au.validBefore + a5.FEE_CLAIM_WINDOW();
        if (!late) assertEq(a5.accruedFees() - acc0, f, "fee accrues when marked in time");
        else if (blockMode == 0) assertEq(token.balanceOf(address(wallet)) - w0, f, "late: fee back to the owner");
        else if (blockMode == 1) assertEq(token.balanceOf(v) - v0, f, "late + wallet blocklisted: fee to the vault");
        else assertEq(a5.accruedFees() - acc0, f, "late + both blocklisted: kept as protocol fee, batch never reverts");
        assertEq(a5.pendingFees(), 0);
        assertEq(PayerVaultV55(v).reserved(), 0);
    }
    /// One x402 owner approval = one reservation, even after the owner cancelled it (t1181u).
    function testFuzz_x402ApprovalSingleUse(uint256 a) public {
        a = bound(a, 1, SINGLE);
        KipurseAdapterV55.Auth memory au = authV(stranger, a, ++ref_);
        bytes memory ap = approvalBy(ownerKey, a5.purchaseKey(stranger, au.merchantRef, au.repeatKey), stranger, a, au.validBefore);
        vm.prank(executor); (, bytes32 dg,) = a5.prepareAuthorization(p, au, ap, 0, dl());
        uint256 w0 = token.balanceOf(address(wallet));
        vm.prank(address(wallet)); a5.cancelReservation(dg);
        assertEq(token.balanceOf(address(wallet)) - w0, a + fee(a), "cancel refunds value + fee");
        vm.prank(executor); vm.expectRevert(ApprovalUsed.selector); a5.prepareAuthorization(p, au, ap, 0, dl());
    }

    // ======================= I-11: a broken registry is "not listed, not blocked"; owner trust always wins =======================
    function testFuzz_registryFailureNeverBlocks(uint8 mode, uint256 a, bool optOut) public {
        mode %= 3; a = bound(a, 1, OPEN_SINGLE);
        address reg = mode == 0 ? address(new RevertingRegistry()) : mode == 1 ? address(new GasBurnRegistry()) : address(new BlockAllRegistry());
        p = grant(77, 30, pol(reg, TERM55));
        if (optOut) ownerExec(address(t5), abi.encodeCall(t5.setRegistryOptOut, (true)));
        vm.prank(executor); a5.payDirect(p, dirV(bidPayee, a, ++ref_), "", 0, dl());  // K8: owner trust beats any registry
        assertEq(token.balanceOf(bidPayee), a);
        KipurseAdapterV55.Direct memory d = dirV(stranger, a, ++ref_);
        vm.prank(executor);
        if (mode == 2 && !optOut) vm.expectRevert(RegistryBlocked.selector); // an honest block applies to stranger routing only
        a5.payDirect(p, d, "", 0, dl());
        // signed order from an unknown signer: broken registry => not listed => Signer(); honest block => RegistryBlocked
        KipurseAdapterV55.PaymentOrder memory o = ordV(regPayee, a, ++ref_, address(0));
        bytes memory sig = signOrdV(kReg, o);
        vm.prank(executor); vm.expectRevert(mode == 2 && !optOut ? RegistryBlocked.selector : Signer.selector);
        a5.paySigned(p, o, sig, 0, dl());
    }
    /// Registry tier: a registry signer may only pay a payee of the same registry merchant.
    function testFuzz_registrySignerPayeeBinding(address payee, uint256 a) public {
        vm.assume(payee != regPayee && payee.code.length == 0 && uint160(payee) > 0x10000 && payee != address(wallet)
            && payee != vaultV() && payee != address(manager) && payee != address(token) && payee != address(a5));
        a = bound(a, 1, VER_SINGLE);
        KipurseAdapterV55.PaymentOrder memory o = ordV(payee, a, ++ref_, address(0));
        bytes memory sig = signOrdV(kReg, o);
        vm.prank(executor); vm.expectRevert(PayeeBinding.selector); a5.paySigned(p, o, sig, 0, dl());
        o.payee = regPayee; sig = signOrdV(kReg, o);
        vm.prank(executor); a5.paySigned(p, o, sig, 0, dl());
        assertEq(token.balanceOf(regPayee), a);
    }

    // ======================= I-10: pause rules =======================
    function testFuzz_pauseRules(uint8 whoSeed, uint256 dt) public {
        uint256 who = whoSeed % 4; dt = bound(dt, 0, 3 days);
        address caller = who == 0 ? executor : who == 1 ? guardian : who == 2 ? _registerAsExecutor() : attacker;
        vm.prank(caller);
        if (who == 3) { vm.expectRevert(Pauser.selector); a5.pause(p); return; }
        a5.pause(p);
        assertTrue(t5.isPaused(address(wallet)));
        warpBy(dt);
        bool still = who == 1 || dt < 24 hours;   // executor / vault pause expires after 24 h; guardian pause waits for the owner
        assertEq(t5.isPaused(address(wallet)), still);
        ownerExec(address(t5), abi.encodeCall(t5.setPaused, (false)));
        assertFalse(t5.isPaused(address(wallet)), "only the owner ends any pause");
        // a pause needs a valid permission of this adapter
        ISpendPermissionManager.SpendPermission memory q = p; q.salt = 999;
        vm.prank(executor); vm.expectRevert(Permission.selector); a5.pause(q);
        vm.prank(address(t5)); vm.expectRevert(Core.selector); t5.pauseFor(address(wallet), attacker, true);
    }
    function _registerAsExecutor() internal returns (address) { vm.prank(executor); return a5.registerPermission(p); }
    /// V5.5 (KR-03): only the account or the permission's own executor may register; the vault records the permission hash.
    function testFuzz_registerPermissionChecks(uint8 whichSeed, address caller) public {
        uint256 which = whichSeed % 4;
        ISpendPermissionManager.SpendPermission memory q = p;
        if (which == 0) q.spender = attacker; else if (which == 1) q.token = attacker;
        else if (which == 2) q.extraData = hex"00"; else q.salt = 12345; // not approved in the SPM
        vm.prank(executor); vm.expectRevert(Permission.selector); a5.registerPermission(q);
        vm.assume(caller != executor && caller != address(wallet));
        vm.prank(caller); vm.expectRevert(Registrar.selector); a5.registerPermission(p);
        address v = _registerAsExecutor();
        assertEq(PayerVaultV55(v).sessionSigner(), executor); assertEq(PayerVaultV55(v).maxGasPerOp(), MAX_NF);
        assertEq(PayerVaultV55(v).permissionHash(), phV(), "vault bound to this permission");
        vm.prank(address(wallet)); assertEq(a5.registerPermission(p), v, "idempotent; same vault; the account may register too");
    }

    // ======================= Conservation: payer debit == merchant credit + fee + networkFee =======================
    function testFuzz_conservationDirect(uint256 a, uint256 nfee, uint256 lower, uint8 who) public {
        nfee = bound(nfee, 0, MAX_NF); lower = bound(lower, 0, FEE_PPM);
        if (lower < FEE_PPM) { vm.prank(feeAdmin); feeCtl.lowerFee(lower); }
        uint256 ppm = feeCtl.feePpm();
        address payee = who % 2 == 0 ? bidPayee : stranger;
        a = bound(a, 1, payee == bidPayee ? SINGLE : OPEN_SINGLE);
        if (payee == stranger && a + feeAt(a, ppm) + nfee > OPEN_DAILY) nfee = 0;
        address v = vaultV();
        uint256 w0 = token.balanceOf(address(wallet)); uint256 v0 = token.balanceOf(v); uint256 acc0 = a5.accruedFees();
        vm.prank(executor); a5.payDirect(p, dirV(payee, a, ++ref_), "", nfee, dl());
        uint256 f = feeAt(a, ppm);
        assertEq(w0 - token.balanceOf(address(wallet)), token.balanceOf(payee) + (a5.accruedFees() - acc0) + (token.balanceOf(v) - v0));
        assertEq(token.balanceOf(payee), a); assertEq(a5.accruedFees() - acc0, f); assertEq(token.balanceOf(v) - v0, nfee);
        assertLe(f, feeAt(a, 3000)); assertEq(a5.feeFor(a), f);
        assertEq(token.balanceOf(address(a5)), a5.accruedFees() + a5.pendingFees());
        uint256 c = a5.collectFees();
        assertEq(token.balanceOf(feeSafe), c); assertEq(a5.accruedFees(), 0);
    }
    /// A blocklisted fee recipient never blocks payments; fees stay accrued until the (timelocked) recipient change.
    function test_blocklistedRecipientKeepsFeesAccrued() public {
        vm.prank(executor); a5.payDirect(p, dirV(bidPayee, 1e6, ++ref_), "", 0, dl());
        token.setBlocklisted(feeSafe, true);
        vm.expectRevert(); a5.collectFees();
        vm.prank(executor); a5.payDirect(p, dirV(bidPayee, 1e6, ++ref_), "", 0, dl()); // payments continue
        assertEq(a5.accruedFees(), 2 * fee(1e6));
        vm.prank(feeAdmin); feeCtl.proposeRecipient(address(0xFEE6));
        warpBy(48 hours); feeCtl.executeRecipient();
        assertEq(a5.collectFees(), 2 * fee(1e6)); assertEq(token.balanceOf(address(0xFEE6)), 2 * fee(1e6));
    }

    /// Constructor: every dependency must be a contract.
    function testFuzz_constructorRequiresContracts(uint8 which) public {
        address[4] memory xs = [address(manager), address(token), address(vf5), address(feeCtl)];
        xs[which % 4] = address(uint160(0xE0A0 + which));
        vm.expectRevert(Contracts.selector);
        new KipurseAdapterV55(ISpendPermissionManager(xs[0]), IERC20(xs[1]), PayerVaultFactoryV55(xs[2]), KipurseFeeControllerV5(xs[3]));
    }

    // ======================= M3 float =======================
    function testFuzz_fundFloatChecks(uint8 whichSeed, uint256 x) public {
        uint256 which = whichSeed % 7;
        ownerExec(address(t5), abi.encodeCall(t5.setFloatCap, (uint160(5e5))));
        address sk = vm.addr(K_FLOAT_SESSION); uint256 amt = 2e5; uint64 exp = uint64(vm.getBlockTimestamp() + 1 hours);
        ISpendPermissionManager.SpendPermission memory q = p;
        bytes4 err;
        if (which == 0) { vm.prank(executor); a5.fundFloat(p, sk, amt, exp, 0, dl()); err = FloatOpen.selector; }
        else if (which == 1) { sk = address(0); err = Session.selector; }
        else if (which == 2) {
            KipurseAdapterV5.Policy memory pl = polStruct(address(registry), TERM55); pl.openSingle = 0; pl.openDaily = 0;
            q = grant(88, 30, abi.encode(pl)); err = Session.selector;
        }
        else if (which == 3) { exp = uint64(vm.getBlockTimestamp() - bound(x, 0, 100)); err = FloatExpiry.selector; }
        else if (which == 4) { exp = uint64(vm.getBlockTimestamp() + 1 days + bound(x, 1, 1e6)); err = FloatExpiry.selector; }
        else if (which == 5) { amt = bound(x, 5e5 + 1, SINGLE); err = FloatCap.selector; }
        else { ownerExec(address(t5), abi.encodeCall(t5.setFloatCap, (uint160(0)))); err = FloatCap.selector; }
        vm.prank(executor); vm.expectRevert(err); a5.fundFloat(q, sk, amt, exp, 0, dl());
    }
    /// The float vault signs only well-formed EIP-3009 vouchers from the session key, within session caps and gates.
    function testFuzz_floatVaultSignatureGate(uint8 whichSeed, uint256 x) public {
        uint256 which = whichSeed % 10;
        ownerExec(address(t5), abi.encodeCall(t5.setFloatCap, (uint160(5e5))));
        uint64 exp = uint64(vm.getBlockTimestamp() + 1 hours);
        vm.prank(executor); a5.fundFloat(p, vm.addr(K_FLOAT_SESSION), 3e5, exp, 0, dl());
        address fv = floatV();
        address to = FLOAT_PAYEE; uint256 val = 5e4; uint256 va = vm.getBlockTimestamp() - 1; uint256 vb = vm.getBlockTimestamp() + 60;
        bytes32 n = bytes32(x); uint256 k = K_FLOAT_SESSION;
        if (which == 1) val = 0;
        else if (which == 2) val = bound(x, OPEN_SINGLE + 1, 1e12);
        else if (which == 3) vb = exp + bound(x, 1, 1e6);
        else if (which == 4) ownerExec(address(t5), abi.encodeCall(t5.setPaused, (true)));
        else if (which == 5) ownerExec(address(t5), abi.encodeCall(t5.setDeniedPayee, (to, true)));
        else if (which == 6) to = address(wallet);
        else if (which == 7) { k = bound(x, 1, 1e30); if (k == K_FLOAT_SESSION) k++; }
        else if (which == 8) warpBy(1 hours);
        bytes memory sig = voucher(k, fv, to, val, va, vb, n);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), fv, to, val, va, vb, n))));
        bytes4 r = KipurseFloatVaultV55(fv).isValidSignature(d, sig);
        assertEq(r, which == 0 || which == 9 ? bytes4(0x1626ba7e) : bytes4(0xffffffff));
        if (which == 9) {
            assertEq(KipurseFloatVaultV55(fv).isValidSignature(d, hex"deadbeef"), bytes4(0xffffffff), "malformed never reverts");
            assertEq(KipurseFloatVaultV55(fv).isValidSignature(keccak256("other"), sig), bytes4(0xffffffff), "digest rebuilt from fields");
        }
    }
    /// Reconcile: anyone after expiry, the owner any time; fee only on what was spent (<= reserve); the rest goes back.
    function testFuzz_floatReconcile(uint256 amt, uint256 spend, bool byOwner, uint256 dt) public {
        ownerExec(address(t5), abi.encodeCall(t5.setFloatCap, (uint160(5e5))));
        amt = bound(amt, 1, 5e5); spend = bound(spend, 0, amt < OPEN_SINGLE ? amt : OPEN_SINGLE); dt = bound(dt, 0, 2 hours);
        vm.expectRevert(BadFloat.selector); a5.reconcileFloat(address(wallet));
        uint64 exp = uint64(vm.getBlockTimestamp() + 1 hours);
        vm.prank(executor); a5.fundFloat(p, vm.addr(K_FLOAT_SESSION), amt, exp, 0, dl());
        address fv = floatV();
        if (spend != 0) {
            bytes memory sig = voucher(K_FLOAT_SESSION, fv, FLOAT_PAYEE, spend, vm.getBlockTimestamp() - 1, exp, bytes32("s"));
            vm.prank(facilitator); token.transferWithAuthorization(fv, FLOAT_PAYEE, spend, vm.getBlockTimestamp() - 1, exp, bytes32("s"), sig);
        }
        warpBy(dt);
        uint256 w0 = token.balanceOf(address(wallet)); uint256 acc0 = a5.accruedFees();
        bool allowed = byOwner || vm.getBlockTimestamp() >= exp;
        vm.prank(byOwner ? address(wallet) : attacker);
        if (!allowed) { vm.expectRevert(BadFloat.selector); a5.reconcileFloat(address(wallet)); return; }
        (uint256 spent, uint256 f) = a5.reconcileFloat(address(wallet));
        assertEq(spent, spend); assertEq(f, fee(spend) < fee(amt) ? fee(spend) : fee(amt));
        assertEq(a5.accruedFees() - acc0, f);
        assertEq(token.balanceOf(address(wallet)) - w0, (amt - spend) + (fee(amt) - f), "unspent + unused reserve back");
        assertEq(token.balanceOf(fv), 0); assertEq(a5.pendingFees(), 0);
        assertFalse(a5.floatBlocked(address(wallet), FLOAT_PAYEE));
        assertTrue(a5.floatBlocked(address(wallet), address(0)));
    }
}
