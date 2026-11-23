// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {SpendPermissionManager} from "spm/SpendPermissionManager.sol";
import {ISpendPermissionManager} from "../src/ISpendPermissionManager.sol";
/// Tests hold permissions as the adapter's interface type; S() converts to the real SPM struct (identical ABI) for direct SPM calls.
function S(ISpendPermissionManager.SpendPermission memory q) pure returns (SpendPermissionManager.SpendPermission memory r) {
    r = abi.decode(abi.encode(q), (SpendPermissionManager.SpendPermission));
}
