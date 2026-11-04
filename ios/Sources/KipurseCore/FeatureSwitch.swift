import Foundation

/// t821: every outage / self-rescue feature sits behind its own switch (default ON). Turn one off with
/// `defaults write <bundle> kp.ff.<name> -bool NO` or the DEBUG launch argument `-kpOff<name>`; nothing else changes.
public enum FeatureSwitch: String, CaseIterable {
  case calmBanner, chainRead, chainRescue, chainRevoke, ledgerCache
  public var on: Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpOff" + rawValue) { return false }
    #endif
    return UserDefaults.standard.object(forKey: "kp.ff." + rawValue) as? Bool ?? true
  }
}
