// SPDX-License-Identifier: Apache-2.0
import Foundation

// MARK: R15 - the home balance is the last two-node agreed one, never the server's number over it

/// t1279 (R15): the server is untrusted. The balance the owner relies on is the last one two public nodes agreed on (this session, in
/// memory, for one wallet). The server's number is shown only before the chain has answered even once (first load); after that a
/// failed / disagreeing chain read keeps the last agreed value instead of falling back to the server.
public struct AgreedBalanceMemory: Equatable {
  public private(set) var wallet: String?
  public private(set) var value: Int64?
  public init() {}
  /// Remember a two-node agreed read (nil = nodes failed / disagreed: keeps what is there). Another wallet starts over.
  public mutating func record(_ agreed: Int64?, wallet w: String) {
    let k = w.lowercased()
    if wallet != k { wallet = k; value = nil }
    if let a = agreed { value = a }
  }
  public mutating func reset() { wallet = nil; value = nil }
  /// The last agreed balance of this wallet (nil = none yet this session).
  public func value(for w: String?) -> Int64? {
    guard let w, let k = wallet, k == w.lowercased() else { return nil }
    return value
  }
  /// A fresh server state with its balance replaced by the last agreed one of the same wallet (unchanged when there is none yet).
  public func apply(to s: WalletState, wallet w: String?) -> WalletState {
    guard let v = value(for: s.wallet ?? w), s.balance != v else { return s }
    return s.withBalance(v)
  }
  /// The balance the chain ledger is rebuilt from: this read's agreed balance, else the last agreed one. Never the server's (nil = skip).
  public func ledgerEnd(chain: Int64?, wallet w: String) -> Int64? { chain ?? value(for: w) }
}

/// t1279 (R15): a deposit shows "已到账 +X" only from two agreed chain balances: one before (baseline) and one now.
public enum DepositArrival {
  public static func plus(baseline: Int64?, now: Int64?) -> Int64? {
    guard let b = baseline, let n = now, n > b else { return nil }
    return n - b
  }
}

// MARK: R17 - connect card: name / avatar only from a verified host

public extension ConnectBrand {
  /// The name the connect UI shows: the official name of a verified host, else the host itself, else `generic`. Never the AI's own name.
  static func shown(host: String, generic: String = "AI") -> String {
    let h = host.trimmingCharacters(in: .whitespaces)
    if let b = verified(host: h) { return b }
    return h.isEmpty ? generic : h
  }
}
