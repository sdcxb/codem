# DeepSeek Search / Fetch：HTTP 200 成功路径真机取证（2026-10-17）

> 对应 `docs/HANDOVER-2026-10-17.md` §9 第 1 项：「能力已实现、端点为真（无效 Key 返 401/225ms），
> 但开发机的 Key 是**封存**形态，探针拿不到明文 ⇒ 200 成功路径缺真机证据」。
> 本目录就是这一项闭环的证据：**两次真机、两次构建**，都是应用自己的工具链路，
> 记录到 status / 耗时 / 响应体大小 / 结果条数 / 正文长度。

## 1. 结论（可核对的最小事实集）

| 事实 | 值 | 出处 |
|---|---|---|
| `POST /v1/tools/search` 成功 | **HTTP 200**，347 / 352 / 290 ms，响应体 14,593 / 32,148 / 9,555… 字符 | `probe-http.json` runs[].records |
| `POST /v1/tools/fetch` 成功 | **HTTP 200**，855 / 213 / 216 / 128 ms，`content` 6,402 字 | 同上 |
| 工具层状态 | `web_search` / `web_fetch` 全部 `status=done`，`source` 分别为 `DeepSeek Search` / `DeepSeek Fetch` | `session-toolcalls-run*.json` |
| 计费口径相关的"空结果" | 未出现（三次 search 都非空：5 / 10 / 5 条） | 同上 |
| 设置条数语义 | 模型不指定 ⇒ 用设置缺省 10；模型显式指定 ⇒ 以模型为准（5） | run2 的两次 search |
| 模型可见输出 | search：`[Search source: DeepSeek Search]` + 每条含 `Summary`/`站点`/`日期`/`权威度`/`相关度`；fetch：`Length: 6402 字` | `session-toolcalls-run*.json`、`after-fetch-card-length.png` |

**为什么这一条以前拿不到**：开发机的 `providers[deepseek].apiKey` 落盘是 `dsh1:…` 密文（529 字符，明文 `apiKey` 为空串）。
在渲染器里直接读库拿到的也是密文，用它打官方接口只会得到 401（上一份 `deepseek-live-probe.log` 就是这个结论）。
这次改变的是**取证位置**：不再在库外拼请求，而是让**应用自己**读设置层水合后的明文去调工具 ——
所以既不需要明文暴露，也不存在"探针自己拼错了地址"的可能。

## 2. 怎么做的（可复现）

前置：本机安装版 `%LOCALAPPDATA%\Codem\codem.exe`；**不存在明文 Key**。

1. **起应用并开 CDP**
   `scripts/_launch-cdp.ps1`（设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 后启动）。
2. **注入网络探针**（`scripts/_probe-install.js`，用 `.preview-shot/cdp.mjs @<file>` 求值）：
   包一层 `window.fetch`，只记录 URL 含 `/v1/tools/` 的请求 → `status / ms / 响应体字符数 / results 条数 / content 字数`。只记录、不改请求。
3. **在设置面板里真点击打开两个开关**（`设置 → 通用 → DeepSeek`，选择器
   `button.toggle-entry[aria-label="网页搜索（DeepSeek Search）"]` / `…"网页抓取（DeepSeek Fetch）"`）：
   CDP 派发**真实鼠标事件**（`elementFromPoint` 命中测试通过，不是 `el.click()`），`aria-checked` 由 `false`→`true`；
   随后只读钻取真库副本复核：`codem-deepseek-web-search="1"`、`codem-deepseek-web-fetch="1"`。
4. **新对话里发同一句提示词**（`scripts/_probe-type.js` 用原生 setter + `input` 事件写入，再真点发送按钮）：
   要求模型**真的调用** `web_search`（query=「DeepSeek 官方文档 网页搜索与抓取」）与 `web_fetch`
   （url=`https://api-docs.deepseek.com/zh-cn/guides/search/`），并原样抄回 `Length` 行。
5. **取证**：读 `window.__dsProbe`（网络层）＋ 读会话日志 JSONL（应用自己的落盘记录，`scripts/_extract-toolcalls.mjs` 抽取）＋ 截图。
6. **收尾**：把两个开关点回关闭并复核落库为 `"0"`（默认关闭是产品口径，取证不该留下付费能力常开的状态）。

## 3. 顺着这条取证发现的真缺陷（已修，有判据）

**`web_search` 的报告被当成 grep 输出渲染。**

- 现象（`before-websrch-rendered-as-grep.png`）：卡片显示成 3 个**假文件**、每个 `· 1 match`：
  `2026-10-17T09 · 1 match` / `站点: 驱动中国 · 日期: 2026-10-16T16 · 1 match`；
  本该显示的搜索结果列表（标题 / URL / snippet）**一个都没有**。
