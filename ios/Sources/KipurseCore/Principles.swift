// KIPURSE PRINCIPLES (app side). Mirrors gateway src/v5/principles.mjs.
// DO NOT CHANGE without a dated owner decision in the owner's decision log. PrinciplesTests fails on any change.
public enum Principles {
  public static let payerFeeBps = 10           // 0.1%, payer pays; merchant 0
  public static let payerFeeCapBps = 30        // contract max 0.3%
  public static let gasMarginBps = 0           // network fee = actual cost
  public static let phoneUpgradeMarginPct = 0
  public static let phoneUpgradeMinUSDC = 0.0
  public static let holdAboveUSDC = 500.0      // only non-trusted payees
  public static let arrivedRequiresOnchainTx = true
  public static let onrampDestinationIsUserWallet = true
  /// t604 (2026-10-27, locked): gas and fees ALWAYS in USDC, never ETH, for every user-facing on-chain action.
  public static let gasToken = "USDC"
  public static let ethGasPath = false
  /// t603: no preset AI limits; the first limit authorization (in onboarding) is free, later changes cost the actual fee in USDC.
  public static let presetLimits = false
  /// t609: everyday limits (server, Face ID, free) are NEVER above the on-chain floor.
  public static let everydayBelowFloor = true
  /// t763 (2026-10-29, supersedes t603): the first limit authorization is paid from the wallet like every later change.
  public static let firstLimitsFree = false
  /// t762/t763 (2026-10-29, LOCKED, owner): [zh]
  /// [zh]([zh] Kipurse)[zh]
  public static let kycAttestationRequired = true
  public static let depositHistoryCountsAsKyc = false
  public static let kipurseNetCostUSDC = 0.0
  public static let failedGasPaidByUser = true
  public static let onboardingGasRecouped = true
  /// t787 [zh]: [zh]
  /// [zh]
  public static let noPooledCustody = true
  public static let ownerSignsEveryOutflow = true
  public static let withdrawOnlyToVerifiedOwner = true
  public static let signPagePinRequired = true
  public static let sponsorMaxPerDay = 20, sponsorMaxUSDPerDay = 2.0, sponsorMaxUSDPerOp = 0.25
  public static let externalAuditBeforeRealUsers = true
  /// Boot check (call at app start in DEBUG and from tests): crashes a debug build if a locked rule is contradicted.
  public static func assertLocked() -> Bool {
    let pin = SignHost.indexSHA256.count == 64 && SignHost.host != SignHost.apiHost && SignHost.moved.contains("/owner/withdraw") && SignHost.moved.contains("/onboard/new")
    let t787 = noPooledCustody && ownerSignsEveryOutflow && withdrawOnlyToVerifiedOwner && signPagePinRequired && pin && externalAuditBeforeRealUsers
      && sponsorMaxPerDay == 20 && sponsorMaxUSDPerDay == 2.0 && sponsorMaxUSDPerOp == 0.25
    let ok = t787 && kycAttestationRequired && !depositHistoryCountsAsKyc && kipurseNetCostUSDC == 0 && failedGasPaidByUser && onboardingGasRecouped && !firstLimitsFree && gasToken == "USDC" && !ethGasPath
    assert(ok, "PRINCIPLE_VIOLATION: locked owner rules t762/t763/t787 (the owner's decision log)")
    return ok
  }
  /// Text guard: the app never asks the user for ETH.
  public static let forbiddenEthAsks = ["请先准备 ETH", "需要一点 ETH", "you need ETH", "add ETH", "充值 ETH", "为钱包提供资金", "Fund your wallet with ETH"]
}


/// t1027 / 0A.2 / 0B: cold launch never Face ID. Face ID only for these actions when there is a balance.
public enum LaunchBiometricPolicy {
  public static let faceIDRequiredOnColdLaunch = false
  public static let faceIDActions = ["pay_approval", "withdraw", "add_agent"]
}
