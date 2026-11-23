// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../v55/V55Base.t.sol";

/// A "trust contract" that answers whatever digest it was told to (used to show V55-01).
contract EvilTrustV55 {
    bytes32 public target;
    function setTarget(bytes32 t) external { target = t; }
    function trustOf(address, bytes32) external pure returns (uint64, uint64, bool, uint160, uint160) { return (0, 0, false, 0, 0); }
    function ownerDigest(bytes32) external view returns (bytes32) { return target; }
    function TRUST_TYPEHASH() external pure returns (bytes32) { return bytes32(uint256(1)); }
    function INLINE_TRUST_TYPEHASH() external pure returns (bytes32) { return bytes32(uint256(1)); }
    function UNTRUST_TYPEHASH() external pure returns (bytes32) { return bytes32(uint256(1)); }
    function DENY_SIGNER_TYPEHASH() external pure returns (bytes32) { return bytes32(uint256(1)); }
    function SIGNER_TRUST_TYPEHASH() external pure returns (bytes32) { return bytes32(uint256(1)); }
}

/// Independent V5.5 review PoCs, converted after the fixes (V55_CHANGES.md §8): each test now PASSES because the attack
/// reverts or has no effect.
contract V55IndependentReviewTest is V55Base {
    uint256 constant PK1 = 0xA11CE0FF1CE;
    uint256 ref;

    // ------------------------------------------------------------------------------------------------
    // V55-01: seat.setTrustContract accepts ANY contract; the seat then trusts that contract's ownerDigest(),
    // so one phone signature can authorize an arbitrary hash for the wallet (here: a Spend Permission that
    // drains the wallet). Breaks THREAT_MODEL I-6 ("phone key validates only Kipurse kinds").
    // ------------------------------------------------------------------------------------------------
    function test_V55_01_fixed_seat_never_signs_a_spend_permission() public {
        useSeatWallet();
        (uint256 px, uint256 py) = vm.publicKeyP256(PK1);
        ownerExec(address(seat), abi.encodeCall(KipurseKeySeatV2.setKey, (px, py)));

        // 1) there is no way to repoint the seat any more
        EvilTrustV55 evil = new EvilTrustV55();
        vm.prank(owner); vm.expectRevert();
        wallet.execute(address(seat), 0, abi.encodeWithSignature("setTrustContract(address)", address(evil)));
        assertEq(address(seat.trust()), address(t5));

        // 2) a phone signature over a foreign hash (spend permission to a thief) is refused for every kind
        address thief = address(0xBEEF);
        uint256 bal = token.balanceOf(address(wallet));
        ISpendPermissionManager.SpendPermission memory sp = ISpendPermissionManager.SpendPermission({
            account: address(wallet), spender: thief, token: address(token), allowance: uint160(bal),
            period: 1 days, start: uint48(vm.getBlockTimestamp()), end: uint48(vm.getBlockTimestamp() + 1 days), salt: 1, extraData: ""});
        bytes32 h = manager.getHash(S(sp));
        for (uint8 k = 1; k <= 6; k++) {
            bytes memory body = k == 2 ? abi.encode(bytes32(0), bytes32(0), uint256(0)) : bytes("");
            bytes memory sig = seatSig(k, body, h, PK1);
            vm.expectRevert(); manager.approveWithSignature(S(sp), sig);
        }
        // 3) even a seat CONSTRUCTED with a malicious "trust" only ever builds Kipurse-typed digests (its domain uses the
        //    trust's core() as verifyingContract), so the foreign hash is still refused
        KipurseKeySeatV2 seat2 = new KipurseKeySeatV2(address(factory), owner, address(manager), address(new EvilCoreTrust()));
        assertTrue(seat2.ownerDigest(bytes32(0)) != h);
        assertEq(token.balanceOf(address(wallet)), bal, "wallet untouched");
        assertEq(token.balanceOf(thief), 0);
    }

    // ------------------------------------------------------------------------------------------------
    // V55-02: KR-03 residual. registerPermission accepts the executor of ANY approved, unrevoked permission,
    // even one whose term has ENDED (SPM.isValid ignores time). A leaked old executor key re-binds the vault
    // to the old permission, takes over the vault's session signer (userOps, paymaster permits, gas) and
    // makes the live executor's vault path revert (VaultPermission).
    // ------------------------------------------------------------------------------------------------
    function test_V55_02_fixed_old_executor_cannot_rebind() public {
        uint256 kOld = 0x01D;
        address oldExec = vm.addr(kOld);
        KipurseAdapterV5.Policy memory po = polStruct(address(registry), TERM55); po.executor = oldExec;
        ISpendPermissionManager.SpendPermission memory oldP = grant(77, 1, abi.encode(po)); // 1-day term, never revoked
        vm.prank(address(wallet)); address v = a5.registerPermission(p);                    // owner binds the live permission
        assertEq(PayerVaultV55(v).sessionSigner(), executor);

        // while both are live: the old executor cannot displace the owner's binding
        vm.prank(oldExec); vm.expectRevert(Registrar.selector); a5.registerPermission(oldP);
        warpBy(2 days); // the old permission's term is over: it is no longer registrable at all
        vm.prank(oldExec); vm.expectRevert(Permission.selector); a5.registerPermission(oldP);
        assertEq(PayerVaultV55(v).sessionSigner(), executor, "live binding kept");
        assertEq(PayerVaultV55(v).permissionHash(), manager.getHash(S(p)));

        KipurseAdapterV55.Direct memory d = dirV(bidPayee, 1e6, ++ref);
        vm.prank(v); a5.payDirect(p, d, "", 0, dl()); // live path works
        assertEq(token.balanceOf(bidPayee), 1e6);
    }

    // ------------------------------------------------------------------------------------------------
    // V55-03: _release now reverts (Reserved) unless the vault holds the FULL value. A stale paymaster allowance
    // (approve <= maxGasPerOp, not fully consumed) lets the paymaster pull USDC after the owner withdrew the
    // unreserved part, so the vault holds less than its open reservation: cancelReservation AND reclaim revert,
    // the caps / purchase key / slot stay taken until someone tops the vault up. (V5.4 swallowed the shortfall.)
    // ------------------------------------------------------------------------------------------------
    function test_V55_03_fixed_owner_withdraw_revokes_stale_gas_allowance_and_cancel_works() public {
        vm.prank(executor); a5.registerPermission(p);
        KipurseAdapterV55.Auth memory au = authV(bidPayee, 1e6, 1);
        vm.prank(executor); (address v, bytes32 dg,) = a5.prepareAuthorization(p, au, "", 0, dl());
        token.mint(v, 20_000);                                                                  // gas buffer
        vm.prank(EP); PayerVaultV55(v).execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 20_000)));
        ownerExec(v, abi.encodeCall(PayerVaultV55.withdraw, (IERC20(address(token)), address(wallet), 20_000)));
        assertEq(token.allowance(v, PM), 0, "owner withdraw revoked the stale allowance");
        vm.prank(PM); vm.expectRevert(); token.transferFrom(v, PM, 20_000);                     // nothing left to pull
        assertGe(token.balanceOf(v), PayerVaultV55(v).reserved(), "I-8 holds");

        uint256 w0 = token.balanceOf(address(wallet));
        vm.prank(address(wallet)); a5.cancelReservation(dg);                                    // exit not blocked
        assertEq(token.balanceOf(address(wallet)) - w0, 1e6 + fee(1e6));
    }

    // ------------------------------------------------------------------------------------------------
    // V55-04: registry V2 binds proposals to the REMOVAL generation only. Executing a newer proposal does not void
    // an older queued one, so anyone can roll the record back to the older parameters within the 7-day grace.
    // ------------------------------------------------------------------------------------------------
    function test_V55_04_fixed_older_proposal_cannot_overwrite_newer_record() public {
        KipurseMerchantRegistryV2 r2 = new KipurseMerchantRegistryV2(maintainer, 48 hours);
        bytes32 m = keccak256("shop.example");
        address payee = address(0x5A1E);
        vm.startPrank(maintainer);
        r2.propose(m, arr(payee), none(), 5e6, 10e6, bytes32("old"));   // first draft: high caps
        r2.propose(m, arr(payee), none(), 1e6, 2e6, bytes32("new"));    // corrected: low caps
        vm.stopPrank();
        warpBy(48 hours);
        r2.execute(m, arr(payee), none(), 1e6, 2e6, bytes32("new"));
        vm.prank(attacker); vm.expectRevert(StaleProposal.selector); r2.execute(m, arr(payee), none(), 5e6, 10e6, bytes32("old"));
        (, uint160 s, uint160 d) = r2.lookupPayee(payee);
        assertEq(s, 1e6); assertEq(d, 2e6);
    }
}

/// A "trust" whose core() is some address: the seat only takes verifyingContract and epochs from it.
contract EvilCoreTrust {
    function core() external pure returns (address) { return address(0xC0DE); }
    function trustOf(address, bytes32) external pure returns (uint64, uint64, bool, uint160, uint160) { return (7, 0, false, 0, 0); }
}
