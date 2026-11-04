// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {S} from "./SpmCast.sol";
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {KipurseTrustV5} from "../src/KipurseTrustV5.sol";
import {KipurseAdapterV5, PayerVaultV5} from "../src/KipurseAdapterV5.sol";
import {KipurseMerchantRegistry} from "../src/KipurseMerchantRegistry.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";

contract RevertingRegistry {
    function lookupPayee(address) external pure returns (bytes32, uint160, uint160) { revert("boom"); }
    function lookupSigner(address) external pure returns (bytes32, uint160, uint160) { revert("boom"); }
    function isPayeeOf(bytes32, address) external pure returns (bool) { revert("boom"); }
    function blocked(address) external pure returns (bool) { revert("boom"); }
}
contract GasBurnerRegistry {
    function _burn() internal pure { uint256 i; while (true) { i++; } }
    function lookupPayee(address) external pure returns (bytes32, uint160, uint160) { _burn(); }
    function lookupSigner(address) external pure returns (bytes32, uint160, uint160) { _burn(); }
    function isPayeeOf(bytes32, address) external pure returns (bool) { _burn(); }
    function blocked(address) external pure returns (bool) { _burn(); }
}
contract OtherToken is ERC20 { constructor() ERC20("Other", "OTH") { _mint(msg.sender, 1e24); } }

