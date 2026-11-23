// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// F-1 / KR-08 regression on V5.5 (port of test/invariant/V54Findings.t.sol). On V5.4, while reservation B was settled by the
/// facilitator but not yet marked, cancelling / reclaiming reservation A refunded ONLY the fee (the value hit Reserved()
/// inside a try/catch and stayed in the vault) and still emitted AuthorizationClosed. On V5.5 the vault's reserved()
/// ignores settled nonces (KR-02), so A is refunded in full; the old "known failing" test is now a normal passing test.
contract V55FindingsTest is V55Base {
    function _twoReservationsOneSettled() internal returns (address v, bytes32 dA, bytes32 dB) {
        KipurseAdapterV55.Auth memory a = authV(bidPayee, 1e6, 1);
        KipurseAdapterV55.Auth memory b = authV(bidPayee, 2e6, 2);
        bytes32 nB;
        vm.startPrank(executor);
        (v, dA,) = a5.prepareAuthorization(p, a, "", 0, dl());
        (, dB, nB) = a5.prepareAuthorization(p, b, "", 0, dl());
        vm.stopPrank();
        vm.prank(facilitator); token.transferWithAuthorization(v, bidPayee, 2e6, b.validAfter, b.validBefore, nB, hex"00"); // B settled, NOT marked
        assertEq(token.balanceOf(v), 1e6);
        assertEq(PayerVaultV55(v).reserved(), 1e6, "V5.5: settled B no longer counts as reserved");
        assertEq(PayerVaultV55(v).openCount(), 2, "B is still tracked until markSettled / pruning");
    }

    /// F-1 fixed: cancel refunds value + fee while the sibling is settled-but-unmarked, and the event is a full refund.
    function test_F1_fixed_cancelWhileSiblingSettledUnmarked_refundsInFull() public {
        (address v, bytes32 dA, bytes32 dB) = _twoReservationsOneSettled();
        uint256 w0 = token.balanceOf(address(wallet));
        vm.recordLogs();
        vm.prank(address(wallet)); a5.cancelReservation(dA);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool closed;
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != KipurseAdapterV55.RefundKept.selector, "no RefundKept");
            if (logs[i].topics[0] == KipurseAdapterV55.AuthorizationClosed.selector) {
                closed = true; assertEq(logs[i].topics[1], dA);
                (bool settled, uint256 value, uint256 f,) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256));
                assertFalse(settled); assertEq(value, 1e6); assertEq(f, fee(1e6));
            }
        }
        assertTrue(closed);
        assertEq(token.balanceOf(address(wallet)) - w0, 1e6 + fee(1e6), "wallet got value + fee");
        assertEq(token.balanceOf(v), 0);
        assertEq(PayerVaultV55(v).reserved(), 0);
        // B is marked later as usual; nothing else moves
        assertEq(a5.markSettled(one(dB)), 1);
        assertEq(PayerVaultV55(v).openCount(), 0);
    }
    /// Same for the permissionless reclaim path.
    function test_F1_fixed_reclaimWhileSiblingSettledUnmarked_refundsInFull() public {
        (address v, bytes32 dA,) = _twoReservationsOneSettled();
        uint256 w0 = token.balanceOf(address(wallet));
        warpBy(121);
        a5.reclaim(dA);
        assertEq(token.balanceOf(address(wallet)) - w0, 1e6 + fee(1e6));
        assertEq(token.balanceOf(v), 0);
    }
    /// The intended behaviour that V5.4 skipped as "known failing" now holds.
    function test_F1_intended_cancelRefundsValue() public {
        (, bytes32 dA,) = _twoReservationsOneSettled();
        uint256 w0 = token.balanceOf(address(wallet));
        vm.prank(address(wallet)); a5.cancelReservation(dA);
        assertEq(token.balanceOf(address(wallet)) - w0, 1e6 + fee(1e6), "cancel refunds value + fee");
    }
    /// V55-03: if the vault somehow holds less than the value (I-8 broken from outside), the owner's cancel still succeeds:
    /// it refunds what is there, releases caps / key / slot and reports the gap with RefundShortfall.
    function test_V55_03_underfundedVault_cancelStillSucceeds_reportsShortfall() public {
        KipurseAdapterV55.Auth memory a = authV(bidPayee, 1e6, 3);
        vm.prank(executor); (address v, bytes32 dA,) = a5.prepareAuthorization(p, a, "", 0, dl());
        vm.prank(v); token.transfer(address(0xD00D), 4e5); // simulate USDC leaving the vault outside the adapter
        uint256 w0 = token.balanceOf(address(wallet));
        vm.expectEmit(true, true, false, true, address(a5));
        emit KipurseAdapterV55.RefundShortfall(dA, address(wallet), 4e5);
        vm.prank(address(wallet)); a5.cancelReservation(dA);
        (,,,, bool open,,,,,,) = a5.reservations(dA);
        assertFalse(open);
        assertEq(token.balanceOf(address(wallet)) - w0, 6e5 + fee(1e6), "what was there + the fee");
        assertFalse(a5.purchaseUsed(address(wallet), a5.purchaseKey(bidPayee, bytes32(uint256(3)), bytes32(0))), "key released");
        assertEq(PayerVaultV55(v).openCount(), 0);
    }
    /// K-1 kept: a USDC-blocklisted wallet still cannot block cancel; the value stays (unreserved) in the owner's vault and
    /// RefundKept says so explicitly.
    function test_K1_blocklistedWallet_refundKeptInVault() public {
        KipurseAdapterV55.Auth memory a = authV(bidPayee, 1e6, 4);
        vm.prank(executor); (address v, bytes32 dA,) = a5.prepareAuthorization(p, a, "", 0, dl());
        token.setBlocklisted(address(wallet), true);
        vm.expectEmit(true, true, false, true, address(a5));
        emit KipurseAdapterV55.RefundKept(dA, address(wallet), 1e6);
        vm.prank(address(wallet)); a5.cancelReservation(dA);
        assertEq(token.balanceOf(v), 1e6 + fee(1e6), "value and fee kept in the owner's vault");
        assertEq(PayerVaultV55(v).unreserved(), 1e6 + fee(1e6), "withdrawable by the owner");
    }
}
