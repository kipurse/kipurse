# 网页钱包和安卓计划（仅计划）
同样的合约、同样的网关、同样的规则：只有一个「暂停 AI 付款」开关，批准方式等同 Face ID，不收集邮箱或手机号，费用以 USDC 从钱包扣除。

## 网页钱包（先做，约 3 周）
- 通行密钥（WebAuthn）作为主人，通过 Base Account / Coinbase Smart Wallet；批准使用设备自带的验证器（Touch ID / Windows Hello）。
- 复用：`owner-sign/` 页面、救援页面（本来就不依赖服务器）、`server/src/v5/receipt.mjs`（批准前显示费用）。
- 页面：钱包余额、已连接的 AI（真实状态）、批准请求、暂停、提现、争议。每个功能只出现一次。
- 网页端没有 Apple Pay；在 Coinbase Onramp 网页版获批之前，充值只能用 USDC 转账。

## 安卓（和网页并行，约 6 周；已有 Play 账号）
- Kotlin + Jetpack Compose；用 Credential Manager 管理通行密钥；用 BiometricPrompt 批准；用 Play Integrity 代替 App Attest。
- 把 `ios/Sources/KipurseCore` 的逻辑（纯 Swift）移植到共享的 Kotlin 模块；复用服务器测试向量保证一致。
- Google Play：主人已有开发者账号。计划：第 4 周内部测试轨道，第 5 周封闭测试（Play 要求新个人账号有测试人员），第 6 周正式审核。
- 发布规则和 TestFlight 一样：每个 Play 版本都同步到 github.com/kipurse/kipurse 并打标签（`android-vX.Y.Z-buildN`）。
- 需要准备的 Play 政策项：金融功能声明（加密钱包，非托管）、数据安全表（不收集邮箱/手机号）、目标 API 级别保持最新、由 Google Play 进行应用签名。
- 外部依赖：Coinbase Onramp 对 Google Pay 的批准（和 Apple Pay 申请分开）。
