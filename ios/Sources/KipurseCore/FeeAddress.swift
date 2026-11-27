// SPDX-License-Identifier: Apache-2.0
import Foundation
/// t1346 (decision 169, owner t1302): the company Safe "Blessbridge Treasury" on Base (SafeL2 1.5.0, 2-of-3) is the ONLY fee address
/// the app lets any batch pay. Same constant as the server (src/v5/operator-constants.mjs COMPANY_FEE_TO) and the sign page (/v13 KPFEETO).
public enum FeeAddress {
  public static let company = "0x82ecf6e2f76ee100e4676dabe193bca6bcab64fd"
  /// Retired fee addresses: the scrubbed open-source placeholder 0xf14E…0Dd9 (nobody holds its key) and the old ops account 0xfc0E…345B.
  /// Never paid again (every check compares against `company` only); read ONLY so fees paid there in the past still show as fees in records.
  public static let retired: [String] = ["0xf14ef5dc4723245866c22c749a0a84afceba0dd9", "0xfc0e68572cdba016c1c90a45e1792f3fe0ee345b"]
  public static func isRetired(_ a: String?) -> Bool {
    guard let a else { return false }
    return retired.contains(a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
  }
  /// Addresses whose incoming transfers count as "fees" when reading history (company + retired). Never used to build or approve a payment.
  public static var historicalFeeRecipients: Set<String> { Set([company] + retired) }
}
