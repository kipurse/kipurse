// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Minimal interface to Coinbase's SpendPermissionManager (deployed at 0xf85210B21cC50302F477BA56686d2019dC9b67Ad on Base).
/// Declares only what the Kipurse adapter calls. The struct layout and ABI match the deployed contract exactly.
/// Importing this interface instead of the full SpendPermissionManager source keeps the GPL-3.0 ERC-4337 sources
/// (pulled in transitively through Coinbase Smart Wallet) out of the adapter's compilation unit.
interface ISpendPermissionManager {
    struct SpendPermission {
        address account;
        address spender;
        address token;
        uint160 allowance;
        uint48 period;
        uint48 start;
        uint48 end;
        uint256 salt;
        bytes extraData;
    }
    /// @notice Pull `value` of the permitted token from the account to the spender (must be the caller) within the period allowance.
    function spend(SpendPermission memory spendPermission, uint160 value) external;
    /// @notice True when the permission is approved, not revoked and inside [start, end).
    function isValid(SpendPermission memory spendPermission) external view returns (bool);
    /// @notice EIP-712 hash of the permission as stored by the SpendPermissionManager.
    function getHash(SpendPermission memory spendPermission) external view returns (bytes32);
}
