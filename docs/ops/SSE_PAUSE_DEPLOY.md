# SSE pause fix — deploy runbook (NOT deployed; owner approval required)
Gap: a legacy SSE session bound its engine at connect time, so pausing/disconnecting an AI did not stop an already-open session.
Fix: `server/kit/pause.mjs` `liveAgentEngine` re-reads pause/revoke on every spend call. Tests: `server/test/t934-sse-pause.test.mjs` (3 cases), `t934-security.test.mjs`.

Steps once approved:
1. On production host: snapshot current kit (`tar czf kit-backup-$(date +%s).tgz kit`), no deletion.
2. Copy `kit/pause.mjs` and the `liveAgentEngine` wiring in `kit/server.mjs` from tag `v0.1.0-build5`+.
3. `npm test` on host; restart service; verify: open SSE session → pause agent in app → `kipurse_pay` returns `agent_paused`.
4. Rollback: restore the tarball and restart.
No caps, keys, or config change.
