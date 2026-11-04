# Kipurse（启付）

A self-custodial USDC wallet on Base that lets AI agents pay within limits you set, with Face ID approval on your iPhone.
一个在 Base 上的自托管 USDC 钱包：AI 只能在你设定的额度内付款，超额、新收款人都要你在 iPhone 上用 Face ID 批准。

## Use with an AI agent (MCP)
Remote MCP server: `https://pay.kipurse.com/mcp` (Streamable HTTP, OAuth). Setup for Cline and other MCP clients: [llms-install.md](llms-install.md).

## Layout
- `ios/` — iOS app (SwiftUI), widget, `KipurseCore` Swift package, unit and UI tests.
- `server/` — Kipurse production gateway (cleaned copy): owner API, AI agent MCP (OAuth), Siri endpoint, pause, caps, onboarding sponsor caps, rescue (offline withdraw) page, SDK. Operator values (addresses, keys, URLs) come from config outside the repo.
- `contracts/` — Solidity V5 contracts (trust, adapter, phone approver, vaults) with Foundry tests; `install-deps.sh` fetches pinned libs.
- `docs/compliance/` — compliance notes (not legal advice).

## Principles
- Self-custody only: keys stay in the iPhone Secure Enclave / the user's own smart wallet. No pooled custody.
- One wallet per person. The owner can always withdraw everything, even if the Kipurse server is down.
- Hard AI caps (default 20 payments/day, $2/day, $0.25 per payment). One "Pause AI payments" switch stops every AI, including Siri.
- Identity: Coinbase Verified attestation only. Funding: Coinbase / Coinbase Onramp only. Fees are in USDC, paid from the wallet.

## Build (iOS, simulator)
```sh
cd ios
cp Config/Local.xcconfig.example Config/Local.xcconfig   # optional; fill in your own team / bundle prefix
brew install xcodegen && xcodegen generate                # if the project needs regenerating
xcodebuild -project Kipurse.xcodeproj -scheme Kipurse -destination 'platform=iOS Simulator,name=iPhone 17' build
swift test            # KipurseCore unit tests
```

## Server
```sh
cd server && npm ci && npm test
```
Operator config lives OUTSIDE the repo (see `server/kit/operator.mjs`); `KIPURSE_DEMO=1` runs unbranded.
Configuration comes from environment variables; see `examples/` and `DEVELOPMENT_SETUP.md`. Never commit `.env` files or keys.

## License
Copyright © 2026 Blessbridge Global Trading LLC / Kipurse.

| Path | License |
|---|---|
| `contracts/` | Apache-2.0 |
| `ios/` | Apache-2.0 |
| `server/sdk/` and files with an Apache-2.0 SPDX header (MCP surface, exit kit, rescue page) | Apache-2.0 |
| `server/` (hosted gateway) | AGPL-3.0-only |

Why: wallets, contracts and SDKs are permissive so anyone can build on them; the hosted gateway is AGPL so improvements to a hosted fork come back to the community. See `LICENSE` and each directory's `LICENSE`. Security issues: `SECURITY.md`.
