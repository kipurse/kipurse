// SPDX-License-Identifier: Apache-2.0
import Foundation

/// t1275: the phone never adopts the owner / wallet a sign-in status names on the server's word. The server returns the owner's own SIWE
/// message + signature; the phone checks them itself and only then hands the owner to WalletVerify (chain) and adopts the wallet:
///   1. the message (EIP-4361) is for `owner`, on the pinned API host (domain and https URI), chain 8453, the nonce this phone's
///      /signin/start got, sane issued / expiry times, and its statement names THIS phone's own key fingerprint (the server writes the
///      read grant only for that key: same text as gateway signin.mjs signinStatement, cross-tested with t1275-signin-siwe.json.txt);
///   2. the signature is valid for `owner` on chain: the deployless ERC-6492 universal validator (works for undeployed Coinbase Smart
///      Wallets, deployed ones via ERC-1271, and EOAs) run as an eth_call that two public Base nodes must answer identically.
/// Any failure -> nil / a reason, and the app adopts nothing. No Face ID here (sign-in rule 0A #2).
public enum SigninSiwe {
  public static let chainId = 8453
  public static let genericStatement = "Sign in to Kipurse. This only proves this account is yours. It costs nothing and sends no transaction."
  public static func statement(fp: String) -> String { "Sign in to Kipurse and allow the iPhone with key \(fp) to read this wallet. Free: no transaction." }
  /// The statement this phone expects: its own key's fingerprint (PhoneTrust.fingerprint), or the plain text when it sent no key.
  public static func statement(x: [UInt8]?, y: [UInt8]?) -> String {
    guard let x, let y, x.count == 32, y.count == 32 else { return genericStatement }
    return statement(fp: PhoneTrust.fingerprint(x: x, y: y))
  }
  public struct Fields: Equatable {
    public var domain = "", address = "", statement: String? = nil, uri: String? = nil, version: String? = nil, chainId: Int? = nil, nonce: String? = nil
    public var issuedAt: String? = nil, expirationTime: String? = nil, notBefore: String? = nil
  }
  static let known: Set<String> = ["URI", "Version", "Chain ID", "Nonce", "Issued At", "Expiration Time", "Not Before", "Request ID", "Resources"]
  /// Strict EIP-4361 reader (CRLF tolerated, as the server does). Unknown / repeated fields or a malformed header -> nil.
  public static func parse(_ message: String) -> Fields? {
    let L = message.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
    let tail = " wants you to sign in with your Ethereum account:"
    guard L.count >= 4, L[0].hasSuffix(tail), L[2].isEmpty else { return nil }
    var f = Fields(); var d = String(L[0].dropLast(tail.count)); if d.lowercased().hasPrefix("https://") { d = String(d.dropFirst(8)) }
    guard !d.isEmpty, !d.contains(" ") else { return nil }
    f.domain = d; f.address = L[1].trimmingCharacters(in: .whitespaces)
    var i = 3
    if L.count > 4, L[4].isEmpty, !L[3].isEmpty { f.statement = L[3]; i = 5 }
    var seen = Set<String>(); var inResources = false
    while i < L.count {
      let l = L[i]; i += 1
      if inResources, l.hasPrefix("- ") { continue }
      if l.isEmpty, i == L.count { break }   // one trailing newline
      guard let c = l.range(of: ": ") ?? (l.hasSuffix(":") ? l.range(of: ":", options: .backwards) : nil) else { return nil }
      let k = String(l[..<c.lowerBound]), v = String(l[c.upperBound...]).trimmingCharacters(in: .whitespaces)
      guard known.contains(k), seen.insert(k).inserted else { return nil }
      inResources = k == "Resources"
      switch k {
      case "URI": f.uri = v
      case "Version": f.version = v
      case "Chain ID": guard let n = Int(v) else { return nil }; f.chainId = n
      case "Nonce": f.nonce = v
      case "Issued At": f.issuedAt = v
      case "Expiration Time": f.expirationTime = v
      case "Not Before": f.notBefore = v
      default: break
      }
    }
    return f
  }
  static func date(_ s: String) -> Date? {
    let a = ISO8601DateFormatter(); a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let b = ISO8601DateFormatter(); b.formatOptions = [.withInternetDateTime]
    return a.date(from: s) ?? b.date(from: s)
  }
  /// How old a signed message the phone still accepts (the server's own limit is 10 minutes; status is polled right after).
  public static let maxAge: TimeInterval = 30 * 60
  /// nil = the message is exactly what this phone asked for; otherwise a short reason (logs only, never shown raw).
  public static func problem(message: String, owner: String, x: [UInt8]?, y: [UInt8]?, nonce: String?, host: String = SignHost.apiHost, now: Date = Date()) -> String? {
    guard message.utf8.count <= 2000, let f = parse(message) else { return "parse" }
    guard CoinbaseIdentity.isAddress(owner), f.address.lowercased() == owner.lowercased() else { return "owner" }
    let h = host.lowercased()
    guard f.domain.lowercased() == h else { return "domain" }
    guard let us = f.uri, let u = URL(string: us), u.scheme?.lowercased() == "https", u.host?.lowercased() == h, u.port == nil, u.user == nil, u.password == nil else { return "uri" }
    guard f.chainId == chainId else { return "chain" }
    if let v = f.version, v != "1" { return "version" }
    guard f.statement == statement(x: x, y: y) else { return "statement" }
    guard let n = nonce, !n.isEmpty, f.nonce == n else { return "nonce" }
    if let s = f.issuedAt { guard let t = date(s), t > now.addingTimeInterval(-maxAge), t < now.addingTimeInterval(ClockSkew.upperTolerance) else { return "time" } }
    if let s = f.expirationTime { guard let t = date(s), t > now else { return "expired" } }
    if let s = f.notBefore { guard let t = date(s), t < now.addingTimeInterval(ClockSkew.upperTolerance) else { return "not_yet" } }
    return nil
  }
  /// EIP-191 personal_sign hash (what a Coinbase / Base Account signs for SIWE).
  public static func personalHash(_ message: String) -> [UInt8] {
    let b = Array(message.utf8); return Keccak.hash(Array("\u{19}Ethereum Signed Message:\n\(b.count)".utf8) + b)
  }
  /// eth_call data (no `to`): validator creation code + abi.encode(address signer, bytes32 hash, bytes signature). Same bytes as viem
  /// encodeDeployData(erc6492SignatureValidatorAbi, erc6492SignatureValidatorByteCode, [owner, hash, signature]).
  public static func validatorCall(owner: String, hash: [UInt8], signature: String) -> String? {
    guard CoinbaseIdentity.isAddress(owner), hash.count == 32, signature.hasPrefix("0x"), signature.count <= 20002, let a = Hex.decode(owner), a.count == 20,
          let s = Hex.decode(signature), !s.isEmpty, let code = Hex.decode(validatorCode) else { return nil }
    func word(_ n: Int) -> [UInt8] { var w = [UInt8](repeating: 0, count: 32); var v = n; for k in stride(from: 31, through: 24, by: -1) { w[k] = UInt8(v & 0xff); v >>= 8 }; return w }
    let pad = (32 - s.count % 32) % 32
    return Hex.encode(code + [UInt8](repeating: 0, count: 12) + a + hash + word(96) + word(s.count) + s + [UInt8](repeating: 0, count: pad))
  }
  /// The validator returns one byte: 0x01 = valid. Anything else (0x00, empty, revert) = not valid.
  public static func isValid(_ result: String?) -> Bool {
    guard let r = result, let b = Hex.decode(r), let last = b.last else { return false }
    return last == 1 && b.dropLast().allSatisfy { $0 == 0 }
  }
  /// eth_call without `to` (deployless) -> hex result, nil = could not confirm. Production: two nodes must agree.
  public typealias DeploylessCall = (String) async -> String?
  public static let agreedCall: DeploylessCall = { data in await ChainRPC.agreed("eth_call", [["data": data], "latest"]) }
  /// nil = the owner signed exactly this message for this phone; otherwise a short reason (logs only).
  public static func check(owner: String, message: String?, signature: String?, x: [UInt8]?, y: [UInt8]?, nonce: String?, host: String = SignHost.apiHost,
                           now: Date = Date(), call: DeploylessCall = agreedCall) async -> String? {
    guard let m = message, let s = signature else { return "missing" }
    if let p = problem(message: m, owner: owner, x: x, y: y, nonce: nonce, host: host, now: now) { return p }
    guard s.count >= 4, s.count <= 20002, s.dropFirst(2).allSatisfy(\.isHexDigit), let data = validatorCall(owner: owner, hash: personalHash(m), signature: s) else { return "signature_shape" }
    return isValid(await call(data)) ? nil : "signature"
  }
  /// The sign-in's owner, only once `check` passed for it; nil = adopt nothing.
  public static func verifiedOwner(_ r: CoinbaseIdentity.Result, x: [UInt8]?, y: [UInt8]?, nonce: String?, host: String = SignHost.apiHost, now: Date = Date(),
                                   call: DeploylessCall = agreedCall) async -> String? {
    await check(owner: r.owner, message: r.siweMessage, signature: r.siweSignature, x: x, y: y, nonce: nonce, host: host, now: now, call: call) == nil ? r.owner : nil
  }
  public static var refusedText: String { T("没能确认这次登录是你的 Coinbase 账户亲自签的，已停止，什么都没有改。请重新登录。",
                                             "Couldn't confirm this sign-in was signed by your own Coinbase account. Stopped; nothing was changed. Please sign in again.") }
  /// ERC-6492 universal signature validator creation code (viem erc6492SignatureValidatorByteCode; keccak checked by the cross-test).
  public static let validatorCode = "0x608060405234801561001057600080fd5b5060405161069438038061069483398101604081905261002f9161051e565b600061003c848484610048565b9050806000526001601ff35b60007f64926492649264926492649264926492649264926492649264926492649264926100748361040c565b036101e7576000606080848060200190518101906100929190610577565b60405192955090935091506000906001600160a01b038516906100b69085906105dd565b6000604051808303816000865af19150503d80600081146100f3576040519150601f19603f3d011682016040523d82523d6000602084013e6100f8565b606091505b50509050876001600160a01b03163b60000361016057806101605760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90610190908b9087906004016105f9565b602060405180830381865afa1580156101ad573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906101d19190610633565b6001600160e01b03191614945050505050610405565b6001600160a01b0384163b1561027a57604051630b135d3f60e11b808252906001600160a01b03861690631626ba7e9061022790879087906004016105f9565b602060405180830381865afa158015610244573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102689190610633565b6001600160e01b031916149050610405565b81516041146102df5760405162461bcd60e51b815260206004820152603a602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610157565b6102e7610425565b5060208201516040808401518451859392600091859190811061030c5761030c61065d565b016020015160f81c9050601b811480159061032b57508060ff16601c14155b1561038c5760405162461bcd60e51b815260206004820152603b602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610157565b60408051600081526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156103ea573d6000803e3d6000fd5b505050602060405103516001600160a01b0316149450505050505b9392505050565b600060208251101561041d57600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b038116811461045857600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561048c578181015183820152602001610474565b50506000910152565b600082601f8301126104a657600080fd5b81516001600160401b038111156104bf576104bf61045b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156104ed576104ed61045b565b60405281815283820160200185101561050557600080fd5b610516826020830160208701610471565b949350505050565b60008060006060848603121561053357600080fd5b835161053e81610443565b6020850151604086015191945092506001600160401b0381111561056157600080fd5b61056d86828701610495565b9150509250925092565b60008060006060848603121561058c57600080fd5b835161059781610443565b60208501519093506001600160401b038111156105b357600080fd5b6105bf86828701610495565b604086015190935090506001600160401b0381111561056157600080fd5b600082516105ef818460208701610471565b9190910192915050565b828152604060208201526000825180604084015261061e816060850160208701610471565b601f01601f1916919091016060019392505050565b60006020828403121561064557600080fd5b81516001600160e01b03198116811461040557600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572"
}
