// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// Tests for every check that is NEW in V5.5 (beyond the ported V5.4 suites and the inverted PoCs).
contract V55NewChecksTest is V55Base {
    uint256 ref;

    // ======================= typed data (gateway / iOS must recompute these) =======================
    function test_typehashes_and_domain() public view {
        assertEq(t5.INLINE_TRUST_TYPEHASH(), keccak256("OwnerInlineTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"));
        assertTrue(t5.INLINE_TRUST_TYPEHASH() != t5.TRUST_TYPEHASH());
        assertEq(t5.TRUST_TYPEHASH(), trustC.TRUST_TYPEHASH());
        bytes32 dom = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Kipurse Owner"), keccak256("5"), block.chainid, address(a5)));
        assertEq(t5.ownerDigest(bytes32(uint256(1))), keccak256(abi.encodePacked("\x19\x01", dom, bytes32(uint256(1)))));
        assertEq(t5.core(), address(a5));
    }

    // ======================= KR-05: inline expiry bounds (finite <= 366 days, or NO_EXPIRY) =======================
    function _inline(uint64 exp, uint256 dline) internal view returns (bytes memory) {
        KipurseTrustV5.TrustParams memory t = inlineParams(); t.expiry = exp;
        return inlineBlob(ownerKey, t, bytes32("n"), dline);
    }
    function _payInline(bytes memory blob, bytes4 err) internal {
        KipurseAdapterV55.Direct memory d = dirV(INLINE_PAYEE, 1e6, ++ref);
        vm.prank(executor); if (err != bytes4(0)) vm.expectRevert(err);
        a5.payDirect(p, d, blob, 0, dl());
    }
    function test_KR05_inline_expiry_bounds() public {
        uint256 nowTs = vm.getBlockTimestamp();
        _payInline(_inline(uint64(nowTs + 365 days), nowTs + 365 days), bytes4(0));                     // exactly 365 days: ok (V55-07)
        _payInline(_inline(uint64(nowTs + 365 days + 1), nowTs + 1 days), TrustExpiry.selector);       // one second more: refused
        _payInline(_inline(type(uint64).max - 1, nowTs + 1 days), TrustExpiry.selector);                // huge but finite: refused
        _payInline(_inline(type(uint64).max, type(uint64).max), bytes4(0));                            // "remember": no expiry, ok
        assertEq(token.balanceOf(INLINE_PAYEE), 2e6);
    }
    function test_KR05_trustBySig_still_rejects_permanent_records() public {
        KipurseTrustV5.TrustParams memory t = trustParams(INAME, arr(INLINE_PAYEE), none(), IS, ID, type(uint64).max);
        bytes memory sig = ownerSig(trustDigest(address(wallet), t, bytes32("s"), type(uint64).max));
        vm.expectRevert(TrustExpiry.selector);
        t5.trustBySig(address(wallet), KipurseTrustV55.TrustParams(t.merchant, t.name, t.payees, t.signers, t.single, t.daily, t.expiry),
            bytes32("s"), type(uint64).max, sig);
    }
    function test_KR05_inline_view_returns_caps() public view {
        KipurseTrustV5.TrustParams memory t = inlineParams();
        bytes memory blob = inlineBlob(ownerKey, t, bytes32("n"), vm.getBlockTimestamp() + 1 days);
        (bytes32 m, uint160 s, uint160 d) = t5.inlinePayeeTrust(address(wallet), INLINE_PAYEE, _strip(blob));
        assertEq(m, IM); assertEq(s, IS); assertEq(d, ID);
    }
    function _strip(bytes memory b) internal pure returns (bytes memory r) {
        r = new bytes(b.length - 4); for (uint256 i; i < r.length; i++) r[i] = b[i + 4];
    }

    // ======================= KR-02: reservations tracked with their nonce =======================
    function _prep(uint256 a, uint256 r_) internal returns (address v, bytes32 dg, bytes32 n, KipurseAdapterV55.Auth memory au) {
        au = authV(bidPayee, a, r_);
        vm.prank(executor); (v, dg, n) = a5.prepareAuthorization(p, au, "", 0, dl());
    }
    function _settle(address v, KipurseAdapterV55.Auth memory au, bytes32 n) internal {
        vm.prank(facilitator); token.transferWithAuthorization(v, au.to, au.value, au.validAfter, au.validBefore, n, hex"00");
    }
    function test_KR02_withdraw_and_sweep_not_blocked_by_settled_unmarked() public {
        (address v, , bytes32 n, KipurseAdapterV55.Auth memory au) = _prep(2e6, 1);
        token.mint(v, 1e6); // e.g. a merchant refund
        _settle(v, au, n);
        assertEq(PayerVaultV55(v).unreserved(), 1e6);
        ownerExec(v, abi.encodeCall(PayerVaultV55.withdraw, (IERC20(address(token)), address(wallet), 1e6)));
        assertEq(token.balanceOf(v), 0);
    }
    function test_KR02_permit_1271_valid_while_settled_unmarked() public {
        vm.prank(executor); a5.registerPermission(p);
        (address v, , bytes32 n, KipurseAdapterV55.Auth memory au) = _prep(2e6, 1);
        token.mint(v, 50_000);
        uint256 sk = 0x5E55; // not the session signer: just checks the reserve rule comes first
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), v, PM, uint256(10_000), uint256(0), uint256(1e10)))));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(sk, d);
        bytes memory sig = abi.encode(PM, uint256(10_000), uint256(0), uint256(1e10), abi.encodePacked(r, s, vv));
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0xffffffff), "wrong signer");
        // the fixture executor (0xA001) has no private key: register a permission whose executor is a real key
        address keyed = vm.addr(0x5E55);
        KipurseAdapterV5.Policy memory po = polStruct(address(registry), TERM55); po.executor = keyed;
        ISpendPermissionManager.SpendPermission memory q = grant(57, 30, abi.encode(po));
        vm.prank(address(wallet)); a5.registerPermission(q); // the account may re-bind; the executor may not (V55-02)
        (vv, r, s) = vm.sign(sk, d);
        sig = abi.encode(PM, uint256(10_000), uint256(0), uint256(1e10), abi.encodePacked(r, s, vv));
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0x1626ba7e), "unsettled reservation fully backed: ok");
        _settle(v, au, n);
        assertEq(token.balanceOf(v), 50_000);
        // V55-05: the validation path reads only the cached total (no external loop), so until someone syncs it the permit
        // is refused conservatively; any account (no permission needed) unsticks it with vault.sync() or adapter.markSettled.
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0xffffffff), "cached total still counts the settled value");
        vm.prank(attacker); PayerVaultV55(v).sync();
        assertEq(PayerVaultV55(v).reservedTotal(), 0);
        assertEq(PayerVaultV55(v).isValidSignature(d, sig), bytes4(0x1626ba7e), "after sync: gas permit valid (KR-02)");
    }
    /// V55-05: validation-path reads are own storage + USDC balanceOf(vault) only: the cached total equals the sum of tracked
    /// values, and reserved() (execution paths) is never above it.
    function test_V55_05_cached_total_tracks_list() public {
        (address v, bytes32 dA, bytes32 nA, KipurseAdapterV55.Auth memory aA) = _prep(1e5, 1);
        _prep(2e5, 2);
        assertEq(PayerVaultV55(v).reservedTotal(), 3e5); assertEq(PayerVaultV55(v).reserved(), 3e5);
        _settle(v, aA, nA);
        assertEq(PayerVaultV55(v).reservedTotal(), 3e5); assertEq(PayerVaultV55(v).reserved(), 2e5);
        a5.markSettled(one(dA));
        assertEq(PayerVaultV55(v).reservedTotal(), 2e5);
    }
    /// V55-06: expired, unsettled reservations do not count toward MAX_OPEN (only toward MAX_TRACKED), and anyone reclaims them.
    function test_V55_06_expired_do_not_block_new_reservations() public {
        address v; bytes32[] memory ds = new bytes32[](16);
        for (uint256 i; i < 16; i++) (v, ds[i],,) = _prep(1e4, 200 + i);
        KipurseAdapterV55.Auth memory extra = authV(bidPayee, 1e4, 999);
        vm.prank(executor); vm.expectRevert(TooManyReservations.selector); a5.prepareAuthorization(p, extra, "", 0, dl());
        warpBy(121); // all 16 expired, none reclaimed yet
        extra = authV(bidPayee, 1e4, 1000);
        vm.prank(executor); a5.prepareAuthorization(p, extra, "", 0, dl());
        assertEq(PayerVaultV55(v).openCount(), 17);
        vm.prank(attacker); a5.reclaim(ds[0]);                  // anyone releases an expired one
        assertEq(PayerVaultV55(v).openCount(), 16);
        assertEq(PayerVaultV55(v).MAX_TRACKED(), 48);
    }
    function test_KR02_max_open_and_pruning() public {
        uint256 max = 16;
        address v; bytes32[] memory ns = new bytes32[](max); KipurseAdapterV55.Auth[] memory as_ = new KipurseAdapterV55.Auth[](max);
        for (uint256 i; i < max; i++) { (v,, ns[i], as_[i]) = _prep(1e5, 100 + i); }
        assertEq(PayerVaultV55(v).openCount(), max);
        assertEq(PayerVaultV55(v).MAX_OPEN(), max);
        KipurseAdapterV55.Auth memory extra = authV(bidPayee, 1e5, 999);
        vm.prank(executor); vm.expectRevert(TooManyReservations.selector); a5.prepareAuthorization(p, extra, "", 0, dl());
        _settle(v, as_[3], ns[3]); _settle(v, as_[7], ns[7]);   // two settle, nobody marks them
        vm.prank(executor); (, bytes32 dg,) = a5.prepareAuthorization(p, extra, "", 0, dl()); // pruned -> fits
        assertEq(PayerVaultV55(v).openCount(), max - 1);
        assertEq(PayerVaultV55(v).reserved(), 15 * 1e5);
        assertEq(PayerVaultV55(v).approvedUntil(dg), extra.validBefore);
    }
    function test_KR02_markSettled_after_prune_still_closes() public {
        (address v, bytes32 dA, bytes32 nA, KipurseAdapterV55.Auth memory aA) = _prep(1e5, 1);
        _settle(v, aA, nA);
        _prep(1e5, 2); // prunes A from the vault
        (bytes32 nn,,) = PayerVaultV55(v).reservation(dA); assertEq(nn, bytes32(0), "pruned");
        assertEq(PayerVaultV55(v).isValidSignature(dA, ""), bytes4(0xffffffff));
        assertEq(a5.markSettled(one(dA)), 1, "adapter closes it, fee accrues");
        assertEq(a5.pendingFees(), fee(1e5));
    }
    function test_KR02_vault_adapter_only_entry_points() public {
        (address v,,,) = _prep(1e5, 1);
        vm.expectRevert(BadAdapter.selector); PayerVaultV55(v).approveDigest(bytes32(uint256(1)), 1, 1, bytes32(0));
        vm.expectRevert(BadAdapter.selector); PayerVaultV55(v).close(bytes32(uint256(1)));
        vm.expectRevert(BadAdapter.selector); PayerVaultV55(v).refund(attacker, 1);
        vm.expectRevert(BadAdapter.selector); PayerVaultV55(v).setSession(attacker, 1, bytes32(0), 0);
    }

    // ======================= KR-03 =======================
    function test_KR03_account_may_register_and_vault_pays_for_its_permission() public {
        vm.prank(address(wallet)); address v = a5.registerPermission(p);
        assertEq(PayerVaultV55(v).permissionHash(), phV());
        vm.prank(v); a5.payDirect(p, dirV(bidPayee, 1e6, ++ref), "", 0, dl());
        assertEq(token.balanceOf(bidPayee), 1e6);
        // a second, unregistered permission of the same account: the executor key may use it directly, the vault may not
        ISpendPermissionManager.SpendPermission memory q = grant(58, 30, pol(address(registry), TERM55));
        KipurseAdapterV55.Direct memory d = dirV(bidPayee, 1e6, ++ref);
        vm.prank(v); vm.expectRevert(VaultPermission.selector); a5.payDirect(q, d, "", 0, dl());
        vm.prank(executor); a5.payDirect(q, d, "", 0, dl());
    }
    function test_KR03_unregistered_vault_refused() public {
        (address v,,,) = _prep(1e5, 1); // vault deployed by x402, never registered: permissionHash = 0
        KipurseAdapterV55.Direct memory d = dirV(bidPayee, 1e6, ++ref);
        vm.prank(v); vm.expectRevert(VaultPermission.selector); a5.payDirect(p, d, "", 0, dl());
    }

    // ======================= KR-07 =======================
    function _fundFloat(uint256 amt) internal {
        ownerExec(address(t5), abi.encodeCall(t5.setFloatCap, (uint160(1e6))));
        vm.prank(executor); a5.fundFloat(p, vm.addr(K_FLOAT_SESSION), amt, uint64(vm.getBlockTimestamp() + 1 hours), 0, dl());
    }
    function test_KR07_recovery_address_receives_float_when_wallet_blocklisted() public {
        address rec = address(0x4EC0);
        vm.expectEmit(true, false, false, true, address(t5));
        emit KipurseTrustV55.RecoverySet(address(wallet), rec);
        ownerExec(address(t5), abi.encodeCall(t5.setRecovery, (rec)));
        assertEq(t5.recoveryOf(address(wallet)), rec);
        _fundFloat(5e5);
        token.setBlocklisted(address(wallet), true);
        warpBy(2 hours);
        a5.reconcileFloat(address(wallet));
        assertEq(token.balanceOf(rec), 5e5 + fee(5e5));
        assertEq(token.balanceOf(floatV()), 0);
    }
    function test_KR07_wallet_not_blocklisted_unchanged() public {
        ownerExec(address(t5), abi.encodeCall(t5.setRecovery, (address(0x4EC0))));
        _fundFloat(5e5);
        uint256 w0 = token.balanceOf(address(wallet));
        warpBy(2 hours); a5.reconcileFloat(address(wallet));
        assertEq(token.balanceOf(address(wallet)) - w0, 5e5 + fee(5e5));
        assertEq(token.balanceOf(address(0x4EC0)), 0);
    }
    function test_KR07_both_refuse_reverts_loudly_and_owner_can_fix() public {
        address rec = address(0x4EC0);
        ownerExec(address(t5), abi.encodeCall(t5.setRecovery, (rec)));
        _fundFloat(5e5);
        token.setBlocklisted(rec, true);
        token.setBlocklisted(address(wallet), true);
        warpBy(2 hours);
        vm.expectRevert(); a5.reconcileFloat(address(wallet));
        (,,,, bool open) = a5.floats(address(wallet)); assertTrue(open, "nothing silently stranded");
        ownerExec(address(t5), abi.encodeCall(t5.setRecovery, (address(0x4EC1)))); // owner picks another recovery address
        a5.reconcileFloat(address(wallet));
        assertEq(token.balanceOf(address(0x4EC1)), 5e5 + fee(5e5));
    }
    function test_KR07_setRecovery_is_per_caller() public {
        vm.prank(attacker); t5.setRecovery(attacker);           // only sets the attacker's OWN entry
        assertEq(t5.recoveryOf(address(wallet)), address(0));
        assertEq(t5.recoveryOf(attacker), attacker);
    }
    function test_KR07_float_vault_close_adapter_only() public {
        _fundFloat(5e5);
        KipurseFloatVaultV55 fv = KipurseFloatVaultV55(floatV());
        vm.expectRevert(BadAdapter.selector); fv.close(attacker);
    }
    /// ERC-7562 OP-011: isValidSignature reads TIMESTAMP only for stored reservation digests; an expired one is invalid,
    /// an unknown hash goes straight to the permit checks.
    function test_7562_reservation_digest_expiry_and_unknown_hash() public {
        (address v, bytes32 dg,,) = _prep(1e5, 1);
        assertEq(PayerVaultV55(v).isValidSignature(dg, ""), bytes4(0x1626ba7e));
        warpBy(121);
        assertEq(PayerVaultV55(v).isValidSignature(dg, ""), bytes4(0xffffffff), "expired reservation digest");
        assertEq(PayerVaultV55(v).isValidSignature(keccak256("unknown"), ""), bytes4(0xffffffff));
    }
}
