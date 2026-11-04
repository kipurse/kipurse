# Kipurse 攻击路径评审 / Attack-path review (t934, 2026-11-03)

范围：iOS App（KipurseCore + App）、Kipurse 服务器（gateway / kit）、V5 合约。只在模拟器和测试环境验证，没有动主网、没有动真钱。
Scope: iOS app, Kipurse server, V5 contracts. Verified on simulator / test fixtures only — no mainnet, no real funds.

图例 Legend：✅ 已有缓解并有测试 · ⚠️ 有缓解但有缺口 · ❌ 缺

## 1. 恶意 AI / Malicious AI agent
| 攻击 | 缓解 | 证据 | 状态 |
|---|---|---|---|
| 在额度内乱花 | 链上 SpendPermission 上限 + 每个 AI 自己的额度 + 服务器 anomaly 自动暂停（>30 笔/10 分钟、>200 笔/天、>8 个新收款人/天） | gateway `siri-allowance-t899`, `t934-security` | ✅（损失上限 = 用户设的额度） |
| 付给自己控制的新地址 | 新收款人 → `ask_owner` → 手机 Face ID；App 在手机上重算签名内容（OwnerPay.toSign），收款人/金额/钱包/链/截止时间任何一个不对就拒签 | `t934-security`「new payee」; iOS `T934SecurityTests.testPhoneRefusesSwapped…` | ✅ |
| 暂停后继续付款（旧连接） | **发现缺口**：kit 服务器的旧版 SSE 会话在连接时绑定 engine，主人之后暂停/断开这个 AI，已打开的 SSE 会话还能继续调用付款工具 | 修复：`kit/pause.mjs liveAgentEngine` 每次调用都重新检查暂停/撤销；测试 `server/test/t934-security.test.mjs` | ⚠️ 已在开源仓库 `server/`（生产网关清理版）修好并有测试 `server/test/t934-sse-pause.test.mjs`；**线上生产服务器未部署** |
| 读取别人的钱包 | per-user 路由 + OAuth 跨租户 13 项攻击矩阵（既有） | THREAT_MODEL.md | ✅（既有测试，本轮未重跑生产 fork 测试） |

## 2. 重放 / Replay
| 攻击 | 缓解 | 证据 | 状态 |
|---|---|---|---|
| 重放旧的批准签名 | EIP-712 OwnerApproval 含 purchaseKey + deadline；手机只签 10 秒–1 小时内的截止时间；链上 nonce/purchaseKey 一次性 | iOS `testPhoneRefuses…`（expired、wrongChain） | ✅ |
| 跨链重放 | domain 绑定 chainId 8453 + adapter 地址；手机拒绝 chainId≠8453 | 同上 | ✅ |
| 同一订单重复扣款 | idempotencyKey 必填（缺失直接拒绝） | gateway 现有测试 | ✅ |

## 3. 钓鱼收款人 / Phishing payees
| 攻击 | 缓解 | 状态 |
|---|---|---|
| 长得像的地址（前后几位相同） | 新收款人必须 Face ID；批准页显示完整分组地址；自己的地址默认缩写、陌生地址显示全 | ⚠️ 用户仍可能在 Face ID 时没看清；建议加「和以前付过的地址相似」警告（未做） |
| 服务器被篡改，换收款人 | 手机自己重算 digest，和服务器给的不一致就拒签（digestMismatch） | ✅ |
| 已知诈骗地址 | 制裁/诈骗名单筛查（服务器端） | ⚠️ 依赖服务器诚实，本轮未验证名单更新 |

## 4. 提示注入 / Prompt injection
| 攻击 | 缓解 | 状态 |
|---|---|---|
| 网页/邮件让 AI「把钱转到 X」 | AI 只能在额度内付给已知收款人；新收款人和超额都要主人 Face ID；Siri 不能自己选新地址 | ✅（设计上把损失限制在额度内） |
| 注入让 AI 提高自己的额度 | 改额度是 owner 草稿，必须 Face ID 签名；暂停中的 AI 调 setLimits 被拒 | ✅ `kit-pause`, `t934-security` |
| 注入让 AI 发起提现 | 提现只能到主人自己的 Coinbase 钱包，批次由手机重建校验（RequestVerify / OwnerExit） | ✅ |
| AI 回答里伪造「已付款」 | App 只显示服务器链上确认的状态 | ⚠️ 依赖服务器；未做独立链上核对 |

## 5. 被偷且已解锁的手机 / Stolen, unlocked phone
| 攻击 | 缓解 | 状态 |
|---|---|---|
| 直接打开 App 付款 | 新收款人、超额、恢复暂停都要 Face ID（Secure Enclave，不能导出） | ✅ |
| 用 Siri 在额度内付给已知收款人 | **设计如此**：额度内已知收款人不需要 Face ID → 小偷最多花掉 Siri 当天剩余额度 | ⚠️ 已知风险，靠低额度控制；建议默认 Siri 额度保持很低 |
| 显示余额 | 余额眼睛不需要 Face ID（主人规则），冷启动隐藏 | ⚠️ 已知取舍 |
| 远程止损 | 在 Coinbase 账户里确认即可暂停 AI、取消等待中的付款、全部提现（不需要手机） | ✅ 设计；**未在真机验证** |
| Siri 在暂停时跳过确认 | **发现缺口**：`SiriSkip.inside` 不看暂停状态，暂停中仍可能判断为「额度内、直接付」（服务器会拒，但手机端不该这样判断） | ✅ 已修复（SiriAgent.swift，备份 .bak-t934），iOS 测试覆盖 |

## 6. 服务器宕机 / Server down
- 设计：开源「离线提现」页面 + Base Account 签名，不经过 Kipurse 服务器。
- 本轮：模拟器上把服务器地址设成 `https://kipurse.invalid`（真不可达）跑 T820 停机演练，结果见 PROGRESS / 报告。
- 真机 + 真钱的端到端提现 **未验证**（需要主人本人签名）。

## 7. 赞助 gas 上限 / Sponsor caps
- 生产 gateway `onboard-sponsor.mjs` 默认：每天 20 笔、每天 $2、每笔 $0.25；新测试 `t934-caps.test.mjs` 钉死这三个数和边界（19→可以、20→停；$1.99→可以、$2→停；单笔超 $0.25→拒）。
- 缺口：环境变量可以把上限调高，没有「不能超过 X」的硬上限；建议加启动断言（未改，需主人决定）。

## 主要缺口汇总 / Top gaps
1. SSE 暂停绕过：开源仓库已修，生产未部署。
2. `server/` 已换成生产网关的清理版；8 个依赖运营方地址/App Attest 样本的冻结向量测试在开源版里标为 skip。
3. 没有外部安全审计。
4. 相似地址警告未做。
5. 赞助上限可被环境变量调高，没有硬上限。
6. 真机项目全部需要主人本人做（见报告）。
