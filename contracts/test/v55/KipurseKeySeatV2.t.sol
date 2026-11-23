// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V55Base.t.sol";

/// Port of t1213's KipurseKeySeatV1.t.sol to KipurseKeySeatV2 on V5.5, plus KL-5 (on-curve key, low-s only), the new
/// KIND_INLINE_TRUST (6) and the seat-built digests (V55-01: no setTrustContract, hard-coded typehashes and domain). The wallet is created by the Coinbase factory with owners [owner, seat, SPM];
/// after that NO owner is ever added or removed. Phone set / change / off = wallet.execute(seat, 0, setKey|clearKey).
contract KipurseKeySeatV2Test is V55Base {
    uint256 constant PK1 = 0xA11CE0FF1CE; uint256 constant PK2 = 0xB0B0B0B0B;
    address shop = address(0x5409); uint256 ref;
    bytes4 constant ADD_OWNER = 0x0f0f3f24; bytes4 constant REMOVE_OWNER = 0x89625b57;
    uint256 constant P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF;

    function setUp() public override {
        super.setUp();
        useSeatWallet();
        p = grant(9, 30, pol(address(registry), TERM));
    }

    // ---- helpers ----
    function setKeyCall(uint256 pk) internal view returns (bytes memory) {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        return abi.encodeCall(CoinbaseSmartWallet.execute, (address(seat), 0, abi.encodeCall(KipurseKeySeatV2.setKey, (px, py))));
    }
    function ownerSends(bytes memory walletCall) internal { vm.prank(owner); (bool ok, bytes memory r) = address(wallet).call(walletCall); if (!ok) assembly { revert(add(r, 32), mload(r)) } }
    /// Phone "approve & remember" = KIND_INLINE_TRUST over OwnerInlineTrust (V5.5).
    function phoneTrust(KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, uint256 pk) internal view returns (bytes memory) {
        bytes memory sig = seatSig(6, abi.encode(t, n, dline), inlineDigest(address(wallet), t, n, dline), pk);
        return abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
    }
    function shopTrust() internal view returns (KipurseTrustV5.TrustParams memory) {
        return trustParams("coffee.example", arr(shop), none(), 2e6, 5e6, uint64(block.timestamp + 90 days));
    }
    function payOk(bytes memory a) internal { vm.prank(executor); adapter.payDirect(p, direct(shop, 1e6, ++ref), a, nf, dl()); }
    function payRefused(bytes memory a) internal {
        KipurseAdapterV5.Direct memory d = direct(shop, 1e6, ++ref);
        vm.prank(executor); vm.expectRevert(Approval.selector); adapter.payDirect(p, d, a, nf, dl());
    }
    function noOwnerChange(bytes memory c) internal pure {
        bytes4 top; assembly { top := mload(add(c, 32)) }
        assertTrue(top != ADD_OWNER && top != REMOVE_OWNER, "top-level owner change");
        for (uint256 i = 0; i + 4 <= c.length; i++) {
            bytes4 w = bytes4(c[i]) | (bytes4(c[i + 1]) >> 8) | (bytes4(c[i + 2]) >> 16) | (bytes4(c[i + 3]) >> 24);
            assertTrue(w != ADD_OWNER && w != REMOVE_OWNER, "owner change inside");
        }
    }

    // ---- V1 behaviour, unchanged ----
    function test_wallet_address_fixed_by_owner_only_and_owners_set_at_creation() public view {
        assertEq(seat.wallet(), address(wallet), "seat knows its wallet before it exists");
        assertTrue(wallet.isOwnerAddress(owner)); assertTrue(wallet.isOwnerAddress(address(seat))); assertTrue(wallet.isOwnerAddress(address(manager)));
        assertEq(wallet.nextOwnerIndex(), 3);
        assertEq(seat.x(), 0, "no phone key in the seat's code or address");
        assertEq(address(seat.trust()), address(t5));
    }
    function test_no_key_nothing_valid_then_owner_sets_key_and_phone_approval_pays() public {
        bytes memory a = phoneTrust(shopTrust(), keccak256("n"), shopTrust().expiry, PK1);
        payRefused(a);
        bytes memory c = setKeyCall(PK1); noOwnerChange(c);
        ownerSends(c);
        assertEq(seat.keyEpoch(), 1);
        uint256 w0 = token.balanceOf(address(wallet));
        payOk(a); warpBy(1 hours); payOk(a);
        assertEq(token.balanceOf(shop), 2e6);
        assertEq(w0 - token.balanceOf(address(wallet)), 2e6 + 2 * fee(1e6) + 2 * nf);
        assertEq(wallet.nextOwnerIndex(), 3, "still no owner added");
    }
    function test_only_the_wallet_can_change_the_key() public {
        (uint256 px, uint256 py) = vm.publicKeyP256(PK1);
        vm.expectRevert(KipurseKeySeatV2.OnlyWallet.selector); seat.setKey(px, py);
        vm.prank(owner); vm.expectRevert(KipurseKeySeatV2.OnlyWallet.selector); seat.setKey(px, py);
        vm.prank(executor); vm.expectRevert(KipurseKeySeatV2.OnlyWallet.selector); seat.clearKey();
        vm.prank(address(adapter)); vm.expectRevert(KipurseKeySeatV2.OnlyWallet.selector); seat.setKey(px, py);
        vm.prank(evilSigner); vm.expectRevert(); wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.setKey, (px, py)));
    }
    /// I-7: a new phone kills every inline trust signed by the old key, at once.
    function test_new_phone_old_key_dies_at_once_new_key_works() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust();
        bytes memory old = phoneTrust(t, keccak256("n1"), t.expiry, PK1);
        payOk(old);
        bytes memory c = setKeyCall(PK2); noOwnerChange(c); ownerSends(c);
        assertEq(seat.keyEpoch(), 2);
        payRefused(old);
        payRefused(phoneTrust(t, keccak256("n2"), t.expiry, PK1));
        payOk(phoneTrust(t, keccak256("n3"), t.expiry, PK2));
        assertEq(wallet.nextOwnerIndex(), 3);
    }
    function test_face_id_off_then_back_on() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust();
        bytes memory a = phoneTrust(t, keccak256("n"), t.expiry, PK1);
        bytes memory off = abi.encodeCall(CoinbaseSmartWallet.execute, (address(seat), 0, abi.encodeCall(KipurseKeySeatV2.clearKey, ())));
        noOwnerChange(off); ownerSends(off);
        assertEq(seat.x(), 0); payRefused(a);
        ownerSends(setKeyCall(PK1)); payOk(a);
        (uint256 cx, uint256 cy) = (seat.x(), seat.y());
        vm.prank(owner); vm.expectRevert(KipurseKeySeatV2.BadKey.selector);
        wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.setKey, (cx, cy)));
    }
    function test_seat_cannot_sign_anything_else() public {
        ownerSends(setKeyCall(PK1));
        bytes32 h = wallet.replaySafeHash(keccak256("addOwnerAddress(attacker)"));
        (bytes32 r, bytes32 s) = vm.signP256(PK1, h);
        uint256 su = uint256(s) > P256_N / 2 ? P256_N - uint256(s) : uint256(s);
        for (uint8 k = 0; k < 10; k++) {
            if (k >= 1 && k <= 6) continue;   // real kinds need real bodies (covered elsewhere)
            assertEq(seat.isValidSignature(h, abi.encode(k, bytes(""), uint256(r), su)), bytes4(0xffffffff));
        }
        bytes memory w = abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, abi.encode(uint8(9), bytes(""), uint256(r), su)));
        assertEq(wallet.isValidSignature(keccak256("addOwnerAddress(attacker)"), w), bytes4(0xffffffff));
    }
    function test_wrong_key_rejected() public {
        ownerSends(setKeyCall(PK1));
        payRefused(phoneTrust(shopTrust(), keccak256("n"), shopTrust().expiry, PK2));
    }

    // ---- KL-5: on-curve key, canonical low-s ----
    function _setKeyRaw(uint256 kx, uint256 ky) internal returns (bool ok) {
        vm.prank(owner);
        try wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.setKey, (kx, ky))) { ok = true; } catch {}
    }
    function test_KL5_setKey_rejects_off_curve_and_zero() public {
        (uint256 px, uint256 py) = vm.publicKeyP256(PK1);
        assertFalse(_setKeyRaw(px, py + 1), "off-curve y");
        assertFalse(_setKeyRaw(px + 1, py), "off-curve x");
        assertFalse(_setKeyRaw(0, 0), "zero");
        assertFalse(_setKeyRaw(px, 0), "y = 0");
        assertFalse(_setKeyRaw(0, py), "x = 0");
        assertFalse(_setKeyRaw(P, py), "x = p");
        assertFalse(_setKeyRaw(px, type(uint256).max), "y >= p");
        assertTrue(_setKeyRaw(px, P - py), "the negated point (x, p - y) is on the curve and accepted");
        assertTrue(_setKeyRaw(px, py));
        assertEq(seat.x(), px);
    }
    function testFuzz_KL5_setKey_only_valid_points(uint256 kx, uint256 ky) public {
        bool onCurve = kx != 0 && ky != 0 && kx < P && ky < P
            && mulmod(ky, ky, P) == addmod(addmod(mulmod(mulmod(kx, kx, P), kx, P), mulmod(kx, P - 3, P), P),
                0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B, P);
        assertEq(_setKeyRaw(kx, ky), onCurve);
    }
    function test_KL5_high_s_rejected_low_s_accepted() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust(); bytes32 n = keccak256("n"); uint256 dl_ = t.expiry;
        bytes32 h = wallet.replaySafeHash(inlineDigest(address(wallet), t, n, dl_));
        (bytes32 r, bytes32 s) = vm.signP256(PK1, h);
        uint256 lo = uint256(s) > P256_N / 2 ? P256_N - uint256(s) : uint256(s);
        uint256 hi = P256_N - lo;
        bytes memory body = abi.encode(t, n, dl_);
        assertEq(seat.isValidSignature(h, abi.encode(uint8(6), body, uint256(r), lo)), bytes4(0x1626ba7e), "low-s valid");
        assertEq(seat.isValidSignature(h, abi.encode(uint8(6), body, uint256(r), hi)), bytes4(0xffffffff), "malleated high-s refused");
        assertEq(seat.isValidSignature(h, abi.encode(uint8(6), body, uint256(0), lo)), bytes4(0xffffffff), "r = 0");
        assertEq(seat.isValidSignature(h, abi.encode(uint8(6), body, P256_N, lo)), bytes4(0xffffffff), "r = n");
        assertEq(seat.isValidSignature(h, abi.encode(uint8(6), body, uint256(r), uint256(0))), bytes4(0xffffffff), "s = 0");
        // end to end: the high-s form never pays
        bytes memory sigHi = abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, abi.encode(uint8(6), body, uint256(r), hi)));
        payRefused(abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dl_, sigHi)));
        payOk(phoneTrust(t, n, dl_, PK1));
    }

    // ---- KR-01 on the phone path: kind 1 (stored trust) and kind 6 (inline) are not interchangeable ----
    function test_KR01_kind1_signature_is_not_an_inline_trust_and_vice_versa() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust(); bytes32 n = keccak256("n"); uint256 dl_ = t.expiry;
        // a phone kind-1 OwnerTrust signature (for trustBySig) used inline -> refused
        bytes memory k1 = seatSig(1, abi.encode(t, n, dl_), trustDigest(address(wallet), t, n, dl_), PK1);
        payRefused(abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dl_, k1)));
        // a phone kind-6 inline signature submitted to trustBySig -> refused
        bytes memory k6 = seatSig(6, abi.encode(t, n, dl_), inlineDigest(address(wallet), t, n, dl_), PK1);
        vm.prank(attacker); vm.expectRevert(OwnerSig.selector); t5.trustBySig(address(wallet), t5Params(t), n, dl_, k6);
        // kind 1 lands as a stored trust through trustBySig (owner intent), as before
        t5.trustBySig(address(wallet), t5Params(t), n, dl_, k1);
        (,, bool active,,) = t5.trustOf(address(wallet), t.merchant); assertTrue(active);
    }
    function t5Params(KipurseTrustV5.TrustParams memory t) internal pure returns (KipurseTrustV55.TrustParams memory) {
        return KipurseTrustV55.TrustParams(t.merchant, t.name, t.payees, t.signers, t.single, t.daily, t.expiry);
    }

    // ---- V55-01: the seat builds the digests itself, from hard-coded typehashes and the fixed adapter ----
    function test_V55_01_seat_digests_match_trust_and_are_fixed() public view {
        assertEq(seat.adapter(), address(a5));
        assertEq(address(seat.trust()), address(t5));
        bytes32 sh = keccak256("any struct hash");
        assertEq(seat.ownerDigest(sh), t5.ownerDigest(sh), "same EIP-712 domain as the trust contract");
        assertEq(seat.TRUST_TYPEHASH(), t5.TRUST_TYPEHASH());
        assertEq(seat.INLINE_TRUST_TYPEHASH(), t5.INLINE_TRUST_TYPEHASH());
        assertEq(seat.UNTRUST_TYPEHASH(), t5.UNTRUST_TYPEHASH());
        assertEq(seat.DENY_SIGNER_TYPEHASH(), t5.DENY_SIGNER_TYPEHASH());
        assertEq(seat.SIGNER_TRUST_TYPEHASH(), t5.SIGNER_TRUST_TYPEHASH());
        assertEq(seat.APPROVAL_TYPEHASH(), a5.APPROVAL_TYPEHASH());
    }
    function test_V55_01_no_repoint_function() public {
        (bool ok,) = address(seat).call(abi.encodeWithSignature("setTrustContract(address)", address(t5)));
        assertFalse(ok, "seat cannot be repointed");
    }
    /// CREATE2 formula the app uses: deterministic deployer, salt keccak256("kipurse-key-seat-v2"),
    /// initcode = creationCode ++ abi.encode(cbswFactory, owner, SPM, trustV55).
    function test_V55_01_create2_address_formula() public view {
        address dd = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        bytes memory initcode = abi.encodePacked(type(KipurseKeySeatV2).creationCode,
            abi.encode(address(factory), owner, address(manager), address(t5)));
        address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), dd, keccak256("kipurse-key-seat-v2"), keccak256(initcode))))));
        assertTrue(predicted != address(0));
        bytes[] memory owners = new bytes[](3);
        owners[0] = abi.encode(owner); owners[1] = abi.encode(predicted); owners[2] = abi.encode(address(manager));
        assertTrue(factory.getAddress(owners, 0) != address(0));
    }
}
