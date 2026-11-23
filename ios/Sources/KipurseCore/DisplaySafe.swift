import Foundation

/// t690 red-team: merchant / payee names come from AI agents and merchant pages (unverified). Before they reach the ledger,
/// receipts or notifications: drop bidi overrides, zero-width and control characters, flatten newlines, hide long hex
/// (no fake addresses), drop fake "verified" marks, cap the length. Display only: never used for routing money.
public enum DisplaySafe {
  static let invisible: Set<UInt32> = [0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF, 0x00AD]
  static let fakeMarks: Set<UInt32> = [0x2705, 0x2611, 0x2714, 0x1F512, 0x1F510, 0x1F6E1, 0x2B50]
  public static func merchant(_ raw: String, max: Int = 32) -> String {
    var s = String(String.UnicodeScalarView(raw.unicodeScalars.compactMap { u -> Unicode.Scalar? in
      if invisible.contains(u.value) || fakeMarks.contains(u.value) || u.properties.generalCategory == .format { return nil }
      if u.value == 0xFE0F { return nil }
      if CharacterSet.newlines.contains(u) || CharacterSet.controlCharacters.contains(u) { return " " }
      return u }))
    s = s.replacingOccurrences(of: "0[xX][0-9a-fA-F]{6,}", with: "…", options: .regularExpression)
    s = s.replacingOccurrences(of: "[0-9a-fA-F]{12,}", with: "…", options: .regularExpression)
    s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    if s.count > max { s = String(s.prefix(max - 1)) + "…" }
    return s
  }
}
