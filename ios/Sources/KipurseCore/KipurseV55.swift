// SPDX-License-Identifier: Apache-2.0
import Foundation

/// t1250 (handbook §6#119): the Kipurse V5.5 suite on the phone. Public chain constants (gw/mainnet/v55-deploy-plan.json), the six owner digests
/// the Face ID key seat V2 accepts, its signature wrapper (owner index 1) and the KR-05 rules for trusts. Mirrors KipurseKeySeatV2 / KipurseTrustV55.
/// V55-01: everything here is computed ON THE PHONE from the fields it shows; the phone never signs a digest taken from a server or a contract view.
/// Pinned against the deployed contracts by Tests/KipurseCoreTests/t1250-v55-vectors.json.txt (T1250V55Tests).
public enum KipurseV55 {
  public static let chainId = 8453
  public static let adapter = "0x53F99af228A165A312Ed4A7E47447a9137dbf03e"
  /// CREATE(adapter, nonce 1): the adapter constructor deploys its trust contract.
  public static let trust = "0xDBb66b5E7a2773e0419093Ea5cf6E70E68A747B4"
  public static let vaultFactory = "0xC01C40bBE92D0e959C2730c5f62F2737baEEc248"
  /// CREATE(factory, 1) / CREATE(factory, 2): vault and float implementations (factory.prepare, called by the adapter constructor).
  public static let vaultImpl = "0xB0F92441A31CbCB7Baa5659a08228De8De7d2BDf"
  public static let floatImpl = "0x54830Fc7042DBe7A4Eb03928ACf22Cf7B251780b"
  public static let registryV2 = "0xB8ce1FfCbF88DBd73C5C6f557b3D68cF0b92Eb68"
  public static let feeController = "0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A"
  public static let spendPermissionManager = RequestVerify.spendPermissionManager
  public static let usdc = RequestVerify.usdc
  public static let cbswFactory = "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842"
  public static let deployer = "0x4e59b44847b379578588920cA78FbF26c0B4956C"
  public static let entryPoint = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
  public static let feeTo = RequestVerify.duesTo
  static var v54: KipurseSuite { .v54 }   // the owner's current wallet (only for checking the move batch)
  /// owners [0 Base Account, 1 key seat V2, 2 SpendPermissionManager]
  public static let seatOwnerIndex: UInt64 = 1
  public static let noExpiry = RequestVerify.noExpiry   // 2^64-1: inline "remember" trust, no expiry (owner decision t553/t554)
  public static let maxTrust: UInt64 = 365 * 86400      // MAX_TRUST: finite trust expiry bound (stored and inline, V55-07)
  public static let inlineTrustTag: [UInt8] = [0x4b, 0x50, 0x54, 0x52]   // "KPTR"
  public static let moveFeeCap: UInt64 = 150_000          // MOVE_V55_FEE_CAP (0.15 USDC)
  public static let vaultSeedMax: UInt64 = 200_000

  static func lc(_ s: String) -> String { s.lowercased() }
  static func a20(_ s: String) -> [UInt8]? { BatchVerify.addrBytes(s) }

  // MARK: addresses computed on the phone
  /// CREATE address for a small nonce (1...127): keccak(rlp([sender, nonce]))[12:].
  static func createAddress(_ from: String, nonce: UInt8) -> String? {
    guard let f = a20(from), nonce > 0, nonce < 0x80 else { return nil }
    return Hex.encode(Array(Keccak.hash([0xd6, 0x94] + f + [nonce]).suffix(20))) }
  /// The pinned constants agree with how they were created (trust = CREATE(adapter,1), vault/float impl = CREATE(factory,1/2)).
  public static func constantProblems() -> [String] {
    var p = [String]()
    if createAddress(adapter, nonce: 1) != lc(trust) { p.append("trust is not the adapter's first contract") }
    if createAddress(vaultFactory, nonce: 1) != lc(vaultImpl) { p.append("vault implementation is not the factory's first contract") }
    if createAddress(vaultFactory, nonce: 2) != lc(floatImpl) { p.append("float implementation is not the factory's second contract") }
    if KipurseSuite.v55.adapter != adapter || KipurseSuite.v55.trust != trust || KipurseSuite.v55.factory != vaultFactory || KipurseSuite.v55.vaultImpl != vaultImpl { p.append("suite table") }
    return p }
  static func clone(_ impl: String, wallet: String) -> String? {
    guard let f = a20(vaultFactory), let w = a20(wallet), let h = OpsCap.cloneInitHash(impl: impl) else { return nil }
    return BatchVerify.create2(f, [UInt8](repeating: 0, count: 12) + w, h) }
  /// adapterV55.vaultAddress(wallet) / floatAddress(wallet): EIP-1167 clones, CREATE2(factory, salt = wallet).
  public static func vault(wallet: String) -> String? { clone(vaultImpl, wallet: wallet) }
  public static func float(wallet: String) -> String? { clone(floatImpl, wallet: wallet) }
  /// The owner's key seat V2 and his V5.5 wallet [Base Account, seat V2, SPM] (nonce 0), from his Base Account alone.
  public static func seat(owner: String) -> String? { KeySeat.address(owner: owner, trust: trust) }
  public static func wallet(owner: String) -> String? { KeySeat.predictWallet(owner: owner, trust: trust) }

