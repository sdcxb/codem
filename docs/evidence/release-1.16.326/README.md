# Release 1.16.326 真机取证

日期：2026-10-18
构建：`Codem_1.16.326_x64-setup.exe`（本地 `tauri build`，签名 420 字节）→ 静默安装 → 启动
驱动：WebView2 CDP。模型：deepseek-flash（用户现有配置）。

## 1. 版本与安装

- 静默安装：`./Codem_1.16.326_x64-setup.exe //S` → exit 0，`%LOCALAPPDATA%\Codem\codem.exe` 更新为本次构建。
  ⚠️ 在 bash 里必须写 `//S`（MSYS 会把单个 `/S` 当路径转换，安装器会卡住不返回——这是本轮排查出的环境坑，不是安装包问题）。
- `window.__TAURI__.app.getVersion()` → **1.16.326**。

## 2. 沙箱允许目录：可见、可移除（设置 → 通用）

`settings-allowlist.jpg`

| 步骤 | 结果 |
|---|---|
| 设置 → 通用（沙箱模式下方） | 「沙箱允许目录（工作区外额外放行）」一节出现 |
| 列表内容 | `C:/mimo-gui/docs`（交接时加入的测试目录） |
| 点「移除」 | 列表清空；`settings.get_all` 里 `codem-sandbox-allowed-dirs` 回到 `[]` |

测试期间加入的示例目录已清理，未污染用户环境。

## 3. 交接行为

同日在同一构建上核过（详见 `docs/evidence/handoff-new-session-2026-10-18/`）：

- 源会话调用 `handoff_to_new_session` → 新建会话 `交接会话 · 10-18 11:15`（与 11:02 那次可区分），老会话未被触碰；
- 交接正文含 `C:/mimo-gui/docs/ui-spec.md` → 提示条出现 → 「加入允许目录」→ 同一会话 `read` 成功，
  第一行与磁盘逐字一致（`# Codem UI 规格（唯一口径）`）。

## 4. 发布链路

- `latest.json`：本地 5 项通过；`--remote` **7 项**通过（远端资产 sha256 与本地产物一致）。
- `gh release list`：`v1.16.326 = Latest`，5 个资产齐全。

## 5. 局限

- 本轮未重跑 12 个仓库任务对标批（沿用上一版结论：本版 10 / 参考实现 9）。
- `run_code` 的 `sdk.read` 未单独真机重试（与 `read` 共用同一条闸门）；提示音/转场等 UI 细节不在本版改动范围。
