# 隐私政策 + 服务条款审阅 / Privacy policy & Terms review

> 不是法律意见。基于 2026-10-27 草稿和线上 kipurse.com/privacy（Last updated October 23, 2026）。

## 线上状态 / Live status (checked 2026-11-03)
- `https://kipurse.com/privacy` → 真实隐私政策页，日期 2026-10-23（**旧版**，10-27 草稿的更新没有发布）。
- `https://kipurse.com/terms` → 返回 200，但内容是**首页**（单页应用的兜底），**服务条款还没发布**。
- App：Settings → 帮助 已有「隐私政策」；本轮加了「服务条款」（只这一处）。条款页发布前，这个链接会打开首页 —— 必须先发布。

## 隐私政策 — 发现的问题
1. **gas 赞助说法过时**：线上政策写「从不赞助 gas」，但现在新用户开户由 Kipurse 先垫付、再从钱包收回固定 0.05 USDC。按主人规则不能写「免费 / 赞助 / 垫付」，建议写成「开户网络费从你的启付钱包余额扣」。
2. **Apple Pay / Onramp**：只用 Coinbase 托管页面（Coinbase 自己收集邮箱、手机号和支付信息）；Kipurse 从不收集或验证邮箱、手机号（t938）。政策里要写明购买跳到 Coinbase 页面，我们只传钱包地址、币种和金额。
3. **推送 token**：草稿已写，营养标签是否勾选「Device ID」需确认。
4. **Coinbase Verified 证明读取**：要写明我们读取链上公开的 EAS 证明（只读地址是否有证明，不拿身份信息）。
5. **AI 代理数据**：OAuth 授权、代理名称 —— 草稿已覆盖。
6. **儿童**：写明 18+（依赖 Coinbase KYC）。

## 服务条款 — 发现的问题
1. **未发布**（最大问题）。
2. §9 写的是 Apache-2.0 + AGPL-3.0 —— 与开源仓库一致（t937 已定：contracts/ios/SDK Apache-2.0，server AGPL-3.0）。
3. §6 费用里「[Owner: if the first wallet setup is sponsored…]」要按现在的开户费规则改。
4. §2 「Apple Pay/Onramp 只在美国」要等 Coinbase 批准后确认。
5. §4 写「Kipurse 不限制用户设的额度」—— 和赞助上限（20/天、$2/天、$0.25/笔，只针对 Kipurse 垫付的 gas）不冲突，但最好说明。
6. 新增「暂停 AI 付款」：一个开关停掉所有 AI（含 Siri），充值和提现照常 —— 建议写进 §4。
7. §15 争议解决、§12 责任上限、§16 Apple 条款 都标了 [Attorney]，需要律师定。
8. 繁体中文：不提供（主人规则）。条款建议只发英文正式版 + 简体中文参考译本，并写明以英文为准。

## 下一步 / Next steps（需要主人）
2. 律师审阅两份草稿。
3. 发布 kipurse.com/terms 和更新 /privacy（网站改动需要主人批准）。
