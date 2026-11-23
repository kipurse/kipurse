// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import "./KipurseErrors.sol";
import "./KipurseErrorsV55.sol";

import {ISpendPermissionManager} from "./ISpendPermissionManager.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";
import {IKipurseMerchantRegistry} from "./IKipurseMerchantRegistry.sol";
import {KipurseFeeControllerV5} from "./KipurseFeeControllerV5.sol";
import {KipurseTrustV55} from "./KipurseTrustV55.sol";
import {KipurseFloatVaultV55} from "./KipurseFloatVaultV55.sol";
import {IEIP3009} from "./KipurseAdapterV5.sol";
import {PayerVaultV55, PayerVaultFactoryV55} from "./KipursePayerVaultV55.sol";

/// Kipurse V5.5 payment adapter (2026-11-22, handbook §6#119; NOT audited). = KipurseAdapterV54 with the fixes of the
/// November 2026 internal review (docs/audit/INTERNAL_REVIEW_2026-11.md):
///  KR-01 / KR-05  inline payee trust (KPTR) is verified by KipurseTrustV55.inlinePayeeTrust over its own typed data
///                 OwnerInlineTrust (never accepted by trustBySig), with the setTrust record checks.
///  KR-02 / KR-08  PayerVaultV55 ignores reservations the facilitator already settled (EIP-3009 authorizationState), so a
///                 settled-but-unmarked x402 reservation no longer freezes the vault; cancel / reclaim refund the full value
///                 or revert (RefundKept is emitted when a blocklisted wallet refuses it and it stays in the owner's vault).
///  KR-03          the vault is accepted as executor only for the permission it was registered with; registerPermission
///                 is restricted to the account itself or the permission's own executor.
///  KR-07          reconcileFloat falls back to the owner's recovery address (KipurseTrustV55.setRecovery) or the payer vault
///                 when the wallet cannot receive USDC.
/// Everything else (tiers, caps, fees, exactly-once keys, float, pause, signer grants) is the V5.4 logic.
///
/// Same Coinbase Smart Wallet + SpendPermissionManager model: one fixed-term single-period permission whose SPM allowance IS
/// the term cap (never max uint), `spender` = this contract, extraData = abi.encode(Policy).
///  C1 owner trust records (merchant => human-readable name, payees, signers, caps, expiry <= 365 d) live in KipurseTrustV55
///     (created by this constructor; owner typed data keeps THIS contract as verifyingContract). The owner's own trust
///     takes precedence over registry blocks (K8).   C2 payee binding for signed orders.
///  C3 owner signer blacklist.   C4 every payment leaves from the per-owner vault.   C5 optional owner-chosen registry.
///  C6 one-time owner approval.   C7 pause: executor pause expires after 24 h, owner/guardian pause lasts until the owner unpauses.
///  C8 fees, paid by the payer: protocol fee = amount * feePpm / 1e6 rounded up (KipurseFeeControllerV5: only down, hard
///     max 0.3%, owner bounds it with maxFeePpm) + a network fee (gas reimbursement in USDC, <= Policy.maxNetworkFee).
///     Fees do NOT count against per-payment caps; they DO count against every daily cap and the term.
///  C9 exactly-once: purchaseKey(payee, merchantRef, repeatKey) (amount NOT in the key); signed orders: (merchant, orderId).
contract KipurseAdapterV55 {
    using SafeERC20 for IERC20;

    // ---------------- types ----------------
    struct Policy {
        address executor;       // only caller of paying functions
        address guardian;       // optional owner-chosen pauser (0 = none); its pause lasts until the owner unpauses
        uint160 single;         // max merchant amount per payment, every tier (fees excluded)
        uint160 daily;          // max per day incl. fees (day = 24h since permission start)
        uint160 term;           // max for the whole term incl. fees; MUST equal the SPM allowance; 0 is forbidden
        uint160 openSingle;     // stranger tier per payment (0 = strangers disabled)
        uint160 openDaily;      // stranger tier per day incl. fees
        uint160 verifiedSingle; // registry tier per payment ceiling (0 = registry tier disabled)
        uint160 verifiedDaily;  // registry tier per day incl. fees, aggregate over all registry merchants
        address registry;       // optional merchant registry (0 = none)
        uint256 maxFeePpm;      // protocol fee rate the owner accepts; the controller's feePpm must be <= this
        uint256 maxNetworkFee;  // owner-signed ceiling for the per-payment gas reimbursement (actual gas + margin, atomic USDC)
    }
    /// payer = 0: any Kipurse wallet may pay this order; otherwise only that wallet (EIP-712 signed by the merchant).
    struct PaymentOrder { address payee; uint256 amount; bytes32 orderId; uint256 deadline; uint256 chainId; address adapter; address payer; }
    struct Direct { address payee; uint256 amount; bytes32 merchantRef; bytes32 repeatKey; uint256 deadline; }
    struct Auth { address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 merchantRef; bytes32 repeatKey; }

    enum Tier { None, Stranger, Verified, Trusted, Approved }
    struct Route { Tier tier; bytes32 merchant; uint256 single; uint256 merchantDaily; }
    struct Reservation {
        address account; uint64 day; uint64 validBefore; Tier tier; bool open;
        bytes32 permissionHash; bytes32 purchaseKey; bytes32 merchant; uint256 value; uint256 fee; uint256 networkFee; // fee = protocol
    }

    // ---------------- constants ----------------
    uint256 public constant MAX_AUTH_WINDOW = 600;
    uint256 public constant POLICY_LENGTH = 384;
    uint256 internal constant REGISTRY_GAS = 60_000;
    /// A settled x402 reservation nobody marked within this window after validBefore returns its fee to the owner.
    uint256 public constant FEE_CLAIM_WINDOW = 7 days;
    bytes32 public constant ORDER_TYPEHASH =
        keccak256("PaymentOrder(address payee,uint256 amount,bytes32 orderId,uint256 deadline,uint256 chainId,address adapter,address payer)");
    bytes32 public constant APPROVAL_TYPEHASH =
        keccak256("OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)");
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PURCHASE_TAG = keccak256("kipurse.v5.purchase");
    bytes32 public constant SIGNED_TAG = keccak256("kipurse.v5.signed-order");

    // ---------------- immutables ----------------
    ISpendPermissionManager public immutable manager;
    IERC20 public immutable token;
    KipurseFeeControllerV5 public immutable fees;
    PayerVaultFactoryV55 public immutable vaultFactory;
    KipurseTrustV55 public immutable trust; // owner controls (created here)

    // ---------------- storage ----------------
    mapping(address => mapping(bytes32 => bool)) public purchaseUsed;            // account => purchaseKey
    mapping(address => mapping(bytes32 => bool)) public orderUsed;               // signer => orderId (global)
    /// t1181u branch: owner-approval digests already used to prepare an x402 authorization (cancel / reclaim never reopen them).
    mapping(bytes32 => bool) public approvalUsed;
    mapping(bytes32 => uint256) public termSpent;                                // permissionHash
    /// Packed per-day counters (ONE storage slot per permission-day instead of four): total incl. fees, stranger tier,
    /// registry tier, float funded. uint64 atomic USDC = 1.8e13 USDC per day; the total is checked against that bound.
    struct Day { uint64 total; uint64 open; uint64 verified; uint64 floatFunded; }
    mapping(bytes32 => mapping(uint256 => Day)) internal days_;                 // ph => day
    mapping(bytes32 => mapping(bytes32 => mapping(uint256 => uint256))) public merchantDaySpent; // ph => merchant => day
    mapping(address => PayerVaultV55) public vaultOf;
    mapping(bytes32 => Reservation) public reservations; // EIP-3009 digest
    uint256 public accruedFees; // collectable by anyone to fees.feeRecipient()
    uint256 public pendingFees; // fees of open x402 reservations + float fee reserves (refunded on reclaim / cancel / reconcile)
    /// M3 micropayment float: one session per wallet; caps were charged when funded (conservative: never credited back).
    struct Float { bytes32 permissionHash; uint160 funded; uint160 feeReserve; uint64 expiry; bool open; }
    mapping(address => Float) public floats;
    mapping(address => KipurseFloatVaultV55) public floatVaultOf;
    uint256 public constant MAX_FLOAT_SESSION = 1 days;
    /// ownerApproval prefix selecting the inline payee-trust form (a Coinbase SignatureWrapper always starts with 0x00000000).
    bytes4 public constant INLINE_TRUST_TAG = 0x4b505452; // "KPTR"
    bool private transient entered; // EIP-1153 lock (100 gas TSTORE/TLOAD instead of 2 SSTOREs)

    // ---------------- events ----------------
    event Paid(bytes32 indexed permissionHash, bytes32 indexed purchaseKey, address indexed account, address payee, uint256 amount, uint256 fee, uint256 networkFee, Tier tier, bytes32 merchant);
    event FeesCollected(address indexed recipient, uint256 amount);
    event FeeReturned(address indexed account, bytes32 indexed purchaseKey, uint256 fee);
    event OrderPaid(address indexed signer, bytes32 indexed orderId, bytes32 indexed purchaseKey);
    event AuthorizationPrepared(bytes32 indexed purchaseKey, address indexed account, address indexed vault, bytes32 digest, address to, uint256 value, uint256 fee, uint256 validAfter, uint256 validBefore);
    event AuthorizationClosed(bytes32 indexed digest, bool settled, uint256 value, uint256 fee, uint256 networkFee);
    event FloatFunded(address indexed account, address indexed floatVault, address sessionKey, uint256 amount, uint256 feeReserve, uint256 networkFee, uint64 expiry);
    event PermissionRegistered(address indexed account, bytes32 indexed permissionHash, address indexed vault, address sessionSigner, uint256 maxGasPerOp);
    event FloatReconciled(address indexed account, uint256 spent, uint256 fee, uint256 returned);
    /// KR-08: a cancelled / reclaimed x402 value the wallet refused (USDC blocklist); it stays, unreserved, in the owner's vault.
    event RefundKept(bytes32 indexed digest, address indexed account, uint256 value);
    /// V55-03: part of a cancelled / reclaimed x402 value the vault could not cover (should never happen; I-8). The caps, the
    /// purchase key and the reservation are still released so the owner's exit is never blocked.
    event RefundShortfall(bytes32 indexed digest, address indexed account, uint256 missing);
    constructor(ISpendPermissionManager m, IERC20 t, PayerVaultFactoryV55 f, KipurseFeeControllerV5 fc) {
        require(address(m).code.length != 0 && address(t).code.length != 0 && address(f).code.length != 0 && address(fc).code.length != 0, Contracts());
        manager = m; token = t; vaultFactory = f; fees = fc; trust = new KipurseTrustV55();
        f.prepare(t, address(trust)); // shared vault implementations; every vault is then a cheap EIP-1167 clone
    }

    modifier nonReentrant() { require(!entered, Reentrant()); entered = true; _; entered = false; }

    // =====================================================================================================
    // Owner controls live in `trust` (KipurseTrustV55): setTrust / untrust / deny / registry opt-out / setPaused (owner unpause)
    // and their BySig variants. Only the pause of a live permission's executor / guardian goes through here.
    // =====================================================================================================
    /// Executor (24 h, expires by itself) or guardian (until the owner unpauses) of a currently valid permission.
    function pause(ISpendPermissionManager.SpendPermission calldata p) external {
        require(p.spender == address(this) && p.extraData.length == POLICY_LENGTH && manager.isValid(p), Permission());
        Policy memory pol = abi.decode(p.extraData, (Policy));
        bool g = pol.guardian != address(0) && msg.sender == pol.guardian;
        require(g || msg.sender == pol.executor || msg.sender == address(vaultOf[p.account]), Pauser());
        trust.pauseFor(p.account, msg.sender, g);
    }

    /// @notice The account itself (owner batch) or the permission's own executor: bind a currently valid permission (its hash,
    ///  session signer Policy.executor and per-op USDC gas ceiling Policy.maxNetworkFee) to the owner's vault, deploying the
    ///  vault if needed. After this the vault is the ERC-4337 sender for this owner and executes ONLY for this permission (KR-03).
    ///  V55-02: the permission must be live now (start <= now < end, approved, not revoked). The executor may only bind an
    ///  unbound vault, re-bind the same permission, or replace a binding whose permission has ended; anything else needs the
    ///  account itself.
    function registerPermission(ISpendPermissionManager.SpendPermission calldata p) external returns (address vault) {
        require(p.spender == address(this) && p.token == address(token) && p.extraData.length == POLICY_LENGTH
            && block.timestamp >= p.start && block.timestamp < p.end && manager.isValid(p), Permission());
        Policy memory pol = abi.decode(p.extraData, (Policy));
        require(msg.sender == p.account || msg.sender == pol.executor, Registrar());
        vault = _vault(p.account);
        bytes32 ph = manager.getHash(p);
        if (msg.sender != p.account) {
            bytes32 cur = PayerVaultV55(vault).permissionHash();
            require(cur == bytes32(0) || cur == ph || block.timestamp >= PayerVaultV55(vault).permissionEnd(), Registrar());
        }
        PayerVaultV55(vault).setSession(pol.executor, pol.maxNetworkFee, ph, p.end);
        emit PermissionRegistered(p.account, ph, vault, pol.executor, pol.maxNetworkFee);
    }

    // =====================================================================================================
    // Views
    // =====================================================================================================
    function _domain(bytes32 name) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, name, keccak256("5"), block.chainid, address(this)));
    }
    /// @notice EIP-712 digest a merchant signer signs for a PaymentOrder.
    function orderDigest(PaymentOrder calldata o) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domain(keccak256("AgentWalletPaymentOrder")),
            keccak256(abi.encode(ORDER_TYPEHASH, o.payee, o.amount, o.orderId, o.deadline, o.chainId, o.adapter, o.payer))));
    }
    /// @notice Owner-signature digest (replay-safe for the Smart Wallet) used by every BySig owner action.
    function ownerDigest(bytes32 structHash) public view returns (bytes32) { return trust.ownerDigest(structHash); }
    /// @notice Digest the owner signs to approve one purchase above trust (step-up approval).
    function approvalDigest(address account, bytes32 purchaseKey_, address payee, uint256 amount, uint256 deadline) public view returns (bytes32) {
        return ownerDigest(keccak256(abi.encode(APPROVAL_TYPEHASH, account, purchaseKey_, payee, amount, deadline)));
    }
    /// Canonical purchase identity for direct and x402 (shared key space). The amount is NOT part of it: a changed price
    /// for the same merchant reference is the same purchase (cannot be paid twice).
    function purchaseKey(address payee, bytes32 merchantRef, bytes32 repeatKey) public pure returns (bytes32) {
        return keccak256(abi.encode(PURCHASE_TAG, payee, merchantRef, repeatKey));
    }
    /// @notice Purchase key for a merchant-signed order: one payment per (merchant, orderId).
    function signedPurchaseKey(bytes32 merchant, bytes32 orderId) public pure returns (bytes32) {
        return keccak256(abi.encode(SIGNED_TAG, merchant, orderId));
    }
    /// Protocol fee: pure percentage, no cap, no minimum (tiny payments may round to 0).
    /// Protocol fee, rounded UP to the 6-decimal unit (every non-zero payment pays >= 1 atomic unit while feePpm > 0).
    function feeFor(uint256 amount) public view returns (uint256) { return (amount * fees.feePpm() + 999_999) / 1_000_000; }
    /// @notice EIP-3009 TransferWithAuthorization digest that the payer vault will approve via ERC-1271.
    function authorizationDigest(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        public view returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", IEIP3009(address(token)).DOMAIN_SEPARATOR(),
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
    }
    /// @notice Deterministic payer-vault address for an account.
    function vaultAddress(address account) public view returns (address) {
        return vaultFactory.vaultAddress(address(this), account, token);
    }
    /// @notice Index of the current daily window of the permission (relative to its start).
    function dayIndex(ISpendPermissionManager.SpendPermission calldata p) public view returns (uint256) {
        require(block.timestamp >= p.start, Term());
        return (block.timestamp - p.start) / 1 days;
    }

    // =====================================================================================================
    // Paying functions (executor only). networkFee: per-payment gas/service recovery, <= Policy.maxNetworkFee.
    // =====================================================================================================
    /// @notice Executor: pay a merchant-signed order through the spend permission; fee and network fee are charged to the payer.
    function paySigned(ISpendPermissionManager.SpendPermission calldata p, PaymentOrder calldata o, bytes calldata signature, uint256 networkFee, uint48 txDeadline)
        external nonReentrant
    {
        Policy memory pol = _policy(p, txDeadline, o.payee, o.amount, networkFee);
        require(o.chainId == block.chainid && o.adapter == address(this), Domain());
        require(o.payer == address(0) || o.payer == p.account, Payer());
        require(o.orderId != bytes32(0) && block.timestamp < o.deadline, Expired());
        address signer = ECDSA.recover(orderDigest(o), signature);
        Route memory r = _routeSigned(p.account, pol, signer, o.payee);
        require(!orderUsed[signer][o.orderId], Duplicate());
        orderUsed[signer][o.orderId] = true;
        bytes32 key = signedPurchaseKey(r.merchant, o.orderId);
        _usePurchase(p.account, key);
        _settleNow(p, pol, r, o.payee, o.amount, networkFee, key);
        emit OrderPaid(signer, o.orderId, key);
    }

    /// @notice Executor: pay a merchant-signed order to the order's own payee under the owner's inline signer trust
    ///  (ownerSignerTrust = abi.encode(KipurseTrustV55.SignerTrust, nonce, deadline, ownerSig)). Strict payer binding: the order
    ///  must name THIS wallet as payer (an unbound order could be someone else's purchase). Unknown / ungranted signers revert;
    ///  they keep using paySigned (V5.2 payee binding) or payDirect with the owner's per-payment approval.
    function paySignedTrusted(ISpendPermissionManager.SpendPermission calldata p, PaymentOrder calldata o, bytes calldata signature,
        bytes calldata ownerSignerTrust, uint256 networkFee, uint48 txDeadline) external nonReentrant
    {
        Policy memory pol = _policy(p, txDeadline, o.payee, o.amount, networkFee);
        require(o.chainId == block.chainid && o.adapter == address(this), Domain());
        require(o.payer == p.account, Payer());
        require(o.orderId != bytes32(0) && block.timestamp < o.deadline, Expired());
        address signer = ECDSA.recover(orderDigest(o), signature);
        (bytes32 m, uint160 ts, uint160 td) = trust.inlineSignerTrust(p.account, signer, ownerSignerTrust); // incl. denied signer
        Route memory r = Route(Tier.Trusted, m, _min(ts, pol.single), td);
        require(!orderUsed[signer][o.orderId], Duplicate());
        orderUsed[signer][o.orderId] = true;
        bytes32 key = signedPurchaseKey(m, o.orderId);
        _usePurchase(p.account, key);
        _settleNow(p, pol, r, o.payee, o.amount, networkFee, key);
        emit OrderPaid(signer, o.orderId, key);
    }

    /// @notice Executor: pay a payee directly (trusted, within caps, or with an owner approval); fee and network fee are charged to the payer.
    function payDirect(ISpendPermissionManager.SpendPermission calldata p, Direct calldata d, bytes calldata ownerApproval, uint256 networkFee, uint48 txDeadline)
        external nonReentrant
    {
        Policy memory pol = _policy(p, txDeadline, d.payee, d.amount, networkFee);
        require(d.merchantRef != bytes32(0) && block.timestamp < d.deadline, Expired());
        bytes32 key = purchaseKey(d.payee, d.merchantRef, d.repeatKey);
        Route memory r = _routeWithApproval(p.account, pol, d.payee, d.amount, key, d.deadline, ownerApproval);
        _usePurchase(p.account, key);
        _settleNow(p, pol, r, d.payee, d.amount, networkFee, key);
    }

    /// Mode 3: x402 / MPP exact, ONE sponsored tx per payment. amount moves into the vault, which ERC-1271-approves exactly
    /// one TransferWithAuthorization(from = vault, nonce = purchaseKey); fees wait in this contract until the reservation is
    /// closed (markSettled, batched and deferred) or refunded (reclaim / cancelReservation).
    function prepareAuthorization(ISpendPermissionManager.SpendPermission calldata p, Auth calldata a, bytes calldata ownerApproval, uint256 networkFee, uint48 txDeadline)
        external nonReentrant returns (address vault, bytes32 digest, bytes32 nonce)
    {
        Policy memory pol = _policy(p, txDeadline, a.to, a.value, networkFee);
        require(a.merchantRef != bytes32(0), Expired());
        require(a.validAfter < block.timestamp && a.validBefore > block.timestamp && a.validBefore - block.timestamp <= MAX_AUTH_WINDOW, Window());
        nonce = purchaseKey(a.to, a.merchantRef, a.repeatKey);
        Route memory r = _routeWithApproval(p.account, pol, a.to, a.value, nonce, a.validBefore, ownerApproval);
        _usePurchase(p.account, nonce);
        if (r.tier == Tier.Approved) { // t1181u branch: one owner approval = one reservation, even after cancelReservation
            bytes32 ad = approvalDigest(p.account, nonce, a.to, a.value, a.validBefore);
            require(!approvalUsed[ad], ApprovalUsed());
            approvalUsed[ad] = true;
        }
        vault = _vault(p.account);
        require(vault != a.to, Payee());
        require(!IEIP3009(address(token)).authorizationState(vault, nonce), NonceUsed());
        uint256 fee = feeFor(a.value);
        (bytes32 ph, uint256 day) = _charge(p, pol, r, a.value, fee + networkFee);
        _pull(p, a.value + fee + networkFee);
        token.safeTransfer(vault, a.value + networkFee); // networkFee = USDC gas top-up of the owner's vault (pays the paymaster)
        pendingFees += fee;
        digest = authorizationDigest(vault, a.to, a.value, a.validAfter, a.validBefore, nonce);
        require(!reservations[digest].open, Digest());
        reservations[digest] = Reservation({account: p.account, day: uint64(day), validBefore: uint64(a.validBefore), tier: r.tier, open: true,
            permissionHash: ph, purchaseKey: nonce, merchant: r.merchant, value: a.value, fee: fee, networkFee: networkFee});
        PayerVaultV55(vault).approveDigest(digest, a.validBefore, a.value, nonce);
        emit AuthorizationPrepared(nonce, p.account, vault, digest, a.to, a.value, fee + networkFee, a.validAfter, a.validBefore);
    }

    /// Anyone, any time after the facilitator settled, in BATCHES (one tx closes many reservations): close each settled
    /// reservation and move its fee to accruedFees. Unsettled / closed digests are skipped. If nobody marked a reservation
    /// within FEE_CLAIM_WINDOW after validBefore, its fee goes back to the owner instead (fees can never get stuck).
    function markSettled(bytes32[] calldata digests) external nonReentrant returns (uint256 closed) {
        for (uint256 i; i < digests.length; i++) {
            Reservation storage r = reservations[digests[i]];
            if (!r.open) continue;
            PayerVaultV55 vault = vaultOf[r.account];
            if (!IEIP3009(address(token)).authorizationState(address(vault), r.purchaseKey)) continue;
            r.open = false;
            vault.close(digests[i]);
            pendingFees -= r.fee;
            if (block.timestamp >= uint256(r.validBefore) + FEE_CLAIM_WINDOW) {
                _refundFee(r.account, address(vault), r.fee); // K-1 fixed: never reverts the batch
                emit FeeReturned(r.account, r.purchaseKey, r.fee);
            } else accruedFees += r.fee;
            emit Paid(r.permissionHash, r.purchaseKey, r.account, address(0), r.value, r.fee, r.networkFee, r.tier, r.merchant);
            emit AuthorizationClosed(digests[i], true, r.value, r.fee, r.networkFee);
            closed++;
        }
    }

    /// Anyone: send all accrued fees to the fee recipient in one transfer. If that transfer fails (e.g. a blocklisted
    /// recipient), fees simply stay accrued until the recipient is changed through the controller's 48 h timelock.
    function collectFees() external nonReentrant returns (uint256 amount) {
        amount = accruedFees;
        accruedFees = 0;
        address to = fees.feeRecipient();
        token.safeTransfer(to, amount);
        emit FeesCollected(to, amount);
    }

    /// Anyone, after validBefore, if the authorization was never used: refund the wallet (value + protocol fee), credit caps
    /// by that, free the key. The network fee is NOT refunded: it reimbursed gas that was really spent (users bear all gas).
    /// KR-08: the value is refunded in full (or the call reverts); a settled sibling reservation no longer reduces it.
    function reclaim(bytes32 digest) external nonReentrant {
        Reservation storage r = reservations[digest];
        require(r.open, BadReservation());
        require(block.timestamp >= r.validBefore, NotExpired());
        _release(digest, r);
    }

    /// The wallet (owner) may cancel its own open reservation at any time, e.g. during an emergency exit.
    function cancelReservation(bytes32 digest) external nonReentrant {
        Reservation storage r = reservations[digest];
        require(r.open && r.account == msg.sender, BadReservation());
        _release(digest, r);
    }

    // =====================================================================================================
    // M3 micropayment float (sub-$1 x402 payments without one of our txs each)
    // =====================================================================================================
    /// Executor: move `amount` (<= the owner's trust.floatCap per day, <= Policy.single) from the wallet into the float vault and
    /// open a session for `sessionKey` until `expiry` (<= 24 h). Pulls amount + fee reserve (0.1% of amount, rounded up) +
    /// networkFee (this tx's gas + the reconcile share). Counts against the daily and term caps.
    function fundFloat(ISpendPermissionManager.SpendPermission calldata p, address sessionKey, uint256 amount, uint64 expiry,
        uint256 networkFee, uint48 txDeadline) external nonReentrant
    {
        address fv = floatAddress(p.account);
        Policy memory pol = _policy(p, txDeadline, fv, amount, networkFee);
        require(!floats[p.account].open, FloatOpen());
        require(sessionKey != address(0) && pol.openSingle != 0, Session());
        require(expiry > block.timestamp && expiry <= block.timestamp + MAX_FLOAT_SESSION && expiry <= p.end, FloatExpiry());
        uint256 feeRes = feeFor(amount);
        (bytes32 ph, uint256 day) = _charge(p, pol, Route(Tier.None, bytes32(0), 0, 0), amount, feeRes + networkFee);
        Day storage dd = days_[ph][day]; // warm slot (just written by _charge)
        uint256 f = dd.floatFunded + amount; // <= dd.total, so it fits uint64
        require(f <= trust.floatCap(p.account), FloatCap());
        dd.floatFunded = uint64(f);
        KipurseFloatVaultV55 v = floatVaultOf[p.account];
        if (address(v) == address(0)) {
            v = KipurseFloatVaultV55(vaultFactory.deployFloat(p.account, token));
            require(address(v) == fv && v.adapter() == address(this), Vault());
            floatVaultOf[p.account] = v;
        }
        _pull(p, amount + feeRes + networkFee);
        token.safeTransfer(fv, amount);
        if (networkFee != 0) token.safeTransfer(_vault(p.account), networkFee); // gas top-up stays owner money
        v.open(sessionKey, expiry, uint160(pol.openSingle));
        pendingFees += feeRes;
        floats[p.account] = Float(ph, uint160(amount), uint160(feeRes), expiry, true);
        emit FloatFunded(p.account, fv, sessionKey, amount, feeRes, networkFee, expiry);
    }

    /// Anyone after the session expired, or the wallet (owner exit) at any time: protocol fee on what was actually spent
    /// (funded - remaining, rounded up, never above the reserve); the rest of the reserve and every remaining USDC go back.
    /// KR-07: if the wallet refuses USDC (blocklisted), both go to the owner's recovery address (trust.setRecovery) or, if
    /// none is set, to the owner's payer vault (withdrawable by the owner to any address).
    function reconcileFloat(address account) external nonReentrant returns (uint256 spent, uint256 fee) {
        Float storage fl = floats[account];
        require(fl.open && (block.timestamp >= fl.expiry || msg.sender == account), BadFloat());
        fl.open = false;
        KipurseFloatVaultV55 v = floatVaultOf[account];
        uint256 bal = token.balanceOf(address(v));
        spent = fl.funded > bal ? fl.funded - bal : 0;
        fee = _min(feeFor(spent), fl.feeReserve);
        pendingFees -= fl.feeReserve;
        accruedFees += fee;
        uint256 back = fl.feeReserve - fee;
        address alt = trust.recoveryOf(account);
        if (alt == address(0)) alt = _vault(account);
        if (back != 0 && !_try(account, back)) token.safeTransfer(alt, back);
        uint256 returned = v.close(alt);
        emit FloatReconciled(account, spent, fee, returned + back);
    }

    /// Float session gate (read by the float vault's ERC-1271): paused wallet or owner-denied payee => refuse.
    function floatBlocked(address account, address to) external view returns (bool) {
        return trust.isPaused(account) || trust.deniedPayee(account, to) || to == account || to == address(0);
    }
    /// @notice Deterministic float-vault address for an account.
    function floatAddress(address account) public view returns (address) { return vaultFactory.floatAddress(address(this), account, token); }

    // =====================================================================================================
    // Internals
    // =====================================================================================================
    function _release(bytes32 digest, Reservation storage r) internal {
        PayerVaultV55 vault = vaultOf[r.account];
        require(!IEIP3009(address(token)).authorizationState(address(vault), r.purchaseKey), Settled());
        r.open = false;
        vault.close(digest);
        // KR-08: refund the value from unreserved USDC (reserved() ignores settled siblings). V55-03: never revert for lack of
        // funds (RefundShortfall reports a gap). K-1: a USDC-blocklisted wallet keeps the refund in the owner's vault
        // (RefundKept), withdrawable to any address with vault.withdraw.
        (uint256 paid, bool delivered) = vault.refund(r.account, r.value);
        if (!delivered) emit RefundKept(digest, r.account, paid);
        if (paid < r.value) emit RefundShortfall(digest, r.account, r.value - paid);
        // R2-01: caps are credited only with what actually came back (+ fee); a shortfall stays charged. The network fee
        // stays charged too: its gas was spent.
        uint256 total = paid + r.fee;
        bytes32 ph = r.permissionHash; uint256 day = r.day;
        termSpent[ph] -= total;
        Day memory dd = days_[ph][day];
        dd.total -= uint64(total);
        if (r.tier == Tier.Stranger) dd.open -= uint64(total);
        if (r.tier == Tier.Verified) dd.verified -= uint64(total);
        days_[ph][day] = dd;
        if (r.tier == Tier.Verified || r.tier == Tier.Trusted) merchantDaySpent[ph][r.merchant][day] -= total;
        purchaseUsed[r.account][r.purchaseKey] = false;
        pendingFees -= r.fee;
        _refundFee(r.account, address(vault), r.fee);
        emit AuthorizationClosed(digest, false, r.value, r.fee, r.networkFee);
    }

    function _policy(ISpendPermissionManager.SpendPermission calldata p, uint48 txDeadline, address payee, uint256 amount, uint256 networkFee)
        internal view returns (Policy memory pol)
    {
        require(p.spender == address(this) && p.token == address(token), Scope());
        require(p.end > p.start && p.period == p.end - p.start && p.period <= 365 days, Term());
        require(p.extraData.length == POLICY_LENGTH, BadPolicy());
        pol = abi.decode(p.extraData, (Policy));
        // caller: the session signer itself, or the owner's vault (ERC-4337 sender, zero reserve) - the vault only for the ONE
        // permission it was registered with (KR-03)
        PayerVaultV55 v = vaultOf[p.account];
        require(pol.executor != address(0) && (msg.sender == pol.executor || msg.sender == address(v)), BadExecutor());
        if (msg.sender != pol.executor) require(v.permissionHash() == manager.getHash(p), VaultPermission());
        require(pol.term != 0 && p.allowance == pol.term, Allowance()); // SPM is an independent second cap = the real term cap
        require(pol.daily != 0 && pol.single != 0 && pol.single <= pol.daily && pol.daily <= pol.term, BadPolicy());
        require(pol.openSingle <= pol.single && pol.openDaily <= pol.daily, BadPolicy());
        require(pol.verifiedSingle <= pol.single && pol.verifiedDaily <= pol.daily, BadPolicy());
        require(fees.feePpm() <= pol.maxFeePpm, Fee());
        require(networkFee <= pol.maxNetworkFee, NetworkFee());
        require(block.timestamp < txDeadline && txDeadline - block.timestamp <= 300, Operation());
        (bool isP, bool denied,) = trust.gate(p.account, payee);
        require(!isP, WalletPaused());
        require(amount != 0 && amount <= pol.single, Amount());
        require(payee != address(0) && payee != address(this) && payee != p.account && payee != address(manager)
            && payee != address(token) && payee != vaultAddress(p.account), Payee());
        require(!denied, Denied());
    }

    function _useRegistry(address account, Policy memory pol) internal view returns (bool) {
        if (pol.registry == address(0)) return false;
        (,, bool optOut) = trust.gate(account, address(0));
        return !optOut;
    }
    /// A failing / gas-griefing registry is treated as "not listed, not blocked".
    function _regBlocked(address reg, address who) internal view returns (bool) {
        try IKipurseMerchantRegistry(reg).blocked{gas: REGISTRY_GAS}(who) returns (bool b) { return b; } catch { return false; }
    }
    function _regPayee(address reg, address payee) internal view returns (bytes32 m, uint160 s, uint160 d) {
        try IKipurseMerchantRegistry(reg).lookupPayee{gas: REGISTRY_GAS}(payee) returns (bytes32 m_, uint160 s_, uint160 d_) {
            return (m_, s_, d_);
        } catch { return (bytes32(0), 0, 0); }
    }
    function _regSigner(address reg, address signer) internal view returns (bytes32 m, uint160 s, uint160 d) {
        try IKipurseMerchantRegistry(reg).lookupSigner{gas: REGISTRY_GAS}(signer) returns (bytes32 m_, uint160 s_, uint160 d_) {
            return (m_, s_, d_);
        } catch { return (bytes32(0), 0, 0); }
    }
    function _regIsPayeeOf(address reg, bytes32 merchant, address payee) internal view returns (bool) {
        try IKipurseMerchantRegistry(reg).isPayeeOf{gas: REGISTRY_GAS}(merchant, payee) returns (bool b) { return b; } catch { return false; }
    }
    function _min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }

    function _routePayee(address account, Policy memory pol, address payee) internal view returns (Route memory) {
        // K8: the owner's own trust wins; a registry block only affects registry / stranger routing
        (bytes32 tm, uint160 ts, uint160 td) = trust.payeeTrust(account, payee);
        if (tm != bytes32(0)) return Route(Tier.Trusted, tm, _min(ts, pol.single), td);
        bool reg = _useRegistry(account, pol);
        if (reg && _regBlocked(pol.registry, payee)) revert RegistryBlocked();
        if (reg && pol.verifiedSingle != 0) {
            (bytes32 m, uint160 s, uint160 d) = _regPayee(pol.registry, payee);
            if (m != bytes32(0)) return Route(Tier.Verified, m, _min(s, pol.verifiedSingle), _min(d, pol.verifiedDaily));
        }
        return Route(Tier.Stranger, bytes32(0), pol.openSingle, 0);
    }
    function _routeWithApproval(address account, Policy memory pol, address payee, uint256 amount, bytes32 key, uint256 deadline,
        bytes calldata ownerApproval) internal view returns (Route memory r)
    {
        if (ownerApproval.length >= 4 && bytes4(ownerApproval[:4]) == INLINE_TRUST_TAG) {
            (bytes32 m, uint160 ts, uint160 td) = trust.inlinePayeeTrust(account, payee, ownerApproval[4:]); // KR-01 / KR-05
            return Route(Tier.Trusted, m, _min(ts, pol.single), td);
        }
        r = _routePayee(account, pol, payee);
        if (ownerApproval.length != 0) {
            require(SignatureChecker.isValidSignatureNow(account, approvalDigest(account, key, payee, amount, deadline), ownerApproval), Approval());
            r = Route(Tier.Approved, bytes32(0), pol.single, 0);
        }
    }
    function _routeSigned(address account, Policy memory pol, address signer, address payee) internal view returns (Route memory) {
        require(!trust.deniedSigner(account, signer), BadSignerDenied());
        (bytes32 tm, uint160 ts, uint160 td, bool bound) = trust.signerTrust(account, signer, payee);
        if (tm != bytes32(0)) {
            require(bound, PayeeBinding());
            return Route(Tier.Trusted, tm, _min(ts, pol.single), td);
        }
        bool reg = _useRegistry(account, pol);
        if (reg && (_regBlocked(pol.registry, signer) || _regBlocked(pol.registry, payee))) revert RegistryBlocked();
        if (reg && pol.verifiedSingle != 0) {
            (bytes32 m, uint160 s, uint160 d) = _regSigner(pol.registry, signer);
            if (m != bytes32(0)) {
                require(_regIsPayeeOf(pol.registry, m, payee), PayeeBinding());
                return Route(Tier.Verified, m, _min(s, pol.verifiedSingle), _min(d, pol.verifiedDaily));
            }
        }
        revert Signer();
    }

    /// Fee refund that never reverts (K-1): to the wallet; if USDC refuses (blocklisted), to the owner's vault; if that
    /// also fails, the fee is kept as protocol fee (accruedFees) rather than blocking settlement for everyone.
    function _refundFee(address account, address vault, uint256 fee) internal {
        if (fee == 0 || _try(account, fee) || _try(vault, fee)) return;
        accruedFees += fee;
    }
    function _try(address to, uint256 amt) internal returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amt)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
    /// @notice Packed day counters (total incl. fees / stranger / registry / float funded) of a permission-day.
    function daySpent(bytes32 ph, uint256 day) external view returns (uint256) { return days_[ph][day].total; }
    function openDaySpent(bytes32 ph, uint256 day) external view returns (uint256) { return days_[ph][day].open; }
    function verifiedDaySpent(bytes32 ph, uint256 day) external view returns (uint256) { return days_[ph][day].verified; }
    function floatDaySpent(bytes32 ph, uint256 day) external view returns (uint256) { return days_[ph][day].floatFunded; }

    function _usePurchase(address account, bytes32 key) internal {
        require(!purchaseUsed[account][key], DuplicatePurchase());
        purchaseUsed[account][key] = true;
    }

    /// Per-payment caps compare the merchant amount only; every daily cap and the term count amount + fees.
    function _charge(ISpendPermissionManager.SpendPermission calldata p, Policy memory pol, Route memory r, uint256 amount, uint256 fee)
        internal returns (bytes32 ph, uint256 day)
    {
        if (r.tier == Tier.Stranger) require(r.single != 0 && amount <= r.single, BadStranger());
        else if (r.tier == Tier.Verified) require(amount <= r.single, VerifiedCap());
        else if (r.tier == Tier.Trusted) require(amount <= r.single, MerchantCap());
        uint256 charge = amount + fee;
        ph = manager.getHash(p);
        day = dayIndex(p);
        uint256 newTerm = termSpent[ph] + charge;
        Day memory dd = days_[ph][day]; // one SLOAD for all four day counters
        uint256 newDay = dd.total + charge;
        require(newTerm <= pol.term, TermCap());
        require(newDay <= pol.daily && newDay <= type(uint64).max, DailyCap());
        termSpent[ph] = newTerm;
        dd.total = uint64(newDay); // every tier counter is <= total, so they fit too
        if (r.tier == Tier.Stranger) {
            uint256 v = dd.open + charge;
            require(v <= pol.openDaily, StrangerDailyCap());
            dd.open = uint64(v);
        } else if (r.tier == Tier.Verified) {
            uint256 v = dd.verified + charge;
            require(v <= pol.verifiedDaily, VerifiedDailyCap());
            dd.verified = uint64(v);
        }
        days_[ph][day] = dd; // one SSTORE
        if (r.tier == Tier.Verified || r.tier == Tier.Trusted) {
            uint256 v = merchantDaySpent[ph][r.merchant][day] + charge;
            require(v <= r.merchantDaily, MerchantDailyCap());
            merchantDaySpent[ph][r.merchant][day] = v;
        }
    }

    function _vault(address account) internal returns (address) {
        PayerVaultV55 v = vaultOf[account];
        if (address(v) == address(0)) {
            v = PayerVaultV55(vaultFactory.deploy(account, token));
            require(address(v) == vaultAddress(account) && v.adapter() == address(this), Vault());
            vaultOf[account] = v;
        }
        return address(v);
    }

    /// SPM pulls exactly `total` from the wallet into this adapter (the SPM allowance is the term cap: second, independent limit).
    function _pull(ISpendPermissionManager.SpendPermission calldata p, uint256 total) internal {
        uint256 beforeSelf = token.balanceOf(address(this));
        manager.spend(p, uint160(total));
        require(token.balanceOf(address(this)) == beforeSelf + total, Pull());
    }

    /// direct / signed: ONE sponsored tx. amount: wallet -> adapter -> vault -> payee; fees stay here as accruedFees.
    function _settleNow(ISpendPermissionManager.SpendPermission calldata p, Policy memory pol, Route memory r, address payee, uint256 amount,
        uint256 networkFee, bytes32 key) internal
    {
        uint256 fee = feeFor(amount);
        (bytes32 ph,) = _charge(p, pol, r, amount, fee + networkFee);
        address vault = _vault(p.account);
        uint256 beforePayee = token.balanceOf(payee);
        _pull(p, amount + fee + networkFee);
        token.safeTransfer(vault, amount + networkFee); // networkFee = USDC gas top-up of the owner's vault
        PayerVaultV55(vault).pay(payee, amount);
        require(token.balanceOf(payee) == beforePayee + amount, Delivery());
        accruedFees += fee;
        emit Paid(ph, key, p.account, payee, amount, fee, networkFee, r.tier, r.merchant);
    }
}