/// Attack and life-cycle scenarios from the design doc (S1b, S3, S5-S11) plus pause and registry compromise.
contract KipurseV5ScenariosTest is V5Base {
    // ======================= S6: leaked merchant signer =======================
    function test_S6_leakedSigner_cannotRedirectToAnyOtherPayee() public {
        // attacker holds ExampleShop's signing key (kBid)
        expectSignedRevert(kBid, attacker, 1e6, 1, abi.encodeWithSelector(PayeeBinding.selector));
        expectSignedRevert(kBid, stranger, 5e4, 2, abi.encodeWithSelector(PayeeBinding.selector)); // not even within stranger caps
        expectSignedRevert(kBid, regPayee, 1e6, 3, abi.encodeWithSelector(PayeeBinding.selector));
        assertEq(token.balanceOf(attacker), 0);
    }
    function test_S6_leakedSigner_worstCaseIsOverpayingRealMerchantWithinCaps() public {
        uint256 paid; uint256 i;
        while (true) {
            KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 5e6, 100 + i);
            bytes memory sig = signOrder(kBid, o);
            vm.prank(executor);
            try adapter.paySigned(p, o, sig, nf, dl()) { paid += 5e6 + fee(5e6); i++; } catch { break; }
        }
        assertEq(i, 2); // 2 x 5.0002 <= 12/day
        assertLe(paid, DAILY);
        assertEq(token.balanceOf(attacker), 0);
    }
    function test_S6_ownerBlacklistsSignerOnChain_noReSign() public {
        bytes32 h0 = ph();
        ownerCall(abi.encodeCall(trustC.setDeniedSigner, (bidSigner, true)));
        expectSignedRevert(kBid, bidPayee, 1e6, 1, abi.encodeWithSelector(BadSignerDenied.selector));
        // rotate to a new ExampleShop signer with one owner call; same permission, nothing re-signed
        uint256 kNew = 0xB1D2;
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(vm.addr(kNew)), SINGLE, DAILY, 0);
        paySigned(kNew, bidPayee, 1e6, 2);
        assertEq(ph(), h0); assertTrue(manager.isValid(S(p)));
        expectSignedRevert(kBid, bidPayee, 1e6, 3, abi.encodeWithSelector(BadSignerDenied.selector));
    }
    function test_S6_denySignerBySig_relayedByExecutor() public {
        bytes32 n = keccak256("deny-1"); uint256 dline = vm.getBlockTimestamp() + 600;
        bytes32 sh = keccak256(abi.encode(trustC.DENY_SIGNER_TYPEHASH(), address(wallet), bidSigner, n, dline));
        bytes memory sig = ownerSig(adapter.ownerDigest(sh));
        vm.prank(executor); trustC.denySignerBySig(address(wallet), bidSigner, n, dline, sig);
        assertTrue(trustC.deniedSigner(address(wallet), bidSigner));
        expectSignedRevert(kBid, bidPayee, 1e6, 1, abi.encodeWithSelector(BadSignerDenied.selector));
        vm.prank(executor); vm.expectRevert(SigNonce.selector); trustC.denySignerBySig(address(wallet), bidSigner, n, dline, sig);
    }
    function test_S6_registrySignerLeak_blockedImmediately() public {
        paySigned(kReg, regPayee, 1e6, 1);
        vm.prank(maintainer); registry.setBlocked(regSigner, true);
        expectSignedRevert(kReg, regPayee, 1e6, 2, abi.encodeWithSelector(RegistryBlocked.selector));
        payDirect(regPayee, 1e6, 3); // the merchant's payee itself is still verified for direct / x402
    }

    // ======================= S5: phishing / fake merchant =======================
    function test_S5a_fakeSiteOwnPayeeFallsToStrangerTier() public {
        address fake = address(0xF4CE); // "exampleshop-ai.example" with its own address
        expectDirectRevert(fake, 5e6, 1, abi.encodeWithSelector(BadStranger.selector));
        payDirect(fake, 99_900, 2);
        payDirect(fake, 99_900, 3);
        expectDirectRevert(fake, 1_000, 4, abi.encodeWithSelector(StrangerDailyCap.selector));
        assertLe(token.balanceOf(fake), OPEN_DAILY);
        vm.prank(executor); vm.expectRevert(BadStranger.selector);
        adapter.prepareAuthorization(p, auth(fake, 5e6, 5), "", nf, dl());
    }
    function test_S5a_fakeSiteSignedOrderRejected() public {
        expectSignedRevert(kEvil, address(0xF4CE), 5e6, 1, abi.encodeWithSelector(Signer.selector));
        expectSignedRevert(kEvil, bidPayee, 5e6, 2, abi.encodeWithSelector(Signer.selector)); // even naming the real payee
    }
    function test_S5b_fakeSiteUsingRealPayee_moneyGoesToRealMerchant() public {
        payDirect(bidPayee, 1e6, 1);
        assertEq(token.balanceOf(bidPayee), 1e6);
    }
    function test_S5c_promptInjectionToArbitraryAddressBounded() public {
        uint256 i;
        while (true) {
            KipurseAdapterV5.Direct memory d = direct(attacker, 99_900, 500 + i);
            vm.prank(executor);
            try adapter.payDirect(p, d, "", nf, dl()) { i++; } catch { break; }
        }
        assertEq(token.balanceOf(attacker), 2 * 99_900);
        assertLe(token.balanceOf(attacker) + adapter.accruedFees(), OPEN_DAILY);
    }

    // ======================= S3: double purchase =======================
    function test_S3_twoAgentsSamePurchaseDifferentIntentIds_paidOnce() public {
        // agent A and agent B both resolve the same server-provided x402 resource + nonce (never the client payment-identifier)
        bytes32 ref = keccak256("x402:https://api.example/report|nonce:abc");
        KipurseAdapterV5.Direct memory d = KipurseAdapterV5.Direct({payee: bidPayee, amount: 1e6, merchantRef: ref, repeatKey: 0,
            deadline: vm.getBlockTimestamp() + 600});
        vm.prank(executor); adapter.payDirect(p, d, "", nf, dl());
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); adapter.payDirect(p, d, "", nf, dl());
        assertEq(token.balanceOf(bidPayee), 1e6);
    }
    function test_S3_crossModeDuplicateBlocked() public {
        payDirect(bidPayee, 1e6, 42);
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector);
        adapter.prepareAuthorization(p, auth(bidPayee, 1e6, 42), "", nf, dl());
        (,, bytes32 n) = prepare(auth(bidPayee, 1e6, 43));
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 43);
        assertEq(adapter.purchaseKey(d.payee, d.merchantRef, d.repeatKey), n);
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); adapter.payDirect(p, d, "", nf, dl());
    }
    function test_S3_signedOrderOnce_evenAfterSignerRotation() public {
        paySigned(kBid, bidPayee, 1e6, 7);
        expectSignedRevert(kBid, bidPayee, 1e6, 7, abi.encodeWithSelector(Duplicate.selector));
        uint256 kNew = 0xB1D3;
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(vm.addr(kNew)), SINGLE, DAILY, 0);
        expectSignedRevert(kNew, bidPayee, 1e6, 7, abi.encodeWithSelector(DuplicatePurchase.selector)); // same merchant order id, new key
        assertEq(token.balanceOf(bidPayee), 1e6);
    }
    function test_S3_explicitRepeatAllowed() public {
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 9);
        vm.prank(executor); adapter.payDirect(p, d, "", nf, dl());
        d.repeatKey = bytes32(uint256(20261018)); // e.g. tomorrow's daily report
        vm.prank(executor); adapter.payDirect(p, d, "", nf, dl());
        assertEq(token.balanceOf(bidPayee), 2e6);
    }
    function test_S3_zeroMerchantRefRejected() public {
        expectDirectRevert(bidPayee, 1e6, 0, abi.encodeWithSelector(Expired.selector));
    }

    // ======================= S7: compromised agent / executor =======================
    function test_S7_executorCannotTrustUntrustOrUnpauseForTheWallet() public {
        vm.prank(executor);
        trustC.setTrust(trustParams("evil", arr(attacker), arr(evilSigner), SINGLE, DAILY, 0)); // writes executor's OWN record
        expectSignedRevert(kEvil, attacker, 1e6, 1, abi.encodeWithSelector(Signer.selector));
        expectDirectRevert(attacker, 1e6, 2, abi.encodeWithSelector(BadStranger.selector));
        vm.prank(executor); adapter.pause(p);
        vm.prank(executor); trustC.setPaused(false); // only clears the executor's OWN record
        assertTrue(trustC.isPaused(address(wallet)));
        vm.prank(executor); trustC.untrust(EXAMPLESHOP);
        ownerCall(abi.encodeCall(trustC.setPaused, (false)));
        paySigned(kBid, bidPayee, 1e6, 3); // wallet's ExampleShop record untouched
    }
    function test_S7_executorCannotForgeOwnerTrust() public {
        KipurseTrustV5.TrustParams memory t = trustParams("evil", arr(attacker), none(), SINGLE, DAILY, 0);
        bytes32 n = keccak256("t1"); uint256 dline = vm.getBlockTimestamp() + 600;
        bytes32 d = trustDigest(address(wallet), t, n, dline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(kEvil, d);
        vm.prank(executor); vm.expectRevert(OwnerSig.selector); trustC.trustBySig(address(wallet), t, n, dline, abi.encodePacked(r, s, v));
        // a wrapper signature by a non-owner key through the wallet's 1271 also fails
        bytes memory w = walletSig(wallet, kEvil, d);
        vm.prank(executor); vm.expectRevert(); trustC.trustBySig(address(wallet), t, keccak256("t2"), dline, w);
        expectDirectRevert(attacker, 1e6, 1, abi.encodeWithSelector(BadStranger.selector));
    }
    function test_S7_executorCannotCancelOrStealReservations() public {
        (address v, bytes32 digest,) = prepare(auth(bidPayee, 1e6, 60));
        vm.prank(executor); vm.expectRevert(BadReservation.selector); adapter.cancelReservation(digest);
        vm.prank(executor); assertEq(adapter.markSettled(one(digest)), 0); // not settled: nothing closes
        vm.prank(executor); vm.expectRevert(NotAccount.selector); PayerVaultV5(v).withdraw(IERC20(address(token)), executor, 1);
        PayerVaultV5(v).sweep(); // returns nothing: everything is reserved
        assertEq(token.balanceOf(v), 1e6);
    }
    function test_S7_compromisedExecutorTotalDailyDamageBounded() public {
        // everything an attacker controlling the executor can push out in one day, across all tiers
        uint256 w0 = token.balanceOf(address(wallet));
        for (uint256 i; i < 40; i++) {
            KipurseAdapterV5.Direct memory d = direct(attacker, 99_900, 900 + i);
            vm.prank(executor); try adapter.payDirect(p, d, "", nf, dl()) {} catch {}
            KipurseAdapterV5.Direct memory d2 = direct(regPayee, 19e5, 1900 + i);
            vm.prank(executor); try adapter.payDirect(p, d2, "", nf, dl()) {} catch {}
            KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 5e6, 2900 + i);
            bytes memory sig = signOrder(kBid, o);
            vm.prank(executor); try adapter.paySigned(p, o, sig, nf, dl()) {} catch {}
        }
        uint256 out = w0 - token.balanceOf(address(wallet));
        assertLe(out, DAILY);
        assertLe(token.balanceOf(attacker), OPEN_DAILY);
        assertEq(adapter.daySpent(ph(), 0), out);
    }
    function test_S7_executorOfAnotherPermissionCannotSpend() public {
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 70);
        vm.prank(address(0xE2)); vm.expectRevert(BadExecutor.selector); adapter.payDirect(p, d, "", nf, dl());
    }

    // ======================= S1b: one-tap owner trust by signature =======================
    function _trustSig(KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        return ownerSig(trustDigest(address(wallet), t, n, dline));
    }
    function test_S1b_trustBySig_firstMerchantThenAutoPay() public {
        address shop = address(0x5409); uint256 kShop = 0x5409;
        KipurseTrustV5.TrustParams memory t = trustParams("new-shop.example", arr(shop), arr(vm.addr(kShop)), 3e6, 4e6, 0);
        bytes32 n = keccak256("trust-1"); uint256 dline = vm.getBlockTimestamp() + 600;
        expectDirectRevert(shop, 1e6, 1, abi.encodeWithSelector(BadStranger.selector));
        bytes memory sig = _trustSig(t, n, dline);
        bytes32 h0 = ph();
        vm.prank(executor); trustC.trustBySig(address(wallet), t, n, dline, sig);
        payDirect(shop, 1e6, 2);
        paySigned(kShop, shop, 2e6, 3);
        expectDirectRevert(shop, 1e6, 4, abi.encodeWithSelector(MerchantDailyCap.selector)); // 3.00012 + 1.00004 > 4
        assertEq(ph(), h0); // no re-sign
        vm.prank(executor); vm.expectRevert(SigNonce.selector); trustC.trustBySig(address(wallet), t, n, dline, sig);
    }
    function test_S1b_staleTrustSigCannotBeReplayedAfterUntrust() public {
        address shop = address(0x540A);
        KipurseTrustV5.TrustParams memory t = trustParams("shop-a", arr(shop), none(), 3e6, 4e6, 0);
        uint256 dline = vm.getBlockTimestamp() + 3600;
        bytes memory sigUnused = _trustSig(t, keccak256("n-unused"), dline); // signed but never submitted
        vm.prank(executor); trustC.trustBySig(address(wallet), t, keccak256("n-used"), dline, _trustSig(t, keccak256("n-used"), dline));
        ownerCall(abi.encodeCall(trustC.untrust, (keccak256("shop-a"))));
        expectDirectRevert(shop, 1e6, 1, abi.encodeWithSelector(BadStranger.selector));
        vm.prank(executor); vm.expectRevert(OwnerSig.selector); // epoch moved on
        trustC.trustBySig(address(wallet), t, keccak256("n-unused"), dline, sigUnused);
    }
    function test_S1b_trustSigExpiredAndWrongAccount() public {
        KipurseTrustV5.TrustParams memory t = trustParams("shop-b", arr(address(0x540B)), none(), 1e6, 1e6, 0);
        uint256 dline = vm.getBlockTimestamp() + 60;
        bytes memory sig = _trustSig(t, keccak256("n"), dline);
        warpBy(61);
        vm.prank(executor); vm.expectRevert(SigExpired.selector); trustC.trustBySig(address(wallet), t, keccak256("n"), dline, sig);
        vm.prank(executor); vm.expectRevert(); trustC.trustBySig(executor, t, keccak256("n"), dline + 1000, sig); // EOA account: no 1271
    }
    function test_S1b_untrustBySig_oneTap() public {
        bytes32 n = keccak256("u1"); uint256 dline = vm.getBlockTimestamp() + 600;
        bytes32 sh = keccak256(abi.encode(trustC.UNTRUST_TYPEHASH(), address(wallet), EXAMPLESHOP, n, dline));
        vm.prank(executor); trustC.untrustBySig(address(wallet), EXAMPLESHOP, n, dline, ownerSig(adapter.ownerDigest(sh)));
        expectSignedRevert(kBid, bidPayee, 1e6, 1, abi.encodeWithSelector(Signer.selector));
        expectDirectRevert(bidPayee, 1e6, 2, abi.encodeWithSelector(BadStranger.selector));
        assertTrue(manager.isValid(S(p)));
    }
    function test_S1b_trustExpiry() public {
        ownerSetTrust("tmp", arr(address(0x7E3)), none(), 2e6, 2e6, uint64(vm.getBlockTimestamp() + 1 days));
        payDirect(address(0x7E3), 1e6, 1);
        warpBy(1 days);
        expectDirectRevert(address(0x7E3), 1e6, 2, abi.encodeWithSelector(BadStranger.selector));
    }

    // ======================= S11: refund =======================
    function test_S11_refundToPayerReturnsToOwner() public {
        paySigned(kBid, bidPayee, 5e6, 1);
        uint256 w = token.balanceOf(address(wallet));
        uint256 spentBefore = adapter.termSpent(ph());
        // merchant refunds "to sender": the on-chain sender is the owner's vault, not a shared contract
        { address vv = vault(); vm.prank(bidPayee); token.transfer(vv, 5e6); }
        vm.prank(attacker); PayerVaultV5(vault()).sweep(); // anyone can trigger, funds only go to the wallet
        assertEq(token.balanceOf(address(wallet)), w + 5e6);
        assertEq(adapter.termSpent(ph()), spentBefore); // conservative: refunds do not restore caps
        assertEq(token.balanceOf(address(adapter)), adapter.accruedFees());
    }
    function test_S11_ownerWithdrawsRefundAndOtherTokens() public {
        payDirect(bidPayee, 1e6, 1);
        { address vv = vault(); vm.prank(bidPayee); token.transfer(vv, 4e5); }
        OtherToken o = new OtherToken(); o.transfer(vault(), 7e18);
        vm.startPrank(owner);
        wallet.execute(vault(), 0, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(token)), owner, 4e5)));
        wallet.execute(vault(), 0, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(o)), owner, 7e18)));
        vm.stopPrank();
        assertEq(token.balanceOf(owner), 4e5); assertEq(o.balanceOf(owner), 7e18);
    }
    function test_S11_ownerCannotWithdrawReservedButCanCancel() public {
        (address v, bytes32 digest,) = prepare(auth(bidPayee, 1e6, 2));
        vm.prank(owner); vm.expectRevert(Reserved.selector);
        wallet.execute(v, 0, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(token)), owner, 1)));
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        assertEq(token.balanceOf(v), 0);
    }

    // ======================= S9: expiry =======================
    function test_S9_expiryStopsEverythingNoRenewal() public {
        warpBy(30 days - 1);
        payDirect(bidPayee, 1e6, 1);
        warpBy(1);
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 2);
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, "", nf, dl());
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 1e6, 3); bytes memory sig = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(); adapter.paySigned(p, o, sig, nf, dl());
        warpBy(365 days);
        d = direct(bidPayee, 1e6, 4);
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, "", nf, dl());
        // balance stays and is withdrawable by the owner
        uint256 bal = token.balanceOf(address(wallet));
        vm.prank(owner); wallet.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (owner, bal)));
        assertEq(token.balanceOf(owner), bal);
    }
    function test_S9_reservationOpenAtExpiryStillReclaimable() public {
        warpBy(30 days - 60);
        (, bytes32 digest,) = prepare(auth(bidPayee, 1e6, 5));
        uint256 w = token.balanceOf(address(wallet));
        warpBy(1 days); // permission expired, adapter has no further authority
        adapter.reclaim(digest);
        assertEq(token.balanceOf(address(wallet)), w + 1e6 + fee(1e6));
    }

    // ======================= S10: owner top-up mid-term =======================
    function test_S10_topUpMidTermUsableClockUnchanged() public {
        bytes32 h0 = ph(); uint48 end0 = p.end;
        for (uint256 i; i < 2; i++) paySigned(kBid, bidPayee, 5e6, 10 + i);
        uint256 spent = adapter.termSpent(h0);
        warpBy(10 days);
        token.mint(address(wallet), 50e6); // owner deposits; no approval, no new permission
        assertEq(ph(), h0); assertEq(p.end, end0); assertEq(adapter.termSpent(h0), spent);
        SpendPermissionManager.PeriodSpend memory s = manager.getCurrentPeriod(S(p));
        assertEq(s.start, p.start); assertEq(s.end, p.end);
        paySigned(kBid, bidPayee, 5e6, 20); paySigned(kBid, bidPayee, 5e6, 21);
        warpBy(1 days);
        paySigned(kBid, bidPayee, 5e6, 22);
        assertEq(adapter.termSpent(h0), 5 * (5e6 + fee(5e6)));
        expectSignedRevert(kBid, bidPayee, 5e6, 23, abi.encodeWithSelector(TermCap.selector)); // the 30 term cap still binds after the top-up
    }

    // ======================= pause (C7) =======================
    function test_pause_executorAndGuardianCanPauseOnlyOwnerUnpauses() public {
        vm.prank(attacker); vm.expectRevert(Pauser.selector); adapter.pause(p);
        vm.prank(guardian); adapter.pause(p);
        expectDirectRevert(bidPayee, 1e6, 1, abi.encodeWithSelector(WalletPaused.selector));
        expectSignedRevert(kBid, bidPayee, 1e6, 2, abi.encodeWithSelector(WalletPaused.selector));
        vm.prank(executor); vm.expectRevert(WalletPaused.selector); adapter.prepareAuthorization(p, auth(bidPayee, 1e6, 3), "", nf, dl());
        vm.prank(guardian); trustC.setPaused(false); vm.prank(executor); trustC.setPaused(false);
        assertTrue(trustC.paused(address(wallet)));
        ownerCall(abi.encodeCall(trustC.setPaused, (false)));
        payDirect(bidPayee, 1e6, 4);
        vm.prank(executor); adapter.pause(p);
        assertTrue(trustC.isPaused(address(wallet)));
    }
    function test_pause_requiresLivePermission() public {
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.revoke, (S(p))));
        vm.prank(executor); vm.expectRevert(Permission.selector); adapter.pause(p);
    }
    function test_pause_exitStillWorksWhilePaused() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 5);
        (address v, bytes32 d1,) = prepare(a);
        (, bytes32 d2,) = prepare(auth(bidPayee, 1e6, 6));
        token.mint(v, 1e5); // a refund arrives
        vm.prank(executor); adapter.pause(p);
        PayerVaultV5(v).sweep();
        ownerCall(abi.encodeCall(adapter.cancelReservation, (d1)));
        warpBy(121); adapter.reclaim(d2);
        assertEq(token.balanceOf(v), 0);
        assertEq(token.balanceOf(address(wallet)), 100e6 + 1e5);
    }

    // ======================= S8: full outage exit (owner only, no executor / service / paymaster) =======================
    function test_S8_serviceDownOwnerExit() public {
        paySigned(kBid, bidPayee, 1e6, 1);
        (, bytes32 digest,) = prepare(auth(regPayee, 1e6, 2)); // an in-flight x402 reservation
        { address vv = vault(); vm.prank(bidPayee); token.transfer(vv, 1e6); }      // and a refund sitting in the vault
        // --- service gone: only the owner (and permissionless calls) from here on ---
        vm.startPrank(owner);
        wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setPaused, (true)));
        wallet.execute(address(adapter), 0, abi.encodeCall(adapter.cancelReservation, (digest)));
        wallet.execute(address(manager), 0, abi.encodeCall(manager.revoke, (S(p))));
        vm.stopPrank();
        PayerVaultV5(vault()).sweep();
        uint256 bal = token.balanceOf(address(wallet));
        vm.startPrank(owner);
        wallet.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (owner, bal)));
        wallet.removeOwnerAtIndex(1, abi.encode(address(manager))); // kill switch: SPM no longer a wallet owner
        vm.stopPrank();
        assertEq(token.balanceOf(owner), 100e6 - 1e6 - fee(1e6) + 1e6);
        assertEq(token.balanceOf(vault()), 0); assertEq(token.balanceOf(address(wallet)), 0);
        assertEq(token.balanceOf(address(adapter)), fee(1e6)); // only the earned fee of the settled payment
        assertTrue(manager.isRevoked(S(p))); assertFalse(wallet.isOwnerAddress(address(manager)));
        ownerCall(abi.encodeCall(trustC.setPaused, (false)));
        token.mint(address(wallet), 1e6);
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 3);
        vm.prank(executor); vm.expectRevert(); adapter.payDirect(p, d, "", nf, dl());
    }

    // ======================= registry maintainer compromise =======================
    function test_R_compromisedMaintainer_timelockThenBoundedByOwnerVerifiedCaps() public {
        address[] memory evilPayees = arr2(address(0xE1), address(0xE2));
        vm.prank(maintainer); registry.propose(keccak256("evil1"), evilPayees, arr(evilSigner), 100e6, 100e6, "x");
        vm.prank(maintainer); registry.propose(keccak256("evil2"), arr(address(0xE3)), none(), 100e6, 100e6, "y");
        vm.expectRevert(Timelock.selector); registry.execute(keccak256("evil1"), evilPayees, arr(evilSigner), 100e6, 100e6, "x");
        expectDirectRevert(address(0xE1), 1e6, 1, abi.encodeWithSelector(BadStranger.selector)); // not live during the 48h public window
        warpBy(48 hours);
        registry.execute(keccak256("evil1"), evilPayees, arr(evilSigner), 100e6, 100e6, "x");
        registry.execute(keccak256("evil2"), arr(address(0xE3)), none(), 100e6, 100e6, "y");
        expectDirectRevert(address(0xE1), 5e6, 2, abi.encodeWithSelector(VerifiedCap.selector)); // registry says 100, owner ceiling is 2
        payDirect(address(0xE1), 19e5, 3);
        payDirect(address(0xE2), 19e5, 4);
        expectDirectRevert(address(0xE3), 19e5, 5, abi.encodeWithSelector(VerifiedDailyCap.selector)); // 5/day aggregate across ALL registry merchants
        assertLe(adapter.verifiedDaySpent(ph(), adapter.dayIndex(p)), VER_DAILY);
        // owner opts out: immediate, no re-sign
        ownerCall(abi.encodeCall(trustC.setRegistryOptOut, (true)));
        expectDirectRevert(address(0xE3), 19e5, 6, abi.encodeWithSelector(BadStranger.selector));
        ownerCall(abi.encodeCall(trustC.setRegistryOptOut, (false)));
        // honest signers remove it: immediate
        vm.prank(maintainer); registry.remove(keccak256("evil2"));
        warpBy(1 days);
        expectDirectRevert(address(0xE3), 1e6, 7, abi.encodeWithSelector(BadStranger.selector));
    }
    function test_R_compromisedMaintainerCannotHijackOwnerTrustedMerchant() public {
        // registry re-binds ExampleShop's real signer and payee to an attacker merchant
        vm.prank(maintainer); registry.propose(keccak256("evil"), arr2(bidPayee, attacker), arr(bidSigner), 100e6, 100e6, "z");
        warpBy(48 hours);
        registry.execute(keccak256("evil"), arr2(bidPayee, attacker), arr(bidSigner), 100e6, 100e6, "z");
        expectSignedRevert(kBid, attacker, 1e6, 1, abi.encodeWithSelector(PayeeBinding.selector)); // owner trust wins and binds payees
        paySigned(kBid, bidPayee, 5e6, 2);                                  // owner caps, not registry
        // the attacker payee only gets the registry tier (capped)
        expectDirectRevert(attacker, 3e6, 3, abi.encodeWithSelector(VerifiedCap.selector));
    }
    /// K8: a registry block (maintainer) never overrides the owner's own trust; it only affects registry / stranger routing.
    function test_R_maintainerBlockCannotOverrideOwnerTrust() public {
        vm.prank(maintainer); registry.setBlocked(bidPayee, true);
        paySigned(kBid, bidPayee, 1e6, 1);                         // owner-trusted: still pays
        vm.prank(maintainer); registry.setBlocked(stranger, true);
        expectDirectRevert(stranger, 5e4, 2, abi.encodeWithSelector(RegistryBlocked.selector)); // not owner-trusted: block applies
        ownerCall(abi.encodeCall(trustC.setRegistryOptOut, (true)));
        payDirect(stranger, 5e4, 3);                                // owner opted out of the registry
    }
    function test_R_brokenOrGriefingRegistryDegradesToOwnerTrustAndStranger() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(new RevertingRegistry()), TERM);
        ISpendPermissionManager.SpendPermission memory q = grant(11, 30, abi.encode(x));
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 1e6, 1); bytes memory sig = signOrder(kBid, o);
        vm.prank(executor); adapter.paySigned(q, o, sig, nf, dl());
        vm.prank(executor); adapter.payDirect(q, direct(stranger, 5e4, 2), "", nf, dl());
        vm.prank(executor); vm.expectRevert(BadStranger.selector); adapter.payDirect(q, direct(regPayee, 1e6, 3), "", nf, dl());
        x.registry = address(new GasBurnerRegistry());
        q = grant(12, 30, abi.encode(x));
        o = order(bidPayee, 1e6, 4); sig = signOrder(kBid, o);
        vm.prank(executor); adapter.paySigned{gas: 2_000_000}(q, o, sig, nf, dl());
    }
    function test_R_recordsExpireAfter90DaysUnlessRenewed() public {
        KipurseMerchantRegistry r2 = new KipurseMerchantRegistry(maintainer, 48 hours);
        vm.prank(maintainer); r2.propose(keccak256("m"), arr(address(0x99)), none(), 1e6, 1e6, "s");
        warpBy(48 hours); r2.execute(keccak256("m"), arr(address(0x99)), none(), 1e6, 1e6, "s");
        (bytes32 m,,) = r2.lookupPayee(address(0x99)); assertEq(m, keccak256("m"));
        warpBy(90 days);
        (m,,) = r2.lookupPayee(address(0x99)); assertEq(m, bytes32(0));
        vm.prank(maintainer); r2.renew(keccak256("m"));
        (m,,) = r2.lookupPayee(address(0x99)); assertEq(m, keccak256("m"));
    }
}
