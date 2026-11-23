// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// Read interface the V5 adapter uses. A registry is OPTIONAL and chosen by the owner inside the signed permission.
/// Every lookup returns merchant == 0 when the address is unknown, removed, stale, expired or blocked.
interface IKipurseMerchantRegistry {
    /// @notice Live binding for a payee address: merchant id plus its single/daily caps (zero when unbound or expired).
    function lookupPayee(address payee) external view returns (bytes32 merchant, uint160 single, uint160 daily);
    /// @notice Live binding for an order signer: merchant id plus its single/daily caps (zero when unbound or expired).
    function lookupSigner(address signer) external view returns (bytes32 merchant, uint160 single, uint160 daily);
    /// @notice True when `payee` is a live payee bound to `merchant`.
    function isPayeeOf(bytes32 merchant, address payee) external view returns (bool);
    /// @notice True when the maintainer has blocked this payee or signer for everyone (owners can opt out of the registry).
    function blocked(address who) external view returns (bool);
}
