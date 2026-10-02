# DSH「远程控制」对标分析与改进计划

> 结论先行：DSH 最新版（装机版 **DSH Desktop 2.0.17**）侧栏里的「远程控制」**不是 DSH 核心功能**，
> 而是它**预装的第三方插件** `@agents-anywhere/dsh-bridge-next`（Agents Anywhere）。
> DSH 官方自己另有一条**独立**能力：把本机 Web UI 经 **LAN HTTPS** 暴露给普通浏览器。
> 两条路我们都只有一半 —— 详见 §5 三向对照与 §6 改进计划。

> ## ⚠️ 决策修正（第 122 轮，用户口径）
>
> 本文初版把「云账号 + 中继」列进 §7「明确不抄」，建议先做局域网。
> **用户随后明确要求：百分百对标 DSH，直接复制它的策略。** 该决定覆盖 §7 的第一条。
> 因此本文后续以「**出站中继**」为唯一目标形态，§7 里那几条"不抄"**只保留与策略无关的部分**
> （Python 运行时、手写 TCP、原生 App、侧栏扩展点），并新增 §11 记录真实策略与实现计划。

---

## 0. 方法与证据（先说清楚我凭什么下结论）

| 项 | 说明 |
|---|---|
| DSH 装机版 | `C:\Program Files\DSH Desktop\resources\app`，`dsh-plugin-desktop@2.0.17` |
| 被对标插件 | `@agents-anywhere/dsh-bridge-next@2.0.2-desktop.c1678f407364c.r156e8f86` |
| **一手源码** | 该插件的 `lib/index.js.map` / `lib/client.js.map` **内嵌完整原始 TypeScript**（51 host + 39 client 文件）。已导出到 `.preview-shot/_aa-src/`，本文所有插件引用都来自**原始 TS 的行号** |
| 厂商文档 | 插件包内 `TECHNICAL.md`（207 行）、`RUNTIME_READS.md`（122 行）；`cordis.patch.yml` |
| 我方现状 | `src-tauri/src/phone/**`、`src/core/phone-link/**`、`src/core/wechat-bridge/**` |

**诚实边界（必须先说）**：

1. 我**没有真的用手机连过 DSH 的远程控制**，也没有 AA 账号。本文对 DSH 的所有描述都来自
   **源码与随包文档**，不是实机行为记录。
2. DSH 官方 LAN HTTPS 那条我只读了**编译产物**（`lib/lan-https-*.js`），没有拿到它的原始 TS。
3. 「值得学」与「建议怎么做」是我的判断，已标注为**建议**，与「事实」分开写。
4. `_aa-src` 里导出的源码**不是**该项目的完整仓库（sourcemap 只含被 bundle 进去的文件；
   `src/client/features/**` 的 TSX 与 Python Connector 源码都不在其中）。涉及那两处的描述，
   我引用的是 `TECHNICAL.md` / `RUNTIME_READS.md` 的**文字**，并已注明来源。

---

## 1. DSH 是怎么实现的（分层）

### 1.1 拓扑：**出站中继**，桌面不向局域网开控制端口

```
手机 / 浏览器
   │  HTTPS
   ▼
Agents Anywhere Web（云端 web.agents-anywhere.com，或用户自建实例）
   │
Agents Anywhere Server  ◀──（出站长连接）──  Python Connector（桌面子进程）
                                                  │  本机 127.0.0.1 JSON-RPC
                                                  ▼
                                       DSH Host 插件（dsh-runtime）
                                                  │  官方服务
                                                  ▼
                                  sessions / sessionQuery / sessionController / …
                                                  ▼
                                            原生会话与 JSONL 日志
```

关键点：**DSH 桌面从不监听局域网**。它只在 `127.0.0.1` 上开一个私有 RPC，
由**自己拉起来的** Python Connector 反向连上来读；对外的可达性由 Connector 到中继的**出站**连接解决。

证据：

- `src/host/dsh-runtime/server.ts:63-64` —— `this.server!.listen(0, '127.0.0.1', …)`
  （`0` = 由 OS 分配随机端口；**绑回环，不绑 0.0.0.0**）
- `src/host/dsh-runtime/server.ts:12` —— `MAX_FRAME_BYTES = 8 * 1024 * 1024`
- `RUNTIME_READS.md:9-13`（厂商原文，讲了这条链）—— `平台 → Connector RuntimeProtocol →
  Python DSH 适配器 → 本机鉴权 JSON-RPC → 插件 host/dsh-runtime → DSH 官方 SessionQuery →
  原生 Session / SessionPersistence`
- `TECHNICAL.md:12-18`（厂商原文，讲了用户视角的完整链路）—— `DSH 左侧边栏「设置」上方 →
  远程控制 → 云端登录或连接自己的服务器 → Web 登录/注册、授权插件 → **插件 127.0.0.1 回调**，
  交换用户凭据 → 复用或注册本机设备，启动插件内部的源码 Connector → 等待服务端确认设备在线 →
  Web 独立引导页 → 进入 Web App`

注意 `TECHNICAL.md:14` 那句「**插件 127.0.0.1 回调**」：OAuth 回调是**回环端口**，
不是把我们暴露到网上 —— 这是它"桌面永不对 LAN 开控制口"的第一层体现。

### 1.2 本机传输：手写 TCP + 换行分隔 JSON-RPC 2.0

不是 HTTP，是 `node:net` 裸 TCP；每帧一行 JSON。

| 机制 | 实现 | 证据 |
|---|---|---|
| 监听 | `net.createServer`，`127.0.0.1:0` | `server.ts:61-64` |
| 令牌 | `randomBytes(32).toString('base64url')` | `server.ts:60` |
| 端点发现文件 | `{version:1, host:'127.0.0.1', port, token, pid}` | `server.ts:13` |
| 文件权限 | 目录 `0700`、文件 `0600` | `server.ts:71,77` |
| 原子发布 | 先写 `.tmp`（`flag:'wx'`）再 `link()` 到正式名；**拒绝覆盖竞争owner** | `server.ts:75-79` |
| 单实例 | 进程级 **OS 租约**（`acquireManagerLock`），崩溃自动释放 | `server.ts:43-47` |
| 鉴权 | 首帧必须是 `initialize`，`timingSafeEqual` 比对 token | `server.ts:160-165` |
| 协议校验 | `protocolVersion` 必须匹配 `^1\.\d+$`，且 `runtime === 'dsh'` | `server.ts:166-168` |
| 命名空间 | `sessionNamespace`（或 `connectorId`），≤512 字符 | `server.ts:169-170` |
| 鉴权超时 | 10 秒未完成 `initialize` 即断开（`unref()`） | `server.ts:122-123` |
| 并发上限 | 连接 ≤16；在途请求 ≤16；请求 id 不得重复 | `server.ts:116,159` |
| 单请求取消 | 每个请求一个 `AbortController`；支持 `$/cancelRequest` | `server.ts:191-197,150-153` |
| 请求超时 | 默认 60 秒 | `server.ts:32,198` |
| 背压 | 写侧积压 > 2×8 MiB 直接断开；单帧超限丢弃并在换行处重新对齐 | `server.ts:130,236-246` |
| 服务端→客户端 | 通知帧 `runtime.sync.batch` / `runtime.error` | `server.ts:172,176` |
| 能力协商 | `initialize` 回 `identity` / `storage` / `features` | `server.ts:182-188` |

`features` 里回的东西很关键（`server.ts:185-187`）——**能力是按宿主实际提供的服务算出来的**，
不是写死的：`attachments` 取决于 `sessionController && attachments` 是否注册，
`approval` / `userQuestions` 取决于对应服务是否 available，`readOnly` 取决于有没有 `sessionController`。

### 1.3 RPC 面：远程到底能做什么

`src/host/dsh-runtime/router.ts:50-181` 一个 switch 就是全部。逐条：

| 方法 | 作用 | 行号 |
|---|---|---|
| `initialize`（在 server 层） | 握手 + 能力协商 | `server.ts:160-189` |
| `ping` | 探活 | `router.ts:132` |
| `runtime.getConfig` | 运行时配置 | `:133` |
| `runtime.getCapabilities` | 能力集 | `:135` |
| `workspace.list` | 工作区列表 | `:134` |
| **`session.list`** | 会话清单（分页游标，官方顺序，排除子代理/归档） | `:136,222-252` |
| **`session.getSnapshot`** | 单会话时间线快照（分页） | `:137,254-296` |
| **`session.getState`** | 状态：idle/running/waiting_approval/blocked + 当前配置 | `:138-164` |
| `session.getCapabilities` | 单会话能力 | `:175-178` |
| **`session.createAndStart`** | 新建会话并跑首轮 | `:76-96` |
| **`session.startTurn`** | 在已有会话续聊一轮 | `:76-96` |
| **`session.interrupt`** | 中断当前轮 | `:126-131` |
| **`session.updateSelections`** | 改配置（模型 / 权限 / agent 模式） | `:112-125` |
| `catalog.listModels` | 可选模型目录（带搜索 + 上限） | `:97-103` |
| `catalog.listPermissions` | 权限档目录 | `:104-107` |
| `catalog.listAgentPresets` | agent 模式目录 | `:108-111` |
| `session.getNotices` | 待处理通知（审批 + 问答） | `:165-168` |
| **`session.respondInteraction`** | 回答通知：审批或问答 | `:169-174` |
| `runtime.sync.subscribe` | 订阅事件流（返回 `streamId`） | `:53-64` |
| `runtime.sync.ack` | 确认批次（带 checkpoint） | `:65-67` |
| `runtime.sync.unsubscribe` | 退订 | `:68` |
| `runtime.sync.refresh` | 单会话强制重读 | `:69-75` |

注意几个设计取舍（**都能直接看出为什么**）：

- `session.getState` 对**不可用**（归档等）的会话返回 `status: 'blocked'` 而**不去加载 Agent**（`:153-156`）。
- 发送失败**不抛错**，而是返回结构化 `{ok:false, code, message, result:{sourceState, configuration}}`
  （`:87-94`）—— 让远端能显示"为什么没发出去"，而不是一个 500。
- `session.updateSelections` 失败时把**最新 state 一起带回去**（`:119-124`），避免远端状态漂移。
- 分页游标是**内存里的临时捕获**，120 秒过期，且绑定连接/会话（`router.ts:29,210-220,262-265`）——
  「不当第二个持久化会话库」。

### 1.4 远端审批：**一次性授权**，且要防多端竞争

`src/host/dsh-runtime/approvals.ts`：

- 类头注释就写明契约：`/** Decisions flow through the official pending request; a grant always applies once. */`（`:14`）
- 只接受官方 `approval/request` 的 waterfall，且会话必须**可见**（`:31`）；不可见就不拦，交回原生 answerer（`:33`）
- 通知里给远端两个动作（`:69-72`）：
  `{actionId:'allow-once', label:'允许一次', style:'primary'}` / `{actionId:'reject', label:'拒绝'}`
- `respond()` 的防护链（`:76-93`）值得逐条看：
  1. 找不到 / 已不是 `open` / 会话不可见 → 回 `dsh_approval_not_pending`（`:78-79`）
  2. 动作名不在白名单 → `dsh_approval_invalid_action`（`:80`）
  3. **await 可见性之后再次检查 `open`** —— 因为"另一个客户端可能已经决定了"（`:81-82`）
  4. 置 `responding` → 回复官方 → 若期间被撤回则回 stale（`:83-86`）
  5. 官方没收下 → **退回 `open`** 让用户重试（`:89-91`）
