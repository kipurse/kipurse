// SPDX-License-Identifier: Apache-2.0
import Foundation
import CryptoKit

/// t621 #1 (2026-10-27): the phone decodes EVERY Coinbase wallet batch the server builds (new-user setup, re-setup, add / upgrade phone,
/// unlink phone, limits incl. the fee refund, withdraw) and checks every target, function, address and amount against what it expects
/// BEFORE anything opens. Only then it commits to the exact batch: SHA-256 over a canonical form goes into the page URL fragment
/// (#vh=…, never sent to a server) and the Kipurse pages refuse to send any other batch (owner-sign/guard/kpvh.js).
/// Public chain constants only; no user or operator data.
public enum BatchVerify {
  public static let chainId = 8453
  /// Coinbase Smart Wallet factory (Base) and the ERC-1967 proxy init-code hash it deploys (implementation 0x00000110…534d).
  public static let factory = "0xba5ed110efdba3d005bfc882d75358acbbb85842"
  public static let factoryProxyInitHash = "0xa53d9968113cdf38ec78edc985b30bcb1a274ddaa221624c1d15604f70b0761a"
  public static let deployer = "0x4e59b44847b379578588920ca78fbf26c0b4956c"
  /// t1197u (§6#92): the trust contract of THIS wallet's suite (V5.2 0x65d2… / V5.3 0xda1d…).
  public static var trust: String { KipurseSuite.active.trust.lowercased() }
  static var spm: String { RequestVerify.spendPermissionManager.lowercased() }
  /// keccak256 of each KipursePhoneApprover creation bytecode (without constructor args) and its length.
  public static let approverCode: [String: (hash: String, len: Int, args: Int)] = [
    "v3": ("0x5a9764bb3f6d20605148ce7168ff18da84a37475c8008f112ada0cf4b4d42dfe", 7252, 4),
    "v2": ("0xbb39a0fc5d3ef3c35473c59fe7e1519b3cac5286ad054b7d8bb48fef6b852621", 7723, 6),
    "v1": ("0xe881029e8a2616e491c68031ba3b3eb284c666c824f1e7c7a4d0a8553f9f5808", 7201, 6)]

  public struct Report: Equatable { public var problems: [String] = []; public var notes: [String] = []; public var approver: String?
    public var ok: Bool { problems.isEmpty } }

  static func lc(_ s: String) -> String { s.lowercased() }
  static func word(_ b: [UInt8]) -> [UInt8] { [UInt8](repeating: 0, count: max(0, 32 - b.count)) + b.suffix(32) }
  static func w(_ v: UInt64) -> [UInt8] { var x = v.bigEndian; return word(withUnsafeBytes(of: &x) { Array($0) }) }
  static func sel(_ sig: String) -> String { Hex.encode(Array(Keccak.hash(sig).prefix(4))) }
  static let selAddOwner = sel("addOwnerAddress(address)"), selRemoveOwner = sel("removeOwnerAtIndex(uint256,bytes)"),
             selExecute = sel("execute(address,uint256,bytes)"), selExecuteBatch = sel("executeBatch((address,uint256,bytes)[])"),
             selCreate = sel("createAccount(bytes[],uint256)")

