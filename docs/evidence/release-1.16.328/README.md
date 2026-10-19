# Release 1.16.328 真机取证

日期：2026-10-19
构建：`Codem_1.16.328_x64-setup.exe`（本地 `tauri build` + 签名）→ 静默安装（bash 里用 `//S`）→ 启动
驱动：WebView2 CDP。

## 1. 版本

`window.__TAURI__.app.getVersion()` → **1.16.328**。

## 2. 本版改动的验证方式

本版是上下文策略改动，无法用"点几下"复现 200% 级长会话，验证分三层：

1. **判据 + 变异**：`RAWCTX-1..4`、`STAB-1..6`、`HEADROOM-1..3`、`FOLD-LONGTURN-1..7`；
   变异波次 `raw-context-metric`（3）、`water-banner-stability`（4）、`compaction-headroom`（3）、
   `fold-long-turn`（5）全部对红。
2. **真实日志模拟**（用户提供的两台电脑会话日志，CJK 感知的 `estimateTokens`）：
   - 会话 A：原始 284,453 token（0.9×128K 预算的 247%）→ 新折叠后 86%；
   - 会话 B：原始 252,901 token（220%）→ 新折叠后 137%（剩余大头是正文与 `write` 参数，折叠不能动）。
   两例在 70% 处都会交给自动压缩，压完保留 40% ⇒ 留 30% 余量。
3. **配置落地**：本机 `getVersion()` 与 `latest.json` 校验（本地 5 项 / 远端 7 项）。

## 3. 发布链路

- `gh release list`：`v1.16.328 = Latest`，5 个资产齐全；
- `verify-update-manifest --remote`：7 项通过（远端资产 sha256 与本地一致）。

## 4. 局限（如实）

- 没有在真实 200% 会话上做端到端重放；阈值/保留比例来自日志测算 + 判据。
- 提示条阈值、折叠与压缩的交互由判据覆盖；真机只核了版本与安装。
