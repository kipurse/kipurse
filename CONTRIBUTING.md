# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Contributor License Agreement (required)
Before a pull request can be merged you must agree to the [Kipurse Individual Contributor License Agreement](CLA.md) (CLA). In short: you keep the copyright to your contribution, and you grant the copyright holder of the project a perpetual, worldwide, royalty-free license to use, modify, sublicense and distribute it under any license, including commercial licenses (for example a commercial license for the AGPL gateway) and distributing the iOS app through Apple's App Store (whose terms are not compatible with some open-source licenses). The open-source project keeps your contribution under the license of the directory it went into. You also confirm that you have the right to make the contribution.

To agree, post the sentence from the "How to agree" section of [CLA.md](CLA.md) on your pull request. A pull request is merged only after that. Contributions on behalf of a company need a corporate agreement: open an issue first.

## Ground rules
- Self-custody is non-negotiable: no change may let Kipurse (or any server) hold user funds or keys, or spend beyond the owner's limits without the owner's approval.
- Keep secrets and personal data out of the repository: no keys, `.env` files, real wallet addresses of real people, device ids or production data. Use synthetic test data.
- Security problems: do not open a public issue; see [SECURITY.md](SECURITY.md).

## Before you open a pull request
- iOS core: `cd ios && swift test`
- Server: `cd server && npm ci && npm test`
- Contracts: `cd contracts && ./install-deps.sh && forge test`
- Keep user-facing text bilingual (Chinese and English) where the surrounding code is.
- Repository guards (also run in CI and by the pre-push hook from `sh scripts/install-pre-push.sh`): `node scripts/guard.mjs`
  (unknown wallet addresses, hashed private denylist, SPDX headers on new files, no references to private add-ons) and
  `gitleaks detect --no-git -c .gitleaks.toml`.
- New source files start with an `SPDX-License-Identifier` line (see [LICENSING.md](LICENSING.md)). Test addresses must be
  synthetic (e.g. `0x1111…1111`); a public contract address goes into `public-addresses.txt` with a reason.

By contributing you agree that your contribution is licensed under the license of the directory it goes into (see [LICENSING.md](LICENSING.md)) and under the [CLA](CLA.md).
