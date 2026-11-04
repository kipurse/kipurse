// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/// Test fixture mirroring FiatTokenV2_2 transferWithAuthorization(bytes) semantics (EOA ECDSA or ERC-1271 via SignatureChecker).
contract MockEIP3009 is ERC20 {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    mapping(address => uint256) public nonces;
    mapping(address => bool) public blocklisted; // models USDC's blocklist (a blocklisted fee recipient must not brick payments)
    constructor() ERC20("Fixture USDC", "USDC") {}
    function setBlocklisted(address a, bool v) external { blocklisted[a] = v; }
    function _update(address from, address to, uint256 value) internal override {
        require(!blocklisted[from] && !blocklisted[to], "blocklisted");
        super._update(from, to, value);
    }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 v) external { _mint(to, v); }
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USD Coin"), keccak256("2"), block.chainid, address(this)));
    }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes memory signature) external {
        require(block.timestamp > validAfter, "not yet valid");
        require(block.timestamp < validBefore, "expired");
        require(!authorizationState[from][nonce], "used");
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        require(SignatureChecker.isValidSignatureNow(from, d, signature), "invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) external {
        require(block.timestamp <= deadline, "expired");
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))));
        require(SignatureChecker.isValidSignatureNow(owner, d, signature), "invalid signature");
        _approve(owner, spender, value);
    }
}
