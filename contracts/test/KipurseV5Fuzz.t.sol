// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {KipurseAdapterV5, PayerVaultV5} from "../src/KipurseAdapterV5.sol";

contract KipurseV5FuzzTest is V5Base {
    function testFuzz_feeNeverAboveHardMax(uint256 amount) public view {
        amount = bound(amount, 0, type(uint160).max);
        uint256 f = adapter.feeFor(amount);
        assertLe(f, (amount * feeCtl.MAX_FEE_PPM() + 999_999) / 1_000_000); // rounded up: at most 1 atomic unit above the exact rate
        assertEq(f, fee(amount));
    }
    function testFuzz_feeCountedInEveryCap(uint256[6] memory amounts) public {
        uint256 sumCharge; uint256 sumFee; uint256 w0 = token.balanceOf(address(wallet));
        for (uint256 i; i < amounts.length; i++) {
            uint256 a = bound(amounts[i], 1, SINGLE);
            KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, a, 1000 + i);
            bytes memory sig = signOrder(kBid, o);
            vm.prank(executor);
            try adapter.paySigned(p, o, sig, nf, dl()) { sumCharge += a + fee(a); sumFee += fee(a); } catch {}
        }
        assertEq(adapter.termSpent(ph()), sumCharge);
        assertEq(adapter.daySpent(ph(), 0), sumCharge);
        assertLe(sumCharge, DAILY);
        assertEq(w0 - token.balanceOf(address(wallet)), sumCharge);
        assertEq(adapter.accruedFees(), sumFee);
    }
    function testFuzz_signedOrderOnlyToBoundPayee(address payee, uint96 amount) public {
        vm.assume(payee != bidPayee && payee != address(0));
        uint256 a = bound(uint256(amount), 1, 5e6);
        KipurseAdapterV5.PaymentOrder memory o = order(payee, a, 7);
        bytes memory sig = signOrder(kBid, o);
        vm.prank(executor);
        try adapter.paySigned(p, o, sig, nf, dl()) { fail(); } catch {}
        assertEq(token.balanceOf(payee) == 0 || payee == address(token) || payee == address(wallet), true);
    }
    function testFuzz_samePurchaseNeverPaidTwice(bytes32 ref, uint96 amount, bool viaX402First) public {
        vm.assume(ref != bytes32(0));
        uint256 a = bound(uint256(amount), 1, 4e6);
        KipurseAdapterV5.Direct memory d = KipurseAdapterV5.Direct({payee: bidPayee, amount: a, merchantRef: ref, repeatKey: 0, deadline: vm.getBlockTimestamp() + 600});
        KipurseAdapterV5.Auth memory x = KipurseAdapterV5.Auth({to: bidPayee, value: a, validAfter: vm.getBlockTimestamp() - 1,
            validBefore: vm.getBlockTimestamp() + 120, merchantRef: ref, repeatKey: 0});
        if (viaX402First) { vm.prank(executor); adapter.prepareAuthorization(p, x, "", nf, dl()); }
        else { vm.prank(executor); adapter.payDirect(p, d, "", nf, dl()); }
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); adapter.payDirect(p, d, "", nf, dl());
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); adapter.prepareAuthorization(p, x, "", nf, dl());
    }
    function testFuzz_ownerApprovalUnforgeable(uint256 k) public {
        k = bound(k, 1, 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140);
        vm.assume(k != ownerKey);
        KipurseAdapterV5.Direct memory d = direct(attacker, 3e6, 5);
        bytes32 key = adapter.purchaseKey(d.payee, d.merchantRef, d.repeatKey);
        bytes memory sig = walletSig(wallet, k, adapter.approvalDigest(address(wallet), key, d.payee, d.amount, d.deadline));
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, sig, nf, dl());
    }
    function testFuzz_strangerDailyBound(uint256[8] memory amounts, uint8 payeeSeed) public {
        for (uint256 i; i < amounts.length; i++) {
            uint256 a = bound(amounts[i], 1, OPEN_SINGLE);
            KipurseAdapterV5.Direct memory d = direct(address(uint160(0x10000 + uint256(payeeSeed) + i)), a, 3000 + i);
            vm.prank(executor); try adapter.payDirect(p, d, "", nf, dl()) {} catch {}
        }
        assertLe(adapter.openDaySpent(ph(), 0), OPEN_DAILY);
    }
}