- `turn/end` 时把仍 pending 的审批标记为 `expired`（`:94-99`）
- 历史条目**有界回收**：非 pending 的只保留最近 128 条（`:48-49`）

### 1.5 会话保真：投影成统一 Timeline，而不是自己存一份

`RUNTIME_READS.md:44-62` 给了完整的**原始记录 → Timeline** 映射表（厂商原文），摘几条关键的：

- 真正用户的 `user/message` → `message(role=user)`；**插件注入的 user-role 消息不输出**（`:47`）
- assistant 文本 → `message/markdown`，**流式片段与最终消息用同一 ID**（`:48`）
- `reasoning` → `system/reasoning`，**与普通文本分开**（`:49`）
- `tool-call`/`tool/result` → **合并成同一条 `tool`**（按 callId 合并输入/结果/错误/状态）（`:51`）
- `bash`/`pwsh` → `tool/command`，**没有事实依据时不猜退出码**（`:52`）
- `write`/`edit` → `tool/file_change`，**有原生 diff meta 才用，绝不读当前磁盘拼历史**（`:53`）
- `ask_user_question`/`exit_plan_mode` → `tool/input_request`，**历史只读，不发起新交互**（`:57`）
- `approval/asked`/`approval/decided` → **合并成同一条 `tool/permission`，不重新弹审批框**（`:59`）
- `compaction` → `marker/compact`，**原始历史保留，不以压缩后上下文覆盖聊天记录**（`:61`）
- 其他内部事件**不输出**，且**不生成兜底 notice**（`:62`）

`:64` 还有一条很硬的取舍：**损坏日志由官方读取层拒绝，转成稳定错误，「不会伪装成空历史」**。

### 1.6 同步：事件驱动 + 检查点 + 增量，而不是轮询

- 订阅后 `SyncFeed` 推 `runtime.sync.batch`；`ack` 要带 `batchSeq` 与 `checkpoint`（`router.ts:65-67`）
- 检查点落在 **Connector 侧** `<dataRoot>/<connectorId>/<runtimeId>/sync-state.json`（`TECHNICAL.md:48`）
- **历史相关批次要等服务端 ingestion 成功才推进检查点**；收页 ACK 或通知入队**不算**成功（`TECHNICAL.md:48`）
- 重连时：本地读检查点 → 比较指纹 → 匹配就**只上传变化项**；不匹配/有删除/仍在生成就**补该会话快照**（`TECHNICAL.md:48`）
- **投影版本**是显式常量，客户端要协商：`PROJECTION_VERSION`（`router.ts:1,60,63,187,294`）；
  `TECHNICAL.md:92` 说明升级到 v3 时**旧 v2 检查点不复用**，避免旧映射错误长期留在平台历史里
- 分页与预算：快照每帧 ≤1000 条、总量 ≤7 MiB；单条 >7 MiB 直接 `FRAME_TOO_LARGE`（`router.ts:281-287`）
- 订阅初始历史每页 ≤250 条（`RUNTIME_READS.md:68`）
- 失败**按会话隔离**：单会话读失败只影响它，其他继续同步，且**不用空快照覆盖已有历史**（`TECHNICAL.md:50`）

### 1.7 账号、设备与授权链

- **OAuth 用临时回环端口 + state + PKCE S256 + 一次性授权码**；取消/超时/重复回调都有明确处理（`TECHNICAL.md:22`）
- 凭据分层：账号 token **不进页面状态、不进跳转 URL**（`TECHNICAL.md:21`）
- 设备复用：同账号同服务复用已有设备；**重试丢失的注册响应不会重复创建设备**（`:23`）
- 设备被删/凭据失效 → **必须人工点按钮**恢复，插件**不会自动续签或重建**（`TECHNICAL.md:126`）
- 凭据文件原子替换、POSIX `0600`（`TECHNICAL.md:162`）
- 同一数据目录只允许一个实例管理设备：靠**回环管理端口**由 OS 保证独占（`TECHNICAL.md:164`）
- 恢复出厂：**先撤销服务端凭据，再清本地**；撤销失败则**先保留本地状态**（`TECHNICAL.md:36`）

### 1.8 手机扫码

复用 AA 服务端既有接口 `/auth/mobile-login/qr`、`status`、`confirm`；
二维码里是**临时登录凭据**，用**当前账号的后端地址**，**不用 DSH 地址也不用 OAuth 回环端口**（`TECHNICAL.md:40`）。

### 1.9 客户端如何挂进 DSH

- **Host 侧**：`cordis.patch.yml:1-4` 往 DSH 配置里 insert 一个插件层；
  `src/host/index.ts:10-13` `apply()` 里注册两个服务（`DshRuntimeService` + `OnboardingService`）
- **Client 侧**：`package.json:35-43` 声明 `dsh.client.inject`（slots / locale / connection / sidebar）
- 入口用官方 `sidebar.footer.action` 扩展点，挂在「设置」**上方**；图标 Lucide `Smartphone` + 「远程控制」（`TECHNICAL.md:116`）
- 弹窗复用官方 primitives（`Modal`/`Tooltip`/`Button`/`Input`/`StateDot`），
  **不打包自己的副本**（`TECHNICAL.md:118`）
- 客户端 → Host 的 RPC 走官方 **Typert Gateway**（`src/host/rpc/service.ts:5,23`），
  暴露 17 个 `@Remote` 方法（`service.ts:59-113`）：`inspect` / `restartBridge` / `openDesktop` /
  `readBridgeLogs` / `readConnectorLogs` / `begin` / `cancel` / `logout` / `recoverDevice` /
  `controlConnector` / `saveConnectorSettings` / `openConnectorFolder` / `resetConnector` /
  `createMobileLogin` / `inspectMobileLogin` / `confirmMobileLogin` / `selection`
- 侧栏四个页签：登录和连接 / 设置 / 桥接日志 / 维护（`TECHNICAL.md:31-36`）
- **`selection` 那条容易被忽略但很重要**（`service.ts:109-113`）：
  多端把"当前选中哪个会话"上报给 runtime 的 `presence`
  —— 也就是**多端在场感知**，避免两个客户端各说各话。

---

## 2. DSH 官方那条：LAN HTTPS 浏览器访问

这条与插件**无关**，是 DSH Desktop 自己的能力：把本机 Web UI 给**局域网里的普通浏览器**用。

| 机制 | 实现 | 证据（编译产物） |
|---|---|---|
| 上游只绑回环 | `DesktopWebServer` 构造时**强制** `config.host === '127.0.0.1'`，否则抛错 | `lib/webserver.js` |
| 入口门卫 | 每个 route/fallback/upgrade 都过 `permits(request)`，拒绝即 403 / 403 upgrade | `lib/webserver.js` |
| 两种身份 | Electron 渲染进程（带专用 header token）vs 普通浏览器 | `lib/desktop-browser-access-*.js:5,47-51` |
| token 强度 | 32 字节 base64url，长度正则 `^[A-Za-z0-9_-]{43}$`，`timingSafeEqual` 比对 | 同上 `:6-7,32-35` |
| 抗 DNS rebinding | 普通浏览器请求的 URL **不得带 `dsh-desktop-` 前缀的渲染器标记** | 同上 `:8,37-45,49` |
| 端口冲突 | 逐个 +1 重试，最多 32 次 | `lib/webserver.js` |
| LAN 边缘 | **`EDGE_HOST = "0.0.0.0"`，`TARGET_HOST = "127.0.0.1"`** —— HTTPS/WSS 边缘反代回环上游 | `lib/lan-https-runtime-*.js:7-8` |
| 证书 | `selfsigned` 自签：CA 3650 天 / 叶子 30 天，RSA-SHA256 | `lib/lan-https-certificate-*.js:6,17-18,213` |
| SAN | 只接受**规范化 IPv4**，逐个进 SAN | 同上 `:43,73-79,294` |
| 用户可验证 | 导出 **CA 指纹** `sha256(ca.x509.raw)` | 同上 `:68` |
| 抗跨站 | upgrade 时校验 `Host` ∈ 允许地址集 且 非 cross-site | `lib/lan-https-runtime-*.js:51-52` |
| 可热插拔 | 边缘可开关，无需重建 Host generation | 同上 `:114-117` |

---

## 3. 我们的现状（逐条带证据）

### 3.1 传输：Rust 侧 **0.0.0.0 明文 HTTP** + 事件代理

- `src-tauri/src/phone/mod.rs:12-21` 文件头自己写明拓扑：
  `手机浏览器 ──HTTP(LAN)──▶ [Rust phone 服务] ──event──▶ [WebView TS phone-link]`
- `mod.rs:280` 注释：`未运行则 bind 0.0.0.0:0`；`:303` `TcpListener::bind("0.0.0.0:0")`
  —— **绑所有网卡，明文 HTTP**
- `mod.rs:41` `PAIR_TTL_MS = 5min`；`:42` `MAX_DEVICES = 8`
- `mod.rs:519` 配对成功后下发：
  `codem_phone=<secret>; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`
- 配对模型（`mod.rs:11-16` 注释）：桌面点"开始"→ 生成带 token 的配对 URL → 手机打开 `/pair?token=`
  → 等待页轮询 → 桌面 approve → 下发 cookie；secret 以 **sha256** 落 `devices.json`（`:57`）
- 代理：Rust 把 `/api/*` 请求经 `phone-request` 事件抛给 WebView，TS 处理完 `phone_respond` 回 JSON
- **明文 HTTP + LAN cookie**：`mod.rs:19-20` 自己标注为 **MVP 安全水位**

### 3.2 路由面：只有 5 条，纯读 + 发消息

`src/core/phone-link/phone-link.ts:71-83`（`parsePhonePath`）就是全部：

| 路由 | 作用 | 证据 |
|---|---|---|
| `GET /api/status` | 桌面当前项目/会话 | `phone-link.ts:289-299` |
| `GET /api/sessions` | 全部项目会话 | `:300-303` |
| `GET /api/sessions/<id>/messages?limit=N` | 会话消息（≤200） | `:304-314` |
| `POST /api/chat` | 续聊一轮（**先 202 再后台跑**） | `:315-329` |
| `POST /api/chat/new` | 新会话 + 一轮 | `:11` |

### 3.3 消息保真度：只有 `id/role/content/timestamp`

`phone-link.ts:95-100` 的 `PhoneMessageView` 与 `:146` 的 `mapMessages` 明确只取这四个字段 ——
**没有工具调用、没有 reasoning、没有附件、没有生成文件**。

### 3.4 结果获取：**轮询**，没有推流

`phone-link.ts:200-206` 注释说明：`POST /api/chat` 先回 202，完整回合可能几分钟，
**手机端只能靠轮询 messages 拿结果**。（`app.html:98` 确实是 `setInterval` 式拉取。）

### 3.5 失败可见性做得不错（这是我们的优点，别丢）

