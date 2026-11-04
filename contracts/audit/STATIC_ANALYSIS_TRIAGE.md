# Kipurse V5 static analysis: every finding triaged (2026-10-17)

These are development contracts and have NOT been audited. Tools were installed locally in a local tools directory:
- Slither 0.11.6 (Python venv `sa-env`)
- Aderyn 0.6.8 (npm `@cyfrin/aderyn`)

Scope is `src/` only, with lib/, test/ and script/ filtered out. Compiler: solc 0.8.37, via_ir.

Raw outputs:
- `evidence/static/slither.json`
- `evidence/static/aderyn-report.md`
- `evidence/static/slither-checklist.md` (first run)

## Result in one line
**No real vulnerability was found.**

| Run | Findings |
|---|---|
| Slither first run | 75 results |
| Slither after one fix | **72 results** (High 3, Medium 23, Low 39, Informational 7) |
| Aderyn | **4 High categories / 13 instances**, **13 Low categories / 42 instances** |

What changed because of the analysis:
- **One code change.** FeeController events now index their address parameters. This cleared Slither `unindexed-event-address` ×3.
- **One test addition.** A dedicated FeeController suite (5 tests, including a fuzz test). Coverage on that contract was 66.67% lines before it.
- **One new known issue (K-1)** from the manual review done alongside triage. See the end of this file.

Everything else is a false positive or an accepted design choice. Each case is explained below.

Verdict key:
- **FP**: false positive.
- **ACK**: accepted by design, with the reason given.
- **FIXED**: changed in code.

## Slither (72 after the fix)

| # | Detector | Impact | n | Verdict | Reasoning |
|---|---|---|---|---|---|
| 1 | reentrancy-balance | High | 3 | FP/ACK | `_pull` and `_settleNow` read a balance before `manager.spend` or `vault.pay`, then require exact equality afterwards. That check is deliberate: an exact-delivery guard that rejects fee-on-transfer tokens and short pulls. The calls go only to immutable trusted contracts (the SPM at a fixed address, the adapter-owned CREATE2 vault, USDC). Every value-moving adapter entry point is `nonReentrant` (paySigned, payDirect, prepareAuthorization, markSettled, collectFees, reclaim, cancelReservation, fundFloat, reconcileFloat). A reentrant call could only make the equality fail, which is a revert and therefore safe. |
| 2 | incorrect-equality | Medium | 9 | FP | 7 of these compare `Tier` enums, where strict equality is correct. 2 are the exact-delivery `==` balance checks from row 1; they are intentionally strict. 1 is the registry `m == merchant` bytes32 comparison. |
| 3 | reentrancy-no-eth | Medium | 4 | FP | State is written after a call to the factory (`deploy` / `deployFloat`) and `vault.close`. The factory is immutable and set by this adapter, and the CREATE2 address plus `adapter()` are verified right after deploy. `vault.close` is our own vault and only callable by the adapter. All four sites sit inside `nonReentrant` functions. |
| 4 | uninitialized-local | Medium | 6 | FP | `FloatVault.isValidSignature` declares the locals and assigns them in the `try` branch. The `catch` returns FAIL before they are read. |
| 5 | unused-return | Medium | 4 | ACK | Tuple elements that are not needed are ignored on purpose: the `trust.gate` partial reads, the `pauseFor` return (the until time is only emitted), and the third element of `ECDSA.tryRecover` (the error arg). The recover error itself IS checked. |
| 6 | timestamp | Low | 25 | ACK | Every time window (deadlines, expiries, timelocks, the daily index, the executor pause) needs `block.timestamp`. On Base the sequencer controls timestamps only within seconds, and all windows are minutes or longer. |
| 7 | missing-zero-check | Low | 6 | ACK | The vault constructors get `adapter = msg.sender` of the factory call, which is never zero. `account` is `p.account` of an SPM-valid permission, so it is never zero. The adapter verifies the CREATE2 address and `adapter()` right after deploy. A vault that a third party deploys through the factory gets a different address, because the adapter is part of the init code, so it is ignored. `FloatVault.open(key)`: the adapter rejects `sessionKey == 0` in `fundFloat`, and the vault also treats `sessionKey == 0` as FAIL. `Registry.proposeMaintainer(0)` is a harmless cancel, because acceptance requires `msg.sender == pending`. |
| 8 | reentrancy-benign | Low | 4 | FP | Same call graph as row 3. |
| 9 | calls-loop | Low | 2 | ACK | `markSettled` batches by design. Callers choose the batch size, and one bad digest is skipped, not reverted (but see K-1). |
| 10 | events-maths | Low | 2 | ACK | `PayerVault.reserved +=/-=` changes are already covered by the adapter's `AuthorizationPrepared` and `AuthorizationClosed` events. |
| 11 | costly-loop | Info | 2 | ACK | Storage writes in the `markSettled` batch. |
| 12 | missing-inheritance | Info | 1 | ACK | The adapter implements `IFloatGate.floatBlocked`. It does not inherit the interface, which saves bytes; the selector is tested. |
| 13 | naming-convention | Info | 2 | ACK | `DOMAIN_SEPARATOR()` is the standard EIP-2612/3009 name. |
| 14 | too-many-digits | Info | 2 | FP | The CREATE2 `0xff` prefix literal. |
| — | unindexed-event-address | Info | 3 | **FIXED** | `RecipientProposed`, `RecipientChanged` and `RecipientCancelled` now use `indexed`. |

