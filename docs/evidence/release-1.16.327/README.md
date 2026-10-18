# Release 1.16.327 真机取证

日期：2026-10-18
构建：`Codem_1.16.327_x64-setup.exe`（本地 `tauri build`，签名 420 字节）→ 静默安装（bash 里用 `//S`）→ 启动
驱动：WebView2 CDP。

## 1. 版本

`window.__TAURI__.app.getVersion()` → **1.16.327**。

## 2. 记忆审批面板（`memory-approval-panel.jpg`）

- 「写入审批」三档可见：平台 = 需批准、项目 = 需批准、对话 = 直接生效（默认值）。
- 顶部提示「其它项目还有 2 条待批准」——本机那 2 条 pending 属于别的项目作用域，当前作用域没有待批准，
  所以待批准区（以及新增的「以后不再逐条批准」按钮）**这一次没有出现**；不伪造截图。
- 真机点了「项目：需批准」这一档（与新增按钮走**同一** `handleToggleApproval("project")` 路径）：
  存储里的 `memory-write-approval` 从 `{"platform":true,"project":true,...}` 变为
  `{"platform":true,"project":false,...}`；随后又点了一次**恢复默认**，没有留下改动。

## 3. 发布链路

- `latest.json`：本地 5 项通过；`--remote` **7 项**通过（远端资产 sha256 与本地产物一致）。
- `gh release list`：`v1.16.327 = Latest`，5 个资产齐全。

## 4. 局限

- 待批准区的新按钮需要**当前作用域有 pending** 才会渲染（`approval.project && pending.length > 0`），
  本机当前作用域为 0 条，所以只验证了同一路径的开关（上面的写入审批档位）。
- 原生确认框无法用 CDP 点击；按钮自身的判据 `MEM-QUICK-1..3` 与变异波次 `memory-quick-toggle` 覆盖逻辑。
- 未重跑 12 个仓库任务对标批（沿用上一版 10 / 参考 9）。
