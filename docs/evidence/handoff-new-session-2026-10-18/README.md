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

`new-session-with-unique-title.png`：源会话（对话 37）里模型先据提示词决定调用
`handoff_to_new_session`，随后界面切到**新建的交接会话**；它的标题是 `交接会话 · 10-18 11:15`
（与 11:02 那次**可区分**），并已收到交接正文（正在按交接读 `C:/mimo-gui/docs/ui-spec.md`，
被沙箱拦下后如实报告——那是另一个已知限制，与本次修复无关）。

`source-session-tool-result.png`：源会话里能看到本次调用链
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
