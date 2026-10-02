# 交接单：DSH / Pi Agent Harness 对标与修复（2026-10-02 · v1.16.221）

> **新对话请从这里开始。** 目的：让你**不用重新推导**就能接手四项大任务。
> 所有数字都是实测，出处写在括号里。本文件是**事实与约定**，不是叙事。
>
> ⚠️ **本文件是 gitignore 的**（`docs/*.md` 在 `.gitignore` 里 ⇒ 提交要 `git add -f`）。
> 同目录另有一份**无关的**旧交接单 `HANDOFF.md`（微信桥会话，v1.16.154），别混淆。

---

## §0 先做这三件事

```powershell
# 1. 基线必须绿，不绿就先报告，别在它上面叠加改动
npx vitest run                                              # 期望 451 文件 / 6770 用例
cargo test --manifest-path src-tauri\Cargo.toml --lib        # 期望 130 passed（+2 ignored）
npm run audit                                                # 期望 exit 0

# 2. 任务 0：参考副本严重过期，先更新（见 §6 任务 0）
cd .deepseek-harness-ref; git fetch origin; git pull

# 3. 读这一轮的对标方法长什么样（它是本仓库"怎么做对标"的样板）
#    docs/DSH-REMOTE-CONTROL-BENCHMARK.md 的 §11–§16
```

**最重要的工作方式**：
> **每一项改动都要有「判据 + 变异自证」，然后发版、装机验证。**

"判据全绿"在本仓库**不算证据** —— 必须**证明判据能变红**。§5 有完整约定与三种"假绿"的实例。

---

## §1 项目是什么

**Codem**（`C:\mimo-gui`，包名 `codem`）：**桌面 AI 编码代理**，
**Tauri v2（Rust）+ React + TypeScript**，构建在 **DeepSeek Harness (DSH)** 之上。

三条决定设计形态的事实：

1. **DSH 是插件宿主，不是库**：靠插槽挂 UI、靠 RPC 暴露能力。
2. **引擎逻辑活在 WebView 的 TypeScript 里，不在 Rust 里**。
   所以"手机能访问的 API"是 Rust 起 socket → 转发给渲染进程处理
   （`src-tauri/src/phone/mod.rs` 的 `proxy_to_ts`）。
3. 项目自己的完整说明在 `docs/PROJECT-GUIDE.md`（**版本表在文件顶部，每版一行，有判据**）。

---

## §2 当前状态（可核对）

| 项 | 值 |
|---|---|
| 版本 | **1.16.221**（已装机：`HKCU\...\Uninstall\Codem` 的 `DisplayVersion`） |
| HEAD | `09c729b`，工作区干净，tag 与 HEAD 一致 |
| 测试 | TS **451 文件 / 6770 用例**；Rust **130 条**（+2 条 `#[ignore]` 活体） |
| `npm run audit` | exit 0；UI 审计 error 0 / warn 0 |
| 最近交付 | **AA 远程控制复刻**（R1–R6）+ 登录入口（N1–N12），v1.16.218 → .221 |

**最近这串做了什么**（细节见 `docs/DSH-REMOTE-CONTROL-BENCHMARK.md` §11–§16、`CHANGELOG.md`）：
把 Agents Anywhere（AA）的**私有 WebSocket 协议**完整复刻，并接了
「登录 AA 账号 → 自动注册本机 → 连上」的用户路径。
**已对着真 AA 服务端验过**（账号 `sdcxb@163.com` 在 `web.agents-anywhere.com` 登录成功、
本机注册成设备、connector `connected=true` / `errors=0` / 服务端调过我们 `runtime.discover`）。

**外部参考副本**（都在 gitignore 里，不在版本控制内）：

