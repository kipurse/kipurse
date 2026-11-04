# Coinbase Onramp 申请状态（2026-11-03 更新）

## 主人规则
启付**从不收集、也不验证**用户的邮箱或手机号。Apple Pay 购买只走 **Coinbase 托管的 Onramp 页面**，由 Coinbase 自己处理邮箱、手机号和支付。**不申请 Headless Onramp**（它要求 App 自己收集并用验证码验证邮箱和手机号，还要接入费）。

## 现状
- 主人 2026-10-27 批准用 Blessbridge Global Trading LLC 名义申请 CDP Onramp，前提是**不产生任何费用**；一旦需要付费就停下问主人。
- App 内「Apple Pay 充值」按钮在，显示「申请中」，购买前必须有 Coinbase Verified 证明。
- Coinbase 尚未批准；没找到申请编号或提交日期的记录（未验证）。
- 官方申请渠道：CDP Onramp 开通表单 https://support.cdp.coinbase.com/onramp-onboarding （需登录 CDP 账号）。没有公开邮箱。

## ⚠️ 重要风险
Coinbase 文档写明：**托管 Onramp 页面里的 Guest Checkout（借记卡、Apple Pay，无需 Coinbase 账号）已于 2026-06-30 停用**，Coinbase 建议改用 Headless。托管页面现在支持的是「登录 Coinbase 账号后的支付方式」，且标注不收开发者费用。
→ 在托管页面上能不能用 Apple Pay，取决于 Coinbase 账号内是否提供 Apple Pay；这正是申请里要问 Coinbase 的问题。我们的用户本来就必须有通过 KYC 的 Coinbase 账号，所以「登录 Coinbase 后购买」符合规则。

## 下一步
1. 主人登录 CDP，用上面的表单提交（正文见报告 / 本目录 README）。
2. 发布 kipurse.com/terms（申请通常需要条款和隐私政策链接）。
3. 若 Coinbase 回复要收费或只给 Headless → 停下，交主人决定。
