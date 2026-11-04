# 虚拟卡发卡合作方案 —— 2026-11-04
目标：让 AI 用主人自托管的 USDC 在只收银行卡的商家付款，不做资金池，启付也不收集邮箱或手机号。

## 必须先决定的硬冲突
所有受监管的发卡项目都要求持卡人 KYC，需要姓名、出生日期、住址，以及（Bridge/Stripe）手机号。来源：Bridge 卡片 KYC 文档（phone_number 校验、24 小时内重新确认）、Rain 开户说明（发卡前必须通过 KYC/KYB）、Lithic（通过 Lithic 做 KYC，只有预先批准的项目才能自带 KYC 或豁免）。
和我们「从不收集邮箱/手机号」规则的兼容方式：只有在**发卡方托管的 KYC 页面收集这些信息、启付永远不保存也看不到**的情况下才可行（Bridge/Persona 托管链接、Rain 托管页面）。启付只保存发卡方的客户 ID / 持卡人 ID。这个解释需要主人批准。
另外：卡上的余额由发卡方持有（预付 / 抵押），也就是说充值到卡的那一刻资金离开了自托管。设计方案：即时注资 —— AI 的 USDC 付款（在链上额度内）只为一次刷卡授权注资；启付不汇集任何资金。

## 方案对比
| 方案 | 模式 | 稳定币注资 | KYC | 对我们的要求 | 成本（需在销售沟通中确认） | 时间 | 契合度 |
|---|---|---|---|---|---|---|---|
| Bridge + Stripe Issuing | 面向个人的 Visa 虚拟卡，由稳定币支持 | 支持，原生（Bridge） | Bridge 托管的 Persona 链接，24 小时有效 | Stripe 账号状态良好、美国公司（Blessbridge LLC）、按地区审批发卡项目 | Stripe Issuing 每张卡 + 每次授权费用；Bridge 费用 | 6–12 周（含项目审核） | API 最契合；先做美国 |
| Rain | 加密卡发卡项目（Visa），链上 USDC 抵押 | 支持，链上抵押 | Rain KYC/KYB 申请 | 公司 KYB、项目协议 | 开通费 + 每张卡费用 + 交换费分成 | 8–12 周 | 链上契合度高；适合 Base |
| Lithic（稳定币试点） | 由稳定币充值地址注资的预付金融账户（支持 Base） | 支持，试点中 | Lithic KYC，或预先批准后自带/豁免 | 项目管理方批准、合作银行 | 平台费 + 每张卡费用 | 8–16 周，需试点资格 | 灵活，但仍是试点 |
| Crossmint / Coinbase 卡片方案 | 构建在发卡方之上的 AI 代理卡 API | 通过他们的钱包 | 他们的 KYC + 邮箱 | 合作协议；通常要求用他们的钱包/邮箱 | 收入分成 | 4–8 周 | 不契合：要求邮箱并由他们托管 |

## 建议
1. 同时申请 **Bridge（Stripe Issuing）** 和 **Rain**（以 Blessbridge Global Trading LLC 做公司 KYB）。申请本身不需要花钱。
2. 用功能开关开发：`server/src/v5/cards.mjs` 已经有卡片通道接口和模拟提供方 —— 加上 `bridge-stripe` 和 `rain` 两个提供方；每笔购买一张卡，锁定金额、锁定商家、只用一次，由 AI 受额度限制的 USDC 付款即时注资。
3. App：只在一个地方出现（在现有的 AI 付款额度里的「AI 刷卡」）；KYC 打开发卡方的托管页面；启付不保存任何个人信息。
4. 费用：发卡方成本按实际金额以 USDC 从钱包扣除，在 Face ID 之前的收据里显示（不新增启付费用 —— 调整费用由主人决定）。

## 需要主人决定
- 是否接受发卡方托管 KYC（发卡方收集手机号/住址，启付从不保存）？
- 由哪家公司申请；谁签项目协议；是否有开通费。

---
# 决定更新（2026-11-04）—— 主人已批准发卡方托管 KYC，启付不保存任何信息
## 推荐：Stripe Issuing + Bridge 稳定币卡（备选：Rain）
理由（资料于 2026-11-04 查阅）：
- **公开价格最低：** Stripe Issuing 虚拟卡每张 $0.10（美国/英国/欧盟），争议 $15，跨境 1% + $0.30（另加 1% 换汇）—— docs.stripe.com/issuing/choose-cards；Lithic Starter 也约 $0.10，但稳定币还在试点且只支持美国/加拿大；Rain 价格只在合同里（未公开）。
- **受理范围最广：** Visa 全球受理；稳定币卡支持 60 多个国家的持卡人（美国、拉美、加勒比、非洲、亚洲）—— docs.stripe.com/issuing/stablecoin-cards；Bridge 博客 2026-04-29（30 个国家，计划 2026 年底超过 100 个）。
- **保持自托管：** 「非托管钱包」注资方式 —— 刷卡授权时 Bridge 直接从用户自己的钱包扣款（启付没有资金池）。符合我们不做资金池的规则。
- **KYC 符合规则：** Bridge 托管 KYC 链接（Persona），加 `?endorsement=cards`；启付只保存 Bridge 客户 ID + Stripe 持卡人 ID。注意：如果 24 小时内没有开卡，需要重新确认。
- 卡片付款自带争议/拒付处理（Stripe Issuing disputes）—— 也补上了我们在刷卡消费上「没有拒付保护」的短板。
需要在销售沟通中确认：非托管注资是否支持 Base + USDC（链列表）、我们持卡人所在国家是否开放个人卡项目、Stripe 之外的 Bridge 费用、每月最低消费。

备选：**Rain** —— Visa 主会员，覆盖 1.5 亿多家商户，Rain 为每个用户管理智能合约抵押（自托管），约 6 周上线；价格按合同。

## 注册步骤（公司：Blessbridge Global Trading LLC）
1. Stripe：用公司现有或新建的 Stripe 账号 → 控制台 → Issuing → 「Stablecoin-backed cards」→ 联系销售（公开预览权限）。需要：公司 KYB（EIN、注册地址、受益所有人）、网站（kipurse.com）、项目说明（面向个人的预付/借记虚拟卡，用于 AI 代理购物，自托管 USDC 注资，发卡方托管 KYC）。
2. Bridge：bridge.xyz →「Get started」开发者账号 → 沙盒 API 密钥 → 关联 Stripe 账号后申请正式的卡片资格。
3. 要发送的合规材料：docs/compliance/MONEY_TRANSMISSION.md、PRIVACY_TERMS_REVIEW.md、本方案、费用表（docs/fees/FEES.md）。
4. 沙盒开发（不花钱）：在 server/src/v5/cards.mjs 里加 `bridge-stripe` 提供方（一次性、锁定金额和商家的虚拟卡，由 AI 受额度限制的 USDC 即时注资），在 Bridge 沙盒 + Stripe 测试模式中测试。
5. 签约时主人决定：合同条款、最低消费；卡片成本按实际金额以 USDC 从钱包扣除（不新增启付费用）。
需要主人操作：Stripe/Bridge 注册的是公司账号（新账号）—— 我准备好所有材料，主人负责开户和 KYB。