  /// Phone-side check of addresses the server reports for V5.5 (any of these keys, at the top level or under contracts / addresses / reused):
  /// each must equal the phone's own constant. Unknown keys are ignored; nothing is ever taken from the server.
  public static func addressProblems(_ j: [String: Any]) -> [String] {
    let want: [String: String] = ["adapter": adapter, "adapterV55": adapter, "trust": trust, "trustV55": trust, "factory": vaultFactory, "vaultFactory": vaultFactory,
      "vaultFactoryV55": vaultFactory, "vaultImpl": vaultImpl, "vaultImplV55": vaultImpl, "floatImpl": floatImpl, "floatImplV55": floatImpl, "registryV2": registryV2,
      "spm": spendPermissionManager, "spendPermissionManager": spendPermissionManager, "usdc": usdc, "cbswFactory": cbswFactory, "coinbaseSmartWalletFactory": cbswFactory,
      "deployer": deployer, "deterministicDeployer": deployer, "feeController": feeController, "entryPoint": entryPoint, "entryPointV07": entryPoint]
    var p = [String]()
    func scan(_ o: [String: Any]) { for (k, v) in o { if let s = v as? String, let w = want[k], lc(s) != lc(w) { p.append("\(k) differs from the phone's V5.5 address") } } }
    scan(j); for k in ["contracts", "addresses", "reused", "suite"] { if let o = j[k] as? [String: Any] { scan(o) } }
    if let c = j["chainId"], "\(c)" != String(chainId) { p.append("not Base") }
    return p.sorted() }
  /// The server's wallet / seat / vault / float for this owner must be the ones the phone computes.
  public static func walletProblems(owner: String, wallet: String?, seat s: String? = nil, vault v: String? = nil, float f: String? = nil) -> [String] {
    var p = [String]()
    guard let w0 = self.wallet(owner: owner), let s0 = seat(owner: owner) else { return ["bad owner"] }
    if let w = wallet, lc(w) != w0 { p.append("wallet isn't the V5.5 wallet your Base Account gets") }
    if let s = s, lc(s) != s0 { p.append("key seat isn't your V5.5 Face ID key seat") }
    let w = wallet ?? w0
    if let v = v, lc(v) != vault(wallet: w) { p.append("vault isn't this wallet's V5.5 vault") }
    if let f = f, lc(f) != float(wallet: w) { p.append("float vault isn't this wallet's V5.5 float vault") }
    return p }

