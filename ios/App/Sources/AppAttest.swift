import Foundation
import DeviceCheck
import CryptoKit

/// Apple App Attest (t629): proves to the Kipurse server that a new-wallet request comes from the genuine Kipurse app on a real
/// iPhone. The attestation is bound to the phone key being enrolled. Free; nothing personal is sent. Simulator: unsupported -> nil.
enum AppAttest {
  static func clientDataHash(x: String, y: String) -> Data {
    Data(SHA256.hash(data: Data("kipurse-attest-v1|\(x.lowercased())|\(y.lowercased())".utf8)))
  }
  static func attest(x: String, y: String) async -> [String: String]? {
    let s = DCAppAttestService.shared
    guard s.isSupported else { return nil }
    do {
      let k = try await s.generateKey()
      let a = try await s.attestKey(k, clientDataHash: clientDataHash(x: x, y: y))
      return ["keyId": k, "attestation": a.base64EncodedString()]
    } catch { return nil }
  }
}