  // ---- commitment ----
  /// Decimal form of a call value ("0x0", "0", nil, numbers).
  static func decValue(_ v: Any?) -> String? {
    switch v { case nil: return "0"; case let n as Int: return n >= 0 ? String(n) : nil; case let n as UInt64: return String(n)
    case let s as String:
      if s.hasPrefix("0x") || s.hasPrefix("0X") { let h = String(s.dropFirst(2)); if h.isEmpty { return "0" }; guard let b = Hex.decode(h), b.count <= 32 else { return nil }; return RequestVerify.decimal(word(b)) }
      guard !s.isEmpty, s.allSatisfy({ $0.isNumber }) else { return nil }; let t = s.drop { $0 == "0" }; return t.isEmpty ? "0" : String(t)
    default: return nil }
  }
  public static func canonical(chainId: Int, from: String, calls: [[String: Any]]) -> String? {
    var parts = [String]()
    for c in calls { guard let to = c["to"] as? String, let v = decValue(c["value"]) else { return nil }; parts.append("\(lc(to)),\(v),\(lc((c["data"] as? String) ?? "0x"))") }
    return "kpbatch1|\(chainId)|\(lc(from))|" + parts.joined(separator: ";")
  }
  public static func commitment(chainId: Int, from: String, calls: [[String: Any]]) -> String? {
    guard let s = canonical(chainId: chainId, from: from, calls: calls) else { return nil }
    return SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  /// Page URL + "#vh=<commitment>" (the fragment never leaves the phone / browser).
  public static func committedURL(_ url: URL, chainId: Int, from: String, calls: [[String: Any]]) -> URL? {
    guard let h = commitment(chainId: chainId, from: from, calls: calls), var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    if let sh = SignHost.shellURL(for: url, fragment: "vh=" + h, lang: Loc.code) { return sh }
    c.fragment = "vh=" + h; return c.url
  }
  /// Deposit page: "#vw=<wallet>" lets the page send ONLY USDC to that wallet, or a stray-coin return from it back to the signer.
  public static func depositURL(_ url: URL, wallet: String) -> URL {
    guard Hex.decode(wallet)?.count == 20, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    if let sh = SignHost.shellURL(for: url, fragment: "vw=" + lc(wallet), lang: Loc.code) { return sh }
    c.fragment = "vw=" + lc(wallet); return c.url ?? url
  }

  // ---- addresses ----
  static func addrBytes(_ s: String) -> [UInt8]? { guard let a = Hex.decode(s), a.count == 20 else { return nil }; return a }
  static func create2(_ from: [UInt8], _ salt: [UInt8], _ initHash: [UInt8]) -> String { Hex.encode(Array(Keccak.hash([0xff] + from + salt + initHash).suffix(20))) }
  static func ownersEncoding(_ owner: [UInt8]) -> [UInt8] { w(0x40) + w(0) + w(1) + w(0x20) + w(32) + word(owner) }
  /// The Kipurse wallet a new user gets: Coinbase Smart Wallet owned only by their Coinbase wallet, nonce 0 (the factory's getAddress).
  public static func predictWallet(owner: String) -> String? {
    guard let o = addrBytes(owner), let f = addrBytes(factory), let ih = Hex.decode(factoryProxyInitHash) else { return nil }
    return create2(f, Keccak.hash(ownersEncoding(o)), ih)
  }
  static func createAccountData(owner: String) -> String? { guard let o = addrBytes(owner) else { return nil }; return lc(selCreate + Hex.encode(ownersEncoding(o)).dropFirst(2)) }

  /// Decode a deterministic-deployer call (salt ‖ initcode) for THIS phone's key and THIS wallet. Returns the approver address.
  static func approver(_ data: [UInt8], wallet: String, x: [UInt8], y: [UInt8], maxSingle: String?, maxDaily: String?, trust: String = BatchVerify.trust, problems: inout [String]) -> String? {
    guard data.count > 32, let wb = addrBytes(wallet), let tb = addrBytes(trust) else { problems.append("bad phone-signer deployment"); return nil }
    let salt = Array(data[0..<32]), initcode = Array(data[32...])
    for (v, a) in approverCode {
      guard Keccak.hash(Array(("kipurse-phone-approver-" + v).utf8) + x + y) == salt else { continue }
      guard initcode.count == a.len + a.args * 32, Hex.encode(Keccak.hash(Array(initcode[0..<a.len]))) == a.hash else { problems.append("phone-signer contract code is not the published Kipurse code"); return nil }
      let r = RequestVerify.R(b: Array(initcode[a.len...]))
      guard r.addr(0) == lc(Hex.encode(wb)), r.addr(32) == lc(Hex.encode(tb)), r.word(64) == x, r.word(96) == y else { problems.append("phone signer is not for this wallet / this phone"); return nil }
      if a.args == 6, let s = maxSingle, let d = maxDaily, let ps = r.dec(128), let pd = r.dec(160), RequestVerify.lt(s, ps) || RequestVerify.lt(d, pd) { problems.append("phone signer caps above your limits") }
      return create2(addrBytes(deployer)!, salt, Keccak.hash(initcode))
    }
    problems.append("phone signer is not for this phone's key"); return nil
  }

  static func callParts(_ c: [String: Any]) -> (to: String, data: [UInt8])? {
    guard let to = c["to"] as? String, addrBytes(to) != nil, decValue(c["value"]) == "0", let d = Hex.decode((c["data"] as? String) ?? "0x") else { return nil }
    return (lc(to), d)
  }
  static func selector(_ d: [UInt8]) -> String { d.count >= 4 ? Hex.encode(Array(d.prefix(4))) : "0x" }
  /// t1238 (handbook §6#106): Coinbase refuses top-level owner calls, so the server sends owner changes as the wallet calling itself:
  /// wallet.execute(wallet, 0, addOwnerAddress/removeOwnerAtIndex(...)). Returns the INNER call so it is checked by exactly the same rules
  /// as the old top-level form. `.none` = not a self-call (checked as before); `.bad` = a self-call we don't accept (anything else inside,
  /// a value, or non-canonical encoding).
  enum SelfCall { case none, inner([UInt8]), bad }
  static func selfCall(_ to: String, _ d: [UInt8], wallet: String) -> SelfCall {
    guard to == lc(wallet), selector(d) == selExecute else { return .none }
    let r = RequestVerify.R(b: Array(d.dropFirst(4)))
    guard d.count >= 4 + 128, let tgt = r.addr(0), tgt == lc(wallet) else { return .none }  // execute on another target (e.g. the USDC fee leg): old rules
    guard r.dec(32) == "0", r.int(64) == 96, let len = r.int(96), len >= 4, len <= d.count, d.count == 4 + 128 + (len + 31) / 32 * 32 else { return .bad }
    let inner = Array(d[(4 + 128)..<(4 + 128 + len)])
    guard d[(4 + 128 + len)...].allSatisfy({ $0 == 0 }) else { return .bad }
    let s = selector(inner); guard s == selAddOwner || s == selRemoveOwner else { return .bad }
    return .inner(inner)
  }
  /// removeOwnerAtIndex(i, owner): must remove an ADDRESS owner that is NOT your Coinbase wallet (nor the new phone signer / the permission manager).
  static func removeProblem(_ d: [UInt8], owner: String, keep: [String], only: String? = nil) -> String? {
    let r = RequestVerify.R(b: Array(d.dropFirst(4)))
    guard r.int(0) != nil, let o = r.int(32), let b = r.bytes(o), b.count == 32, b.prefix(12).allSatisfy({ $0 == 0 }) else { return "removes an owner it can't show" }
    let a = Hex.encode(Array(b.suffix(20)))
    if a == lc(owner) { return "would remove YOUR Coinbase wallet from the wallet" }
    if keep.map(lc).contains(a) { return "would remove a key it must keep" }
    if let o = only, lc(o) != a { return "removes a different phone signer" }
    return nil
  }

  /// One-signature setup batches. New user: [factory.createAccount([you],0)]? + deployer(phone signer) + wallet.addOwnerAddress(SPM)? +
  /// wallet.executeBatch(your limits) + wallet.addOwnerAddress(phone signer). Re-setup adds removeOwnerAtIndex(old signers) and no factory call.
  /// t1197u (§6#92): `suite` = the contract suite this batch must use (nil: the suite of the server's vault if it is one of ours, else this wallet's).
  public static func setup(calls: [[String: Any]], wallet: String, owner: String, x: [UInt8], y: [UInt8], choice: RequestVerify.Choice, newWallet: Bool, vault: String? = nil, suite: KipurseSuite? = nil, now: Date = Date()) -> Report {
    let su = suite ?? KipurseSuite.forVault(vault, wallet: wallet) ?? KipurseSuite.active
    var rep = Report(); var p = [String]()
    // option A: leading approve(CDP paymaster) / deposit transfer(this wallet) are checked here, then the usual steps follow
    let ug = UsdcGas.split(calls, wallet: wallet, vault: vault); p += ug.problems; let calls = ug.rest
    if ug.vaultSeed > 0 { rep.notes.append("puts \(AnswerRules.format(Int64(ug.vaultSeed))) USDC of your money into your wallet's fee reserve") }
    if ug.approved > 0 { rep.notes.append("lets Coinbase take the network fee in USDC (at most 0.25)") }; if ug.feeRepaid > 0 { rep.notes.append("pays the opening fee in USDC in this confirmation") }; if ug.deposit > 0 { rep.notes.append("deposits your USDC into your Kipurse wallet") }; if newWallet && !ug.leading.isEmpty && ug.feeRepaid == 0 && ug.approved == 0 { p.append("opening must repay the network fee in USDC in this confirmation") } // enforced on live prepare by the app; legacy vectors have no USDC prefix
    // t1238 §6#109: key-seat opening (owners fixed at creation). Detected only by THIS owner's own seat, computed on the phone.
    if let seat = KeySeat.address(owner: owner, trust: su.trust), isSeatBatch(calls, wallet: wallet, owner: owner, seat: seat, trust: su.trust) {
      return setupSeat(calls, rep0: rep, problems: p, ug: ug, wallet: wallet, owner: owner, x: x, y: y, choice: choice, newWallet: newWallet, vault: vault, su: su, seat: seat, now: now) }
    if newWallet { if predictWallet(owner: owner) != lc(wallet) { p.append("wallet address isn't the one your Coinbase wallet gets") } }
    var approver: String?, addedApprover = false, limits = 0
    if calls.isEmpty || calls.count > 12 { p.append("unexpected number of steps") }
    for (i, c) in calls.enumerated() {
      guard let (to, d0) = callParts(c) else { p.append("step \(i + 1) is malformed or sends ETH"); continue }
      var d = d0  // t1238 §6#106: wallet.execute(wallet,0,owner change) is checked as its inner call
      switch selfCall(to, d0, wallet: wallet) { case .bad: p.append("step \(i + 1) is an unexpected wallet self-call"); continue; case .inner(let x): d = x; case .none: break }
      let s = selector(d)
      switch to {
      case factory:
        if !(newWallet && i == 0 && Hex.encode(d) == createAccountData(owner: owner)) { p.append("unexpected wallet creation") } else { rep.notes.append("creates your wallet") }
      case deployer:
        if approver != nil { p.append("deploys twice") } else { approver = Self.approver(d, wallet: wallet, x: x, y: y, maxSingle: choice.single, maxDaily: choice.daily, trust: su.trust, problems: &p) }
      case lc(wallet):
        if s == selAddOwner, let a = RequestVerify.R(b: Array(d.dropFirst(4))).addr(0), d.count == 36 {
          if a == spm && newWallet { rep.notes.append("lets the spend permission manager use your limits") }
          else if let ap = approver, a == ap { addedApprover = true }
          else { p.append("adds an unknown owner \(a) to your wallet") }
        } else if s == selRemoveOwner {
          if let e = removeProblem(d, owner: owner, keep: [approver ?? "", spm]) { p.append(e) } else { rep.notes.append("removes an old phone signer") }
        } else if s == selExecuteBatch {
          let r = RequestVerify.limitsBatch(calls: [["to": to, "data": Hex.encode(d), "value": "0x0"]], wallet: wallet, chainId: chainId, choice: choice, currentExecutor: nil, adapter: su.adapter, owner: owner, vault: vault, now: now)
          p += r.problems; rep.notes += r.notes; limits += 1
        } else if s == selExecute {
          if let e = RequestVerify.feeRefundProblem(["to": to, "data": Hex.encode(d), "value": "0x0"], wallet: wallet, owner: owner) { p.append(e) }
        } else { p.append("unknown wallet function \(s)") }
      default: p.append("step \(i + 1) calls an unknown contract \(to)")
      }
    }
    // 0A.1: opening may omit the phone Face ID key (added later after a balance). If present, it must be this phone.
    if approver != nil && !addedApprover { p.append("phone signer is not added") }
    if limits != 1 { p.append("expected exactly one limits step") }
    rep.problems = p; rep.approver = approver; return rep
  }

  /// Add / upgrade this phone: deployer(phone signer for THIS key) + wallet.addOwnerAddress(it) + removeOwnerAtIndex(old signers)* + fee refund?
  /// t843 replacing: the old approver the SERVER STATUS reported (phone/status active.approver). When set, the batch must add this phone's
  /// signer FIRST and then remove exactly that one old approver (one removal, nothing else removed) in the same signature.
  public static func enroll(calls: [[String: Any]], wallet: String, owner: String, x: [UInt8], y: [UInt8], replacing: String? = nil) -> Report {
    if let seat = KeySeat.address(owner: owner, trust: trust), isSeatBatch(calls, wallet: wallet, owner: owner, seat: seat, trust: trust) { return enrollSeat(calls, wallet: wallet, owner: owner, x: x, y: y, seat: seat) }
    var rep = Report(); var p = [String](); var approver: String?, added = false; var removed = [String](); var removedBeforeAdd = false; var fees = 0
    if calls.count < 2 || calls.count > 10 { p.append("unexpected number of steps") }
    for (i, c) in calls.enumerated() {
      guard let (to, d0) = callParts(c) else { p.append("step \(i + 1) is malformed or sends ETH"); continue }
      var d = d0  // t1238 §6#106: wallet.execute(wallet,0,owner change) is checked as its inner call
      switch selfCall(to, d0, wallet: wallet) { case .bad: p.append("step \(i + 1) is an unexpected wallet self-call"); continue; case .inner(let x): d = x; case .none: break }
      let s = selector(d)
      if to == deployer, approver == nil { approver = Self.approver(d, wallet: wallet, x: x, y: y, maxSingle: nil, maxDaily: nil, problems: &p); continue }
      guard to == lc(wallet) else { p.append("step \(i + 1) calls an unknown contract \(to)"); continue }
      if s == selAddOwner, d.count == 36, let a = RequestVerify.R(b: Array(d.dropFirst(4))).addr(0), let ap = approver, a == ap { added = true }
      else if s == selRemoveOwner { if let e = removeProblem(d, owner: owner, keep: [approver ?? "", spm], only: replacing) { p.append(e) }
        if !added { removedBeforeAdd = true }
        let r = RequestVerify.R(b: Array(d.dropFirst(4))); if let o = r.int(32), let b = r.bytes(o), b.count == 32 { removed.append(Hex.encode(Array(b.suffix(20)))) } }
      else if s == selExecute { fees += 1; if fees > 1 { p.append("more than one fee payment") }  // t906: the wallet pays the fee to Kipurse ops (fixed address, max 0.05) while gas is sponsored
        if let e = RequestVerify.feeRefundProblem(["to": to, "data": Hex.encode(d), "value": "0x0"], wallet: wallet, owner: owner, alsoTo: RequestVerify.duesTo) { p.append(e) } }
      else { p.append("unexpected wallet function \(s)") }
    }
    if approver == nil { p.append("no phone signer for this phone") }
    if !added { p.append("phone signer is not added") }
    if let old = replacing {
      if lc(old) == lc(owner) || lc(old) == lc(spm) { p.append("old approver can't be your Coinbase wallet or the permission manager") }
      if removed.count != 1 || removed.first != lc(old) { p.append("must remove exactly the old phone signer, once") }
      if removedBeforeAdd { p.append("removes the old phone signer before adding this phone") }
    }
    rep.problems = p; rep.approver = approver; return rep
  }

  /// Unlink a phone: only removeOwnerAtIndex on your wallet, never your Coinbase wallet (and only `approver` if the phone knows it).
  public static func revoke(calls: [[String: Any]], wallet: String, owner: String, approver: String?) -> Report {
    var rep = Report()
    // t1238 §6#109: key-seat wallet: Face ID off = exactly wallet.execute(your seat, 0, clearKey()); nothing else.
    if let seat = KeySeat.address(owner: owner, trust: trust), isSeatBatch(calls, wallet: wallet, owner: owner, seat: seat, trust: trust) {
      if calls.count != 1 { rep.problems.append("unexpected number of steps") }
      for c in calls { guard let (to, d) = callParts(c), to == lc(wallet), let inner = KeySeat.executeOn(d, target: seat), Hex.encode(inner).lowercased() == KeySeat.clearKeyData else { rep.problems.append("unexpected step"); continue } }
      if let a = approver, lc(a) != lc(seat) { rep.problems.append("not your Face ID key seat") }
      return rep }
    if calls.isEmpty || calls.count > 3 { rep.problems.append("unexpected number of steps") }
    for c in calls {
      guard let (to, d0) = callParts(c), to == lc(wallet) else { rep.problems.append("unexpected step"); continue }
      var d = d0  // t1238 §6#106: the removal may come as wallet.execute(wallet,0,removeOwnerAtIndex(...))
      switch selfCall(to, d0, wallet: wallet) { case .bad: rep.problems.append("unexpected step"); continue; case .inner(let x): d = x; case .none: break }
      guard selector(d) == selRemoveOwner else { rep.problems.append("unexpected step"); continue }
      if let e = removeProblem(d, owner: owner, keep: [spm], only: approver) { rep.problems.append(e) }
    }
    return rep
  }
}

// MARK: - t1238 key seat (handbook §6#109)
extension BatchVerify {
  /// A batch is a key-seat batch when it creates the wallet with THIS owner's seat, deploys THIS owner's seat, or calls wallet.execute(THIS seat, ...).
  static func isSeatBatch(_ calls: [[String: Any]], wallet: String, owner: String, seat: String, trust: String) -> Bool {
    let create = KeySeat.createAccountData(owner: owner, trust: trust), dep = KeySeat.deployData(owner: owner, trust: trust)
    return calls.contains { c in
      guard let (to, d) = callParts(c) else { return false }
      let h = Hex.encode(d).lowercased()
      return (to == factory && h == create) || (to == deployer && h == dep) || (to == lc(wallet) && KeySeat.executeOn(d, target: seat) != nil)
    }
  }
  /// Opening a key-seat wallet: [factory.createAccount([you, your seat, SPM], 0)] + [deployer(your seat)]? + wallet.executeBatch(your limits)
  /// + wallet.execute(your seat, 0, setKey(THIS phone)) + fee steps (already split off). No owner is ever added or removed.
  static func setupSeat(_ calls: [[String: Any]], rep0: Report, problems p0: [String], ug: UsdcGas.Split, wallet: String, owner: String, x: [UInt8], y: [UInt8],
                        choice: RequestVerify.Choice, newWallet: Bool, vault: String?, su: KipurseSuite, seat: String, now: Date) -> Report {
    var rep = rep0; var p = p0; var created = false, deployed = false, keySet = 0, limits = 0
    if newWallet { if KeySeat.predictWallet(owner: owner, trust: su.trust) != lc(wallet) { p.append("wallet address isn't the one your Coinbase wallet gets") } }
    if calls.isEmpty || calls.count > 6 { p.append("unexpected number of steps") }
    let create = KeySeat.createAccountData(owner: owner, trust: su.trust), dep = KeySeat.deployData(owner: owner, trust: su.trust), want = KeySeat.setKeyData(x: x, y: y)
    for (i, c) in calls.enumerated() {
      guard let (to, d) = callParts(c) else { p.append("step \(i + 1) is malformed or sends ETH"); continue }
      let h = Hex.encode(d).lowercased()
      switch to {
      case factory:
        if newWallet && i == 0 && !created && h == create { created = true; rep.notes.append("creates your wallet with your Coinbase wallet, your Face ID key seat and the spend permission manager as its only owners") }
        else { p.append("unexpected wallet creation") }
      case deployer:
        if !deployed && h == dep { deployed = true; rep.notes.append("deploys your Face ID key seat (public Kipurse code)") } else { p.append("unexpected deployment") }
      case lc(wallet):
        let s = selector(d)
        if let inner = KeySeat.executeOn(d, target: seat) {
          if Hex.encode(inner).lowercased() == want { keySet += 1 } else { p.append("Face ID key seat call is not 'use this phone'") }
        } else if s == selExecuteBatch {
          let r = RequestVerify.limitsBatch(calls: [["to": to, "data": h, "value": "0x0"]], wallet: wallet, chainId: chainId, choice: choice, currentExecutor: nil, adapter: su.adapter, owner: owner, vault: vault, now: now)
          p += r.problems; rep.notes += r.notes; limits += 1
        } else if s == selExecute, case .none = selfCall(to, d, wallet: wallet) {
          if let e = RequestVerify.feeRefundProblem(["to": to, "data": h, "value": "0x0"], wallet: wallet, owner: owner) { p.append(e) }
        } else { p.append("unexpected wallet step \(s) (a key-seat wallet never adds or removes owners)") }
      default: p.append("step \(i + 1) calls an unknown contract \(to)")
      }
    }
    if newWallet && !created { p.append("wallet is not created in this confirmation") }
    if keySet != 1 { p.append("this phone must be set exactly once") }
    if limits != 1 { p.append("expected exactly one limits step") }
    rep.problems = p; rep.approver = seat; return rep
  }
  /// New phone / reinstall on a key-seat wallet: exactly one wallet.execute(your seat, 0, setKey(THIS phone)) + at most one fee step. Nothing else.
  static func enrollSeat(_ calls: [[String: Any]], wallet: String, owner: String, x: [UInt8], y: [UInt8], seat: String) -> Report {
    var rep = Report(); var p = [String](); var keySet = 0, fees = 0; let want = KeySeat.setKeyData(x: x, y: y)
    if calls.isEmpty || calls.count > 2 { p.append("unexpected number of steps") }
    for (i, c) in calls.enumerated() {
      guard let (to, d) = callParts(c), to == lc(wallet) else { p.append("step \(i + 1) is not on your wallet"); continue }
      if let inner = KeySeat.executeOn(d, target: seat) { if Hex.encode(inner).lowercased() == want { keySet += 1 } else { p.append("Face ID key seat call is not 'use this phone'") }; continue }
      if selector(d) == selExecute, case .none = selfCall(to, d, wallet: wallet) { fees += 1; if fees > 1 { p.append("more than one fee payment") }
        if let e = RequestVerify.feeRefundProblem(["to": to, "data": Hex.encode(d), "value": "0x0"], wallet: wallet, owner: owner, alsoTo: RequestVerify.duesTo) { p.append(e) }; continue }
      p.append("unexpected wallet step (a key-seat wallet never adds or removes owners)")
    }
    if keySet != 1 { p.append("this phone must be set exactly once") }
    rep.problems = p; rep.approver = seat; return rep
  }
}

// MARK: - JSON helpers (server replies arrive as JSONValue in the app)
public extension BatchVerify {
  /// [{to,data,value}] -> [[String: Any]]; nil if the list is missing or any call isn't an object of strings.
  static func calls(_ v: JSONValue?) -> [[String: Any]]? {
    guard let v, case .array(let a) = v else { return nil }
    var out: [[String: Any]] = []
    for c in a { guard case .object(let o) = c else { return nil }; var d: [String: Any] = [:]; for (k, x) in o { if let s = x.string { d[k] = s } }; out.append(d) }
    return out
  }
  static func chainId(_ v: JSONValue?) -> Int? { v?.string.flatMap { Int($0) ?? ($0.hasPrefix("0x") ? Int($0.dropFirst(2), radix: 16) : nil) } }
}
