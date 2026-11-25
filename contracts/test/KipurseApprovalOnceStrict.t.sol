// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import "../src/KipurseErrors.sol";

/// t1181 (decision 84): STRICT version of the cancel-then-replay check. FAILS on the live V5.2 source (the bug), PASSES on the
/// contract branch (approvalUsed). Not part of the live suite; the live suite carries test_KNOWN_BUG_... instead.
contract KipurseApprovalOnceStrictTest is V5Base {
    function setUp() public override {
        super.setUp();
        adapter = KipurseAdapterV5(address(new KipurseAdapterV52(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl)));
        trustC = adapter.trust();
        p = grant(2, 30, pol(address(registry), TERM));
    }
    function x402ApprovalFor(KipurseAdapterV5.Auth memory a) internal view returns (bytes memory) {
        return ownerSig(adapter.approvalDigest(address(wallet), adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey), a.to, a.value, a.validBefore));
    }
    function test_cancelThenReplay_sameOwnerApproval_rejected() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 510);
        bytes memory sig = x402ApprovalFor(a);
        vm.prank(executor); (, bytes32 digest,) = adapter.prepareAuthorization(p, a, sig, nf, dl());
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        vm.prank(executor); vm.expectRevert(); adapter.prepareAuthorization(p, a, sig, nf, dl());
    }
}
