# Kipurse attack-path review (2026-11-03)

Scope: iOS app (KipurseCore + App), Kipurse server (gateway / kit), V5 contracts. Verified on simulator and test fixtures only — no mainnet, no real funds.

Legend: ✅ mitigated with tests · ⚠️ mitigated with gaps · ❌ missing

## 1. Malicious AI agent
| Attack | Mitigation | Evidence | Status |
|---|---|---|---|
| Overspending within limits | On-chain SpendPermission cap + per-AI limits + server anomaly auto-pause (>30 payments / 10 min, >200 / day, >8 new payees / day) | gateway `siri-allowance-t899`, `t934-security` | ✅ (max loss = the limit the user set) |
| Paying a new address it controls | New payee → `ask_owner` → phone Face ID; the app recomputes what it signs on the phone (OwnerPay.toSign) and refuses if payee/amount/wallet/chain/deadline is wrong | `t934-security` "new payee"; iOS `T934SecurityTests.testPhoneRefusesSwapped…` | ✅ |
| Paying after pause (old connection) | **Gap found**: legacy SSE sessions on the kit server bound the engine at connect time, so after the owner paused/disconnected the AI an open SSE session could still call payment tools | Fix: `kit/pause.mjs liveAgentEngine` re-checks pause/revoke on every call; test `server/test/t934-security.test.mjs` | ⚠️ Fixed with tests in the open-source repo `server/` (cleaned production gateway), test `server/test/t934-sse-pause.test.mjs`; **not deployed to the production server** |
| Reading someone else's wallet | Per-user routing + 13-case OAuth cross-tenant attack matrix (existing) | THREAT_MODEL.md | ✅ (existing tests; production fork tests not rerun this round) |

## 2. Replay
| Attack | Mitigation | Evidence | Status |
|---|---|---|---|
| Replaying an old approval signature | EIP-712 OwnerApproval includes purchaseKey + deadline; the phone only signs deadlines 10 s – 1 h out; on-chain nonce/purchaseKey single-use | iOS `testPhoneRefuses…` (expired, wrongChain) | ✅ |
| Cross-chain replay | Domain bound to chainId 8453 + adapter address; phone refuses chainId ≠ 8453 | Same | ✅ |
| Charging the same order twice | idempotencyKey required (rejected if missing) | Existing gateway tests | ✅ |

## 3. Phishing payees
| Attack | Mitigation | Status |
|---|---|---|
| Look-alike address (same first/last characters) | New payees require Face ID; approval screen shows the full grouped address; own addresses abbreviated, unknown ones shown in full | ⚠️ The user may still not read carefully at Face ID; suggest a "similar to an address you paid before" warning (not done) |
| Tampered server swaps the payee | The phone recomputes the digest and refuses if it differs from the server's (digestMismatch) | ✅ |
| Known scam addresses | Sanctions/scam list screening (server side) | ⚠️ Relies on an honest server; list updates not verified this round |

## 4. Prompt injection
| Attack | Mitigation | Status |
|---|---|---|
| Web page / email tells the AI to "send money to X" | AI can only pay known payees within limits; new payees and over-limit need owner Face ID; Siri cannot pick a new address itself | ✅ (losses bounded by the limit by design) |
| Injection makes the AI raise its own limit | Limit changes are owner drafts that need a Face ID signature; a paused AI calling setLimits is refused | ✅ `kit-pause`, `t934-security` |
| Injection makes the AI start a withdrawal | Withdrawals only go to the owner's own Coinbase wallet; the batch is rebuilt and checked on the phone (RequestVerify / OwnerExit) | ✅ |
| AI fakes "paid" in its answer | The app shows only statuses the server confirmed on-chain | ⚠️ Relies on the server; no independent on-chain check |

## 5. Stolen, unlocked phone
| Attack | Mitigation | Status |
|---|---|---|
| Open the app and pay | New payees, over-limit and resuming from pause need Face ID (Secure Enclave, non-exportable) | ✅ |
| Use Siri to pay known payees within limits | **By design**: known payees within limits need no Face ID → a thief can spend at most Siri's remaining daily limit | ⚠️ Known risk, controlled by low limits; keep the default Siri limit very low |
| See the balance | The balance eye needs no Face ID (owner rule), hidden on cold start | ⚠️ Known trade-off |
| Remote stop | Confirm in the Coinbase account to pause AI, cancel pending payments and withdraw everything (no phone needed) | ✅ Design; **not verified on device** |
| Siri skips confirmation while paused | **Gap found**: `SiriSkip.inside` ignored pause state, so while paused it could still decide "within limit, pay directly" (the server would refuse, but the phone should not decide that) | ✅ Fixed (SiriAgent.swift), covered by iOS tests |

## 6. Server down
- Design: the open-source "offline withdraw" page + Base Account signature, without Kipurse servers.
- This round: on the simulator, the server URL was set to `https://kipurse.invalid` (truly unreachable) and the T820 outage drill was run; results in PROGRESS / the report.
- End-to-end withdrawal on a real device with real money is **not verified** (needs the owner's own signature).

## 7. Setup network-fee caps
- Production gateway `onboard-sponsor.mjs` (setup network fee) defaults: 20 per day, $2 per day, $0.25 per transaction; new test `t934-caps.test.mjs` pins these three numbers and edges (19 → ok, 20 → stop; $1.99 → ok, $2 → stop; single tx over $0.25 → refused).
- Gap: environment variables can raise the caps; there is no hard "never above X" ceiling; suggest a startup assertion (not changed, owner decision).

## Top gaps
1. SSE pause bypass: fixed in the open-source repo, not deployed to production.
2. `server/` is now the cleaned production gateway; 8 frozen-vector tests that depend on operator addresses / App Attest samples are marked skip in the open-source copy.
3. No external security audit.
4. Look-alike address warning not done.
5. Setup network-fee caps can be raised by environment variables; no hard ceiling.
6. All real-device items need the owner in person (see report).
