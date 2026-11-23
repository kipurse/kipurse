# Kipurse gateway: scaling path

Today: one free Oracle VPS, one Node process, file/SQLite storage. The code keeps clean seams so that growth means adding
machines and managed services, not rewriting. Build only what we run; this file documents the next steps.

## Seams in the code (already in place)
| Concern | Interface (file) | Today | Later |
|---|---|---|---|
| Short-lived values: challenges, rate-limit windows, revocation feed | `KV` in `src/v5/store.mjs` (`put/get/take/del/incr/list`) | SQLite `data/kv.sqlite` (WAL) | Redis (`SET PX`, `GETDEL`, `INCR`+`PEXPIRE`) |
| Per-user document state | `TenantState` in `src/v5/store.mjs` (`load/save` by tenant) | JSON file per tenant (legacy `runtime-state.json` for the first wallet) | Postgres, table partitioned by `hash(tenant)` |
| Payment ledger + idempotency | `src/v5/ledger*.mjs` (SQLite: `purchases`, `idempotency`, `claims` with lease) | local SQLite | Postgres (same tables, `tenant` column, partitioned) |
| Chain access | `src/v5/rpc.mjs` `rpcTransport(list)` + `createReadCache` | `KIPURSE_RPC_URLS` or `engine.rpcUrls` (fallback in order) | paid providers first, public last |
| Observability | `src/v5/obs.mjs` | JSON log lines (allow-listed fields, no PII), `/metrics` (Prometheus text), `/healthz` (local only) | scrape + alert |
| Backpressure | `obs.wrap` | `KIPURSE_MAX_INFLIGHT` (default 200) -> 503 + Retry-After | per-worker, behind a load balancer |

Key scheme: `<scope>:<tenant|global>:<name>`, tenant = lowercase wallet address. Everything per-user is keyed by tenant, so it
shards by the tenant part. Hot paths never scan across tenants (the only `list()` is the small global revocation feed).

## Rules for new code
- No process-memory state that matters across requests: put it in `KV` (expiring) or `TenantState` / the ledger (durable).
- Payments are idempotent: `Idempotency-Key` + `claims` lease rows; a worker that dies leaves a lease that expires and is retried.
- Logs: only allow-listed fields (`event, route, status, ms, part, count, reason, kind, instance, release`); never addresses, tokens, IPs.
- Knobs are env vars: `KIPURSE_RPC_URLS`, `KIPURSE_MAX_INFLIGHT`, `KIPURSE_REVOKE_POLL_MS`, `KIPURSE_INSTANCE`.

## Stage 1 (now): 1 VPS
One process. Scale up by giving the VM more CPU/RAM. Measured on the fork staging: ~950 req/s, p95 216 ms (2 workers in one process, mixed routes).

## Stage 2: N stateless workers + Postgres + Redis
1. Implement `KV` on Redis and `TenantState`/ledger on Postgres (same method names; swap by config).
2. Run N workers behind a load balancer (Cloudflare tunnel -> LB). Revocations reach every worker via the KV feed (`KIPURSE_REVOKE_POLL_MS`).
3. On-chain submission: the legacy executor path serializes nonces per process (`chain.mjs` lock) -> keep ONE submitter (a queue consumer)
   or use the userop/bundler path (nonce per wallet). Payment jobs = durable rows (`claims` lease) so any worker can pick them up.
4. Paid RPC providers in `KIPURSE_RPC_URLS`, public RPC as last fallback.

## Stage 3: sharded (100M+ users)
- Postgres partitioned / sharded by `hash(tenant)`; Redis cluster (keys already carry the tenant part).
- A shard map service maps tenant -> shard; workers stay stateless.
- Chain reads: per-tenant cache + event indexer instead of per-request reads; webhooks / streams instead of polling.
- Per-user and global rate limits in Redis (`createRateLimiter`), plus per-tenant fees already settled on chain per payment.

## Still single-tenant (open work)
The current mainnet deployment serves ONE wallet (`X.wallet` from operator config). The multi-user step (tenant resolution per
request, owner migration to `TenantState`, wallet discovery at onboarding, cross-tenant tests) is the next change and builds on these seams.
