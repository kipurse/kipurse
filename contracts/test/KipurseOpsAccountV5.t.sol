// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {V5Base} from "./V5Base.sol";
import {KipurseOpsAccountV5} from "../src/KipurseOpsAccountV5.sol";
import {KipurseAdapterV5, PackedUserOperation} from "../src/KipurseAdapterV5.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// Ops account: zero-reserve deployer (deploy phase) + fee recipient that pays its own gas in USDC (after lock).
contract KipurseOpsAccountV5Test is V5Base {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant PM = 0x6C973eBe80dCD8660841D4356bf15c32460271C9;
    uint256 constant SIG = 0x0A5;
    address treasury = address(0x7EA5);
    KipurseOpsAccountV5 ops;
    function setUp() public override {
        super.setUp();
        ops = new KipurseOpsAccountV5(EP, PM, address(0), IERC20(address(token)), token.DOMAIN_SEPARATOR(), treasury, vm.addr(SIG), 50_000, 1_000_000);
    }
    function _op(bytes memory pmd, uint256 k, bytes32 h) internal pure returns (PackedUserOperation memory o) {
        o.paymasterAndData = pmd;
        (uint8 vv, bytes32 r, bytes32 s) = VmSign(address(uint160(uint256(keccak256("hevm cheat code"))))).sign(k, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        o.signature = abi.encodePacked(r, s, vv);
    }
    function test_validate_onlyEP_noEth_paymasterRequired_signerOnly() public {
        bytes memory pmd = abi.encodePacked(PM, uint128(1e5), uint128(1e5));
        vm.expectRevert(NotEntryPoint.selector); ops.validateUserOp(_op(pmd, SIG, bytes32(uint256(1))), bytes32(uint256(1)), 0);
        vm.startPrank(EP);
        assertEq(ops.validateUserOp(_op(pmd, SIG, bytes32(uint256(1))), bytes32(uint256(1)), 0), 0);
        assertEq(ops.validateUserOp(_op(pmd, 0xBAD, bytes32(uint256(1))), bytes32(uint256(1)), 0), 1);
        vm.expectRevert(NoEth.selector); ops.validateUserOp(_op(pmd, SIG, bytes32(uint256(1))), bytes32(uint256(1)), 1);
        vm.expectRevert(Target.selector); ops.validateUserOp(_op(abi.encodePacked(attacker), SIG, bytes32(uint256(1))), bytes32(uint256(1)), 0);
        vm.stopPrank();
    }
    function test_deployPhase_thenLock_thenOnlyCollectFeesAndTreasury() public {
        // deploy phase: CREATE2 a fee controller whose recipient is the ops account itself
        bytes memory init = abi.encodePacked(type(KipurseFeeControllerV5).creationCode, abi.encode(feeAdmin, uint256(1000), address(ops)));
        vm.expectRevert(Target.selector); ops.deploy(bytes32(uint256(7)), init);
        vm.prank(EP); address fc = ops.deploy(bytes32(uint256(7)), init);
        assertEq(KipurseFeeControllerV5(fc).feeRecipient(), address(ops));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(adapter), 0, abi.encodeWithSignature("collectFees()")); // not locked yet
        vm.prank(attacker); vm.expectRevert(Target.selector); ops.lock(address(adapter));
        vm.prank(treasury); ops.lock(address(adapter));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.deploy(bytes32(uint256(8)), init); // deploy phase over for good
        // fee collection: adapter with this account as recipient
        vm.prank(treasury); vm.expectRevert(Target.selector); ops.lock(address(adapter)); // lock once
        vm.prank(EP); ops.execute(address(adapter), 0, abi.encodeWithSignature("collectFees()"));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(adapter), 0, abi.encodeWithSignature("reclaim(bytes32)", bytes32(0)));
        // treasury transfers keep a 4 x maxGasPerOp buffer; nobody else can receive
        deal(address(token), address(ops), 1_000_000);
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (attacker, 1)));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (treasury, 800_001)));
        vm.prank(EP); ops.execute(address(token), 0, abi.encodeCall(IERC20.transfer, (treasury, 800_000)));
        assertEq(token.balanceOf(treasury), 800_000);
        vm.prank(EP); vm.expectRevert(GasCap.selector); ops.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 50_001)));
        vm.prank(EP); ops.execute(address(token), 0, abi.encodeCall(IERC20.approve, (PM, 50_000)));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(token), 0, abi.encodeCall(IERC20.approve, (attacker, 1)));
        vm.prank(EP); vm.expectRevert(Target.selector); ops.execute(address(adapter), 1, abi.encodeWithSignature("collectFees()"));
    }
    function test_permit_capFollowsPhase_treasuryControls() public {
        bytes32 dom = token.DOMAIN_SEPARATOR(); uint256 dlx = block.timestamp + 600;
        bytes32 big = _pd(dom, 1_000_000, dlx); bytes32 small = _pd(dom, 50_000, dlx);
        assertEq(ops.isValidSignature(big, _ps(1_000_000, dlx, big)), bytes4(0x1626ba7e));   // deploy phase: big ops allowed
        vm.prank(treasury); ops.lock(address(adapter));
        assertEq(ops.isValidSignature(big, _ps(1_000_000, dlx, big)), bytes4(0xffffffff));   // after lock: fee-collection cap
        assertEq(ops.isValidSignature(small, _ps(50_000, dlx, small)), bytes4(0x1626ba7e));
        vm.expectRevert(NotAccount.selector); ops.configure(attacker, 1, 1);
        vm.prank(treasury); ops.configure(vm.addr(0xBEEF), 40_000, 0);
        assertEq(ops.isValidSignature(small, _ps(50_000, dlx, small)), bytes4(0xffffffff));
        deal(address(token), address(ops), 5);
        vm.expectRevert(NotAccount.selector); ops.withdraw(IERC20(address(token)), attacker, 5);
        vm.prank(treasury); ops.withdraw(IERC20(address(token)), treasury, 5);
    }
    function _pd(bytes32 dom, uint256 v, uint256 dlx) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", dom, keccak256(abi.encode(keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"), address(ops), PM, v, uint256(0), dlx))));
    }
    function _ps(uint256 v, uint256 dlx, bytes32 d) internal pure returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = VmSign(address(uint160(uint256(keccak256("hevm cheat code"))))).sign(SIG, d);
        return abi.encode(PM, v, uint256(0), dlx, abi.encodePacked(r, s, vv));
    }
}
interface VmSign { function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32); }
