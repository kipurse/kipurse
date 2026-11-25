// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V5Base.sol";
import "../src/KipurseErrors.sol";
import {KipurseAdapterV54} from "../src/KipurseAdapterV54.sol";
import {KipurseKeySeatV1} from "../src/KipurseKeySeatV1.sol";

/// Handbook decision 108: Face ID KEY SEAT. The wallet is created by the Coinbase factory with owners [owner, seat, SPM] in one go;
/// after that NO owner is ever added or removed. Phone set / change / off = wallet.execute(seat, 0, setKey|clearKey).
contract KipurseKeySeatV1Test is V5Base {
    uint256 constant PK1 = 0xA11CE0FF1CE; uint256 constant PK2 = 0xB0B0B0B0B; uint256 constant SEAT_IDX = 1;
    KipurseKeySeatV1 seat; address shop = address(0x5409); uint256 ref;
    bytes4 constant ADD_OWNER = 0x0f0f3f24; bytes4 constant REMOVE_OWNER = 0x89625b57; bytes4 constant EXECUTE = 0xb61d27f6;

    function setUp() public override {
        super.setUp();
        KipurseAdapterV54 a2 = new KipurseAdapterV54(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        adapter = KipurseAdapterV5(address(a2)); trustC = adapter.trust();
        // opening: the seat (no phone key in its code) and the wallet are both fixed by the owner's Base Account
        seat = new KipurseKeySeatV1{salt: keccak256("kipurse-key-seat-v1")}(address(factory), owner, address(manager), address(trustC));
        bytes[] memory owners = new bytes[](3);
        owners[0] = abi.encode(owner); owners[1] = abi.encode(address(seat)); owners[2] = abi.encode(address(manager));
        wallet = factory.createAccount(owners, 0);   // a FACTORY call, not an owner change
        token.mint(address(wallet), 100e6);
        p = grant(9, 30, pol(address(registry), TERM));
    }

    // ---- helpers ----
    function setKeyCall(uint256 pk) internal view returns (bytes memory) {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        return abi.encodeCall(CoinbaseSmartWallet.execute, (address(seat), 0, abi.encodeCall(KipurseKeySeatV1.setKey, (px, py))));
    }
    function ownerSends(bytes memory walletCall) internal { vm.prank(owner); (bool ok, bytes memory r) = address(wallet).call(walletCall); if (!ok) assembly { revert(add(r, 32), mload(r)) } }
    function phoneTrust(KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline, uint256 pk) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, wallet.replaySafeHash(trustDigest(address(wallet), t, n, dline)));
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, abi.encode(uint8(1), abi.encode(t, n, dline), uint256(r), uint256(s))));
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

    // ---- tests ----
    function test_wallet_address_fixed_by_owner_only_and_owners_set_at_creation() public view {
        assertEq(seat.wallet(), address(wallet), "seat knows its wallet before it exists");
        assertTrue(wallet.isOwnerAddress(owner)); assertTrue(wallet.isOwnerAddress(address(seat))); assertTrue(wallet.isOwnerAddress(address(manager)));
        assertEq(wallet.nextOwnerIndex(), 3);
        assertEq(seat.x(), 0, "no phone key in the seat's code or address");
    }
    function test_no_key_nothing_valid_then_owner_sets_key_and_phone_approval_pays() public {
        bytes memory a = phoneTrust(shopTrust(), keccak256("n"), shopTrust().expiry, PK1);
        payRefused(a);                                    // Face ID not set up yet
        bytes memory c = setKeyCall(PK1); noOwnerChange(c);
        ownerSends(c);                                    // owner confirms ONE normal call in the Coinbase popup
        assertEq(seat.keyEpoch(), 1);
        uint256 w0 = token.balanceOf(address(wallet));
        payOk(a); warpBy(1 hours); payOk(a);              // remembered payee: AI auto-pays within limits
        assertEq(token.balanceOf(shop), 2e6);
        assertEq(w0 - token.balanceOf(address(wallet)), 2e6 + 2 * fee(1e6) + 2 * nf);
        assertEq(wallet.nextOwnerIndex(), 3, "still no owner added");
    }
    function test_only_the_wallet_can_change_the_key() public {
        (uint256 px, uint256 py) = vm.publicKeyP256(PK1);
        vm.expectRevert(KipurseKeySeatV1.OnlyWallet.selector); seat.setKey(px, py);                       // anyone
        vm.prank(owner); vm.expectRevert(KipurseKeySeatV1.OnlyWallet.selector); seat.setKey(px, py);      // even the owner directly
        vm.prank(executor); vm.expectRevert(KipurseKeySeatV1.OnlyWallet.selector); seat.clearKey();      // the Kipurse executor
        vm.prank(address(adapter)); vm.expectRevert(KipurseKeySeatV1.OnlyWallet.selector); seat.setKey(px, py);
        vm.prank(evilSigner); vm.expectRevert(); wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV1.setKey, (px, py)));
    }
    function test_new_phone_old_key_dies_at_once_new_key_works() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust();
        bytes memory old = phoneTrust(t, keccak256("n1"), t.expiry, PK1);
        payOk(old);
        bytes memory c = setKeyCall(PK2); noOwnerChange(c); ownerSends(c);     // new phone: one confirmation, no owner change
        assertEq(seat.keyEpoch(), 2);
        payRefused(old);                                                        // old phone's approval no longer valid
        payRefused(phoneTrust(t, keccak256("n2"), t.expiry, PK1));              // old phone can't sign new ones either
        payOk(phoneTrust(t, keccak256("n3"), t.expiry, PK2));                   // new phone works
        assertEq(wallet.nextOwnerIndex(), 3);
    }
    function test_face_id_off_then_back_on() public {
        ownerSends(setKeyCall(PK1));
        KipurseTrustV5.TrustParams memory t = shopTrust();
        bytes memory a = phoneTrust(t, keccak256("n"), t.expiry, PK1);
        bytes memory off = abi.encodeCall(CoinbaseSmartWallet.execute, (address(seat), 0, abi.encodeCall(KipurseKeySeatV1.clearKey, ())));
        noOwnerChange(off); ownerSends(off);
        assertEq(seat.x(), 0); payRefused(a);
        ownerSends(setKeyCall(PK1)); payOk(a);                                  // reinstall with the same Secure Enclave key: works again
        (uint256 cx, uint256 cy) = (seat.x(), seat.y());
        vm.prank(owner); vm.expectRevert(KipurseKeySeatV1.BadKey.selector);    // setting the same key twice is refused (no silent no-op)
        wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV1.setKey, (cx, cy)));
    }
    function test_seat_cannot_sign_anything_else() public {
        ownerSends(setKeyCall(PK1));
        // an arbitrary hash (UserOp, permit, owner change) has no Kipurse preimage -> invalid even with a good P-256 signature
        bytes32 h = wallet.replaySafeHash(keccak256("addOwnerAddress(attacker)"));
        (bytes32 r, bytes32 s) = vm.signP256(PK1, h);
        for (uint8 k = 0; k < 8; k++) {
            bytes memory data = abi.encode(k, bytes(""), uint256(r), uint256(s));
            if (k == 1 || k == 2 || k == 3 || k == 4 || k == 5) continue;   // real kinds need real bodies (covered elsewhere)
            assertEq(seat.isValidSignature(h, data), bytes4(0xffffffff));
        }
        bytes memory w = abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, abi.encode(uint8(9), bytes(""), uint256(r), uint256(s))));
        assertEq(wallet.isValidSignature(keccak256("addOwnerAddress(attacker)"), w), bytes4(0xffffffff));
    }
    function test_wrong_key_rejected() public {
        ownerSends(setKeyCall(PK1));
        payRefused(phoneTrust(shopTrust(), keccak256("n"), shopTrust().expiry, PK2));
    }
}
