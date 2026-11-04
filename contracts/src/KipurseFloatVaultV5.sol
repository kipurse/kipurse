// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

interface IFloatGate { function floatBlocked(address account, address to) external view returns (bool); }
interface IDomain3009 { function DOMAIN_SEPARATOR() external view returns (bytes32); }

/// Micropayment float (M3; development only, NOT audited). One per agent wallet: an EIP-1167 clone (CREATE2) via PayerVaultFactoryV5.
/// The adapter funds it once a day (<= the owner's float cap) and opens a SESSION: a gateway-held session key may then
/// sign standard x402 / EIP-3009 TransferWithAuthorization payments FROM this contract, verified here through ERC-1271:
///  - only TransferWithAuthorization for THIS vault and the configured token (the digest is rebuilt from the fields, so the
///    key can never approve a permit, an arbitrary hash or another token);
///  - value <= maxSingle (the owner's stranger per-payment cap), validBefore <= session expiry (<= 24 h);
///  - refused while the wallet is paused or the payee is denied by the owner;
///  - worst case if the session key leaks: the float balance (<= the owner's daily float cap).
/// No tx from us per micropayment: the merchant's facilitator settles each one. The adapter reconciles after expiry
/// (protocol fee on what was actually spent, rounded up; the rest + unspent float go back to the owner's wallet).
contract KipurseFloatVaultV5 {
    using SafeERC20 for IERC20;
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes4 internal constant FAIL = 0xffffffff;
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    address public immutable adapter;
    IERC20 public immutable token;
    address internal immutable FACTORY;
    address public account; // per clone (EIP-1167), set once by the factory
    address public sessionKey;
    uint64 public expiry;
    uint160 public maxSingle;

    event SessionOpened(address indexed sessionKey, uint64 expiry, uint160 maxSingle);
    event SessionClosed(uint256 returned);

    constructor(IERC20 token_, address adapter_) { adapter = adapter_; token = token_; FACTORY = msg.sender; }
    /// @notice Factory only, once per clone: bind the clone to the owner's wallet.
    function init(address account_) external {
        require(msg.sender == FACTORY && account == address(0) && account_ != address(0), Vault());
        account = account_;
    }
    modifier onlyAdapter() { require(msg.sender == adapter, BadAdapter()); _; }

    /// @notice Adapter only: start a float day with a session key, expiry and per-voucher max.
    function open(address key, uint64 exp, uint160 maxS) external onlyAdapter {
        require(sessionKey == address(0), SessionOpen());
        sessionKey = key; expiry = exp; maxSingle = maxS;
        emit SessionOpened(key, exp, maxS);
    }
    /// Ends the session and returns every remaining USDC to the owner's wallet.
    function close() external onlyAdapter returns (uint256 bal) {
        sessionKey = address(0); expiry = 0; maxSingle = 0;
        bal = token.balanceOf(address(this));
        if (bal != 0) token.safeTransfer(account, bal);
        emit SessionClosed(bal);
    }

    /// @notice Decode a session-key voucher signature into its EIP-3009 fields and the ECDSA signature.
    function decodeVoucher(bytes calldata signature) external pure
        returns (address, uint256, uint256, uint256, bytes32, bytes memory)
    { return abi.decode(signature, (address, uint256, uint256, uint256, bytes32, bytes)); }
    /// signature = abi.encode(to, value, validAfter, validBefore, nonce, ecdsaSignatureOfHashBySessionKey).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (sessionKey == address(0) || block.timestamp >= expiry) return FAIL;
        address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; bytes memory sig;
        try this.decodeVoucher(signature) returns (address t, uint256 v, uint256 va, uint256 vb, bytes32 n, bytes memory sg) {
            (to, value, validAfter, validBefore, nonce, sig) = (t, v, va, vb, n, sg);
        } catch { return FAIL; } // malformed bytes never revert ERC-1271, they are simply not valid
        if (value == 0 || value > maxSingle || validBefore > expiry) return FAIL;
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", IDomain3009(address(token)).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, address(this), to, value, validAfter, validBefore, nonce))));
        if (d != hash) return FAIL;
        if (IFloatGate(adapter).floatBlocked(account, to)) return FAIL;
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, sig);
        return e == ECDSA.RecoverError.NoError && r == sessionKey ? MAGIC : FAIL;
    }
}