`phone-link.ts:207-220` `noteTurnFailure`：前置校验失败（引擎未就绪/会话不存在/无工作区/会话忙）
会**落一条 `system/error` 消息**，手机刷新就能看到"为什么没反应"。
注释 `:200-205` 记录了原缺陷：以前只 `console.warn`，手机看到"已发送、处理中"然后**永远没有回复**。

### 3.6 微信通道：审批是**自动拒绝**，不是远端交互

`src/core/wechat-bridge/wechat-bridge.ts:665` 注释原文：

> `// onPermissionRequest 缺省策略已安全：full→放行；否则自动拒绝。`

也就是说：**微信/手机这一侧根本没有"允许一次/拒绝"的交互**，需要审批的工具调用会被静默否掉。
对照 DSH 的 `approvals.ts:69-72`（推到远端让用户点）—— 这是体验差距最大的一处。

---

## 4. 三向对照表

| 维度 | DSH·Agents Anywhere 插件 | DSH 官方 LAN HTTPS | **我们（Codem）** |
|---|---|---|---|
| 控制通道绑定 | `127.0.0.1`（**从不对 LAN 开**） | 上游 `127.0.0.1` + 边缘 `0.0.0.0` | **`0.0.0.0`（直接对 LAN 开）** |
| 谁能连上 | 中继服务器（出站） | 局域网普通浏览器 | 局域网任意浏览器 |
| 跨网络（手机在外面） | ✅ 经中继 | ❌ | ❌ |
| 传输加密 | 到中继是 HTTPS | **HTTPS/WSS（自签 CA + 指纹）** | ❌ **明文 HTTP** |
| 鉴权 | 32B token + `timingSafeEqual` + 一次性 OAuth code | capability token + Host 白名单 + 抗 rebinding | cookie secret（sha256 落盘） |
| 令牌比对 | 恒定时间（`timingSafeEqual`） | 恒定时间（`timingSafeEqual`） | ⚠️ **普通 `==`**（`mod.rs:205`：`d.secret_hash == hash`）。**注意别夸大**：比的是 sha256 摘要，攻击者要利用前缀时序得先找到摘要前缀的原像，sha256 下不可行 ⇒ **实际风险低**；但恒定时间是一行的事，属该改的姿势问题 |
| 单实例保护 | OS 租约（`acquireManagerLock`） | 端口冲突逐个 +1 重试（≤32 次） | ⚠️ **只有进程内 `running` 标志**（`mod.rs:283-284`）。`src-tauri/Cargo.toml` 里**没有** `single-instance` 插件 ⇒ 开两个应用实例时各自绑自己的随机端口、各自一份 `devices.json`：不撞车，但**配对设备互不相通** |
| 远端中断当前轮 | ✅ `session.interrupt` | —（同一 UI，无"远端"概念） | ❌ 只有内部超时兜底 |
| 远端改模型/权限 | ✅ `updateSelections` + 三个 catalog | ✅（就是完整 Web UI） | ❌ |
| **远端审批（允许一次/拒绝）** | ✅ 单次生效 + 防多端竞争 + 过期 | ✅（完整 UI） | ❌ **自动拒绝**（wechat `:665`） |
| 远端问答（ask_user_question） | ✅ 复用官方问答表单 | ✅ | ❌ |
| 多端在场感知 | ✅ `selection` → presence | —（单 UI） | ❌ |
| 历史保真 | ✅ 工具/推理/图片/压缩标记/审批历史全投影 | ✅ 完整 UI | ❌ 只有 `role/content` |
| 结果获取 | ✅ 事件流 + ACK + 检查点 | ✅ 同 UI | ❌ **轮询** |
| 分页与体积预算 | ✅ 1000 条/7 MiB/帧 | n/a | 简单 `limit` |
| 失败可见 | ✅ 结构化 code + message | ✅ | ✅（`system/error` 落库，做得好） |
| 手机配对 | 扫码（服务端临时凭据） | 输网址（+ 装 CA） | ✅ **桌面 approve 配对**（比 DSH 更严） |
| 需要云账号 | ✅ 是（或自建服务） | ❌ 否 | ❌ 否 |

---

## 5. 差距清单（按"不做就等于功能残缺"排序）

**P0 —— 功能残缺，且用户会直接撞上**

1. **远端审批缺失**：手机/微信发起的回合里，任何需要批准的工具调用被**自动拒绝**。
   用户看到的现象是"任务莫名没做"，而不是"它在等你说同意"。
2. **结果靠轮询**：长回合（几分钟）在手机上就是"发出去 → 不知道在干嘛 → 忽然出现一段结果"。
   没有增量、没有进行中状态、没有工具进度。
3. **没有中断入口**：手机上发现跑偏了，**没有任何办法停下来**，只能等超时（8 分钟）。
4. **历史保真太薄**：手机上看不到工具调用/推理/改动文件 —— 而这几样恰恰是"这个 agent 在干什么"的全部信息。

**P1 —— 明显落后**

5. **明文 HTTP**：同网段任何人可嗅探/篡改；cookie 一旦泄露即长期有效（1 年）。
6. **不校验 Host / 无抗 rebinding**：恶意网页可诱导内网浏览器打我们的 LAN 端口（DNS rebinding）。
7. **无跨网络能力**：手机在公司/外网就完全用不了。

**P2 —— 锦上添花**

8. 多端在场感知（两个客户端同时开着时的"当前会话"一致性）。
9. 远端改模型/权限档。
10. 会话列表分页与体积预算（现在是一次性 300 条 + 每会话 `limit`）。

---

## 6. 改进计划

> 总原则（**建议**）：**抄 DSH 的机制，不抄它的部署形态。**
> DSH 那套需要一个云账号体系（OAuth + 设备绑定 + 中继），我们没有也不该为此建云。
> 但它的**架构取舍**（控制通道只绑回环、边缘做 HTTPS、能力按宿主服务协商、
> 事件驱动 + 检查点、审批一次性生效）是可以直接搬的，而且搬完我们比现在安全得多。

### 阶段 0（先止血，1 个版本内）—— 不加新功能，先把"残缺"补齐

| # | 做什么 | 落点 | 验收 |
|---|---|---|---|
| 0.1 | **远端审批**：把待批准请求推到手机/微信，给「允许一次 / 拒绝」两个动作 | 新增 `src/core/remote-approval/`；复用 `executeSessionTurn` 的 `onPermissionRequest`（现在 wechat 传空 → `wechat-bridge.ts:665`）；手机 `app.html` 加卡片 | 受控工具在手机上出现卡片；点"允许一次"后工具真的执行；点"拒绝"落到错误消息；**同一次请求只能批一次**（第二次点回 stale） |
| 0.2 | **中断入口**：手机上一个「停止」按钮 | 复用已有 `cancelSessionExecution`（`phone-link.ts:23` 已 import）；加 `POST /api/chat/cancel` | 长回合中点停止 ⇒ 回合在数秒内结束，且桌面端状态一致 |
| 0.3 | **进行中状态**：把 `run-status-tracker` 的阶段暴露给手机 | 加 `GET /api/sessions/<id>/run` | 手机能看到"思考中/在调工具/在等批准" |
| 0.4 | **历史保真**：`PhoneMessageView` 增加 `toolCalls`（名字+状态，参数与结果**按上限截断**）与 `reasoning`（可选） | `phone-link.ts:95-100,146` | 手机能看到"调了 bash、编辑了 a.ts"；开关可关（省流量） |

### 阶段 1（安全对齐）—— 把明文 HTTP 换掉

| # | 做什么 | 落点 | 验收 |
|---|---|---|---|
| 1.1 | **LAN HTTPS/WSS**：Rust 侧自签 CA（CA 长有效期 + 叶子短有效期）+ SAN 只放规范化 IPv4；导出 **CA 指纹**给用户核对 | `src-tauri/src/phone/`；参考 DSH `lan-https-certificate` 的形状 | 浏览器 `https://<lan-ip>:<port>/` 可访问；指纹与桌面显示一致 |
| 1.2 | **上游只绑回环**：把"对 LAN 开"的只有 HTTPS 边缘，把 HTTP 上游收到 `127.0.0.1` | 同上（现在 `mod.rs:303` 直接 `0.0.0.0`） | `netstat` 只看到边缘端口在 `0.0.0.0`，上游在 `127.0.0.1` |
| 1.3 | **Host 白名单 + 抗 rebinding**：校验 `Host` 属于本机允许地址集，且拒绝跨站来源 | 同上 | 用改 Host 的请求测：403 |
| 1.4 | **令牌恒定时间比对 + 单实例保护** | `mod.rs` 配对/校验处 | 代码审查 + 单测；两个实例不能同时服务 |
| 1.5 | 缩短 cookie 寿命 / 加轮换（现在 1 年，`mod.rs:519`） | 同上 | 过期需重新配对；桌面可一键踢掉所有设备 |

### 阶段 2（把"轮询"换成"推"）

| # | 做什么 | 落点 | 验收 |
|---|---|---|---|
| 2.1 | `/api/events`（SSE 起步，之后可上 WSS）：推 delta，而不是让手机拉全量 | `phone-link.ts` + `app.html`；事件源用现有 `SessionMessageBus` / 事件日志 | 长回合期间手机**无需轮询**即可增量看到输出；断线重连能补齐 |
| 2.2 | 给每批一个 `seq`，客户端 ACK 后才推进"已投递"游标 | 同上 | 断线重连不重复也不丢（照 DSH `runtime.sync.ack` 的形状） |
| 2.3 | 分页 + 体积预算（每帧条数上限 + 字节上限） | 同上 | 大会话不撑爆手机 |

### 阶段 3（跨网络，可选，用户自持出口）

| # | 做什么 | 说明（**建议**） |
|---|---|---|
| 3.1 | **不建云**。提供"自带出口"文档与配置：Tailscale / Cloudflare Tunnel / 用户自己的 VPS 反代 | 我们**没有**现成的公网代理实现（`src/core/` 下没有 net/proxy 目录，`src-tauri/src/` 只有 `ilink` 与 `phone`）⇒ 这条路是"只给文档与配置指引"，不含我们自己的代码；好处是跨网络的责任交给用户自己的基础设施，我们不碰用户数据 |
| 3.2 | 若确有需求：实现 **egress connector** 模式 —— 桌面侧只出站长连，和一个用户指定的中继握手 | 这才是真正对标 DSH 的中继形态；工程量与运维责任都很大，**建议放到有明确需求之后** |

### 阶段 4（体验收尾）

| # | 做什么 |
|---|---|
| 4.1 | 多端在场感知（谁在看哪个会话） |
| 4.2 | 远端改模型/权限档（需要先有目录接口） |
| 4.3 | 手机端 UI 对齐桌面语义（工具卡片、审批卡片、压缩标记） |

---

## 7. 明确**不抄**的（以及为什么）

| DSH 的做法 | 为什么不抄 |
|---|---|
| 云账号 + 设备绑定 + OAuth 授权链 | 我们没有任何服务端资产；引入账号体系会改变产品定位（本地优先），且要承担凭据托管责任。**若将来真要，先做阶段 3.1 让用户自持出库。** |
| 用 Python 子进程做 Connector（uv 拉 Python 3.12 + venv） | 我们已经有 Rust 侧传输层；再引一个 Python 运行时是纯粹的体积与启动复杂度。**用 Rust 做 egress 更贴合现状。** |
| 手写 TCP + 换行 JSON-RPC | DSH 这么做是因为它的宿主是 Node 且要跟 Python 讲协议。我们两边都是自己的代码，**HTTP/SSE + WSS 更省事，还能直接复用浏览器的重连与代理语义。** |
| 把 Android/iOS 原生 App 作为唯一手机端 | 我们是 WebView 页面路线，浏览器即可用；原生 App 是另一个量级投入。 |
| 复用官方侧栏扩展点挂入口 | 那是 DSH 的插件体系。我们是自家 UI，直接做设置页入口即可。 |