## Aderyn (13 High instances, 42 Low instances)

| ID | Title | n | Verdict | Reasoning |
|---|---|---|---|---|
| H-1 | abi.encodePacked hash collision | 2 | FP | The CREATE2 address uses `encodePacked(bytes1, address, bytes32, bytes32)`. All arguments are fixed-size, so no collision is possible. |
| H-2 | State change after external call | 8 | FP | Same as Slither rows 1/3/8. All sites are `nonReentrant`, and the callees are immutable and trusted. |
| H-3 | Storage array edited with memory | 2 | FP | `_live(Binding memory, …)` is a VIEW that copies a struct to read it. Nothing is written. |
| H-4 | Unsafe integer cast | 1 | FP | `uint64(day)` and `uint64(a.validBefore)`. `validBefore` is bounded to `now + MAX_AUTH_WINDOW` (600 s) by the `Window` check, and `day` is far below 2^64. |
| L-1 | Costly ops in loop | 5 | ACK | Bounded loops: at most 16 payees/signers (`MAX_BINDINGS`, Trust 16), or a caller-chosen batch. |
| L-2 | Large numeric literal | 2 | ACK | `60_000` gas, `1_000_000` ppm. |
| L-3 | Literal instead of constant | 4 | ACK | The `0xff` CREATE2 prefix and `365 days`. |
| L-4 | Missing inheritance | 3 | ACK | Same as Slither row 12. |
| L-5 | PUSH0 opcode | 8 | ACK | Base supports PUSH0 (Shanghai/Cancun). The fork and Sepolia runs prove it. |
| L-6 | require in loop | 5 | ACK | Input validation; a whole-call revert is intended. |
| L-7 | State change without event | 2 | ACK | Same as Slither row 10. |
| L-8 | Address set without checks | 1 | ACK | Same as Slither row 7. |
| L-9 | Unchecked return | 1 | ACK | `pauseFor`; same as Slither row 5. |
| L-10 | Uninitialized local | 1 | FP | The loop index `i` starts at 0 by default. |
| L-11 | Unspecific pragma | 8 | ACK | The source pragma is `^0.8.28` and the build pins solc 0.8.37 in `foundry.toml`. The deploy runbook requires the pinned compiler and verified bytecode. |
| L-12 | Public not used internally | 1 | ACK | `lookupSigner` is an interface function. |
| L-13 | Unused state variable | 1 | FP | `REGISTRY_GAS` is used in every `{gas: REGISTRY_GAS}` registry call. Aderyn misses call options. |

## Manual-review note (raised while triaging)

**K-1 (Low, open, for the auditor).**

The problem:
- `markSettled` returns a late fee to `r.account` through `safeTransfer`.
- If USDC has blocklisted that account, the transfer reverts, and that digest can never be closed.
- Any batch containing it reverts. Other digests are unaffected if callers drop it from the batch.

The worst case is that one reservation's fee (at most 0.1% of one payment) stays in the adapter.

Possible fixes, to decide with the auditor:
- send that fee to `accruedFees` when the transfer fails (try/catch);
- or skip the digest.

This is NOT changed yet, because it alters fee-routing semantics. It is listed in `THREAT_MODEL.md`.


## Rerun after the zero-reserve changes (2026-10-17, evidence/static-zr/)

Scope is the same, and the code now includes the ERC-4337 vault, `registerPermission`, the transient lock, and the reserved-funds guard.

| Tool | Before (m12) | After (ZR) | Delta |
|---|---|---|---|
| Slither | 72 (H3 / M23 / L39 / I7) | **89 (H3 / M28 / L47 / I11)** | +17, all in the new vault / 4337 code |
| Aderyn | High 4 categories / 13 instances; Low 13 / 41 (counted by "Found in") | **High 4 / 16; Low 14 / 54** | H-2 +3, L-3 +9, L-6 +1, L-8 +1, L-10 +1, new L-11 ×1 |

**Manual review alongside the rerun found one real issue, now FIXED (T18 / I-25).**
- The problem: Circle's `transferFrom` ignores `reserved`, so the gas prefund could consume USDC that backs an open x402 reservation.
- The fix: the vault's permit path (`isValidSignature`) and approve path (`_exec`) now require `balanceOf(vault) ≥ reserved + value`.
- New test: `test_gasNeverTouchesReservedX402Funds`.
- The live Sepolia rerun used the fixed code, and the Pimlico bundler accepted every op under that code.

