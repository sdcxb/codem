# 桌面网关真机用例（写 / 审批 / 取消 / 事件流 / 变更记录）

> 对象：**PC 桌面数据**经 loopback 网关给手机用（ADR-0005 M2 + M3）。与
> `ANDROID-DEVICE-TEST-CASES.md` 的对象（手机**本机** Host）不是同一套。
>
> 自动化入口：`node android-shell/spike-desktop-gateway.mjs`
> 报告：`docs/architecture/evidence/gateway-m2-report.json`（`ok=true` 才算通过）

## 0. 前置（缺一项就报错，不猜）

1. 桌面 Codem 启动，设置 →「桌面远程网关」→ 启动，记下 `http://127.0.0.1:<port>`；
2. `CODEM_GATEWAY_PORT=<port>`、`CODEM_GATEWAY_PAIR_CODE=<6 位码>`（设置页「生成配对码」）；
3. 桌面至少有一个会话（协议用例会向它发一条**无害**消息，真实写入历史）；
4. `ANDROID_SDK_ROOT` 指向 SDK，模拟器/真机已连接（默认 `emulator-5554`）。

脚本先执行 `adb reverse tcp:<port> tcp:<port>`，因此**手机与 PC 使用同一个 URL**；
手机侧走的就是产品路径（配对 cookie → `/rpc` + `/events`）。

## 1. 用例

| ID | 步骤 | 期望 | 自动化判据 |
|---|---|---|---|
| **GWD-0** 反向映射 | `adb reverse` | 手机可访问 PC 网关 | 命令成功 |
| **GWD-1** 健康检查 | `GET /health` | `{ok:true, service:"codem-gateway"}` | 响应体 `service` |
| **GWD-2** 未配对拒绝 | 无 cookie `GET /events` | 401（不能建立事件流） | HTTP 状态 |
| **GWD-3** 配对 | `pair.claim`（6 位码） | HttpOnly cookie；响应体不含 token | `Set-Cookie` 存在且不被打印 |
| **GWD-4** 能力表 | `host.hello` | `supported` 含 `prompt.send/run.cancel/approval.list/approval.respond`；**不含** `events` | 方法集合 |
| **GWD-5** 读桌面数据 | `session.list` → `session.get` | 会话来自桌面库；`run` 字段存在（null 或 running） | `session.id` + `run` |
| **GWD-6** 待批表 | `approval.list` | `{approvals: [...]}`（形状稳定，可为空） | 数组类型 |
| **GWD-7** 发一轮 | SSE 连接 → `prompt.send` | 事件顺序：`run.started` → 正文/工具 → 终态；seq 单调；`runId` 一致；终态 `succeeded` | 事件流断言 |
| **GWD-7b** 历史落库 | 终态后 `session.get` | 桌面会话里能看到这条用户消息与助手回复 | 消息内容/角色 |
| **GWD-8** 断线重连 | `Last-Event-ID=<第一条事件 seq>` 重连 | 只补发 `seq > since`；**不重复**；**终态仍在** | 补发集合 |
| **GWD-9** 手机审批 | 触发审批的提示词 → `approval.list` 可见 → `approval.respond`（deny） | 答复一次生效；`approval.resolved` 到达；桌面卡片同步消失 | 列表 + 答复 + 事件 |
| **GWD-10** 手机取消 | 长任务提示词 → `run.cancel` | `cancelled:true`；终态 `run.cancelled`（不是 failed）；桌面回合停下 | RPC + 终态事件 |
| **GWD-11** 真实 Chrome UI | `--ui` + 第二个配对码 | 页面加载（无 `__CODEM_GATEWAY_READ_ONLY__`）、会话列表、发送框存在 | Chrome CDP `Runtime.evaluate` |
| **GWD-12** 变更列表 | `session.changes` | `{items,hasMore,supported}` 形状；非 git/无工作区时 `supported:false + reason`（不是空列表冒充） | 类型 + 空态语义 |
| **GWD-13** 单文件 diff | `session.change.diff`（取首条记录的 `files[0]`） | `supported:true` 时 patch 非空或 `truncated:true`；`supported:false` 时必须带 reason（敏感/未跟踪/对象缺失） | patch 形状 + 诚实空态 |
| **GWD-14** 未知记录 | `session.change.diff` + 不存在的 `changeId` | `NOT_FOUND`（`-32003`），不是空 patch | JSON-RPC 错误码 |
| **GWD-15** 真实改文件 | `CODEM_GATEWAY_CHANGE_PROMPT` → 轮询 `session.changes` | 回合后出现**新的 changeId**，首个文件能取 diff（`supported` 布尔 + reason 语义） | 新记录 + diff |

`GWD-9/GWD-10/GWD-15` 需要模型配合：分别用 `CODEM_GATEWAY_APPROVAL_PROMPT`、
`CODEM_GATEWAY_CANCEL_PROMPT`、`CODEM_GATEWAY_CHANGE_PROMPT` 提供提示词；
未提供时**如实记为 skipped**（不假绿）。
`GWD-11` 需要 `CODEM_GATEWAY_UI_PAIR_CODE`（配对码一次性，协议用例已用掉第一个）。

## 2. 判据边界（不是"忘了"）

- 事件流只覆盖**网关发起**的运行；桌面前台回合走 `App.tsx` 自己的循环，手机刷新
  `session.get` 能看到结果与历史，但不会收到它的实时事件/也无法取消它
  （`RUN_NOT_FOUND`，如实拒绝而不是假装停止）。
