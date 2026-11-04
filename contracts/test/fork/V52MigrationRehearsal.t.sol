// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Test, console2} from "forge-std/Test.sol";
import {ISpendPermissionManager} from "../../src/ISpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CoinbaseSmartWallet} from "smart-wallet/CoinbaseSmartWallet.sol";
import {KipurseAdapterV5, PayerVaultFactoryV5} from "../../src/KipurseAdapterV5.sol";
import {KipurseAdapterV52} from "../../src/KipurseAdapterV52.sol";
import {KipurseFeeControllerV5} from "../../src/KipurseFeeControllerV5.sol";
import {KipurseTrustV5} from "../../src/KipurseTrustV5.sol";
import {KipursePhoneApproverV3} from "../../src/KipursePhoneApproverV3.sol";
interface IFeed { function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80); }
interface ISpm { function approve(ISpendPermissionManager.SpendPermission calldata) external returns (bool); function isValid(ISpendPermissionManager.SpendPermission calldata) external view returns (bool); }
/// FORK ONLY, NO BROADCAST: Base mainnet state, wallet 0xdEaD (V3 phone approver). Rehearses the V52 migration batch.
/// Run: FORK_URL=https://mainnet.base.org forge test --match-contract V52MigrationRehearsal -vv
contract V52MigrationRehearsal is Test {
    address constant W = 0x000000000000000000000000000000000000dEaD;
    address constant OWNER = 0xC14B0707634A55B3DE43811FD34C92f6f49f410b;
    address constant OLD_AP = 0x2902bE800ad88B30CAfD5df2DF263dd03CFceED5;
    address constant SPM = 0xf85210B21cC50302F477BA56686d2019dC9b67Ad;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant VF = 0x6CE7BC537379A6e10b88D1e98A5c3803a9812BE9;
    address constant FEES = 0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A;
    address constant DD = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address constant FEED = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    function test_rehearse_v52_migration() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(url);
        // 0) one-time global deploy (shared by all users)
        uint256 g = gasleft();
        KipurseAdapterV52 a = new KipurseAdapterV52(ISpendPermissionManager(SPM), IERC20(USDC), PayerVaultFactoryV5(VF), KipurseFeeControllerV5(FEES));
        uint256 gDeploy = g - gasleft();
        // 1) per-wallet batch signed once by the owner's Base Account
        (uint256 px, uint256 py) = vm.publicKeyP256(0xA11CE);
        bytes memory init = abi.encodePacked(type(KipursePhoneApproverV3).creationCode, abi.encode(W, address(a.trust()), px, py));
        bytes32 salt = keccak256(abi.encodePacked("kipurse-phone-approver-v3", px, py));
        address newAp = vm.computeCreate2Address(salt, keccak256(init), DD);
        KipurseAdapterV5.Policy memory pol = KipurseAdapterV5.Policy({executor: address(0xE7EC), guardian: address(0), single: 5e6, daily: 20e6, term: 100e6,
            openSingle: 0, openDaily: 0, verifiedSingle: 0, verifiedDaily: 0, registry: address(0), maxFeePpm: 1000, maxNetworkFee: 50_000});
        ISpendPermissionManager.SpendPermission memory q = ISpendPermissionManager.SpendPermission({account: W, spender: address(a), token: USDC,
            allowance: 100e6, period: 30 days, start: uint48(block.timestamp), end: uint48(block.timestamp + 30 days), salt: 52, extraData: abi.encode(pol)});
        uint256 oldIdx = 2; assertEq(CoinbaseSmartWallet(payable(W)).ownerAtIndex(oldIdx), abi.encode(OLD_AP), "old approver index");
        CoinbaseSmartWallet.Call[] memory c = new CoinbaseSmartWallet.Call[](5);
        c[0] = CoinbaseSmartWallet.Call(DD, 0, abi.encodePacked(salt, init));
        c[1] = CoinbaseSmartWallet.Call(W, 0, abi.encodeWithSignature("addOwnerAddress(address)", newAp));
        c[2] = CoinbaseSmartWallet.Call(W, 0, abi.encodeWithSignature("removeOwnerAtIndex(uint256,bytes)", oldIdx, abi.encode(OLD_AP)));
        c[3] = CoinbaseSmartWallet.Call(SPM, 0, abi.encodeCall(ISpm.approve, (q)));
        c[4] = CoinbaseSmartWallet.Call(address(a), 0, abi.encodeCall(a.registerPermission, (q)));
        bytes memory batch = abi.encodeCall(CoinbaseSmartWallet.executeBatch, (c));
        vm.prank(OWNER); g = gasleft(); (bool ok,) = W.call(batch); uint256 gBatch = g - gasleft();
        assertTrue(ok, "batch");
        assertTrue(CoinbaseSmartWallet(payable(W)).isOwnerAddress(newAp)); assertFalse(CoinbaseSmartWallet(payable(W)).isOwnerAddress(OLD_AP));
        assertTrue(ISpm(SPM).isValid(q));
        (, int256 eth,,,) = IFeed(FEED).latestRoundData();
        uint256 gp = tx.gasprice > 0 ? tx.gasprice : block.basefee;
        emit log_named_uint("deploy gas", gDeploy); emit log_named_uint("batch gas", gBatch); emit log_named_uint("batch calldata bytes", batch.length);
        emit log_named_uint("basefee wei", block.basefee); emit log_named_uint("ETH/USD 1e8", uint256(eth)); emit log_named_uint("block", block.number); gp;
    }
}