| 路径 | 是什么 | 新鲜度 |
|---|---|---|
| `.deepseek-harness-ref/` | DSH 仓库 clone | ⚠️ **落后上游 20467 个提交**（本地 `47f9438`，上游 `639ed01`）—— 任务 0 必须先更新 |
| `.preview-shot/_aa-repo/` | Agents Anywhere 仓库 clone | ✅ 最新（0 落后） |
| `.preview-shot/_aa-src/` | 从 DSH 里那个 AA 插件包的 **sourcemap 提取出的原始 TS** | 快照 |
| `C:\Program Files\DSH Desktop\resources\app\` | 已装 **DSH Desktop 2.0.17**（含 AA 插件 2.0.2） | 快照，是**用户实际跑的**东西 |

---

## §3 关键路径

```
src/                       渲染进程（引擎与绝大部分逻辑）
  core/llm/agentic-loop.ts ★ 代理循环（对标 DSH 的主战场之一）
  core/session/            会话存储与执行器
  core/phone-link/
    phone-link.ts          ~1200 行：路由分发 + 会话/回合/审批/目录/选择
    aa-notice.ts           R4：按 AA 形状产出的通知（八态交互模型）
    dsh-selection-id.ts    R3：dsh:model:/dsh:permission:（TS 侧实现）
    aa-protocol-ids.ts     R3：通用 sel_* + 规范 JSON + 自带 SHA-256
    presence.ts            S4：多端在场
    remote-selections.ts   远端改模型/权限档（含"去掉只能收紧"的取舍说明）
    event-stream.ts        阶段 2：事件流（seq/checkpoint/预算）
  core/permission/approval-broker.ts  远端审批（阶段 0，条目级 revision）
  components/AaRemoteSection.tsx      ★ N1–N3：AA 登录入口
  components/PhoneLinkSettings.tsx    手机设置（AA 区块在上；「高级：自研中继」在下、默认折叠）
  test/                     ★ 判据都在这，按功能分文件
src-tauri/src/phone/
  mod.rs                    ★ 手机服务 + Tauri 命令 + 上游代理
  aa_protocol.rs            R1：协议**规格层**（信封/能力集/目录/八态/revision）
  aa_connector.rs           R2/R5：出站 connector（鉴权链/WS/心跳/dispatch 表）
  aa_account.rs             N1–N3：账号（PKCE + 邮箱密码 + 注册本机 + 持久化）
  aa_mock_test.rs           M1–M7：对着**自写 mock AA 服务端**
  aa_live_test.rs           ★ 2 条 `#[ignore]` 活体判据：对着**真服务端**