---

## 8. 诚实边界与风险

1. **我没有实机验证 DSH 的远程控制**。上文 DSH 侧的一切都来自源码（sourcemap 原始 TS）与随包文档；
   它的**实际手感**（配对成功率、弱网表现、手机端交互）我不知道，也不做评价。
2. `_aa-src` **不是完整仓库**：`src/client/features/**` 的 TSX 与 Python Connector 的真源码不在里面，
   这两处的描述来自 `TECHNICAL.md` / `RUNTIME_READS.md` 的**文字**。
3. 我方现状里原本有三处标为「待查」的，本文收尾时**已逐条读代码核实**（结果写进 §4 表格）：
   令牌比对是普通 `==`（比的是摘要，故实际风险低）、单实例只有进程内标志、没有现成的公网代理实现。
   **这份文档里不再留"待查"** —— 有结论的写结论，没结论的写"不知道"。
4. **阶段 1 的 HTTPS 会带来一个真实代价**：自签证书在手机上要用户手动信任（或每次告警）。
   DSH 的解法是让人装 CA 并核对指纹 —— 我们要么照做，要么接受"每次红警告"。
   这是产品决策，不是技术细节。
5. **阶段 0.1（远端审批）是这批里风险最高的一项**：它把"是否允许执行一个可能破坏性的操作"
   的决定权交给了一个走网络的路径。实施时必须满足：**默认拒绝**、
   **一次性生效**（照 `approvals.ts:14` 的契约）、**turn/end 即过期**（`approvals.ts:94-99`）、
   且**不可用时回退到桌面本地询问**（不能让手机掉线导致所有工具都跑不了）。
6. 本文只覆盖「远程控制」这一条。DSH 那条 LAN HTTPS 我列出来是为了**对齐安全设计**，
   不代表我们也要做"把整个 Web UI 给浏览器"（那是另一个产品选择）。

---

## 9. 建议的下一步（需要你定一件事）

阶段 0 的四项（远端审批 / 中断 / 进行中 / 历史保真）**无论走哪条路都要做**，
且都不需要任何服务端，我建议**先做这批**。

真正需要你拍板的是**跨网络那一步**：

- **只做局域网**（阶段 0 + 1 + 2）：手机在家/办公室同网可用，安全等级对齐到 DSH 的 LAN HTTPS 水平。
  **不需要任何账号与服务器。**
- **要跨网络**（再加阶段 3）：手机在外面也能用。但必须先选是
  **自带出口**（Tailscale / Cloudflare Tunnel / 用户自己的 VPS，我们不碰数据），
  还是**自建中继**（我们提供连接器，用户自己部署）。

---

## 10. 实施状态

> 用户已拍板：**要跨网络 + 自建中继**（阶段 3.2），且**现在就开始阶段 0**。
> 阶段 3.2 排在后面，本节只记已完成的部分。

### 阶段 1 —— 已完成（v1.16.212）

| 项 | 落点 | 判据 |
|---|---|---|
| 1.1 LAN HTTPS + 自签 CA | 新增 `src-tauri/src/phone/tls.rs`（rcgen + rustls）；CA **3650 天**、叶子 **30 天**（对齐 DSH `lan-https-certificate:17-18`）、SAN 只放**规范化后的 IP**、CA 尽量复用（手机只信任一次）、叶子按需轮换；桌面显示 CA 指纹并支持导出证书 | `edge_test.rs` E1/E6（**以 IP 作 server name 能完成握手 = SAN 真的覆盖了该 IP**）、LNX-6、`tls.rs` 单测 |
| 1.2 上游收回回环 | 上游 `TcpListener::bind("127.0.0.1:0")`；边缘 `0.0.0.0:0` —— **局域网上不再有明文监听** | LNX-2（断言 `0.0.0.0` 的绑定**只有一处**且属于边缘）、E5 |
| 1.3 Host 白名单 + 抗 rebinding | `guard::edge_verdict`（Host 白名单 / 拒跨站）；边缘注入**每次运行随机**的标记，上游只认带标记的请求 | E2（陌生 Host ⇒ 421 且**上游根本没被连过**）、E3（跨站 ⇒ 403）、E4（伪造标记被**删除**后替换）、RAW/LNX-5 |
| 1.4 恒定时间比对 | `timing_safe_eq` 去掉「长度不等提前返回」；`auth_device` 从 `find(|d| d.secret_hash == hash)` 改为**遍历全部设备**做常数时间比较（不再泄露"第几个命中"） | `guard`/`mod` 单测 + LNX-7 |
| 1.5 cookie 硬化 | `HttpOnly; Secure; SameSite=Strict`，`Max-Age` 从 **1 年收到 30 天** | LNX-7（含"旧硬编码必须消失"的反向判据） |

**变异自证 8/8（Rust 4 + TS 4，全部验过变红）**：去掉 Host 判定 / 去掉跨站判定 /
标记改成只追加不删除 / 上游准入恒放行 / 上游绑回 `0.0.0.0` / cookie 退回 1 年且去 Secure /
界面文案退回「明文 HTTP」/ `normalizeState` 给 `https` 编造默认值。

**这张设计里唯一真正的安全边界，必须说清楚**：证书是**自签**的，
所以「手机信任这张证书」这一步**不构成**对中间人的防护 ——
真正的边界是**用户把桌面上显示的指纹与手机证书详情里的指纹逐段核对**。
因此实现上做了两件事：① 指纹必须在设置卡里**显著可见**（`data-testid="phone-ca-fingerprint"`）；
② 拿不到指纹时界面显示**红色警告并劝阻配对**，而不是显示成"一切正常"。

**顺带修掉/发现的**（都记档）：
① 模块头部注释还写着旧设计（"明文 HTTP""Max-Age=31536000""0.0.0.0:0"）——
   被 LNX-7 的反向判据**当场抓住**后才改的；
② 手机页面里一个 `placeholder` 还是 `http://`，现在会误导用户以为要连明文；
③ **变异脚本自身的坑**：`copyFileSync` 还原后 mtime 没往前推，cargo 复用了
   变异时编译的测试二进制 ⇒「还原后复跑」给出**假红**，我为此白查了一轮。
   还原函数现在会显式推进 mtime。**一次性工具的正确性也要保证，否则它会骗你。**

### 尚未开始

- 阶段 2（事件流替代轮询 + `seq`/ACK + 分页预算）；
- 阶段 3.2（用户自建中继的 egress connector）；
- 阶段 4（多端在场感知 / 远端改模型与权限 / 手机 UI 语义对齐）。

### 阶段 1 的补丁 —— v1.16.213

**真机端到端验证（`_verify-212-lan-https.mjs`）当场抓到 1.16.212 的一个真 bug**：

`start_server` 有**两条**返回路径 ——「已运行 ⇒ 提前返回」与「刚启动完」。
1.16.212 只在后者改成 `https` 并带上指纹，**前者仍手写 `http://` 且不带指纹**。
而应用启动时会 `autoStart`，所以用户点到的每一次「开始配对 / 刷新配对二维码」
走的都是那条提前返回的路径；更糟的是 `phone-link.ts` 拿这个返回值**覆盖状态缓存**，
于是设置卡上那串"必须核对的指纹"**显示不出来**，配对链接还可能被写成 `http://`
（而局域网侧已经没有明文监听 ⇒ 扫出来根本连不上）。

- 修法：两条路径**共用同一个 `start_response()`** —— 这个响应只剩一种形状。
- 判据 **LNX-9**：代码里不得再出现 `format!("http://`；`start_response` 必须恰好 3 次
  （1 定义 + 2 调用）；提前返回那条必须带 CA 指纹。变异自证已验过会变红。
- **教训（两条）**：
  1. **同一个响应不要在两处拼** —— 两处就一定有一处先腐化；
  2. **"已运行 / 已存在"这类分支只有真机端到端才走到**，
     单元测试与集成测试都不会覆盖到它。这正是"发版并装机验证"这一步的价值。

### 阶段 0 —— 已完成（v1.16.211）

| 项 | 落点 | 判据 |
|---|---|---|
| 0.1 远端审批 | 新增 `src/core/permission/approval-broker.ts`；`phone-link.ts` 与 `wechat-bridge.ts` 的回合接入；`App.tsx` 桌面回退；手机页面审批卡片 | `approval-broker.test.ts`（AB-1..AB-10，11 条）+ `remote-approval-wiring.test.ts`（RAW-1..RAW-10） |
| 0.2 远端中断 | `POST /api/chat/cancel`，复用既有的 `cancelSessionExecution`（`executor.ts:780-785`）；手机「停止」按钮 | RAW-8 + RAW-10 |
| 0.3 进行中状态 | `GET /api/sessions/<id>/run`，复用 `isSessionExecuting`；手机状态条 | RAW-8 + RAW-10 |
| 0.4 历史保真 | `PhoneMessageView` 增加 `toolCalls` / `reasoning`（`?reasoning=1` 按需）/ `generatedFiles`，全部有上限；手机渲染工具卡（失败的显红边） | RAW-9 + RAW-10 |

**阶段 0 的取舍（与 §6 一致，实施时逐条落实）**：

1. **只给两个动作**（`allow` / `deny`），远端回答的 `alwaysAllow` **恒为 false** ——
   照 DSH `approvals.ts:14` 的「a grant always applies once」；
2. **刻意不设超时**（与 `permission.ts:239-243` 的既有约定一致），
   悬空由调用方在回合收尾时 `closeSessionApprovals()` 按**拒绝**收口（fail-closed）；
3. **回答只生效一次**：第二个回答方拿 `approval_not_pending`，且**不能改写已有结果**；
4. **桌面是共用同一张表的另一个回答方**，不是额外机制 —— 所以手机掉线时桌面照样能答；
5. **入参消毒**：只保留已知字段、长字段截断并**注明原长**；
   存的是**有界结构**而不是原始入参（`write` 的 `content` 可能几 MB），
   同一份结构既喂给桌面 `PermissionDialog`，也渲染成手机的预览文本。

**变异自证 8/8**：broker 侧 4 个（去掉一次性检查 / 收尾改成放行 / 放开 alwaysAllow /
去掉有界回收），接线侧 4 个（去掉收口 / 颠倒审批与跑回合的顺序 / 退回静默 auto-deny /
手机页面不拉待批准）。

**装机版端到端验证（9/9，`_verify-211-remote-api.mjs`）**：走**真实配对流程**
（`phone_start` → 拿 token → 桌面 `phone_decide(approved)` → `pair-state` 取 cookie），
然后带 cookie 直接打新端点：

