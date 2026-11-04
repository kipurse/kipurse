// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";

/// @title Kipurse delivery-confirmed escrow (V1) - TESTNET / FORK ONLY until the owner approves a mainnet deploy.
/// One escrow per owner wallet. The AI pays INTO this contract through the normal Kipurse pay path (single limit, 0.1% fee
/// charged once by the adapter, gas at actual cost); the gateway then opens an order that binds exactly that amount to a merchant.
///  - merchant confirms fulfillment (tx from the payee, or the payee's EIP-712 signature relayed by anyone) -> review window
///    starts; after it, anyone may release to the merchant. The owner may confirm delivery to release at once.
///  - not fulfilled by the deadline -> anyone may refund the owner wallet.  - owner may cancel (refund) until the merchant has
///    confirmed, and may dispute (refund) during the review window.  - funds only ever go to the order's merchant or the owner.
///  - money never sits unaccounted: unallocated USDC (paid in but not opened) can only be swept back to the owner.
contract KipurseEscrowV1 is EIP712 {
    using SafeERC20 for IERC20;
    enum State { None, Open, Fulfilled, Released, Refunded }
    struct Order { address merchant; uint96 amount; uint64 deadline; uint64 fulfilledAt; uint32 reviewSec; State state; }
    IERC20 public immutable token; address public immutable owner; address public immutable opener;
    uint32 public constant MAX_REVIEW = 7 days; uint64 public constant MAX_TERM = 90 days;
    bytes32 public constant FULFILLED_TYPEHASH = keccak256("Fulfilled(bytes32 id,address merchant,uint256 amount)");
    mapping(bytes32 => Order) public orders; uint256 public locked;
    event Opened(bytes32 indexed id, address indexed merchant, uint256 amount, uint64 deadline, uint32 reviewSec);
    event FulfillmentConfirmed(bytes32 indexed id, uint64 at); event Released(bytes32 indexed id, address merchant, uint256 amount, address by);
    event Refunded(bytes32 indexed id, uint256 amount, uint8 why); event Swept(uint256 amount);
    error NotAllowed(); error BadState(); error BadParams(); error Unfunded(); error TooEarly();
    constructor(IERC20 t, address ownerWallet, address openerExecutor) EIP712("Kipurse Escrow", "1") {
        if (address(t) == address(0) || ownerWallet == address(0)) revert BadParams(); token = t; owner = ownerWallet; opener = openerExecutor;
    }
    function unallocated() public view returns (uint256) { uint256 b = token.balanceOf(address(this)); return b > locked ? b - locked : 0; }
    /// Bind `amount` already paid in to `merchant`. Only the owner wallet or its Kipurse executor (which could pay the merchant directly anyway).
    function open(bytes32 id, address merchant, uint96 amount, uint64 deadline, uint32 reviewSec) external {
        if (msg.sender != owner && msg.sender != opener) revert NotAllowed();
        if (orders[id].state != State.None || merchant == address(0) || merchant == owner || merchant == address(this) || amount == 0) revert BadParams();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_TERM || reviewSec > MAX_REVIEW) revert BadParams();
        if (unallocated() < amount) revert Unfunded();
        locked += amount; orders[id] = Order(merchant, amount, deadline, 0, reviewSec, State.Open);
        emit Opened(id, merchant, amount, deadline, reviewSec);
    }
    function fulfilledDigest(bytes32 id) public view returns (bytes32) { Order storage o = orders[id];
        return _hashTypedDataV4(keccak256(abi.encode(FULFILLED_TYPEHASH, id, o.merchant, uint256(o.amount)))); }
    /// Merchant confirms fulfillment: from the merchant address itself, or its signature (EOA or ERC-1271) relayed by anyone.
    function confirmFulfilled(bytes32 id, bytes calldata merchantSig) external { Order storage o = orders[id];
        if (o.state != State.Open || block.timestamp > o.deadline) revert BadState();
        if (msg.sender != o.merchant && !SignatureChecker.isValidSignatureNow(o.merchant, fulfilledDigest(id), merchantSig)) revert NotAllowed();
        o.state = State.Fulfilled; o.fulfilledAt = uint64(block.timestamp); emit FulfillmentConfirmed(id, uint64(block.timestamp));
        if (o.reviewSec == 0) _release(id, o);
    }
    /// After the review window anyone may release to the merchant.
    function release(bytes32 id) external { Order storage o = orders[id];
        if (o.state != State.Fulfilled) revert BadState(); if (block.timestamp < o.fulfilledAt + o.reviewSec) revert TooEarly(); _release(id, o); }
    /// Owner confirms delivery: release now (Open or Fulfilled).
    function ownerConfirm(bytes32 id) external { if (msg.sender != owner) revert NotAllowed(); Order storage o = orders[id];
        if (o.state != State.Open && o.state != State.Fulfilled) revert BadState(); _release(id, o); }
    /// Owner cancels before fulfillment, or disputes during the review window -> refund to the owner wallet.
    function ownerCancel(bytes32 id) external { if (msg.sender != owner) revert NotAllowed(); Order storage o = orders[id];
        if (o.state == State.Open) return _refund(id, o, 1);
        if (o.state == State.Fulfilled && block.timestamp < o.fulfilledAt + o.reviewSec) return _refund(id, o, 2);
        revert BadState(); }
    /// Not fulfilled by the deadline -> anyone refunds the owner.
    function refundExpired(bytes32 id) external { Order storage o = orders[id];
        if (o.state != State.Open || block.timestamp <= o.deadline) revert BadState(); _refund(id, o, 3); }
    /// Paid in but never opened (e.g. the gateway crashed between the two steps): only ever back to the owner.
    function sweepUnallocated() external { uint256 u = unallocated(); if (u == 0) revert BadState(); token.safeTransfer(owner, u); emit Swept(u); }
    function _release(bytes32 id, Order storage o) internal { o.state = State.Released; locked -= o.amount; token.safeTransfer(o.merchant, o.amount); emit Released(id, o.merchant, o.amount, msg.sender); }
    function _refund(bytes32 id, Order storage o, uint8 why) internal { o.state = State.Refunded; locked -= o.amount; token.safeTransfer(owner, o.amount); emit Refunded(id, o.amount, why); }
}
