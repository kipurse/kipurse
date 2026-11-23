import Foundation

/// t1238 (handbook §6#109): after the owner's wallet moved to a new key-seat wallet, the phone showed the OLD wallet's cached home
/// (AIs "online", October ledger) because the one local cache file is not tied to a wallet and sign-out kept it.
/// A cached home may be shown only for the wallet this phone is on now.
public enum CacheGuard {
  /// current: Operator.wallet ("" = not known yet). cached: the wallet inside the cached state (nil = unknown).
  public static func usable(cachedWallet: String?, current: String) -> Bool {
    let c = current.trimmingCharacters(in: .whitespaces).lowercased()
    guard !c.isEmpty else { return true }                       // nothing chosen yet (cold start before sign-in): old behaviour
    guard let w = cachedWallet?.lowercased(), !w.isEmpty else { return false }   // a cache that doesn't say whose it is: don't show it
    return w == c
  }
}