| 检查 | 结果 |
|---|---|
| 未批准时 `/api/pair-state` = 200 waiting | ✅ |
| 桌面批准配对成功 | ✅ |
| 批准后拿到会话 cookie | ✅ |
| `GET /api/approvals` = 200 + 数组（0.1） | ✅ |
| 既有 `/api/sessions` 仍正常 | ✅ |
| `GET /api/sessions/<id>/run` = 200 + `running` 布尔（0.3） | ✅ |
| `POST /api/chat/cancel` = 200 + `wasRunning`（0.2） | ✅ |
| 回答不存在的审批 ⇒ **409 + `approval_not_pending`**（如实拒绝，不假装成功） | ✅ |
| 非法动作 ⇒ **400**（远端没有"总是允许"这个选项） | ✅ |

⚠️ 这一步同样抓到我自己两个错（都记档）：
① `/api/pair-state` **必须带 token**（`mod.rs:457`），第一版没带，拿到 `403 {"state":"invalid"}`
——那不是产品 bug，是我漏了参数；
② `phone_unpair` **需要 `deviceId`**，第一版没传 ⇒ invoke reject、测试设备留在
`devices.json` 里（事后手工清掉）。**收尾代码也要读一遍被调方的签名，不能想当然。**

⚠️ **其中两条是我自己写错后被用例/变异抓回来的，记在这里**：

- **AB-7**：预览第一版遇到 `path` 就直接返回路径、把 `content` 整个丢掉 ⇒
  手机上只显示一行路径，用户无法判断"要往里写什么"。判据当场变红。
- **RAW-10**：第一版只断言 `toContain("/api/approvals")`，变异把请求改成
  `/api/approvals-DISABLED?sessionId=` 之后**照样全绿**（前缀匹配）。
  已改成断言**完整调用形态**，再测才变红。**判据要盯"它真的在拉这个 URL"。**

### 尚未开始（阶段 0 视角，已被上面的阶段 1 覆盖）

- 阶段 1（LAN HTTPS + CA 指纹 / 上游收回回环 / Host 白名单 + 抗 rebinding /
  恒定时间比对 / 缩短 cookie 寿命）—— **已在 v1.16.212 完成，见本文后面的阶段 1 小节**；
- 阶段 2（事件流替代轮询 + `seq`/ACK + 分页预算）；
- 阶段 3.2（用户自建中继的 egress connector）；
- 阶段 4（多端在场感知 / 远端改模型与权限 / 手机 UI 语义对齐）。

---

## 11. 策略修正：完全对标「出站中继」（用户口径，覆盖 §7 第一条）

### 11.1 AA 的真实策略（四条通道，只有一条是它的资产）

读 `src/host/connector/process.ts` 才看清全貌 —— AA 不是"一条连接"，是**四条**：

| # | 通道 | 传输 | 凭据 | 证据 |
|---|---|---|---|---|
| 1 | 手机 / Web App ↔ **AA 云** | HTTPS | 用户账号会话 | `TECHNICAL.md:12-18` |
| 2 | **Connector ↔ AA 云（出站）** | HTTPS 长连，心跳 **20s**、重连 **3s**、同步 **30s** | `connectorId` + `connectorToken` | `connector/process.ts:126-135` |
| 3 | Connector ↔ DSH 插件运行时 | **本机 127.0.0.1** 裸 TCP JSON-RPC | `endpoint.json` 里的 32 字节 token | `dsh-runtime/server.ts:13,60-64,160-170` |
| 4 | 插件 ↔ Connector **进程** | **stdio** JSON-RPC 2.0，换行分隔，**1 MiB** 帧上限 | — | `connector/process.ts:15,250-261` |

第 4 条的方法只有三个：`connector.getState` / `connector.start` / `connector.stop`
（`process.ts:193-195,225`），另有 `connector/state` 通知（`:272`）；
错误码 `-32009` + `data.reason='connector_already_running'` = 所有权冲突（`:280-281`）。

**关键结论：只有第 1、2 条里的那个"云"是它的资产，其余全是桌面侧机制。
而第 3 条与我们阶段 1 做的「回环上游 + 每次运行随机令牌」是同一个形状。**

### 11.2 Connector 的配置契约（逐字对齐）

`connector/process.ts:126-135` 落盘的 `connector.json` 字段我们**照抄字段名**：

```
serverUrl / connectorId / connectorToken / statePath
heartbeatSeconds(20) / reconnectSeconds(3)
syncIntervalSeconds(30) / syncExistingOnConnect(true)
```

启动方式它对标不了（它是 `uv run anywhere-cli rpc`，拉 235 MiB 的 Python 轮子），
但**这条不是策略**，§7 保留"不引 Python 运行时"这一条。

### 11.3 我们要做的形态（同一个策略，唯一差别是"谁来运营中继"）

    手机浏览器 ──HTTPS──▶ [Codem 中继（用户自持：VPS / 家里的小主机 / 本机）]
                              ▲
                              │ 出站长连（connectorId + connectorToken，心跳/重连/同步）
                              │
                        [Codem egress connector]（Rust，进程内任务）
                              │
                              │ 本机 127.0.0.1 + 边缘令牌（= AA 的第 3 条，已在阶段 1 建好）
                              ▼
                        [WebView TS phone-link] → 会话/消息/回合

**唯一与 AA 不同的地方：中继由用户自己跑，不走我们的 SaaS、不要账号体系。**
这是**部署差别**，不是策略差别 —— 策略（谁连谁、凭据怎么发、桌面开不开 LAN 口）
与 AA 完全一致：**桌面不为这条路径开任何 LAN 端口，只出站。**

中继设计成**纯隧道**：它不认识我们的会话协议，只把手机发来的 HTTP 请求
原样透给 connector、把响应透回去。好处是：
① 中继上看不到会话语义（比 AA 的云更保守）；
② 桌面侧的路由/鉴权/审批代码**一行都不用改** —— 阶段 0 与阶段 1 的全部成果直接复用。

### 11.4 实施顺序

| 步 | 内容 | 状态 |
|---|---|---|
| **A** | **中继**（`tools/relay/codem-relay.mjs`，零依赖）：`/connector/hello`、`/connector/stream`(SSE)、`/connector/response`、`/app/pair`、`/app/*` 隧道 | ✅ **v1.16.214**；判据 `RL-1..RL-11` + 7 个变异自证 |
| **B** | **Connector**（`src-tauri/src/phone/connector.rs`）：`connector.json`、出站长连、心跳、重连、把推来的请求转给回环上游 | ✅ **v1.16.214**；字段逐字对齐 AA（两边配置可互读）+ 7 条 Rust 单测 |
| **C** | **配对**：桌面把 `pairingCode` 注册给中继；手机用码换中继会话 | ✅ 已实现（connector 每 2 秒检查配对码轮换，轮换即重连登记） |
| **D** | **设置界面**：中继地址、连接状态、connectorId、启停、日志 | ✅ **v1.16.215**；判据 `RUI-1..RUI-7` + 5 个变异自证 |
| **E** | **装机版端到端**：起中继 → 桌面连上 → 模拟手机走中继拿到会话 | ✅ **v1.16.214 验过 14/14**（`.preview-shot/_verify-relay-e2e.mjs`） |

### 11.5 A/B 步落地时"我自己的三个错"（都由判据/变异抓出，记档）

1. **`req.on('close')` 对没有 body 的 GET 会立刻触发**（Node 的语义是"请求流读完"，
   不是"连接断了"）⇒ SSE 一注册就被自己的 cleanup 清掉，connector 刚上线就被判"已断开"，
   手机请求全拿 503。**表象是"桌面侧什么都没收到"**，从表象极难定位。
   改成挂 `res.on('close')`。
2. **`server.close()` 只关监听、不关已建立的连接** ⇒ 测试里那条长活 SSE 让
   `await close()` 永不返回，报出来的是「Test timed out」，
   **看起来像被测的业务逻辑卡住**，而诊断日志显示 `request` 帧早就到了 ——
   **清理代码把自己的失败伪装成了被测代码的失败**。改用 `closeAllConnections()`。
3. **变异 1 没咬住** ⇒ 才发现 `RL-2` 根本没覆盖"常数时间比对"：
   把 `crypto.timingSafeEqual` 换成普通 `!==`，功能判据**照样全绿**
   （功能上"对的码通过、错的码拒绝"两种实现完全一样，差别只在耗时形状，
   而计时用例必然是 flaky 的）。补了 **RL-11 静态判据**，
   并如实写明：**这件事没法用行为判据证明，只能静态钉住。**
4. **`Secure` cookie 在明文链路上必然被丢**（端到端 E9 抓到的）：
   阶段 1 给 cookie 加了 `Secure`，但"手机到中继"那一跳的协议由**中继**决定，
   桌面看不到。明文中继下浏览器**直接丢弃**该 cookie ⇒ 手机永远 401，
   现象只是"一直登不上"。修法：connector 发 `X-Forwarded-Proto`
   （反向代理同一惯例），上游据此决定；**缺这个头时默认加 Secure**
   （LAN 边缘永远是 HTTPS，不许因中继的存在而被削弱）。
   这条改动**把阶段 1 的判据 LNX-7 弄红了**（它原来断言无条件 `Secure`），
   于是改成守三件事 + 变异自证。**判据该有的样子：不是为了永远绿，
   而是让每一次放宽都必须被明确记录并说清理由。**

---

## 12. 阶段 2 已完成（v1.16.216）—— 收尾

**阶段 2：把「轮询」换成「推」** 已完成，四个阶段至此全部落地。

### 12.1 为什么是长轮询而不是 SSE

中继是**纯隧道**（请求→应答），流式响应会被隧道的超时逻辑掐掉。
与其维护两套推送机制（其中一套只在一半场景可用，而且必然分叉），
选一条**两条路都能走**的：`GET /api/events?since=N&wait=10000`。

### 12.2 对标 DSH 同步模型的部分

| DSH | 我们 |
|---|---|
| `sync.subscribe` / `sync.ack`（带 checkpoint） | 客户端带 `since=<seq>`（HTTP 无状态，等价且更简单） |
| **不复用旧版本检查点**（宁可重来） | 检查点被挤出环形缓冲 ⇒ **`reset: true` 且不带事件**，客户端整批重取 |
| 每帧 ≤ 1000 项 / 7 MiB | 每批 ≤ 200 项 / 256 KiB + `hasMore` |
| `PAGE_LIFETIME = 120_000` | 页的寿命 = 长轮询挂起的那 10 秒 |

**如果这次只记一条，就记「检查点失效必须明说」**：轮询天然每次都重问全量，
推送一旦丢一段，客户端**不会自己发现**，会安静地少显示一段直到重启页面。
这是推送相对轮询**唯一新增的静默损坏模式**，所以 ES-3 的变异
（把 reset 判成"静默跳过"）必须变红 —— 它是这一阶段最重要的一条判据。

### 12.3 装机版实测（`_verify-216-push.mjs`，9/9）

| 验的是什么 | 结果 |
|---|---|
| **空闲 20 秒的请求数** | **2 次**（旧方案 3 次/2.6s ≈ **23 次**） |
| **桌面侧变化推到手机的延迟** | **15 ms** |
| 长轮询真的"挂住"（wait=2500） | 实测挂 **2515 ms** |
| 检查点超前 ⇒ 不误判 reset | ✅ |
| 检查点被丢弃 ⇒ reset 且不带事件 | ✅（真机难造 500+ 事件，行为由 ES-3/ES-6/ES-7 用灌爆缓冲验，各带变异） |
| 未配对 ⇒ 401 | ✅ |

