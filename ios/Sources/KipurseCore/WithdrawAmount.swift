import Foundation

/// t1116: everyday withdraw = any amount the user picks, or everything ("[zh]" / "All", = wallet + fee reserve, as before).
/// Only the amount is the user's; the destination is still only the user's own Coinbase wallet (OwnerExit rebuilds the batch).
public enum WithdrawAmount {
  public enum Problem: String, Equatable { case empty, notANumber, zero, overBalance, notAboveFee }
  /// "12.5" / "1,234.56" -> atomic USDC (6 decimals). "0" -> 0. nil = not a plain amount (letters, 7+ decimals, "1e6", negative…).
  public static func atomic(_ raw: String) -> Int64? {
    let v = raw.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "，", with: "").replacingOccurrences(of: "。", with: ".").trimmingCharacters(in: .whitespaces)
    let parts = v.split(separator: ".", omittingEmptySubsequences: false)
    guard !v.isEmpty, parts.count <= 2, parts[0].allSatisfy({ $0.isASCII && $0.isNumber }), parts[0].count <= 9 else { return nil }
    let i = Int64(parts[0].isEmpty ? "0" : String(parts[0])) ?? 0
    var f: Int64 = 0
    if parts.count == 2 { let d = String(parts[1]); guard d.count <= 6, d.allSatisfy({ $0.isASCII && $0.isNumber }), !(parts[0].isEmpty && d.isEmpty) else { return nil }; f = Int64((d + "000000").prefix(6)) ?? 0 }
    return i * 1_000_000 + f
  }
  /// The amount the user chose: the "all" choice = the whole balance (`total`); otherwise the typed / preset number.
  public static func chosen(text: String, allLabel: String, total: Int64) -> Int64? { text == allLabel ? total : atomic(text) }
  /// Why the withdraw button stays off (nil = OK to continue). Fee unknown -> not checked here (the server refuses at/below the fee).
  public static func problem(text: String, allLabel: String, total: Int64, fee: Int64?) -> Problem? {
    if text.trimmingCharacters(in: .whitespaces).isEmpty { return .empty }
    guard let n = chosen(text: text, allLabel: allLabel, total: total) else { return .notANumber }
    if n <= 0 { return .zero }
    if n > total { return .overBalance }
    if let f = fee, n <= f { return .notAboveFee }
    return nil
  }
  /// A preset tile is usable only when it is not more than the balance ("All" is always usable).
  public static func presetAvailable(_ preset: String, total: Int64) -> Bool { atomic(preset).map { $0 <= total } ?? true }
  /// The prepared plan must be for EXACTLY the amount the user just confirmed (no "close enough").
  public static func preparedMatches(prepared: UInt64, confirmed: Int64) -> Bool { confirmed > 0 && prepared == UInt64(confirmed) }
  /// [zh] ≈ amount − network fee (never below 0).
  public static func net(amount: Int64, fee: Int64) -> Int64 { max(0, amount - fee) }
}
