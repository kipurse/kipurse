// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {KipurseAdapterV5} from "../src/KipurseAdapterV5.sol";
import {KipurseFloatVaultV5} from "../src/KipurseFloatVaultV5.sol";

/// M3 micropayment float: daily float (<= owner cap) + session-key EIP-3009 vouchers settled by the merchant's facilitator,
/// reconciled once (protocol fee on the actual spend, rounded up). Worst case = the float balance.
contract KipurseV5FloatTest is V5Base {
    uint256 sessKey = 0x5E55; address sess;
    uint160 constant CAP = 5e6;
    function setUp() public override {
        super.setUp(); sess = vm.addr(sessKey);
        ownerCall(abi.encodeCall(trustC.setFloatCap, (CAP)));
        nf = 3000;
    }
    function fund(uint256 amount, uint64 exp) internal { vm.prank(executor); adapter.fundFloat(p, sess, amount, exp, nf, dl()); }
    function fv() internal view returns (address) { return adapter.floatAddress(address(wallet)); }
    function voucher(uint256 k, address to, uint256 value, uint256 n, uint256 vb) internal view returns (bytes32 nonce, bytes memory sig) {
        nonce = keccak256(abi.encode("micro", n));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            fv(), to, value, uint256(0), vb, nonce))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, d);
        sig = abi.encode(to, value, uint256(0), vb, nonce, abi.encodePacked(r, s, v));
    }
    function micro(address to, uint256 value, uint256 n) internal returns (bool ok) {
        uint256 vb = vm.getBlockTimestamp() + 300;
        (bytes32 nonce, bytes memory sig) = voucher(sessKey, to, value, n, vb);
        vm.prank(facilitator);
        try token.transferWithAuthorization(fv(), to, value, 0, vb, nonce, sig) { ok = true; } catch {}
    }

    function test_float_100Micropayments_twoOfOurTxs_feeOnActualSpendRoundedUp() public {
        uint256 w0 = token.balanceOf(address(wallet));
        uint64 exp = uint64(vm.getBlockTimestamp() + 1 days);
        fund(2e6, exp);                                                       // our tx #1 (gas top-up nf -> owner vault)
        assertEq(token.balanceOf(fv()), 2e6); assertEq(adapter.pendingFees(), 2000);
        assertEq(adapter.daySpent(ph(), 0), 2e6 + 2000 + nf);                  // float counts against daily + term when funded
        for (uint256 i; i < 100; i++) assertTrue(micro(stranger, 1001, i));   // 100 x 0.001001 USDC, settled by the merchant's facilitator
        assertEq(token.balanceOf(stranger), 100_100);
        vm.expectRevert(BadFloat.selector); adapter.reconcileFloat(address(wallet)); // not before expiry (except the owner)
        vm.warp(exp);
        assertFalse(micro(stranger, 1001, 1000));                              // session over
        (uint256 spent, uint256 f) = adapter.reconcileFloat(address(wallet));  // our tx #2 (anyone; gas prepaid in nf)
        assertEq(spent, 100_100); assertEq(f, 101);                            // ceil(100,100 * 0.1%) = 101 (not 100 x 1)
        assertEq(token.balanceOf(fv()), 0); assertEq(adapter.pendingFees(), 0); assertEq(adapter.accruedFees(), 101); assertEq(token.balanceOf(adapter.vaultAddress(address(wallet))), nf); // gas top-up = owner money in the payer vault
        assertEq(w0 - token.balanceOf(address(wallet)), 100_100 + 101 + nf);   // payer bears spend + fee + gas, nothing else
        vm.expectRevert(BadFloat.selector); adapter.reconcileFloat(address(wallet));
    }
    function test_float_leakedSessionKey_worstCaseIsTheFloat_andOnlyEip3009WithinBounds() public {
        uint64 exp = uint64(vm.getBlockTimestamp() + 12 hours);
        fund(3e5, exp); address F = fv();
        assertFalse(micro(attacker, OPEN_SINGLE + 1, 1));                      // above the owner's stranger per-payment cap
        uint256 vbLate = exp + 1; (bytes32 n1, bytes memory s1) = voucher(sessKey, attacker, 1000, 2, vbLate);
        vm.prank(facilitator); vm.expectRevert(bytes("invalid signature")); token.transferWithAuthorization(F, attacker, 1000, 0, vbLate, n1, s1);
        (bytes32 n2, bytes memory s2) = voucher(0xBAD5, attacker, 1000, 3, exp - 1); // wrong key
        vm.prank(facilitator); vm.expectRevert(bytes("invalid signature")); token.transferWithAuthorization(F, attacker, 1000, 0, exp - 1, n2, s2);
        // the session key cannot approve a permit or any other hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessKey, keccak256("anything"));
        assertEq(KipurseFloatVaultV5(F).isValidSignature(keccak256("anything"), abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        uint256 pdl = vm.getBlockTimestamp() + 100; vm.expectRevert(bytes("invalid signature")); token.permit(F, attacker, 1e6, pdl, abi.encode(attacker, 1e6, 0, exp - 1, bytes32(0), abi.encodePacked(r, s, v)));
        // drain attempt: at most the float balance leaves, never the wallet or the payer vault
        uint256 w0 = token.balanceOf(address(wallet)); uint256 got;
        for (uint256 i = 10; i < 20; i++) if (micro(attacker, OPEN_SINGLE, i)) got += OPEN_SINGLE;
        assertEq(got, 3e5); assertEq(token.balanceOf(attacker), 3e5); assertEq(token.balanceOf(address(wallet)), w0);
    }
    function test_float_pauseAndDenyStopVouchersImmediately() public {
        fund(5e5, uint64(vm.getBlockTimestamp() + 1 days));
        assertTrue(micro(stranger, 1000, 1));
        ownerCall(abi.encodeCall(trustC.setDeniedPayee, (stranger, true)));
        assertFalse(micro(stranger, 1000, 2)); assertTrue(micro(bidPayee, 1000, 3));
        vm.prank(executor); adapter.pause(p);                                  // one tap, no owner signature
        assertFalse(micro(bidPayee, 1000, 4));
    }
    function test_float_capsAndBounds() public {
        uint64 exp = uint64(vm.getBlockTimestamp() + 1 days);
        vm.prank(executor); vm.expectRevert(FloatCap.selector); adapter.fundFloat(p, sess, CAP + 1, exp, nf, dl());
        vm.prank(executor); vm.expectRevert(FloatExpiry.selector); adapter.fundFloat(p, sess, 1e6, exp + 1, nf, dl());
        vm.prank(attacker); vm.expectRevert(BadExecutor.selector); adapter.fundFloat(p, sess, 1e6, exp, nf, dl());
        vm.prank(executor); vm.expectRevert(NetworkFee.selector); adapter.fundFloat(p, sess, 1e6, exp, MAX_NF + 1, dl());
        fund(3e6, exp);
        vm.prank(executor); vm.expectRevert(FloatOpen.selector); adapter.fundFloat(p, sess, 1e6, exp, nf, dl());
        vm.prank(address(wallet)); adapter.reconcileFloat(address(wallet));    // owner exit: any time
        vm.prank(executor); vm.expectRevert(FloatCap.selector); adapter.fundFloat(p, sess, 2e6 + 1, exp, nf, dl()); // 3 + 2.000001 > 5 per day
        fund(2e6, exp);
        assertEq(adapter.floatDaySpent(ph(), 0), 5e6);
        ownerCall(abi.encodeCall(trustC.setFloatCap, (0)));                    // owner disables the float
        vm.prank(address(wallet)); adapter.reconcileFloat(address(wallet));
        warpBy(1 days);
        vm.prank(executor); vm.expectRevert(FloatCap.selector); adapter.fundFloat(p, sess, 1, uint64(vm.getBlockTimestamp() + 1 hours), nf, dl());
    }
    function test_float_ownerExitReturnsEverythingUnspent() public {
        uint256 w0 = token.balanceOf(address(wallet));
        fund(1e6, uint64(vm.getBlockTimestamp() + 1 days));
        assertTrue(micro(stranger, 5e4, 1));
        vm.prank(address(wallet)); (uint256 spent, uint256 f) = adapter.reconcileFloat(address(wallet));
        assertEq(spent, 5e4); assertEq(f, 50);
        assertEq(w0 - token.balanceOf(address(wallet)), 5e4 + 50 + nf);
        assertFalse(micro(stranger, 5e4, 2));                                  // session closed
        assertEq(token.balanceOf(address(adapter)), adapter.accruedFees() + adapter.pendingFees());
    }
    function testFuzz_float_reconcileFeeNeverAboveReserveAndConserves(uint96[8] memory vals) public {
        uint256 w0 = token.balanceOf(address(wallet));
        uint64 exp = uint64(vm.getBlockTimestamp() + 1 days);
        fund(CAP, exp);
        uint256 paid;
        for (uint256 i; i < vals.length; i++) { uint256 v = bound(uint256(vals[i]), 1, OPEN_SINGLE); if (micro(stranger, v, i)) paid += v; }
        vm.warp(exp);
        (uint256 spent, uint256 f) = adapter.reconcileFloat(address(wallet));
        assertEq(spent, paid); assertEq(f, fee(paid)); assertLe(f, fee(CAP));
        assertEq(w0 - token.balanceOf(address(wallet)), paid + f + nf);
        assertEq(token.balanceOf(address(adapter)), adapter.accruedFees() + adapter.pendingFees());
    }
}
