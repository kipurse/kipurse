// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {S} from "./SpmCast.sol";
import {KipurseAdapterV5, PayerVaultV5, PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {KipurseFloatVaultV5} from "../src/KipurseFloatVaultV5.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// Round 2 (2026-10-17 evening): K-1 fix, EIP-1167 clone vaults, packed day counters.
contract KipurseV5Round2Test is V5Base {
    function setUp() public override { super.setUp(); ownerCall(abi.encodeCall(trustC.setFloatCap, (5e6))); }
    // ---------------- K-1 ----------------
    function test_K1_blocklistedWallet_lateFeeGoesToOwnerVault_batchNeverReverts() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 31);
        KipurseAdapterV5.Auth memory b = auth(bidPayee, 2e6, 32);
        (address v, bytes32 d1, bytes32 n1) = prepare(a);
        (, bytes32 d2, bytes32 n2) = prepare(b);
        settle(v, a, n1); settle(v, b, n2);
        vm.warp(a.validBefore + adapter.FEE_CLAIM_WINDOW());
        token.setBlocklisted(address(wallet), true);
        uint256 v0 = token.balanceOf(v);
        bytes32[] memory both = new bytes32[](2); both[0] = d1; both[1] = d2;
        assertEq(adapter.markSettled(both), 2); // before the fix: reverted for the whole batch
        assertEq(token.balanceOf(v) - v0, fee(1e6) + fee(2e6)); // owner money, kept in the owner's vault
        assertEq(adapter.pendingFees(), 0); assertEq(adapter.accruedFees(), 0);
        // the owner withdraws it to another address of theirs
        uint256 bal = token.balanceOf(v);
        vm.prank(owner); wallet.execute(v, 0, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(token)), address(0xA11CE), bal)));
        assertEq(token.balanceOf(address(0xA11CE)), v0 + fee(1e6) + fee(2e6));
    }
    function test_K1_bothBlocklisted_feeKeptAsProtocolFee_neverStuck() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 33);
        (address v, bytes32 d, bytes32 n) = prepare(a);
        settle(v, a, n);
        vm.warp(a.validBefore + adapter.FEE_CLAIM_WINDOW());
        token.setBlocklisted(address(wallet), true); token.setBlocklisted(v, true);
        assertEq(adapter.markSettled(one(d)), 1);
        assertEq(adapter.accruedFees(), fee(1e6));
    }
    function test_K1_reclaimForBlocklistedWallet_valueAndFeeStayInVault() public {
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 1e6, 34);
        (address v, bytes32 d,) = prepare(a);
        warpBy(MAX_AUTH() + 1);
        token.setBlocklisted(address(wallet), true);
        uint256 v0 = token.balanceOf(v);
        adapter.reclaim(d); // before the fix: reverted (refund to a blocklisted wallet)
        assertEq(PayerVaultV5(v).reserved(), 0);
        assertEq(token.balanceOf(v), v0 + fee(1e6)); // value was already in the vault; now unreserved; + the refunded fee
        assertFalse(adapter.purchaseUsed(address(wallet), adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey)));
    }
    function MAX_AUTH() internal view returns (uint256) { return adapter.MAX_AUTH_WINDOW(); }

    // ---------------- EIP-1167 clones ----------------
    function test_clones_vaultsAreMinimalProxies_sharedImplementation_initOnce() public {
        payDirect(bidPayee, 1e6, 41);
        address v = vault();
        assertEq(v.code.length, 45); // EIP-1167 runtime
        address impl = vaultFactory.vaultImpl(address(adapter));
        assertEq(PayerVaultV5(v).adapter(), address(adapter)); assertEq(PayerVaultV5(v).account(), address(wallet));
        assertEq(PayerVaultV5(impl).account(), address(0)); // the implementation itself is bound to nobody
        vm.expectRevert(Vault.selector); PayerVaultV5(v).init(attacker);
        vm.prank(address(vaultFactory)); vm.expectRevert(Vault.selector); PayerVaultV5(v).init(attacker); // only once
        vm.expectRevert(Vault.selector); PayerVaultV5(impl).init(attacker);
        // float vault: same pattern
        address fv = adapter.floatAddress(address(wallet));
        assertEq(fv.code.length, 0);
        vm.prank(executor); adapter.fundFloat(p, address(0x5E55), 1e5, uint64(vm.getBlockTimestamp() + 3600), nf, dl());
        assertEq(fv.code.length, 45); assertEq(KipurseFloatVaultV5(fv).account(), address(wallet));
    }
    // ---------------- packed counters ----------------
    function test_packedDayCounters_allTiersInOneSlot() public {
        payDirect(stranger, 1e5, 51);   // stranger tier
        payDirect(bidPayee, 1e6, 52);   // trusted
        vm.prank(executor); adapter.fundFloat(p, address(0x5E55), 2e5, uint64(vm.getBlockTimestamp() + 3600), nf, dl());
        bytes32 h = ph();
        uint256 t = 1e5 + fee(1e5) + nf + 1e6 + fee(1e6) + nf + 2e5 + fee(2e5) + nf;
        assertEq(adapter.daySpent(h, 0), t);
        assertEq(adapter.openDaySpent(h, 0), 1e5 + fee(1e5) + nf);
        assertEq(adapter.verifiedDaySpent(h, 0), 0);
        assertEq(adapter.floatDaySpent(h, 0), 2e5);
        assertEq(adapter.termSpent(h), t);
    }
}
