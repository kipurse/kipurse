// KIPURSE PRINCIPLES (app side). Mirrors gateway src/v5/principles.mjs.
// DO NOT CHANGE without a dated owner decision in OWNER_HANDBOOK.md. PrinciplesTests fails on any change.
public enum Principles {
  public static let payerFeeBps = 10           // 0.1%, payer pays; merchant 0
  public static let payerFeeCapBps = 30        // contract max 0.3%
  public static let gasMarginBps = 0           // network fee = actual cost
  public static let phoneUpgradeMarginPct = 0
  public static let phoneUpgradeMinUSDC = 0.0
  public static let holdAboveUSDC = 500.0      // only non-trusted payees
  public static let arrivedRequiresOnchainTx = true
  public static let onrampDestinationIsUserWallet = true
  /// t604u (2026-10-27, locked): gas and fees ALWAYS in USDC, never ETH, for every user-facing on-chain action.
  public static let gasToken = "USDC"
  public static let ethGasPath = false
  /// t603u: no preset AI limits; the first limit authorization (in onboarding) is free, later changes cost the actual fee in USDC.
  public static let presetLimits = false
  /// t609u: everyday limits (server, Face ID, free) are NEVER above the on-chain floor.
  public static let everydayBelowFloor = true
  /// t763u (2026-10-29, supersedes t603u): the first limit authorization is paid from the wallet like every later change.
  public static let firstLimitsFree = false
  /// t762u/t763u (2026-10-29, LOCKED, owner): 开户必须有 Coinbase Verified Account 链上认证，不接受充值记录；入金、出金只到这个已认证的主人地址；
  /// 入金/出金/链上手续费、付款失败烧掉的手续费、交易手续费(付给 Kipurse)全部由用户出；Kipurse 不承担一分钱，只可垫付开户网络费并在入金后扣除。
  public static let kycAttestationRequired = true
  public static let depositHistoryCountsAsKyc = false
  public static let kipurseNetCostUSDC = 0.0
  public static let failedGasPaidByUser = true
  public static let onboardingGasRecouped = true
  /// t787u 启付安全铁律（永不修改）: 不做大钱包；任何转出都要主人本人签名；服务器只拿小额权限（上限 20 次/天、2 美元/天、0.25 美元/笔），
  /// 只能提现到本人认证地址；签名页必须校验通过才打开、App 自己核对；储备只放够用的；密钥分开放；一键刹车；上线前外部审计和渗透测试。
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
    assert(ok, "PRINCIPLE_VIOLATION: locked owner rules t762u/t763u/t787u (OWNER_HANDBOOK.md)")
    return ok
  }
  /// Text guard: the app never asks the user for ETH.
  public static let forbiddenEthAsks = ["请先准备 ETH", "需要一点 ETH", "you need ETH", "add ETH", "充值 ETH", "为钱包提供资金", "Fund your wallet with ETH"]
}
