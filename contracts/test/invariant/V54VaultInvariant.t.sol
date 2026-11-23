// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./V54Base.t.sol";

/// Stateful handler for the payer vault (PayerVaultV5 clones of the LIVE V5.4 adapter): ERC-4337 validation (session
/// signer, paymaster allowlist, ops per UTC day), execute / executeBatch allowlist (adapter, BySig relays, paymaster
/// approve <= maxGasPerOp, one owner-configured bundler fee per op), ERC-1271 (adapter-approved x402 digests and session
/// permits only), x402 reservations, sweep / withdraw. I-13, I-14, I-8 (vault side), I-9 (vault withdraw).
contract V54VaultHandler is V54Base {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant PM = 0x6C973eBe80dCD8660841D4356bf15c32460271C9;
    uint256 constant SESS = 0x5E55;
    address constant BUNDLER = address(0xB0B);
    uint96 constant BUNDLER_MAX = 5_000;
    bytes4 constant MAGIC = 0x1626ba7e;

    PayerVaultV5 public v;
    uint256 public violations; string public firstViolation;
    uint256 public okOps; uint256 public okApprove; uint256 public okBundlerOps; uint256 public okPays; uint256 public okX402;
    uint256 public okPermit; uint256 ops;
    mapping(bytes32 => uint256) public approvedUntilModel; // digest => validBefore while open (independent model)
    bytes32[] public digests; KipurseAdapterV54.Auth[] auths; bytes32[] nonces;

    function init() external {
        executor = vm.addr(SESS);
        setUp();
        v = PayerVaultV5(a4.registerPermission(p));
        ownerExec(address(v), abi.encodeCall(PayerVaultV5.setBundlerFee, (BUNDLER, BUNDLER_MAX)));
        token.mint(address(v), 1e6); // USDC gas buffer
    }
    function _bad(string memory why) internal { if (violations == 0) firstViolation = why; violations++; }
    function _sign(uint256 k, bytes32 d) internal pure returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(k, d); return abi.encodePacked(r, s, vv);
    }
    function _cap() internal view returns (uint256) { return v.opsPerDay(); }

    // ---------------- ERC-4337 validation (I-14) ----------------
    function userOp(uint256 daySeed, uint256 seq, uint8 signerSel, uint8 pmSel, bool eth, bool notEp) external {
        uint256 dayNow = vm.getBlockTimestamp() / 1 days;
        uint256 dsel = daySeed % 5;
        uint256 day = dsel == 0 ? 0 : dsel == 1 ? dayNow - 1 : dsel == 4 ? 1e9 : dayNow + (dsel - 2);
        seq = bound(seq, 0, _cap() + 3);
        PackedUserOperation memory o;
        o.nonce = (day << 64) | seq;
        address pm = pmSel % 4 == 0 ? PM : pmSel % 4 == 1 ? attacker : pmSel % 4 == 2 ? address(0) : PM;
        o.paymasterAndData = pmSel % 4 == 2 ? bytes("") : abi.encodePacked(pm, uint128(1e5), uint128(1e5));
        bytes32 h = keccak256(abi.encode("op", ++ops));
        bool bySession = signerSel % 3 != 0;
        o.signature = _sign(bySession ? SESS : K_ATTACKER, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        if (signerSel % 7 == 6) o.signature = hex"1234"; // malformed
        bool mustRevert = notEp || eth || pm != PM || day == 0 || day >= 1e9 || seq >= _cap();
        vm.prank(notEp ? attacker : EP);
        try v.validateUserOp(o, h, eth ? 1 : 0) returns (uint256 vd) {
            if (mustRevert) _bad("validateUserOp accepted a non-EP / ETH / non-paymaster / out-of-cap op");
            uint256 sigFailed = vd & ((1 << 160) - 1);
            uint256 until = (vd >> 160) & ((1 << 48) - 1); uint256 after_ = vd >> 208;
            bool good = bySession && signerSel % 7 != 6;
            if (sigFailed == 0 && !good) _bad("validateUserOp: a non-session signature validated");
            if (sigFailed != 0 && good) _bad("validateUserOp: the session signature failed");
            if (after_ != day * 1 days || until != after_ + 1 days - 1) _bad("validateUserOp: window != the nonce-key UTC day");
            if (sigFailed == 0) okOps++;
        } catch {
            if (!mustRevert) _bad("validateUserOp reverted on a well-formed op");
        }
    }
    function setOps(uint256 n, bool byOwner) external {
        n = bound(n, 0, v.MAX_OPS_PER_DAY() + 10);
        if (byOwner) {
            vm.prank(owner);
            try wallet.execute(address(v), 0, abi.encodeCall(PayerVaultV5.setOpsPerDay, (uint32(n)))) {
                if (n > v.MAX_OPS_PER_DAY()) _bad("opsPerDay above MAX_OPS_PER_DAY");
                if (v.opsPerDay() != (n == 0 ? v.DEFAULT_OPS_PER_DAY() : n)) _bad("opsPerDay not applied");
            } catch { if (n <= v.MAX_OPS_PER_DAY()) _bad("owner could not set opsPerDay"); }
        } else {
            vm.prank(executor);
            try v.setOpsPerDay(uint32(n)) { _bad("session signer changed opsPerDay"); } catch {}
        }
    }

    // ---------------- execute allowlist (I-14 gas, I-13 no arbitrary calls) ----------------
    function execApprove(uint256 amt, bool toPm) external {
        amt = bound(amt, 0, 3 * MAX_NF);
        address sp = toPm ? PM : attacker;
        vm.prank(EP);
        try v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (sp, amt))) {
            okApprove++;
            if (!toPm) _bad("vault approved a non-paymaster");
            if (amt > v.maxGasPerOp()) _bad("paymaster allowance above maxGasPerOp");
        } catch {}
    }
    function execBundler(uint256 amt, bool twice) external {
        amt = bound(amt, 0, 2 * BUNDLER_MAX);
        PayerVaultV5.Call[] memory cs = new PayerVaultV5.Call[](twice ? 2 : 1);
        for (uint256 i; i < cs.length; i++) cs[i] = PayerVaultV5.Call(address(token), 0, abi.encodeCall(IERC20.transfer, (BUNDLER, amt)));
        vm.prank(EP);
        try v.executeBatch(cs) {
            okBundlerOps++;
            if (twice) _bad("two bundler fees in one userOp");
            if (amt > BUNDLER_MAX) _bad("bundler fee above maxBundlerFee");
        } catch {}
    }
    function execForbidden(uint8 kind, uint256 x) external {
        kind %= 7;
        address target; bytes memory data; uint256 value;
        if (kind == 0) { target = address(token); data = abi.encodeCall(IERC20.transfer, (attacker, bound(x, 1, 1e6))); }
        else if (kind == 1) { target = address(t4); data = abi.encodeCall(t4.setPaused, (false)); }
        else if (kind == 2) { target = address(t4); data = abi.encodeCall(t4.setDeniedPayee, (attacker, false)); }
        else if (kind == 3) { target = attacker; data = hex"12345678"; }
        else if (kind == 4) { target = address(a4); value = bound(x, 1, 1e18); data = abi.encodeCall(a4.collectFees, ()); }
        else if (kind == 5) { target = address(token); data = abi.encodeCall(IERC20.transferFrom, (address(wallet), attacker, 1)); }
        else { target = address(manager); data = hex"00"; }
        vm.prank(EP);
        try v.execute(target, value, data) { _bad("vault executed a call outside its allowlist"); } catch {}
        vm.prank(attacker);
        try v.execute(address(a4), 0, abi.encodeCall(a4.collectFees, ())) { _bad("non-EntryPoint executed"); } catch {}
    }
    /// The 4337 path: the vault (sender) calls the adapter; the adapter accepts the vault as the executor.
    function execPay(uint256 a, uint256 nfSeed) external {
        a = bound(a, 1, 2e6); uint256 nfee = nfSeed % (MAX_NF + 1);
        KipurseAdapterV54.Direct memory d = dirV(bidPayee, a, ++ops);
        bytes memory data = abi.encodeCall(a4.payDirect, (p, d, "", nfee, dl()));
        uint256 b0 = token.balanceOf(bidPayee);
        vm.prank(EP);
        try v.execute(address(a4), 0, data) {
            okPays++;
            if (token.balanceOf(bidPayee) - b0 != a) _bad("4337 pay: payee credit != amount");
        } catch {}
    }

    // ---------------- x402 digests (I-13) ----------------
    function x402(uint256 a) external {
        a = bound(a, 1, 2e6);
        KipurseAdapterV54.Auth memory au = authV(bidPayee, a, ++ops);
        vm.prank(executor);
        try a4.prepareAuthorization(p, au, "", 0, dl()) returns (address, bytes32 dg, bytes32 n) {
            okX402++; digests.push(dg); auths.push(au); nonces.push(n); approvedUntilModel[dg] = au.validBefore;
        } catch {}
    }
    function settleAndMark(uint256 i) external {
        if (digests.length == 0) return; i %= digests.length;
        KipurseAdapterV54.Auth memory au = auths[i];
        bool modelOpen = approvedUntilModel[digests[i]] > vm.getBlockTimestamp();
        vm.prank(facilitator);
        try token.transferWithAuthorization(address(v), au.to, au.value, au.validAfter, au.validBefore, nonces[i], hex"00") {
            if (!modelOpen) _bad("vault 1271 approved an expired / closed digest");
        } catch {}
        a4.markSettled(_one(digests[i]));
        (,,,, bool open,,,,,,) = a4.reservations(digests[i]);
        if (!open) approvedUntilModel[digests[i]] = 0;
    }
    function reclaimOne(uint256 i) external {
        if (digests.length == 0) return; i %= digests.length;
        try a4.reclaim(digests[i]) { approvedUntilModel[digests[i]] = 0; } catch {}
    }
    function _one(bytes32 d) internal pure returns (bytes32[] memory r) { r = new bytes32[](1); r[0] = d; }

    // ---------------- ERC-1271 (I-13 / I-14) ----------------
    function permit1271(uint256 val, uint8 spSel, bool bySession, uint256 deadline, bool mutate) external {
        val = bound(val, 0, 3 * MAX_NF);
        address sp = spSel % 3 == 0 ? attacker : PM;
        uint256 nonce = token.nonces(address(v));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), address(v), sp, val, nonce, deadline))));
        bytes memory sig = abi.encode(sp, val, nonce, deadline, _sign(bySession ? SESS : K_ATTACKER, d));
        bytes32 asked = mutate ? keccak256(abi.encode(d)) : d;
        bytes4 r = v.isValidSignature(asked, sig);
        bool expect = !mutate && sp == PM && bySession && val <= v.maxGasPerOp() && token.balanceOf(address(v)) >= v.reserved() + val
            && approvedUntilModel[asked] <= vm.getBlockTimestamp();
        if (r == MAGIC && !expect) _bad("vault 1271 signed a bad permit / arbitrary hash");
        if (r != MAGIC && expect) _bad("vault 1271 refused a valid session permit");
        if (r == MAGIC) okPermit++;
    }
    function random1271(bytes32 hash, bytes calldata sig, uint256 pick) external {
        if (digests.length != 0 && pick % 2 == 0) hash = digests[pick % digests.length];
        bytes4 r = v.isValidSignature(hash, sig);
        bool open = approvedUntilModel[hash] > vm.getBlockTimestamp();
        if (r == MAGIC && !open) _bad("vault 1271 signed a digest the adapter never approved (or expired)");
        if (r != MAGIC && open) _bad("vault 1271 refused an open adapter digest");
    }

    // ---------------- exits ----------------
    function sweep(bool byOwner) external {
        uint256 u = v.unreserved(); uint256 keep = byOwner ? 0 : 4 * v.maxGasPerOp();
        uint256 w0 = token.balanceOf(address(wallet));
        if (byOwner) ownerExec(address(v), abi.encodeCall(PayerVaultV5.sweep, ()));
        else { vm.prank(attacker); v.sweep(); }
        if (token.balanceOf(address(wallet)) - w0 != (u > keep ? u - keep : 0)) _bad("sweep amount");
    }
    function withdraw(uint256 amt, bool byOwner) external {
        amt = bound(amt, 0, token.balanceOf(address(v)) + 1);
        if (byOwner) {
            vm.prank(owner);
            try wallet.execute(address(v), 0, abi.encodeCall(PayerVaultV5.withdraw, (IERC20(address(token)), address(wallet), amt))) {
                if (token.balanceOf(address(v)) < v.reserved()) _bad("withdraw ate reserved funds");
            } catch { if (amt <= v.unreserved()) _bad("owner could not withdraw unreserved USDC"); }
        } else {
            vm.prank(attacker);
            try v.withdraw(IERC20(address(token)), attacker, amt) { _bad("non-owner withdrew"); } catch {}
        }
    }
    function topUp(uint256 a) external { token.mint(address(v), bound(a, 1, 1e5)); }
    function pass(uint256 s) external { warpBy(bound(s, 1, 12 hours)); }

    // views
    function vaultAddr() external view returns (address) { return address(v); }
    function tokenAddr() external view returns (address) { return address(token); }
    function pmAllowance() external view returns (uint256) { return token.allowance(address(v), PM); }
    function attackerAllowance() external view returns (uint256) { return token.allowance(address(v), attacker); }
    function bundlerBal() external view returns (uint256) { return token.balanceOf(BUNDLER); }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
