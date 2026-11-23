// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../V5Base.sol";
import {Vm} from "forge-std/Vm.sol";
import "../../src/KipurseErrors.sol";
import "../../src/KipurseErrorsV55.sol";
import {KipurseAdapterV55} from "../../src/KipurseAdapterV55.sol";
import {KipurseTrustV55} from "../../src/KipurseTrustV55.sol";
import {PayerVaultV55, PayerVaultFactoryV55} from "../../src/KipursePayerVaultV55.sol";
import {KipurseFloatVaultV55} from "../../src/KipurseFloatVaultV55.sol";
import {KipurseKeySeatV2} from "../../src/KipurseKeySeatV2.sol";
import {KipurseMerchantRegistryV2} from "../../src/KipurseMerchantRegistryV2.sol";
import {PackedUserOperation} from "../../src/KipurseAdapterV5.sol";

/// Shared fixture for the V5.5 suites (handbook §6#119): the V5Base world (real Coinbase Smart Wallet, real
/// SpendPermissionManager, EIP-3009 USDC fixture, registry) with KipurseAdapterV55 + KipurseTrustV55 + PayerVaultFactoryV55
/// swapped in (the deployed KipurseFeeControllerV5 is reused unchanged). Port of test/invariant/V54Base.t.sol.
abstract contract V55Base is V5Base {
    KipurseAdapterV55 a5; KipurseTrustV55 t5; PayerVaultFactoryV55 vf5;

    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant PM = 0x6C973eBe80dCD8660841D4356bf15c32460271C9;
    uint160 constant TERM55 = 120e6;          // term = SPM allowance of the V5.5 permission
    uint256 constant WALLET_FUNDS = 300e6;    // minted on top of V5Base's 100e6
    uint256 constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    // signer-trust grant: merchant GM's order signer may name any per-order payee
    uint256 constant K_SHOP = 0x5109; address shopSigner;
    string constant GNAME = "deposits.example"; bytes32 constant GM = keccak256(bytes("deposits.example"));
    uint160 constant GS = 3e6; uint160 constant GD = 8e6;

    // inline payee trust (KPTR) for one payee
    string constant INAME = "inline.example"; bytes32 constant IM = keccak256(bytes("inline.example"));
    address constant INLINE_PAYEE = address(0x1A1A);
    uint160 constant IS = 2e6; uint160 constant ID = 5e6;

    uint256 constant K_ATTACKER = 0xBADBAD;    // a key that is NOT an owner of the wallet
    address constant FLOAT_PAYEE = address(0xF10A7);
    uint256 constant K_FLOAT_SESSION = 0xF5E5;

    // key seat (V2)
    KipurseKeySeatV2 seat; uint256 constant SEAT_IDX = 1;

    function setUp() public virtual override {
        super.setUp();
        vf5 = new PayerVaultFactoryV55(EP, PM, address(0));
        a5 = new KipurseAdapterV55(ISpendPermissionManager(address(manager)), IERC20(address(token)), vf5, feeCtl);
        adapter = KipurseAdapterV5(address(a5)); // V5Base helpers that only need the shared ABI (identical structs / selectors)
        t5 = a5.trust(); trustC = KipurseTrustV5(address(t5));
        p = grant(55, 30, pol(address(registry), TERM55));
        token.mint(address(wallet), WALLET_FUNDS);
        shopSigner = vm.addr(K_SHOP);
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), SINGLE, DAILY, 0); // stored trust on the V5.5 trust
    }

    // ---------------- key-seat wallet (owners [owner, seat, SPM] fixed at creation) ----------------
    /// Replace the fixture wallet by a key-seat wallet (the production layout), fund it, grant a permission, trust ExampleShop.
    function useSeatWallet() internal {
        seat = new KipurseKeySeatV2{salt: keccak256("kipurse-key-seat-v2")}(address(factory), owner, address(manager), address(t5));
        bytes[] memory owners = new bytes[](3);
        owners[0] = abi.encode(owner); owners[1] = abi.encode(address(seat)); owners[2] = abi.encode(address(manager));
        wallet = factory.createAccount(owners, 0);
        token.mint(address(wallet), WALLET_FUNDS + 100e6);
        p = grant(56, 30, pol(address(registry), TERM55));
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), SINGLE, DAILY, 0);
    }
    function seatSetKey(uint256 pk) internal {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        vm.prank(owner); wallet.execute(address(seat), 0, abi.encodeCall(KipurseKeySeatV2.setKey, (px, py)));
    }
    /// P-256 signature by `pk` over wallet.replaySafeHash(digest), normalized to low-s (KL-5), wrapped for the seat owner.
    function seatSig(uint8 kind, bytes memory body, bytes32 digest, uint256 pk) internal view returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, wallet.replaySafeHash(digest));
        uint256 su = uint256(s); if (su > P256_N / 2) su = P256_N - su;
        return abi.encode(CoinbaseSmartWallet.SignatureWrapper(SEAT_IDX, abi.encode(kind, body, uint256(r), su)));
    }

    // ---------------- typed V5.5 helpers ----------------
    function dirV(address payee, uint256 amount, uint256 ref_) internal view returns (KipurseAdapterV55.Direct memory) {
        return KipurseAdapterV55.Direct({payee: payee, amount: amount, merchantRef: bytes32(ref_), repeatKey: bytes32(0),
            deadline: vm.getBlockTimestamp() + 600});
    }
    function ordV(address payee, uint256 amount, uint256 id, address payer) internal view returns (KipurseAdapterV55.PaymentOrder memory) {
        return KipurseAdapterV55.PaymentOrder({payee: payee, amount: amount, orderId: bytes32(id), deadline: vm.getBlockTimestamp() + 1800,
            chainId: block.chainid, adapter: address(a5), payer: payer});
    }
    function signOrdV(uint256 k, KipurseAdapterV55.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, a5.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function authV(address to, uint256 value, uint256 ref_) internal view returns (KipurseAdapterV55.Auth memory) {
        return KipurseAdapterV55.Auth({to: to, value: value, validAfter: vm.getBlockTimestamp() - 1, validBefore: vm.getBlockTimestamp() + 120,
            merchantRef: bytes32(ref_), repeatKey: bytes32(0)});
    }
    /// One-time owner approval (C6), signed by key k through the wallet's ERC-1271 (k != owner => forged).
    function approvalBy(uint256 k, bytes32 key, address payee, uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return walletSig(wallet, k, a5.approvalDigest(address(wallet), key, payee, amount, deadline));
    }
    function inlineParams() internal view returns (KipurseTrustV5.TrustParams memory) {
        return trustParams(INAME, arr(INLINE_PAYEE), none(), IS, ID, uint64(vm.getBlockTimestamp() + 180 days));
    }
    /// V5.5 KR-01: digest of the inline payee trust = OwnerInlineTrust typed data at the CURRENT trust epoch of t.merchant.
    function inlineDigest(address account, KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes32) {
        (uint64 epoch,,,,) = t5.trustOf(account, t.merchant);
        return t5.ownerDigest(keccak256(abi.encode(t5.INLINE_TRUST_TYPEHASH(), account, t.merchant, keccak256(bytes(t.name)), epoch,
            keccak256(abi.encodePacked(t.payees)), keccak256(abi.encodePacked(t.signers)), t.single, t.daily, t.expiry, n, dline)));
    }
    /// KPTR inline payee trust blob at the CURRENT trust epoch, signed by key k (OwnerInlineTrust).
    function inlineBlob(uint256 k, KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        bytes memory sig = walletSig(wallet, k, inlineDigest(address(wallet), t, n, dline));
        return abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
    }
    function grantParams(address[] memory signers, uint160 s, uint160 d) internal view returns (KipurseTrustV55.SignerTrust memory) {
        return KipurseTrustV55.SignerTrust({merchant: GM, name: GNAME, signers: signers, single: s, daily: d,
            expiry: uint64(vm.getBlockTimestamp() + 180 days)});
    }
    /// OwnerSignerTrust grant blob at the CURRENT epoch of t.merchant, signed by key k through the wallet.
    function grantBlob(uint256 k, KipurseTrustV55.SignerTrust memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        bytes32 dg = t5.ownerDigest(t5.signerTrustStructHash(address(wallet), t, n, dline));
        return abi.encode(t, n, dline, walletSig(wallet, k, dg));
    }
    function ownerExec(address target, bytes memory data) internal {
        vm.prank(owner); wallet.execute(target, 0, data);
    }
    function vaultV() internal view returns (address) { return a5.vaultAddress(address(wallet)); }
    function floatV() internal view returns (address) { return a5.floatAddress(address(wallet)); }
    function phV() internal view returns (bytes32) { return manager.getHash(S(p)); }
    function today() internal view returns (uint256) { return (vm.getBlockTimestamp() - p.start) / 1 days; }
    function feeAt(uint256 amount, uint256 ppm) internal pure returns (uint256) { return (amount * ppm + 999_999) / 1_000_000; }
    function voucher(uint256 k, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 n)
        internal view returns (bytes memory)
    {
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, n))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, d);
        return abi.encode(to, value, va, vb, n, abi.encodePacked(r, s, v));
    }
}