Other code changes from the rerun:
- `Session` event: the signer is now indexed. This clears `unindexed-event-address`. Slither only showed this after its stale `--json` output was deleted, because it refuses to overwrite the file.
- `adapter.trust()` is cached as the `TRUST` immutable. That removes one external call per userOp call (gas) and the `calls-loop` instance on it.

Triage of the new instances:

| Detector | n new | Verdict | Reasoning |
|---|---|---|---|
| Slither missing-zero-check (factory entryPoint/paymaster/paymaster2; vault account/adapter/t; setSession signer) | 7 | ACK / FP | paymaster2 = 0 means "none" by design. A zero paymaster never matches (`_isPaymaster` requires a != 0). A zero signer can never validate (`r != address(0)`). The vault's account/adapter come from the adapter via the factory, and a spoofed deploy lands at a different CREATE2 address (test_vault_factoryCannotBeSpoofed). |
| Slither unused-return (ECDSA.tryRecover 3rd value) | 2 | FP | The error enum and the address are both checked; the 3rd value is only the error argument. |
| Slither uninitialized-local (constructor `d`, `t`) | 2 | FP | Deliberate zero default when the try/catch fails (no DOMAIN_SEPARATOR / no trust()). |
| Slither reentrancy-no-eth (`_vault`, `fundFloat`) / reentrancy-events (`registerPermission`) | 2 | ACK | Callees are our own CREATE2 factory and the vault it just deployed; the transient lock is on value-moving paths. |
| Slither calls-loop (`_exec` in executeBatch: target.call, balanceOf) | 2 | ACK | The batch is EntryPoint-only and every target is allowlisted (adapter, trust, USDC approve to a paymaster). |
| Slither assembly / low-level-calls (`_exec` revert bubbling) | 2 | ACK | Standard revert-data bubbling. |
| Slither naming-convention (TOKEN_DOMAIN, TRUST immutables) | 2 | ACK | Style only. |
| Aderyn H-2 (state change after external call), lines 60/62/65 | 3 | FP | These are immutable assignments in the vault constructor after view calls to the factory, the adapter and USDC. A contract that is not yet deployed cannot be re-entered. |
| Aderyn L-3 literals (20, 68, 192, 4 ×) | 9 | ACK | ABI layout constants (address length, approve calldata length, minimum permit-signature length). |
| Aderyn L-6 require in loop (`executeBatch`) | 1 | ACK | Intended: the whole batch is atomic. |
| Aderyn L-8 (`setSession` signer) | 1 | ACK | Adapter-only; see missing-zero-check above. |
| Aderyn L-10 (constructor locals) | 1 | FP | As above. |
| Aderyn L-11 "unsafe ERC20 operation", line 100 | 1 | FP | This is `IERC20.approve.selector` used in a comparison; no ERC20 call is made there. |

**Verdict: no open vulnerability.** One real issue was found and fixed (T18), and every other new instance is FP or ACK as listed above.

## Round 2 rerun (2026-10-17 evening): clones, K-1 fix, packed counters, ops account
- **Slither** (json deleted first; `evidence/static-r2/`): **102 results** (was 89).
  - High 3 (reentrancy-balance, unchanged pre-existing FPs: the balance-delta checks around SPM.spend / vault.pay are intentional, and the targets are trusted).
  - Medium 29 (incorrect-equality 9, unused-return 8, uninitialized-local 7, reentrancy-no-eth 5).
  - Low 52 (timestamp 25, missing-zero-check 13, calls-loop 7, reentrancy-benign 4, events-maths 2, reentrancy-events 1).
  - Informational 18.
- **Deltas vs ZR**: +2 assembly / +2 low-level-calls (ops CREATE2, the `_try` refund transfer), +2 costly-loop, +3 naming (immutables), +3 calls-loop, +2 missing-zero-check, +2 unused-return (ops `tryRecover` tuple; the error is checked), -2 too-many-digits, -1 uninitialized-local.
- **Only new semantic item**: reentrancy-no-eth in `markSettled` via `_refundFee`. `accruedFees` is written after a low-level USDC transfer. The function is `nonReentrant` and the token is USDC → FP.
- **Aderyn**: High 3 issues / **18 instances**.
  - H-1 reentrancy 12: same pattern as before (trusted SPM/USDC/own-vault calls, nonReentrant).
  - H-2 storage-array-with-memory 2: registry view, pre-existing FP.
  - H-3 unsafe-cast 4: `_release` uint64 downcasts bounded by `_charge`, and reservation `validBefore` <= now + 600. K-10.
- **Aderyn Low**: 14 issues / **78 instances** (was 54). Mostly literal-instead-of-constant 24, pragma 9, PUSH0 9, plus the new ops-account instances.
  - L-14 "unused" REGISTRY_GAS is an FP (used in call options).
  - L-11 unsafe ERC20 at vault/ops `_exec` lines are decode-only (the calls are forwarded with return checks), plus `_try` (return checked).
- **No new true positive.** K-1 is closed.