/// forge-config: default.invariant.fail-on-revert = false
contract V54VaultInvariantTest is Test {
    V54VaultHandler h; PayerVaultV5 v; MockEIP3009 tok;
    function setUp() public {
        h = new V54VaultHandler(); h.init();
        v = PayerVaultV5(h.vaultAddr()); tok = MockEIP3009(h.tokenAddr());
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](16);
        s[0] = h.userOp.selector; s[1] = h.setOps.selector; s[2] = h.execApprove.selector; s[3] = h.execBundler.selector;
        s[4] = h.execForbidden.selector; s[5] = h.execPay.selector; s[6] = h.x402.selector; s[7] = h.settleAndMark.selector;
        s[8] = h.reclaimOne.selector; s[9] = h.permit1271.selector; s[10] = h.random1271.selector; s[11] = h.sweep.selector;
        s[12] = h.withdraw.selector; s[13] = h.topUp.selector; s[14] = h.pass.selector; s[15] = h.userOp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }
    function invariant_noHandlerViolation() public view { assertEq(h.violations(), 0, h.firstViolation()); }
    /// I-8 (vault): open x402 reservations stay fully backed (settled ones are marked in the same handler step).
    function invariant_vaultCoversReservations() public view { assertGe(tok.balanceOf(address(v)), v.reserved()); }
    /// I-14: the paymaster allowance never exceeds maxGasPerOp; nobody else ever gets an allowance.
    function invariant_gasAllowanceBounded() public view {
        assertLe(h.pmAllowance(), v.maxGasPerOp()); assertEq(h.attackerAllowance(), 0);
    }
    /// I-14: bundler fees <= one capped fee per userOp; opsPerDay within its hard max.
    function invariant_bundlerAndOpsBounded() public view {
        assertLe(h.bundlerBal(), h.okBundlerOps() * v.maxBundlerFee());
        assertLe(v.opsPerDay(), v.MAX_OPS_PER_DAY());
    }
    function test_vaultHandlerSmoke() public {
        h.userOp(2, 0, 1, 0, false, false); h.userOp(2, 0, 0, 0, false, false); h.userOp(0, 0, 1, 0, false, false);
        h.userOp(2, 0, 1, 1, false, false); h.userOp(2, 0, 1, 0, true, false); h.userOp(2, 0, 1, 0, false, true);
        h.setOps(3, true); h.userOp(2, 3, 1, 0, false, false); h.setOps(5, false); h.setOps(200_000, true);
        h.execApprove(10_000, true); h.execApprove(100_000, true); h.execApprove(1, false);
        h.execBundler(1_000, false); h.execBundler(1_000, true); h.execBundler(9_000, false);
        for (uint8 k; k < 7; k++) h.execForbidden(k, 5);
        h.execPay(1e6, 0); h.x402(1e6); h.permit1271(10_000, 1, true, 1e10, false); h.permit1271(10_000, 0, true, 1e10, false);
        h.random1271(bytes32(0), "", 0); h.random1271(keccak256("x"), hex"00", 1);
        h.settleAndMark(0); h.x402(1e6); h.pass(1 hours); h.reclaimOne(1);
        h.sweep(false); h.withdraw(1, false); h.withdraw(1e5, true); h.sweep(true);
        assertEq(h.violations(), 0, h.firstViolation());
        assertEq(h.okOps(), 1); assertEq(h.okApprove(), 1); assertEq(h.okBundlerOps(), 1); assertEq(h.okPays(), 1); assertEq(h.okX402(), 2);
        assertEq(h.okPermit(), 1);
    }
}