- 断线太久（事件日志已淘汰）时客户端收到 `gateway.reset`，界面从桌面存储重新对齐；
  缺口中间的正文流不重放（重放会让手机重复追加文本），但**终态**会单独补发。
- `approval.respond` 不支持「总是允许」：远端一次性授权是审批代理的硬约定。
- `GWD-7b` 是"桌面历史落库"的服务端判据（读的是桌面存储投影，不是手机自己缓存的
  事件流）；手机 UI 在 `run.finished` 后也会重新拉一次 `session.get`。
- 变更记录读的是**桌面渲染进程的 `turn_file_changes`**（`FileChangeStorage`）与
  **该会话工作区**的 git 对象，不是 Host 库、也没有网关缓存。`session.list` 是全项目的，
  所以 `session.changes` 按会话取工作区（worktree 会话取 worktree）。
- 跨工作区/对象被清理 ⇒ `supported:false + reason`，不是 `INTERNAL`，也不是"没有改动"。
- 敏感路径（`.env` / 私钥 / `.git/config`）的 diff **硬拒绝**：变更记录没有 `approvalId`
  字段，弹审批就是半套；远程端不提供这条内容出口。
- 变更面**没有回滚**：桌面那套回滚仍只在桌面；协议只下发只读视图。

## 3. 本机实测（2026-11-02）

环境：Windows 11 + 桌面 Codem（`cargo build --release` 产物，**隔离数据根**
`CODEM_DATA_HOME` + `WEBVIEW2_USER_DATA_FOLDER`）+ `emulator-5554`。桌面以
`--remote-debugging-port=9223` 启动；网关端口 55026。

**通过**（报告 `ok=true`，`docs/architecture/evidence/gateway-m2-report.json`）：

- GWD-0..6：`adb reverse`、`/health`、未配对 401、配对 cookie、capabilities 8 条、
  `session.get`（`run:null`）、`approval.list` 形状；
- GWD-P0..P4（`--probe`）：桌面 WebView 里调用真实的 `gateway_publish_event` →
  SSE 收到正文（`seq=13`）与终态（`seq=14`）；`Last-Event-ID=13` 重连只补发终态
  （重复 0）；渲染层发布 `gateway.reset` 被网关拒绝；
- GWD-11（`--ui`，模拟器里的 **真实 Chrome**）：页面标题 `Codem Remote`、选中桌面
  会话后出现发送框；`新建会话`/`文件` 入口**不存在**（网关能力表没有
  `session.create`/`workspace.*`）；只读标记 `undefined`。

**未执行（如实标注）**：

- GWD-7/7b/8/9/10 在 `--probe` 下记为 skipped（没有模型）。另做了一次**真实回合**
  尝试（不经脚本，向隔离库的「对话 1」发 `请只回复 GW_LIVE_OK`）：`prompt.send`
  返回了 runId，SSE 依次收到 `run.started` → `tool.error` → `assistant.text`
  → `run.failed`，**证明真实循环 → 事件 → 终态管道通了**；失败原因是隔离数据根
  没有 LLM 凭据（`Failed to fetch`），因此"成功回合 / 审批 / 取消"三条成功路径
  仍需在**配置了模型**的桌面上用本脚本的 GWD-7/9/10 执行。

## 4. 复跑

```powershell
$env:ANDROID_SDK_ROOT="C:\Users\abee\AppData\Local\Android\Sdk"
$env:CODEM_GATEWAY_PORT="54321"
$env:CODEM_GATEWAY_PAIR_CODE="123456"
# 可选：审批/取消/UI
$env:CODEM_GATEWAY_APPROVAL_PROMPT="请用 bash 执行 echo GW_APPROVAL_OK"
$env:CODEM_GATEWAY_CANCEL_PROMPT="请用 bash 执行 sleep 60"
$env:CODEM_GATEWAY_UI_PAIR_CODE="654321"
node android-shell/spike-desktop-gateway.mjs --ui
```

无模型/无桌面环境时，等价的行为判据在：

- Rust：`cargo test --lib phone::gateway`（真实 TCP：配对、鉴权、SSE 直播/续传/缺口/
  终态保留、stop 断开流、白名单转发）；
- TS：`src/test/remote-gateway-*.test.ts`、`src/test/gateway-event-publisher.test.ts`
  （协议/投影/队列/审批比较器/接线）。

## 5. M3 变更面真机执行状态（如实）

`GWD-12..15` 已加入 `android-shell/spike-desktop-gateway.mjs`（含 `--probe` 下如实
skip；GWD-15 需要 `CODEM_GATEWAY_CHANGE_PROMPT`）。**本轮未执行真机**——没有可用的
桌面 + Android 设备/模拟器会话；因此这里不写"已通过"。自动化判据已覆盖：

- `src/test/gateway-changes.test.ts`（桌面工作区逐会话、对象缺失、敏感拒绝、截断）；
- `src/test/remote-gateway-changes.test.ts`（RPC 参数/错误码/能力表/生产接线）；
- `cargo test --lib phone::gateway`（白名单真实 TCP 转发）；`src/test/host-git-exec.test.ts`
  （Host `cat-file -e` 白名单）。

真机复跑命令见 §4，额外加：

```powershell
$env:CODEM_GATEWAY_CHANGE_PROMPT="把 GW_CHANGE.txt 的内容改成 ok（只改这一个文件）"
node android-shell/spike-desktop-gateway.mjs
```
