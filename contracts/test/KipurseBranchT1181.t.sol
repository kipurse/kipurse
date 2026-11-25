// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {KipurseAdapterV5, PayerVaultV5, PackedUserOperation} from "../src/KipurseAdapterV5.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import {KipurseTrustV5} from "../src/KipurseTrustV5.sol";
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// t1181 contract BRANCH (NOT deployed): approval used once, session userOps per day, TRUST relay whitelist.
contract KipurseBranchT1181Test is V5Base {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant PM = 0x6C973eBe80dCD8660841D4356bf15c32460271C9;
    uint256 constant SESS = 0x5E55;
    PayerVaultV5 v;
    function setUp() public override {
        executor = vm.addr(SESS);
        super.setUp();
        adapter = KipurseAdapterV5(address(new KipurseAdapterV52(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl)));
        trustC = adapter.trust();
        p = grant(2, 30, pol(address(registry), TERM));
        v = PayerVaultV5(adapter.registerPermission(p));
    }
    function apprX(KipurseAdapterV5.Auth memory a) internal view returns (bytes memory) {
        return ownerSig(adapter.approvalDigest(address(wallet), adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey), a.to, a.value, a.validBefore));
    }
    // ---- approval used once ----
    function test_approvedPrepare_worksOnce_andMarksUsed() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 601);
        bytes memory sig = apprX(a);
        uint256 g = gasleft();
        vm.prank(executor); adapter.prepareAuthorization(p, a, sig, nf, dl());
        emit log_named_uint("gas approved prepare (branch)", g - gasleft());
        bytes32 ad = adapter.approvalDigest(address(wallet), adapter.purchaseKey(a.to, a.merchantRef, a.repeatKey), a.to, a.value, a.validBefore);
        assertTrue(KipurseAdapterV52(address(adapter)).approvalUsed(ad));
    }
    function test_afterCancel_ownerCanApproveAgain_withANewApproval() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 602);
        bytes memory sig = apprX(a);
        vm.prank(executor); (, bytes32 digest,) = adapter.prepareAuthorization(p, a, sig, nf, dl());
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        vm.prank(executor); vm.expectRevert(ApprovalUsed.selector); adapter.prepareAuthorization(p, a, sig, nf, dl());
        a.validBefore = a.validBefore + 1; // the owner signs a NEW approval (new Face ID) for the same purchase
        bytes memory sig2 = apprX(a);
        vm.prank(executor); adapter.prepareAuthorization(p, a, sig2, nf, dl());
    }
    function test_afterReclaim_sameApprovalCannotReopen() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 3e6, 603);
        bytes memory sig = apprX(a);
        vm.prank(executor); (, bytes32 digest,) = adapter.prepareAuthorization(p, a, sig, nf, dl());
        vm.warp(a.validBefore); adapter.reclaim(digest);
        vm.prank(executor); vm.expectRevert(); adapter.prepareAuthorization(p, a, sig, nf, dl());
    }
    function test_withinCapsX402_unaffected_noApprovalNeeded() public {
        KipurseAdapterV5.Auth memory a = auth(stranger, 5e4, 604);
        vm.prank(executor); (, bytes32 digest,) = adapter.prepareAuthorization(p, a, "", nf, dl());
        ownerCall(abi.encodeCall(adapter.cancelReservation, (digest)));
        vm.prank(executor); adapter.prepareAuthorization(p, a, "", nf, dl()); // unchanged: no owner approval involved
    }
    // ---- session userOps per UTC day ----
    function pmd() internal pure returns (bytes memory) { return abi.encodePacked(PM, uint128(1e5), uint128(1e5), uint8(0)); }
    function op(uint256 key, uint64 seq, bytes32 h) internal view returns (PackedUserOperation memory o) {
        o.nonce = (key << 64) | seq; o.paymasterAndData = pmd();
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(SESS, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        o.signature = abi.encodePacked(r, s, vv);
    }
    function test_opsPerDay_capAndWindow() public {
        bytes32 h = keccak256("op"); uint256 day = vm.getBlockTimestamp() / 1 days;
        vm.startPrank(EP);
        uint256 vd = v.validateUserOp(op(day, 0, h), h, 0);
        assertEq(uint48(vd >> 208), day * 1 days, "validAfter = start of the day");
        assertEq(uint48(vd >> 160), day * 1 days + 1 days - 1, "validUntil = end of the day");
        assertEq(uint160(vd), 0, "signature ok");
        v.validateUserOp(op(day, 499, h), h, 0);
        vm.expectRevert(OpsPerDay.selector); v.validateUserOp(op(day, 500, h), h, 0);
        vm.expectRevert(OpsPerDay.selector); v.validateUserOp(op(0, 0, h), h, 0); // key 0 (no day) refused
        // a FUTURE day key is accepted by the account but the EntryPoint only runs it inside that day's window
        uint256 fut = v.validateUserOp(op(day + 5, 0, h), h, 0);
        assertEq(uint48(fut >> 208), (day + 5) * 1 days);
        vm.stopPrank();
    }
    function test_opsPerDay_ownerSetsCap_onlyOwner() public {
        vm.expectRevert(NotAccount.selector); v.setOpsPerDay(5);
        vm.prank(address(wallet)); v.setOpsPerDay(5);
        bytes32 h = keccak256("op"); uint256 day = vm.getBlockTimestamp() / 1 days;
        vm.startPrank(EP);
        v.validateUserOp(op(day, 4, h), h, 0);
        vm.expectRevert(OpsPerDay.selector); v.validateUserOp(op(day, 5, h), h, 0);
        vm.stopPrank();
        assertEq(v.opsPerDay(), 5);
        // owner raises it again (AI payments resume the same day), resets to the default, and cannot set an absurd value
        vm.prank(address(wallet)); v.setOpsPerDay(2000); assertEq(v.opsPerDay(), 2000);
        vm.prank(EP); v.validateUserOp(op(day, 1999, h), h, 0);
        vm.prank(address(wallet)); v.setOpsPerDay(0); assertEq(v.opsPerDay(), 500);
        vm.prank(address(wallet)); vm.expectRevert(OpsPerDay.selector); v.setOpsPerDay(100_001);
        vm.prank(address(wallet)); v.setOpsPerDay(100_000); assertEq(v.opsPerDay(), 100_000);
    }
    function test_opsPerDay_default500() public view { assertEq(v.opsPerDay(), 500); assertEq(v.DEFAULT_OPS_PER_DAY(), 500); }
    function test_opsPerDay_serverAndExecutorCannotSet() public {
        vm.prank(EP); vm.expectRevert(NotAccount.selector); v.setOpsPerDay(1);
        vm.prank(address(adapter)); vm.expectRevert(NotAccount.selector); v.setOpsPerDay(1);
        // the vault itself (i.e. a session userOp calling vault.setOpsPerDay through execute) is not a target the vault allows
        vm.prank(EP); vm.expectRevert(Target.selector); v.execute(address(v), 0, abi.encodeCall(PayerVaultV5.setOpsPerDay, (1)));
    }
    // ---- TRUST relay whitelist ----
    function test_trustWhitelist_onlyBySigRelays() public {
        vm.startPrank(EP);
        vm.expectRevert(Target.selector); v.execute(address(trustC), 0, abi.encodeCall(KipurseTrustV5.setPaused, (true)));
        vm.expectRevert(Target.selector); v.execute(address(trustC), 0, abi.encodeCall(KipurseTrustV5.setFloatCap, (1e6)));
        vm.expectRevert(Target.selector); v.execute(address(trustC), 0, hex"");
        // a BySig relay goes through to TRUST (fails there on the bad signature, not on the vault's whitelist)
        bytes memory relay = abi.encodeCall(KipurseTrustV5.untrustBySig, (address(wallet), bytes32("m"), bytes32("n"), vm.getBlockTimestamp() + 60, hex"00"));
        (bool ok, bytes memory ret) = address(v).call(abi.encodeCall(PayerVaultV5.execute, (address(trustC), 0, relay)));
        assertFalse(ok); assertTrue(ret.length < 4 || bytes4(ret) != Target.selector, "reached TRUST");
        vm.stopPrank();
    }
}
