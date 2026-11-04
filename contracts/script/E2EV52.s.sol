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
import {KipurseAdapterV5, PayerVaultFactoryV5} from "../src/KipurseAdapterV5.sol";
import {KipurseAdapterV52} from "../src/KipurseAdapterV52.sol";
import {KipurseFeeControllerV5} from "../src/KipurseFeeControllerV5.sol";
import {KipursePhoneApproverV3} from "../src/KipursePhoneApproverV3.sol";
import {MockEIP3009} from "../test/MockEIP3009.sol";
/// Local anvil only: full V52 stack + V3 phone approver (bound to V52's trust) for the gateway e2e.
contract E2EV52 is Script {
    function run() external {
        uint256 ok = vm.envUint("OWNER_PK"); address owner = vm.addr(ok); address executor = vm.envAddress("EXECUTOR");
        uint256 px = vm.envUint("PX"); uint256 py = vm.envUint("PY");
        vm.startBroadcast(ok);
        CoinbaseSmartWalletFactory f = new CoinbaseSmartWalletFactory(address(new CoinbaseSmartWallet()));
        bytes[] memory owners = new bytes[](1); owners[0] = abi.encode(owner);
        CoinbaseSmartWallet w = f.createAccount(owners, 0);
        SpendPermissionManager m = new SpendPermissionManager(new PublicERC6492Validator(), address(0));
        w.addOwnerAddress(address(m));
        MockEIP3009 t = new MockEIP3009();
        PayerVaultFactoryV5 vf = new PayerVaultFactoryV5(0x0000000071727De22E5E9d8BAf0edAc6f37da032, 0x6C973eBe80dCD8660841D4356bf15c32460271C9, address(0));
        KipurseFeeControllerV5 fc = new KipurseFeeControllerV5(owner, 1000, owner);
        KipurseAdapterV52 a = new KipurseAdapterV52(ISpendPermissionManager(address(m)), IERC20(address(t)), vf, fc);
        KipursePhoneApproverV3 ap = new KipursePhoneApproverV3(address(w), address(a.trust()), px, py);
        w.addOwnerAddress(address(ap));
        t.mint(address(w), 100e6);
        KipurseAdapterV52.Policy memory pol = KipurseAdapterV52.Policy({executor: executor, guardian: address(0), single: 6e6, daily: 12e6, term: 30e6,
            openSingle: 0, openDaily: 0, verifiedSingle: 0, verifiedDaily: 0, registry: address(0), maxFeePpm: 1000, maxNetworkFee: 20_000});
        ISpendPermissionManager.SpendPermission memory q = ISpendPermissionManager.SpendPermission({account: address(w), spender: address(a), token: address(t),
            allowance: 30e6, period: 30 days, start: uint48(block.timestamp), end: uint48(block.timestamp + 30 days), salt: 1, extraData: abi.encode(pol)});
        w.execute(address(m), 0, abi.encodeCall(m.approve, (S(q))));
        vm.stopBroadcast();
        string memory o = "e";
        vm.serializeAddress(o, "wallet", address(w)); vm.serializeAddress(o, "adapter", address(a)); vm.serializeAddress(o, "trust", address(a.trust()));
        vm.serializeAddress(o, "token", address(t)); vm.serializeAddress(o, "approver", address(ap)); vm.serializeUint(o, "ownerIndex", w.nextOwnerIndex() - 1);
        vm.serializeUint(o, "start", q.start); vm.serializeUint(o, "end", q.end);
        string memory j = vm.serializeBytes(o, "extraData", q.extraData);
        console2.log(j);
    }
}
