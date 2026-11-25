// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import {KipurseAdapterV54} from "../src/KipurseAdapterV54.sol";
import "../src/KipurseErrors.sol";

/// t1181 (decision 84, audit decision 83): binding tests on the LIVE V5.2 adapter (no contract change).
///  - an OwnerApproval is bound to the chain and to the adapter (EIP-712 domain) -> replay elsewhere fails
///  - a SpendPermission for another token (or another spender) is refused by Scope, for every pay entry point
///  - KNOWN BUG documented: after the owner cancels an owner-approved x402 reservation, the SAME approval can be
///    prepared again inside its validBefore window. The live contract allows it; the fix is on the contract branch
///    (approvalUsed) and, without redeploy, in the server (src/v5/approval-use.mjs refuses a consumed approval).
contract KipurseV54RegressAuditGapsTest is V5Base {
    function setUp() public override {
        super.setUp();
        adapter = KipurseAdapterV5(address(new KipurseAdapterV54(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl)));
        trustC = adapter.trust();
        p = grant(2, 30, pol(address(registry), TERM));
    }
    function approvalFor(KipurseAdapterV5 a, KipurseAdapterV5.Direct memory d) internal view returns (bytes memory) {
        return ownerSig(a.approvalDigest(address(wallet), a.purchaseKey(d.payee, d.merchantRef, d.repeatKey), d.payee, d.amount, d.deadline));
    }
    function x402ApprovalFor(KipurseAdapterV5.Auth memory a) internal view returns (bytes memory) {
        return ownerSig(adapter.approvalDigest(address(wallet), adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey), a.to, a.value, a.validBefore));
    }

    // ---------- control: the approval works where it was signed ----------
    function test_ownerApproval_paysWhereSigned() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 501);
        bytes memory sig = approvalFor(adapter, d);
        vm.prank(executor); adapter.payDirect(p, d, sig, nf, dl());
        assertEq(token.balanceOf(stranger), 3e6);
    }

    // ---------- OwnerApproval bound to the chain ----------
    function test_ownerApproval_otherChain_rejected() public {
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 502);
        bytes memory sig = approvalFor(adapter, d);          // signed on chain 84532
        vm.chainId(8453);                                    // same contracts, other chain id
        p = grant(3, 30, pol(address(registry), TERM));      // a valid permission on THIS chain, so only the approval can fail
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, sig, nf, dl());
        assertEq(token.balanceOf(stranger), 0);
    }
    function test_ownerApproval_otherChain_rejected_x402() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 503);
        bytes memory sig = x402ApprovalFor(a);
        vm.chainId(8453);
        p = grant(3, 30, pol(address(registry), TERM));
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.prepareAuthorization(p, a, sig, nf, dl());
    }

    // ---------- OwnerApproval bound to the adapter (verifying contract) ----------
    function test_ownerApproval_otherAdapter_rejected() public {
        KipurseAdapterV5 other = KipurseAdapterV5(address(new KipurseAdapterV54(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl)));
        KipurseAdapterV5 live = adapter;
        KipurseAdapterV5.Direct memory d = direct(stranger, 3e6, 504);
        bytes memory sigLive = approvalFor(live, d);
        assertTrue(live.approvalDigest(address(wallet), bytes32(uint256(1)), stranger, 1, 1) != other.approvalDigest(address(wallet), bytes32(uint256(1)), stranger, 1, 1), "domains differ");
        // a valid permission for the OTHER adapter; the approval signed for the live adapter must not work there
        adapter = other; ISpendPermissionManager.SpendPermission memory q = grant(4, 30, pol(address(registry), TERM));
        vm.prank(executor); vm.expectRevert(Approval.selector); other.payDirect(q, d, sigLive, nf, dl());
        // and the reverse: signed for the other adapter, replayed on the live one
        bytes memory sigOther = approvalFor(other, d);
        vm.prank(executor); vm.expectRevert(Approval.selector); live.payDirect(p, d, sigOther, nf, dl());
        assertEq(token.balanceOf(stranger), 0);
    }

    // ---------- Scope: permission for another token / another spender ----------
    function grantFor(address spender, address tok, uint256 salt) internal returns (ISpendPermissionManager.SpendPermission memory q) {
        bytes memory extra = pol(address(registry), TERM);
        q = ISpendPermissionManager.SpendPermission({account: address(wallet), spender: spender, token: tok,
            allowance: TERM, period: uint48(30 days), start: uint48(vm.getBlockTimestamp()), end: uint48(vm.getBlockTimestamp() + 30 days), salt: salt, extraData: extra});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
    }
    function test_scope_otherTokenPermission_rejected_everyEntryPoint() public {
        MockEIP3009 other = new MockEIP3009(); other.mint(address(wallet), 100e6);
        ISpendPermissionManager.SpendPermission memory q = grantFor(address(adapter), address(other), 7);
        KipurseAdapterV5.Direct memory d = direct(stranger, 5e4, 505);
        vm.prank(executor); vm.expectRevert(Scope.selector); adapter.payDirect(q, d, "", nf, dl());
        bytes memory sig = approvalFor(adapter, direct(stranger, 3e6, 506));
        vm.prank(executor); vm.expectRevert(Scope.selector); adapter.payDirect(q, direct(stranger, 3e6, 506), sig, nf, dl());
        vm.prank(executor); vm.expectRevert(Scope.selector); adapter.prepareAuthorization(q, auth(stranger, 5e4, 507), "", nf, dl());
        KipurseAdapterV5.PaymentOrder memory o = order(bidPayee, 1e6, 508);
        bytes memory os = signOrder(kBid, o);
        vm.prank(executor); vm.expectRevert(Scope.selector); adapter.paySigned(q, o, os, nf, dl());
        assertEq(token.balanceOf(stranger), 0); assertEq(other.balanceOf(stranger), 0); assertEq(other.balanceOf(address(wallet)), 100e6);
    }
    function test_scope_otherSpenderPermission_rejected() public {
        ISpendPermissionManager.SpendPermission memory q = grantFor(address(0xC0FFEE), address(token), 8);
        vm.prank(executor); vm.expectRevert(Scope.selector); adapter.payDirect(q, direct(stranger, 5e4, 509), "", nf, dl());
    }

    // ---------- KNOWN BUG (documented; fixed on the contract branch, guarded by the server on mainnet) ----------
    /// The live V5.2 lets the executor re-prepare an owner-approved x402 payment after the owner cancelled it, with the SAME
    /// approval, while validBefore (<= 600 s) has not passed. This test asserts the CURRENT behaviour so the suite stays
    /// green; KipurseV53ApprovalOnce (branch) asserts the fixed behaviour. Flip this test when the fixed adapter is live.
    function test_FIXED_cancelThenReplay_sameOwnerApproval_rejected() public { // t1181 branch: flipped from test_KNOWN_BUG_...
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 510);
        bytes memory sig = x402ApprovalFor(a);
        vm.prank(executor); (, bytes32 digest,) = adapter.prepareAuthorization(p, a, sig, nf, dl());
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        vm.prank(executor); vm.expectRevert(ApprovalUsed.selector); adapter.prepareAuthorization(p, a, sig, nf, dl());
    }
}
