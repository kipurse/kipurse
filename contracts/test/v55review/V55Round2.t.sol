// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../v55/V55Base.t.sol";

/// Independent V5.5 review, round 2. R2-01 converted after the fix (the attack now fails); R2-02 documents the accepted trade-off.
contract V55Round2Test is V55Base {
    address constant BUNDLER = address(0xB0B);

    // R2-01, converted after the fix: the bundler-fee / approve checks now count the paymasters' outstanding allowance, so the
    // combined gas outflow can never reach reserved USDC; and _release credits caps only with what was actually refunded.
    function test_R2_01_fixed_approve_plus_bundler_fee_cannot_eat_reserved() public {
        vm.prank(executor); address v = a5.registerPermission(p);
        ownerExec(v, abi.encodeCall(PayerVaultV55.setBundlerFee, (BUNDLER, uint96(20_000))));
        KipurseAdapterV55.Auth memory au = authV(bidPayee, 1e6, 1);
        vm.prank(executor); (, bytes32 dg,) = a5.prepareAuthorization(p, au, "", 0, dl());
        token.mint(v, 20_000);                                       // gas buffer (free USDC)
        uint256 termBefore = a5.termSpent(phV());

        PayerVaultV55.Call[] memory cs = new PayerVaultV55.Call[](2);
        cs[0] = PayerVaultV55.Call(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 20_000)));
        cs[1] = PayerVaultV55.Call(address(token), 0, abi.encodeCall(IERC20.transfer, (BUNDLER, 20_000)));
        vm.prank(EP); vm.expectRevert(Reserved.selector); PayerVaultV55(v).executeBatch(cs);   // whole op refused
        // order reversed: fee first, then approve -> the approve now sees the smaller free balance
        cs[0] = PayerVaultV55.Call(address(token), 0, abi.encodeCall(IERC20.transfer, (BUNDLER, 20_000)));
        cs[1] = PayerVaultV55.Call(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 20_000)));
        vm.prank(EP); vm.expectRevert(Reserved.selector); PayerVaultV55(v).executeBatch(cs);
        // each alone within the free buffer still works
        vm.prank(EP); PayerVaultV55(v).execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 20_000)));
        vm.prank(EP); vm.expectRevert(Reserved.selector);
        PayerVaultV55(v).execute(address(token), 0, abi.encodeCall(IERC20.transfer, (BUNDLER, 1)));   // allowance already uses the buffer
        vm.prank(PM); token.transferFrom(v, PM, 20_000);             // paymaster postOp: actual gas
        assertGe(token.balanceOf(v), PayerVaultV55(v).reserved(), "I-8 holds");

        warpBy(1 hours);
        uint256 w0 = token.balanceOf(address(wallet));
        a5.reclaim(dg);                                              // anyone
        assertEq(token.balanceOf(address(wallet)) - w0, 1e6 + fee(1e6), "full refund");
        assertEq(a5.termSpent(phV()), termBefore - 1e6 - fee(1e6));
        assertEq(token.balanceOf(BUNDLER), 0);
    }
    /// R2-01 part 2: if a shortfall ever happens anyway, the caps stay charged with the missing part.
    function test_R2_01_fixed_caps_credited_only_with_refunded_amount() public {
        KipurseAdapterV55.Auth memory au = authV(bidPayee, 1e6, 2);
        vm.prank(executor); (address v, bytes32 dg,) = a5.prepareAuthorization(p, au, "", 0, dl());
        uint256 termAfterPrep = a5.termSpent(phV());
        vm.prank(v); token.transfer(address(0xD00D), 3e5);           // USDC leaves the vault outside the adapter
        vm.prank(address(wallet)); a5.cancelReservation(dg);
        assertEq(termAfterPrep - a5.termSpent(phV()), 7e5 + fee(1e6), "only paid + fee credited; 3e5 stays charged");
        assertEq(a5.daySpent(phV(), today()), 3e5 + (termAfterPrep - 1e6 - fee(1e6)), "day counter likewise");
    }

    // R2-02 (info): after a facilitator settlement the cached reservedTotal still counts the settled value, so the vault's
    // ERC-1271 permit (gas) is refused until someone calls sync()/markSettled; anyone can, and sync never unlocks reserved funds.
    function test_R2_02_permit_blocked_until_sync_and_sync_is_safe() public {
        address keyed = vm.addr(0x5E55);
        KipurseAdapterV5.Policy memory po = polStruct(address(registry), TERM55); po.executor = keyed;
        ISpendPermissionManager.SpendPermission memory q = grant(57, 30, abi.encode(po));
        vm.prank(keyed); a5.registerPermission(q);
        KipurseAdapterV55.Auth memory au = authV(bidPayee, 2e6, 1);
        vm.prank(executor); (address v,, bytes32 n) = a5.prepareAuthorization(p, au, "", 0, dl());
        token.mint(v, 50_000);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), v, PM, uint256(10_000), uint256(0), uint256(1e10)))));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(0x5E55, d);
        bytes memory sig = abi.encode(PM, uint256(10_000), uint256(0), uint256(1e10), abi.encodePacked(r, s, vv));
        vm.prank(facilitator); token.transferWithAuthorization(v, au.to, au.value, au.validAfter, au.validBefore, n, hex"00");
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0xffffffff), "gas refused while stale");
        vm.prank(attacker); PayerVaultV55(v).sync();
        assertEq(PayerVaultV55(v).reservedTotal(), 0);
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0x1626ba7e));
        // sync on an UNSETTLED reservation changes nothing
        KipurseAdapterV55.Auth memory au2 = authV(bidPayee, 1e6, 2);
        vm.prank(executor); a5.prepareAuthorization(p, au2, "", 0, dl());
        vm.prank(attacker); PayerVaultV55(v).sync();
        assertEq(PayerVaultV55(v).reservedTotal(), 1e6);
    }
}

/// Seat V2 digests must equal what KipurseTrustV55 / KipurseAdapterV55 verify (positive control, should always pass).
contract V55Round2SeatTest is V55Base {
    function test_R2_seat_constants_and_domain_match_trust_and_adapter() public {
        useSeatWallet();
        assertEq(seat.adapter(), address(a5));
        assertEq(seat.TRUST_TYPEHASH(), t5.TRUST_TYPEHASH());
        assertEq(seat.INLINE_TRUST_TYPEHASH(), t5.INLINE_TRUST_TYPEHASH());
        assertEq(seat.UNTRUST_TYPEHASH(), t5.UNTRUST_TYPEHASH());
        assertEq(seat.DENY_SIGNER_TYPEHASH(), t5.DENY_SIGNER_TYPEHASH());
        assertEq(seat.SIGNER_TRUST_TYPEHASH(), t5.SIGNER_TRUST_TYPEHASH());
        assertEq(seat.APPROVAL_TYPEHASH(), a5.APPROVAL_TYPEHASH());
        assertEq(seat.ownerDigest(bytes32(uint256(7))), t5.ownerDigest(bytes32(uint256(7))));
        vm.chainId(8453); // other chain: both move together, and differ from before
        assertEq(seat.ownerDigest(bytes32(uint256(7))), t5.ownerDigest(bytes32(uint256(7))));
    }
}
