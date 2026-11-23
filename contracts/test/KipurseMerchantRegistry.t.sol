// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {Test} from "forge-std/Test.sol";
import {KipurseMerchantRegistry} from "../src/KipurseMerchantRegistry.sol";

contract KipurseMerchantRegistryTest is Test {
    KipurseMerchantRegistry r; address m = address(0x5AFE);
    bytes32 constant A = keccak256("a.example");
    function arr(address x) internal pure returns (address[] memory y) { y = new address[](1); y[0] = x; }
    function none() internal pure returns (address[] memory y) { y = new address[](0); }
    function setUp() public { vm.warp(1_700_000_000); r = new KipurseMerchantRegistry(m, 48 hours); }
    function warpBy(uint256 s) internal { vm.warp(vm.getBlockTimestamp() + s); }

    function test_constructor_delayAtLeast48h() public {
        vm.expectRevert(Delay.selector); new KipurseMerchantRegistry(m, 48 hours - 1);
        vm.expectRevert(BadMaintainer.selector); new KipurseMerchantRegistry(address(0), 48 hours);
        assertEq(r.delay(), 48 hours);
    }
    function test_onlyMaintainer() public {
        vm.expectRevert(BadMaintainer.selector); r.propose(A, arr(address(1)), none(), 1, 1, "");
        vm.expectRevert(BadMaintainer.selector); r.remove(A);
        vm.expectRevert(BadMaintainer.selector); r.setBlocked(address(1), true);
        vm.expectRevert(BadMaintainer.selector); r.unbindPayee(address(1));
        vm.expectRevert(BadMaintainer.selector); r.proposeMaintainer(address(2));
    }
    function test_proposeValidation() public {
        vm.startPrank(m);
        vm.expectRevert(BadMerchant.selector); r.propose(bytes32(0), arr(address(1)), none(), 1, 1, "");
        vm.expectRevert(Bindings.selector); r.propose(A, none(), none(), 1, 1, "");
        vm.expectRevert(Caps.selector); r.propose(A, arr(address(1)), none(), 2, 1, "");
        vm.expectRevert(Caps.selector); r.propose(A, arr(address(1)), none(), 0, 1, "");
        r.propose(A, arr(address(1)), none(), 1, 1, "");
        vm.expectRevert(Exists.selector); r.propose(A, arr(address(1)), none(), 1, 1, "");
        vm.stopPrank();
    }
    function test_timelockExecuteByAnyoneAndCancel() public {
        vm.prank(m); bytes32 id = r.propose(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        warpBy(48 hours - 1);
        vm.expectRevert(Timelock.selector); r.execute(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        warpBy(1);
        vm.prank(address(0xCAFE)); r.execute(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        (bytes32 mm, uint160 s, uint160 d) = r.lookupPayee(address(1));
        assertEq(mm, A); assertEq(s, 1e6); assertEq(d, 2e6);
        (mm,,) = r.lookupSigner(address(2)); assertEq(mm, A);
        assertTrue(r.isPayeeOf(A, address(1))); assertFalse(r.isPayeeOf(A, address(2)));
        vm.expectRevert(Unknown.selector); r.execute(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s"); // one-shot
        vm.prank(m); id = r.propose(A, arr(address(3)), none(), 1e6, 2e6, "t");
        vm.prank(m); r.cancel(id);
        warpBy(48 hours);
        vm.expectRevert(Unknown.selector); r.execute(A, arr(address(3)), none(), 1e6, 2e6, "t");
    }
    function test_reExecuteReplacesBindings() public {
        vm.prank(m); r.propose(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        warpBy(48 hours); r.execute(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        vm.prank(m); r.propose(A, arr(address(3)), none(), 1e6, 2e6, "t");
        warpBy(48 hours); r.execute(A, arr(address(3)), none(), 1e6, 2e6, "t");
        (bytes32 mm,,) = r.lookupPayee(address(1)); assertEq(mm, bytes32(0));
        (mm,,) = r.lookupSigner(address(2)); assertEq(mm, bytes32(0));
        (mm,,) = r.lookupPayee(address(3)); assertEq(mm, A);
    }
    function test_immediateRemovalUnbindAndBlock() public {
        vm.prank(m); r.propose(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        warpBy(48 hours); r.execute(A, arr(address(1)), arr(address(2)), 1e6, 2e6, "s");
        vm.prank(m); r.unbindSigner(address(2));
        (bytes32 mm,,) = r.lookupSigner(address(2)); assertEq(mm, bytes32(0));
        vm.prank(m); r.setBlocked(address(1), true);
        (mm,,) = r.lookupPayee(address(1)); assertEq(mm, bytes32(0));
        assertTrue(r.blocked(address(1)));
        vm.prank(m); r.setBlocked(address(1), false);
        (mm,,) = r.lookupPayee(address(1)); assertEq(mm, A);
        vm.prank(m); r.remove(A);
        (mm,,) = r.lookupPayee(address(1)); assertEq(mm, bytes32(0));
        vm.prank(m); vm.expectRevert(Inactive.selector); r.renew(A);
    }
    function test_blockedAddressCannotBeListed() public {
        vm.prank(m); r.setBlocked(address(1), true);
        vm.prank(m); r.propose(A, arr(address(1)), none(), 1e6, 2e6, "s");
        warpBy(48 hours);
        vm.expectRevert(Payee.selector); r.execute(A, arr(address(1)), none(), 1e6, 2e6, "s");
    }
    function test_maintainerHandoverTimelocked() public {
        vm.prank(m); r.proposeMaintainer(address(0xBEEF));
        vm.prank(address(0xBEEF)); vm.expectRevert(Timelock.selector); r.acceptMaintainer();
        vm.prank(address(0xBAD)); vm.expectRevert(Pending.selector); r.acceptMaintainer();
        warpBy(48 hours);
        vm.prank(address(0xBEEF)); r.acceptMaintainer();
        assertEq(r.maintainer(), address(0xBEEF));
        // honest maintainer can cancel a pending hand-over by proposing address(0)
        vm.prank(address(0xBEEF)); r.proposeMaintainer(address(0xBAD));
        vm.prank(address(0xBEEF)); r.proposeMaintainer(address(0));
        warpBy(48 hours);
        vm.prank(address(0xBAD)); vm.expectRevert(Pending.selector); r.acceptMaintainer();
    }
}
