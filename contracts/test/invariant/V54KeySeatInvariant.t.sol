// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../V5Base.sol";
import "../../src/KipurseErrors.sol";
import {KipurseAdapterV54} from "../../src/KipurseAdapterV54.sol";
import {KipurseTrustV54} from "../../src/KipurseTrustV54.sol";
import {KipurseKeySeatV1} from "../../src/KipurseKeySeatV1.sol";

/// Stateful handler for the LIVE Face ID key seat (KipurseKeySeatV1, handbook §6#108) on a V5.4 wallet created with owners
/// [owner, seat, SPM] (t1214 §6#118). Random key changes (only via the wallet), clears, stranger attempts, and P-256
/// signatures by current / old / never-set keys over the five Kipurse kinds, mutated hashes, other kinds and arbitrary
/// hashes, checked both directly on the seat and end-to-end through the wallet's ERC-1271 and a real V5.4 payment.
/// I-6 (only the five kinds, only this wallet / domain), I-7 (setKey / clearKey kill old signatures at once).
contract V54KeySeatHandler is V5Base {
    KipurseAdapterV54 public a4; KipurseTrustV54 public t4; KipurseKeySeatV1 public seat;
    uint256 constant SEAT_IDX = 1;
    uint256[4] PKS = [uint256(0), 0xA11CE0FF1CE, 0xB0B0B0B0B, 0xC0FFEE1234];
    address constant SHOP = address(0x5409);
    bytes4 constant MAGIC = 0x1626ba7e;

    uint256 public cur; uint64 public modelEpoch;
    uint256 public violations; string public firstViolation;
    uint256 public okValid; uint256 public okPays; uint256 ref_;

    function init() external { setUp(); }
    function setUp() public override {
        super.setUp();
        a4 = new KipurseAdapterV54(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        adapter = KipurseAdapterV5(address(a4)); trustC = adapter.trust(); t4 = KipurseTrustV54(address(trustC));
        seat = new KipurseKeySeatV1{salt: keccak256("kipurse-key-seat-v1")}(address(factory), owner, address(manager), address(trustC));
        bytes[] memory owners = new bytes[](3);
        owners[0] = abi.encode(owner); owners[1] = abi.encode(address(seat)); owners[2] = abi.encode(address(manager));
        wallet = factory.createAccount(owners, 0);
        token.mint(address(wallet), 100e6);
        p = grant(9, 30, pol(address(registry), TERM));
    }
    function _bad(string memory why) internal { if (violations == 0) firstViolation = why; violations++; }

    // ---------------- key management ----------------
    function setKey(uint8 i) external {
        i = uint8(1 + i % 3);
        (uint256 px, uint256 py) = vm.publicKeyP256(PKS[i]);
        vm.prank(owner);
        try wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV1.setKey, (px, py))) {
            if (i == cur) _bad("same key set twice (silent no-op)");
            cur = i; modelEpoch++;
        } catch { if (i != cur) _bad("owner could not set a new key"); }
    }
    function clearKey() external {
        vm.prank(owner);
        try wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV1.clearKey, ())) { cur = 0; modelEpoch++; }
        catch { _bad("owner could not clear the key"); }
    }
    function strangerSetKey(uint8 i, uint8 who) external {
        (uint256 px, uint256 py) = vm.publicKeyP256(PKS[1 + i % 3]);
        address[5] memory ws = [attacker, owner, executor, address(a4), address(manager)];
        address c = ws[who % 5];
        vm.prank(c); try seat.setKey(px, py) { _bad("non-wallet set the key"); } catch {}
        vm.prank(c); try seat.clearKey() { _bad("non-wallet cleared the key"); } catch {}
        vm.prank(attacker);
        try wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV1.setKey, (px, py))) { _bad("non-owner drove the wallet"); } catch {}
    }

    // ---------------- signatures (I-6 / I-7) ----------------
    function _sh(uint256 kind, address acct, uint256 x, bool badPay) internal view returns (bytes memory body, bytes32 sh) {
        bytes32 n = bytes32(x); uint256 dline = vm.getBlockTimestamp() + 1 days;
        if (kind == 1) {
            KipurseTrustV5.TrustParams memory t = trustParams("shop.example", arr(SHOP), none(), 1e6, 2e6, 0);
            body = abi.encode(t, n, dline);
            (uint64 ep,,,,) = t4.trustOf(address(wallet), t.merchant);
            sh = keccak256(abi.encode(t4.TRUST_TYPEHASH(), acct, t.merchant, keccak256(bytes(t.name)), ep,
                keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, n, dline));
        } else if (kind == 2) {
            bytes32 m = keccak256("shop.example");
            body = abi.encode(m, n, dline); sh = keccak256(abi.encode(t4.UNTRUST_TYPEHASH(), acct, m, n, dline));
        } else if (kind == 3) {
            body = abi.encode(evilSigner, n, dline); sh = keccak256(abi.encode(t4.DENY_SIGNER_TYPEHASH(), acct, evilSigner, n, dline));
        } else if (kind == 4) {
            bytes32 key = keccak256(abi.encode("purchase", x)); address payee = SHOP; uint256 amount = 1e6; uint256 dl_ = dline;
            if (badPay) {
                uint256 b = x % 5;
                if (b == 0) key = bytes32(0); else if (b == 1) payee = address(0); else if (b == 2) payee = address(wallet);
                else if (b == 3) amount = 0; else dl_ = vm.getBlockTimestamp();
            }
            body = abi.encode(key, payee, amount, dl_);
            sh = keccak256(abi.encode(seat.APPROVAL_TYPEHASH(), acct, key, payee, amount, dl_));
        } else if (kind == 5) {
            KipurseTrustV54.SignerTrust memory t = KipurseTrustV54.SignerTrust(keccak256("deposits.example"), "deposits.example",
                arr(bidSigner), 1e6, 2e6, uint64(vm.getBlockTimestamp() + 90 days));
            body = abi.encode(t, n, dline);
            (uint64 ep,,,,) = t4.trustOf(address(wallet), t.merchant);
            sh = keccak256(abi.encode(t4.SIGNER_TRUST_TYPEHASH(), acct, t.merchant, keccak256(bytes(t.name)), ep,
                keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, n, dline));
        } else {
            body = ""; sh = keccak256(abi.encode("not a kipurse kind", x));
        }
    }
    /// mutate 0: honest; 1: signature over a different digest; 2: struct hash for ANOTHER wallet; 3: arbitrary hash (e.g. a
    /// UserOp / permit / owner change) signed directly by the key.
    function sign(uint8 kindSeed, uint8 keySel, uint8 mutate, uint256 x, bool badPay) external {
        uint256 kind = kindSeed % 8; mutate %= 4; uint256 k = 1 + keySel % 3;
        (bytes memory body, bytes32 sh) = _sh(kind, mutate == 2 ? attacker : address(wallet), x, badPay && kind == 4);
        bytes32 inner = mutate == 3 ? keccak256(abi.encode("arbitrary", x)) : t4.ownerDigest(sh);
        bytes32 h = wallet.replaySafeHash(inner);
        (bytes32 r, bytes32 s) = vm.signP256(PKS[k], mutate == 1 ? keccak256(abi.encode(h)) : h);
        bytes memory data = abi.encode(uint8(kind), body, uint256(r), uint256(s));
        bool expect = cur != 0 && k == cur && kind >= 1 && kind <= 5 && mutate == 0 && !(badPay && kind == 4);
        bytes4 r1 = bytes4(0xffffffff);
        try seat.isValidSignature(h, data) returns (bytes4 v) { r1 = v; } catch {}
        bytes4 r2 = bytes4(0xffffffff);
        try wallet.isValidSignature(inner, abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, data))) returns (bytes4 v) { r2 = v; } catch {}
        if ((r1 == MAGIC) != expect) _bad(expect ? "seat refused a valid current-key Kipurse signature" : "seat accepted an invalid signature");
        if ((r2 == MAGIC) != expect) _bad(expect ? "wallet refused a valid seat signature" : "wallet accepted an invalid seat signature");
        if (r1 == MAGIC) okValid++;
    }
    /// End to end: a kind-4 (pay once) phone approval pays a stranger above the stranger tier iff it is signed by the CURRENT key.
    function payWithPhone(uint8 keySel, uint256 a) external {
        uint256 k = 1 + keySel % 3; a = bound(a, OPEN_SINGLE + 1, 2e6);
        KipurseAdapterV5.Direct memory d = direct(SHOP, a, ++ref_ + 1_000_000);
        bytes32 key = a4.purchaseKey(SHOP, d.merchantRef, d.repeatKey);
        bytes32 h = wallet.replaySafeHash(a4.approvalDigest(address(wallet), key, SHOP, a, d.deadline));
        (bytes32 r, bytes32 s) = vm.signP256(PKS[k], h);
        bytes memory ap = abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX,
            abi.encode(uint8(4), abi.encode(key, SHOP, a, d.deadline), uint256(r), uint256(s))));
        vm.prank(executor);
        try adapter.payDirect(p, d, ap, 0, dl()) {
            okPays++;
            if (k != cur) _bad("payment approved by a stale / unset phone key");
        } catch {}
    }
    function pass(uint256 s) external { warpBy(bound(s, 1, 6 hours)); }

    // views
    function keyOf(uint256 i) external view returns (uint256 x, uint256 y) { if (i != 0) (x, y) = vm.publicKeyP256(PKS[i]); }
    function walletAddr() external view returns (address) { return address(wallet); }
    function ownerAddr() external view returns (address) { return owner; }
    function managerAddr() external view returns (address) { return address(manager); }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 32
