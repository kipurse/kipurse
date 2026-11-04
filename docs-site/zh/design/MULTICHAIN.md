# 多链 / 多稳定币设计（仅设计）
目标：在更多 EVM 链和稳定币上沿用同样的自托管 + 链上额度模式，不做资金池，也不提高额度。

## 抽象层
- `ChainAdapter {chainId, name, rpc, explorer, usdc, spendPermissionManager, entryPoint, paymaster?, l1FeeOracle?, sequencerFeed?}` ——
  目前硬编码在 `server/kit/rescue/src/plan.mjs CHAINS` 和 `server/src/v5/chain.mjs` 里；改为一个 `chains.json` 注册表，由服务器、救援页面和 iOS（`Mainnet.swift`）共同读取。
- `TokenAdapter {address, decimals, symbol, permitStyle: 'eip2612'|'eip3009'|'none'}` —— 先做 USDC（只用 Circle 原生 USDC，绝不用跨链桥版本），再做 EURC。
- 额度按钱包、按链分别设置，以代币最小单位计；App 显示合并视图，但每条链在链上各自执行自己的额度。
- 费用报价：`quoteNetworkFee` 改为可按链插拔（Base/Optimism 用 OP-stack L1 预言机，Arbitrum 用 ArbGasInfo）。

## 顺序
1. Base Sepolia（已完成）→ Optimism Sepolia → Arbitrum Sepolia：在测试网部署 V5 合约，每条链运行现有 Foundry + 端到端测试。
2. 每条链的主网部署由主人决定（gas 花费，确认 CDP/Base Account 是否支持）。
3. 离线提现：救援页面读取 `chains.json`；每条链一张救援卡。

## 风险
Spend Permission Manager / Base Account 在各链上的可用性不同；Coinbase Verified 证明只在 Base 上有（KYC 门槛仍然只在 Base）。
