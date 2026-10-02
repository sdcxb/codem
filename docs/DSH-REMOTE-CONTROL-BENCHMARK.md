# DSH「远程控制」对标分析与改进计划

> 结论先行：DSH 最新版（装机版 **DSH Desktop 2.0.17**）侧栏里的「远程控制」**不是 DSH 核心功能**，
> 而是它**预装的第三方插件** `@agents-anywhere/dsh-bridge-next`（Agents Anywhere）。
> DSH 官方自己另有一条**独立**能力：把本机 Web UI 经 **LAN HTTPS** 暴露给普通浏览器。
> 两条路我们都只有一半 —— 详见 §5 三向对照与 §6 改进计划。

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