- 根因：`trySearchModel` 的门禁写成 `toolName.toLowerCase().includes('search')`，于是 `web_search` 也进来；
  其报告里的 `站点: … · 日期: 2026-10-17T09:12:12.122Z` 命中 `^(.+?):(\d+):(.*)$`（`T09:12:12` 被读成第 09 行）。
  而 `WebSearchResultCard` 排在 `searchModel !== null` 之后 ⇒ **永远到不了**（`websearch-head` 计数为 0）。
- 修复（`src/components/ToolCallCard.tsx`）：把门禁改成**精确 id 白名单** `grep` / `glob`
  —— 只有这两个工具的输出契约是「`路径:行号:内容`」或纯路径列表。
  顺带修掉同源的 `search_notebook` 误伤（它名字里也带 search）。
- 判据：`src/test/web-search-card-not-grep.test.tsx` 的 `WEBSEARCH-CARD-1/2/3`
  （1 = 真报告走专用卡片且 URL 真的渲染；2 = grep 仍走文件行卡片；3 = `search_notebook` 不被误伤）。
  变异自证：把白名单的 `grep` 去掉 ⇒ `WEBSEARCH-CARD-2` 立刻红；换回子串门禁 ⇒ 1 与 3 红。
- 修后真机（`after-websrch-dedicated-card.png`）：`.websearch-head=1`、`.websearch-item=10`、
  `.search-match-row=0`、`.search-block=0`，链接 href 正确；`after-fetch-card-length.png` 里 `Length: 6402 字` 照旧。

## 4. 看到但**没有**改的两点（不该凭感觉动）

1. **Fetch 正文是官方转义过的 Markdown**：`JSON.parse` 之后仍带 `\/`、`\#`、`\-`、`\|`、`\:`
   （例：`Search \/ Fetch API 已上线…`、`\# 网页搜索与抓取`）。官方文档没有写"客户端应当反转义"，
   自作主张反转义会破坏代码块里合法的反斜杠 ⇒ 原样透传，只在这里记一笔。
2. **`web_fetch` 走的是通用 IN/OUT 卡**（`after-fetch-card-length.png` 下半部分），不是专用卡。
   这是"更好看"的取舍，不是缺陷（输出对模型与对人都完整可读）。

## 5. 局限（别把这份证据读大）

- 只覆盖**中文单次查询**这一种形状（`count` 缺省与显式各一次）；地区/语言、`ori_question`、`need_content=true` 未取证。
- 只覆盖**成功**路径；429/5xx 重试、408、402 的文案仍是判据覆盖，不是真机。
- 耗时是**渲染器侧**的墙钟（含 DNS/TLS/排队），不含服务端耗时；两次构建的机器负载不同，不宜横向比快慢。
- 明文 Key 全程未被打印或落盘；`probe-http.json` 里没有 Key，也没有请求头。

## 6. 文件

| 文件 | 是什么 |
|---|---|
| `probe-http.json` | 两轮的网络层记录（status / ms / 响应体字符数 / 结果条数 / 正文长度）+ 应用侧工具 metadata |
| `session-toolcalls-run1.json` / `-run2.json` | 两次会话里工具调用的最终形态（args / status / result / metadata，来自会话日志） |
| `before-websrch-rendered-as-grep.png` | 修复前：`web_search` 被渲染成假文件行 |
| `tool-cards-expanded.png` | 修复前：两个工具卡展开（同一轮的另一张） |
| `after-websrch-dedicated-card.png` | 修复后：专用搜索卡片（标题 + 可点链接 + snippet） |
| `after-fetch-card-length.png` | 修复后：`Length: 6402 字` |
| `scripts/` | 复现用的四个脚本（CDP 启动 / 网络探针 / 写提示词 / 抽会话工具调用） |

截图 sha256（原图，未压缩）：

```
bc66f1e8fff4c59276b90cb8a8e22fb9eac3e314cdb4964489fc78feffd37f62  after-fetch-card-length.png
70528318e18400e7bcdcc67a98efb96728c00db6b9fee30388e5a3a1b0396c65  after-websrch-dedicated-card.png
e7b07dd5ca53bcfafe224ebc60e8ceed04f013646a7784a8238c60109e223c5f  before-websrch-rendered-as-grep.png
6b58a43ff083312a1e867faa9af9d4cf76bc9d8fc3edafe08c577b89a9c58921  tool-cards-expanded.png
```

构建/安装标识（run2）：安装包 `Codem_1.16.323_x64-setup.exe`，
sha256 `59409f50acbb789f9ad136b4eaa089065daa9702cc7c314a667c0077e4bb6684`，
静默安装于 2026-10-17 22:21，`codem.exe` 时间戳 22:21:46；源码 = `1f6f67d7` + 本目录所述改动（`ToolCallCard.tsx` 一行门禁 + 三个判据）。