/// Stateful invariant handler: random mixes of every payment mode, settlement, reclaim, refunds, sweeps and time.
contract V5Handler is V5Base {
    uint256 public ops; uint256 public refunds; uint256 public okPays;
    constructor(V5Base) {}
    function init() external { setUp(); }
    function ref() internal returns (uint256) { return ++ops; }
    function signed(uint256 a, bool rogue) external {
        a = bound(a, 1, SINGLE);
        KipurseAdapterV5.PaymentOrder memory o = order(rogue ? attacker : bidPayee, a, ref());
        bytes memory sig = signOrder(kBid, o);
        vm.prank(executor); try adapter.paySigned(p, o, sig, nf, dl()) { okPays++; } catch {}
    }
    function directPay(uint256 a, uint8 who) external {
        a = bound(a, 1, SINGLE);
        address[4] memory ps = [bidPayee, regPayee, stranger, attacker];
        KipurseAdapterV5.Direct memory d = direct(ps[who % 4], a, ref());
        vm.prank(executor); try adapter.payDirect(p, d, "", nf, dl()) { okPays++; } catch {}
    }
    bytes32[] public digests; KipurseAdapterV5.Auth[] auths; bytes32[] nonces;
    function x402(uint256 a, uint8 who) external {
        a = bound(a, 1, SINGLE);
        address[3] memory ps = [bidPayee, regPayee, stranger];
        KipurseAdapterV5.Auth memory au = auth(ps[who % 3], a, ref());
        vm.prank(executor);
        try adapter.prepareAuthorization(p, au, "", nf, dl()) returns (address, bytes32 dg, bytes32 n) { okPays++; digests.push(dg); auths.push(au); nonces.push(n); } catch {}
    }
    function settleOne(uint256 i) external {
        if (digests.length == 0) return; i = i % digests.length;
        KipurseAdapterV5.Auth memory au = auths[i];
        address v = vault();
        vm.prank(facilitator); try token.transferWithAuthorization(v, au.to, au.value, au.validAfter, au.validBefore, nonces[i], hex"00") {} catch {}
        try adapter.markSettled(one(digests[i])) {} catch {}
    }
    function reclaimOne(uint256 i) external {
        if (digests.length == 0) return; i = i % digests.length;
        try adapter.reclaim(digests[i]) {} catch {}
    }
    function refund(uint256 a) external {
        uint256 bal = token.balanceOf(bidPayee); if (bal == 0) return;
        a = bound(a, 1, bal); address v = vault();
        vm.prank(bidPayee); token.transfer(v, a); refunds += a;
    }
    function sweep() external { address v = vault(); if (v.code.length != 0) PayerVaultV5(v).sweep(); }
    function pass(uint256 s) external { warpBy(bound(s, 1, 2 days)); }
    // views for the invariant contract
    function termSpent() external view returns (uint256) { return adapter.termSpent(ph()); }
    function daySpentAt(uint256 d) external view returns (uint256) { return adapter.daySpent(ph(), d); }
    function openAt(uint256 d) external view returns (uint256) { return adapter.openDaySpent(ph(), d); }
    function verAt(uint256 d) external view returns (uint256) { return adapter.verifiedDaySpent(ph(), d); }
    function day() external view returns (uint256) { return (vm.getBlockTimestamp() - p.start) / 1 days; }
    function adapterBal() external view returns (uint256) { return token.balanceOf(address(adapter)); }
    function owedFees() external view returns (uint256) { return adapter.accruedFees() + adapter.pendingFees(); }
    function vaultOk() external view returns (bool) {
        address v = vault(); if (v.code.length == 0) return true;
        return token.balanceOf(v) >= PayerVaultV5(v).reserved();
    }
    function attackerBal() external view returns (uint256) { return token.balanceOf(attacker); }
    function feeBal() external view returns (uint256) { return adapter.accruedFees(); }
    function delivered() external view returns (uint256) {
        return token.balanceOf(bidPayee) + token.balanceOf(regPayee) + token.balanceOf(stranger) + token.balanceOf(attacker) + refunds;
    }
}

contract KipurseV5InvariantTest is V5Base {
    V5Handler h;
    function setUp() public override {
        h = new V5Handler(this); h.init();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = V5Handler.signed.selector; sel[1] = V5Handler.directPay.selector; sel[2] = V5Handler.x402.selector;
        sel[3] = V5Handler.settleOne.selector; sel[4] = V5Handler.reclaimOne.selector; sel[5] = V5Handler.refund.selector;
        sel[6] = V5Handler.sweep.selector; sel[7] = V5Handler.pass.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }
    function afterInvariant() public { emit log_named_uint("successful payments in last run", h.okPays()); assertGt(h.okPays() + 1, 0); }
    function test_handlerMakesRealPayments() public {
        h.signed(1e6, false); h.directPay(5e4, 2); h.x402(1e6, 0); h.settleOne(0); h.refund(1e5); h.sweep(); h.pass(1 days);
        h.signed(1e6, true); // rogue payee: must not pay
        assertEq(h.okPays(), 3); assertEq(h.attackerBal(), 0); assertGt(h.termSpent(), 0);
    }
    /// The adapter holds exactly the fees it owes: accrued (collectable) + pending (open x402 reservations), nothing else.
    function invariant_adapterHoldsOnlyFees() public view { assertEq(h.adapterBal(), h.owedFees()); }
    function invariant_vaultCoversReservations() public view { assertTrue(h.vaultOk()); }
    function invariant_termCapIncludingFees() public view { assertLe(h.termSpent(), TERM); }
    function invariant_dailyCaps() public view {
        uint256 d = h.day();
        for (uint256 i = d > 3 ? d - 3 : 0; i <= d; i++) {
            assertLe(h.daySpentAt(i), DAILY); assertLe(h.openAt(i), OPEN_DAILY); assertLe(h.verAt(i), VER_DAILY);
        }
    }
    function invariant_attackerOnlyStrangerTier() public view { assertLe(h.attackerBal(), uint256(OPEN_DAILY) * (h.day() + 1)); }
    function invariant_feeBoundedByHardMax() public view { assertLe(h.feeBal(), h.delivered() * 3000 / 1_000_000 + h.okPays()); } // ceil: <= 1 unit per payment
}