### 12.4 一条旧判据被这次改动弄红（记档）

`RAW-4` 原来钉的是单表达式形状 `(request) => requestApproval(request, "phone")`。
阶段 2 要给手机推事件，回调必须变成块 ⇒ **判据当场红**，逼我把"会不会破坏原性质"想清楚。
结论是没破坏，但多了一条以前不需要守的：**必须把 Promise 返回给引擎**
（不返回则引擎 `await` 到 `undefined`、读 `.action` 直接抛）。
**判据的价值不是永远绿，而是让每一次改动都必须把理由说清楚。**

### 12.5 明确**不在**本轮范围

- **阶段 4**（多端在场感知 / 远端改模型与权限 / 手机 UI 语义对齐）—— 从未列入目标，未做。
- **跨网络的可达性**已由 §11 的出站中继解决；但**中继需要用户自己跑**（一段零依赖 Node 程序），
  且公网部署**必须**放在 HTTPS 反代之后（否则流量明文，中继启动时会警告）。
  这是**部署形态**，不是未完成的功能。

---

## 13. 调研：「能不能直接用 Agents Anywhere 的中继服务器？」

> 用户问：可以用 dsh 一样的中继服务器吗？是 Agents Anywhere 吗？对其他 agent 平台开放吗？
> 这一节只写**从证据能看到的**，看不到的明确标注。

### 13.1 是 Agents Anywhere，而且它**支持自建服务器**

| 事实 | 证据 |
|---|---|
| 云端地址 | `CLOUD_API_BASE_URL = 'https://web.agents-anywhere.com'`（`src/host/index.ts:9`） |
| 服务器可换 | `config.ts:18` `apiBaseUrl: z.string().default(CLOUD_API_BASE_URL)`；`config.ts:46` 走 `normalizeServerOrigin` |
| **明确支持自建** | `LoginRequest = { target: 'cloud' } \| { target: 'server'; serverUrl: string }`（`host/index.ts:29`）；界面文案「请选择云端或自建服务器。」（`locales.ts:82`） |
| 怎么验服务器 | `GET {apiBaseUrl}/api/v2/health` 必须返回 `{status:'ok'}`（`account/server.ts:25-30`），否则报「该地址未返回正常的 Agents Anywhere 服务」 |

所以答案是：**服务器可以不是它的云，可以是你自己的** —— 但那个"你自己的服务器"
必须是**一套 Agents Anywhere 服务端**，不是随便什么中继。

### 13.2 它的 connector 是**多平台**的（这就是"对谁开放"的答案）

connector 的 Python 源码**就捆绑在插件包里**：
`node_modules/@agents-anywhere/dsh-bridge-next/lib/bundled-connector/`
（`pyproject.toml` 里 `name = "anywhere-cli"`、`[project.scripts] anywhere-cli = "connector.cli:main"`；
`UV_DEFAULT_INDEX` 只是拉**依赖**，不是拉它自己 —— `connector/project.ts` 从
`config.connectorSourceDir` 复制这份捆绑源码）。

它内置的运行时目录 `connector/runtimes/` 下是：

```
claude    codex    dsh
```

**也就是说：它对 Claude Code、OpenAI Codex、DSH 这三个 agent 平台是开放的** ——
但这是**它主动适配**的结果，不是"任何人实现一个公开协议就能接"。
协议实现全在 `connector/server/*.py`（`client.py` / `rpc.py` / `pairing.py` /
`terminal_relay.py` / `urls.py`），依赖 `websockets>=16.0` ——
**是它的私有 WebSocket 协议，包里没有任何公开规范**。

账号/REST 面倒是从 TS 完全可见（`account/api.ts`）：

```
POST /api/v2/oauth/token           GET  /api/v2/auth/me
GET  /api/v2/connectors            POST /api/v2/connectors
GET  /api/v2/connectors/{id}       POST /api/v2/connectors/{id}/revoke
POST /api/v2/connector/auth        Authorization: Connector <id>:<token>
POST /api/v2/auth/mobile-login/qr  .../status  .../confirm
GET  /api/v2/health
```

### 13.3 所以「和 DSH 用一模一样的中继」具体有三条路

| 路 | 要做什么 | 代价 |
|---|---|---|
| **A. 直接跑它捆绑的 connector** | 用它的 `bundled-connector` + `uv run anywhere-cli rpc --config connector.json`，指向它的云或自建 AA 服务器 | 引入 Python 3.12 + uv + 首次约 235 MiB 依赖；**手机端要用它的 Web App**（中继只服务它自己的前端），我们的手机页面在那条路上没有位置；需要 AA 账号（云）或一套自建 AA 服务端 |
| **B. 照 `connector/server/*.py` 重实现它的协议** | 用 Rust 实现它的 WebSocket 协议 | 追一个**私有且会变**的协议；它一变我们就坏；同样要用它的 Web App |
| **C. 保持现状（我们自己的中继）** | 已实现并验过（§11） | 用户要自己跑一段零依赖 Node 程序；**但协议是我们的、手机端是我们的、不依赖任何第三方** |

### 13.4 我的建议与**我核实不了的事**

**建议保持 C**，理由不是"我们做得更好"，而是三条具体的：
1. 走 A/B 之后，**手机端 UI 就不是我们的了** —— 阶段 0/1/2 做的审批卡片、事件流、
   指纹核对在那条路上全部作废（它们是我们手机页面的能力）；
2. 走 A/B 等于把远程控制建在**别人的私有协议**上，它改协议我们就坏，
   而我们**没有追它的能力**（没有规范、只有 Python 实现）；
3. 现在这条路**已经验证过**（§11 + §12，装机端到端 14/14 与 9/9）。

**我无法核实的（不在我能看到的信息范围内）**：
- 把 Codem 接到 `web.agents-anywhere.com` 或自建 AA 服务端，**在许可条款上是否允许** ——
  插件包里没有可据以判断的材料；
- **AA 服务端软件本身怎么获取**（插件包里**没有**服务端代码，只有 connector）。

所以"如果可以"这个前提，我只能说：**技术上可行（走 A 最省事），
但代价是交出手机端并且依赖一个私有协议；许可问题我核实不了。**

### 13.5 与 DSH 的策略到底还有没有差别

**策略层面已经没有差别了**：都是"桌面出站长连到中继，手机连中继"。
剩下的差别只有一处，而且是**部署形态**不是策略：

| | DSH / AA | 我们 |
|---|---|---|
| 中继由谁跑 | 它的云（或你自建 AA 服务端） | **你自己跑**（零依赖 Node 一段程序） |
| 协议 | 它的私有 WebSocket | 我们的（纯隧道，中继看不懂会话） |
| 手机端 | 它的 Web App | 我们的手机页面（因此审批卡片/事件流/指纹核对都还在） |
| 账号体系 | 有（OAuth + 设备绑定） | 无 |

如果你想连账号体系也对齐（走 A），那是一个**产品定位决策**（本地优先 → 依赖第三方平台），
不是技术债 —— 说一声我就按 A 重做，但上面三条代价会同时到来。

---

## 14. 复刻蓝图：DSH / Agents Anywhere 的远程控制路径

> 用户口径：**完全复刻它的路径，不做并行机制。**
> 这一节是**读它捆绑 connector 的 Python 源码**得出的完整实现规格 ——
> 所有事实都在
> `…/dsh-bridge-next/lib/bundled-connector/connector/` 下，逐条标了文件与行号。
> 这一节的作用是：让"复刻"变成一份**可核对、可施工**的规格，而不是一句口号。

### 14.1 链路全貌（四条通道）

```
手机 / Web App ──HTTPS──▶ AA 服务端 ◀──WS 出站长连── Connector（Python，捆绑在插件里）
                              ▲                          │ stdio JSON-RPC（插件 ↔ 子进程）
                              │ REST: /connector/auth    ▼
                              │                       插件 host ←→ DSH 运行时
                              └── 本机 127.0.0.1 ── Connector → 插件运行时
```

### 14.2 鉴权链（逐行对齐）

| 步 | 做什么 | 证据 |
|---|---|---|
| 1 | `POST {server}/api/v2/connector/auth`，头 `Authorization: Connector <connectorId>:<connectorToken>` | `server/auth.py:47-51` |
| 2 | 返回 `{ accessToken: string, expiresIn: number }`；401 ⇒ **凭据失效，不再重试** | `auth.py:57-69` |
| 3 | 缓存 accessToken，**提前 60 秒**刷新 | `auth.py:13,74-83` |
| 4 | `GET {wss}://{host}/api/v2/connector/ws`，头 `Authorization: Bearer <accessToken>` + `X-Device-OS: windows\|macos\|linux` | `client.py:246-258`、`urls.py:24-27` |

**设备身份由此确定**：Bearer 令牌是**为该 connector 换来的**，所以服务端不需要额外的 connectorId 参数。

### 14.3 帧信封（三条）

```jsonc
{ "id": "<str>", "type": "request",      "method": "...", "params": ... }
{ "id": "<str>", "type": "response",     "ok": true, "result": ..., "error": {"...":"..."} }
{                "type": "notification", "method": "...", "params": ... }
```
（`server/protocol.py` 的 `RpcRequest` / `RpcResponse` / `RpcNotification`）

**握手**（`ProtocolHandshakeRequest`）：
```jsonc
{ "protocolVersions": ["1.0"], "connectorVersion": "2.0.0",
  "runtimes": [{ "runtime": "dsh", "runtimeVersion": "..." }] }
```
`RuntimeName = codex | claude | opencode | acp | dsh`（`protocol.py:15`）

### 14.4 版本与序号：**处处带 revision**

- `ProtocolRevisionClock`：单调微秒时钟，`next() = max(now_us, last+1)`（`protocol_revision.py:15-21`）
- `ProtocolCapabilitySet.revision`、`ProtocolModelCatalog.revision`、`ProtocolPermissionCatalog.revision`、
  `ProtocolNotice.revision` 都是它的实例
- 上限 `PROTOCOL_MAX_REVISION = 2^53-1`（`protocol.py:12`）

**这与我们阶段 2 的 `seq` 是同一个思想**，但它**逐层都带**（能力集/目录/通知各有各的 revision）。

### 14.5 selectionId 的派生（可确定性复算）

```python
raw = f"1:{runtime}:{catalog_type}:{canonical_json(identity)}"   # ensure_ascii=False, sort_keys, 紧凑分隔符
digest = base64url(sha256(raw)).rstrip("=")
return f"sel_{catalog_type}_{digest[:24]}"
```
（`protocol.py:126-133`）
—— 即"同一份 identity 在任何地方都算出同一个 id"。

### 14.6 方法清单（完整，来自 `local_rpc.py:15-32`、`capabilities.py:14-22` 与全量扫描）

**能力 ↔ 方法映射**（`capabilities.py:14-22`，可直接照抄）：

| capabilityId | method |
|---|---|
| `modelCatalog` | `catalog.model` / `catalog.effort` |
| `permissionCatalog` | `catalog.permission` |
| `steerTurn` | `session.steer` |
| `interruptTurn` | `session.interrupt` |
| `commands` | `session.commands` |
| `interactions` | `session.interaction.approval` |
| `attachments` | `runtime.attachment` |
| （`runtime.config`） | `runtime.config` / `runtime.configSchema` / `runtime.validateConfig` |

