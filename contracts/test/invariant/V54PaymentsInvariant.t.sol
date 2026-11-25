// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V54Base.t.sol";

/// Stateful handler for the LIVE V5.4 adapter (t1214 decision 118). Every money path the executor has: payDirect (stored trust,
/// registry, stranger, one-time owner approval, KPTR inline payee trust), paySigned (V5.2 payee binding), paySignedTrusted
/// (V5.4 inline signer grant, per-order payees), x402 prepareAuthorization / settle / markSettled / reclaim / cancel,
/// the M3 float (fund / session-key spend / reconcile), plus owner controls (pause, deny, deny signer, untrust, re-trust),
/// executor / guardian pause, fee lowering, fee collection, refunds, sweeps, replays and forged / tampered inputs.
/// The handler checks each successful call against an independent model and counts violations (an assert inside a
/// handler would be swallowed with fail_on_revert = false); the invariant contract asserts violations == 0.
contract V54PayHandler is V54Base {
    error ExitResult(bool ok, string why);

    uint256 public violations; string public firstViolation;
    uint256 public okDirect; uint256 public okApproved; uint256 public okInline; uint256 public okSigned; uint256 public okTrusted;
    uint256 public okX402; uint256 public okSettle; uint256 public okRelease; uint256 public okFloat; uint256 public okFloatSpend;
    uint256 ops;
    uint256 public refundsLeftInVault; uint256 public floatToAttacker;

    // independent model of the adapter's cap accounting (amount + fee + networkFee, minus x402 releases of value + fee)
    uint256 public ghostTerm; uint256 public ghostPulled; uint256 public ghostFeeBound; uint256 public collected;
    mapping(uint256 => uint256) public ghostDay; uint256 public maxDay;
    uint256 public lastPpm;
    address[8] public fresh;

    // replay material
    KipurseAdapterV54.Direct lastDirect; bytes lastDirectAppr; bool hasDirect;
    KipurseAdapterV54.PaymentOrder lastOrder; bytes lastOrderSig; bool hasOrder;
    KipurseAdapterV54.PaymentOrder lastTOrder; bytes lastTSig; bytes lastTGrant; bool hasT;
    bytes staleInline; uint64 staleInlineEpoch; bytes staleGrant; uint64 staleGrantEpoch;

    struct Res { bytes32 digest; bytes32 nonce; KipurseAdapterV54.Auth a; uint256 fee; uint256 day; bytes appr; }
    Res[] public resList;

    struct Snap { uint256 w; uint256 pe; uint256 acc; uint256 pend; uint256 v; uint256 fv; bool paused; bool denied; uint256 ppm; uint256 day; }

    function init() external {
        setUp();
        for (uint256 i; i < 8; i++) fresh[i] = address(uint160(uint256(keccak256(abi.encode("deposit", i)))));
        ownerExec(address(t4), abi.encodeCall(t4.setFloatCap, (uint160(5e5))));
        a4.registerPermission(p); // vault deployed, session signer = executor, maxGasPerOp = MAX_NF
        staleInline = inlineBlob(ownerKey, inlineParams(), bytes32("stale"), vm.getBlockTimestamp() + 170 days);
        (staleInlineEpoch,,,,) = t4.trustOf(address(wallet), IM);
        staleGrant = grantBlob(ownerKey, grantParams(arr(shopSigner), GS, GD), bytes32("stale"), vm.getBlockTimestamp() + 170 days);
        (staleGrantEpoch,,,,) = t4.trustOf(address(wallet), GM);
        lastPpm = feeCtl.feePpm();
    }

    // ---------------- model helpers ----------------
    function _bad(string memory mode, string memory why) internal {
        if (violations == 0) firstViolation = string.concat(mode, ": ", why);
        violations++;
    }
    function _sub(uint256 a, uint256 b) internal pure returns (uint256) { return a >= b ? a - b : type(uint256).max; }
    function _nf(uint256 seed) internal pure returns (uint256) { return seed % (MAX_NF + MAX_NF / 4 + 1); }
    function _snap(address payee) internal view returns (Snap memory s) {
        s.w = token.balanceOf(address(wallet)); s.pe = token.balanceOf(payee); s.acc = a4.accruedFees(); s.pend = a4.pendingFees();
        s.v = token.balanceOf(vaultV()); s.fv = token.balanceOf(floatV());
        s.paused = t4.isPaused(address(wallet)); s.denied = t4.deniedPayee(address(wallet), payee);
        s.ppm = feeCtl.feePpm(); s.day = today();
    }
    function _account(uint256 day, uint256 charge, uint256 amount) internal {
        ghostTerm += charge; ghostDay[day] += charge; ghostPulled += charge; ghostFeeBound += feeAt(amount, 3000);
        if (day > maxDay) maxDay = day;
    }
    function _common(Snap memory s, uint256 amount, uint256 nfee, uint256 cap, string memory mode) internal returns (uint256 f) {
        f = feeAt(amount, s.ppm);
        if (s.paused) _bad(mode, "paid while the wallet is paused");
        if (s.denied) _bad(mode, "paid an owner-denied payee");
        if (nfee > MAX_NF) _bad(mode, "network fee above Policy.maxNetworkFee");
        if (amount > cap || amount > SINGLE) _bad(mode, "amount above the tier / policy single cap");
        if (s.ppm > FEE_PPM || f > feeAt(amount, 3000)) _bad(mode, "fee above maxFeePpm / MAX_FEE_PPM");
        if (_sub(s.w, token.balanceOf(address(wallet))) != amount + f + nfee) _bad(mode, "payer debit != amount + fee + networkFee");
        _account(s.day, amount + f + nfee, amount);
    }
    /// direct / signed / signed-trusted: payee +amount, accrued +fee, vault +networkFee (conservation).
    function _checkNow(Snap memory s, address payee, uint256 amount, uint256 nfee, uint256 cap, string memory mode) internal {
        uint256 f = _common(s, amount, nfee, cap, mode);
        if (_sub(token.balanceOf(payee), s.pe) != amount) _bad(mode, "merchant credit != amount");
        if (_sub(a4.accruedFees(), s.acc) != f) _bad(mode, "accrued fee != protocol fee");
        if (_sub(token.balanceOf(vaultV()), s.v) != nfee) _bad(mode, "vault top-up != networkFee");
    }
    function _directCap(address payee) internal view returns (uint256) {
        (bytes32 m, uint160 s,) = t4.payeeTrust(address(wallet), payee);
        if (m != bytes32(0)) return s < SINGLE ? s : SINGLE;
        (bytes32 rm, uint160 rs,) = registry.lookupPayee(payee);
        if (rm != bytes32(0)) return rs < VER_SINGLE ? rs : VER_SINGLE;
        return OPEN_SINGLE;
    }
    function _resOpen(bytes32 d) internal view returns (bool open) { (,,,, open,,,,,,) = a4.reservations(d); }

    // ---------------- payDirect ----------------
    function payDirect(uint256 a, uint8 who, uint256 nfSeed) external {
        address[4] memory ps = [bidPayee, regPayee, stranger, attacker];
        address payee = ps[who % 4];
        a = who % 4 >= 2 ? bound(a, 1, 2 * OPEN_SINGLE) : bound(a, 1, SINGLE);
        uint256 nfee = _nf(nfSeed);
        KipurseAdapterV54.Direct memory d = dirV(payee, a, ++ops);
        uint256 cap = _directCap(payee);
        Snap memory s = _snap(payee);
        vm.prank(executor);
        try a4.payDirect(p, d, "", nfee, dl()) {
            okDirect++; _checkNow(s, payee, a, nfee, cap, "payDirect");
            lastDirect = d; lastDirectAppr = ""; hasDirect = true;
        } catch {}
    }
    /// variant 0: owner approval; 1: approval signed by a non-owner key; 2: approval for a different amount.
    function payApproved(uint256 a, uint8 variant, uint256 nfSeed) external {
        variant %= 3; a = bound(a, 1, SINGLE);
        uint256 nfee = _nf(nfSeed);
        KipurseAdapterV54.Direct memory d = dirV(stranger, a, ++ops);
        bytes32 key = a4.purchaseKey(stranger, d.merchantRef, d.repeatKey);
        bytes memory ap = approvalBy(variant == 1 ? K_ATTACKER : ownerKey, key, stranger, variant == 2 ? a + 1 : a, d.deadline);
        Snap memory s = _snap(stranger);
        vm.prank(executor);
        try a4.payDirect(p, d, ap, nfee, dl()) {
            if (variant != 0) _bad("payApproved", "forged / tampered owner approval accepted");
            okApproved++; _checkNow(s, stranger, a, nfee, SINGLE, "payApproved");
            lastDirect = d; lastDirectAppr = ap; hasDirect = true;
        } catch {}
    }
    /// KPTR inline payee trust. 0 fresh owner blob; 1 non-owner key; 2 blob used for a payee it does not list; 3 blob
    /// signed at setup (dead once the owner untrusted IM).
    function payInline(uint256 a, uint8 variant, uint256 nfSeed) external {
        variant %= 4; a = bound(a, 1, IS + 1e6);
        uint256 nfee = _nf(nfSeed);
        address payee = variant == 2 ? stranger : INLINE_PAYEE;
        bytes memory blob = variant == 3 ? staleInline
            : inlineBlob(variant == 1 ? K_ATTACKER : ownerKey, inlineParams(), bytes32(ops + 1), vm.getBlockTimestamp() + 1 days);
        KipurseAdapterV54.Direct memory d = dirV(payee, a, ++ops);
        Snap memory s = _snap(payee);
        (uint64 ep,,,,) = t4.trustOf(address(wallet), IM);
        vm.prank(executor);
        try a4.payDirect(p, d, blob, nfee, dl()) {
            if (variant == 1 || variant == 2) _bad("payInline", "forged / unbound inline trust accepted");
            if (variant == 3 && ep != staleInlineEpoch) _bad("payInline", "inline trust survived the owner's untrust (epoch)");
            okInline++; _checkNow(s, payee, a, nfee, IS, "payInline");
        } catch {}
    }

    // ---------------- paySigned (V5.2 payee binding) ----------------
    /// 0 bound signer -> bound payee; 1 bound signer -> attacker; 2 registry signer -> its payee; 3 rogue signer;
    /// 4 order bound to another payer wallet.
    function paySigned(uint256 a, uint8 variant, uint256 nfSeed) external {
        variant %= 5; a = bound(a, 1, SINGLE);
        uint256 nfee = _nf(nfSeed);
        uint256 k = variant == 2 ? kReg : variant == 3 ? kEvil : kBid;
        address payee = variant == 1 || variant == 3 ? attacker : variant == 2 ? regPayee : bidPayee;
        KipurseAdapterV54.PaymentOrder memory o = ordV(payee, a, ++ops, variant == 4 ? address(0xD00D) : address(0));
        bytes memory sig = signOrdV(k, o);
        Snap memory s = _snap(payee);
        bool deniedSigner = t4.deniedSigner(address(wallet), vm.addr(k));
        vm.prank(executor);
        try a4.paySigned(p, o, sig, nfee, dl()) {
            if (variant == 1 || variant == 3 || variant == 4) _bad("paySigned", "unbound payee / rogue signer / foreign order paid");
            if (deniedSigner) _bad("paySigned", "owner-denied signer paid");
            okSigned++; _checkNow(s, payee, a, nfee, variant == 2 ? VER_SINGLE : SINGLE, "paySigned");
            lastOrder = o; lastOrderSig = sig; hasOrder = true;
        } catch {}
    }

    // ---------------- paySignedTrusted (V5.4) ----------------
    /// 0 fresh owner grant; 1 order payer = 0 (I-12); 2 order signed by a signer the grant does not list; 3 grant signed by a
    /// non-owner key; 4 grant signed at setup (dead after untrust(GM)); 5 grant listing only the rogue signer; 6 grant
    /// whose single (10 USDC) exceeds the policy single (must still be capped by Policy.single).
    function payTrusted(uint256 a, uint8 payeeSeed, uint8 variant, uint256 nfSeed) external {
        variant %= 7;
        a = bound(a, 1, variant == 6 ? SINGLE + 1e6 : GS + 1e6);
        uint256 nfee = _nf(nfSeed);
        address payee = fresh[payeeSeed % 8];
        uint256 n = ++ops;
        bytes memory g;
        if (variant == 4) g = staleGrant;
        else if (variant == 5) g = grantBlob(ownerKey, grantParams(arr(evilSigner), GS, GD), bytes32(n), vm.getBlockTimestamp() + 1 days);
        else if (variant == 6) g = grantBlob(ownerKey, grantParams(arr(shopSigner), 10e6, 10e6), bytes32(n), vm.getBlockTimestamp() + 1 days);
        else g = grantBlob(variant == 3 ? K_ATTACKER : ownerKey, grantParams(arr(shopSigner), GS, GD), bytes32(n), vm.getBlockTimestamp() + 1 days);
        KipurseAdapterV54.PaymentOrder memory o = ordV(payee, a, n, variant == 1 ? address(0) : address(wallet));
        bytes memory sig = signOrdV(variant == 2 ? kEvil : K_SHOP, o);
        Snap memory s = _snap(payee);
        bool deniedSigner = t4.deniedSigner(address(wallet), shopSigner);
        (uint64 ep,,,,) = t4.trustOf(address(wallet), GM);
        vm.prank(executor);
        try a4.paySignedTrusted(p, o, sig, g, nfee, dl()) {
            if (variant == 1) _bad("payTrusted", "signer-grant order without payer == wallet paid (I-12)");
            if (variant == 2 || variant == 3 || variant == 5) _bad("payTrusted", "unlisted signer / forged grant paid");
            if (variant == 4 && ep != staleGrantEpoch) _bad("payTrusted", "signer grant survived untrust (epoch)");
            if (deniedSigner) _bad("payTrusted", "owner-denied signer paid");
            okTrusted++; _checkNow(s, payee, a, nfee, variant == 6 ? SINGLE : GS, "payTrusted");
            if (a4.merchantDaySpent(phV(), GM, s.day) > (variant == 6 ? 10e6 : GD)) _bad("payTrusted", "grant daily cap exceeded");
            lastTOrder = o; lastTSig = sig; lastTGrant = g; hasT = true;
        } catch {}
    }

    // ---------------- replays (I-5) ----------------
    /// 0 last direct (incl. its owner approval); 1 last signed order; 2 last signer-grant order; 3 last signer-grant order
    /// through paySigned (cross-path); 4 last signed order through paySignedTrusted with a fresh grant.
    function replay(uint8 kind) external {
        kind %= 5;
        bytes memory g = grantBlob(ownerKey, grantParams(arr(shopSigner), GS, GD), bytes32(++ops), vm.getBlockTimestamp() + 1 days);
        if (kind == 0 && hasDirect) {
            vm.prank(executor);
            try a4.payDirect(p, lastDirect, lastDirectAppr, 0, dl()) { _bad("replay", "direct purchase paid twice"); } catch {}
        } else if (kind == 1 && hasOrder) {
            vm.prank(executor);
            try a4.paySigned(p, lastOrder, lastOrderSig, 0, dl()) { _bad("replay", "signed order paid twice"); } catch {}
        } else if (kind == 2 && hasT) {
            vm.prank(executor);
            try a4.paySignedTrusted(p, lastTOrder, lastTSig, lastTGrant, 0, dl()) { _bad("replay", "signer-grant order paid twice"); } catch {}
        } else if (kind == 3 && hasT) {
            vm.prank(executor);
            try a4.paySigned(p, lastTOrder, lastTSig, 0, dl()) { _bad("replay", "signer-grant order paid again via paySigned"); } catch {}
        } else if (kind == 4 && hasT) {
            vm.prank(executor);
            try a4.paySignedTrusted(p, lastTOrder, lastTSig, g, 0, dl()) { _bad("replay", "order paid twice with a fresh grant"); } catch {}
        }
    }

    // ---------------- x402 ----------------
    /// variant 0: tier routing; 1: owner approval (stranger); 2: approval signed by a non-owner key.
    function x402(uint256 a, uint8 who, uint8 variant, uint256 nfSeed) external {
        variant %= 3;
        address[3] memory ps = [bidPayee, regPayee, stranger];
        address to = variant == 0 ? ps[who % 3] : stranger;
        a = to == stranger && variant == 0 ? bound(a, 1, 2 * OPEN_SINGLE) : bound(a, 1, SINGLE);
        uint256 nfee = _nf(nfSeed);
        KipurseAdapterV54.Auth memory au = authV(to, a, ++ops);
        bytes32 key = a4.purchaseKey(to, au.merchantRef, au.repeatKey);
        bytes memory ap = variant == 0 ? bytes("") : approvalBy(variant == 2 ? K_ATTACKER : ownerKey, key, to, a, au.validBefore);
        uint256 cap = variant == 0 ? _directCap(to) : SINGLE;
        Snap memory s = _snap(to);
        uint256 r0 = PayerVaultV5(vaultV()).reserved();
        vm.prank(executor);
        try a4.prepareAuthorization(p, au, ap, nfee, dl()) returns (address v, bytes32 dg, bytes32 nonce) {
            if (variant == 2) _bad("x402", "forged owner approval accepted");
            okX402++;
            uint256 f = _common(s, a, nfee, cap, "x402");
            if (v != vaultV() || nonce != key) _bad("x402", "wrong vault / nonce");
            if (_sub(token.balanceOf(v), s.v) != a + nfee) _bad("x402", "vault credit != value + networkFee");
            if (_sub(a4.pendingFees(), s.pend) != f) _bad("x402", "pending fee != protocol fee");
            if (PayerVaultV5(v).reserved() - r0 != a) _bad("x402", "vault reserved != value");
            resList.push(Res(dg, nonce, au, f, s.day, ap));
        } catch {}
    }
    function settle(uint256 i) external {
        if (resList.length == 0) return;
        Res memory r = resList[i % resList.length];
        bool open = _resOpen(r.digest);
        uint256 b0 = token.balanceOf(r.a.to);
        address v = vaultV();
        vm.prank(facilitator);
        try token.transferWithAuthorization(v, r.a.to, r.a.value, r.a.validAfter, r.a.validBefore, r.nonce, hex"00") {
            if (!open) _bad("settle", "vault ERC-1271 approved a closed reservation (I-13)");
            if (token.balanceOf(r.a.to) - b0 != r.a.value) _bad("settle", "facilitator moved != value");
            okSettle++;
        } catch {}
    }
    function markAll() external {
        bytes32[] memory ds = new bytes32[](resList.length);
        for (uint256 i; i < ds.length; i++) ds[i] = resList[i].digest;
        try a4.markSettled(ds) {} catch { _bad("markSettled", "batch reverted"); }
    }
    function _release(uint256 i, bool byOwner) internal {
        if (resList.length == 0) return;
        Res memory r = resList[i % resList.length];
        uint256 w0 = token.balanceOf(address(wallet)); uint256 v0 = token.balanceOf(vaultV());
        bool ok;
        if (byOwner) {
            vm.prank(owner);
            try wallet.execute(address(a4), 0, abi.encodeCall(a4.cancelReservation, (r.digest))) { ok = true; } catch {}
        } else {
            try a4.reclaim(r.digest) { ok = true; } catch {}
        }
        if (!ok) return;
        okRelease++;
        ghostTerm -= r.a.value + r.fee; ghostDay[r.day] -= r.a.value + r.fee;
        uint256 wGain = _sub(token.balanceOf(address(wallet)), w0);
        // owner side (wallet + vault) gains exactly the protocol fee; the value moves vault -> wallet ...
        if (_sub(token.balanceOf(address(wallet)) + token.balanceOf(vaultV()), w0 + v0) != r.fee) _bad("release", "owner side != +fee");
        // ... unless the vault's `reserved` still counts another reservation that was settled but not yet marked: then
        // vault.pay hits Reserved() inside the K-1 try/catch and the value silently stays in the vault (see V54Findings).
        if (wGain == r.fee) refundsLeftInVault++;
        else if (wGain != r.a.value + r.fee) _bad("release", "refund != value + protocol fee");
    }
    function reclaimOne(uint256 i) external { _release(i, false); }
    function cancelOne(uint256 i) external { _release(i, true); }
    function cancelByStranger(uint256 i) external {
        if (resList.length == 0) return;
        vm.prank(attacker);
        try a4.cancelReservation(resList[i % resList.length].digest) { _bad("cancel", "non-owner cancelled a reservation"); } catch {}
    }
    /// One owner approval = one x402 reservation, even after it was cancelled / reclaimed (t1181).
    function replayApproval(uint256 i) external {
        if (resList.length == 0) return;
        Res memory r = resList[i % resList.length];
        if (r.appr.length == 0 || _resOpen(r.digest)) return;
        vm.prank(executor);
        try a4.prepareAuthorization(p, r.a, r.appr, 0, dl()) { _bad("replayApproval", "x402 owner approval used twice"); } catch {}
    }

    // ---------------- M3 float ----------------
    function fundFloat(uint256 a, uint256 nfSeed) external {
        a = bound(a, 1, 3e5);
        uint256 nfee = _nf(nfSeed);
        uint64 exp = uint64(vm.getBlockTimestamp() + 6 hours);
        Snap memory s = _snap(floatV());
        vm.prank(executor);
        try a4.fundFloat(p, vm.addr(K_FLOAT_SESSION), a, exp, nfee, dl()) {
            okFloat++;
            uint256 f = _common(s, a, nfee, SINGLE, "fundFloat");
            if (_sub(token.balanceOf(floatV()), s.fv) != a) _bad("fundFloat", "float credit != amount");
            if (_sub(token.balanceOf(vaultV()), s.v) != nfee) _bad("fundFloat", "vault top-up != networkFee");
            if (_sub(a4.pendingFees(), s.pend) != f) _bad("fundFloat", "fee reserve != fee");
            if (a4.floatDaySpent(phV(), s.day) > t4.floatCap(address(wallet))) _bad("fundFloat", "float above owner float cap");
        } catch {}
    }
    /// variant 0: session key to FLOAT_PAYEE; 1: session key to attacker; 2: a non-session key.
    function floatSpend(uint256 v, uint8 variant) external {
        variant %= 3;
        address fv = floatV(); if (fv.code.length == 0) return;
        address to = variant == 1 ? attacker : FLOAT_PAYEE;
        v = bound(v, 1, OPEN_SINGLE + 1e4);
        uint256 va = vm.getBlockTimestamp() - 1; uint256 vb = vm.getBlockTimestamp() + 60;
        bytes32 n = bytes32(++ops);
        bytes memory sig = voucher(variant == 2 ? K_ATTACKER : K_FLOAT_SESSION, fv, to, v, va, vb, n);
        bool paused = t4.isPaused(address(wallet)); bool denied = t4.deniedPayee(address(wallet), to);
        (,,, uint64 exp, bool open) = a4.floats(address(wallet));
        vm.prank(facilitator);
        try token.transferWithAuthorization(fv, to, v, va, vb, n, sig) {
            okFloatSpend++;
            if (variant == 2) _bad("floatSpend", "non-session key spent the float");
            if (paused || denied) _bad("floatSpend", "float paid while paused / to a denied payee");
            if (v > OPEN_SINGLE) _bad("floatSpend", "voucher above the stranger single");
            if (!open || vm.getBlockTimestamp() >= exp || vb > exp) _bad("floatSpend", "float spent outside its session");
            if (to == attacker) floatToAttacker += v;
        } catch {}
    }
    function reconcile(bool byOwner) external {
        (,, uint160 res,  uint64 exp, bool open) = a4.floats(address(wallet));
        uint256 pend0 = a4.pendingFees();
        bool ok;
        if (byOwner) {
            vm.prank(owner);
            try wallet.execute(address(a4), 0, abi.encodeCall(a4.reconcileFloat, (address(wallet)))) { ok = true; } catch {}
        } else {
            vm.prank(attacker);
            try a4.reconcileFloat(address(wallet)) { ok = true; } catch {}
            if (ok && vm.getBlockTimestamp() < exp) _bad("reconcile", "third party closed a live float session");
        }
        if (!ok) return;
        if (!open) _bad("reconcile", "closed a float that was not open");
        if (token.balanceOf(floatV()) != 0) _bad("reconcile", "float vault not emptied");
        if (_sub(pend0, a4.pendingFees()) != res) _bad("reconcile", "fee reserve not released");
    }

    // ---------------- owner / executor / guardian controls ----------------
    /// Biased to unpause (3 of 4) so runs are not dominated by a paused wallet.
    function ownerPause(uint8 x) external { ownerExec(address(t4), abi.encodeCall(t4.setPaused, (x % 4 == 0))); }
    function executorPause() external {
        vm.prank(executor); try a4.pause(p) {} catch {}
        if (t4.pausedUntil(address(wallet)) > vm.getBlockTimestamp() + 24 hours) _bad("pause", "executor pause longer than 24 h");
    }
    function guardianPause() external { vm.prank(guardian); try a4.pause(p) {} catch {} }
    function strangerPause() external { vm.prank(attacker); try a4.pause(p) { _bad("pause", "stranger paused the wallet"); } catch {} }
    function ownerDeny(uint8 who, bool v) external {
        address[7] memory ps = [bidPayee, regPayee, stranger, attacker, INLINE_PAYEE, fresh[0], FLOAT_PAYEE];
        ownerExec(address(t4), abi.encodeCall(t4.setDeniedPayee, (ps[who % 7], v)));
    }
    function ownerDenySigner(bool v) external { ownerExec(address(t4), abi.encodeCall(t4.setDeniedSigner, (shopSigner, v))); }
    function ownerUntrust(uint8 which) external {
        bytes32[3] memory ms = [GM, IM, EXAMPLESHOP];
        ownerExec(address(t4), abi.encodeCall(t4.untrust, (ms[which % 3])));
    }
    function ownerRetrustShop() external { ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), SINGLE, DAILY, 0); }
    function lowerFee(uint256 step) external {
        uint256 cur = feeCtl.feePpm(); if (cur == 0) return;
        uint256 nxt = cur - 1 - (step % (cur < 100 ? cur : 100));
        vm.prank(feeAdmin); feeCtl.lowerFee(nxt);
        vm.prank(feeAdmin); try feeCtl.lowerFee(nxt + 1) { _bad("fee", "fee went up"); } catch {}
        if (feeCtl.feePpm() > lastPpm || feeCtl.feePpm() > 3000) _bad("fee", "feePpm increased / above MAX");
        lastPpm = feeCtl.feePpm();
    }

    // ---------------- misc ----------------
    function collect() external {
        uint256 acc = a4.accruedFees(); uint256 b0 = token.balanceOf(feeSafe);
        try a4.collectFees() { collected += acc; if (token.balanceOf(feeSafe) - b0 != acc) _bad("collect", "recipient got != accrued"); }
        catch { _bad("collect", "collectFees reverted"); }
    }
    function refund(uint256 a) external {
        uint256 bal = token.balanceOf(bidPayee); if (bal == 0) return;
        a = bound(a, 1, bal);
        address v = vaultV();
        vm.prank(bidPayee); token.transfer(v, a);
    }
    function sweepByStranger() external {
        address v = vaultV();
        uint256 keep = 4 * PayerVaultV5(v).maxGasPerOp(); uint256 u = PayerVaultV5(v).unreserved();
        vm.prank(attacker); PayerVaultV5(v).sweep();
        uint256 expectLeft = u > keep ? keep : u;
        if (PayerVaultV5(v).unreserved() != expectLeft) _bad("sweep", "third-party sweep left != gas buffer");
    }
    function pass(uint256 s) external { warpBy(bound(s, 1 minutes, 8 hours)); }

    // ---------------- I-9: the owner can always exit (probe; all state is reverted) ----------------
    function exitProbe() external returns (bool ok, string memory why) {
        try this.exitInner() { return (false, "exitInner did not revert"); }
        catch (bytes memory r) {
            if (r.length < 4 || bytes4(r) != ExitResult.selector) return (false, "an exit step reverted");
            assembly { let len := mload(r) r := add(r, 4) mstore(r, sub(len, 4)) }
            return abi.decode(r, (bool, string));
        }
    }
    function exitInner() external {
        require(msg.sender == address(this));
        address v = vaultV(); address fv = floatV();
        uint256 w0 = token.balanceOf(address(wallet));
        uint256 gain = token.balanceOf(v) + token.balanceOf(fv) + a4.pendingFees();
        uint256 acc0 = a4.accruedFees();
        ownerExec(address(t4), abi.encodeCall(t4.setPaused, (true)));             // owner pause works in any state
        bytes32[] memory ds = new bytes32[](resList.length);
        for (uint256 i; i < ds.length; i++) ds[i] = resList[i].digest;
        a4.markSettled(ds);                                                        // anyone: close what was settled
        for (uint256 i; i < ds.length; i++)
            if (_resOpen(ds[i])) ownerExec(address(a4), abi.encodeCall(a4.cancelReservation, (ds[i])));
        (,,,, bool fopen) = a4.floats(address(wallet));
        if (fopen) ownerExec(address(a4), abi.encodeCall(a4.reconcileFloat, (address(wallet))));
        ownerExec(v, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(token)), address(wallet), PayerVaultV5(v).unreserved())));
        ownerExec(address(manager), abi.encodeCall(manager.revoke, (S(p))));
        gain -= a4.accruedFees() - acc0;                                          // settled fees that became protocol fees
        bool ok = true; string memory why = "";
        if (token.balanceOf(v) != 0 || PayerVaultV5(v).reserved() != 0) { ok = false; why = "vault not empty after exit"; }
        else if (token.balanceOf(fv) != 0) { ok = false; why = "float vault not empty after exit"; }
        else if (a4.pendingFees() != 0) { ok = false; why = "pending fees left after exit"; }
        else if (token.balanceOf(address(wallet)) - w0 != gain) { ok = false; why = "wallet did not get every owner USDC back"; }
        vm.prank(executor);
        try a4.payDirect(p, dirV(bidPayee, 1, ++ops), "", 0, dl()) { ok = false; why = "executor paid after pause + revoke"; } catch {}
        revert ExitResult(ok, why);
    }

    // ---------------- views for the invariant contract ----------------
    function freshAt(uint256 i) external view returns (address) { return fresh[i]; }
    function knownHoldersTotal() external view returns (uint256 t) {
        address[12] memory hs = [address(wallet), vaultV(), floatV(), address(a4), feeSafe, bidPayee, regPayee, stranger, attacker,
            INLINE_PAYEE, FLOAT_PAYEE, facilitator];
        for (uint256 i; i < hs.length; i++) t += token.balanceOf(hs[i]);
        for (uint256 i; i < 8; i++) t += token.balanceOf(fresh[i]);
    }
    /// Value of reservations that are open AND not yet settled by the facilitator (what the vault must still hold).
    function unsettledReserved() external view returns (uint256 t, uint256 openTotal) {
        address v = vaultV();
        for (uint256 i; i < resList.length; i++) {
            Res memory r = resList[i];
            if (!_resOpen(r.digest)) continue;
            openTotal += r.a.value;
            if (!token.authorizationState(v, r.nonce)) t += r.a.value;
        }
    }
    function walletAddr() external view returns (address) { return address(wallet); }
    function adapterAddr() external view returns (address) { return address(a4); }
    function permissionHash() external view returns (bytes32) { return phV(); }
    function spmSpent() external view returns (uint256) { return manager.getLastUpdatedPeriod(S(p)).spend; }
    function tokenAddr() external view returns (address) { return address(token); }
    function vaultAddr() external view returns (address) { return vaultV(); }
    function floatCapNow() external view returns (uint256) { return t4.floatCap(address(wallet)); }
    function attackerAddr() external view returns (address) { return attacker; }
}

