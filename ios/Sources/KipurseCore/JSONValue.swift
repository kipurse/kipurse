import Foundation
/// Loose JSON so the app keeps working when the server adds fields.
public enum JSONValue: Codable, Equatable {
  case string(String), number(Double), bool(Bool), object([String:JSONValue]), array([JSONValue]), null
  public init(from d: Decoder) throws {
    let c = try d.singleValueContainer()
    if c.decodeNil() { self = .null } else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) } else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) } else { self = .object(try c.decode([String:JSONValue].self)) }
  }
  public func encode(to e: Encoder) throws {
    var c = e.singleValueContainer()
    switch self { case .string(let s): try c.encode(s); case .number(let n): try c.encode(n); case .bool(let b): try c.encode(b)
    case .object(let o): try c.encode(o); case .array(let a): try c.encode(a); case .null: try c.encodeNil() }
  }
  public subscript(_ k: String) -> JSONValue? { if case .object(let o) = self { return o[k] }; return nil }
  public var array: [JSONValue] { if case .array(let a) = self { return a }; return [] }
  public var string: String? { switch self { case .string(let s): return s; case .number(let n): return n == n.rounded() ? String(Int64(n)) : String(n); case .bool(let b): return String(b); default: return nil } }
  /// Base-unit integer from "123" / 123.
  public var atomic: Int64? { switch self { case .string(let s): return Int64(s); case .number(let n): return Int64(n); default: return nil } }
  public var bool: Bool { if case .bool(let b) = self { return b }; return false }
}
