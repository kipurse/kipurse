# App Store 3.1.5 + Apple Pay 检查表 / Checklist

> 基于 App Store Review Guidelines（3.1.1、3.1.5、5.1、5.3 等）的条文理解，不是 Apple 的官方答复。提交前请主人再对照最新版指南。

## 3.1.5 Cryptocurrencies
| 条款 | 要求 | Kipurse | 状态 |
|---|---|---|---|
| 3.1.5(i) Wallets | 钱包 App 必须由**组织**（非个人）开发者账号提交 | Blessbridge Global Trading LLC 组织账号 | ✅ |
| 3.1.5(ii) Mining | 不能在设备上挖矿 | 无挖矿 | ✅ |
| 3.1.5(iii) Exchanges | 交易/买卖加密货币要在有牌照的交易所，并由持牌方提供 | 不自己卖币；Apple Pay 购买由 Coinbase Onramp（持牌）提供 | ✅（依赖 Coinbase 申请获批） |
| 3.1.5(iv) ICO | 不能做 ICO | 无 | ✅ |
| 3.1.5(v) | 不能用加密货币奖励完成任务（下载、发帖等） | 无奖励 | ✅ |
| 3.1.1 IAP | 数字内容/功能解锁必须用 IAP | 0.1% 服务费是付款手续费，不是解锁数字内容 —— **需确认** Apple 不视作应走 IAP | ⚠️ 未验证 |
| 5.1.1 隐私 | App 内和 App Store Connect 都要有隐私政策链接；隐私营养标签准确 | Settings 有「隐私政策」；营养标签需和政策对照 | ⚠️ 标签未逐项核对 |
| 5.1.1(v) 账号删除 | 能在 App 内删除账号 | Settings → 危险操作 → 删除 | ✅ |
| 5.3 / 地区 | 金融服务要符合各上线地区法律 | 需律师意见（见 MONEY_TRANSMISSION.md），建议先只上美国 | ⚠️ |
| 服务条款 | 金融类 App 建议提供 EULA/条款 | 已在 Settings → 帮助 加「服务条款」（唯一入口）；**kipurse.com/terms 还没发布**（现在打开是首页） | ❌ 先发布条款页 |
| 2.1 完整性 | 审核员能走完核心流程 | 需要演示账号/演示模式说明（Review Notes） | ⚠️ |

## Apple Pay（通过 Coinbase Onramp）
| 项 | 要求 | 状态 |
|---|---|---|
| 提供方 | 只用 Coinbase 托管 Onramp 页面；Kipurse 不碰卡信息，不收集邮箱或手机号（t938） | ✅ 设计 |
| Coinbase 批准 | 托管 Onramp 正式权限需 Coinbase 审核；托管页 Guest Checkout 已于 2026-06-30 停用，Apple Pay 是否可在 Coinbase 账号内使用待 Coinbase 确认 | ❌ 申请中 |
| KYC 门槛 | 购买前必须有 Coinbase Verified 证明（主人规则，fail closed） | ✅ 代码已实现 |
| 显示条款 | 显示 Coinbase Guest Checkout Terms + Privacy 链接 | ✅（ApplePayBuy.swift） |
| 到账 | 只有服务器确认钱进了钱包才显示「已到账」 | ✅ 设计；真机未验证 |
| 未开通时 | 按钮显示「申请中」，不扣钱 | ✅ |
| Apple Pay 品牌规范 | 使用官方 Apple Pay 按钮样式 / 标志 | ⚠️ 未逐项核对 Apple Pay Marketing Guidelines |
| Merchant ID | 若由 Coinbase 网页内嵌完成，Kipurse 不需要自己的 Apple Pay merchant ID —— 需和 Coinbase 确认 | ⚠️ |
