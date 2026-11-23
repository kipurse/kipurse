// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {PackedUserOperation} from "./KipurseAdapterV5.sol";

/// Kipurse operations account (development only, NOT audited): ONE ERC-4337 v0.7 account that (1) DEPLOYS the V5 contracts and
/// then (2) is the protocol FEE RECIPIENT that collects fees, with every op's gas paid in USDC through the allowlisted Circle
/// Paymaster from this account's own balance. Zero reserve: nobody holds ETH for it.
///  - Bootstrap (M5): the account itself is created by its first userOp (initCode = the public CreateX factory), after the
///    OWNER funded its counterfactual address with a few cents of USDC (the owner's explicit, one-time spend).
///  - Deploy phase (`!locked`): `deploy(salt, initCode)` = CREATE2 of a contract; per-op gas cap `maxDeployGas`.
///  - `lock(adapter)` ends the deploy phase for good. After that the ONLY allowed actions are adapter.collectFees(),
///    USDC approve of an allowlisted paymaster <= maxGasPerOp, and USDC transfers to the TREASURY (the owner) that leave
///    a gas buffer of 4 x maxGasPerOp. The session signer holds nothing and can never send funds anywhere else.
///  - The treasury (owner) can rotate the signer, change caps and withdraw anything, directly.
/// The constructor makes no external call (ERC-7562: it runs inside userOp validation): the USDC EIP-712 domain separator is
/// passed in and checked off-chain.
contract KipurseOpsAccountV5 {
    using SafeERC20 for IERC20;
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 internal constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    address public immutable entryPoint;
    address public immutable paymaster;
    address public immutable paymaster2;
    IERC20 public immutable token;
    address public immutable treasury;
    bytes32 internal immutable TOKEN_DOMAIN;
    address public signer;
    uint96 public maxGasPerOp;   // after lock (fee collection ops)
    address public adapter;      // set by lock()
    uint96 public maxDeployGas;  // during the deploy phase (big CREATE2 ops)
    bool public locked;

    event Deployed(address indexed addr, bytes32 salt);
    event Locked(address indexed adapter);
    event Config(address indexed signer, uint256 maxGasPerOp, uint256 maxDeployGas);

    constructor(address entryPoint_, address paymaster_, address paymaster2_, IERC20 token_, bytes32 tokenDomain_, address treasury_,
        address signer_, uint96 maxGasPerOp_, uint96 maxDeployGas_)
    {
        require(treasury_ != address(0) && signer_ != address(0), NotAccount());
        entryPoint = entryPoint_; paymaster = paymaster_; paymaster2 = paymaster2_; token = token_; TOKEN_DOMAIN = tokenDomain_;
        treasury = treasury_; signer = signer_; maxGasPerOp = maxGasPerOp_; maxDeployGas = maxDeployGas_;
    }

    /// @notice EntryPoint only: valid iff the signer signed userOpHash (EIP-191) and an allowlisted paymaster pays. Never pays ETH.
    function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingAccountFunds) external returns (uint256) {
        require(msg.sender == entryPoint, NotEntryPoint());
        require(missingAccountFunds == 0, NoEth());
        require(op.paymasterAndData.length >= 20 && _isPaymaster(address(bytes20(op.paymasterAndData[:20]))), Target());
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash)), op.signature);
        return e == ECDSA.RecoverError.NoError && r != address(0) && r == signer ? 0 : 1;
    }

    /// @notice EntryPoint only, deploy phase only: CREATE2 one contract (the V5 stack, one per op).
    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        require(msg.sender == entryPoint && !locked, Target());
        bytes memory c = initCode;
        assembly { addr := create2(0, add(c, 32), mload(c), salt) }
        require(addr != address(0), Vault());
        emit Deployed(addr, salt);
    }
    /// @notice EntryPoint or treasury: end the deploy phase for good and bind the adapter whose fees this account collects.
    function lock(address adapter_) external {
        require((msg.sender == entryPoint || msg.sender == treasury) && !locked && adapter_.code.length != 0, Target());
        adapter = adapter_; locked = true;
        emit Locked(adapter_);
    }

    /// @notice EntryPoint only, after lock: adapter.collectFees(), approve an allowlisted paymaster <= maxGasPerOp, or send
    ///  USDC to the treasury (leaving the 4 x maxGasPerOp gas buffer).
    function execute(address target, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        _exec(target, value, data);
    }
    struct Call { address target; uint256 value; bytes data; }
    /// @notice EntryPoint only: several allowed calls, atomically (e.g. collectFees + transfer to the treasury).
    function executeBatch(Call[] calldata calls) external {
        require(msg.sender == entryPoint, NotEntryPoint());
        for (uint256 i; i < calls.length; i++) _exec(calls[i].target, calls[i].value, calls[i].data);
    }
    function _exec(address target, uint256 value, bytes calldata data) internal {
        require(value == 0 && locked, Target());
        if (target == adapter) {
            require(data.length == 4 && bytes4(data) == bytes4(keccak256("collectFees()")), Target());
        } else {
            require(target == address(token) && data.length == 68, Target());
            (address to, uint256 amt) = abi.decode(data[4:], (address, uint256));
            if (bytes4(data[:4]) == IERC20.approve.selector) { require(_isPaymaster(to), Target()); require(amt <= maxGasPerOp, GasCap()); }
            else require(bytes4(data[:4]) == IERC20.transfer.selector && to == treasury
                && token.balanceOf(address(this)) >= amt + 4 * uint256(maxGasPerOp), Target());
        }
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    /// @notice ERC-1271 for the Circle permit only: allowlisted paymaster, value <= the current per-op cap, signed by the signer.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 192) return bytes4(0xffffffff);
        (address sp, uint256 v, uint256 nonce, uint256 deadline, bytes memory sig) = abi.decode(signature, (address, uint256, uint256, uint256, bytes));
        if (!_isPaymaster(sp) || v > (locked ? maxGasPerOp : maxDeployGas)) return bytes4(0xffffffff);
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", TOKEN_DOMAIN, keccak256(abi.encode(PERMIT_TYPEHASH, address(this), sp, v, nonce, deadline))));
        if (d != hash) return bytes4(0xffffffff);
        (address r, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, sig);
        return e == ECDSA.RecoverError.NoError && r != address(0) && r == signer ? MAGIC : bytes4(0xffffffff);
    }
    function _isPaymaster(address a) internal view returns (bool) { return a != address(0) && (a == paymaster || a == paymaster2); }

    // ---------------- treasury (owner), direct calls ----------------
    /// @notice Treasury only: rotate the signer and change the per-op caps.
    function configure(address signer_, uint96 maxGasPerOp_, uint96 maxDeployGas_) external {
        require(msg.sender == treasury && signer_ != address(0), NotAccount());
        signer = signer_; maxGasPerOp = maxGasPerOp_; maxDeployGas = maxDeployGas_;
        emit Config(signer_, maxGasPerOp_, maxDeployGas_);
    }
    /// @notice Treasury only: withdraw any token.
    function withdraw(IERC20 t, address to, uint256 amount) external {
        require(msg.sender == treasury, NotAccount());
        t.safeTransfer(to, amount);
    }
}
