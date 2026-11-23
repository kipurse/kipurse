import Foundation

/// t1266: small pure rules the app uses before it trusts anything the server says. Every one only adds refusals.

/// Upper time bounds that equal a server choice (deadline = now + 1 h, expiry = now + 1 year ...) get this much clock-skew
/// tolerance on the phone, so a phone clock a few minutes behind the server never refuses an honest request.
/// Only ever added to an UPPER bound; lower bounds ("not expired") are never relaxed.
public enum ClockSkew {
  public static let upperTolerance: TimeInterval = 300
}

/// t1266 (fix 4): the wallet address the server reports is used ONLY after the chain itself (two public nodes agreeing on every
/// read) confirms it: the wallet has code, the owner's Coinbase / Base Account is one of its owners, and either
///  - this phone's P-256 key sits in an approver / key seat that is an owner of THIS wallet (contract x() / y() / wallet()), or
///  - the owner is the one this phone signed in as AND the wallet is the address the factory gives that owner (computed on the phone).
/// An owner that differs from the one this phone signed in as is refused outright.
public enum WalletVerify {
  static let selX = "0x0c55699c", selY = "0xa56dfe4a", selWallet = "0x521eb273", selIsOwnerAddress = "0xa2e1a8d8"
  /// Every wallet address the Coinbase factory gives this owner in a Kipurse layout (plain wallet, or key-seat wallets of each suite).
  public static func predicted(owner: String) -> Set<String> {
    var out = Set<String>()
    if let w = BatchVerify.predictWallet(owner: owner) { out.insert(w.lowercased()) }
    for t in [KipurseSuite.v52.trust, KipurseSuite.v53.trust, KipurseSuite.v54.trust, KipurseSuite.v55.trust] {
      if let w = KeySeat.predictWallet(owner: owner, trust: t) { out.insert(w.lowercased()) }
    }
    return out
  }
  /// Seats this owner can have (one per suite trust): candidates for "this phone's key is the wallet's approver".
  public static func seats(owner: String) -> [String] {
    [KipurseSuite.v52.trust, KipurseSuite.v53.trust, KipurseSuite.v54.trust, KipurseSuite.v55.trust].compactMap { KeySeat.address(owner: owner, trust: $0)?.lowercased() }
  }
  public static func confirmed(wallet: String, owner: String, knownOwner: String?, x: [UInt8]?, y: [UInt8]?, approverHints: [String] = [],
                               call: MoveFollow.Call, code: MoveFollow.Code) async -> Bool {
    let w = wallet.lowercased(), o = owner.lowercased()
    guard BatchVerify.addrBytes(w) != nil, BatchVerify.addrBytes(o) != nil, w != o else { return false }
    if let k = knownOwner, k.lowercased() != o { return false }
    guard let c = await code(w), c.count > 2, let po = MoveFollow.pad(o), MoveFollow.isTrue(await call(w, selIsOwnerAddress + po)) else { return false }
    if knownOwner != nil, predicted(owner: o).contains(w) { return true }
    guard let x, let y, x.count == 32, y.count == 32 else { return false }
    var seen = Set<String>()
    for a in (approverHints.map { $0.lowercased() } + seats(owner: o)) where BatchVerify.addrBytes(a) != nil && a != w && a != o && seen.insert(a).inserted {
      guard let pa = MoveFollow.pad(a), MoveFollow.isTrue(await call(w, selIsOwnerAddress + pa)) else { continue }
      guard let bw = MoveFollow.word(await call(a, selWallet)), Hex.encode(Array(bw[12...])).lowercased() == w else { continue }
      guard let sx = MoveFollow.word(await call(a, selX)), let sy = MoveFollow.word(await call(a, selY)), sx == x, sy == y else { continue }
      return true
    }
    return false
  }
  /// Production wiring: two public nodes must agree on every read.
  public static func confirmed(wallet: String, owner: String, knownOwner: String?, x: [UInt8]?, y: [UInt8]?, approverHints: [String] = []) async -> Bool {
    await confirmed(wallet: wallet, owner: owner, knownOwner: knownOwner, x: x, y: y, approverHints: approverHints,
                    call: { to, data in await ChainRPC.ethCall(to, data, agreed: true) },
                    code: { a in await ChainRPC.agreed("eth_getCode", [a, "latest"]) })
  }
}

public extension ConnectApproval {
  /// t1266 (fix 6): names / ids / redirects shown and signed must be plain text (no control characters, no bidi tricks).
  static func safeField(_ s: String, max: Int = 512) -> Bool {
    guard !s.isEmpty, s.count <= max else { return false }
    return !s.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) || $0.properties.generalCategory == .format }
  }
  /// The host the owner is shown and the app returns to: ONLY the signed redirect URL's own https host (never a separate server field).
  static func returnHost(redirect: String) -> String? {
    guard safeField(redirect, max: 2048), let u = URL(string: redirect), u.scheme?.lowercased() == "https", u.user == nil, u.password == nil,
          let h = u.host?.lowercased(), !h.isEmpty, h.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }) else { return nil }
    return h
  }
  /// Max lifetime the phone accepts for a connection request it signs (server: 10 minutes).
  static let maxConnectLife: Int = 15 * 60
  /// now < exp <= now + 15 min (+ clock-skew tolerance on the upper bound only).
  static func expOK(_ exp: Int, now: Date = Date()) -> Bool {
    let t = Int(now.timeIntervalSince1970)
    return exp > t && exp <= t + maxConnectLife + Int(ClockSkew.upperTolerance)
  }
  /// First connect: the amounts the server sends back must be EXACTLY the ones this phone remembered, and within the wallet caps.
  /// nil = OK; otherwise a short reason (refuse).
  static func firstConnectProblem(server: AISpendLimits.Saved, pending: AISpendLimits.Saved?, caps: AILimitGate.Caps) -> String? {
    guard let p = pending else { return "no amounts on this phone" }
    if server != p { return "amounts differ from what you typed" }
    let v = AILimitGate.verdict(single: p.single, daily: p.daily, term: p.term, caps: caps)
    return v == .within ? nil : "amounts not within the wallet safety limit"
  }
}

/// t1266 (fix 7): kipurse:// links any app or web page can open.
public enum DeepLinkGate {
  /// kipurse://limits-updated / limits-pending only count while a signing page this app opened is on screen.
  public static func acceptsLimits(signingSheetOpen: Bool, demo: Bool) -> Bool { signingSheetOpen || demo }
  /// The chain itself shows the new limits (re-read on the phone before celebrating).
  public static func limitsOnChain(_ u: LimitsUpdate, chain: AILimitGate.Caps) -> Bool {
    if case .ready(let s, let d, let t) = chain { return s == u.single && d == u.daily && t == u.term }
    return false
  }
  /// kipurse://review-demo only when this phone has no real wallet / identity at all.
  public static func reviewDemoAllowed(hasState: Bool, inDemo: Bool, wallet: String, owner: String?, rememberedWallet: String?, hasSession: Bool) -> Bool {
    !hasState && !inDemo && wallet.isEmpty && (owner ?? "").isEmpty && (rememberedWallet ?? "").isEmpty && !hasSession
  }
}

/// t1266 (fix 7): what the demo shows where a deposit address would be. Clearly not an address (not hex), so nothing can be sent to it.
public enum DemoAddress {
  public static let placeholder = "0x" + String(repeating: "DEMO", count: 10)
  public static func isPlaceholder(_ s: String) -> Bool { s == placeholder }
}
