# SSE 暂停修复 —— 部署手册
问题：旧版 SSE 会话在连接时就绑定了 engine，所以主人暂停或断开某个 AI 后，已经打开的会话不会停止。
修复：`server/kit/pause.mjs` 中的 `liveAgentEngine` 在每次付款调用时都重新读取暂停/撤销状态。测试：`server/test/t934-sse-pause.test.mjs`（3 个用例）、`t934-security.test.mjs`。

批准后的步骤：
1. 在生产主机上：给当前 kit 做快照（`tar czf kit-backup-$(date +%s).tgz kit`），不删除任何文件。
2. 从 `v0.1.0-build5` 及之后的标签复制 `kit/pause.mjs` 以及 `kit/server.mjs` 中 `liveAgentEngine` 的接线。
3. 在主机上运行 `npm test`；重启服务；验证：打开 SSE 会话 → 在 App 里暂停该 AI → `kipurse_pay` 返回 `agent_paused`。
4. 回滚：恢复快照并重启。
不改额度、密钥或配置。
