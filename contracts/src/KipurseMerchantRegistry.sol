// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";

import {IKipurseMerchantRegistry} from "./IKipurseMerchantRegistry.sol";

/// Kipurse merchant registry (V5, development only, NOT audited).
/// - The maintainer is meant to be a 2-of-3 hardware multisig (e.g. a Safe). This contract only sees one address.
/// - Adding or changing a merchant (payees, signers, caps) is a public proposal that can only be executed after
///   `delay` (>= 48 h). Removal, unbinding and blocking take effect immediately.
/// - Every record expires VALIDITY (90 days) after execution unless the maintainer renews it (renewal adds no capability).
/// - Maintainer hand-over is timelocked too.
/// - The registry can never move funds. Adapters cap the registry tier with the owner's own verified caps.
contract KipurseMerchantRegistry is IKipurseMerchantRegistry {
    uint256 public constant MIN_DELAY = 48 hours;
    uint256 public constant VALIDITY = 90 days;
    uint256 public constant MAX_BINDINGS = 16;

    struct Merchant { uint64 epoch; uint64 validUntil; bool active; uint160 single; uint160 daily; }
    struct Binding { bytes32 merchant; uint64 epoch; }

    uint256 public immutable delay;
    address public maintainer;
    address public pendingMaintainer;
    uint64 public pendingMaintainerEta;

    mapping(bytes32 => Merchant) public merchants;
    mapping(address => Binding) public payeeBinding;
    mapping(address => Binding) public signerBinding;
    mapping(address => bool) public blocked;
    mapping(bytes32 => uint64) public proposalEta; // proposal id => earliest execution time

    event Proposed(bytes32 indexed id, bytes32 indexed merchant, address[] payees, address[] signers, uint160 single, uint160 daily, bytes32 salt, uint64 eta);
    event Cancelled(bytes32 indexed id);
    event MerchantSet(bytes32 indexed merchant, uint64 epoch, uint64 validUntil, uint160 single, uint160 daily);
    event MerchantRemoved(bytes32 indexed merchant, uint64 epoch);
    event Renewed(bytes32 indexed merchant, uint64 validUntil);
    event PayeeUnbound(address indexed payee);
    event SignerUnbound(address indexed signer);
    event Blocked(address indexed who, bool blocked);
    event MaintainerProposed(address indexed next, uint64 eta);
    event MaintainerChanged(address indexed previous, address indexed next);

    modifier onlyMaintainer() { require(msg.sender == maintainer, BadMaintainer()); _; }

    constructor(address maintainer_, uint256 delay_) {
        require(maintainer_ != address(0), BadMaintainer());
        require(delay_ >= MIN_DELAY && delay_ <= 30 days, Delay());
        maintainer = maintainer_;
        delay = delay_;
    }

    // ---------------- timelocked additions ----------------
    /// @notice Id of a merchant binding proposal (hash of all its parameters).
    function proposalId(bytes32 merchant, address[] calldata payees, address[] calldata signers, uint160 single, uint160 daily, bytes32 salt)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(merchant, payees, signers, single, daily, salt));
    }

    /// @notice Maintainer: queue a merchant binding; executable after the registry delay.
    function propose(bytes32 merchant, address[] calldata payees, address[] calldata signers, uint160 single, uint160 daily, bytes32 salt)
        external onlyMaintainer returns (bytes32 id)
    {
        require(merchant != bytes32(0), BadMerchant());
        require(payees.length != 0 && payees.length <= MAX_BINDINGS && signers.length <= MAX_BINDINGS, Bindings());
        require(single != 0 && single <= daily, Caps());
        id = proposalId(merchant, payees, signers, single, daily, salt);
        require(proposalEta[id] == 0, Exists());
        uint64 eta = uint64(block.timestamp + delay);
        proposalEta[id] = eta;
        emit Proposed(id, merchant, payees, signers, single, daily, salt, eta);
    }

    /// @notice Maintainer: cancel a queued proposal.
    function cancel(bytes32 id) external onlyMaintainer {
        require(proposalEta[id] != 0, Unknown());
        delete proposalEta[id];
        emit Cancelled(id);
    }

    /// Anyone may execute a matured proposal (the timelock, not the caller, is the safeguard).
    /// Replaces the merchant record: all earlier payee/signer bindings of this merchant become stale.
    function execute(bytes32 merchant, address[] calldata payees, address[] calldata signers, uint160 single, uint160 daily, bytes32 salt) external {
        bytes32 id = proposalId(merchant, payees, signers, single, daily, salt);
        uint64 eta = proposalEta[id];
        require(eta != 0, Unknown());
        require(block.timestamp >= eta, Timelock());
        delete proposalEta[id];
        Merchant storage m = merchants[merchant];
        uint64 epoch = m.epoch + 1;
        m.epoch = epoch;
        m.active = true;
        m.validUntil = uint64(block.timestamp + VALIDITY);
        m.single = single;
        m.daily = daily;
        for (uint256 i; i < payees.length; i++) {
            require(payees[i] != address(0) && !blocked[payees[i]], Payee());
            payeeBinding[payees[i]] = Binding(merchant, epoch);
        }
        for (uint256 i; i < signers.length; i++) {
            require(signers[i] != address(0) && !blocked[signers[i]], Signer());
            signerBinding[signers[i]] = Binding(merchant, epoch);
        }
        emit MerchantSet(merchant, epoch, m.validUntil, single, daily);
    }

    // ---------------- immediate restrictions ----------------
    /// @notice Maintainer: remove a merchant and its bindings immediately (removal is never delayed).
    function remove(bytes32 merchant) external onlyMaintainer {
        Merchant storage m = merchants[merchant];
        m.epoch += 1;
        m.active = false;
        emit MerchantRemoved(merchant, m.epoch);
    }

    /// @notice Maintainer: remove one payee binding immediately.
    function unbindPayee(address payee) external onlyMaintainer { delete payeeBinding[payee]; emit PayeeUnbound(payee); }
    /// @notice Maintainer: remove one signer binding immediately.
    function unbindSigner(address signer) external onlyMaintainer { delete signerBinding[signer]; emit SignerUnbound(signer); }

    /// Blocking a payee or signer is immediate. Unblocking only removes the block; it never lists anything.
    function setBlocked(address who, bool v) external onlyMaintainer { blocked[who] = v; emit Blocked(who, v); }

    /// Re-verification: extends an active record by VALIDITY without changing it.
    function renew(bytes32 merchant) external onlyMaintainer {
        Merchant storage m = merchants[merchant];
        require(m.active, Inactive());
        m.validUntil = uint64(block.timestamp + VALIDITY);
        emit Renewed(merchant, m.validUntil);
    }

    // ---------------- maintainer hand-over (timelocked) ----------------
    /// @notice Maintainer: propose a new maintainer (two-step handover).
    function proposeMaintainer(address next) external onlyMaintainer {
        pendingMaintainer = next;
        pendingMaintainerEta = next == address(0) ? 0 : uint64(block.timestamp + delay);
        emit MaintainerProposed(next, pendingMaintainerEta);
    }

    /// @notice Pending maintainer: accept the handover.
    function acceptMaintainer() external {
        require(msg.sender == pendingMaintainer && pendingMaintainer != address(0), Pending());
        require(block.timestamp >= pendingMaintainerEta, Timelock());
        emit MaintainerChanged(maintainer, msg.sender);
        maintainer = msg.sender;
        pendingMaintainer = address(0);
        pendingMaintainerEta = 0;
    }

    // ---------------- views ----------------
    function _live(Binding memory b, address who) internal view returns (bytes32, uint160, uint160) {
        if (b.merchant == bytes32(0) || blocked[who]) return (bytes32(0), 0, 0);
        Merchant memory m = merchants[b.merchant];
        if (!m.active || m.epoch != b.epoch || block.timestamp >= m.validUntil) return (bytes32(0), 0, 0);
        return (b.merchant, m.single, m.daily);
    }

    /// @notice Live binding for a payee address (zero when unbound or expired).
    function lookupPayee(address payee) public view returns (bytes32, uint160, uint160) { return _live(payeeBinding[payee], payee); }
    /// @notice Live binding for a signer address (zero when unbound or expired).
    function lookupSigner(address signer) public view returns (bytes32, uint160, uint160) { return _live(signerBinding[signer], signer); }

    /// @notice True when `payee` is a live payee bound to `merchant`.
    function isPayeeOf(bytes32 merchant, address payee) external view returns (bool) {
        (bytes32 m,,) = lookupPayee(payee);
        return merchant != bytes32(0) && m == merchant;
    }
}
