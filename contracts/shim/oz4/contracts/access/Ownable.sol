// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
abstract contract Ownable { address private _o; constructor() { _o = msg.sender; } function owner() public view returns (address) { return _o; } modifier onlyOwner() { require(msg.sender == _o, "Ownable: caller is not the owner"); _; } }
