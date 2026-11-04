// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {KipurseTrustV5} from "../../src/KipurseTrustV5.sol";
import {KipurseAdapterV5} from "../../src/KipurseAdapterV5.sol";
import {ISpendPermissionManager} from "../../src/ISpendPermissionManager.sol";
import {KipursePhoneApprover} from "../../src/KipursePhoneApprover.sol";
import {KipursePhoneApproverV2} from "../../src/KipursePhoneApproverV2.sol";
interface IERC20B { function balanceOf(address) external view returns (uint256); }
/// FORK ONLY. Nothing is broadcast. No deployment data lives in this file: the operator passes it by env.
///   FORK_URL         Base mainnet RPC
///   FORK_PERMISSION  abi-encoded SpendPermission of a live Kipurse account (public on chain); its account/spender pick
///                    the wallet and the adapter, the adapter picks the trust contract.
/// The wallet's address owner at index 0 is impersonated only inside the fork to add the test approver.
contract PhoneApproverMainnetFork is Test {
    uint256 PK = 0xC0FFEE1234; CoinbaseSmartWallet W; KipurseAdapterV5 A; KipurseTrustV5 T; address OWNER;
    ISpendPermissionManager.SpendPermission P; KipurseAdapterV5.Policy POL;
    function setUp() public {
        string memory u = vm.envOr("FORK_URL", string("")); bytes memory perm = vm.envOr("FORK_PERMISSION", bytes(""));
        if (bytes(u).length == 0 || perm.length == 0) { vm.skip(true); return; }
        vm.createSelectFork(u);
        P = abi.decode(perm, (ISpendPermissionManager.SpendPermission));
        W = CoinbaseSmartWallet(payable(P.account)); A = KipurseAdapterV5(P.spender); T = A.trust();
        OWNER = abi.decode(W.ownerAtIndex(0), (address));
        POL = abi.decode(P.extraData, (KipurseAdapterV5.Policy));
    }
    function _add(address ap) internal returns (uint256 idx) { vm.prank(OWNER); W.addOwnerAddress(ap); idx = W.nextOwnerIndex() - 1; }
    function test_fork_realWallet_phoneTrust_v1() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PK);
        KipursePhoneApprover ap = new KipursePhoneApprover(address(W), address(T), x, y, 10e6, 12e6); uint256 idx = _add(address(ap));
        KipursePhoneApprover.TrustParams memory t; t.name = "fork-self"; t.merchant = keccak256(bytes(t.name)); t.payees = new address[](1); t.payees[0] = OWNER; t.signers = new address[](0);
        t.single = 0.05e6; t.daily = 0.05e6; t.expiry = uint64(block.timestamp + 30 days);
        bytes32 n = keccak256("fork-n"); uint256 dline = block.timestamp + 600;
        bytes32 h = W.replaySafeHash(T.ownerDigest(ap.structHashOf(1, abi.encode(t, n, dline)))); (bytes32 r, bytes32 s) = vm.signP256(PK, h);
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(1), abi.encode(t, n, dline), uint256(r), uint256(s))));
        vm.prank(address(0xE11)); T.trustBySig(address(W), KipurseTrustV5.TrustParams(t.merchant, t.name, t.payees, t.signers, t.single, t.daily, t.expiry), n, dline, sig);
        (bytes32 m,,) = T.payeeTrust(address(W), OWNER); assertEq(m, t.merchant);
        vm.prank(OWNER); W.removeOwnerAtIndex(idx, abi.encode(address(ap))); assertFalse(W.isOwnerAddress(address(ap)));
    }
    /// End-to-end on the fork: phone P-256 approval -> real adapter payDirect by the real executor -> payee receives, fees charged.
    function test_fork_realWallet_phonePay_v2() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PK);
        KipursePhoneApproverV2 ap = new KipursePhoneApproverV2(address(W), address(T), x, y, 1e6, 2e6); uint256 idx = _add(address(ap));
        address payee = makeAddr("fork-payee"); IERC20B usdc = IERC20B(P.token);
        KipurseAdapterV5.Direct memory d = KipurseAdapterV5.Direct(payee, 0.01e6, keccak256("fork-ref"), bytes32(0), block.timestamp + 600);
        bytes32 key = A.purchaseKey(d.payee, d.merchantRef, d.repeatKey);
        (bytes32 r, bytes32 s) = vm.signP256(PK, W.replaySafeHash(A.approvalDigest(address(W), key, d.payee, d.amount, d.deadline)));
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(4), abi.encode(key, d.payee, d.amount, d.deadline), uint256(r), uint256(s))));
        // tampered amount -> rejected
        KipurseAdapterV5.Direct memory bad = KipurseAdapterV5.Direct(d.payee, 0.02e6, d.merchantRef, d.repeatKey, d.deadline);
        vm.prank(POL.executor); vm.expectRevert(); A.payDirect(P, bad, sig, 0, uint48(block.timestamp + 60));
        uint256 w0 = usdc.balanceOf(address(W));
        vm.prank(POL.executor); A.payDirect(P, d, sig, 0, uint48(block.timestamp + 60));
        assertEq(usdc.balanceOf(payee), 0.01e6, "payee received exactly the amount");
        assertEq(w0 - usdc.balanceOf(address(W)), 0.01e6 + A.feeFor(0.01e6), "amount + protocol fee from the wallet");
        // replay -> rejected; revoked phone -> rejected
        vm.prank(POL.executor); vm.expectRevert(); A.payDirect(P, d, sig, 0, uint48(block.timestamp + 60));
        vm.prank(OWNER); W.removeOwnerAtIndex(idx, abi.encode(address(ap)));
        KipurseAdapterV5.Direct memory d2 = KipurseAdapterV5.Direct(d.payee, d.amount, keccak256("fork-ref-2"), bytes32(0), d.deadline); key = A.purchaseKey(d2.payee, d2.merchantRef, d2.repeatKey);
        (r, s) = vm.signP256(PK, W.replaySafeHash(A.approvalDigest(address(W), key, d2.payee, d2.amount, d2.deadline)));
        sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper(idx, abi.encode(uint8(4), abi.encode(key, d2.payee, d2.amount, d2.deadline), uint256(r), uint256(s))));
        vm.prank(POL.executor); vm.expectRevert(); A.payDirect(P, d2, sig, 0, uint48(block.timestamp + 60));
    }
    /// Gas of the real deployment + enrollment calls (estimate for the mainnet plan; nothing broadcast).
    function test_fork_gas_v2_deploy() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PK);
        emit log_named_uint("initcode_bytes", type(KipursePhoneApproverV2).creationCode.length);
        KipursePhoneApproverV2 ap = new KipursePhoneApproverV2(address(W), address(T), x, y, 1e6, 2e6);
        emit log_named_uint("runtime_bytes", address(ap).code.length); uint256 g = gasleft(); _add(address(ap)); emit log_named_uint("addOwner_gas", g - gasleft());
    }
}
