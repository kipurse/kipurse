# Architecture layers: core, operator, private add-ons

Kipurse separates three things so that the open-source core never names who runs it and never contains anyone's real wallet.

| Layer | Where | What it may contain |
|---|---|---|
| **Core** (this repository) | `ios/`, `contracts/`, `server/src/`, `server/kit/`, `server/owner-sign/`, `server/sdk/` | Protocol logic, public protocol constants (USDC, EntryPoint, the deployed Kipurse contracts, see `public-addresses.txt`), synthetic test data. No operator names, no keys, no real user data. |
| **Operator** (outside the repository) | an `operator.json` (kit) and `mainnet-trustflow.config.json` (hosted gateway), plus key files | Who runs the gateway: legal and display name, public URLs, account ids, key **file paths**, the official fee address and the paymaster addresses the ledger labels. |
| **Private add-ons** (separate private repositories) | e.g. paid features of the app | Code that is only **added** on top of the core. The core never imports it (`scripts/check-no-pro.mjs` enforces this). |

User data lives only in the gateway's data directory (outside the code tree; the hosted launcher refuses to start otherwise), in encrypted backups and on the user's phone. It never belongs in any repository.

## Operator config for the local kit (`server/kit/operator.mjs`)

- Copy [`server/config/operator.example.json`](../server/config/operator.example.json) to a path **outside** the repository, fill it in and set `KIPURSE_OPERATOR_CONFIG=/that/path` (or use the per-OS default: `~/Library/Application Support/Kipurse/operator/operator.json` on macOS, `$XDG_CONFIG_HOME/kipurse-operator/operator.json` elsewhere).
- [`server/config/operator.schema.json`](../server/config/operator.schema.json) documents the fields; `validateOperator()` in `kit/operator.mjs` is the authoritative check. Secrets are never inline: only absolute paths to key files.
- Without a config the kit refuses to start, unless `KIPURSE_DEMO=1` (an unbranded local demo with no onramp key and no public URL). The tests run in that mode.

## Operator constants for the hosted gateway (`server/mainnet/mainnet-owner-launch.mjs`)

The official fee address and the paymaster addresses are operator values. The launcher reads them from the `operatorConstants` key of its `mainnet-trustflow.config.json` (in `KIPURSE_MAIN_CONFIG_DIR`, outside the code tree):

```json
{
  "operatorConstants": {
    "feeTo": "0x<the operator's fee address>",
    "paymasters": ["0x<paymaster used for wallet operations>"],
    "ownerPaymasters": ["0x<paymaster used for the owner's own operations>"]
  }
}
```

The open-source launcher has no built-in values: if `operatorConstants.feeTo` is missing or not an address, it refuses to start (`src/v5/operator-constants.mjs`). `KIPURSE_WITHDRAW_FEE_TO` still overrides the fee address for withdrawals (`off` disables that fee).

**iOS app:** the app does not read operator config yet. The hosted service's signing / API hosts (`SignHost.swift`), official fee address and paymaster checks (`OwnerExit.swift`, `RequestVerify.swift`, `UsdcGas.swift`) are compiled in; a self-hosted fork must change them and build its own app.

Note: some deployed contracts and the phone check a fee recipient as part of the protocol (for example the account-opening dues slot and the wallet-paid network fee). Those values are part of the deployed contract suite and are listed in `public-addresses.txt`.

## Guards

`node scripts/guard.mjs` (CI: `.github/workflows/guard.yml`; locally: `sh scripts/install-pre-push.sh`) fails on any unknown wallet address, any hashed private-denylist hit, a new source file without an SPDX header, or a reference to private add-on code. gitleaks runs in the same workflow and hook.