/// forge-config: default.invariant.fail-on-revert = false
contract V54KeySeatInvariantTest is Test {
    V54KeySeatHandler h; KipurseKeySeatV1 seat; CoinbaseSmartWallet w;
    function setUp() public {
        h = new V54KeySeatHandler(); h.init();
        seat = h.seat(); w = CoinbaseSmartWallet(payable(h.walletAddr()));
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](8);
        s[0] = h.setKey.selector; s[1] = h.clearKey.selector; s[2] = h.strangerSetKey.selector; s[3] = h.sign.selector;
        s[4] = h.sign.selector; s[5] = h.payWithPhone.selector; s[6] = h.pass.selector; s[7] = h.sign.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }
    function invariant_noHandlerViolation() public view { assertEq(h.violations(), 0, h.firstViolation()); }
    /// I-7: the seat key is exactly the last key the wallet set (or none after clearKey); keyEpoch counts every change.
    function invariant_keyFollowsWallet() public view {
        (uint256 x, uint256 y) = h.keyOf(h.cur());
        assertEq(seat.x(), x); assertEq(seat.y(), y); assertEq(seat.keyEpoch(), h.modelEpoch());
    }
    /// The owner set never changes: no owner is ever added or removed (the whole point of the seat).
    function invariant_ownersFixed() public view {
        assertEq(w.nextOwnerIndex(), 3); assertEq(w.removedOwnersCount(), 0);
        assertTrue(w.isOwnerAddress(h.ownerAddr())); assertTrue(w.isOwnerAddress(address(seat))); assertTrue(w.isOwnerAddress(h.managerAddr()));
        assertEq(seat.wallet(), address(w));
    }
    function test_keySeatHandlerSmoke() public {
        h.sign(1, 0, 0, 1, false);                      // no key: invalid
        h.setKey(0); h.setKey(0);                       // key 1, then same key refused
        for (uint8 k = 1; k <= 5; k++) h.sign(k, 0, 0, k, false);   // all five kinds valid with the current key
        h.sign(4, 0, 0, 7, true);                       // malformed pay body
        h.sign(1, 1, 0, 1, false); h.sign(1, 0, 1, 1, false); h.sign(1, 0, 2, 1, false); h.sign(1, 0, 3, 1, false);
        h.sign(0, 0, 0, 1, false); h.sign(6, 0, 0, 1, false); h.sign(7, 0, 0, 1, false);
        h.payWithPhone(0, 5e5); h.payWithPhone(1, 5e5);
        h.setKey(1); h.payWithPhone(0, 5e5); h.payWithPhone(1, 5e5);  // new phone: old key dies at once
        h.strangerSetKey(0, 0); h.strangerSetKey(0, 1); h.strangerSetKey(0, 2); h.strangerSetKey(0, 3);
        h.clearKey(); h.sign(2, 1, 0, 9, false); h.payWithPhone(1, 5e5);
        assertEq(h.violations(), 0, h.firstViolation());
        assertEq(h.okValid(), 5); assertEq(h.okPays(), 2);
        invariant_keyFollowsWallet(); invariant_ownersFixed();
    }
    /// I-6: for any hash that is not a Kipurse digest, a perfectly valid P-256 signature by the current key over it is
    /// never accepted, whatever kind tag is claimed (malformed bodies may revert, which ERC-1271 callers treat as invalid).
    function testFuzz_seatNeverSignsArbitraryHash(bytes32 inner, uint8 kind, bytes calldata body) public {
        h.setKey(0);
        bytes32 hh = w.replaySafeHash(inner);
        (bytes32 r, bytes32 s) = vm.signP256(0xA11CE0FF1CE, hh);
        try seat.isValidSignature(hh, abi.encode(kind, body, uint256(r), uint256(s))) returns (bytes4 v) {
            assertEq(v, bytes4(0xffffffff));
        } catch {}
    }
}
