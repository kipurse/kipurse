// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {Test} from "forge-std/Test.sol";
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
import {KipurseOrderVerifier} from "../src/KipurseOrderVerifier.sol";
/// Frozen merchant-spec test vector (EXAMPLESHOP_V51_SPEC): same digest / signature as gateway test/v51.test.mjs.
contract KipurseOrderVerifierVectorTest is Test {
    address constant VER = 0xBCbe3b3c463ff4C1C049c549F98CA93c9209F8dC; // Base mainnet verifier (frozen derivation)
    function test_specVector() public {
        vm.chainId(8453);
        KipurseOrderVerifier v0 = new KipurseOrderVerifier(ISpendPermissionManager(address(this)));
        vm.etch(VER, address(v0).code);
        KipurseOrderVerifier v = KipurseOrderVerifier(VER);
        KipurseOrderVerifier.PaymentOrder memory o = KipurseOrderVerifier.PaymentOrder({payee: address(0xba5e1), amount: 1_000_000,
            orderId: keccak256("pi_test"), deadline: 4102444800, payer: 0x5e4c116dd45eDc2DBED826bE8B97A72499d03fC8});
        assertEq(o.orderId, 0x94f7a868a972292409e93a5940cfab67927a26a03f4336345a35dc65082f59f8);
        assertEq(v.domainSeparator(), 0xdcb2af5b9b27dc315fd35c7d75e50b977352ba732305ea33db240f97fd2a8eaf);
        assertEq(v.orderDigest(o), 0x8935355a1e1626752d8c5ae4e393111e51907183d67df1b56b366c36d9c5a220);
        bytes memory sig = hex"c9d6678496933cd9286d276ce30726a8cec2f284676c3e0ee991d11cac83a682612a2354ebe2c9c2234aea58557455fb8cf4c5f7e7b9d4ae893dd36a06ccefdf1b";
        assertEq(v.recover(o, sig), 0x70997970C51812dc3A010C7d01b50e0d17dc79C8);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, v.orderDigest(o));
        assertEq(abi.encodePacked(r, s, vv), sig);
    }
}
