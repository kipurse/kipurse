# 资金转移分析 / Money-transmission analysis (FinCEN + Texas)

> **不是法律意见 / NOT LEGAL ADVICE.** Informational summary to prepare a lawyer consultation. Facts below describe the product as built on 2026-11-03.

## 1. 产品事实 / Product facts the analysis depends on
- **非托管 Non-custodial：** 每个用户一个自己的智能钱包（Coinbase Smart Wallet / Base Account 为 owner）。Kipurse 没有资金池，从不持有用户 USDC 或私钥。
- **服务器权限 Server powers：** 服务器持有 executor/session key，只能在用户链上签好的 SpendPermission 额度内、按用户规则付款；不能加新收款人（需要手机 Face ID 签名）、不能改额度、不能阻止提现。
- **提现 Withdraw：** 只能回到用户自己的 Coinbase 钱包；服务器宕机也能用开源页面提现。
- **费用 Fees：** 每笔付款 0.1% 服务费（USDC，从用户钱包扣），网络费按成本从用户钱包扣。新用户开户 gas 由 Kipurse 先垫付再从钱包收回（「开户费」固定 0.05 USDC）。
- **充值 Funding：** 只从用户自己的 Coinbase Wallet / Base Account 转入；Apple Pay 购买由 Coinbase Onramp 完成（Coinbase 是持牌 MSB）。
- **身份 Identity：** 只依赖 Coinbase Verified Account 链上证明；Kipurse 自己不做 KYC。
- **公司：** Blessbridge Global Trading LLC（德州 Houston）。

## 2. FinCEN（联邦）
- 2019 FinCEN Guidance (FIN-2019-G001) §4.2：**非托管钱包软件提供者**（不持有、不控制用户资金）一般**不是** money transmitter。关键是「是否独立控制价值」。
- 风险点（需要律师判断）：
  1. 服务器 executor key 能在额度内**主动**发起付款 —— 是否构成对资金的「total independent control」？我们的论点：额度、收款人范围由用户链上签名限定，用户可随时撤销 / 暂停 / 提现，因此不是独立控制。
  2. 0.1% 费用从付款中收取 —— 是否让 Kipurse 成为「accepting and transmitting」链条的一方？
  3. 开户 gas 垫付后从钱包收回 —— 是否构成「为他人转移价值」或信贷？
  4. 手续费地址是 Kipurse 运营账户：收的是自己的费用，不是代客转账（需确认）。
- 若被认定为 MSB：需要 FinCEN 注册（Form 107）、AML 计划、SAR/CTR、OFAC 合规。

## 3. Texas（州）
- Texas Finance Code Chapter 152（Money Services Businesses），2023 年修订后明确把「virtual currency」纳入「money or monetary value」（HB 1666 / 2023），并由 Texas Department of Banking 监管。
- Texas DoB Supervisory Memorandum 1037（虚拟货币）：非托管、不接收用户资金的软件通常不需要牌照；但「接收资金并承诺转移」的需要。
- USDC 是稳定币 → 在德州被视为「money or monetary value」的可能性高。
- 需要律师确认：Kipurse 的 executor 付款是否算「receiving」用户的 monetary value。

## 4. 其他州 / Other states
- 用户不止在德州：纽约 BitLicense、加州 DFAL（2026 年 7 月起生效的牌照要求）对「控制」的定义可能更宽。建议律师给出 50 州矩阵或限制上线州。

## 5. 给律师的问题 / Questions for counsel
1. 在 FIN-2019-G001 下，一个能在用户签名额度内主动付款的服务器 key，是否让我们成为 money transmitter？如果是，怎样改架构能避免（例如每笔都要用户签名）？
2. 0.1% 服务费从付款中扣除的方式，有没有监管影响？改成单独收费是否更好？
3. 开户 gas 垫付 + 从钱包收回，是否构成借贷或资金转移？
4. Texas Ch.152 + SM 1037：我们需要德州 MSB 牌照吗？是否需要书面向 Texas DoB 申请 no-action / 确认？
5. 加州 DFAL、纽约 BitLicense：是否需要牌照或应该暂不对这些州开放？
6. 仅依赖 Coinbase Verified 证明、不自己做 KYC，是否足够（尤其若被认定为 MSB）？
7. OFAC 筛查（地址名单 + Chainalysis 链上 oracle）是否足够？需要书面制裁合规政策吗？
8. App Store 上架主体（Blessbridge Global Trading LLC）和服务条款的责任限制、仲裁条款是否可执行？
9. 开源许可（Apache-2.0 + AGPL-3.0（t937 已定））对责任有无影响？
10. 用户 AI 代理在额度内的付款，法律上算谁授权？条款需要怎么写？

## 6. 现状 / Status
- 律师意见：**缺**。没有任何书面法律意见。
- 建议：上线前至少拿到 FinCEN + Texas 的书面意见。
