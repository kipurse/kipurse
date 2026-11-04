// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";
import {ISpendPermissionManager} from "./ISpendPermissionManager.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

/// Kipurse merchant PaymentOrder verifier (V5.1; development only, NOT audited).
/// STABLE merchant domain: merchants sign against THIS contract, never against a Kipurse adapter. It has no owner, no admin,
/// no upgrade path and no configuration besides the immutable SpendPermissionManager, so future Kipurse adapters reuse it
/// and a merchant's signing code never changes when Kipurse upgrades.
///   EIP712Domain(name "Kipurse PaymentOrder", version "1", chainId, verifyingContract = this)
///   PaymentOrder(address payee,uint256 amount,bytes32 orderId,uint256 deadline,address payer)
/// Exactly-once across adapters: an order (signer, orderId) is consumed at most once PER PAYING WALLET, and only by a contract
/// that is the spender of a currently valid (approved, not revoked, in term) SPM permission of that wallet. Nobody else can
/// burn a wallet's order, and a wallet's revoked adapter can no longer consume anything. A merchant that wants an order payable
/// by ONE wallet only sets `payer` (recommended: Kipurse sends its wallet address when it requests a signed order).
contract KipurseOrderVerifier {
    struct PaymentOrder { address payee; uint256 amount; bytes32 orderId; uint256 deadline; address payer; }
    bytes32 public constant ORDER_TYPEHASH = keccak256("PaymentOrder(address payee,uint256 amount,bytes32 orderId,uint256 deadline,address payer)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    string public constant NAME = "Kipurse PaymentOrder";
    string public constant VERSION = "1";

    ISpendPermissionManager public immutable manager;
    /// wallet => signer => orderId => consumed
    mapping(address => mapping(address => mapping(bytes32 => bool))) public used;
    event OrderConsumed(address indexed account, address indexed signer, bytes32 indexed orderId, address payee, uint256 amount, address by);

    constructor(ISpendPermissionManager m) { require(address(m).code.length != 0, Contracts()); manager = m; }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this)));
    }
    /// @notice EIP-712 digest the merchant order signer signs.
    function orderDigest(PaymentOrder calldata o) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(),
            keccak256(abi.encode(ORDER_TYPEHASH, o.payee, o.amount, o.orderId, o.deadline, o.payer))));
    }
    /// @notice Signer of an order (reverts on a malformed signature). EOA (secp256k1) signers only.
    function recover(PaymentOrder calldata o, bytes calldata signature) public view returns (address) {
        return ECDSA.recover(orderDigest(o), signature);
    }
    /// @notice Spender of a valid permission of p.account only: check payer binding + deadline, recover the signer and
    ///  consume (p.account, signer, orderId) exactly once. Returns the signer; the caller applies trust and caps.
    function consume(ISpendPermissionManager.SpendPermission calldata p, PaymentOrder calldata o, bytes calldata signature)
        external returns (address signer)
    {
        require(msg.sender == p.spender && manager.isValid(p), Permission());
        require(o.payer == address(0) || o.payer == p.account, Payer());
        require(o.orderId != bytes32(0) && block.timestamp < o.deadline, Expired());
        signer = recover(o, signature);
        require(!used[p.account][signer][o.orderId], Duplicate());
        used[p.account][signer][o.orderId] = true;
        emit OrderConsumed(p.account, signer, o.orderId, o.payee, o.amount, msg.sender);
    }
}
