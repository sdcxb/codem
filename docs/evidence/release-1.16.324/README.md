# 1.16.324 发版真机验证（2026-10-18）

> 这一批只回答一件事：**发布出去的那个安装包（`Codem_1.16.324_x64-setup.exe`）装上以后，
> 搜索结果卡片显示的是不是真结果**。上一批（`docs/evidence/deepseek-web-200-2026-10-17/`）
> 记录的是缺陷现场与修复过程，这一批记录的是**发版产物的核对**。

## 1. 安装与版本

| 项 | 值 |
|---|---|
| 安装包 | `Codem_1.16.324_x64-setup.exe`（sha256 `979778cd8d9c9a816196e8e55f2bee7f059281aa3a98e212f272ded7e396f767`） |
| 安装方式 | 静默安装（`Start-Process <setup.exe> -ArgumentList '/S' -Wait`，exit 0） |
| 装好的可执行文件 | `%LOCALAPPDATA%\Codem\codem.exe`，`FileVersion/ProductVersion = 1.16.324`，时间戳 2026-10-18 00:20 |
| 运行时自读版本 | 渲染器里 `window.__TAURI__.app.getVersion()` → **1.16.324** |

## 2. 这一版实测了什么

在**装好的 1.16.324** 上（不是 dev server）：设置里真点击打开「网页搜索 / 网页抓取」→
新对话发一句"请真的调用工具"（让它用 `site:` 语法搜 DeepSeek 官方文档，再抓取一页）→ 展开工具卡片。

工具层（会话日志，`session-toolcalls.json`，5 次调用全部 `status=done`）：

| 工具 | 耗时 | 输出字符 |
|---|---|---|
| `web_search` × 4 | 285 / 386 / 344 / 347 ms | 8,775 / 30,154 / 12,776 / 13,510 |
| `web_fetch` × 1 | 152 ms | 6,519（正文 6,402 字） |

卡片层（DOM 计数）：

```
.websearch-head = 1      ← 专用卡片真的在
.websearch-item = 13     ← 结果条目数
.search-match-row = 0    ← 不再有"假的文件行"
.search-block   = 0      ← 不再走 grep 卡片
前两条链接 = https://api-docs.deepseek.com/zh-cn/guides/search/
            https://api-docs.deepseek.com/zh-cn/api/fetch/
```

截图 `search-card-on-release-build.png`：卡片头部写着 `Search: "site:api-docs.deepseek.com 网页搜索 抓取 guide"`，
每条结果有标题、可点击链接与摘要 —— 正是上一版看不到的部分。

**收尾**：两个付费开关已点回关闭，并复核真库（只读副本）`codem-deepseek-web-search="0"`、`codem-deepseek-web-fetch="0"`。

## 3. 更新链路

`node tools/release/verify-update-manifest.mjs --remote`：**7 项通过 / 0 问题** ——
平台键（`windows-x86_64-nsis` + `windows-x86_64`）、URL/签名与本地产物一致、key id 一致、签名验过、
**远端资产 sha256 与本地产物一致**、远端有 `latest.json`。
发布后 `gh release list` 显示 `v1.16.324` = **Latest**。

## 4. 文件

| 文件 | 是什么 |
|---|---|
| `search-card-on-release-build.png` | 发布版上的搜索结果卡片（专用卡片 + 13 条结果） |
| `session-toolcalls.json` | 这一轮 5 次工具调用的最终形态（args / status / result / metadata） |

截图 sha256：`522a2e91570d21b540bc42d7598ddc387e861c3e7181a5484749e290a91d0cad`。

复现方法（脚本在上一批的 `scripts/` 里）：CDP 起应用 → 设置面板真点击开两个开关 → 新对话发提示词 →
`Runtime.evaluate` 数 DOM → 关闭开关并只读复核落库。
