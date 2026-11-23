// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {S} from "./SpmCast.sol";
import {Test} from "forge-std/Test.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {PublicERC6492Validator} from "spm/PublicERC6492Validator.sol";
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {KipurseTrustV5} from "../src/KipurseTrustV5.sol";
import {KipurseAdapterV5, PayerVaultV5, PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {KipurseMerchantRegistry} from "../src/KipurseMerchantRegistry.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";
import {MockEIP3009} from "./MockEIP3009.sol";

/// Shared fixture: real Coinbase Smart Wallet + real SpendPermissionManager + EIP-3009 USDC fixture.
abstract contract V5Base is Test {
    CoinbaseSmartWalletFactory factory; CoinbaseSmartWallet wallet;
    SpendPermissionManager manager; MockEIP3009 token; KipurseAdapterV5 adapter; KipurseMerchantRegistry registry;
    PayerVaultFactoryV5 vaultFactory; KipurseFeeControllerV5 feeCtl; KipurseTrustV5 trustC;
    ISpendPermissionManager.SpendPermission p;

    uint256 ownerKey = 0x0E1; address owner;
    address executor = address(0xA001); address guardian = address(0xA002);
    address maintainer = address(0x5AFE); address feeSafe = address(0xFEE5); address feeAdmin = address(0xFEEA);
    address facilitator = address(0xFAC);

    // merchants
    uint256 kBid = 0xB1D; address bidSigner; address bidPayee = address(0xB1D0);   // ExampleShop (owner-trusted)
    bytes32 constant EXAMPLESHOP = keccak256("exampleshop.example");
    uint256 kReg = 0x4E6; address regSigner; address regPayee = address(0x4E60);     // a registry-verified merchant
    bytes32 constant REGM = keccak256("verified-shop.example");
    uint256 kEvil = 0xE511; address evilSigner; address attacker = address(0xBAD);
    address stranger = address(0xD002);

    uint48 constant T0 = 1_700_000_000;
    uint256 constant FEE_PPM = 1000;     // 0.1%, pure percentage (owner decision 2026-10-17), no cap, no minimum
    uint160 constant SINGLE = 6e6; uint160 constant DAILY = 12e6; uint160 constant TERM = 30e6;
    uint160 constant OPEN_SINGLE = 1e5; uint160 constant OPEN_DAILY = 2e5;
    uint160 constant VER_SINGLE = 2e6; uint160 constant VER_DAILY = 5e6;

    uint256 constant MAX_NF = 20_000;    // owner-bounded network fee per payment, default 0.02 USDC
    uint256 nf;                           // network fee the executor passes in the helpers
    uint256 nonceCounter;

    function setUp() public virtual {
        vm.chainId(84532); vm.warp(T0);
        owner = vm.addr(ownerKey); bidSigner = vm.addr(kBid); regSigner = vm.addr(kReg); evilSigner = vm.addr(kEvil);
        factory = new CoinbaseSmartWalletFactory(address(new CoinbaseSmartWallet()));
        bytes[] memory owners = new bytes[](1); owners[0] = abi.encode(owner);
        wallet = factory.createAccount(owners, 0);
        manager = new SpendPermissionManager(new PublicERC6492Validator(), address(0));
        vm.prank(owner); wallet.addOwnerAddress(address(manager));
        token = new MockEIP3009();
        vaultFactory = new PayerVaultFactoryV5(0x0000000071727De22E5E9d8BAf0edAc6f37da032, 0x6C973eBe80dCD8660841D4356bf15c32460271C9, address(0));
        feeCtl = new KipurseFeeControllerV5(feeAdmin, FEE_PPM, feeSafe);
        adapter = new KipurseAdapterV5(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        trustC = adapter.trust();
        registry = new KipurseMerchantRegistry(maintainer, 48 hours);
        p = grant(1, 30, pol(address(registry), TERM));
        token.mint(address(wallet), 100e6);
        // ExampleShop trusted by the owner in the same batch as the approve (one owner signature in production)
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), SINGLE, DAILY, 0);
        // a registry merchant, through the full 48h timelock
        registryAdd(REGM, arr(regPayee), arr(regSigner), 3e6, 6e6, bytes32("r1"));
    }

    // ---------------- helpers ----------------
    function arr(address a) internal pure returns (address[] memory r) { r = new address[](1); r[0] = a; }
    function arr2(address a, address b) internal pure returns (address[] memory r) { r = new address[](2); r[0] = a; r[1] = b; }
    function none() internal pure returns (address[] memory r) { r = new address[](0); }

    function polStruct(address reg, uint160 term) internal view returns (KipurseAdapterV5.Policy memory) {
        return KipurseAdapterV5.Policy({executor: executor, guardian: guardian, single: SINGLE, daily: DAILY, term: term,
            openSingle: OPEN_SINGLE, openDaily: OPEN_DAILY, verifiedSingle: VER_SINGLE, verifiedDaily: VER_DAILY,
            registry: reg, maxFeePpm: FEE_PPM, maxNetworkFee: MAX_NF});
    }
    function pol(address reg, uint160 term) internal view returns (bytes memory) { return abi.encode(polStruct(reg, term)); }

    function grant(uint256 salt, uint48 days_, bytes memory extra) internal returns (ISpendPermissionManager.SpendPermission memory q) {
        q = ISpendPermissionManager.SpendPermission({account: address(wallet), spender: address(adapter), token: address(token),
            allowance: termOf(extra), period: uint48(days_ * 1 days), start: uint48(vm.getBlockTimestamp()),
            end: uint48(vm.getBlockTimestamp() + days_ * 1 days), salt: salt, extraData: extra});
        vm.prank(owner); wallet.execute(address(manager), 0, abi.encodeCall(manager.approve, (S(q))));
    }

    /// SPM allowance = the policy's term cap (enforced on chain); malformed test policies get max so other checks fire.
    function termOf(bytes memory extra) internal pure returns (uint160) {
        if (extra.length != 384) return type(uint160).max;
        return abi.decode(extra, (KipurseAdapterV5.Policy)).term;
    }
    function one(bytes32 d) internal pure returns (bytes32[] memory r) { r = new bytes32[](1); r[0] = d; }
    /// expiry 0 in the helpers = the gateway default of 90 days (permanent trust is rejected on chain).
    function trustParams(string memory name, address[] memory payees, address[] memory signers, uint160 s, uint160 d, uint64 exp)
        internal view returns (KipurseTrustV5.TrustParams memory)
    {
        if (exp == 0) exp = uint64(vm.getBlockTimestamp() + 90 days);
        return KipurseTrustV5.TrustParams({merchant: keccak256(bytes(name)), name: name, payees: payees, signers: signers, single: s, daily: d, expiry: exp});
    }
    function ownerSetTrust(string memory m, address[] memory payees, address[] memory signers, uint160 s, uint160 d, uint64 exp) internal {
        vm.prank(owner);
        wallet.execute(address(trustC), 0, abi.encodeCall(trustC.setTrust, (trustParams(m, payees, signers, s, d, exp))));
    }
    /// Owner call from the wallet; owner-control selectors go to the trust contract, the rest to the adapter.
    function ownerCall(bytes memory data) internal {
        vm.prank(owner); wallet.execute(targetFor(data), 0, data);
    }
    function targetFor(bytes memory data) internal view returns (address) {
        bytes4 sel = bytes4(data);
        if (sel == trustC.setTrust.selector || sel == trustC.untrust.selector || sel == trustC.setPaused.selector || sel == trustC.setDeniedPayee.selector
            || sel == trustC.setDeniedSigner.selector || sel == trustC.setRegistryOptOut.selector || sel == trustC.setFloatCap.selector) return address(trustC);
        return address(adapter);
    }
    function registryAdd(bytes32 m, address[] memory payees, address[] memory signers, uint160 s, uint160 d, bytes32 salt) internal {
        vm.prank(maintainer); registry.propose(m, payees, signers, s, d, salt);
        uint256 t = vm.getBlockTimestamp();
        vm.warp(t + 48 hours);
        registry.execute(m, payees, signers, s, d, salt);
        vm.warp(t); // keep the test clock at T0 (record stays valid: validUntil = t + 48h + 90d)
    }

    /// Owner signature through the Coinbase Smart Wallet's ERC-1271 (replay-safe hash, owner index 0).
    function ownerSig(bytes32 digest) internal view returns (bytes memory) { return walletSig(wallet, ownerKey, digest); }
    function walletSig(CoinbaseSmartWallet w, uint256 k, bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, w.replaySafeHash(digest));
        return abi.encode(CoinbaseSmartWallet.SignatureWrapper({ownerIndex: 0, signatureData: abi.encodePacked(r, s, v)}));
    }

    function warpBy(uint256 s) internal { vm.warp(vm.getBlockTimestamp() + s); }
    /// Owner-side cap convention used by the V5 plan generator: a cap stated for merchant amounts gets fee headroom
    /// ceil(cap * ppm / 1e6), so payments whose merchant amounts sum to the stated cap always fit (fees floor per payment).
    function withFee(uint256 cap) internal pure returns (uint160) { return uint160(cap + (cap * FEE_PPM + 999_999) / 1_000_000); }
    function trustDigest(address account, KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes32) {
        (uint64 epoch,,,,) = trustC.trustOf(account, t.merchant);
        return trustC.ownerDigest(keccak256(abi.encode(trustC.TRUST_TYPEHASH(), account, t.merchant, keccak256(bytes(t.name)), epoch,
            keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, n, dline)));
    }
    function dl() internal view returns (uint48) { return uint48(vm.getBlockTimestamp() + 60); }
    function fee(uint256 a) internal pure returns (uint256 f) { f = (a * FEE_PPM + 999_999) / 1_000_000; } // rounded up

    function order(address payee, uint256 amount, uint256 id) internal view returns (KipurseAdapterV5.PaymentOrder memory) {
        return KipurseAdapterV5.PaymentOrder({payee: payee, amount: amount, orderId: bytes32(id), deadline: vm.getBlockTimestamp() + 1800,
            chainId: block.chainid, adapter: address(adapter), payer: address(0)});
    }
    function signOrder(uint256 k, KipurseAdapterV5.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, adapter.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function direct(address payee, uint256 amount, uint256 ref) internal view returns (KipurseAdapterV5.Direct memory) {
        return KipurseAdapterV5.Direct({payee: payee, amount: amount, merchantRef: bytes32(ref), repeatKey: bytes32(0), deadline: vm.getBlockTimestamp() + 600});
    }
    function auth(address to, uint256 value, uint256 ref) internal view returns (KipurseAdapterV5.Auth memory) {
        return KipurseAdapterV5.Auth({to: to, value: value, validAfter: vm.getBlockTimestamp() - 1, validBefore: vm.getBlockTimestamp() + 120,
            merchantRef: bytes32(ref), repeatKey: bytes32(0)});
    }

    function paySigned(uint256 k, address payee, uint256 amount, uint256 id) internal {
        KipurseAdapterV5.PaymentOrder memory o = order(payee, amount, id);
        bytes memory sig = signOrder(k, o);
        vm.prank(executor); adapter.paySigned(p, o, sig, nf, dl());
    }
    function expectSignedRevert(uint256 k, address payee, uint256 amount, uint256 id, bytes memory reason) internal {
        KipurseAdapterV5.PaymentOrder memory o = order(payee, amount, id);
        bytes memory sig = signOrder(k, o);
        vm.prank(executor); vm.expectRevert(reason); adapter.paySigned(p, o, sig, nf, dl());
    }
    function payDirect(address payee, uint256 amount, uint256 ref) internal {
        vm.prank(executor); adapter.payDirect(p, direct(payee, amount, ref), "", nf, dl());
    }
    function expectDirectRevert(address payee, uint256 amount, uint256 ref, bytes memory reason) internal {
        KipurseAdapterV5.Direct memory d = direct(payee, amount, ref);
        vm.prank(executor); vm.expectRevert(reason); adapter.payDirect(p, d, "", nf, dl());
    }
    function prepare(KipurseAdapterV5.Auth memory a) internal returns (address vault, bytes32 digest, bytes32 nonce) {
        vm.prank(executor); (vault, digest, nonce) = adapter.prepareAuthorization(p, a, "", nf, dl());
    }
    function settle(address vault, KipurseAdapterV5.Auth memory a, bytes32 nonce) internal {
        vm.prank(facilitator); token.transferWithAuthorization(vault, a.to, a.value, a.validAfter, a.validBefore, nonce, hex"00");
    }
    function vault() internal view returns (address) { return adapter.vaultAddress(address(wallet)); }
    function ph() internal view returns (bytes32) { return manager.getHash(S(p)); }
}
