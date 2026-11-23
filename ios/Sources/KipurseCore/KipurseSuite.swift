import Foundation

/// t1197u (handbook §6#92): two Kipurse contract suites live side by side on Base.
/// NEW wallets open on V5.3 (daily operations cap, vault fee reserve); the operator's original wallet and every wallet
/// opened before stay on V5.2, untouched. The phone picks the suite per wallet:
///  - a new opening: the suite whose vault (computed ON THE PHONE, CREATE2) equals the server's vault, then cross-checked on chain;
///  - an existing wallet: the suite remembered at opening; otherwise V5.3 only when the server's vault IS this wallet's V5.3 vault
///    AND that vault already has code on chain; everything else stays V5.2 (the safe default for the original and older wallets).
/// Public chain constants only.
public struct KipurseSuite: Equatable, Sendable {
  public let name: String, adapter: String, trust: String, factory: String, vaultImpl: String
  public static let v52 = KipurseSuite(name: "v5.2", adapter: "0x05320BeD08309F66316F7d73e2D0be110400FbB2", trust: "0x65d2ce04da7ace81e7c4ab08712509282745ec84",
                                       factory: "0x6ce7bc537379a6e10b88d1e98a5c3803a9812be9", vaultImpl: "0xc53ab278fe26b31f85b5ccc73eb5a7dd81e05038")
  public static let v53 = KipurseSuite(name: "v5.3", adapter: "0xb150030be35903AdEE466d7733Bf0841B667033C", trust: "0xda1dcc6677f352ba551feb8ca0f39d46b41535c3",
                                       factory: OpsCap.v53Factory, vaultImpl: OpsCap.v53VaultImpl)
  /// t1214 (§6#102): V5.4 = V5.3 + "trust a merchant's order signer" (kind-5 grant). Only the owner's migrated wallet uses it, after his own
  /// Base Account switched it; never matched for a new opening (not in `all`). Adapter / trust / vault implementation are public chain constants.
  public static let v54 = KipurseSuite(name: "v5.4", adapter: "0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa", trust: "0x22eF1633252653932076cB911b155F9D7f73A9E9",
                                       factory: OpsCap.v53Factory, vaultImpl: "0x99D11aFAc77B4E8Ea8AF00C543eee36a74591bBc")
  /// t1250 (handbook §6#119): V5.5 = the internal-review fixes (KR-01…KR-08, KL-5) in NEW contracts, deployed by CREATE2 through the public
  /// deterministic deployer (gw/mainnet/v55-deploy-plan.json). Wallets on V5.5 are NEW wallets with owners [Base Account, KipurseKeySeatV2, SPM]
  /// (the owner's move from V5.4, or a new opening while the server's KIPURSE_V55 flag is on). Matched first for a new opening, but only when the
  /// server's vault IS this wallet's V5.5 vault computed here; an existing wallet switches to V5.5 only when that vault also has code on chain.
  public static let v55 = KipurseSuite(name: "v5.5", adapter: KipurseV55.adapter, trust: KipurseV55.trust, factory: KipurseV55.vaultFactory, vaultImpl: KipurseV55.vaultImpl)
  /// Newest first: a new opening is matched against V5.5, then V5.3, then V5.2.
  public static let all: [KipurseSuite] = [v55, v53, v52]
  public static func named(_ n: String?) -> KipurseSuite? { (all + [v54]).first { $0.name == n } }
  /// t1214 / t1250: the merchant-signer grant (kind 5) exists on V5.4 and, with the same model, on V5.5 (domain = that suite's adapter).
  public var signerGrants: Bool { self == .v54 || self == .v55 }
  /// t1250: V5.5 wallets carry the Face ID key seat V2 (owner index 1): kind 6 inline trust, low-s only, digests built inside the seat.
  public var seatV2: Bool { self == .v55 }

