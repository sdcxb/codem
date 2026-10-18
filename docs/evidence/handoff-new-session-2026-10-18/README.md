# 「移交给新对话」真机取证（2026-10-18）

构建：`src-tauri/target/release/codem.exe`（本地 `tauri build` 产物，含本修复）
驱动：WebView2 CDP。模型：deepseek-flash（用户现有配置）。

## 用户报的两个现象

1. 让它把任务「移交给新对话」，任务却被投给了**标题相似的老会话**（「名词解释」→「名词解释啊」）。
2. 侧栏里反复出现同名「交接会话」，还总被顶到最前，分不清哪次是哪次。

## 根因（代码事实）

- 跨会话工具只有 `delegate_to_session(target_session_id)`：**没有"新建会话"的能力** ⇒ agent 只能从
  `list_sessions` 里挑一条；标题既不唯一也没有身份语义 ⇒ 一挑就错。
- 横幅交接每次 `createSession("交接会话")`，标题固定；`createSession` 的第二层去重只会追加 ` · 2`，
  于是侧栏是一串近似名字。

## 修复

- 新增 `handoff_to_new_session(task)`：**自己建会话**（标题 `交接会话 · MM-DD HH:mm`，同名再追加 `(2)`）
  再把交接正文委派过去，返回 `SESSION_ID` + `TASK_ID`；**签名里没有目标会话参数**。
- 提示词新增 `Routing: new session vs existing session`：新对话必须用 `handoff_to_new_session`；
  标题**不是身份**；只有用户点名已有会话时才用 `delegate_to_session`。
- `list_sessions` 给同名会话打 `⚠同名N`，并在表头写明"标题不是身份"。
- 横幅交接改用 `nextHandoverTitle(existingTitles, zh)`。

## 真机结果

`new-session-with-unique-title.jpg`：源会话（对话 37）里模型先据提示词决定调用
`handoff_to_new_session`，随后界面切到**新建的交接会话**；它的标题是 `交接会话 · 10-18 11:15`
（与 11:02 那次**可区分**），并已收到交接正文（正在按交接读 `C:/mimo-gui/docs/ui-spec.md`，
被沙箱拦下后如实报告——那是另一个已知限制，与本次修复无关）。

`source-session-tool-result.jpg`：源会话里能看到本次调用链
（`Tool call · 【会话交接】…` + `Tool call · del-1792293533910-…`），且**老会话一条都没被动过**。

## 判据与变异

- 判据 `HANDOFF-NEW-1..7`：标题唯一化（纯函数）、创建+委派流程注入测试（委派目标必须是新 id）、
  新建失败不许退化、工具注册、提示词路由规则、`list_sessions` 同名告警、横幅接线。
- 变异波次 `handoff-new-session`：5 条变异全红（标题不查重 / 新建失败仍委派 / 不注册工具 /
  删路由规则 / 横幅退回固定标题）。

## 局限

- 沙箱把 `C:/mimo-gui` 判成工作区外（工作区是 `D:\mimo`），新会话读交接里给的绝对路径被拒；
  这是**沙箱配置**问题，不在本次修复范围（模型按判据如实报告，没有瞎猜）。
- 本轮没有重跑 12 个仓库任务的对标批。

## 后续两处加固（同日，用户要求）

### 1）建会话失败要**换名字重试**

旧实现 `openHandoverSession` 一次失败就抛错 —— 用户指出「交接的目的就是到新对话去，直接报错等于没完成目的」。
现在最多重试 3 次（`attempts`），每次换一个标题（`交接会话 · … (2)/(3)`）；全部失败才报错，
**仍然绝不**退化为"委派给某个已有会话"。判据 `HANDOFF-NEW-8..10`。

### 2）交接正文里的工作区外绝对路径 ⇒ 自动提示加入沙箱允许目录

现场：交接写的是 `C:/mimo-gui/docs/ui-spec.md`，新会话工作区是 `D:\mimo` ⇒ 沙箱拒绝。

现在：交接工具/横幅在创建交接后**机械抽取**正文里的绝对路径，只挑"工作区外且未放行"的，
派发 `codem-sandbox-allow-request` → 界面出现提示条（只提示、**不自动放行**）：

`sandbox-allow-prompt.jpg` —— 提示条出现（1 个路径，可展开看具体路径）。

用户点「加入允许目录」后写入 `codem-sandbox-allowed-dirs`，提示条变为
`已加入允许目录：C:/mimo-gui/docs`；读侧闸门（`file-api` / 工具管线 `tool-pipeline`）、
写侧 `checkSandbox` 与 Rust `write_sandbox_violation` 认**同一份**白名单。

`sandbox-allow-read-succeeds.png` —— 同一交接会话里再读该文件：成功，第一行
`# Codem UI 规格（唯一口径）`（与磁盘内容逐字一致）。

判据 `ALLOW-1..6`；变异波次 `sandbox-allowlist-and-retry`（6 条全红，含"管线闸门不认白名单"）。

#### 局限

- `run_code` 里的 `sdk.read` 走同一条 `file-api` 闸门（理论上同样生效），但本轮真机只直接验证了
  `read` 工具；模型早先那次 `run_code` 失败发生在加白名单**之前**，没有在加完之后重试。
