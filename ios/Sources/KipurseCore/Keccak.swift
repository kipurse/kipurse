import Foundation

/// Keccak-256 (Ethereum's hash; original Keccak padding 0x01, not SHA3's 0x06).
public enum Keccak {
  private static let rc: [UInt64] = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B, 0x0000000080000001,
    0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A, 0x000000008000808B,
    0x800000000000008B, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
  private static let rot: [Int] = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
  private static func f(_ a: inout [UInt64]) {
    var b = [UInt64](repeating: 0, count: 25), c = [UInt64](repeating: 0, count: 5)
    for round in 0..<24 {
      for x in 0..<5 { c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] }
      for x in 0..<5 { let d = c[(x + 4) % 5] ^ ((c[(x + 1) % 5] << 1) | (c[(x + 1) % 5] >> 63)); for y in 0..<5 { a[x + 5 * y] ^= d } }
      for x in 0..<5 { for y in 0..<5 { let i = x + 5 * y, r = rot[i], v = a[i]
        b[y + 5 * ((2 * x + 3 * y) % 5)] = r == 0 ? v : (v << UInt64(r)) | (v >> UInt64(64 - r)) } }
      for x in 0..<5 { for y in 0..<5 { a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]) } }
      a[0] ^= rc[round]
    }
  }
  public static func hash(_ data: [UInt8]) -> [UInt8] {
    let rate = 136; var st = [UInt64](repeating: 0, count: 25)
    var msg = data; msg.append(0x01); while msg.count % rate != 0 { msg.append(0) }; msg[msg.count - 1] |= 0x80
    for off in stride(from: 0, to: msg.count, by: rate) {
      for i in 0..<(rate / 8) { var w: UInt64 = 0; for j in 0..<8 { w |= UInt64(msg[off + i * 8 + j]) << UInt64(8 * j) }; st[i] ^= w }
      f(&st)
    }
    var out = [UInt8](); for i in 0..<4 { for j in 0..<8 { out.append(UInt8((st[i] >> UInt64(8 * j)) & 0xff)) } }; return out
  }
  public static func hash(_ s: String) -> [UInt8] { hash(Array(s.utf8)) }
}

public enum Hex {
  public static func decode(_ s: String) -> [UInt8]? {
    var h = s.hasPrefix("0x") || s.hasPrefix("0X") ? String(s.dropFirst(2)) : s; if h.count % 2 == 1 { h = "0" + h }
    var out = [UInt8](); out.reserveCapacity(h.count / 2); var it = h.makeIterator()
    while let a = it.next(), let b = it.next() { guard let v = UInt8(String([a, b]), radix: 16) else { return nil }; out.append(v) }; return out
  }
  public static func encode(_ b: [UInt8]) -> String { "0x" + b.map { String(format: "%02x", $0) }.joined() }
}