  static let key = "kp.suite."
  static let lock = NSLock()
  static var scoped: KipurseSuite?
  /// Tests only: pin the active suite (nil = normal per-wallet choice).
  public static func pin(_ s: KipurseSuite?) { lock.lock(); scoped = s; lock.unlock() }

  /// The suite of the wallet on this phone (Operator.wallet). Unknown -> V5.2.
  public static var active: KipurseSuite { lock.lock(); let s = scoped; lock.unlock(); return s ?? stored(wallet: Operator.wallet) ?? .v52 }
  public static func stored(wallet: String) -> KipurseSuite? { wallet.isEmpty ? nil : named(UserDefaults.standard.string(forKey: key + wallet.lowercased())) }
  public static func remember(_ s: KipurseSuite, wallet: String) { guard Hex.decode(wallet)?.count == 20 else { return }; UserDefaults.standard.set(s.name, forKey: key + wallet.lowercased()) }

  /// This wallet's payer vault in this suite, computed on the phone: CREATE2(factory, salt = wallet, EIP-1167 clone of the implementation).
  public func vault(wallet: String) -> String? {
    guard let f = Hex.decode(factory), f.count == 20, let w = Hex.decode(wallet), w.count == 20, let h = OpsCap.cloneInitHash(impl: vaultImpl) else { return nil }
    return Hex.encode(Array(Keccak.hash([0xff] + f + ([UInt8](repeating: 0, count: 12) + w) + h).suffix(20))).lowercased() }
  /// The suite whose computed vault for this wallet is `vault` (nil = none of ours).
  public static func forVault(_ vault: String?, wallet: String) -> KipurseSuite? {
    guard let v = vault?.lowercased() else { return nil }; return all.first { $0.vault(wallet: wallet) == v } }

  /// Existing wallet without a remembered suite: switch to V5.3 only when the server's vault is this wallet's V5.3 vault and it has
  /// code on chain (read by the phone itself). Never switches a wallet that is already remembered.
  /// t1275: a vault's code counts only when two public nodes agree (same helper as WalletVerify / MoveFollow).
  static let agreedCode: (String) async -> String? = { a in await ChainRPC.agreed("eth_getCode", [a, "latest"]) }
  @discardableResult public static func detect(wallet: String?, serverVault: String?, code: ((String) async -> String?)? = nil) async -> KipurseSuite {
    guard let w = wallet, Hex.decode(w)?.count == 20 else { return active }
    // t1214 (§6#102): the owner's own V5.2 -> V5.4 switch (and its rollback), both signed by his Base Account. Only these two moves, and only
    // when the server's vault is exactly this wallet's vault of the target suite (computed here); V5.4 also needs that vault's code on chain.
    let sv = serverVault?.lowercased()
    // t1250 (§6#119): the owner's new V5.5 wallet (or a wallet opened on V5.5): the server's vault is exactly this wallet's V5.5 vault (computed here)
    // and that vault has code on chain. Never moves a wallet already remembered on another suite (a V5.5 wallet is always a NEW address).
    if stored(wallet: w) == nil, let v = sv, v == v55.vault(wallet: w) {
      let c = await (code ?? agreedCode)(v)
      if let c, c.count > 2 { remember(.v55, wallet: w); return .v55 } }
    let cur = stored(wallet: w) ?? (forVault(sv, wallet: w) == .v53 ? nil : .v52)
    if cur == .v52 || cur == nil, let v = sv, v == v54.vault(wallet: w) {
      let c = await (code ?? agreedCode)(v)
      if let c, c.count > 2 { remember(.v54, wallet: w); return .v54 } }
    if cur == .v54, let v = sv, v == v52.vault(wallet: w) { remember(.v52, wallet: w); return .v52 }
    if let s = stored(wallet: w) { return s }
    guard let v = serverVault?.lowercased(), forVault(v, wallet: w) == .v53 else { return .v52 }
    let c = await (code ?? agreedCode)(v)
    guard let c, c.count > 2 else { return .v52 }
    remember(.v53, wallet: w); return .v53 }
}