**会话/回合**：`session.create`、`session.discover`、`session.state`、`session.sync`、
`session.inventory.begin`、`session.inventory.complete`、`session.meta.upsert`、
`session.source.updated`、`session.state.updated`、`session.selections.update`、
`session.capabilities`、`session.notices`、`session.command.execute`、`session.turnEnded`、
`turn.start`、`turn.end`

**运行时**：`runtime.discover`、`runtime.start`、`runtime.stop`、`runtime.commands`、
`runtime.capabilities`、`runtime.capability.updated`、`runtime.catalog.updated`、
`runtime.modelCatalog`、`runtime.permissionCatalog`、`runtime.error`

**通知**：`connector.heartbeat`、`connector.preferencesUpdated`、
`protocol.capabilitiesUpdated`、`runtime.statusChanged`、
`timeline.sync`、`timeline.itemUpsert`

**本地能力（fs/shell/terminal）**：`fs.prepareDownload`、`fs.uploadPreparedDownload`、
`fs.writeFile`、`fs.readDir`、`fs.readText`、`shell.exec`、`shell.task.start`、
`shell.task.cancel`、`terminal.create/write/resize/close/rename/setPersistent/list/release/snapshot/relay.connect`

### 14.7 通知/交互模型 = 我们的审批代理，但**更完整**

`ProtocolNotice`（`protocol.py:99-121`）就是我们 `approval-broker` 的超集：

| 我们（阶段 0） | 它 |
|---|---|
| `status: open\|resolved\|closed\|expired` | `open\|responding\|response_accepted\|resolving\|resolved\|expired\|cancelled\|failed` |
| `action: allow\|deny` | `actions: [{actionId, label, style: primary\|secondary\|danger\|default, input:{required, schema, uiSchema}}]` |
| 靠 `sessionId` 关联 | `blocking: {scope: session\|tool_call\|runtime, targetId}` + `responseRequired` |
| — | `source: {runtime, component, approvalId, timelineItemId, operationId}` |
| — | `expiresAt`、`severity: info\|success\|warning\|error`、`interactionType`、`context` |

**所以复刻它 = 把我们的审批代理升级成它的 notice/interaction 模型**，而不是另建一套。

### 14.8 复刻的施工顺序（按依赖，不按大小）

| 步 | 内容 | 能否今天验证 |
|---|---|---|
| **R1** | WS 传输 + 三条信封 + 握手 + revision 时钟 + selectionId 派生 | ✅ 单测 + 变异 |
| **R2** | 鉴权链（`/connector/auth` 换 token、60 秒提前刷新、401 不重试） | ✅ 对着 mock |
| **R3** | capability set 发布 + `catalog.model/permission` + `session.selections.update` | ✅ 对着 mock |
| **R4** | notice/interaction（用它的状态机替换我们的 broker 状态机） | ✅ 单测 + 变异 |
| **R5** | `session.*` / `turn.*` 映射到已有能力面（会话/回合/中断/历史） | ✅ 对着 mock |
| **R6** | 对着**真 AA 服务端**跑通 | ❌ **需要一个服务端** |

### 14.8.1 施工进度

| 步 | 状态 | 证据 |
|---|---|---|
| **R1** 协议规格层 | ✅ 完成（未单独发版，随 R3 一起发） | `phone/aa_protocol.rs`，13 条判据 |
| **R2** 鉴权链 + WS 传输 | ✅ 完成，**对着 mock AA 服务端端到端跑通** | `phone/aa_connector.rs` + `phone/aa_mock_test.rs`，M1–M7 |
| **R3** 能力集发布 + 目录 + `session.selections.update` | 待做（能力集已发，目录与选择待接线） | — |
| **R4** notice/interaction 八态状态机替换现有审批 | 待做（状态机已建模，未接线） | — |
| **R5** `session.*` / `turn.*` 全量映射 | 部分：会话清单/状态/时间线/中断/选择/审批已映射，其余**如实回报未实现** | `map_aa_method_to_local` |
| **R6** 对着真服务端跑通 | ⛔ 阻塞：需要 AA 账号或自建服务端 | — |

**7 个变异自证全部咬住。** 其中变异 1（删掉键排序）**第一版没咬住**，暴露了一个真实盲区：

serde_json 的 `Map` 在我们当前构建里本就是 BTreeMap（键天然有序），所以"我们排了序"
这件事在 `Value` 这个输入上**无法被区分** —— 删掉 `keys.sort()` 判据照样全绿。

修法是把排序落到接收**插入顺序**的 `write_canonical_pairs` 上，并加判据
`sorts_keys_provably`（现在这条变异真的会红）。顺带纠正了本文档早先一句
**未经验证的断言**（原写 schemars 打开了 `preserve_order`，实测不成立）。

**另一条刻意不做的事：不发 `ProtocolHandshakeRequest`。** 它在 connector 与插件 TS 里
**都从未被使用**（全仓搜索只有定义处）。复刻的准则是"照它实际发的发" ——
多发一个服务端不预期的帧，最好是被忽略，最坏是被判协议错误。


**R1–R5 全部可以今天做完并验证**（我写一个**按同一份 spec 的 mock AA 服务端**，
只实现契约、不实现业务）。R6 卡在下面这一件事上。

### 14.9 唯一的硬阻塞：**服务端**

| 选项 | 现状 |
|---|---|
| 它的云 `https://web.agents-anywhere.com` | 需要 **AA 账号**（OAuth）。我没有账号，也不该替你注册 |
| 自建 AA 服务端 | 插件包里**只有 connector，没有服务端代码**（`lib/bundled-connector/` 是连接器）。我拿不到服务端软件 |
| 因此 R6 | **无法在不提供上述任一项的情况下完成** |

**另外一件我核实不了的事**：把 Codem 接到它的服务器上是否被许可 ——
插件包里没有 LICENSE/条款材料可据以判断。这不是技术问题，需要你确认。

### 14.10 与我方现状的映射（复刻不是从零）

| 它的概念 | 我们已有的对应物 | 复用程度 |
|---|---|---|
| `session.inventory.begin/complete`、`session.meta.upsert` | `flattenSessions()` + `PhoneSessionView` | 换名字与结构 |
| `session.state` / `session.state.updated` | `GET /api/sessions/<id>/run` | 换名字与结构 |
| `timeline.itemUpsert` / `timeline.sync` | `mapMessages()` + 阶段 2 的 `toolCalls/reasoning` | 换名字与结构 |
| `session.interaction.approval` | `approval-broker.ts` | **升级状态机** |
| `session.interrupt` | `cancelSessionExecution` | 直接映射 |
| `session.steer` | （我们没有） | 新做 |
| `catalog.model` / `session.selections.update` | 阶段 4 的 `catalog` / `selections` | 换名字与结构 |
| `catalog.permission` | 阶段 4 的权限档（**但我们只能收紧**） | **冲突，见下** |
| `revision` | 阶段 2 的 `seq` | 逐层扩展 |

### 14.11 一处**必须由你决定**的策略冲突

它允许远端改权限档（`session.selections.update` 带 permission）。
我们在阶段 4 定的规则是**只能收紧**，理由是"远端不能自己取消对自己的监督"。

复刻它就意味着**放弃那条规则** —— 也就是：拿到手机的人可以把权限档改成
"自动放行一切"，从此不再需要任何审批。

这**不是技术细节**，是安全姿态：

- 选**完全复刻** ⇒ 我把那条限制去掉，与它一致；
- 选**保留限制** ⇒ 这一条与它不同，我会在文档里标成"有意的偏离"。

我按你的话默认**完全复刻**（去掉限制），除非你另有交代 ——
但它会**削掉阶段 0 审批的实际意义**，所以我把这句话明确写在这里，不埋在代码里。

### 14.12 一处**关键发现**：DSH 运行时不用通用的 `sel_*` 方案

（阶段 R3 的实地结论，直接改变了我原来的实现。）

通用方案是 `protocol.py:126-133` 的 `protocol_selection_id`，产出 `sel_model_<24 字符>`。
**但 `dsh` 这一个运行时不用它** —— DSH 那一支另有一套 `dsh:` 前缀方案：

```
dsh:model:      <base64url( JSON.stringify([provider, model, effort|null]) )>
dsh:permission: <base64url( preset )>
timelineId:     "dsh_" + sha256_hex( external_session_id \0 kind \0 business_id )
```

证据（它捆绑包里的**两处**独立实现，语义一致）：
- 插件侧 TS：`host/dsh-runtime/selections.ts`（`modelSelectionId` / `permissionSelectionId`）
- connector 侧 Python：`connector/runtimes/dsh/identity.py`
- 目录构造：`host/dsh-runtime/catalogs.ts`（插件侧造目录，connector 只是**转发**）

**我一开始只实现了通用方案 —— 那对 `dsh` 运行时是错的。**
而这类错的可怕之处在于**它不会报错**：服务端与它存下来的选择用的是 `dsh:` 形式，
我们发 `sel_model_...` 的结果只是"用户选了模型但设备不认"。

这正是"读协议文件不够、必须读**这个运行时**的适配层"的实例：
`catalogs.py`（通用）与 `catalogs.ts`（DSH 专用）看名字像是一件事，实际是两套。

#### 必须照抄的三条严格性

1. **编码规范性**：解码后重编码必须与输入**逐字**相等（`selections.ts:14`）。
   挡住"同一份内容有多种 base64 写法"⇒ **同一个选择被当成两个**。
   它真正不可替代的一类是**载荷不是合法 UTF-8**：`_w`（字节 `0xFF`）是**规范**编码，
   解码器与字符集校验都拦不住，只有重编码复核能发现
   （`TextDecoder` 会换成 `U+FFFD`，再编码变成 `77-9`）。
   *这条判据是我漏掉的，变异自证当场把它抓了出来。*
2. **`custom` 权限档不可远端切换**，且拒绝空串、首尾空白、含 CR/LF（`selections.ts:38`）。
   `custom` 是"用户自定义的一整套权限"，远端把它当可选档套用 = 绕过用户定制。
3. **`parseSelections` 只认 `model` 与 `permission` 两个作用域**，且每个值必须**能解出来**
   才接受 —— 不做"先存下、以后再校验"。

#### 两侧各一份实现，必须逐字一致

- 插件侧（我们的渲染进程）：`src/core/phone-link/dsh-selection-id.ts`
- connector 侧（Rust）：`src-tauri/src/phone/aa_dsh_identity.rs`

它们必须产出**逐字相同**的 id，否则就是经典的"半边能跑"：
一端发出去的 id 另一端解不出来，而表现只是"选择不生效"。
两侧各用**同一组基准值**（由独立实现算出）钉住，任一侧改动都会被抓到。

**判据 R3-1..R3-9 + 7 个变异自证全部咬住。** 其中三条**第一版没咬住**，逐个查明：
- 变异 3（去掉规范性复核）⇒ 我漏了"非法 UTF-8"那类，已补判据；
- 变异 5（`effort` 用 `undefined`）⇒ **这条变异本身是假的**：
  `JSON.stringify` 对数组里的 `undefined` 输出 `null`，与 `?? null` 逐字相同；
  已换成真的会改变行为的写法；
