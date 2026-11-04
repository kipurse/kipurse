// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {S} from "./SpmCast.sol";
import {KipurseAdapterV5, PayerVaultV5, PackedUserOperation} from "../src/KipurseAdapterV5.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// ZERO-RESERVE gas (design 2026-10-17): the owner's vault is the ERC-4337 v0.7 sender; the session signer holds nothing;
/// gas is paid in USDC from the vault through an allowlisted paymaster, capped per op by Policy.maxGasPerOp (= maxNetworkFee).
contract KipurseV5ZeroReserveTest is V5Base {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant PM = 0x6C973eBe80dCD8660841D4356bf15c32460271C9;
    uint256 constant SESS = 0x5E55;
    PayerVaultV5 v;
    function setUp() public override {
        executor = vm.addr(SESS);
        super.setUp();
        v = PayerVaultV5(adapter.registerPermission(p));
    }
    function op(bytes memory callData, bytes memory pmd, uint256 k, bytes32 h) internal pure returns (PackedUserOperation memory o) {
        o.callData = callData; o.paymasterAndData = pmd;
        (uint8 vv, bytes32 r, bytes32 s) = vm_sign(k, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        o.signature = abi.encodePacked(r, s, vv);
    }
    function vm_sign(uint256 k, bytes32 d) internal pure returns (uint8, bytes32, bytes32) {
        return VmSafeSign(address(uint160(uint256(keccak256("hevm cheat code"))))).sign(k, d);
    }
    function pmd() internal pure returns (bytes memory) { return abi.encodePacked(PM, uint128(1e5), uint128(1e5), uint8(0)); }

    function test_register_bindsSessionAndGasCap_onlyValidPermissions() public view {
        assertEq(v.sessionSigner(), executor); assertEq(v.maxGasPerOp(), MAX_NF);
        assertEq(v.entryPoint(), EP); assertTrue(v.isPaymaster(PM)); assertFalse(v.isPaymaster(address(0)));
        assertEq(address(v), adapter.vaultAddress(address(wallet)));
    }
    function test_register_rejectsRevokedPermission() public {
        vm.prank(address(wallet)); manager.revoke(S(p));
        vm.expectRevert(Permission.selector); adapter.registerPermission(p);
    }
    function test_validateUserOp_onlyEntryPoint_neverPaysEth_paymasterRequired_sessionSignerOnly() public {
        bytes32 h = keccak256("userop");
        PackedUserOperation memory o = op("", pmd(), SESS, h);
        vm.expectRevert(NotEntryPoint.selector); v.validateUserOp(o, h, 0);
        vm.startPrank(EP);
        vm.expectRevert(NoEth.selector); v.validateUserOp(o, h, 1);                       // no paymaster => would pay ETH => refuse
        assertEq(v.validateUserOp(o, h, 0), 0);                                           // session signer + Circle
        assertEq(v.validateUserOp(op("", pmd(), 0xBAD1, h), h, 0), 1);                    // any other key fails
        assertEq(v.validateUserOp(op("", pmd(), SESS, keccak256("other")), h, 0), 1);     // signature bound to the hash
        PackedUserOperation memory noPm = op("", "", SESS, h);
        vm.expectRevert(Target.selector); v.validateUserOp(noPm, h, 0);
        PackedUserOperation memory evilPm = op("", abi.encodePacked(address(0xE71), uint128(1), uint128(1)), SESS, h);
        vm.expectRevert(Target.selector); v.validateUserOp(evilPm, h, 0);
        vm.stopPrank();
    }
    function test_execute_vaultPaysThroughAdapter_signerHoldsNothing() public {
        nf = 7_321;
        bytes memory call_ = abi.encodeCall(KipurseAdapterV5.payDirect, (p, direct(stranger, 1e5, 77), "", nf, dl()));
        vm.prank(EP); v.execute(address(adapter), 0, call_);
        assertEq(token.balanceOf(stranger), 1e5);
        assertEq(token.balanceOf(address(v)), 7_321);                    // gas top-up = owner money, pays the paymaster next op
        assertEq(adapter.accruedFees(), 100);                            // we only get 0.1%
        assertEq(token.balanceOf(executor), 0); assertEq(executor.balance, 0);
        assertEq(address(adapter).balance, 0); assertEq(address(v).balance, 0);
    }
    function test_execute_allowlist() public {
        deal(address(token), address(v), 200_000);
        vm.expectRevert(NotEntryPoint.selector); v.execute(address(adapter), 0, "");
        vm.startPrank(EP);
        v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, MAX_NF)));
        assertEq(token.allowance(address(v), PM), MAX_NF);
        vm.expectRevert(GasCap.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, MAX_NF + 1)));
        vm.expectRevert(Target.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (attacker, 1)));
        vm.expectRevert(Target.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (attacker, 1)));
        vm.expectRevert(Target.selector); v.execute(attacker, 0, "");
        vm.expectRevert(NoEth.selector); v.execute(address(adapter), 1, "");
        PayerVaultV5.Call[] memory cs = new PayerVaultV5.Call[](2);
        cs[0] = PayerVaultV5.Call(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 1)));
        cs[1] = PayerVaultV5.Call(address(token), 0, abi.encodeCall(IERC20.transfer, (attacker, 1)));
        vm.expectRevert(Target.selector); v.executeBatch(cs);              // atomic: one bad call reverts all
        vm.stopPrank();
    }
    bytes32 constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    function permitDigest(address sp, uint256 val, uint256 n, uint256 d) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, address(v), sp, val, n, d))));
    }
    function permitSig(uint256 k, address sp, uint256 val, uint256 n, uint256 d, bytes32 dig) internal pure returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm_sign(k, dig);
        return abi.encode(sp, val, n, d, abi.encodePacked(r, s, vv));
    }
    function test_permit1271_onlyPaymaster_atMostMaxGasPerOp_sessionSigner() public {
        deal(address(token), address(v), 200_000); // the owner's 0.20 USDC gas buffer
        uint256 d = T0 + 600; bytes32 dig = permitDigest(PM, MAX_NF, 0, d);
        assertEq(v.isValidSignature(dig, permitSig(SESS, PM, MAX_NF, 0, d, dig)), bytes4(0x1626ba7e));
        bytes32 big = permitDigest(PM, MAX_NF + 1, 0, d);
        assertEq(v.isValidSignature(big, permitSig(SESS, PM, MAX_NF + 1, 0, d, big)), bytes4(0xffffffff));   // above the cap
        bytes32 ev = permitDigest(attacker, 1, 0, d);
        assertEq(v.isValidSignature(ev, permitSig(SESS, attacker, 1, 0, d, ev)), bytes4(0xffffffff));        // not a paymaster
        assertEq(v.isValidSignature(dig, permitSig(0xBAD1, PM, MAX_NF, 0, d, dig)), bytes4(0xffffffff));     // wrong key
        assertEq(v.isValidSignature(keccak256("x"), permitSig(SESS, PM, MAX_NF, 0, d, dig)), bytes4(0xffffffff)); // digest mismatch
        assertEq(v.isValidSignature(dig, hex"00"), bytes4(0xffffffff));
    }
    function testFuzz_gasAllowanceNeverAboveCap(uint256 amt) public {
        deal(address(token), address(v), 200_000);
        vm.prank(EP);
        if (amt > MAX_NF) { vm.expectRevert(GasCap.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, amt))); }
        else { v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, amt))); assertLe(token.allowance(address(v), PM), MAX_NF); }
    }
    /// Pre-audit finding (2026-10-17, ZR review): the paymaster's transferFrom ignores `reserved`, so without a guard gas could
    /// eat USDC that backs an open x402 reservation. Both the permit path and the approve path now require unreserved >= value.
    function test_gasNeverTouchesReservedX402Funds() public {
        deal(address(token), address(v), 100_000);
        vm.prank(address(adapter)); v.approveDigest(keccak256("open-x402"), T0 + 300, 90_000); // 0.09 reserved for a merchant
        uint256 d = T0 + 600;
        bytes32 a = permitDigest(PM, MAX_NF, 0, d);
        assertEq(v.isValidSignature(a, permitSig(SESS, PM, MAX_NF, 0, d, a)), bytes4(0xffffffff)); // 0.02 cap > 0.01 unreserved
        bytes32 b = permitDigest(PM, 10_000, 0, d);
        assertEq(v.isValidSignature(b, permitSig(SESS, PM, 10_000, 0, d, b)), bytes4(0x1626ba7e)); // exactly the unreserved part
        vm.prank(EP); vm.expectRevert(Reserved.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 10_001)));
        vm.prank(EP); v.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 10_000)));
    }
    /// Optional per-op bundler-fee pass-through: OFF by default; only the OWNER wallet configures it; at most one transfer
    /// per userOp, only to the owner-chosen operator, <= the owner's cap, never from reserved x402 funds.
    function test_bundlerFeePassThrough_ownerConfigured_oncePerOp_capped() public {
        deal(address(token), address(v), 200_000);
        address op_ = address(0xB0B);
        bytes memory fee1 = abi.encodeCall(IERC20.transfer, (op_, 500));
        vm.prank(EP); vm.expectRevert(Target.selector); v.execute(address(token), 0, fee1); // off by default
        vm.expectRevert(NotAccount.selector); v.setBundlerFee(op_, 1000);                  // not the owner
        vm.prank(address(wallet)); v.setBundlerFee(op_, 1000);
        vm.prank(EP); v.execute(address(token), 0, fee1);
        assertEq(token.balanceOf(op_), 500);
        vm.prank(EP); vm.expectRevert(GasCap.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (op_, 1001)));
        vm.prank(EP); vm.expectRevert(Target.selector); v.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (attacker, 500)));
        PayerVaultV5.Call[] memory two = new PayerVaultV5.Call[](2);
        two[0] = PayerVaultV5.Call(address(token), 0, fee1); two[1] = PayerVaultV5.Call(address(token), 0, fee1);
        vm.prank(EP); vm.expectRevert(Target.selector); v.executeBatch(two); // only one fee per op
        vm.prank(EP); v.execute(address(token), 0, fee1); // next op: allowed again
        assertEq(token.balanceOf(op_), 1000);
        uint256 left = token.balanceOf(address(v));
        vm.prank(address(adapter)); v.approveDigest(keccak256("open"), T0 + 300, left - 499); // only 499 unreserved
        vm.prank(EP); vm.expectRevert(Reserved.selector); v.execute(address(token), 0, fee1);
    }
    function test_pauseByVault_andLegacySignerPathStillBounded() public {
        vm.prank(EP); v.execute(address(adapter), 0, abi.encodeCall(KipurseAdapterV5.pause, (p)));
        assertTrue(trustC.isPaused(address(wallet)));
    }
}
interface VmSafeSign { function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32); }
