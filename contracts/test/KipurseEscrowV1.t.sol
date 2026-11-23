// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {KipurseEscrowV1} from "../src/KipurseEscrowV1.sol";
import {MockEIP3009} from "./MockEIP3009.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
contract KipurseEscrowV1Test is Test {
    MockEIP3009 t; KipurseEscrowV1 e; address owner = address(0x0A11); address exec = address(0xE1); uint256 mk = 0xBEEF; address merchant; address rando = address(0xBAD);
    bytes32 constant ID = keccak256("order-1");
    function setUp() public { vm.warp(1_700_000_000); t = new MockEIP3009(); e = new KipurseEscrowV1(IERC20(address(t)), owner, exec); merchant = vm.addr(mk); }
    function _fund(uint256 a) internal { t.mint(address(e), a); }
    function _open(uint96 a, uint32 review) internal { vm.prank(exec); e.open(ID, merchant, a, uint64(block.timestamp + 3 days), review); }
    function _sig(bytes32 id) internal view returns (bytes memory) { (uint8 v, bytes32 r, bytes32 s) = vm.sign(mk, e.fulfilledDigest(id)); return abi.encodePacked(r, s, v); }
    function test_open_needs_funds_and_role() public {
        vm.prank(exec); vm.expectRevert(KipurseEscrowV1.Unfunded.selector); e.open(ID, merchant, 1e6, uint64(block.timestamp + 1 days), 0);
        _fund(1e6); vm.prank(rando); vm.expectRevert(KipurseEscrowV1.NotAllowed.selector); e.open(ID, merchant, 1e6, uint64(block.timestamp + 1 days), 0);
        vm.prank(exec); vm.expectRevert(KipurseEscrowV1.BadParams.selector); e.open(ID, owner, 1e6, uint64(block.timestamp + 1 days), 0);
        _open(1e6, 1 days); assertEq(e.locked(), 1e6); assertEq(e.unallocated(), 0);
        vm.prank(exec); vm.expectRevert(KipurseEscrowV1.BadParams.selector); e.open(ID, merchant, 1, uint64(block.timestamp + 1 days), 0);
        vm.prank(exec); vm.expectRevert(KipurseEscrowV1.Unfunded.selector); e.open(keccak256("o2"), merchant, 1, uint64(block.timestamp + 1 days), 0); // no double binding
    }
    function test_merchant_signature_then_review_then_release() public {
        _fund(2e6); _open(2e6, 1 days);
        vm.prank(rando); vm.expectRevert(KipurseEscrowV1.NotAllowed.selector); e.confirmFulfilled(ID, hex"00");
        vm.prank(rando); e.confirmFulfilled(ID, _sig(ID));
        vm.expectRevert(KipurseEscrowV1.TooEarly.selector); e.release(ID);
        vm.warp(block.timestamp + 1 days); vm.prank(rando); e.release(ID);
        assertEq(t.balanceOf(merchant), 2e6); assertEq(e.locked(), 0);
        vm.expectRevert(KipurseEscrowV1.BadState.selector); e.release(ID);
    }
    function test_zero_review_releases_on_confirmation() public { _fund(1e6); _open(1e6, 0); vm.prank(merchant); e.confirmFulfilled(ID, ""); assertEq(t.balanceOf(merchant), 1e6); }
    function test_owner_confirm_releases_now() public { _fund(1e6); _open(1e6, 1 days); vm.prank(rando); vm.expectRevert(KipurseEscrowV1.NotAllowed.selector); e.ownerConfirm(ID);
        vm.prank(owner); e.ownerConfirm(ID); assertEq(t.balanceOf(merchant), 1e6); }
    function test_owner_cancel_before_fulfilment_and_dispute_in_review() public {
        _fund(1e6); _open(1e6, 1 days); vm.prank(owner); e.ownerCancel(ID); assertEq(t.balanceOf(owner), 1e6);
        bytes32 id2 = keccak256("o2"); _fund(1e6); vm.prank(exec); e.open(id2, merchant, 1e6, uint64(block.timestamp + 3 days), 1 days);
        vm.prank(merchant); e.confirmFulfilled(id2, ""); vm.prank(owner); e.ownerCancel(id2); assertEq(t.balanceOf(owner), 2e6);
        bytes32 id3 = keccak256("o3"); _fund(1e6); vm.prank(exec); e.open(id3, merchant, 1e6, uint64(block.timestamp + 3 days), 1 days);
        vm.prank(merchant); e.confirmFulfilled(id3, ""); vm.warp(block.timestamp + 1 days); vm.prank(owner); vm.expectRevert(KipurseEscrowV1.BadState.selector); e.ownerCancel(id3);
    }
    function test_timeout_refund_by_anyone() public { _fund(1e6); _open(1e6, 1 days);
        vm.expectRevert(KipurseEscrowV1.BadState.selector); e.refundExpired(ID);
        vm.warp(block.timestamp + 3 days + 1); vm.prank(merchant); vm.expectRevert(KipurseEscrowV1.BadState.selector); e.confirmFulfilled(ID, "");
        vm.prank(rando); e.refundExpired(ID); assertEq(t.balanceOf(owner), 1e6); assertEq(t.balanceOf(merchant), 0); }
    function test_unallocated_only_to_owner() public { _fund(5e5); vm.prank(rando); e.sweepUnallocated(); assertEq(t.balanceOf(owner), 5e5); assertEq(t.balanceOf(rando), 0); }
    function testFuzz_conservation(uint96 a, uint8 path) public { a = uint96(bound(a, 1, 1e12)); _fund(a); _open(a, 1 days);
        if (path % 3 == 0) { vm.prank(owner); e.ownerConfirm(ID); } else if (path % 3 == 1) { vm.prank(owner); e.ownerCancel(ID); } else { vm.warp(block.timestamp + 4 days); e.refundExpired(ID); }
        assertEq(t.balanceOf(merchant) + t.balanceOf(owner), a); assertEq(t.balanceOf(address(e)), 0); assertEq(e.locked(), 0); }
}
