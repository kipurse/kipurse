// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import "../src/KipurseErrors.sol";

/// V5.2 inline payee trust: phone/owner signs OwnerTrust once, every later payment carries it; no trust tx.
contract KipurseV52InlineTrustTest is V5Base {
    address shop = address(0x5409);
    bytes32 constant SHOP = keccak256("coffee.example");
    uint256 counter;

    function setUp() public override {
        super.setUp();
        KipurseAdapterV52 a2 = new KipurseAdapterV52(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        adapter = KipurseAdapterV5(address(a2)); // identical external ABI
        trustC = adapter.trust();
        p = grant(2, 30, pol(address(registry), TERM));
    }

    function tp(address payee, uint160 s, uint160 d) internal view returns (KipurseTrustV5.TrustParams memory t) {
        t = trustParams("coffee.example", arr(payee), none(), s, d, uint64(vm.getBlockTimestamp() + 180 days));
    }
    function inlineFor(CoinbaseSmartWallet w, uint256 k, KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        bytes memory sig = walletSig(w, k, trustDigest(address(w), t, n, dline));
        return abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
    }
    function inl(KipurseTrustV5.TrustParams memory t) internal view returns (bytes memory) {
        return inlineFor(wallet, ownerKey, t, bytes32("n1"), t.expiry);
    }
    function pay(address payee, uint256 amt, bytes memory appr) internal {
        vm.prank(executor); adapter.payDirect(p, direct(payee, amt, ++counter), appr, nf, dl());
    }
    function payRevert(address payee, uint256 amt, bytes memory appr, bytes memory reason) internal {
        KipurseAdapterV5.Direct memory d = direct(payee, amt, ++counter);
        vm.prank(executor);
        if (reason.length == 0) vm.expectRevert(); else vm.expectRevert(reason);
        adapter.payDirect(p, d, appr, nf, dl());
    }

    function test_inlineTrust_pays_stranger_without_trust_tx() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        pay(shop, 1e6, a);
        assertEq(token.balanceOf(shop), 1e6);
        (,, bool active,,) = trustC.trustOf(address(wallet), SHOP);
        assertFalse(active, "no on-chain trust record written");
        payRevert(shop, 1e6, "", "");
    }
    function test_inlineTrust_reusable_and_merchant_daily_cap() public {
        bytes memory a = inl(tp(shop, 2e6, withFee(3e6)));
        pay(shop, 2e6, a); pay(shop, 1e6, a);
        payRevert(shop, 1, a, "");
        warpBy(1 days); pay(shop, 1e6, a);
        assertEq(token.balanceOf(shop), 4e6);
    }
    function test_inlineTrust_single_cap_and_policy_cap() public {
        payRevert(shop, 2e6 + 1, inl(tp(shop, 2e6, 5e6)), "");
        payRevert(shop, uint256(SINGLE) + 1, inl(tp(shop, 50e6, 50e6)), "");
    }
    function test_forged_signature_rejected() public {
        KipurseTrustV5.TrustParams memory t = tp(shop, 2e6, 5e6);
        payRevert(shop, 1e6, inlineFor(wallet, kEvil, t, bytes32("n1"), t.expiry), abi.encodeWithSelector(Approval.selector));
    }
    function test_tampered_caps_rejected() public {
        KipurseTrustV5.TrustParams memory t = tp(shop, 2e6, 5e6);
        bytes memory sig = walletSig(wallet, ownerKey, trustDigest(address(wallet), t, bytes32("n1"), t.expiry));
        t.single = 6e6;
        payRevert(shop, 5e6, abi.encodePacked(bytes4(0x4b505452), abi.encode(t, bytes32("n1"), uint256(t.expiry), sig)), abi.encodeWithSelector(Approval.selector));
    }
    function test_wrong_wallet_rejected() public {
        uint256 k2 = 0xBEEF; bytes[] memory o = new bytes[](1); o[0] = abi.encode(vm.addr(k2));
        CoinbaseSmartWallet w2 = factory.createAccount(o, 7);
        KipurseTrustV5.TrustParams memory t = tp(shop, 2e6, 5e6);
        payRevert(shop, 1e6, inlineFor(w2, k2, t, bytes32("n1"), t.expiry), abi.encodeWithSelector(Approval.selector));
    }
    function test_wrong_payee_rejected() public {
        payRevert(attacker, 1e6, inl(tp(shop, 2e6, 5e6)), abi.encodeWithSelector(PayeeBinding.selector));
    }
    function test_replay_after_revoke_rejected() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        pay(shop, 1e6, a);
        ownerCall(abi.encodeCall(trustC.untrust, (SHOP)));
        payRevert(shop, 1e6, a, abi.encodeWithSelector(Approval.selector));
    }
    function test_other_chain_rejected() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        vm.chainId(8453);
        payRevert(shop, 1e6, a, "");
    }
    function test_expired_rejected() public {
        KipurseTrustV5.TrustParams memory t = tp(shop, 2e6, 5e6);
        bytes memory a = inl(t);
        vm.warp(t.expiry);
        p = grant(3, 30, pol(address(registry), TERM));
        payRevert(shop, 1e6, a, abi.encodeWithSelector(Approval.selector));
    }
    function test_signers_must_be_empty() public {
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), arr(evilSigner), 2e6, 5e6, uint64(vm.getBlockTimestamp() + 30 days));
        payRevert(shop, 1e6, inl(t), abi.encodeWithSelector(Approval.selector));
    }
    function test_blacklist_and_pause_still_apply() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        ownerCall(abi.encodeCall(trustC.setDeniedPayee, (shop, true)));
        payRevert(shop, 1e6, a, "");
        ownerCall(abi.encodeCall(trustC.setDeniedPayee, (shop, false)));
        ownerCall(abi.encodeCall(trustC.setPaused, (true)));
        payRevert(shop, 1e6, a, "");
        ownerCall(abi.encodeCall(trustC.setPaused, (false)));
        pay(shop, 1e6, a);
    }
    function test_x402_path_inline() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        vm.prank(executor); adapter.prepareAuthorization(p, auth(shop, 1e6, 99), a, nf, dl());
    }
    function test_gas_inline_vs_onchain_trust() public {
        bytes memory a = inl(tp(shop, 2e6, 5e6));
        pay(shop, 1e5, a);
        uint256 g = gasleft(); pay(shop, 1e6, a); uint256 gi = g - gasleft();
        ownerSetTrust("coffee.example", arr(shop), none(), 2e6, 5e6, 0);
        g = gasleft(); pay(shop, 1e6, ""); uint256 go = g - gasleft();
        emit log_named_uint("gas inline", gi); emit log_named_uint("gas onchain-trust", go);
    }
    function test_no_expiry_valid_until_revoke() public {
        // owner t554: remembered trust has no expiry (expiry = deadline = 2^64-1); only revoke ends it
        KipurseTrustV5.TrustParams memory t = trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, type(uint64).max);
        bytes memory a = inlineFor(wallet, ownerKey, t, bytes32("n1"), type(uint64).max);
        pay(shop, 1e6, a);
        vm.warp(block.timestamp + 3650 days); p = grant(4, 30, pol(address(registry), TERM));
        pay(shop, 1e6, a); // still valid ten years later
        ownerCall(abi.encodeCall(trustC.untrust, (SHOP)));
        payRevert(shop, 1e6, a, abi.encodeWithSelector(Approval.selector));
    }
}
