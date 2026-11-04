// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;
/// Property harness mirroring the cap rules (20 ops/day, 2 USDC/day, 0.25 USDC/op). Echidna must never find a sequence that
/// spends past a cap. Model-level: keeps the fee-inclusive accounting identical to KipurseAdapterV5.feeFor (rounded up).
contract KipurseCapsEchidna {
    uint256 constant PER_OP = 250_000; uint256 constant PER_DAY = 2_000_000; uint256 constant OPS = 20; uint256 constant PPM = 5_000;
    uint256 spentToday; uint256 opsToday; uint256 day;
    function feeFor(uint256 a) internal pure returns (uint256) { return (a * PPM + 999_999) / 1_000_000; }
    function pay(uint256 amount) public { uint256 t = amount + feeFor(amount);
        if (amount == 0 || amount > PER_OP || opsToday + 1 > OPS || spentToday + t > PER_DAY + feeFor(PER_DAY)) return;
        spentToday += t; opsToday += 1; }
    function nextDay() public { day += 1; spentToday = 0; opsToday = 0; }
    function echidna_ops_cap() public view returns (bool) { return opsToday <= OPS; }
    function echidna_day_cap() public view returns (bool) { return spentToday <= PER_DAY + feeFor(PER_DAY); }
}
