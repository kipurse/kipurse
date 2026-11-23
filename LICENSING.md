# Licensing

Kipurse is licensed per component. Each directory carries its own `LICENSE`; files with an `SPDX-License-Identifier` header follow that header.

| Path | License |
|---|---|
| `ios/` (iOS app, widget, `KipurseCore`) | Apache-2.0 (`ios/LICENSE`) |
| `contracts/` (`src/`, `test/`, `script/`) | Apache-2.0 (`contracts/LICENSE`) |
| `contracts/shim/oz4/` | MIT (two OpenZeppelin 4.x files, see headers) |
| `server/sdk/` (JS/TS SDK) | Apache-2.0 (`server/sdk/LICENSE`) |
| `server/` files with an Apache-2.0 SPDX header: `src/v4/mcp.mjs`, `src/v5/mcp.mjs`, `src/v5/abi.mjs`, `src/v5/plan.mjs`, `src/v5/plan51.mjs`, `src/v5/ref.mjs`, `src/v5/remote-engine.mjs`, `src/v5/usdc-out.mjs`; owner rescue kit `kit/rescue/src/` | Apache-2.0 (see the note below) |
| `server/` (hosted gateway, everything else) | AGPL-3.0-only (`server/LICENSE`) |
| `testshop/` | AGPL-3.0-only (`testshop/LICENSE`) |
| `docs/`, root documents | Apache-2.0 |
| Vendored third-party code and data | their own licenses, listed in [NOTICE](NOTICE) |

Full texts: `server/LICENSES/Apache-2.0.txt`, `server/LICENSES/AGPL-3.0.txt`.

**Note on mixed files in `server/`:** an Apache-2.0 file stays Apache-2.0 on its own, but some of them import AGPL-3.0 modules
(for example `src/v5/mcp.mjs` imports `buy.mjs`, `guardrails.mjs` and `owner-ask.mjs`; `src/v5/plan51.mjs` imports `ops.mjs`).
A program that runs them together with those modules is a combined work under AGPL-3.0. To use them under Apache-2.0 alone,
replace the AGPL imports with your own code.

**Third-party data:** `server/src/v5/data/` includes data under its own license (see [NOTICE](NOTICE)); for example the ScamSniffer
list is GPL-3.0. The Contributor License Agreement cannot relicense third-party material: any other license of the gateway must
leave such data out or follow its license.

## Commercial licenses

The copyright holder of Kipurse, Blessbridge Global Trading LLC (and its successors and assigns), may also offer the code under other terms, including commercial licenses (for example, for companies
that want to run a modified gateway without the AGPL-3.0 obligations). This is possible because every outside contribution is made
under the [Contributor License Agreement](CLA.md). Such licenses do not change the open-source licenses above: the code in this
repository stays available under them. To ask, open an issue titled "Commercial license".

Why the split: the wallet app, contracts and SDKs are permissive so anyone can build on them; the hosted gateway is AGPL so improvements to a hosted fork come back to everyone.