  // MARK: owner digests (domain "Kipurse Owner" / "5" / 8453 / V5.5 adapter)
  public enum Kind: UInt8, CaseIterable { case trust = 1, untrust = 2, denySigner = 3, pay = 4, signerTrust = 5, inlineTrust = 6
    public var primaryType: String { ["", "OwnerTrust", "OwnerUntrust", "OwnerDenySigner", "OwnerApproval", "OwnerSignerTrust", "OwnerInlineTrust"][Int(rawValue)] }
    public var typeString: String {
      let trustFields = "(address account,bytes32 merchant,string name,uint64 epoch,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
      switch self {
      case .trust: return "OwnerTrust" + trustFields
      case .inlineTrust: return "OwnerInlineTrust" + trustFields
      case .untrust: return "OwnerUntrust(address account,bytes32 merchant,bytes32 nonce,uint256 deadline)"
      case .denySigner: return "OwnerDenySigner(address account,address signer,bytes32 nonce,uint256 deadline)"
      case .pay: return "OwnerApproval(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline)"
      case .signerTrust: return "OwnerSignerTrust(address account,bytes32 merchant,string name,uint64 epoch,address[] signers,uint160 single,uint160 daily,uint64 expiry,bytes32 nonce,uint256 deadline)"
      } }
    public var typeHash: [UInt8] { Keccak.hash(typeString) }
  }
  /// TrustParams (bytes32 merchant, string name, address[] payees, address[] signers, uint160 single, uint160 daily, uint64 expiry); numbers are decimal strings.
  public struct TrustParams: Equatable { public var merchant, name: String; public var payees, signers: [String]; public var single, daily, expiry: String
    public init(merchant: String, name: String, payees: [String], signers: [String], single: String, daily: String, expiry: String) {
      self.merchant = merchant; self.name = name; self.payees = payees; self.signers = signers; self.single = single; self.daily = daily; self.expiry = expiry } }
  /// SignerTrust (bytes32 merchant, string name, address[] signers, uint160 single, uint160 daily, uint64 expiry).
  public struct SignerTrustParams: Equatable { public var merchant, name: String; public var signers: [String]; public var single, daily, expiry: String
    public init(merchant: String, name: String, signers: [String], single: String, daily: String, expiry: String) {
      self.merchant = merchant; self.name = name; self.signers = signers; self.single = single; self.daily = daily; self.expiry = expiry } }
  /// One seat request: what the owner approves, exactly as the seat body carries it.
  public enum Request: Equatable {
    case trust(TrustParams, nonce: String, deadline: String)              // kind 1: trustBySig (stored)
    case untrust(merchant: String, nonce: String, deadline: String)       // kind 2
    case denySigner(signer: String, nonce: String, deadline: String)      // kind 3
    case pay(purchaseKey: String, payee: String, amount: String, deadline: String)   // kind 4: OwnerApproval
    case signerTrust(SignerTrustParams, nonce: String, deadline: String)  // kind 5
    case inlineTrust(TrustParams, nonce: String, deadline: String)        // kind 6: KPTR "approve & remember" (KR-01)
    public var kind: Kind { switch self { case .trust: return .trust; case .untrust: return .untrust; case .denySigner: return .denySigner; case .pay: return .pay
      case .signerTrust: return .signerTrust; case .inlineTrust: return .inlineTrust } }
  }
  static func u(_ d: String) -> [UInt8]? { PhoneTrust.u256(d) }
  static func addrs(_ a: [String]) -> [[UInt8]]? { var o = [[UInt8]](); for x in a { guard let w = PhoneTrust.addr(x) else { return nil }; o.append(w) }; return o }
  static func tpABI(_ t: TrustParams) -> ABIValue? {
    guard let m = PhoneTrust.b32(t.merchant), let p = addrs(t.payees), let s = addrs(t.signers), let a = u(t.single), let b = u(t.daily), let e = u(t.expiry) else { return nil }
    return .tuple([.word(m), .bytes(Array(t.name.utf8)), .array(p.map { .word($0) }), .array(s.map { .word($0) }), .word(a), .word(b), .word(e)]) }
  static func stABI(_ g: SignerTrustParams) -> ABIValue? {
    guard let m = PhoneTrust.b32(g.merchant), let s = addrs(g.signers), let a = u(g.single), let b = u(g.daily), let e = u(g.expiry) else { return nil }
    return .tuple([.word(m), .bytes(Array(g.name.utf8)), .array(s.map { .word($0) }), .word(a), .word(b), .word(e)]) }
  /// The seat body for this request (abi.encode of the kind's fields, as KipurseKeySeatV2.structHashOf decodes it).
  public static func body(_ r: Request) -> [UInt8]? {
    switch r {
    case .trust(let t, let n, let d), .inlineTrust(let t, let n, let d):
      guard let tp = tpABI(t), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return ABIValue.encode([tp, .word(nb), .word(db)])
    case .untrust(let m, let n, let d):
      guard let mb = PhoneTrust.b32(m), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return ABIValue.encode([.word(mb), .word(nb), .word(db)])
    case .denySigner(let s, let n, let d):
      guard let sb = PhoneTrust.addr(s), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return ABIValue.encode([.word(sb), .word(nb), .word(db)])
    case .pay(let k, let p, let a, let d):
      guard let kb = PhoneTrust.b32(k), let pb = PhoneTrust.addr(p), let ab = u(a), let db = u(d) else { return nil }; return ABIValue.encode([.word(kb), .word(pb), .word(ab), .word(db)])
    case .signerTrust(let g, let n, let d):
      guard let st = stABI(g), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return ABIValue.encode([st, .word(nb), .word(db)])
    } }
  /// EIP-712 struct hash. `epoch` = trust.trustOf(wallet, merchant).epoch (kinds 1, 5, 6; ignored otherwise).
  public static func structHash(_ r: Request, account: String, epoch: String = "0") -> [UInt8]? {
    guard let acc = PhoneTrust.addr(account), let ep = u(epoch) else { return nil }
    let th = r.kind.typeHash
    switch r {
    case .trust(let t, let n, let d), .inlineTrust(let t, let n, let d):
      guard let m = PhoneTrust.b32(t.merchant), let p = addrs(t.payees), let s = addrs(t.signers), let a = u(t.single), let b = u(t.daily), let e = u(t.expiry),
            let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }
      return Keccak.hash(th + acc + m + Keccak.hash(Array(t.name.utf8)) + ep + Keccak.hash(p.flatMap { $0 }) + Keccak.hash(s.flatMap { $0 }) + a + b + e + nb + db)
    case .untrust(let m, let n, let d):
      guard let mb = PhoneTrust.b32(m), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return Keccak.hash(th + acc + mb + nb + db)
    case .denySigner(let s, let n, let d):
      guard let sb = PhoneTrust.addr(s), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }; return Keccak.hash(th + acc + sb + nb + db)
    case .pay(let k, let p, let a, let d):
      guard let kb = PhoneTrust.b32(k), let pb = PhoneTrust.addr(p), let ab = u(a), let db = u(d) else { return nil }; return Keccak.hash(th + acc + kb + pb + ab + db)
    case .signerTrust(let g, let n, let d):
      guard let m = PhoneTrust.b32(g.merchant), let s = addrs(g.signers), let a = u(g.single), let b = u(g.daily), let e = u(g.expiry), let nb = PhoneTrust.b32(n), let db = u(d) else { return nil }
      return Keccak.hash(th + acc + m + Keccak.hash(Array(g.name.utf8)) + ep + Keccak.hash(s.flatMap { $0 }) + a + b + e + nb + db)
    } }
  public static func domainSeparator(adapter: String = adapter) -> [UInt8]? { PhoneTrust.domain("Kipurse Owner", "5", adapter) }
  /// trust.ownerDigest(structHash) = seat.ownerDigest(structHash): EIP-712 under ("Kipurse Owner", "5", 8453, V5.5 adapter).
  public static func ownerDigest(_ r: Request, account: String, epoch: String = "0", adapter: String = adapter) -> [UInt8]? {
    guard let sh = structHash(r, account: account, epoch: epoch), let ds = domainSeparator(adapter: adapter) else { return nil }
    return Keccak.hash([0x19, 0x01] + ds + sh) }
  /// What Face ID signs: wallet.replaySafeHash(ownerDigest) (Coinbase Smart Wallet domain, verifyingContract = the wallet).
  public static func phoneDigest(_ r: Request, wallet: String, epoch: String = "0", adapter: String = adapter) -> [UInt8]? {
    guard let d = ownerDigest(r, account: wallet, epoch: epoch, adapter: adapter) else { return nil }; return PhoneTrust.walletHash(d, wallet: wallet) }

  // MARK: signatures (KL-5 low-s, owner index 1)
  /// Canonical low-s: 0 < s < n, and s > n/2 becomes n - s (the seat rejects s > n/2). nil = not a valid s.
  public static func lowS(_ s: [UInt8]) -> [UInt8]? {
    guard s.count == 32, s.contains(where: { $0 != 0 }), s.lexicographicallyPrecedes(PhoneTrust.p256n) else { return nil }
    return PhoneTrust.lowS(s) }
  public static func isLowS(_ s: [UInt8]) -> Bool { lowS(s) == s }
  /// abi.encode(uint8 kind, bytes body, uint256 r, uint256 s), s normalised to low-s; r must be 0 < r < n.
  public static func seatSignatureData(kind: Kind, body: [UInt8], r: [UInt8], s: [UInt8]) -> [UInt8]? {
    guard r.count == 32, r.contains(where: { $0 != 0 }), r.lexicographicallyPrecedes(PhoneTrust.p256n), let ls = lowS(s) else { return nil }
    return ABIValue.encode([.word([kind.rawValue]), .bytes(body), .word(r), .word(ls)]) }
  /// Coinbase SignatureWrapper(ownerIndex = 1 (the seat), signatureData): what isValidSignature / trustBySig / payDirect take.
  public static func wrapper(kind: Kind, body: [UInt8], r: [UInt8], s: [UInt8], ownerIndex: UInt64 = seatOwnerIndex) -> [UInt8]? {
    guard let sd = seatSignatureData(kind: kind, body: body, r: r, s: s) else { return nil }
    return ABIValue.encode([.tuple([.word(BatchVerify.w(ownerIndex)), .bytes(sd)])]) }
  /// KPTR inline payee trust (V5.5): 0x4b505452 ‖ abi.encode(TrustParams, nonce, deadline, bytes wrapper(kind 6)). KR-05 is checked first.
  public static func inlineTrustBlob(_ t: TrustParams, nonce: String, deadline: String, wrapper: [UInt8], now: Date = Date()) -> [UInt8]? {
    guard trustProblems(t, inline: true, deadline: deadline, now: now).isEmpty, let tp = tpABI(t), let nb = PhoneTrust.b32(nonce), let db = u(deadline) else { return nil }
    return inlineTrustTag + ABIValue.encode([tp, .word(nb), .word(db), .bytes(wrapper)]) }
  /// kind-5 owner signer grant for paySignedTrusted: abi.encode(SignerTrust, nonce, deadline, bytes wrapper(kind 5)) (same layout as V5.4).
  public static func grantBytes(_ g: SignerTrustParams, nonce: String, deadline: String, wrapper: [UInt8]) -> [UInt8]? {
    guard let st = stABI(g), let nb = PhoneTrust.b32(nonce), let db = u(deadline) else { return nil }
    return ABIValue.encode([st, .word(nb), .word(db), .bytes(wrapper)]) }

  // MARK: KR-05 (what KipurseTrustV55 refuses; checked on the phone before Face ID)
  /// Inline (kind 6): merchant == keccak(name), name non-empty, signers empty, 1..16 non-zero payees, 0 < single <= daily,
  /// expiry == 2^64-1 or now < expiry <= now + 365 days, now < deadline. Stored (kind 1): the same name / caps / payee rules, signers allowed,
  /// a finite expiry within 365 days.
  public static func trustProblems(_ t: TrustParams, inline: Bool, deadline: String, now: Date = Date()) -> [String] {
    var p = [String](); let t0 = UInt64(max(0, now.timeIntervalSince1970))
    if t.name.isEmpty || lc(Hex.encode(Keccak.hash(Array(t.name.utf8)))) != lc(t.merchant) { p.append(T("商家编号和名字对不上", "merchant id does not match the name")) }
    if inline && !t.signers.isEmpty { p.append(T("记住收款方时不能加商家下单身份", "a remembered payee trust cannot name order signers")) }
    let zero = "0x" + String(repeating: "0", count: 40)
    if t.payees.isEmpty || t.payees.count > 16 || t.payees.contains(where: { lc($0) == zero || PhoneTrust.addr($0) == nil }) { p.append(T("收款地址不对", "bad payee list")) }
    if let s = u(t.single), let d = u(t.daily), s.contains(where: { $0 != 0 }), !d.lexicographicallyPrecedes(s) {} else { p.append(T("每笔上限必须大于 0 且不超过每天上限", "per-payment cap must be above 0 and not above the daily cap")) }
    if inline && t.expiry == noExpiry {}
    else if let e = UInt64(t.expiry), e > t0, e <= t0 + maxTrust + UInt64(ClockSkew.upperTolerance) {} else { p.append(T("信任的到期时间必须在一年（365 天）以内", "trust must end within 365 days")) }
    if let d = u(deadline), let n = u(String(t0)), n.lexicographicallyPrecedes(d) {} else { p.append(T("请求已过期", "request expired")) }
    return p }   // t1266: the expiry upper bound has clock-skew tolerance (ClockSkew), lower bounds are unchanged
  public static func trustParams(_ m: OwnerTrustMessage) -> TrustParams {
    TrustParams(merchant: m.merchant, name: m.name, payees: m.payees, signers: m.signers, single: m.single, daily: m.daily, expiry: m.expiry) }

  // MARK: the owner's move V5.4 -> new V5.5 wallet (gw sign-v55.mjs mode=move; his Base Account confirms ONE batch)
  /// Phone-side check of a /v55/plan?mode=move reply before anything opens: it is for MY Base Account and MY current wallet, the new wallet / seat /
  /// vault are the ones this phone computes, the seat gets THIS phone's key, every call is one the phone recognises, the new spend permission is
  /// for the new wallet on the V5.5 adapter with the old limits, and USDC leaves the old wallet only to the new wallet (and the small fee).
  /// t1266: `oldTrusts` = the trusts the phone itself read from the OLD wallet (chain); a re-applied setTrust must be exactly one of them
  /// (nil = none read -> any setTrust is refused). `oldFloatCap` = the old wallet's float cap read on chain; setFloatCap may not exceed it
  /// (nil -> refused). setRecovery may only be the zero address or the owner's own Base Account.
  public static func movePlanProblems(_ plan: [String: Any], owner: String, oldWallet: String, x: [UInt8], y: [UInt8], oldTrusts: [TrustParams]? = nil, oldFloatCap: UInt64? = nil) -> [String] {
    var p = [String](); func bad(_ s: String) { p.append(s) }
    let ex = plan["extra"] as? [String: Any] ?? [:]
    func s(_ o: [String: Any], _ k: String) -> String { (o[k] as? String) ?? (o[k] as? NSNumber)?.stringValue ?? "" }
    if lc(s(plan, "owner")) != lc(owner) { bad("not your Base Account") }
    if lc(s(ex, "oldWallet")) != lc(oldWallet) { bad("not your current wallet") }
    guard let nw = wallet(owner: owner), let seat = seat(owner: owner), let vlt = vault(wallet: nw) else { return p + ["bad owner"] }
    p += walletProblems(owner: owner, wallet: s(ex, "newWallet"), seat: s(ex, "seat"), vault: s(ex, "vault"))
    if lc(nw) == lc(oldWallet) { bad("new wallet is the old wallet") }
    if !s(ex, "x").isEmpty, PhoneTrust.u256(s(ex, "x")) != BatchVerify.word(x) || PhoneTrust.u256(s(ex, "y")) != BatchVerify.word(y) { bad("not this phone's key") }
    guard let fee = UInt64(s(plan, "fee")), fee <= moveFeeCap else { return p + ["fee above 0.15 USDC"] }
    guard let calls = plan["calls"] as? [[String: Any]], !calls.isEmpty, calls.count <= 40 else { return p + ["calls"] }
    let old = lc(oldWallet), usdcL = lc(usdc), spm = lc(spendPermissionManager)
    let selTransfer = "a9059cbb", selSetKey = String(KeySeat.selSetKey.dropFirst(2)), selReconcile = sel("reconcileFloat(address)"), selCancel = sel("cancelReservation(bytes32)"),
        selWithdraw = sel("withdraw(address,address,uint256)"), selSetPaused = sel("setPaused(bool)"), selOps = OpsCap.selSetOpsPerDay
    let selSetTrust = sel("setTrust((bytes32,string,address[],address[],uint160,uint160,uint64))"), selSetFloatCap = sel("setFloatCap(uint160)"), selSetRecovery = sel("setRecovery(address)")
    let trustSels = Set(["setDeniedPayee(address,bool)", "setDeniedSigner(address,bool)", "setRegistryOptOut(bool)", "setPaused(bool)"].map(sel))
    var created = 0, deployed = 0, keySet = 0, revoked = 0, moved = 0, fees = 0, seeded = 0
    var approved: RequestVerify.Permission?, registered: RequestVerify.Permission?, oldPerm: RequestVerify.Permission?
    for (i, c) in calls.enumerated() {
      guard let (to, d) = BatchVerify.callParts(c) else { bad("step \(i + 1) is malformed or sends ETH"); continue }
      let h = lc(Hex.encode(d))
      if to == lc(cbswFactory) { if h == KeySeat.createAccountData(owner: owner, trust: trust) && created == 0 { created += 1 } else { bad("unexpected wallet creation") }; continue }
      if to == lc(deployer) { if h == KeySeat.deployData(owner: owner, trust: trust) && deployed == 0 { deployed += 1 } else { bad("unexpected deployment") }; continue }
      guard to == lc(nw) || to == old, let (tg, inner) = executeParts(d) else { bad("step \(i + 1) calls an unknown contract \(to)"); continue }
      let isel = inner.count >= 4 ? String(Hex.encode(Array(inner.prefix(4))).dropFirst(2)) : ""; let r = RequestVerify.R(b: Array(inner.dropFirst(4)))
      if to == lc(nw) {
        if tg == seat && isel == selSetKey { if lc(Hex.encode(inner)) == KeySeat.setKeyData(x: x, y: y) { keySet += 1 } else { bad("Face ID key seat call is not 'use this phone'") } }
        else if tg == spm && isel == RequestVerify.selApprove, let o = r.int(0), let pm = RequestVerify.permission(r, at: o) { if approved != nil { bad("approves twice") }; approved = pm }
        else if tg == lc(adapter) && isel == RequestVerify.selRegister, let o = r.int(0), let pm = RequestVerify.permission(r, at: o) { registered = pm }
        else if tg == usdcL && isel == selTransfer, inner.count == 68, r.addr(0) == vlt, let a = r.u64(32), a <= vaultSeedMax { seeded += 1 }
        else if tg == lc(trust) && isel == selSetTrust {
          let allowed = (oldTrusts ?? []).compactMap { t in tpABI(t).map { lc(Hex.encode(Array(inner.prefix(4)) + ABIValue.encode([$0]))) } }
          if !allowed.contains(lc(Hex.encode(inner))) { bad("re-applied trust is not one read from your old wallet") } }
        else if tg == lc(trust) && isel == selSetFloatCap {
          if inner.count != 36 { bad("bad float cap") } else if let cap = r.u64(0), let oc = oldFloatCap, cap <= oc {} else { bad("float cap above your old wallet's") } }
        else if tg == lc(trust) && isel == selSetRecovery {
          if inner.count != 36 { bad("bad recovery address") } else if let a = r.addr(0), a == "0x" + String(repeating: "0", count: 40) || a == lc(owner) {} else { bad("recovery address is not your own account") } }
        else if tg == lc(trust) && trustSels.contains(isel) { if isel == selSetPaused && r.int(0) != 1 { bad("unpauses on the new wallet") } }
        else if tg == vlt && isel == selOps && inner.count == 36 {}
        else { bad("new wallet step \(i + 1) does something the phone does not recognise") }
      } else {
        if tg == lc(v54.adapter) && ((isel == selReconcile && r.addr(0) == old && inner.count == 36) || (isel == selCancel && inner.count == 36)) {}
        else if isel == selWithdraw && inner.count == 100 && r.addr(0) == usdcL && r.addr(32) == old && tg == v54.vault(wallet: oldWallet)?.lowercased() {}
        else if tg == usdcL && isel == selTransfer && inner.count == 68, let a = r.u64(32) {
          if r.addr(0) == lc(feeTo) { fees += 1; if a != fee { bad("fee differs from the plan") } } else if r.addr(0) == nw { moved += 1 } else { bad("USDC from the old wallet goes to someone else") } }
        else if tg == spm && isel == RequestVerify.selRevoke, let o = r.int(0), let pm = RequestVerify.permission(r, at: o), lc(pm.account) == old { revoked += 1; oldPerm = pm }
        else if tg == lc(v54.trust) && isel == selSetPaused && inner.count == 36 && r.int(0) == 1 {}
        else { bad("old wallet step \(i + 1) does something the phone does not recognise") }
      }
    }
    if created != 1 { bad("new wallet is not created in this confirmation") }
    if keySet != 1 { bad("this phone must be set exactly once") }
    if revoked != 1 { bad("the old permission must be revoked exactly once") }
    if moved != 1 || fees > 1 || seeded > 1 { bad("unexpected USDC transfers") }
    if let a = approved {
      if lc(a.account) != nw || lc(a.spender) != lc(adapter) || lc(a.token) != usdcL { bad("new permission is not for the new wallet on the V5.5 adapter") }
      if registered != a { bad("registered permission differs from the approved one") }
      if let o = oldPerm, o.policy.count < 9 || a.policy.count < 9 || o.allowance != a.allowance || o.period != a.period || o.start != a.start || o.end != a.end || Array(o.policy[2...4]) != Array(a.policy[2...4]) || Array(o.policy[5...8]) != Array(a.policy[5...8]) { bad("new limits differ from your current limits") }
      // t1280 (Q2): pauser, registry and both fee ceilings carry over from the old permission too, and must meet the absolute ceilings
      // registry: the server's own move formula (gw wallet-v55.mjs permissionV55): a registry-using permission (verifiedSingle > 0, registry set)
      // moves to the V5.5 registry V2, any other keeps its registry
      if let o = oldPerm, o.policy.count == 12, a.policy.count == 12 {
        let usesRegistry = o.policy[7] != "0" && lc(o.policy[9]) != RequestVerify.zeroAddress
        if [1, 10, 11].contains(where: { lc(o.policy[$0]) != lc(a.policy[$0]) }) || lc(a.policy[9]) != (usesRegistry ? lc(registryV2) : lc(o.policy[9])) { bad("new pauser / registry / fee ceilings differ from your current permission") } }
      p += RequestVerify.policyCeilingProblems(a.policy)
    } else { bad("no new spend permission") }
    return p }
  static func sel(_ sig: String) -> String { String(BatchVerify.sel(sig).dropFirst(2)) }
  /// t1266: the TrustParams inside a trust.setTrust(tuple) call (selector + abi.encode(tuple)); nil when not canonical.
  public static func decodeSetTrust(_ inner: [UInt8]) -> TrustParams? {
    guard inner.count >= 4 + 32 * 8, String(Hex.encode(Array(inner.prefix(4))).dropFirst(2)) == sel("setTrust((bytes32,string,address[],address[],uint160,uint160,uint64))") else { return nil }
    let r = RequestVerify.R(b: Array(inner.dropFirst(4)))
    guard let b = r.int(0), let m = r.word(b), let no = r.int(b + 32), let po = r.int(b + 64), let so = r.int(b + 96),
          let sg = r.dec(b + 128), let dl = r.dec(b + 160), let ex = r.dec(b + 192), let nb = r.bytes(b + no), let name = String(bytes: nb, encoding: .utf8) else { return nil }
    func addrs(_ o: Int) -> [String]? { guard let n = r.int(o), n <= 64 else { return nil }; var out = [String](); for i in 0..<n { guard let a = r.addr(o + 32 + 32 * i) else { return nil }; out.append(a) }; return out }
    guard let ps = addrs(b + po), let ss = addrs(b + so) else { return nil }
    let t = TrustParams(merchant: Hex.encode(m).lowercased(), name: name, payees: ps, signers: ss, single: sg, daily: dl, expiry: ex)
    guard let tp = tpABI(t), Array(inner.prefix(4)) + ABIValue.encode([tp]) == inner else { return nil }   // canonical only
    return t }
  /// wallet.execute(target, 0, inner) (canonical encoding) -> (target, inner).
  static func executeParts(_ d: [UInt8]) -> (String, [UInt8])? {
    guard BatchVerify.selector(d) == BatchVerify.selExecute, d.count >= 4 + 128 else { return nil }
    let r = RequestVerify.R(b: Array(d.dropFirst(4)))
    guard let t = r.addr(0), r.dec(32) == "0", r.int(64) == 96, let len = r.int(96), len >= 4, d.count == 4 + 128 + (len + 31) / 32 * 32,
          d[(4 + 128 + len)...].allSatisfy({ $0 == 0 }) else { return nil }
    return (t, Array(d[(4 + 128)..<(4 + 128 + len)])) }
}

