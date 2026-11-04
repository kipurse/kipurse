# $1 主网真机离线提现测试 —— 主人操作步骤（已准备，尚未花钱）
目的：证明在启付服务器全部关闭的情况下，主人只靠救援页面和 Base 主网就能把钱取出来。
花费：1 USDC 测试金额（会回到主人自己手里），加上 Base 网络费（几美分），由主人的钱包支付。

1. 主人（iPhone，启付 App）：记下当前钱包余额。从自己的 Base Account 往启付钱包充值正好 1 USDC（或使用现有余额）。
2. 主人：在 App 里打开「离线提现指南」，保存救援卡（链接只留在手机上，从不发送到服务器）。
3. 我（主人在旁观看）：临时停止公开 kit 和主网运行路由（在 VPS 上执行 `systemctl stop kipurse-main`），这一步要主人当场说「开始」；确认 https://pay.kipurse.com/mcp 已不再响应。
4. 主人：从保存的救援卡打开救援页面（静态页面，不需要我们的服务器），收款地址选自己的 Base Account，用 Base Account 签名（Face ID）。
5. 在 basescan.org 上核对：启付钱包发出一笔 executeBatch，USDC 转到主人地址，钱包余额为 0（或剩余金额）。
6. 我：重新启动 `kipurse-main`，检查健康状态（/mcp 返回 401，主人页面返回 200），App 重新连上。
7. 把交易哈希和时间记录到 ~/t968/PROGRESS.md 和 docs/security/ATTACK_PATHS.md（把离线提现标为「已在主网验证」）。
回滚：如果第 4 步失败，立即重启 kipurse-main；资金仍在钱包里（自托管，没有任何资金被移动）。
