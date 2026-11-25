// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "../V5Base.sol";
import "../../src/KipurseErrors.sol";
import {KipurseAdapterV54} from "../../src/KipurseAdapterV54.sol";
import {KipurseTrustV54} from "../../src/KipurseTrustV54.sol";
import {PayerVaultV5, PackedUserOperation} from "../../src/KipurseAdapterV5.sol";
import {KipurseFloatVaultV5} from "../../src/KipurseFloatVaultV5.sol";

/// Shared fixture for the V5.4 invariant / fuzz suites (t1214 decision 118): the V5Base world (real Coinbase Smart Wallet, real
/// SpendPermissionManager, EIP-3009 USDC fixture, registry) with the LIVE KipurseAdapterV54 + KipurseTrustV54 swapped in.
/// Typed helpers use the V5.4 structs directly (no cast through the V5 ABI).
abstract contract V54Base is V5Base {
    KipurseAdapterV54 a4; KipurseTrustV54 t4;

    uint160 constant TERM54 = 120e6;          // term = SPM allowance of the V5.4 permission
    uint256 constant WALLET_FUNDS = 300e6;    // minted on top of V5Base's 100e6

    // V5.4 signer-trust grant (decision 99): merchant GM's order signer may name any per-order payee
    uint256 constant K_SHOP = 0x5109; address shopSigner;
    string constant GNAME = "deposits.example"; bytes32 constant GM = keccak256(bytes("deposits.example"));
    uint160 constant GS = 3e6; uint160 constant GD = 8e6;

    // V5.2 inline payee trust (KPTR) for one payee
    string constant INAME = "inline.example"; bytes32 constant IM = keccak256(bytes("inline.example"));
    address constant INLINE_PAYEE = address(0x1A1A);
    uint160 constant IS = 2e6; uint160 constant ID = 5e6;

    uint256 constant K_ATTACKER = 0xBADBAD;    // a key that is NOT an owner of the wallet
    address constant FLOAT_PAYEE = address(0xF10A7);
    uint256 constant K_FLOAT_SESSION = 0xF5E5;

    function setUp() public virtual override {
        super.setUp();
        a4 = new KipurseAdapterV54(ISpendPermissionManager(address(manager)), IERC20(address(token)), vaultFactory, feeCtl);
        adapter = KipurseAdapterV5(address(a4)); // V5Base helpers that only need the shared ABI
        t4 = a4.trust(); trustC = KipurseTrustV5(address(t4));
        p = grant(54, 30, pol(address(registry), TERM54));
        token.mint(address(wallet), WALLET_FUNDS);
        shopSigner = vm.addr(K_SHOP);
        ownerSetTrust("exampleshop.example", arr(bidPayee), arr(bidSigner), SINGLE, DAILY, 0); // stored trust on the V5.4 trust
    }

    // ---------------- typed V5.4 helpers ----------------
    function dirV(address payee, uint256 amount, uint256 ref_) internal view returns (KipurseAdapterV54.Direct memory) {
        return KipurseAdapterV54.Direct({payee: payee, amount: amount, merchantRef: bytes32(ref_), repeatKey: bytes32(0),
            deadline: vm.getBlockTimestamp() + 600});
    }
    function ordV(address payee, uint256 amount, uint256 id, address payer) internal view returns (KipurseAdapterV54.PaymentOrder memory) {
        return KipurseAdapterV54.PaymentOrder({payee: payee, amount: amount, orderId: bytes32(id), deadline: vm.getBlockTimestamp() + 1800,
            chainId: block.chainid, adapter: address(a4), payer: payer});
    }
    function signOrdV(uint256 k, KipurseAdapterV54.PaymentOrder memory o) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, a4.orderDigest(o)); return abi.encodePacked(r, s, v);
    }
    function authV(address to, uint256 value, uint256 ref_) internal view returns (KipurseAdapterV54.Auth memory) {
        return KipurseAdapterV54.Auth({to: to, value: value, validAfter: vm.getBlockTimestamp() - 1, validBefore: vm.getBlockTimestamp() + 120,
            merchantRef: bytes32(ref_), repeatKey: bytes32(0)});
    }
    /// One-time owner approval (C6), signed by key k through the wallet's ERC-1271 (k != owner => forged).
    function approvalBy(uint256 k, bytes32 key, address payee, uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return walletSig(wallet, k, a4.approvalDigest(address(wallet), key, payee, amount, deadline));
    }
    function inlineParams() internal view returns (KipurseTrustV5.TrustParams memory) {
        return trustParams(INAME, arr(INLINE_PAYEE), none(), IS, ID, uint64(vm.getBlockTimestamp() + 180 days));
    }
    /// KPTR inline payee trust blob at the CURRENT trust epoch of IM, signed by key k.
    function inlineBlob(uint256 k, KipurseTrustV5.TrustParams memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        bytes memory sig = walletSig(wallet, k, trustDigest(address(wallet), t, n, dline));
        return abi.encodePacked(bytes4(0x4b505452), abi.encode(t, n, dline, sig));
    }
    function grantParams(address[] memory signers, uint160 s, uint160 d) internal view returns (KipurseTrustV54.SignerTrust memory) {
        return KipurseTrustV54.SignerTrust({merchant: GM, name: GNAME, signers: signers, single: s, daily: d,
            expiry: uint64(vm.getBlockTimestamp() + 180 days)});
    }
    /// V5.4 OwnerSignerTrust grant blob at the CURRENT epoch of t.merchant, signed by key k through the wallet.
    function grantBlob(uint256 k, KipurseTrustV54.SignerTrust memory t, bytes32 n, uint256 dline) internal view returns (bytes memory) {
        bytes32 dg = t4.ownerDigest(t4.signerTrustStructHash(address(wallet), t, n, dline));
        return abi.encode(t, n, dline, walletSig(wallet, k, dg));
    }
    function ownerExec(address target, bytes memory data) internal {
        vm.prank(owner); wallet.execute(target, 0, data);
    }
    function vaultV() internal view returns (address) { return a4.vaultAddress(address(wallet)); }
    function floatV() internal view returns (address) { return a4.floatAddress(address(wallet)); }
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
