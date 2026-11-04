// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../src/KipurseErrors.sol";
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {S} from "./SpmCast.sol";
import {Test} from "forge-std/Test.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {PublicERC6492Validator} from "spm/PublicERC6492Validator.sol";
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {KipurseTrustV51} from "../src/KipurseTrustV51.sol";
import {KipurseAdapterV51} from "../src/KipurseAdapterV51.sol";
import {KipurseOrderVerifier} from "../src/KipurseOrderVerifier.sol";
import {PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {KipurseMerchantRegistry} from "../src/KipurseMerchantRegistry.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";
import {MockEIP3009} from "./MockEIP3009.sol";

/// V5.1: stable order verifier + owner signer trust with anyPayee (merchant-attested per-order payees).
contract KipurseV51Test is Test {
    CoinbaseSmartWalletFactory factory; CoinbaseSmartWallet wallet; SpendPermissionManager manager; MockEIP3009 token;
    KipurseAdapterV51 adapter; KipurseTrustV51 trustC; KipurseOrderVerifier ov; PayerVaultFactoryV5 vf; KipurseFeeControllerV5 feeCtl;
    KipurseMerchantRegistry registry; ISpendPermissionManager.SpendPermission p;
    uint256 ownerKey = 0x0E1; address owner; address executor = address(0xA001);
    uint256 kBid = 0xB1D; address bidSigner; uint256 kReg = 0x4E6; address regSigner; address regPayee = address(0x4E60);
    uint256 kEvil = 0xE511;
    uint160 constant SINGLE = 6e6; uint160 constant DAILY = 12e6; uint160 constant TERM = 30e6;
    uint160 constant OPEN_SINGLE = 1e5; uint160 constant OPEN_DAILY = 2e5;
    uint256 constant FEE_PPM = 1000;

    function setUp() public {
        vm.chainId(84532); vm.warp(1_700_000_000);
        owner = vm.addr(ownerKey); bidSigner = vm.addr(kBid); regSigner = vm.addr(kReg);
        factory = new CoinbaseSmartWalletFactory(address(new CoinbaseSmartWallet()));
        bytes[] memory owners = new bytes[](1); owners[0] = abi.encode(owner); wallet = factory.createAccount(owners, 0);
        manager = new SpendPermissionManager(new PublicERC6492Validator(), address(0));
        vm.prank(owner); wallet.addOwnerAddress(address(manager));
        token = new MockEIP3009();
        vf = new PayerVaultFactoryV5(0x0000000071727De22E5E9d8BAf0edAc6f37da032, 0x6C973eBe80dCD8660841D4356bf15c32460271C9, address(0));
        feeCtl = new KipurseFeeControllerV5(address(0xFEEA), FEE_PPM, address(0xFEE5));
        ov = new KipurseOrderVerifier(ISpendPermissionManager(address(manager)));
        adapter = newAdapter();
        trustC = adapter.trust();
        registry = new KipurseMerchantRegistry(address(0x5AFE), 48 hours);
        p = grant(adapter, 1);
        token.mint(address(wallet), 100e6);
        // ExampleShop: trusted by ORDER SIGNER alone, any per-order payee (Stripe deposit mode), merchant caps 6 / 12
        setTrust(trustC, "exampleshop.example", none(), arr(bidSigner), SINGLE, DAILY, true);
    }

    // ---------------- helpers ----------------
    function newAdapter() internal returns (KipurseAdapterV51) {
        return new KipurseAdapterV51(ISpendPermissionManager(address(manager)), IERC20(address(token)), vf, feeCtl, ov);
    }
    function arr(address a) internal pure returns (address[] memory r) { r = new address[](1); r[0] = a; }
    function none() internal pure returns (address[] memory r) { r = new address[](0); }
    function polBytes() internal view returns (bytes memory) {
        return abi.encode(KipurseAdapterV51.Policy({executor: executor, guardian: address(0), single: SINGLE, daily: DAILY, term: TERM,
            openSingle: OPEN_SINGLE, openDaily: OPEN_DAILY, verifiedSingle: 2e6, verifiedDaily: 5e6, registry: address(registry), maxFeePpm: FEE_PPM, maxNetworkFee: 20_000}));
    }
    function grant(KipurseAdapterV51 a, uint256 salt) internal returns (ISpendPermissionManager.SpendPermission memory q) {
        q = ISpendPermissionManager.SpendPermission({account: address(wallet), spender: address(a), token: address(token), allowance: TERM,
            period: 30 days, start: uint48(block.timestamp), end: uint48(block.timestamp + 30 days), salt: salt, extraData: polBytes()});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
    }
    function tp(string memory name, address[] memory payees, address[] memory signers, uint160 s, uint160 d, bool any)
        internal view returns (KipurseTrustV51.TrustParams memory)
    {
        return KipurseTrustV51.TrustParams({merchant: keccak256(bytes(name)), name: name, payees: payees, signers: signers, single: s, daily: d,
            expiry: uint64(block.timestamp + 90 days), anyPayee: any});
    }
    function setTrust(KipurseTrustV51 t, string memory name, address[] memory payees, address[] memory signers, uint160 s, uint160 d, bool any) internal {
        vm.prank(owner); wallet.execute(address(t), 0, abi.encodeCall(t.setTrust, (tp(name, payees, signers, s, d, any))));
    }
    function ord(address payee, uint256 amount, uint256 id) internal view returns (KipurseOrderVerifier.PaymentOrder memory) {
        return KipurseOrderVerifier.PaymentOrder({payee: payee, amount: amount, orderId: bytes32(id), deadline: block.timestamp + 1800, payer: address(0)});
    }
    function sign(uint256 k, KipurseOrderVerifier.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, ov.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function dl() internal view returns (uint48) { return uint48(block.timestamp + 60); }
    function paySigned(KipurseAdapterV51 a, ISpendPermissionManager.SpendPermission memory q, uint256 k, KipurseOrderVerifier.PaymentOrder memory o) internal {
        bytes memory sig = sign(k, o); vm.prank(executor); a.paySigned(q, o, sig, 0, dl());
    }
    function expectSigned(uint256 k, KipurseOrderVerifier.PaymentOrder memory o, bytes4 err) internal {
        bytes memory sig = sign(k, o); vm.prank(executor); vm.expectRevert(err); adapter.paySigned(p, o, sig, 0, dl());
    }
    function direct(address payee, uint256 amount, uint256 ref) internal view returns (KipurseAdapterV51.Direct memory) {
        return KipurseAdapterV51.Direct({payee: payee, amount: amount, merchantRef: bytes32(ref), repeatKey: bytes32(0), deadline: block.timestamp + 600});
    }
    function fresh(uint256 i) internal pure returns (address) { return address(uint160(uint256(keccak256(abi.encode("deposit", i))))); }

    // ---------------- anyPayee ----------------
    function test_anyPayee_signedOrderToFreshPerOrderPayee_atTrustedCap() public {
        address dep = fresh(1);
        paySigned(adapter, p, kBid, ord(dep, SINGLE, 1));                       // 6.00 = the merchant per-payment cap
        assertEq(token.balanceOf(dep), SINGLE);
        address dep2 = fresh(2);
        paySigned(adapter, p, kBid, ord(dep2, 99e4, 2));                        // ExampleShop-style 0.99 to another fresh address
        assertEq(token.balanceOf(dep2), 99e4);
        (uint64 ep,,,,,) = trustC.trustOf(address(wallet), keccak256("exampleshop.example"));
        assertEq(ep, 1);
    }
    function test_anyPayee_merchantCapsStillApply() public {
        expectSigned(kBid, ord(fresh(3), uint256(SINGLE) + 1, 3), Amount.selector);  // policy single
        setTrust(trustC, "exampleshop.example", none(), arr(bidSigner), 1e6, 2e6, true);       // owner lowers merchant caps
        expectSigned(kBid, ord(fresh(4), 1e6 + 1, 4), MerchantCap.selector);
        paySigned(adapter, p, kBid, ord(fresh(5), 1e6, 5));
        paySigned(adapter, p, kBid, ord(fresh(6), 99e4, 6));
        expectSigned(kBid, ord(fresh(7), 1e4, 7), MerchantDailyCap.selector);      // 1.0+0.99+fees ~1.992; +0.01 > 2.0
    }
    function test_unsignedToSameFreshAddress_staysStranger() public {
        address dep = fresh(8);
        KipurseAdapterV51.Direct memory d = direct(dep, 99e4, 8);
        vm.prank(executor); vm.expectRevert(BadStranger.selector); adapter.payDirect(p, d, "", 0, dl());
        vm.prank(executor); adapter.payDirect(p, direct(dep, OPEN_SINGLE, 9), "", 0, dl()); // within the stranger cap: ok
        assertEq(token.balanceOf(dep), OPEN_SINGLE);
    }
    function test_revokedSigner_rejected_deny_and_untrust() public {
        vm.prank(owner); wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setDeniedSigner, (bidSigner, true)));
        expectSigned(kBid, ord(fresh(10), 1e6, 10), BadSignerDenied.selector);
        vm.prank(owner); wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setDeniedSigner, (bidSigner, false)));
        vm.prank(owner); wallet.execute(address(trustC), 0, abi.encodeCall(trustC.untrust, (keccak256("exampleshop.example"))));
        expectSigned(kBid, ord(fresh(11), 1e6, 11), Signer.selector);
    }
    function test_payeeBoundRecord_stillBinds() public {
        address shopPayee = address(0x5A0);
        setTrust(trustC, "shop.example", arr(shopPayee), arr(vm.addr(kEvil)), 1e6, 2e6, false);
        expectSigned(kEvil, ord(fresh(12), 1e5, 12), PayeeBinding.selector);
        paySigned(adapter, p, kEvil, ord(shopPayee, 1e5, 13));
    }
    function test_unknownSigner_rejected() public { expectSigned(0xDEAD, ord(fresh(14), 1e4, 14), Signer.selector); }
    function test_trustValidation_anyPayeeNeedsSigner() public {
        KipurseTrustV51.TrustParams memory t = tp("x.example", none(), none(), 1e6, 2e6, true);
        vm.prank(owner); vm.expectRevert(); wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setTrust, (t)));
        t = tp("y.example", none(), arr(bidSigner), 1e6, 2e6, false);           // no payees and not anyPayee: invalid
        vm.prank(owner); vm.expectRevert(); wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setTrust, (t)));
    }
    function test_trustBySig_coversAnyPayeeFlag() public {
        KipurseTrustV51.TrustParams memory t = tp("sig.example", arr(address(0x5160)), arr(vm.addr(kEvil)), 1e6, 2e6, true);
        bytes32 n = keccak256("n1"); uint256 dline = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(trustC.TRUST_TYPEHASH(), address(wallet), t.merchant, keccak256(bytes(t.name)), uint64(0),
            keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, false, n, dline)); // signed anyPayee=false
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, wallet.replaySafeHash(trustC.ownerDigest(sh)));
        bytes memory sig = abi.encode(CoinbaseSmartWallet.SignatureWrapper({ownerIndex: 0, signatureData: abi.encodePacked(r, s, v)}));
        vm.expectRevert(OwnerSig.selector); trustC.trustBySig(address(wallet), t, n, dline, sig);   // relayer flips the flag: rejected
        t.anyPayee = false; trustC.trustBySig(address(wallet), t, n, dline, sig);
        (,,,,, bool any) = trustC.trustOf(address(wallet), t.merchant); assertFalse(any);
    }
    function test_registrySigner_stillPayeeBound() public {
        vm.prank(address(0x5AFE)); registry.propose(keccak256("verified.example"), arr(regPayee), arr(regSigner), 1e6, 2e6, bytes32("r"));
        vm.warp(block.timestamp + 48 hours); registry.execute(keccak256("verified.example"), arr(regPayee), arr(regSigner), 1e6, 2e6, bytes32("r"));
        expectSigned(kReg, ord(fresh(15), 1e5, 15), PayeeBinding.selector);
    }

    // ---------------- stable verifier ----------------
    function test_verifier_domainIndependentOfAdapter_and_crossAdapterExactlyOnce() public {
        KipurseOrderVerifier.PaymentOrder memory o = ord(fresh(20), 5e5, 20);
        bytes memory sig = sign(kBid, o);
        vm.prank(executor); adapter.paySigned(p, o, sig, 0, dl());
        // owner migrates to a NEW adapter (renewal batch): revoke old, grant new, re-trust; the merchant's signature is unchanged
        KipurseAdapterV51 a2 = newAdapter();
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.revoke, (S(p))));
        ISpendPermissionManager.SpendPermission memory q = grant(a2, 2);
        setTrust(a2.trust(), "exampleshop.example", none(), arr(bidSigner), SINGLE, DAILY, true);
        assertEq(a2.orderDigest(o), adapter.orderDigest(o));
        vm.prank(executor); vm.expectRevert(Duplicate.selector); a2.paySigned(q, o, sig, 0, dl());   // already paid via the old adapter
        paySigned(a2, q, kBid, ord(fresh(21), 5e5, 21));                                              // new orders work on the new adapter
        // the revoked old adapter cannot consume anything any more
        KipurseOrderVerifier.PaymentOrder memory o3 = ord(fresh(22), 5e5, 22); bytes memory s3 = sign(kBid, o3);
        vm.prank(executor); vm.expectRevert(); adapter.paySigned(p, o3, s3, 0, dl());
    }
    function test_verifier_onlySpenderOfValidPermission() public {
        KipurseOrderVerifier.PaymentOrder memory o = ord(fresh(30), 1e5, 30); bytes memory sig = sign(kBid, o);
        vm.prank(address(0xBAD)); vm.expectRevert(Permission.selector); ov.consume(p, o, sig);           // not the spender
        // an attacker with its OWN wallet + permission (spender = attacker contract) only burns its own namespace
        assertFalse(ov.used(address(wallet), bidSigner, o.orderId));
        vm.prank(executor); adapter.paySigned(p, o, sig, 0, dl());
        assertTrue(ov.used(address(wallet), bidSigner, o.orderId));
    }
    function test_verifier_payerBinding_and_deadline() public {
        KipurseOrderVerifier.PaymentOrder memory o = ord(fresh(31), 1e5, 31); o.payer = address(0xC0FFEE);
        expectSigned(kBid, o, Payer.selector);
        o.payer = address(wallet); paySigned(adapter, p, kBid, o);                                       // bound to THIS wallet: ok
        KipurseOrderVerifier.PaymentOrder memory e = ord(fresh(32), 1e5, 32); e.deadline = block.timestamp;
        expectSigned(kBid, e, Expired.selector);
        KipurseOrderVerifier.PaymentOrder memory z = ord(fresh(33), 1e5, 0);
        expectSigned(kBid, z, Expired.selector);
    }
    function test_verifier_tamperedOrder_isUnknownSigner() public {
        KipurseOrderVerifier.PaymentOrder memory o = ord(fresh(34), 1e5, 34); bytes memory sig = sign(kBid, o);
        o.payee = address(0xBAD);
        vm.prank(executor); vm.expectRevert(Signer.selector); adapter.paySigned(p, o, sig, 0, dl());
    }
    function test_verifier_domainSeparator_isStable() public view {
        bytes32 want = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Kipurse PaymentOrder"), keccak256("1"), uint256(84532), address(ov)));
        assertEq(ov.domainSeparator(), want);
        assertEq(ov.ORDER_TYPEHASH(), keccak256("PaymentOrder(address payee,uint256 amount,bytes32 orderId,uint256 deadline,address payer)"));
    }
    function testFuzz_anyPayee_anyFreshPayee_exactAmount(uint256 seed, uint256 amount) public {
        amount = bound(amount, 1, SINGLE); address dep = fresh(seed % 1e12 + 1000);
        vm.assume(dep != address(wallet) && dep != address(adapter) && dep != address(token) && dep != address(manager) && dep != adapter.vaultAddress(address(wallet)));
        uint256 b0 = token.balanceOf(dep);
        paySigned(adapter, p, kBid, ord(dep, amount, 1));
        assertEq(token.balanceOf(dep) - b0, amount);
    }
}