tools/audit/                ★ 自带扫描器（见 §6 任务 2）
tools/release/              make-latest-json / verify-update-manifest
docs/PROJECT-GUIDE.md       ★ 版本表（新版本必须加行）
docs/DSH-REMOTE-CONTROL-BENCHMARK.md  ★ 对标计划与全部结论
CHANGELOG.md（根）          ★ 每版一段（有判据）
```

**两条经验**：① **Rust 只管传输与进程边界**，业务判断在 TS。
② **"谁能看到什么"这类规则放服务端侧**，不要放界面。

---

## §4 会咬人的坑（都踩过，直接信）

1. **中文文案里绝不要用 ASCII `"`** —— 在 `"..."` 里再写 `"` 会把 esbuild 打挂
   （`Expected ")" but found "已连接"`）。**用「」**。咬过 3 次以上。
2. **不要用 `Set-Content`/`Out-File` 写源码**（加 BOM）；**用 Node `fs` 或 `edit` 工具**。
3. **不要用 `pwsh -Command` 传多行 commit 信息** —— 写到文件再 `git commit -F`。
4. **`node -e "..."` 带中文/反引号/引号几乎必炸** ⇒ **把脚本写成 `.mjs` 文件再跑**。
   这一轮我在引号上浪费了多次。
5. **`Select-Object -First N` 接原生命令会提前杀进程** ⇒ 先把输出接进变量再过滤。
6. 本仓库**换行 LF/CRLF 混用**、`core.autocrlf=true`、**没有 `.gitattributes`** ⇒ 改文件前先确认。
7. `docs/*.md` 与 `latest.json` 是 gitignore ⇒ **`git add -f`**。
8. 用 **`npx vitest run`**；`npx tsc --noEmit` **可能静默不打任何东西** ⇒ 同时 echo `$LASTEXITCODE`。
9. **happy-dom 的 `fetch` 强制 CORS**（发 OPTIONS 预检）⇒ HTTP 判据用原始 `http` 模块。
10. **可达性扫描的文件来源是 `git ls-files`** ⇒ **新文件在 `git add` 之前不算数**，会误报"不可达"（这是设计）。
11. **应用随启动它的 shell 一起死**；长跑要用后台任务。
12. **CDP 调试**：先设 `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"` 再启动。
13. **装新版前 `Stop-Process -Name codem -Force` 并等 ~5 秒**（文件锁）。
14. **端口 18789 被无关的 `openclaw` 占着 —— 不要杀它**。
15. **我读不了图片** ⇒ 结论必须用**数值/机器可读 DOM**表达。
16. Node 的 `ws`+`fetch` 退出时会触发 libuv 断言 ⇒ 成功也 exit 1；**用显式 `process.exitCode` + `setTimeout(exit,50)`**。

---

## §5 验证与交付约定（本仓库的核心规矩）

### 5.1 判据 + 变异自证

**变异自证**：临时改坏实现的**关键那一行**，确认判据**变红**，再还原。
**没变红的判据视为没有覆盖。**

**已经证明过多次的三种"假绿"，请直接警惕**：

| 假绿形态 | 实例 |
|---|---|
| **邻近子串**当成守卫 | 用"看文案附近 400 字符里有没有阶段判断"来断言；变异把条件换成恒真后**照样全绿**，因为附近还有另一处同名判断 |
| **结构判据**挡不住**新增字段** | 断言"视图里没有 `access_token.clone()`"；变异往视图里**加一个 `"accessToken": ...`** 字段，判据照样绿 ⇒ **行为性质只能用行为判据**（把结果序列化出来，断言里面找不到令牌明文） |
| **输入本身就非法** | 断言"不认识的作用域要报错"，但用的值**碰巧也不合法**，删掉作用域校验仍然报错 |

**判据要为"链路"分段**：这轮有个 bug 是**链中间少了一节**
（界面传了验证码 → 命令签名里**没有这个参数** → 静默丢掉 → 服务端一直说"验证码无效"）。
**两头看起来都对。** 所以逐段钉（本例 5 段），并加反向判据
**"收下参数却没写进请求体"必须判红**。

### 5.2 发版流程

```powershell
node .preview-shot/_bump-version.mjs <from> <to> --write
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri\codem-updater.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
npm run tauri:build
node tools/release/make-latest-json.mjs <ver> --notes-file <notes.md>
node tools/release/verify-update-manifest.mjs <ver>            # 本地 5 项
# 提交（含 git add -f latest.json docs/PROJECT-GUIDE.md）→ push → tag → push tag
gh release create v<ver> --title "..." --notes-file <notes.md>
gh release upload v<ver> <exe> <exe.sig> <msi> <msi.sig> latest.json   # ★ 必须单独 upload
node tools/release/verify-update-manifest.mjs <ver> --remote    # 远端 7 项
```

**新增版本必须同时加三处**：`CHANGELOG.md` 一段、`docs/PROJECT-GUIDE.md` 一行、重新生成 `latest.json`
（`version-consistency.test.ts` 盯着）。然后 **装 NSIS（`/S`）→ 重启 → CDP 探针验证**。

### 5.3 装机验证的写法

- 用 **CDP**（`/json/list` 拿 page target，WebSocket 发 `Runtime.evaluate`）。
- **只认机器可读信号**：`data-testid`、`data-phase`、`data-connected`、精确状态码。**不要从散文里猜。**
- **断言"不存在"前必须先建立前置条件**（否则会因"还没加载"而假过）。
- 需要精确状态码的判据：`409 approval_not_pending`、`400` 坏动作、`410` 请求已失效、
  `421` 坏 Host、`403` 跨站、`401` 未配对、`501/503/504` 隧道状态。

---

## §6 四项任务

### 任务 0（前置，半小时）：更新参考副本

```powershell
cd C:\mimo-gui\.deepseek-harness-ref; git fetch origin; git pull   # ⚠️ 落后 20467 提交
```

**顺手确认一件很有用的事**：这一轮我复刻 AA 协议，靠的是
`C:\Program Files\DSH Desktop\resources\app\node_modules\@agents-anywhere\dsh-bridge-next`
里 **`.js.map` 嵌着的完整原始 TS**。
**这个技巧对 DSH 自己的包同样适用** —— 去看 `node_modules/@deepseek-ai/*` 有没有 sourcemap。
**如果有，你就能读到 DSH 的真实实现，而不是靠猜。这是本次对标最重要的取证手段。**

---

### 任务 1：了解项目

读完 §1–§5 就是答案。**动手前先跑基线**（§0 第 1 步），不绿就先报告。

---

### 任务 2：对标 **DSH（升级后）** → 找潜在 bug/隐患 → 详细修复计划 → 逐一修复

**用户给的验收标准（原话）**：
> **当前的项目移植到咱们平台开发，同样用 DS 模型的情况下，水平和 token 消耗都不差于 dsh。**

#### ⚠️ 我必须先指出：这条标准目前【不可测】

- "水平不差于"没有指标（任务通过率？返工次数？人工评分？）
- **"token 消耗"我们目前没有采集** —— 需要先有埋点/日志
- "移植到咱们平台"没有定义边界（哪些能力算"移植完成"）

**所以任务 2 的第一步不是改代码，而是把这条标准变成可测的东西。**
建议的最小可行方案（**先请用户确认再做**）：

1. **固定任务集**：10–20 个真实编码任务，覆盖读代码 / 改小 bug / 加功能 / 重构 /
   跑测试 / 多文件改动。**冻结版本**，不要边测边改。
2. **同模型、同任务的对照跑法**：DSH 官方客户端跑一遍、Codem 跑一遍，各自记录
   **① token 消耗（输入/输出/缓存命中）② 任务是否完成 ③ 是否需要人工纠偏**。
3. **拿到基线数字之后，差异才有意义**；否则"对标"只能停在"读代码找不同"。

**只有 1–3 做完，"不差于 dsh"才是一句能判真假的话。**

#### 不等测量也能先做的取证式对标

- 逐模块对比：**代理循环**（`src/core/llm/agentic-loop.ts`）、**上下文压缩/预算**、
  **工具契约与失败处理**、**缓存命中**（搜索提到 DSH 的缓存命中率是它的卖点）、
  **错误重试与降级**、**会话/时间线同步**。
- 重点找**隐患类**问题：fail-open 的守卫、静默成功、丢失的写入、
  在错误分支里"看起来成功了"的返回。
  **本仓库已有专门的扫描器，先跑它们**：
  ```
  node tools/audit/scan-fail-open-guards.mjs
  node tools/audit/scan-false-success.mjs
  node tools/audit/scan-silent-write.mjs
  node tools/audit/scan-guard-bypass.mjs
  ```

**产出物**：`docs/DSH-ALIGNMENT-FIX-PLAN.md`，逐条写
**现象 → 证据（file:line）→ 影响 → 修法 → 判据 → 变异自证**，然后逐条修。

---

### 任务 3：对标 **Pi Agent Harness 1.0** → 同样的计划

**我对 Pi 的了解仅限于搜索摘要，开工前必须补齐**（**别信我的转述**）：
- 它是**奥地利的开源编码代理 harness**，1.0 主打 **MCP** 与一个叫 **"Codemode"** 的机制。
- npm 上有 `@ai-sdk/harness-pi`；GitHub 上有若干相关仓库（**注意区分官方与个人配置仓库**）。
- **有一篇正好是"同一个模型跑 OpenCode / pi / DSH 三方对比"**，与任务 2 的验收标准形状一致，
  值得先读：<https://dev.classmethod.jp/en/articles/reona-coding-harness-opencode-pi-dsh/>
- 2026-09 三方选型对比：<https://news.qiniu.com/archives/1789607863507>
- 1.0 报道（德语）：<https://www.it-boltwise.de/pi-1-0-ki-agent-aus-oesterreich-setzt-auf-mcp-und-codemode.html>

**第一步**：`git clone` 它的仓库到 `.preview-shot/`。
**⚠️ 环境限制**：`web_fetch` 在这个环境里**被 DNS 拦**（GitHub / npm / PyPI 都打不开），
**但 `git` 能访问 GitHub** —— 这一轮我就是靠 `git clone` 拿到 AA 仓库的。**用 git，不要用网页抓取。**
拿到源码后再谈对标，**不要从二手文章下结论**。

**产出物**：`docs/PI-ALIGNMENT-FIX-PLAN.md`，同一格式。

---

### 任务 4：**DSH / Pi 有、我们没有**的功能或机制 → 先只给建议

**用户明确要求：先不改，先反馈给他判断。**

每条写：
- **它是什么**（一句话，用用户能懂的话）
- **它解决什么问题**（不解决会怎样）
- **它那边的证据**（file:line 或官方文档链接）
- **我们复刻的代价**（大概工作量、有没有前置依赖）
- **不做的后果**
- **我的建议：做 / 不做 / 观察**，并说明理由

**注意用户反复强调的口径**：
> **"不要太复杂、不要让用户面对看不懂的机制。"**

所以这一项里 **"它很好但我们不该做"也是一个合法且常常正确的结论** ——
把"用户能感知到的收益"和"我们内部的复杂度"**分开讲清楚**。

---

## §7 已知未完成 / 未验证（别当成已完成）

| 项 | 状态 |
|---|---|
| **自研中继那条路** | 代码完整保留、装机验过 14/14，但**默认不启用**，收在「高级」里。用户尚未决定留还是删 |
| **自建 AA 服务端** | Docker Desktop **已装**但**引擎起不来**（缺 WSL2，需管理员 `wsl --install` + **重启**）。默认走官方云，**不需要它** |
| **AA 的 OAuth 登录路** | `aa_account.rs` 里 PKCE/回环那套**写好且有判据**，但**默认不走**（我们走邮箱+密码），保留为备选 |
| **`aa_live_test.rs` 的 2 条活体判据** | 标了 `#[ignore]`，**CI 不跑**；要手工给 `AA_BASE`/`AA_EMAIL`/`AA_PASSWORD` |
| **本机那台 AA 测试服务端** | 跑在 `127.0.0.1:8010`（它自己测试用的 SQLite 模式，**不是生产部署**）。不用了就杀 `uv`/`uvicorn` |
| **"远端改权限档"** | 已按用户口径**去掉「只能收紧」**（与 DSH 一致）⇒ 远端能把权限档改成"自动放行一切"，**从那之后阶段 0 的审批不再生效**。**有意的取舍**，记在 `remote-selections.ts` 文件头 |

---

## §8 留给你的诚实提醒

1. **任务 2 的验收标准必须先变成可测的**（§6 任务 2）。直接开始"读代码找不同然后改"，
   最后**无法回答"是不是不差于 dsh"** —— 会变成一轮无法收尾的工作。**先建尺子，再量。**
2. **DSH 副本落后 20467 个提交**。用旧副本对标会得出**错误的差异清单**。任务 0 必须先做。
3. **判据多（6770 个用例）不等于对**。这一轮我被自己的判据骗过 **4 次**
   （§5.1 三种假绿 + 一次"变异本身没应用成功"）。
   **每次变异"没咬住"，先怀疑变异，再怀疑判据，最后才怀疑实现。**
4. **没有真机验证就不要说"做完了"**。这一轮有**两个 bug 只有用户在真机上点才暴露**
   （缺昵称输入框、验证码没传到服务端）—— 而我当时的判据是**全绿**的。
   **装机验证不是形式，它是唯一能发现"链路缺一节"的手段。**
5. **用户不懂也不想懂内部机制**。对外的话要一屏说清：做什么、要他做什么、失败时他该看到什么。
   **机制留在代码注释里，不要放在界面上。**
