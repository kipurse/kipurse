// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../../src/KipurseErrors.sol";
import "../../src/KipurseErrorsV55.sol";
import {Test} from "forge-std/Test.sol";
import {KipurseMerchantRegistryV2} from "../../src/KipurseMerchantRegistryV2.sol";

/// Port of KipurseMerchantRegistry.t.sol to the V2 registry, plus the KR-04 checks (removal generation, proposal grace,
/// renew only while unexpired) and a Safe-style multisig maintainer (any contract address works; no code change needed).
contract KipurseMerchantRegistryV2Test is Test {
    KipurseMerchantRegistryV2 r; address m = address(0x5AFE);
    bytes32 constant A = keccak256("a.example");
    function arr(address x) internal pure returns (address[] memory y) { y = new address[](1); y[0] = x; }
    function none() internal pure returns (address[] memory y) { y = new address[](0); }
    function setUp() public { vm.warp(1_700_000_000); r = new KipurseMerchantRegistryV2(m, 48 hours); }
    function warpBy(uint256 s) internal { vm.warp(vm.getBlockTimestamp() + s); }

    function test_constructor_delayAtLeast48h() public {
        vm.expectRevert(Delay.selector); new KipurseMerchantRegistryV2(m, 48 hours - 1);
        vm.expectRevert(BadMaintainer.selector); new KipurseMerchantRegistryV2(address(0), 48 hours);
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

    // ---------------- KR-04 ----------------
    function _live(bytes32 id, address payee) internal view returns (bool) { (bytes32 mm,,) = r.lookupPayee(payee); return mm == id; }
    /// The internal-review PoC (test/poc/InternalReview2026_11.t.sol test_KR04) must fail: a proposal queued before remove()
    /// can never re-activate the removed merchant.
    function test_KR04_removeVoidsQueuedProposals() public {
        vm.startPrank(m);
        r.propose(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "a");
        r.propose(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "b");
        vm.stopPrank();
        warpBy(48 hours);
        r.execute(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "a");
        vm.prank(m); r.remove(A);
        assertFalse(_live(A, address(0xBAD0)));
        vm.prank(address(0xBAD)); vm.expectRevert(StaleProposal.selector); r.execute(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "b");
        assertFalse(_live(A, address(0xBAD0)), "removed merchant stays removed");
        // a NEW proposal after the removal is fine (fresh 48 h timelock)
        vm.prank(m); r.propose(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "c");
        warpBy(48 hours - 1);
        vm.expectRevert(Timelock.selector); r.execute(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "c");
        warpBy(1); r.execute(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "c");
        assertTrue(_live(A, address(0xBAD0)));
        // the stale one can still be cancelled (cleanup), but never executed
        bytes32 idB = r.proposalId(A, arr(address(0xBAD0)), none(), 1e6, 2e6, "b");
        assertGt(r.proposalEta(idB), 0);
        vm.prank(m); r.cancel(idB);
        assertEq(r.proposalEta(idB), 0);
    }
    /// Removing ANOTHER merchant does not affect this merchant's queued proposals.
    function test_KR04_epochIsPerMerchant() public {
        bytes32 B = keccak256("b.example");
        vm.prank(m); r.propose(A, arr(address(1)), none(), 1e6, 2e6, "s");
        vm.prank(m); r.remove(B);
        warpBy(48 hours); r.execute(A, arr(address(1)), none(), 1e6, 2e6, "s");
        assertTrue(_live(A, address(1)));
    }
    /// Matured proposals expire PROPOSAL_GRACE after their eta.
    function testFuzz_KR04_proposalGrace(uint256 dt) public {
        dt = bound(dt, 0, 30 days);
        vm.prank(m); bytes32 id = r.propose(A, arr(address(1)), none(), 1e6, 2e6, "s");
        (uint64 eta, uint64 ep) = r.proposals(id); assertEq(ep, 0);
        warpBy(48 hours + dt);
        if (dt >= r.PROPOSAL_GRACE()) { vm.expectRevert(ProposalExpired.selector); r.execute(A, arr(address(1)), none(), 1e6, 2e6, "s"); }
        else { r.execute(A, arr(address(1)), none(), 1e6, 2e6, "s"); assertTrue(_live(A, address(1))); }
        assertEq(uint256(eta), 1_700_000_000 + 48 hours);
    }
    /// renew() cannot revive an expired record; an unexpired one is extended by VALIDITY.
    function test_KR04_renewOnlyWhileValid() public {
        vm.prank(m); r.propose(A, arr(address(1)), none(), 1e6, 2e6, "s");
        warpBy(48 hours); r.execute(A, arr(address(1)), none(), 1e6, 2e6, "s");
        warpBy(89 days);
        vm.prank(m); r.renew(A);                                   // still valid: extended
        (, uint64 until,,,) = r.merchants(A); assertEq(until, vm.getBlockTimestamp() + 90 days);
        warpBy(90 days);                                           // now expired
        assertFalse(_live(A, address(1)));
        vm.prank(m); vm.expectRevert(RecordExpired.selector); r.renew(A);
        assertFalse(_live(A, address(1)), "expired record stays dead; needs a new timelocked proposal");
    }
    /// The maintainer may be a multisig contract: only msg.sender is checked.
    function test_multisigMaintainer() public {
        MiniMultisig ms = new MiniMultisig();
        KipurseMerchantRegistryV2 r2 = new KipurseMerchantRegistryV2(address(ms), 48 hours);
        ms.exec(address(r2), abi.encodeCall(r2.propose, (A, arr(address(1)), none(), 1e6, 2e6, bytes32("s"))));
        warpBy(48 hours); r2.execute(A, arr(address(1)), none(), 1e6, 2e6, "s");
        (bytes32 mm,,) = r2.lookupPayee(address(1)); assertEq(mm, A);
        ms.exec(address(r2), abi.encodeCall(r2.remove, (A)));
        (mm,,) = r2.lookupPayee(address(1)); assertEq(mm, bytes32(0));
    }
}

/// Stand-in for a Safe: forwards a call after its own (here trivial) approval logic.
contract MiniMultisig {
    function exec(address to, bytes calldata data) external { (bool ok, bytes memory r) = to.call(data); if (!ok) assembly { revert(add(r, 32), mload(r)) } }
}