/// Minimal Solidity ABI encoder (abi.encode) for the seat bodies and wrappers: static words, bytes / string, dynamic arrays and tuples.
indirect enum ABIValue {
  case word([UInt8]), bytes([UInt8]), array([ABIValue]), tuple([ABIValue])
  var dynamic: Bool { switch self { case .word: return false; case .bytes, .array: return true; case .tuple(let a): return a.contains { $0.dynamic } } }
  var headSize: Int { if dynamic { return 32 }; if case .tuple(let a) = self { return a.reduce(0) { $0 + $1.headSize } }; return 32 }
  var encoded: [UInt8] {
    switch self {
    case .word(let b): return BatchVerify.word(b)
    case .bytes(let b): return BatchVerify.w(UInt64(b.count)) + b + [UInt8](repeating: 0, count: (32 - b.count % 32) % 32)
    case .array(let a): return BatchVerify.w(UInt64(a.count)) + ABIValue.encode(a)
    case .tuple(let a): return ABIValue.encode(a)
    } }
  /// abi.encode(items...) (= the encoding of a tuple of them).
  static func encode(_ items: [ABIValue]) -> [UInt8] {
    let headLen = items.reduce(0) { $0 + $1.headSize }; var head = [UInt8](), tail = [UInt8]()
    for it in items { if it.dynamic { head += BatchVerify.w(UInt64(headLen + tail.count)); tail += it.encoded } else { head += it.encoded } }
    return head + tail }
}
