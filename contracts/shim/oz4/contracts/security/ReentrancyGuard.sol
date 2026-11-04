// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
abstract contract ReentrancyGuard { uint256 private _s; modifier nonReentrant() { require(_s != 2, "ReentrancyGuard: reentrant call"); _s = 2; _; _s = 1; } }
