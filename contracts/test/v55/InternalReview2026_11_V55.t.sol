// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// The November 2026 internal-review PoCs (test/poc/InternalReview2026_11.t.sol) replayed against V5.5. On V5.4 each PoC
/// PASSES because the attack works; here each test PASSES because the attack reverts or has no effect.
contract InternalReview2026_11_V55 is V55Base {
    uint256 kShop = 0x5109;
    string constant NAME = "coffee.example"; bytes32 constant M = keccak256("coffee.example");
    address shop = address(0x5409);
    uint256 constant PK = 0xA11CE0FF1CE;
    uint256 ref;

    function setUp() public override {
        super.setUp();
        useSeatWallet();                         // production layout: owners [owner, key seat V2, SPM]
        seatSetKey(PK);
        p = grant(4, 30, pol(address(registry), TERM));
    }

    // ---------------- helpers ----------------
    /// Phone (Face ID) inline trust ("approve & remember", KIND_INLINE_TRUST over OwnerInlineTrust), deadline = expiry.
    function phoneInlineTrust() internal view returns (KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, bytes memory sig) {
        t = trustParams(NAME, arr(shop), none(), 2e6, 5e6, 0); n = keccak256("inline-1"); dline = t.expiry;
        sig = seatSig(6, abi.encode(t, n, dline), inlineDigest(address(wallet), t, n, dline), PK);
    }
    function phoneSignerGrant() internal view returns (bytes memory) {
        KipurseTrustV55.SignerTrust memory g = KipurseTrustV55.SignerTrust({merchant: M, name: NAME, signers: arr(vm.addr(kShop)),
            single: 2e6, daily: 5e6, expiry: uint64(block.timestamp + 90 days)});
        bytes32 n = keccak256("grant-1"); uint256 dline = g.expiry;
        bytes memory sig = seatSig(5, abi.encode(g, n, dline), t5.ownerDigest(t5.signerTrustStructHash(address(wallet), g, n, dline)), PK);
        return abi.encode(g, n, dline, sig);
    }
    function order(address payee, uint256 amount) internal returns (KipurseAdapterV55.PaymentOrder memory o) {
        o = KipurseAdapterV55.PaymentOrder({payee: payee, amount: amount, orderId: keccak256(abi.encode(++ref)),
            deadline: block.timestamp + 1800, chainId: block.chainid, adapter: address(a5), payer: address(wallet)});
    }
    function signO(KipurseAdapterV55.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(kShop, a5.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function payInline(bytes memory a) internal { vm.prank(executor); adapter.payDirect(p, direct(shop, 1e6, ++ref), a, nf, dl()); }
    function v55(KipurseTrustV5.TrustParams memory t) internal pure returns (KipurseTrustV55.TrustParams memory) {
        return KipurseTrustV55.TrustParams(t.merchant, t.name, t.payees, t.signers, t.single, t.daily, t.expiry);
    }

    // =====================================================================================================
    // KR-01: the inline signature can no longer be replayed into trustBySig (different primary type).
    // =====================================================================================================
    function test_KR01_fixed_inlineTrust_cannot_be_replayed_into_trustBySig() public {
        (KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, bytes memory sig) = phoneInlineTrust();
        bytes memory inlineA = abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
        bytes memory grantG = phoneSignerGrant();
        payInline(inlineA);
        KipurseAdapterV55.PaymentOrder memory o1 = order(address(0xD1), 1e6);
        bytes memory so1 = signO(o1);
        vm.prank(executor); a5.paySignedTrusted(p, o1, so1, grantG, nf, dl());

        // the third-party replay now reverts: OwnerInlineTrust is not OwnerTrust
        vm.prank(address(0xBEEF)); vm.expectRevert(OwnerSig.selector); t5.trustBySig(address(wallet), v55(t), n, dline, sig);
        (uint64 epoch,, bool active,,) = t5.trustOf(address(wallet), M);
        assertFalse(active); assertEq(epoch, 0, "no epoch bump");

        // ... so the signer grant and the inline trust keep working
        KipurseAdapterV55.PaymentOrder memory o2 = order(address(0xD2), 1e6);
        bytes memory so2 = signO(o2);
        vm.prank(executor); a5.paySignedTrusted(p, o2, so2, grantG, nf, dl());
        payInline(inlineA);
        assertEq(token.balanceOf(shop), 2e6);
    }

    function test_KR01_fixed_inline_trust_dies_with_the_phone_key() public {
        (KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, bytes memory sig) = phoneInlineTrust();
        bytes memory a = abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
        payInline(a);
        vm.prank(attacker); vm.expectRevert(OwnerSig.selector); t5.trustBySig(address(wallet), v55(t), n, dline, sig);

        // owner loses the phone and clears the key (one normal wallet call, no owner change)
        vm.prank(owner); wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.clearKey, ()));

        // I-7 holds: the inline trust is dead, and there is no stored record to fall back on
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
        d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(BadStranger.selector); adapter.payDirect(p, d, "", nf, dl());
        assertEq(token.balanceOf(shop), 1e6);
    }

    // =====================================================================================================
    // KR-02: a settled-but-unmarked x402 reservation no longer freezes the vault.
    // =====================================================================================================
    function test_KR02_fixed_settled_x402_does_not_block_vault() public {
        nf = 10_000;
        vm.prank(executor); a5.registerPermission(p);
        KipurseAdapterV5.Auth memory a = auth(bidPayee, 3e6, 777);
        (address v, bytes32 digest, bytes32 nonce) = prepare(a);
        settle(v, a, nonce);
        assertEq(PayerVaultV55(v).reserved(), 0, "settled reservation no longer reserved");

        // 1) direct payment works before anyone calls markSettled
        vm.prank(executor); adapter.payDirect(p, direct(bidPayee, 1e6, ++ref), "", nf, dl());
        // 2) the vault can approve its own gas
        address ep = PayerVaultV55(v).entryPoint(); address pm = PayerVaultV55(v).paymaster();
        vm.prank(ep); PayerVaultV55(v).execute(address(token), 0, abi.encodeCall(IERC20.approve, (pm, 5_000)));
        assertEq(token.allowance(v, pm), 5_000);
        // markSettled still closes it for fee accounting
        assertEq(adapter.markSettled(one(digest)), 1);
    }

    // =====================================================================================================
    // KR-03: the vault executes only for the permission it was registered with; registration is restricted.
    // =====================================================================================================
    function test_KR03_fixed_vault_bound_to_one_permission() public {
        address oldExec = address(0x01D);
        KipurseAdapterV5.Policy memory po = polStruct(address(registry), TERM); po.executor = oldExec;
        ISpendPermissionManager.SpendPermission memory pOld = grant(9, 30, abi.encode(po)); // older permission, not revoked
        vm.prank(executor); a5.registerPermission(p);
        // a third party can no longer flip the vault
        vm.prank(address(0xCAFE)); vm.expectRevert(Registrar.selector); a5.registerPermission(pOld);
        // nor the old executor itself while the live binding is in force (V55-02) ...
        vm.prank(oldExec); vm.expectRevert(Registrar.selector); a5.registerPermission(pOld);
        address v = a5.vaultAddress(address(wallet));
        assertEq(PayerVaultV55(v).sessionSigner(), executor);
        // ... and if the OWNER binds the vault to pOld, the vault is refused for the other permission p
        vm.prank(address(wallet)); a5.registerPermission(pOld);
        KipurseAdapterV5.Direct memory d = direct(bidPayee, 1e6, ++ref);
        vm.prank(v); vm.expectRevert(VaultPermission.selector); adapter.payDirect(p, d, "", nf, dl());
        assertEq(token.balanceOf(bidPayee), 0);
    }

    // =====================================================================================================
    // KR-04: registry V2 remove() voids queued proposals.
    // =====================================================================================================
    function test_KR04_fixed_registry_remove_cancels_queued_proposals() public {
        KipurseMerchantRegistryV2 reg = new KipurseMerchantRegistryV2(maintainer, 48 hours);
        bytes32 bad = keccak256("bad-shop.example"); address badPayee = address(0xBAD0);
        vm.startPrank(maintainer);
        reg.propose(bad, arr(badPayee), none(), 1e6, 2e6, bytes32("a"));
        reg.propose(bad, arr(badPayee), none(), 1e6, 2e6, bytes32("b"));
        vm.stopPrank();
        warpBy(48 hours);
        reg.execute(bad, arr(badPayee), none(), 1e6, 2e6, bytes32("a"));
        vm.prank(maintainer); reg.remove(bad);
        warpBy(1 days);
        vm.prank(attacker); vm.expectRevert(StaleProposal.selector); reg.execute(bad, arr(badPayee), none(), 1e6, 2e6, bytes32("b"));
        (bytes32 m,,) = reg.lookupPayee(badPayee); assertEq(m, bytes32(0), "removed merchant stays removed");
    }

    // =====================================================================================================
    // KR-05: inline payee trust must name merchant == keccak256(name).
    // =====================================================================================================
    function test_KR05_fixed_inline_trust_merchant_bound_to_name() public {
        KipurseTrustV5.TrustParams memory t = trustParams(NAME, arr(shop), none(), 2e6, 5e6, type(uint64).max);
        t.merchant = keccak256("some-other-id");
        bytes32 n = bytes32("x"); uint256 dline = type(uint64).max;
        bytes memory sig = walletSig(wallet, ownerKey, inlineDigest(address(wallet), t, n, dline));
        bytes memory a = abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(TrustName.selector); adapter.payDirect(p, d, a, nf, dl());
        assertEq(token.balanceOf(shop), 0);
    }

    // =====================================================================================================
    // KR-07: reconcileFloat works for a USDC-blocklisted wallet (falls back to the payer vault / recovery address).
    // =====================================================================================================
    function test_KR07_fixed_reconcileFloat_for_blocklisted_wallet() public {
        ownerCall(abi.encodeCall(trustC.setFloatCap, (uint160(1e6))));
        vm.prank(executor); a5.fundFloat(p, address(0x5E55), 1e6, uint64(block.timestamp + 1 hours), nf, dl());
        token.setBlocklisted(address(wallet), true);
        warpBy(2 hours);
        address v = a5.vaultAddress(address(wallet));
        uint256 v0 = token.balanceOf(v);
        a5.reconcileFloat(address(wallet));
        (,,,, bool open) = a5.floats(address(wallet));
        assertFalse(open, "float closed");
        assertEq(token.balanceOf(a5.floatAddress(address(wallet))), 0);
        assertEq(token.balanceOf(v) - v0, 1e6 + fee(1e6), "unspent float + unused fee reserve in the owner's vault");
    }
}
