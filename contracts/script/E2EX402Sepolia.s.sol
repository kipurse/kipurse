// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Script, console2} from "forge-std/Script.sol";
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {S} from "../test/SpmCast.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {CoinbaseSmartWalletFactory} from "smart-wallet/CoinbaseSmartWalletFactory.sol";
import {PublicERC6492Validator} from "spm/PublicERC6492Validator.sol";
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";
import {KipurseTrustV5} from "../src/KipurseTrustV5.sol";
import {KipurseEscrowV1} from "../src/KipurseEscrowV1.sol";
/// TESTNET ONLY (Base Sepolia or its anvil fork): current V52 stack against REAL Base Sepolia USDC, for the x402 e2e
/// with the official facilitator. Same policy shape as production (0.1% fee, no open stranger tier). One trusted test payee.
contract E2EX402Sepolia is Script {
    function run() external {
        require(block.chainid == 84532, "testnet only");
        uint256 ok = vm.envUint("OWNER_PK"); address owner = vm.addr(ok); address executor = vm.envAddress("EXECUTOR");
        address usdc = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; address payee = vm.envAddress("PAYEE");
        vm.startBroadcast(ok);
        CoinbaseSmartWalletFactory f = new CoinbaseSmartWalletFactory(address(new CoinbaseSmartWallet()));
        bytes[] memory owners = new bytes[](1); owners[0] = abi.encode(owner);
        CoinbaseSmartWallet w = f.createAccount(owners, 0);
        SpendPermissionManager m = new SpendPermissionManager(new PublicERC6492Validator(), address(0));
        w.addOwnerAddress(address(m));
        PayerVaultFactoryV5 vf = new PayerVaultFactoryV5(0x0000000071727De22E5E9d8BAf0edAc6f37da032, 0x6C973eBe80dCD8660841D4356bf15c32460271C9, address(0));
        KipurseFeeControllerV5 fc = new KipurseFeeControllerV5(owner, 1000, owner);
        KipurseAdapterV52 a = new KipurseAdapterV52(ISpendPermissionManager(address(m)), IERC20(usdc), vf, fc);
        KipurseAdapterV52.Policy memory pol = KipurseAdapterV52.Policy({executor: executor, guardian: address(0), single: 5e6, daily: 20e6, term: 100e6,
            openSingle: 0, openDaily: 0, verifiedSingle: 0, verifiedDaily: 0, registry: address(0), maxFeePpm: 1000, maxNetworkFee: 20_000});
        ISpendPermissionManager.SpendPermission memory q = ISpendPermissionManager.SpendPermission({account: address(w), spender: address(a), token: usdc,
            allowance: 100e6, period: 30 days, start: uint48(block.timestamp), end: uint48(block.timestamp + 30 days), salt: 1, extraData: abi.encode(pol)});
        w.execute(address(m), 0, abi.encodeCall(m.approve, (S(q))));
        KipurseEscrowV1 esc = new KipurseEscrowV1(IERC20(usdc), address(w), executor);
        address[] memory ps = new address[](2); ps[0] = payee; ps[1] = address(esc); address[] memory ss = new address[](0);
        w.execute(address(a.trust()), 0, abi.encodeCall(KipurseTrustV5.setTrust, (KipurseTrustV5.TrustParams({merchant: keccak256("x402 test merchant"), name: "x402 test merchant", payees: ps, signers: ss, single: 5e6, daily: 20e6, expiry: uint64(block.timestamp + 30 days)}))));
        vm.stopBroadcast();
        string memory o = "e";
        vm.serializeAddress(o, "wallet", address(w)); vm.serializeAddress(o, "adapter", address(a)); vm.serializeAddress(o, "trust", address(a.trust()));
        vm.serializeAddress(o, "manager", address(m)); vm.serializeAddress(o, "escrow", address(esc)); vm.serializeAddress(o, "token", usdc);
        vm.serializeUint(o, "start", q.start); vm.serializeUint(o, "end", q.end);
        string memory j = vm.serializeBytes(o, "extraData", q.extraData);
        console2.log(j);
    }
}
