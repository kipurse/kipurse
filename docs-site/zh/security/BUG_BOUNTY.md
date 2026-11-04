# 启付漏洞赏金（草案）
状态：**草案，奖金尚未到位**，金额需要主人决定。在此之前：在 SECURITY.md 和版本说明中公开致谢。

请私下报告到 `SECURITY.md` 里的地址。不要在不属于你的主网钱包上测试；请使用 Base Sepolia。

| 严重程度 | 例子 | 拟定奖金（待定） |
|---|---|---|
| 严重 | AI 超出链上额度付款；未经主人同意移动资金；绕过暂停 | 最高 10,000 USDC |
| 高 | 「只付一次」被破坏（重复付款）；离线提现被阻止 | 最高 2,500 USDC |
| 中 | Face ID 前显示的费用不对；争议/退款不匹配 | 最高 500 USDC |
| 低 | 泄露非机密的元数据 | 致谢 |

不在范围内的内容：见 SECURITY.md。安全港：按本政策善意开展的研究不会被追究法律责任。
CI 中的静态分析：Slither（高危即失败）、Echidna 额度属性测试、Foundry 测试、gitleaks —— `ci/contracts-security.yml`（移到 `.github/workflows/` 即可启用）。
外部审计：尚未进行（需要预算；候选：Cantina、Spearbit、Zellic、OpenZeppelin）。
