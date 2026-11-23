# Kipurse（启付）

**English** · [中文](#中文)

Kipurse is a self-custodial USDC wallet on Base for people who let AI agents spend money. The AI can pay only inside limits you set; a new payee, a larger amount or a change of limits needs your Face ID on your iPhone. You can pause every agent with one switch and withdraw everything yourself, even if the Kipurse server is gone.

## Status (read this first)
- **Live on Base mainnet.** The hosted service at `pay.kipurse.com` and the iOS app run this code.
- **The smart contracts are NOT audited.** They have unit, fuzz, invariant and fork tests and internal reviews, but no third-party audit. Use small amounts.
- **Fees:** the hosted service charges 0.1% per payment, paid by the payer, plus the actual network cost in USDC (shown before you approve). Self-hosting this code is free; you pay only network costs to the chain.
- Known limitations are listed in [SECURITY.md](SECURITY.md).

## Layout
| Path | What |
|---|---|
| `ios/` | iOS app (SwiftUI), widget, `KipurseCore` Swift package (platform-neutral logic, runs on macOS/Linux), unit and UI tests |
| `server/` | Gateway: owner API, agent MCP server (OAuth), Siri endpoint, pause, limits, onboarding, signing pages, rescue kit, JS SDK (`server/sdk`) |
| `contracts/` | Solidity contracts (trust, adapter, vaults, phone approver, escrow, merchant registry) with Foundry tests |
| `testshop/` | A tiny test merchant (USDC orders on Base) used to exercise merchant flows |
| `docs/` | Extra docs (MCP client setup) |

## Build the iOS app
Requirements: Xcode 26+, [XcodeGen](https://github.com/yonaskolb/XcodeGen).
```sh
cd ios
cp Config/Local.xcconfig.example Config/Local.xcconfig   # your Apple team, bundle prefix, server, operator details (git-ignored)
xcodegen generate
xcodebuild -project Kipurse.xcodeproj -scheme Kipurse -destination 'generic/platform=iOS Simulator' build
swift test                                               # KipurseCore unit tests (no Xcode project needed)
```
Without `Local.xcconfig` the app builds for the simulator with neutral defaults (`org.example.kipurse`, no server).

## Run the server tests
Requirements: Node.js 24+.
```sh
cd server
npm ci
npm test
```
Configuration is read from environment variables (names in `server/.env.example`) and an operator config file outside the repo (`KIPURSE_OPERATOR_CONFIG`). `KIPURSE_DEMO=1` runs without operator branding. Never commit `.env` files or keys.

## Run the test shop tests
The test shop's tests use the gateway code as the client, so install the server dependencies first:
```sh
(cd server && npm ci) && cd testshop && npm ci && npm test
```

## Build the contracts
Requirements: [Foundry](https://book.getfoundry.sh/), git.
```sh
cd contracts
./install-deps.sh      # fetches the pinned dependencies into lib/
forge build
forge test
```

## License
Apache-2.0 for the iOS app, contracts, SDK and MCP surface; AGPL-3.0-only for the hosted gateway (`server/`). Details: [LICENSING.md](LICENSING.md). Third-party notices: [NOTICE](NOTICE). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 中文

启付是一个在 Base 上的自托管 USDC 钱包，给愿意让 AI 帮自己花钱的人用。AI 只能在你设定的额度内付款；遇到新收款人、超额或修改额度，都要你在 iPhone 上用 Face ID 批准。一个开关就能暂停所有 AI；即使启付服务器不在了，你也能自己把钱全部取出。

### 现状（请先看）
- **已在 Base 主网运行。** `pay.kipurse.com` 上的托管服务和 iOS App 用的就是这份代码。
- **智能合约没有经过第三方审计。** 有单元、模糊、不变量和分叉测试以及内部审查，但没有外部审计。请只放小额资金。
- **费用：** 托管服务每笔付款收 0.1%，由付款方承担，另加实际网络费（USDC，批准前显示）。自己部署这份代码免费，只需付链上网络费。
- 已知限制见 [SECURITY.md](SECURITY.md)。

### 目录
- `ios/`：iOS App、小组件、`KipurseCore` Swift 包和测试。
- `server/`：网关（主人 API、AI 的 MCP 服务、Siri、暂停、额度、开户、签名页、救援工具、JS SDK）。
- `contracts/`：Solidity 合约和 Foundry 测试。
- `testshop/`：测试用的小商店。
- `docs/`：其他文档。

### 构建
- iOS：`cd ios && cp Config/Local.xcconfig.example Config/Local.xcconfig && xcodegen generate`，然后用 Xcode 构建；`swift test` 跑核心单元测试。
- 服务器：`cd server && npm ci && npm test`（Node.js 24+）。环境变量名见 `server/.env.example`。
- 合约：`cd contracts && ./install-deps.sh && forge build && forge test`。

### 许可
iOS App、合约、SDK、MCP：Apache-2.0；托管网关（`server/`）：AGPL-3.0-only。详见 [LICENSING.md](LICENSING.md)。
