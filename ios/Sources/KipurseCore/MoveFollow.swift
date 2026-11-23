import Foundation

/// t1253 (handbook §6#122): after the owner-signed V5.4 -> V5.5 move the phone switches to the new wallet ONLY on its own chain checks,
/// never because the server says so (address-integrity rule). The phone derives the V5.5 wallet and key seat from the owner's Base
/// Account itself, then requires, from the chain (two independent nodes agreeing):
///   1. the new wallet has code, and both the owner's Base Account and that seat are its owners;
///   2. the seat is bound to that wallet (immutable `wallet()`);
///   3. the seat holds THIS phone's own P-256 key (x, y).
/// Any check that fails or can't be confirmed -> no switch (nil).
public enum MoveFollow {
  /// eth_call(to, data) -> hex result (nil = could not confirm). Production: ChainRPC.ethCall(..., agreed: true).
  public typealias Call = (String, String) async -> String?
  /// eth_getCode(address) -> hex code (nil = could not confirm).
  public typealias Code = (String) async -> String?

  static let selX = "0x0c55699c", selY = "0xa56dfe4a", selWallet = "0x521eb273", selIsOwnerAddress = "0xa2e1a8d8"

  static func word(_ h: String?) -> [UInt8]? {
    guard let h, let b = Hex.decode(h), b.count == 32 else { return nil }
    return b
  }
  static func pad(_ a: String) -> String? {
    guard let b = Hex.decode(a), b.count == 20 else { return nil }
    return String(repeating: "0", count: 24) + Hex.encode(b).replacingOccurrences(of: "0x", with: "")
  }
  static func isTrue(_ h: String?) -> Bool { word(h).map { $0.last == 1 && $0.dropLast().allSatisfy { $0 == 0 } } ?? false }

  /// The V5.5 wallet this phone should use instead of `current`, or nil (stay on `current`).
  public static func target(current: String, owner: String, x: [UInt8], y: [UInt8], call: Call, code: Code) async -> String? {
    guard x.count == 32, y.count == 32, Hex.decode(owner)?.count == 20,
          let nw = KipurseV55.wallet(owner: owner), let seat = KipurseV55.seat(owner: owner),
          nw.lowercased() != current.lowercased() else { return nil }
    guard let c = await code(nw), c.count > 2, let sc = await code(seat), sc.count > 2 else { return nil }
    guard let po = pad(owner), let ps = pad(seat),
          isTrue(await call(nw, selIsOwnerAddress + po)), isTrue(await call(nw, selIsOwnerAddress + ps)) else { return nil }
    guard let w = word(await call(seat, selWallet)), Hex.encode(Array(w[12...])).lowercased() == nw.lowercased() else { return nil }
    guard let sx = word(await call(seat, selX)), let sy = word(await call(seat, selY)), sx == x, sy == y else { return nil }
    return nw
  }

  /// Production wiring: two public nodes must agree on every read.
  public static func target(current: String, owner: String, x: [UInt8], y: [UInt8]) async -> String? {
    await target(current: current, owner: owner, x: x, y: y,
                 call: { to, data in await ChainRPC.ethCall(to, data, agreed: true) },
                 code: { a in await ChainRPC.agreed("eth_getCode", [a, "latest"]) })
  }
}