/// I-1, I-2, I-3 (adapter side), I-5, I-8, I-9, I-10, I-12, I-13 (x402 digest side) and payer / merchant / fee conservation
/// for KipurseAdapterV54, KipurseTrustV54 and the payer / float vaults.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = false
contract V54PaymentsInvariantTest is Test {
    V54PayHandler h;
    KipurseAdapterV54 a4; MockEIP3009 tok;
    uint160 constant TERM54 = 120e6; uint160 constant DAILY = 12e6; uint160 constant OPEN_DAILY = 2e5; uint160 constant VER_DAILY = 5e6;

    function setUp() public {
        h = new V54PayHandler(); h.init();
        a4 = KipurseAdapterV54(h.adapterAddr()); tok = MockEIP3009(h.tokenAddr());
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](30);
        s[0] = h.payDirect.selector; s[1] = h.payApproved.selector; s[2] = h.payInline.selector; s[3] = h.paySigned.selector;
        s[4] = h.payTrusted.selector; s[5] = h.replay.selector; s[6] = h.x402.selector; s[7] = h.settle.selector;
        s[8] = h.markAll.selector; s[9] = h.reclaimOne.selector; s[10] = h.cancelOne.selector; s[11] = h.cancelByStranger.selector;
        s[12] = h.replayApproval.selector; s[13] = h.fundFloat.selector; s[14] = h.floatSpend.selector; s[15] = h.reconcile.selector;
        s[16] = h.ownerPause.selector; s[17] = h.executorPause.selector; s[18] = h.guardianPause.selector; s[19] = h.strangerPause.selector;
        s[20] = h.ownerDeny.selector; s[21] = h.ownerDenySigner.selector; s[22] = h.ownerUntrust.selector; s[23] = h.ownerRetrustShop.selector;
        s[24] = h.lowerFee.selector; s[25] = h.collect.selector; s[26] = h.refund.selector; s[27] = h.sweepByStranger.selector;
        s[28] = h.pass.selector; s[29] = h.payTrusted.selector; // signer-grant path weighted twice
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    /// Every per-call check in the handler (caps, fees, conservation, pause, deny, replay, forged input, I-12) held.
    function invariant_noHandlerViolation() public view { assertEq(h.violations(), 0, h.firstViolation()); }
    /// I-8: the adapter holds exactly the fees it owes.
    function invariant_adapterHoldsOnlyFees() public view {
        assertEq(tok.balanceOf(address(a4)), a4.accruedFees() + a4.pendingFees());
    }
    /// I-8: the vault always holds the value of every open, unsettled reservation; `reserved` == sum of open reservations.
    function invariant_vaultCoversReservations() public view {
        (uint256 unsettled, uint256 openTotal) = h.unsettledReserved();
        address v = h.vaultAddr();
        assertGe(tok.balanceOf(v), unsettled);
        assertEq(PayerVaultV5(v).reserved(), openTotal);
    }
    /// I-1 term: the adapter's term counter equals the independent model and never exceeds the owner-signed term; the SPM
    /// (independent second cap) recorded exactly what the adapter pulled.
    function invariant_termCap() public view {
        assertEq(a4.termSpent(h.permissionHash()), h.ghostTerm(), "term counter != model");
        assertLe(h.ghostTerm(), TERM54);
        assertEq(h.spmSpent(), h.ghostPulled(), "SPM spend != pulled");
        assertLe(h.spmSpent(), TERM54);
    }
    /// I-1 daily: every day counter equals the model and stays within daily / stranger / registry / per-merchant / float caps.
    function invariant_dailyCaps() public view {
        bytes32 ph = h.permissionHash();
        for (uint256 d; d <= h.maxDay(); d++) {
            assertEq(a4.daySpent(ph, d), h.ghostDay(d), "day counter != model");
            assertLe(a4.daySpent(ph, d), DAILY);
            assertLe(a4.openDaySpent(ph, d), OPEN_DAILY);
            assertLe(a4.verifiedDaySpent(ph, d), VER_DAILY);
            assertLe(a4.merchantDaySpent(ph, keccak256("deposits.example"), d), 10e6);  // largest signer-grant daily used (per-call check is exact)
            assertLe(a4.merchantDaySpent(ph, keccak256("inline.example"), d), 5e6);     // inline trust daily
            assertLe(a4.merchantDaySpent(ph, keccak256("exampleshop.example"), d), DAILY);
            assertLe(a4.merchantDaySpent(ph, keccak256("verified-shop.example"), d), VER_DAILY);
            assertLe(a4.floatDaySpent(ph, d), h.floatCapNow());
        }
    }
    /// I-2: the attacker address is never trusted / approved, so it can only have received stranger-tier money (or
    /// float micropayments, which are capped by the owner's float cap and the stranger single).
    function invariant_attackerOnlyStrangerTier() public view {
        bytes32 ph = h.permissionHash(); uint256 open;
        for (uint256 d; d <= h.maxDay(); d++) open += a4.openDaySpent(ph, d);
        assertLe(tok.balanceOf(h.attackerAddr()), open + h.floatToAttacker());
    }
    /// Conservation: no USDC ever reaches an address outside the modelled set (wallet, vaults, adapter, fee recipient, payees).
    function invariant_noLeak() public view { assertEq(h.knownHoldersTotal(), tok.totalSupply()); }
    /// I-3: fees ever taken (collected + accrued + pending) never exceed MAX_FEE_PPM of what was paid (rounded up per payment).
    function invariant_feesBoundedByHardMax() public view {
        assertLe(h.collected() + a4.accruedFees() + a4.pendingFees(), h.ghostFeeBound());
    }
    /// I-9: from ANY reachable state the owner alone pauses, closes reservations, reconciles the float, withdraws the vault,
    /// revokes the permission and gets every owner USDC back; the executor can no longer pay. (Probe state is reverted.)
    function invariant_ownerCanAlwaysExit() public {
        (bool ok, string memory why) = h.exitProbe();
        assertTrue(ok, why);
    }
    function afterInvariant() public {
        emit log_named_uint("ok direct+approved+inline", h.okDirect() + h.okApproved() + h.okInline());
        emit log_named_uint("ok signed+signedTrusted", h.okSigned() + h.okTrusted());
        emit log_named_uint("ok x402 / settle / release", h.okX402() * 1e6 + h.okSettle() * 1e3 + h.okRelease());
        emit log_named_uint("ok float fund / spend", h.okFloat() * 1e3 + h.okFloatSpend());
        emit log_named_uint("x402 refunds left in vault (settled-unmarked sibling)", h.refundsLeftInVault());
    }

    /// Deterministic smoke: each path succeeds once and every forged variant is refused.
    function test_handlerExercisesEveryPath() public {
        h.payDirect(5e5, 0, 0); h.payDirect(5e4, 2, 100); h.payApproved(5e5, 0, 0); h.payApproved(5e5, 1, 0); h.payApproved(5e5, 2, 0);
        h.payInline(5e5, 0, 0); h.payInline(5e5, 1, 0); h.payInline(5e5, 2, 0); h.payInline(5e5, 3, 0);
        h.paySigned(5e5, 0, 0); h.paySigned(5e5, 1, 0); h.paySigned(5e5, 2, 0); h.paySigned(5e5, 3, 0); h.paySigned(5e5, 4, 0);
        for (uint8 v; v < 7; v++) h.payTrusted(5e5, v, v, 0);
        for (uint8 k; k < 5; k++) h.replay(k);
        h.x402(5e5, 0, 0, 0); h.x402(5e5, 0, 1, 0); h.x402(5e5, 0, 2, 0); h.x402(5e4, 2, 0, 0);
        h.settle(0); h.markAll(); h.cancelByStranger(1); h.cancelOne(1); h.replayApproval(1);
        h.fundFloat(2e5, 0); h.floatSpend(5e4, 0); h.floatSpend(5e4, 2); h.reconcile(false); h.reconcile(true);
        h.collect(); h.refund(1e5); h.sweepByStranger();
        h.ownerUntrust(0); h.payTrusted(5e5, 1, 4, 0); h.ownerUntrust(1); h.payInline(5e5, 3, 0);
        h.pass(8 hours); h.reclaimOne(2);
        h.executorPause(); h.payDirect(5e5, 0, 0); h.ownerPause(1); h.guardianPause(); h.strangerPause(); h.ownerPause(1);
        h.lowerFee(5);
        assertEq(h.violations(), 0, h.firstViolation());
        assertEq(h.okDirect(), 2); assertEq(h.okApproved(), 1); assertEq(h.okInline(), 2); assertEq(h.okSigned(), 2);
        assertEq(h.okTrusted(), 3, "valid, stale-before-untrust, over-single grant capped by policy");
        assertEq(h.okX402(), 3); assertEq(h.okSettle(), 1); assertEq(h.okRelease(), 2);
        assertEq(h.okFloat(), 1); assertEq(h.okFloatSpend(), 1);
        invariant_adapterHoldsOnlyFees(); invariant_vaultCoversReservations(); invariant_termCap(); invariant_dailyCaps();
        invariant_attackerOnlyStrangerTier(); invariant_noLeak(); invariant_feesBoundedByHardMax(); invariant_ownerCanAlwaysExit();
    }
}
