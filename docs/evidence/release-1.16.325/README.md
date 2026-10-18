# Release 1.16.325 真机取证

日期：2026-10-18
构建：`Codem_1.16.325_x64-setup.exe`（本地 `tauri build`，签名 420 字节）静默安装
驱动：WebView2 CDP（`--remote-debugging-port=9222`）

## 1. 版本

`window.__TAURI__.app.getVersion()` → **1.16.325**（与安装包、`latest.json` 一致）。

## 2. 自定义 Provider 的「添加」并入规范保存（本版代码改动）

`custom-provider-saved.png`

| 步骤 | 结果 |
|---|---|
| 设置 → 通用 → 添加自定义 Provider | 表单出现（名称 / Base URL / API Key） |
| 填 `verify-custom` + `https://verify.invalid/v1` → 「保存 Provider」 | 表单收起，列表出现该 Provider 卡片（名称 + Base URL 回填） |
| 关闭设置 → 重新打开 | 卡片仍在（**证明走的是落库保存**，不是只改了内存） |
| 删除该 Provider | 卡片消失（验证后已清理，未污染用户配置） |

这一步对应的判据是 `CUSTPROV-1..4`（纯逻辑 + 源码级控制流），变异波次
`custom-provider-unified-save`（不传新列表 / 未确认也收起 ⇒ 各自对红）。

## 3. 发布链路

- `latest.json`：平台键 `windows-x86_64-nsis` + `windows-x86_64`；本地 `verify-update-manifest` 5 项通过；
  `--remote` 7 项通过（远端资产 sha256 与本地产物一致）。
- `gh release list`：`v1.16.325 = Latest`，5 个资产齐全。

## 4. 局限

- 本轮没有重跑 12 个真实仓库修复任务的对标批（沿用上一版结论：本版 10 / 参考实现 9）。
- 提示音未在真机听音（默认关闭）；View Transitions 的动画本身取决于 WebView2 内核版本，
  不支持时按判据 `VIEWTRANS-1..3` 的降级路径走。
