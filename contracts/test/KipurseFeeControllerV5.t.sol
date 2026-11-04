// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {Test} from "forge-std/Test.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";

/// Invariants I-FEE-1..4: fee only goes down, never above 0.3%; recipient changes only after 48h; only admin proposes/cancels.
contract KipurseFeeControllerV5Test is Test {
    KipurseFeeControllerV5 f;
    address admin = address(0xA11CE); address r0 = address(0xFEE0); address r1 = address(0xFEE1);
    function setUp() public { vm.warp(1_700_000_000); f = new KipurseFeeControllerV5(admin, 1000, r0); }

    function test_constructorRejects() public {
        vm.expectRevert(Zero.selector); new KipurseFeeControllerV5(address(0), 1000, r0);
        vm.expectRevert(Zero.selector); new KipurseFeeControllerV5(admin, 1000, address(0));
        vm.expectRevert(FeeMax.selector); new KipurseFeeControllerV5(admin, 3001, r0);
        assertEq(new KipurseFeeControllerV5(admin, 3000, r0).feePpm(), 3000);
    }
    function test_feeOnlyDown() public {
        vm.expectRevert(Admin.selector); f.lowerFee(500);
        vm.startPrank(admin);
        vm.expectRevert(OnlyDown.selector); f.lowerFee(1000);
        vm.expectRevert(OnlyDown.selector); f.lowerFee(1001);
        f.lowerFee(500); assertEq(f.feePpm(), 500);
        f.lowerFee(0); assertEq(f.feePpm(), 0);
        vm.expectRevert(OnlyDown.selector); f.lowerFee(0);
    }
    function testFuzz_feeNeverRises(uint256 a, uint256 b) public {
        vm.startPrank(admin);
        a = bound(a, 0, 999); f.lowerFee(a);
        if (b >= a) { vm.expectRevert(OnlyDown.selector); f.lowerFee(b); } else { f.lowerFee(b); }
        assertLe(f.feePpm(), a);
    }
    function test_recipientTimelock() public {
        vm.expectRevert(Admin.selector); f.proposeRecipient(r1);
        vm.startPrank(admin);
        vm.expectRevert(Zero.selector); f.proposeRecipient(address(0));
        vm.expectRevert(Timelock.selector); f.executeRecipient(); // nothing pending
        f.proposeRecipient(r1); assertEq(f.pendingAt(), block.timestamp + 48 hours);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(Timelock.selector); f.executeRecipient();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xBEEF)); f.executeRecipient(); // anyone can execute once matured
        assertEq(f.feeRecipient(), r1); assertEq(f.pendingRecipient(), address(0)); assertEq(f.pendingAt(), 0);
    }
    function test_cancelRecipient() public {
        vm.prank(admin); f.proposeRecipient(r1);
        vm.expectRevert(Admin.selector); f.cancelRecipient();
        vm.prank(admin); f.cancelRecipient();
        vm.warp(block.timestamp + 72 hours);
        vm.expectRevert(Timelock.selector); f.executeRecipient();
        assertEq(f.feeRecipient(), r0);
    }
}
