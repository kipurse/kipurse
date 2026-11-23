// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {S} from "./SpmCast.sol";
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {KipurseTrustV5} from "../src/KipurseTrustV5.sol";
import {KipurseAdapterV5, PayerVaultV5, PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";

/// Core behaviour: policy validation, four tiers, payee binding, fee, vault routing, x402 mode.
contract KipurseV5CoreTest is V5Base {
    // ================= policy / deployment =================
    function test_feeController_hardMaxOnlyDownAndTimelockedRecipient() public {
        vm.expectRevert(FeeMax.selector); new KipurseFeeControllerV5(feeAdmin, 3001, feeSafe); // > 0.3%
        vm.expectRevert(Zero.selector); new KipurseFeeControllerV5(feeAdmin, 1000, address(0));
        KipurseFeeControllerV5 c = new KipurseFeeControllerV5(feeAdmin, 3000, feeSafe);  // exactly the hard max
        KipurseAdapterV5 a = new KipurseAdapterV5(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, c);
        assertEq(c.MAX_FEE_PPM(), 3000); assertEq(a.feeFor(1e6), 3000);
        vm.prank(attacker); vm.expectRevert(Admin.selector); c.lowerFee(1);
        vm.prank(feeAdmin); vm.expectRevert(OnlyDown.selector); c.lowerFee(3000);
        vm.prank(feeAdmin); c.lowerFee(1000); assertEq(a.feeFor(1e6), 1000);
        vm.prank(feeAdmin); vm.expectRevert(OnlyDown.selector); c.lowerFee(1001); // can never go back up
        vm.prank(attacker); vm.expectRevert(Admin.selector); c.proposeRecipient(attacker);
        vm.prank(feeAdmin); c.proposeRecipient(address(0xFEE6));
        vm.expectRevert(Timelock.selector); c.executeRecipient();
        warpBy(48 hours - 1); vm.expectRevert(Timelock.selector); c.executeRecipient();
        warpBy(1); c.executeRecipient(); assertEq(c.feeRecipient(), address(0xFEE6));
        vm.prank(feeAdmin); c.proposeRecipient(attacker); vm.prank(feeAdmin); c.cancelRecipient();
        warpBy(48 hours); vm.expectRevert(Timelock.selector); c.executeRecipient();
    }
    function test_policy_allowanceMustEqualTermAndTermNonZero() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(registry), TERM);
        ISpendPermissionManager.SpendPermission memory q = ISpendPermissionManager.SpendPermission({account: address(wallet), spender: address(adapter),
            token: address(token), allowance: type(uint160).max, period: 30 days, start: uint48(vm.getBlockTimestamp()),
            end: uint48(vm.getBlockTimestamp() + 30 days), salt: 41, extraData: abi.encode(x)});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
        vm.prank(executor); vm.expectRevert(Allowance.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 1), "", nf, dl()); // max uint
        q.allowance = TERM - 1; q.salt = 42;
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
        vm.prank(executor); vm.expectRevert(Allowance.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 2), "", nf, dl());
        x.term = 0; q.extraData = abi.encode(x); q.allowance = 1; q.salt = 43;               // term = 0 is forbidden
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
        vm.prank(executor); vm.expectRevert(Allowance.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 3), "", nf, dl());
        payDirect(bidPayee, 1e6, 4); // fixture permission: allowance == term
    }
    function test_policy_wrongLengthAndRecurringShapeRejected() public {
        ISpendPermissionManager.SpendPermission memory q = grant(4, 30, hex"00");
        vm.prank(executor); vm.expectRevert(BadPolicy.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 1), "", nf, dl());
        q = ISpendPermissionManager.SpendPermission({account: address(wallet), spender: address(adapter), token: address(token),
            allowance: type(uint160).max, period: 1 days, start: uint48(vm.getBlockTimestamp()), end: uint48(vm.getBlockTimestamp() + 30 days), salt: 5,
            extraData: pol(address(registry), TERM)});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
        vm.prank(executor); vm.expectRevert(Term.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 2), "", nf, dl());
    }
    function test_policy_ownerMustAcceptFee() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(registry), TERM); x.maxFeePpm = 0; // owner accepted no fee at all; adapter charges 1000 ppm
        ISpendPermissionManager.SpendPermission memory q = grant(6, 30, abi.encode(x));
        vm.prank(executor); vm.expectRevert(Fee.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 3), "", nf, dl());
    }
    function test_policy_ownerMustAcceptFeeRate() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(registry), TERM); x.maxFeePpm = 999; // owner accepted a lower rate
        ISpendPermissionManager.SpendPermission memory q = grant(16, 30, abi.encode(x));
        vm.prank(executor); vm.expectRevert(Fee.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 3), "", nf, dl());
        x.maxFeePpm = 1000; q = grant(17, 30, abi.encode(x));
        vm.prank(executor); adapter.payDirect(q, direct(bidPayee, 1e6, 3), "", nf, dl());
    }
    function test_policy_tierCapsMustFitPermissionCaps() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(registry), TERM); x.verifiedSingle = SINGLE + 1;
        ISpendPermissionManager.SpendPermission memory q = grant(7, 30, abi.encode(x));
        vm.prank(executor); vm.expectRevert(BadPolicy.selector); adapter.payDirect(q, direct(bidPayee, 1e6, 4), "", nf, dl());
    }
    function test_onlyExecutorPays() public {
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 5);
        vm.prank(attacker); vm.expectRevert(BadExecutor.selector); adapter.payDirect(p, d, "", nf, dl());
        vm.prank(guardian); vm.expectRevert(BadExecutor.selector); adapter.payDirect(p, d, "", nf, dl());
    }
    function test_payeeCannotBeTokenWalletVaultAdapterManager() public {
        expectDirectRevert(address(token), 1e4, 6, abi.encodeWithSelector(Payee.selector));
        expectDirectRevert(address(wallet), 1e4, 7, abi.encodeWithSelector(Payee.selector));
        expectDirectRevert(vault(), 1e4, 8, abi.encodeWithSelector(Payee.selector));
        expectDirectRevert(address(adapter), 1e4, 9, abi.encodeWithSelector(Payee.selector));
        expectDirectRevert(address(manager), 1e4, 10, abi.encodeWithSelector(Payee.selector));
    }
    function test_txDeadlineWindow() public {
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, 11);
        vm.prank(executor); vm.expectRevert(Operation.selector); adapter.payDirect(p, d, "", nf, uint48(vm.getBlockTimestamp() + 301));
        vm.prank(executor); vm.expectRevert(Operation.selector); adapter.payDirect(p, d, "", nf, uint48(vm.getBlockTimestamp()));
    }

    // ================= tiers =================
    function test_tier_trusted_signedOrderPaysBoundPayee() public {
        paySigned(kBid, bidPayee, 5e6, 1);
        assertEq(token.balanceOf(bidPayee), 5e6);
        assertEq(adapter.accruedFees(), fee(5e6));
        assertEq(adapter.termSpent(ph()), 5e6 + fee(5e6));
        assertEq(adapter.merchantDaySpent(ph(), EXAMPLESHOP, 0), 5e6 + fee(5e6));
    }
    function test_tier_trusted_directToBoundPayeeUsesMerchantCaps() public {
        ownerSetTrust("cafe", arr(address(0xCAFE)), none(), 1e6, 15e5, 0);
        payDirect(address(0xCAFE), 9e5, 1);                                        // day: 900,900 incl. fee
        expectDirectRevert(address(0xCAFE), 1e6 + 1, 2, abi.encodeWithSelector(MerchantCap.selector));  // per-payment cap is on the amount only
        payDirect(address(0xCAFE), 5e5, 3);                                        // day: 1,401,400
        expectDirectRevert(address(0xCAFE), 1e5, 4, abi.encodeWithSelector(MerchantDailyCap.selector));// 1,501,500 > 1.5 (fees count daily)
        warpBy(1 days);
        payDirect(address(0xCAFE), 1e6, 5);                                        // exact merchant single passes
    }
    function test_tier_trustedCannotExceedPermissionSingle() public {
        ownerSetTrust("big", arr(address(0xB16)), none(), 100e6, 100e6, 0); // owner record above permission caps
        expectDirectRevert(address(0xB16), SINGLE + 1, 1, abi.encodeWithSelector(Amount.selector));
        payDirect(address(0xB16), SINGLE, 2); // exactly the permission single (fee not counted per payment)
    }
    function test_tier_registryVerified_capsAreMinOfRegistryAndOwner() public {
        // registry gives 3/6, owner's verified ceiling is 2/5 -> effective 2 per payment
        expectDirectRevert(regPayee, 2e6 + 1, 1, abi.encodeWithSelector(VerifiedCap.selector));
        payDirect(regPayee, 19e5, 2);
        paySigned(kReg, regPayee, 19e5, 3);
        expectDirectRevert(regPayee, 19e5, 4, abi.encodeWithSelector(VerifiedDailyCap.selector)); // 3 x (1.9+fee) > 5
        assertEq(adapter.verifiedDaySpent(ph(), 0), 2 * (19e5 + fee(19e5)));
    }
    function test_tier_stranger_exact_0_10_perPayment_feesCountDaily() public {
        expectDirectRevert(stranger, 1e5 + 1, 1, abi.encodeWithSelector(BadStranger.selector));
        payDirect(stranger, 1e5, 2);                 // exactly 0.10 passes; day = 100,100 incl. fee
        payDirect(address(0xD003), 99_800, 3);       // 99,800 + 99 = 99,899 -> day 199,999
        expectDirectRevert(address(0xD004), 1_000, 4, abi.encodeWithSelector(StrangerDailyCap.selector));
        warpBy(1 days);
        payDirect(address(0xD004), 1_000, 5);
    }
    function test_tier_blacklisted_ownerDenyAndRegistryBlock() public {
        ownerCall(abi.encodeCall(trustC.setDeniedPayee, (bidPayee, true)));
        expectSignedRevert(kBid, bidPayee, 1e6, 1, abi.encodeWithSelector(Denied.selector));
        expectDirectRevert(bidPayee, 1e6, 2, abi.encodeWithSelector(Denied.selector));
        vm.prank(maintainer); registry.setBlocked(stranger, true);
        expectDirectRevert(stranger, 5e4, 3, abi.encodeWithSelector(RegistryBlocked.selector));
        // owner opts out of the registry -> registry blocks no longer apply (owner's own choice)
        ownerCall(abi.encodeCall(trustC.setRegistryOptOut, (true)));
        payDirect(stranger, 5e4, 4);
    }
    function test_tier_ownerTrustTakesPrecedenceOverRegistry() public {
        ownerSetTrust("mine", arr(regPayee), none(), 5e6, 5e6, 0);
        payDirect(regPayee, 4e6, 1); // above verified 2, allowed by owner trust
        assertEq(adapter.verifiedDaySpent(ph(), 0), 0);
    }
    function test_tier_ownerApprovalAnyAmountUpToSingle() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 77);
        bytes32 key = adapter.purchaseKey(d.payee, d.merchantRef, d.repeatKey);
        bytes memory sig = ownerSig(adapter.approvalDigest(address(wallet), key, d.payee, d.amount, d.deadline));
        vm.prank(executor); vm.expectRevert(BadStranger.selector); adapter.payDirect(p, d, "", nf, dl());
        vm.prank(executor); adapter.payDirect(p, d, sig, nf, dl());
        assertEq(token.balanceOf(stranger), 3e6);
        assertEq(adapter.openDaySpent(ph(), 0), 0); // not charged to the stranger tier
    }
    function test_tier_ownerApprovalBoundToTermsAndAccount() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 78);
        bytes32 key = adapter.purchaseKey(d.payee, d.merchantRef, d.repeatKey);
        bytes memory sig = ownerSig(adapter.approvalDigest(address(wallet), key, d.payee, d.amount, d.deadline));
        KipurseAdapterV5.Direct memory d2 = direct(attacker, 3e6, 78);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
        d2 = direct(stranger, 3e6 + 1, 78);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d2, sig, nf, dl());
        // signed directly by the owner EOA (not through the wallet's 1271) is rejected
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, adapter.approvalDigest(address(wallet), key, d.payee, d.amount, d.deadline));
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, abi.encodePacked(r, s, v), nf, dl());
    }

    // ================= payee binding (C2) =================
    function test_binding_signedOrderToUnboundPayeeRejected() public {
        expectSignedRevert(kBid, attacker, 1e6, 1, abi.encodeWithSelector(PayeeBinding.selector));
        expectSignedRevert(kBid, regPayee, 1e6, 2, abi.encodeWithSelector(PayeeBinding.selector)); // a payee of ANOTHER merchant
        expectSignedRevert(kReg, attacker, 1e6, 3, abi.encodeWithSelector(PayeeBinding.selector));
        expectSignedRevert(kReg, bidPayee, 1e6, 4, abi.encodeWithSelector(PayeeBinding.selector));
    }
    function test_binding_unknownSignerRejected() public {
        expectSignedRevert(kEvil, bidPayee, 1e6, 1, abi.encodeWithSelector(Signer.selector));
    }
    function test_binding_staleAfterRetrust() public {
        // owner re-sets ExampleShop with a NEW payee only: the old payee binding goes stale immediately
        ownerSetTrust("exampleshop.example", arr(address(0xB1D1)), arr(bidSigner), SINGLE, DAILY, 0);
        expectSignedRevert(kBid, bidPayee, 1e6, 1, abi.encodeWithSelector(PayeeBinding.selector));
        paySigned(kBid, address(0xB1D1), 1e6, 2);
    }
    function test_signed_domainAndExpiry() public {
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 1e6, 9); o.chainId = 8453;
        bytes memory sig = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(Domain.selector); adapter.paySigned(p, o, sig, nf, dl());
        o = order(bidPayee, 1e6, 10); o.adapter = address(0x1234); sig = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(Domain.selector); adapter.paySigned(p, o, sig, nf, dl());
        o = order(bidPayee, 1e6, 11); o.deadline = vm.getBlockTimestamp(); sig = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(Expired.selector); adapter.paySigned(p, o, sig, nf, dl());
        o = order(bidPayee, 1e6, 12); sig = signOrder(kBid, o); o.amount = 2e6; // tampered after signing
        vm.prank(executor); vm.expectRevert(Signer.selector); adapter.paySigned(p, o, sig, nf, dl());
    }

    // ================= fee (C8) =================
    function test_fee_finalValuesPurePercentage() public {
        assertEq(feeCtl.feePpm(), 1000);
        assertEq(adapter.feeFor(1e6), 1000);        // 1 USDC -> 0.001
        assertEq(adapter.feeFor(5e6), 5000);        // ExampleShop 5 USDC -> 0.005
        assertEq(adapter.feeFor(1000e6), 1e6);      // no per-payment cap: 1000 USDC -> 1 USDC
        assertEq(adapter.feeFor(999), 1);           // rounded UP: every payment pays >= 1 atomic unit (0.000001)
        assertEq(adapter.feeFor(1), 1);
        assertEq(adapter.feeFor(1000), 1); assertEq(adapter.feeFor(1001), 2);
    }
    function test_fee_noCapOnLargePayment() public {
        KipurseAdapterV5.Policy memory x = polStruct(address(0), 3000e6); x.single = 1000e6; x.daily = 2000e6;
        ISpendPermissionManager.SpendPermission memory q = grant(8, 30, abi.encode(x));
        token.mint(address(wallet), 2000e6);
        ownerSetTrust("whale", arr(address(0x3A1E)), none(), 1000e6, 2000e6, 0);
        vm.prank(executor); adapter.payDirect(q, direct(address(0x3A1E), 999e6, 1), "", nf, dl());
        assertEq(adapter.accruedFees(), 999_000);
        assertEq(adapter.termSpent(manager.getHash(S(q))), 999e6 + 999_000);
    }
    function test_fee_excludedFromSingleButCountsInDailyAndTerm() public {
        paySigned(kBid, bidPayee, SINGLE, 1);                       // exactly 6.00 passes the per-payment cap
        assertEq(adapter.daySpent(ph(), 0), SINGLE + fee(SINGLE));  // 6.006 counted against daily
        expectSignedRevert(kBid, bidPayee, SINGLE + 1, 2, abi.encodeWithSelector(Amount.selector));
        expectSignedRevert(kBid, bidPayee, SINGLE, 3, abi.encodeWithSelector(DailyCap.selector)); // 12.012 > 12
        uint256 a = 5_988_011; // a + ceil(a/1000) = 5,994,000 = the room left today
        paySigned(kBid, bidPayee, a, 4);
        assertEq(adapter.daySpent(ph(), 0), DAILY);
        expectSignedRevert(kBid, bidPayee, 1, 5, abi.encodeWithSelector(DailyCap.selector));
        warpBy(1 days); paySigned(kBid, bidPayee, SINGLE, 6); paySigned(kBid, bidPayee, a, 7);
        warpBy(1 days);
        expectSignedRevert(kBid, bidPayee, SINGLE, 8, abi.encodeWithSelector(TermCap.selector)); // 24 + 6.006 > 30
        paySigned(kBid, bidPayee, 5_994_005, 9);                   // + 6,000,000 = exactly 30.00
        assertEq(adapter.termSpent(ph()), TERM);
        assertEq(adapter.accruedFees(), 2 * fee(SINGLE) + 2 * fee(a) + fee(5_994_005));
    }
    /// ZERO-RESERVE: networkFee is the USDC gas top-up of the OWNER'S vault (it pays the paymaster); Kipurse never receives it.
    function test_networkFee_actualGasBoundedByOwnerMaxCountsDailyAndIsNeverRefunded() public {
        nf = MAX_NF + 1;
        expectDirectRevert(stranger, 1e5, 1, abi.encodeWithSelector(NetworkFee.selector));          // above the owner-signed maximum
        nf = 7_321;                                                            // the previous op's actual paymaster charge
        uint256 w = token.balanceOf(address(wallet));
        payDirect(stranger, 1e5, 2);                                           // exact 0.10 still passes per payment
        address v = adapter.vaultAddress(address(wallet));
        assertEq(token.balanceOf(stranger), 1e5);                              // merchant receives the full amount
        assertEq(w - token.balanceOf(address(wallet)), 1e5 + 100 + 7_321);     // payer bears fee + gas
        assertEq(adapter.openDaySpent(ph(), 0), 1e5 + 100 + 7_321);            // gas top-up counts in the caps
        assertEq(adapter.accruedFees(), 100);                                  // Kipurse gets the protocol fee only
        assertEq(token.balanceOf(v), 7_321);                                   // gas buffer = owner money in the owner's vault
        KipurseAdapterV5.Auth memory au = auth(bidPayee, 1e6, 3);
        (, bytes32 digest,) = prepare(au);
        assertEq(adapter.accruedFees(), 100); assertEq(adapter.pendingFees(), fee(1e6));
        assertEq(token.balanceOf(v), 1e6 + 2 * 7_321);
        uint256 w1 = token.balanceOf(address(wallet));
        vm.warp(au.validBefore); adapter.reclaim(digest);
        assertEq(token.balanceOf(address(wallet)), w1 + 1e6 + fee(1e6));
        assertEq(adapter.termSpent(ph()), 1e5 + 100 + 7_321 + 7_321);          // gas top-ups stay counted (they sit in the vault)
        assertEq(adapter.pendingFees(), 0);
        adapter.collectFees();
        assertEq(token.balanceOf(feeSafe), 100);
        assertEq(token.balanceOf(address(adapter)), 0);
        adapter.registerPermission(p);                                         // vault learns maxGasPerOp (buffer = 4x)
        vm.prank(address(0xBEEF)); PayerVaultV5(v).sweep();                    // a third party cannot strand the gas buffer
        assertEq(token.balanceOf(v), 2 * 7_321);
        vm.prank(address(wallet)); PayerVaultV5(v).sweep();                    // the owner's exit takes everything back
        assertEq(token.balanceOf(v), 0);
    }
    /// Use-case presets (gateway plan.mjs): ExampleShop 6.00 order and a stranger paying exactly 0.10 both pass with fees + gas.
    function _preset(bool purchasing) internal view returns (KipurseAdapterV5.Policy memory x) {
        x = polStruct(address(0), purchasing ? 100e6 : 50e6);
        if (purchasing) { x.single = 10e6; x.daily = 20e6; x.openSingle = 1e5; x.openDaily = 1e6; x.verifiedSingle = 10e6; x.verifiedDaily = 20e6; }
        else { x.single = 1e6; x.daily = 5e6; x.openSingle = 1e5; x.openDaily = 1e6; x.verifiedSingle = 1e6; x.verifiedDaily = 5e6; }
    }
    function test_presets_merchantSixAndStrangerExactTenCentsPass() public {
        nf = 15_000;
        ISpendPermissionManager.SpendPermission memory q = grant(18, 30, abi.encode(_preset(true)));
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), 10e6, 20e6, 0);
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 6e6, 501); bytes memory sig = signOrder(kBid, o);
        vm.startPrank(executor);
        adapter.paySigned(q, o, sig, nf, dl());
        adapter.payDirect(q, direct(stranger, 1e5, 1), "", nf, dl());
        vm.expectRevert(BadStranger.selector); adapter.payDirect(q, direct(stranger, 1e5 + 1, 2), "", nf, dl());
        vm.stopPrank();
        ISpendPermissionManager.SpendPermission memory api = grant(19, 30, abi.encode(_preset(false)));
        vm.prank(executor); adapter.payDirect(api, direct(address(0xD003), 1e5, 3), "", nf, dl());
        assertEq(token.balanceOf(bidPayee), 6e6); assertEq(token.balanceOf(stranger), 1e5); assertEq(token.balanceOf(address(0xD003)), 1e5);
    }

    // ================= fees can never get stuck =================
    function test_fee_blocklistedRecipientNeverBricksPayments() public {
        token.setBlocklisted(feeSafe, true);
        uint256 w = token.balanceOf(address(wallet));
        paySigned(kBid, bidPayee, 5e6, 1);                     // payments never touch the recipient
        assertEq(token.balanceOf(bidPayee), 5e6);
        assertEq(token.balanceOf(address(wallet)), w - 5e6 - fee(5e6));
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 2);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        settle(v, a, nonce);
        assertEq(adapter.markSettled(one(digest)), 1);
        assertEq(token.balanceOf(v), 0); assertEq(PayerVaultV5(v).reserved(), 0);
        vm.expectRevert(); adapter.collectFees();             // fees wait, they are not lost
        assertEq(adapter.accruedFees(), fee(5e6) + fee(1e6));
        vm.prank(feeAdmin); feeCtl.proposeRecipient(address(0xFEE7));
        warpBy(48 hours); feeCtl.executeRecipient();
        adapter.collectFees();
        assertEq(token.balanceOf(address(0xFEE7)), fee(5e6) + fee(1e6));
    }
    function test_fee_unmarkedSettlementReturnsFeeToOwnerAfterWindow() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 3);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        settle(v, a, nonce);
        assertEq(token.balanceOf(v), 0); assertEq(adapter.pendingFees(), fee(1e6)); // the fee waits in the adapter
        vm.warp(a.validBefore + adapter.FEE_CLAIM_WINDOW());
        uint256 w = token.balanceOf(address(wallet));
        vm.prank(owner); wallet.execute(address(adapter), 0, abi.encodeCall(adapter.markSettled, (one(digest)))); // owner's exit kit can do it
        assertEq(token.balanceOf(address(wallet)), w + fee(1e6));
        assertEq(adapter.accruedFees(), 0); assertEq(adapter.pendingFees(), 0);
        assertEq(token.balanceOf(v), 0); assertEq(PayerVaultV5(v).reserved(), 0);
    }
    function test_fee_markSettledInsideWindowPaysProtocolByAnyone() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 4);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        settle(v, a, nonce);
        vm.warp(a.validBefore + adapter.FEE_CLAIM_WINDOW() - 1);
        vm.prank(address(0x1234)); adapter.markSettled(one(digest));
        assertEq(adapter.accruedFees(), fee(1e6));
    }
    function test_fee_zeroFeeDeployment() public {
        KipurseAdapterV5 a0 = new KipurseAdapterV5(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, new KipurseFeeControllerV5(feeAdmin, 0, feeSafe));
        KipurseAdapterV5.Policy memory x = polStruct(address(0), TERM); x.maxFeePpm = 0;
        ISpendPermissionManager.SpendPermission memory q = ISpendPermissionManager.SpendPermission({account: address(wallet),
            spender: address(a0), token: address(token), allowance: TERM, period: 30 days, start: uint48(vm.getBlockTimestamp()),
            end: uint48(vm.getBlockTimestamp() + 30 days), salt: 9, extraData: abi.encode(x)});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
        vm.prank(executor); a0.payDirect(q, direct(stranger, 1e5, 1), "", nf, dl()); // exactly 0.10 is payable with no fee
        assertEq(token.balanceOf(stranger), 1e5);
    }

    // ================= vault routing (C4) =================
    function test_vault_isOnChainPayerAndAdapterHoldsOnlyAccruedFees() public {
        vm.expectEmit(true, true, false, true, address(token));
        emit IERC20.Transfer(vault(), bidPayee, 1e6);
        paySigned(kBid, bidPayee, 1e6, 1);
        assertEq(token.balanceOf(address(adapter)), adapter.accruedFees());
        assertEq(adapter.accruedFees(), fee(1e6));
        assertEq(token.balanceOf(vault()), 0);
        assertEq(PayerVaultV5(vault()).account(), address(wallet));
        assertEq(PayerVaultV5(vault()).adapter(), address(adapter));
    }
    function test_vault_onlyAdapterCanPayOrApprove() public {
        payDirect(bidPayee, 1e6, 1);
        PayerVaultV5 v = PayerVaultV5(vault());
        token.mint(address(v), 1e6);
        vm.prank(executor); vm.expectRevert(BadAdapter.selector); v.pay(attacker, 1);
        vm.expectRevert(BadAdapter.selector); v.approveDigest(keccak256("x"), vm.getBlockTimestamp() + 10, 0);
        vm.prank(executor); vm.expectRevert(NotAccount.selector); v.withdraw(IERC20(address(token)), attacker, 1);
    }
    function test_vault_factoryCannotBeSpoofed() public {
        // anyone can call the factory, but only an adapter that prepared its own implementation can clone, and the vault
        // they get is not the adapter's vault for that account
        vm.prank(attacker); vm.expectRevert(Vault.selector); vaultFactory.deploy(address(wallet), IERC20(address(token)));
        vm.prank(attacker); vaultFactory.prepare(IERC20(address(token)), address(trustC));
        vm.prank(attacker); address fake = vaultFactory.deploy(address(wallet), IERC20(address(token)));
        assertTrue(fake != vault());
        assertEq(PayerVaultV5(fake).adapter(), attacker);
        vm.prank(attacker); vm.expectRevert(Vault.selector); vaultFactory.prepare(IERC20(address(token)), address(trustC)); // once
        payDirect(bidPayee, 1e6, 1); // the real vault is still created correctly
        assertEq(address(adapter.vaultOf(address(wallet))), vault());
    }

    // ================= x402 mode =================
    function test_x402_prepareSettleMarkSettledAccruesFee() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 30);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        assertEq(nonce, adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey)); // nonce = canonical purchase key
        assertEq(token.balanceOf(v), 1e6); assertEq(adapter.pendingFees(), fee(1e6));
        assertEq(PayerVaultV5(v).isValidSignature(digest, ""), bytes4(0x1626ba7e));
        settle(v, a, nonce);
        assertEq(token.balanceOf(bidPayee), 1e6);
        assertEq(adapter.markSettled(one(digest)), 1);
        assertEq(adapter.accruedFees(), fee(1e6)); assertEq(adapter.pendingFees(), 0);
        assertEq(token.balanceOf(v), 0); assertEq(PayerVaultV5(v).reserved(), 0);
        assertEq(adapter.markSettled(one(digest)), 0); // already closed: skipped
    }
    function test_x402_batchMarkSettledSkipsUnsettled() public {
        bytes32[] memory ds = new bytes32[](3);
        for (uint256 i; i < 3; i++) {
            KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 60 + i);
            (address v, bytes32 d, bytes32 n) = prepare(a);
            ds[i] = d;
            if (i != 1) settle(v, a, n);
        }
        vm.prank(address(0xB0B)); assertEq(adapter.markSettled(ds), 2);
        assertEq(adapter.accruedFees(), 2 * fee(1e6)); assertEq(adapter.pendingFees(), fee(1e6));
        (,,,, bool open,,,,,,) = adapter.reservations(ds[1]); assertTrue(open);
    }
    function test_x402_markSettledRequiresSettlement() public {
        (, bytes32 digest,) = prepare(auth(bidPayee, 1e6, 31));
        assertEq(adapter.markSettled(one(digest)), 0);
        (,,,, bool open,,,,,,) = adapter.reservations(digest); assertTrue(open);
    }
    function test_x402_tamperedAuthorizationRejectedByToken() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 32);
        (address v,, bytes32 nonce) = prepare(a);
        vm.prank(facilitator); vm.expectRevert(bytes("invalid signature"));
        token.transferWithAuthorization(v, attacker, a.value, a.validAfter, a.validBefore, nonce, "");
        vm.prank(facilitator); vm.expectRevert(bytes("invalid signature"));
        token.transferWithAuthorization(v, a.to, a.value + fee(1e6), a.validAfter, a.validBefore, nonce, ""); // can't take the fee too
    }
    function test_x402_vaultNeverApprovesPermitOrArbitraryHash() public {
        (address v,,) = prepare(auth(bidPayee, 1e6, 33));
        vm.expectRevert(bytes("invalid signature")); token.permit(v, attacker, type(uint256).max, vm.getBlockTimestamp() + 100, "");
        assertEq(PayerVaultV5(v).isValidSignature(keccak256("anything"), ""), bytes4(0xffffffff));
    }
    function test_x402_windowLimits() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 34); a.validBefore = vm.getBlockTimestamp() + 601;
        vm.prank(executor); vm.expectRevert(Window.selector); adapter.prepareAuthorization(p, a, "", nf, dl());
    }
    function test_x402_reclaimByAnyoneCreditsCapsAndFreesKey() public {
        uint256 w0 = token.balanceOf(address(wallet));
        KipurseAdapterV5.Auth memory a = auth(stranger, 9e4, 35);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        vm.expectRevert(NotExpired.selector); adapter.reclaim(digest);
        vm.warp(a.validBefore);
        vm.prank(facilitator); vm.expectRevert(bytes("expired")); // mock USDC string
        token.transferWithAuthorization(v, a.to, a.value, a.validAfter, a.validBefore, nonce, "");
        vm.prank(address(0xCAFE)); adapter.reclaim(digest);
        assertEq(token.balanceOf(address(wallet)), w0);
        assertEq(adapter.termSpent(ph()), 0); assertEq(adapter.daySpent(ph(), 0), 0); assertEq(adapter.openDaySpent(ph(), 0), 0);
        assertFalse(adapter.purchaseUsed(address(wallet), nonce));
        vm.expectRevert(BadReservation.selector); adapter.reclaim(digest);
        // the same purchase can be attempted again after an unsettled reclaim
        prepare(auth(stranger, 9e4, 35));
    }
    function test_x402_cannotReclaimSettled() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 36);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        settle(v, a, nonce); vm.warp(a.validBefore + 1);
        vm.expectRevert(Settled.selector); adapter.reclaim(digest);
    }
    function test_x402_ownerCancelBeforeExpiry() public {
        uint256 w0 = token.balanceOf(address(wallet));
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 37);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        vm.prank(executor); vm.expectRevert(BadReservation.selector); adapter.cancelReservation(digest);
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        assertEq(token.balanceOf(address(wallet)), w0);
        assertEq(PayerVaultV5(v).isValidSignature(digest, ""), bytes4(0xffffffff)); // approval withdrawn
        vm.prank(facilitator); vm.expectRevert(bytes("invalid signature"));
        token.transferWithAuthorization(v, a.to, a.value, a.validAfter, a.validBefore, nonce, "");
    }
    function test_x402_registryAndTrustedTiersCreditedBackOnReclaim() public {
        (,bytes32 d1,) = prepare(auth(regPayee, 1e6, 38));
        (,bytes32 d2,) = prepare(auth(bidPayee, 2e6, 39));
        assertGt(adapter.verifiedDaySpent(ph(), 0), 0);
        warpBy(121);
        adapter.reclaim(d1); adapter.reclaim(d2);
        assertEq(adapter.verifiedDaySpent(ph(), 0), 0);
        assertEq(adapter.merchantDaySpent(ph(), REGM, 0), 0);
        assertEq(adapter.merchantDaySpent(ph(), EXAMPLESHOP, 0), 0);
        assertEq(adapter.termSpent(ph()), 0);
    }
    function test_x402_sweepReturnsStrayButNotReserved() public {
        (address v,,) = prepare(auth(bidPayee, 1e6, 40));
        token.mint(v, 3e5);
        uint256 w = token.balanceOf(address(wallet));
        PayerVaultV5(v).sweep();
        assertEq(token.balanceOf(address(wallet)), w + 3e5);
        assertEq(token.balanceOf(v), 1e6);
    }
    // ================= dedupe (C9), payer field, trust bounds, pause expiry =================
    function test_dedupe_samePurchaseRefWithChangedAmountIsSamePurchase() public {
        payDirect(bidPayee, 1e6, 7);
        expectDirectRevert(bidPayee, 2e6, 7, abi.encodeWithSelector(DuplicatePurchase.selector));     // price changed, same purchase
        vm.prank(executor); vm.expectRevert(DuplicatePurchase.selector); adapter.prepareAuthorization(p, auth(bidPayee, 5e5, 7), "", nf, dl());
        payDirect(bidPayee, 1e6, 8);                                          // a different server ref = a distinct purchase
    }
    function test_dedupe_signedOrderKeyedOnMerchantAndOrderIdOnly() public {
        paySigned(kBid, bidPayee, 1e6, 70);
        expectSignedRevert(kBid, bidPayee, 2e6, 70, abi.encodeWithSelector(Duplicate.selector));       // same order id, new amount: refused
        assertTrue(adapter.purchaseUsed(address(wallet), adapter.signedPurchaseKey(EXAMPLESHOP, bytes32(uint256(70)))));
    }
    function test_order_optionalPayerField() public {
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 1e6, 80); o.payer = address(0xDEAD);
        bytes memory sig = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(Payer.selector); adapter.paySigned(p, o, sig, nf, dl());
        o = order(bidPayee, 1e6, 81); o.payer = address(wallet); sig = signOrder(kBid, o);
        vm.prank(executor); adapter.paySigned(p, o, sig, nf, dl());
        o = order(bidPayee, 1e6, 82); o.payer = address(wallet); sig = signOrder(kBid, o); o.payer = address(0); // stripped after signing
        vm.prank(executor); vm.expectRevert(Signer.selector); adapter.paySigned(p, o, sig, nf, dl());
    }
    function test_trust_nameBoundExpiryRequiredAndMax365Days() public {
        KipurseTrustV5.TrustParams memory t = trustParams("shop.example", arr(address(0x5401)), none(), 1e6, 2e6, 0);
        t.merchant = keccak256("other.example");
        ownerExpectRevert(abi.encodeCall(trustC.setTrust, (t)), abi.encodeWithSelector(TrustName.selector));
        t = trustParams("shop.example", arr(address(0x5401)), none(), 1e6, 2e6, 0); t.expiry = 0; // permanent
        ownerExpectRevert(abi.encodeCall(trustC.setTrust, (t)), abi.encodeWithSelector(TrustExpiry.selector));
        t.expiry = uint64(vm.getBlockTimestamp() + 365 days + 1);
        ownerExpectRevert(abi.encodeCall(trustC.setTrust, (t)), abi.encodeWithSelector(TrustExpiry.selector));
        t.expiry = uint64(vm.getBlockTimestamp() + 365 days);
        ownerCall(abi.encodeCall(trustC.setTrust, (t)));
        (,uint64 exp, bool active,,) = trustC.trustOf(address(wallet), keccak256("shop.example"));
        assertTrue(active); assertEq(exp, vm.getBlockTimestamp() + 365 days);
    }
    function ownerExpectRevert(bytes memory data, bytes memory reason) internal {
        vm.prank(owner); vm.expectRevert(reason); wallet.execute(address(trustC), 0, data);
    }
    function test_pause_executorPauseExpiresAfter24h_guardianAndOwnerPausePermanent() public {
        vm.prank(executor); adapter.pause(p);
        assertTrue(trustC.isPaused(address(wallet)));
        expectDirectRevert(bidPayee, 1e6, 1, abi.encodeWithSelector(WalletPaused.selector));
        warpBy(24 hours - 1); expectDirectRevert(bidPayee, 1e6, 2, abi.encodeWithSelector(WalletPaused.selector));
        warpBy(1); assertFalse(trustC.isPaused(address(wallet)));
        payDirect(bidPayee, 1e6, 3);                                      // expired by itself
        vm.prank(guardian); adapter.pause(p);
        warpBy(30 days - 1 days - 1);
        expectDirectRevert(bidPayee, 1e6, 4, abi.encodeWithSelector(WalletPaused.selector));           // guardian pause does not expire
        ownerCall(abi.encodeCall(trustC.setPaused, (false)));
        payDirect(bidPayee, 1e6, 5);
        ownerCall(abi.encodeCall(trustC.setPaused, (true)));
        expectDirectRevert(bidPayee, 1e6, 6, abi.encodeWithSelector(WalletPaused.selector));
    }
}
