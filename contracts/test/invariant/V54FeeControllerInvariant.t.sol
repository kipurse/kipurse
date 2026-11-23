// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import "../../src/KipurseErrors.sol";
import {KipurseFeeControllerV5} from "../../src/KipurseFeeControllerV5.sol";

/// Handler for the LIVE fee controller used by V5.4 (I-3, I-4): random admin / stranger calls and time.
contract V54FeeHandler is Test {
    KipurseFeeControllerV5 public fc;
    address constant ADMIN = address(0xFEEA);
    uint256 public violations; string public firstViolation;
    uint256 public lastPpm; uint256 public okChanges;
    address public modelPending; uint256 public modelProposedAt; address public modelRecipient;

    constructor() {
        vm.warp(1_700_000_000);
        fc = new KipurseFeeControllerV5(ADMIN, 3000, address(0xFEE5));
        lastPpm = 3000; modelRecipient = address(0xFEE5);
    }
    function _bad(string memory why) internal { if (violations == 0) firstViolation = why; violations++; }
    function _caller(uint8 who) internal pure returns (address) { return who % 3 == 0 ? address(0xBAD) : ADMIN; }

    function lowerFee(uint256 n, uint8 who) external {
        address c = _caller(who); n = bound(n, 0, 4000);
        vm.prank(c);
        try fc.lowerFee(n) {
            if (c != ADMIN) _bad("non-admin lowered the fee");
            if (n >= lastPpm) _bad("fee did not go down");
            lastPpm = n;
        } catch { if (c == ADMIN && n < lastPpm) _bad("admin could not lower the fee"); }
    }
    function propose(address r, uint8 who) external {
        address c = _caller(who);
        vm.prank(c);
        try fc.proposeRecipient(r) {
            if (c != ADMIN || r == address(0)) _bad("bad proposal accepted");
            modelPending = r; modelProposedAt = vm.getBlockTimestamp();
        } catch { if (c == ADMIN && r != address(0)) _bad("admin could not propose"); }
    }
    function cancel(uint8 who) external {
        address c = _caller(who);
        vm.prank(c);
        try fc.cancelRecipient() {
            if (c != ADMIN) _bad("non-admin cancelled");
            modelPending = address(0); modelProposedAt = 0;
        } catch { if (c == ADMIN) _bad("admin could not cancel"); }
    }
    function execute() external {
        vm.prank(address(0xBAD)); // anyone may execute once matured
        try fc.executeRecipient() {
            if (modelPending == address(0)) _bad("executed without a pending proposal");
            if (vm.getBlockTimestamp() < modelProposedAt + 48 hours) _bad("recipient changed before the 48 h timelock");
            if (fc.feeRecipient() != modelPending) _bad("recipient != the last uncancelled proposal");
            modelRecipient = modelPending; modelPending = address(0); okChanges++;
        } catch {
            if (modelPending != address(0) && vm.getBlockTimestamp() >= modelProposedAt + 48 hours) _bad("matured proposal not executable");
        }
    }
    function pass(uint256 s) external { vm.warp(vm.getBlockTimestamp() + bound(s, 1, 30 hours)); }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = false
contract V54FeeControllerInvariantTest is Test {
    V54FeeHandler h; KipurseFeeControllerV5 fc;
    function setUp() public { h = new V54FeeHandler(); fc = h.fc(); targetContract(address(h)); }
    function invariant_noHandlerViolation() public view { assertEq(h.violations(), 0, h.firstViolation()); }
    /// I-3: feePpm <= MAX_FEE_PPM and never increases (equals the model's last successful lowering).
    function invariant_feeOnlyDownAndBounded() public view { assertLe(fc.feePpm(), fc.MAX_FEE_PPM()); assertEq(fc.feePpm(), h.lastPpm()); }
    /// I-4: the recipient is always the initial one or a proposal that waited >= 48 h; never zero.
    function invariant_recipientTimelocked() public view {
        assertEq(fc.feeRecipient(), h.modelRecipient()); assertTrue(fc.feeRecipient() != address(0));
        assertEq(fc.pendingRecipient(), h.modelPending());
    }

    /// Constructor guards.
    function testFuzz_constructorBounds(address admin, uint256 ppm, address rcpt) public {
        if (admin == address(0) || rcpt == address(0)) { vm.expectRevert(Zero.selector); new KipurseFeeControllerV5(admin, ppm, rcpt); return; }
        if (ppm > 3000) { vm.expectRevert(FeeMax.selector); new KipurseFeeControllerV5(admin, ppm, rcpt); return; }
        KipurseFeeControllerV5 c = new KipurseFeeControllerV5(admin, ppm, rcpt);
        assertEq(c.feePpm(), ppm); assertEq(c.feeRecipient(), rcpt); assertEq(c.admin(), admin);
    }
    /// I-4: a proposal is executable exactly at proposedAt + 48 h, not one second earlier; a re-proposal restarts the clock.
    function testFuzz_timelockBoundary(uint256 early, uint256 reproposeAfter) public {
        early = bound(early, 0, 48 hours - 1); reproposeAfter = bound(reproposeAfter, 1, 48 hours - 1);
        vm.prank(address(0xFEEA)); fc.proposeRecipient(address(0x1111));
        uint256 t0 = vm.getBlockTimestamp();
        vm.warp(t0 + early); vm.expectRevert(Timelock.selector); fc.executeRecipient();
        vm.warp(t0 + reproposeAfter); vm.prank(address(0xFEEA)); fc.proposeRecipient(address(0x2222));
        vm.warp(t0 + 48 hours); if (reproposeAfter > 0) { vm.expectRevert(Timelock.selector); fc.executeRecipient(); }
        vm.warp(t0 + reproposeAfter + 48 hours); fc.executeRecipient();
        assertEq(fc.feeRecipient(), address(0x2222));
        vm.expectRevert(Timelock.selector); fc.executeRecipient(); // nothing pending any more
    }
}
