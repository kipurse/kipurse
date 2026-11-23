// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";

/// Kipurse protocol fee configuration (development only; NOT audited).
///  - feePpm can only go DOWN (never up) and is hard-capped at MAX_FEE_PPM = 3000 (0.3%).
///  - the fee recipient can only change through a 48 h timelock (anyone executes once matured).
///  - owners additionally bound the rate they accept in their own permission (Policy.maxFeePpm).
contract KipurseFeeControllerV5 {
    uint256 public constant MAX_FEE_PPM = 3000;
    uint256 public constant RECIPIENT_DELAY = 48 hours;
    address public immutable admin; // fee multisig
    uint256 public feePpm;
    address public feeRecipient;
    address public pendingRecipient;
    uint256 public pendingAt;

    event FeeLowered(uint256 oldPpm, uint256 newPpm);
    event RecipientProposed(address indexed recipient, uint256 executableAt);
    event RecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event RecipientCancelled(address indexed recipient);

    constructor(address admin_, uint256 feePpm_, address recipient_) {
        require(admin_ != address(0) && recipient_ != address(0), Zero());
        require(feePpm_ <= MAX_FEE_PPM, FeeMax());
        admin = admin_; feePpm = feePpm_; feeRecipient = recipient_;
    }
    modifier onlyAdmin() { require(msg.sender == admin, Admin()); _; }

    /// @notice Admin: lower the protocol fee. It can only go down, never above the 0.3% hard max.
    function lowerFee(uint256 newPpm) external onlyAdmin {
        require(newPpm < feePpm, OnlyDown());
        emit FeeLowered(feePpm, newPpm);
        feePpm = newPpm;
    }
    /// @notice Admin: propose a new fee recipient; executable only after the 48h timelock.
    function proposeRecipient(address r) external onlyAdmin {
        require(r != address(0), Zero());
        pendingRecipient = r; pendingAt = block.timestamp + RECIPIENT_DELAY;
        emit RecipientProposed(r, pendingAt);
    }
    /// @notice Admin: cancel a pending fee-recipient change.
    function cancelRecipient() external onlyAdmin { emit RecipientCancelled(pendingRecipient); pendingRecipient = address(0); pendingAt = 0; }
    /// @notice Anyone: apply the pending fee recipient once the 48h timelock has elapsed.
    function executeRecipient() external {
        require(pendingRecipient != address(0) && block.timestamp >= pendingAt, Timelock());
        emit RecipientChanged(feeRecipient, pendingRecipient);
        feeRecipient = pendingRecipient; pendingRecipient = address(0); pendingAt = 0;
    }
}