- 变异 7（去掉作用域校验）⇒ 判据用的值**碰巧也不合法**，所以"报错"不是来自作用域校验；
  已改成用对该作用域本身合法的值。

### 14.13 R5：全量方法映射 + **去掉「只能收紧」**

#### 一处我先前的**事实性错误**（比策略错误更危险）

我前两轮把 **`session.interaction.approval`** 当成"回答审批"的入站方法。
读了 `runtime_rpc.py:54-77` 的 `METHODS` 才知道不是：

| | 实际是 |
|---|---|
| 入站请求方法 | **`interaction.respond`**（`{sessionId, noticeId, actionId, inputData?}`） |
| `session.interaction.approval` | 能力表里的**标签/通知**方法 |

**照我原来的写法，服务端发来的回答根本不会被处理** ——
手机点了"允许"会石沉大海，而日志上看不出任何异常。
这类错误的共同特征：**不报错、不影响其它功能、只是那个动作永远不生效**。

#### 策略反转：去掉「只能收紧」

阶段 4 定的"远端只能收紧权限档"已被**去掉**（用户口径：完全按 DSH 模式走，
而 DSH 允许远端改权限档）。

**后果，写在这里而不是埋在代码里**：远端可以把权限档改成「自动放行一切」，
**从那之后阶段 0 的整套远端审批不再生效**。这是**有意的取舍**，不是疏漏。

那条阶段 4 判据（S4-2/S4-3）被**反转而不是删掉** —— 改成钉新行为并把后果写在里面。
判据的作用是让每次改动都把理由说清楚，不是"永远绿"。

#### 方法表逐条归属

新增判据 `every_inbound_method_is_accounted_for`：它入站方法表的 23 条，
**要么被映射、要么登记为「明确不做」并写明理由**。
漏一条的后果是"服务端发过来我们回不支持，而看上去像它没发过" —— 极难归因。

`AaDispatch` 也从 `Option<LocalCall>` 改成三态（`Local` / `Inline` / `Unsupported`）：
旧写法里"本机就能回答"与"我们不做"**都是 `None`**，而这两件事对服务端是**相反的信号**。

#### 下一步（不需要服务端）

**把 AA connector 接进应用**：Tauri 命令（start/stop/status）+ 设置界面
（填服务端地址、`connectorId`/`connectorToken`、显示连接阶段）。
这一层做完，"接上真服务端就能用"，而它本身可以用 mock 验证。

---

## 15. 更正：不需要"买服务端"——就是**注册账号 + 登录**

> 用户问：*"我去 Agents Anywhere 注册个账号？还是他有专门的服务租赁，我要去买服务端？
> dsh 我看到登录 Agents Anywhere 账号就能用啊？一比一复刻，我们难道不是登录账号就能用？"*

**用户说得对，我前面的措辞是错的。** 这一节把实际流程写清楚，并记下我错在哪。

### 15.1 它的实际流程（逐行有据）

| 步 | 做什么 | 证据 |
|---|---|---|
| 1 | 用户在 AA **注册账号**并登录（OAuth，PKCE） | `host/account/api.ts:60-70`：`POST /api/v2/oauth/token`，`grant_type=authorization_code` + `code_verifier` |
| 2 | 用 token 读账号 | `GET /api/v2/auth/me`（`api.ts:71`） |
| 3 | **把本机注册成一台设备** | `POST /api/v2/connectors`，体 `{name, connectorKind:'cli', installationId}` ⇒ 返回 `{connector, connectorToken}`（`api.ts:91-99`） |
| 4 | 校验这对凭据 | `POST /api/v2/connector/auth`，头 `Authorization: Connector <id>:<token>`（`api.ts:101`） |
| 5 | connector 用它换 accessToken 并连 WS | `connector/server/auth.py:47-51` + `client.py:246-258` ← **这一步我已经实现了（R2）** |

**所以：注册账号 + 登录即可，没有"服务租赁"，也不用买任何东西。**
`{target:'server'}` 那个"自建服务器"是它给**不想用它的云**的人准备的**可选**分支，
不是必需项 —— 我先前把它说成前提，是我的错。

### 15.2 我错在哪

我把第 3 步（**注册本机拿 `connectorToken`**）**漏掉了**，于是要求用户
"手上要有一台服务端 / 或者把 `connectorId`+`connectorToken` 填进来"。
那是**把插件本该做的事推给了用户**：

- 在 DSH 里，用户**只登录**；`connectorToken` 是插件自己调 `POST /connectors` 换来的。
- 我只实现了第 5 步（connector 出站），然后让用户去手工准备第 3 步的产物。
- 结果就是用户看到的："为什么我要买服务端？DSH 登录一下就能用啊。"

**这就是"复刻漏了一段"的典型表现：代码能跑、判据全绿，
但用户要走的流程与 DSH 不一样。** 判据只钉了我实现的那一段，
没有钉"用户的完整旅程与 DSH 一致"。

### 15.3 要补的那一段

| | 内容 | 状态 |
|---|---|---|
| N1 | OAuth 登录（PKCE：生成 verifier/challenge、开浏览器、收 code、换 token） | **待做** |
| N2 | `GET /auth/me` 显示当前账号 | **待做** |
| N3 | `POST /connectors` 注册本机 ⇒ 拿 `connectorId`+`connectorToken` 并持久化 | **待做** |
| N4 | 设备列表 / 吊销（`GET /connectors`、`POST /connectors/{id}/revoke`） | **待做** |
| N5 | 用 N3 的凭据启动 connector | ✅ 已实现（R1–R5） |

### 15.4 我在它包里**看不到**的一样东西（这是"缺失的事实"，不是决策）

**`/oauth/authorize` 的 URL 与允许的 `redirect_uri` 看不到。**
它的 `exchange(code, verifier, redirectUri)` 把这三个当**入参**接进来，
说明 PKCE 的生成与"开浏览器"发生在**插件之外**（DSH 宿主侧），
而那部分代码**不在这个捆绑包里**。

我们能看到的只有客户端标识：`OAUTH_CLIENT_ID = 'agents-anywhere-dsh-plugin'`
（`contracts/index.ts:8`）——**那是它 DSH 插件的 OAuth 身份，不是我们的。**

所以 N1 有两种落地方式：

1. **用它那个 client id**（默认就填它）：开箱即用的可能性最大，
   但等于**以 DSH 插件的身份**去登录。redirect_uri 若被服务端白名单限制，就可能被拒。
2. **把 client id / authorize URL / redirect_uri 做成可配置**：
   默认填它的（行为与 DSH 一致），登录页跑不通时用户可以换成自己的注册值。

**我按第 2 种做**（默认它 + 可配），这样"登录就能用"是默认路径，
而它是唯一一处我需要**实测一次真实登录**才能确认的细节 —— 不是要用户做决定。

---

## 16. R6：**对着真服务端**验过了（自建 AA 服务端）

用户口径：**按方案 A（自建 AA 服务端）+ 装 Docker Desktop。**

### 16.1 先纠正一条我说错的事实

我先前说"插件包里只有 connector、拿不到服务端、许可核实不了"。**只看了插件包，
没去查它的仓库。** 实际上：

| 事实 | 证据 |
|---|---|
| 仓库是**开源**的（跨设备 Agent 工作台） | `anywhere-labs/Agents-Anywhere` |
| **许可证 MIT** | `README.zh-CN.md:161`「开源许可：MIT」 |
| **自托管是一等公民** | README 顶部标语「开源 · … · **自托管**」+ `self-hosted-Docker` 徽章 |
| 官方 Docker 部署 | `README.zh-CN.md:120-132`（`docker-compose.postgres.yml`） |
| 明确支持 DSH | 「连接运行 Codex、Claude Code 或 **DeepSeek Harness** 的工作设备」 |
| 服务端 = Python + FastAPI + PostgreSQL + Redis | `server/`、`AGENTS.md` 的目录地图 |

**所以"完全复刻"走得通**，而且比我先前说的干净：自建之后**不碰它的云、不借它的身份**
（`OAUTH_CLIENT_ID = 'agents-anywhere-dsh-plugin'` 是它插件的身份，
自建时你用的是自己服务器上的账号），MIT 也把许可问题解决了。

### 16.2 本机把真服务端跑起来了

它自己的测试用 `create_app(db_path)`（SQLite、不要 Postgres/Redis）—— **那是一个真的 HTTP 服务端**，
不是 mock。用它把服务端跑在本机 `127.0.0.1:8010`：

```
$ uv run uvicorn aa_launcher:app --host 127.0.0.1 --port 8010
GET /api/v2/health → {"status":"ok","version":"2.0.3", ...}
```

首次运行需要在日志里取 `setup-token` 建管理员。整套流程（建管理员 → 建连接器 → 拿凭据）
写在 `.preview-shot/_aa-setup.mjs`。

### 16.3 对着真服务端的验证结果

用**我们 connector 实际会发的帧**去打它（`.preview-shot/_aa-live.mjs`）：

| | 验的是什么 | 结果 |
|---|---|---|
| A1 | `POST /api/v2/connector/auth`，头 `Connector <id>:<token>` | ✅ 200，`{accessToken, expiresIn:900}` |
| A2 | WS 升级 `ws://…/api/v2/connector/ws` + `Bearer` + `X-Device-OS` | ✅ 升级成功 |
| A3 | 发 `protocol.capabilitiesUpdated` + `connector.heartbeat` 后连接仍存活 | ✅ 没被判协议错误 |
| A4 | 连接稳定保持 | ✅ |

**最要紧的一条**：它连上之后**立刻主动发来一条真请求**：

```json
{"id":"rpc_y8Ad9zJ__EM0Ng","type":"request","method":"runtime.discover","params":{}}
```

这正是 R5 里我实现成本机合成的那个方法（`AaDispatch::Inline`）——
**真服务端真的会调它**，而我们那张表覆盖住了。
把回路走完之后（`.preview-shot/_aa-seq.mjs`，应答逻辑镜像我们 Rust 的 dispatch 决策）：

> 它一共调了 1 次请求：`runtime.discover` —— **✅ 它调过的每个方法我们都有归属**。

也就是说：**鉴权链、WS 升级、帧信封、通知形状、方法归属，全部对着真服务端验过了** ——
不再是"对着我按 spec 写的 mock"，而是**对着它自己跑起来的服务端**。

### 16.4 还没做的（说清楚，别当成已经做完）

| | 状态 |
|---|---|
| 用**我们真正的 Rust connector**（而不是 JS 镜像）连真服务端 | 待做：要在 Codem 里启动 connector 并观察 |
| 从 Web 端建会话、走 `session.create` / `send_message` / 通知回传 | 待做（需要 `web-next` 跑起来 + 渲染进程供数据） |
| **Postgres 那一套**（生产形态，`docker-compose.postgres.yml`） | 进行中：Docker Desktop 正在装 |
| 真实 OAuth 登录（`/auth/oauth/*`） | 待做 |

**注意**：SQLite 模式是它**测试用**的路径（README 明确说不支持作为生产后端）。
本机跑它只用于**验证协议对接**，生产部署仍应走 Postgres + Docker。
