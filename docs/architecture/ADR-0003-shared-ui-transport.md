# ADR-0003 · 共享 UI 的 Transport 抽象与移动端功能矩阵

> 状态：**已定（含 1 处需用户确认的传输取舍）** ｜ 日期：2026-10-31
> 相关：`ADR-0001`、`ADR-0002`、`SPIKE-REPORT.md`、`OPEN-DECISIONS.md`

---

## 1. 为什么需要 Transport 抽象

桌面现在直接 `import { invoke } from "@tauri-apps/api/core"`（`src/core` 里 108 处）。
手机没有 Tauri，未来桌面也要改成"连 Host"。三者（Tauri / 本机 HTTP / 远程）不能各写一套调用。

**唯一允许的形态**：所有能力调用只经过一个 `Transport`，UI 不知道自己在哪个宿主里。

```ts
export interface Transport {
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** 事件流：返回取消订阅函数（内部负责重连 + sinceSeq 续传） */
  subscribe(sessionId: string, sinceSeq: number, sink: (e: SessionEvent) => void): () => void;
  readonly kind: "tauri" | "http" | "wss";
}
```

三个实现的共同点：**信封与事件语义完全一致**（`packages/protocol`），差异只在"怎么送字节"。

| 实现 | 谁用 | 传输 | 现状 |
|---|---|---|---|
| `TauriTransport` | 桌面（过渡期，直连渲染侧 core） | Tauri IPC | 已存在（`rust-port.ts` 的 `tauriTransport`） |
| `HttpSseTransport` | 桌面 2.0 / 手机 WebView / PWA | `POST /rpc` + `GET /events`（SSE） | **Spike C 已验证** |
| `WssTransport` | 终端字节流（阶段 5）/ 双向需求 | WebSocket | 未实现（按需引入，不改信封） |

---

## 2. 事件流用 SSE（而不是裸 WebSocket）—— 需要拍板（D-2）

原始目标写的是「WSS JSON-RPC + 事件流」。实现时改成 **HTTP POST + SSE**，理由：

1. **续传是协议要求，SSE 原生就有**：每条事件带 `id: <seq>`，浏览器断线重连自动带
   `Last-Event-ID`，正好等于 `session.watch` 的 `sinceSeq` 语义。自己写 WS 就要自己实现重连与缺口补齐
   —— 而这块最容易在"手机切后台/换网"时出错。
2. **零依赖、零自研帧**：Node 内置 `http` 即可；WS 要么引 `ws`（打进 APK 的体积），
   要么自己实现 RFC6455（掩码/分片/ping-pong/close）—— 都是给"单向事件"付不必要的代价。
3. **穿透更稳**：Tailscale / Cloudflare 对 `text/event-stream` 是默认支持；WS 在部分代理下会被断。
4. **浏览器安全模型更简单**：`POST + SSE` 是普通 HTTP，CSP/`Origin` 校验与普通请求一致。

代价（必须承认）：
- **单向**：所以请求-响应仍走 `POST /rpc`（审批、取消都是普通请求）；
- **无二进制**：终端字节流需要 base64（体积 +33%）—— 所以终端用 WS，而不是把 SSE 硬撑成双向；
- 某些反向代理会缓冲：必须发 `Cache-Control: no-transform` + `X-Accel-Buffering: no`（Host 已发）。

**建议**：事件流保持 SSE；终端（阶段 5）另开 WS 通道，两者共用同一信封与同一 `Transport` 抽象。
如果坚持"一开始就 WSS"，改动集中在 `packages/host/src/server.ts` 与一个 `WssTransport`，
协议类型一行不用动 —— 这不是架构分歧，是传输选择。

---

## 3. 能力位驱动的功能矩阵（同一套 UI，不维护第二份聊天界面）

`host.hello` 返回 `capabilities.supported / unsupported`。UI **按能力位渲染**，
而不是"点了失败再提示"（那是把产品缺陷当运行期异常）。

| 功能 | PC 本机 | 手机 → PC 远程 | 手机本机（PRoot） | 备注 |
|---|---|---|---|---|
| 会话列表 / 打开 / 搜索 | ✅ | ✅ | ✅ | 远程走 `session.list/get` |
| 发 prompt / steer / cancel | ✅ | ✅ | ✅ | 同 `prompt.send` / `run.cancel` |
| 流式正文 / 推理 | ✅ | ✅（SSE） | ✅ | 事件 `assistant.text` |
| 工具卡 / 工具结果 | ✅ | ✅（截断预览 + 展开） | ✅ | 大结果只在 Host 侧落 spill |
| 审批（allow/deny + 备注） | ✅ | ✅ | ✅ | 远程审批是**核心**能力，不是可选 |
| diff 查看 | ✅ | ✅（只读） | ✅ | 远程不允许"在手机上合并冲突" |
| 文件树 / 只读预览 | ✅ | ✅（根限制） | ✅ | `workspace.read` |
| 附件上传（相册/文件） | ✅ | ✅（base64） | ✅ | `attachment.put` |
| 终端 | ✅ | ✅（阶段 5） | ✅ | 需要 WS 字节流 |
| 设置（模型/安全模式） | ✅ | ⚠️ 只读/受限 | ✅ | 远程改安全档要二次确认（见 §5） |
| 插件市场 / 技能安装 | ✅ | ⚠️ 只读列表 | ✅ | 安装动作留桌面 |
| 桌面宠物 / 三皮肤 | ✅ | ❌ | 部分 | 纯桌面装饰，不进手机 UI |
| 多主机切换 | — | ✅（阶段 5） | — | 列表 + 最近连接 |

**布局**（断点与交互）：

| 宽度 | 形态 |
|---|---|
| < 640 | 单列：会话列表 ⇄ 对话（返回手势）；输入区固定底部 + 安全区 |
| 640–1024 | 双列：列表 280 + 对话；工具卡内联 |
| > 1024 / 横屏 | 三列：列表 + 对话 + 详情（diff/文件/终端） |

**phone 上必须去掉的桌面假设**（逐条都是真实缺陷来源）：
- `hover` 才出现的操作 ⇒ 改为常显或长按菜单；
- 右键菜单 ⇒ 长按；
- 固定像素宽度的侧栏 ⇒ 抽屉；
- `window` 尺寸/位置记忆 ⇒ 视口单位 + `env(safe-area-inset-*)`；
- 键盘快捷键提示 ⇒ 不展示（外接键盘时仍可用）。

---

## 4. 单写者租约与多设备

- **一个项目只有一个真源**（PC）。手机**不复制项目文件**；需要同仓库就用 Git。
- **远程默认常驻开启**（用户决策，见 `OPEN-DECISIONS.md` D-4）：首次启动提示一次，
  用户可一键关闭；关闭后关窗即退出。默认开启**不等于**默认放松安全（仍只绑 loopback + 配对）。
- **租约**：同一时刻只允许一个客户端发 prompt（`lease.holder`）。桌面持有租约时，
  手机可以看、可以审批，但发送会被明确拒绝（`LEASE_HELD`），并给"接管"按钮（需二次确认）。
- 理由：两个客户端同时发 prompt 会让同一会话出现两条并行回合 —— 现有 `activeExecutions`
  只在一个进程内生效，跨设备必须靠租约。

---

## 5. 安全（分层，缺一不可）

1. **只监听 loopback**：Host 不绑 `0.0.0.0`；远程可达性由 Tailscale（默认）或 Cloudflare Tunnel 提供。
2. **配对**：Host 的 `PairingService`（6 位一次性码 + 5 分钟 TTL + 单次使用 + sha256 + 设备上限 8 + 显式撤销）。
   旧的 `phone-link` LAN 扫码配对已删除；不要再引入第二套配对/token 发放路径。
3. **传输**：Tailscale = WireGuard（链路层）；Cloudflare 路径**必须加应用层 E2EE**
   （否则隧道服务商能看到明文 prompt/代码）。
4. **应用层校验**：
   - `Origin` 校验 + 同源策略（阻断本机 CSRF）；
   - 文件访问**只允许项目根内**（`resolveInsideRoot`：拒绝绝对路径、`..`、符号链接逃逸）；
   - 不暴露裸 shell：终端走 PTY 会话 + 审批，不接受任意命令字符串直通；
   - 危险动作（改安全模式、批准写文件）**必须**二次确认，且审批记录进事件流（可审计）。
5. **凭据**：API Key 只在 Host 侧；手机永远拿不到（协议里没有任何字段能返回它）。

---

## 6. 共享 UI 的落地路径（阶段 2）

1. **只搬"对话区"**：`MessageBubble` / `ToolCallCard` / `InputArea` / `ChatPanel` 去掉 Tauri 依赖，
   改为 `Transport` + 能力位；桌面继续用同一套组件（不允许 fork）。
2. **状态**：`store.ts` 的 UI 状态留在客户端；**消息/会话状态来自 Host**（客户端不写索引）。
3. **样式**：`styles.css` 的令牌沿用；新增 `--mobile-*` 断点变量，不新开一套皮肤。
4. **判据**：
   - 同一组件在 390/768/1280 三个宽度下快照（现有窄容器判据可扩展）；
   - 能力位缺失时入口**不渲染**（不是渲染后禁用）；
   - 同一场景在桌面与移动视口产生**同一组协议调用**（parity harness）。

> 现状：本轮的 `packages/host/web/index.html` 是**协议壳**（原生 JS，230 行），用来证明传输与事件闭环；
> 它不是最终 UI，阶段 2 会被 `packages/ui` 的 React 组件替换。

---

## 6. 阶段 2 进展（已开工）

- `packages/ui/src/host-client.ts`：共享传输客户端（JSON-RPC + SSE，浏览器/Node 通用；
  `HostRpcError` 带 kind/retryable；坏事件行被忽略；单订阅者崩溃不影响他人）。
- `packages/ui/src/browser.ts` → `packages/host/web/ui.js`（esbuild IIFE，全局 `CodemUI`）。
- **移动壳已整体换成共享 React 应用**（阶段 2 第一块完成）：`web/index.html` 只剩 `#app` + `ui.js`，
  会话列表/消息流/工具卡/输入区全部由 `packages/ui/src/components.tsx` 渲染，数据来自 `MobileApp`；
  Spike C 仍 **8/8**（连接、种子消息、最终答复、工具卡、无页面异常）。
- 判据：`src/test/ui-host-client.test.ts`（UIC-1/2）。
- **传输抽象 + 能力位已落地**：`SessionTransport`（remote = HostClient；local = 注入 store 回调）+
  `capabilitiesFor(local|remote|remoteFull)`；移动壳现在只依赖 `SessionTransport`，不认识 HTTP/SSE。
  判据：`src/test/ui-transport.test.ts`（TR-1..3）。
- **桌面已共用展示组件**（不是预览页）：`src/components/ChatPanel.tsx` 渲染
  `src/components/MessageBubble.tsx`（桌面平台适配器）→ `packages/ui/src/message-bubble.tsx`；
  工具行走 `src/components/ToolCallCard.tsx` → `packages/ui/src/tool-card.tsx`。组件与手机**同一份**。
  判据：`src/test/ui-shared-bubble-wiring.test.tsx`（WIRE-1..6）、
  `src/test/ui-desktop-shared-path.test.tsx`（DTR-1..3）。
- 阶段 2 收尾已完成：`?ui=shared` 只读预览页已删除（B 项）；随后进 Android 壳。
- **会话交互也共用了**：`useSessionChat`（打开→订阅→流式→工具卡→发送/取消→收尾）只有一份实现，
  移动壳已改为只做"列表/标题/布局"；判据 `src/test/ui-session-chat.test.tsx`（URC-1/2）。

### 6.1 阶段性定稿：共享 UI 的适用范围（2026-11，B 项后更新）

**决定**：`packages/ui` 是**聊天渲染的唯一实现**（消息气泡、工具卡、审批卡），
远程客户端（Android 外壳、浏览器）与桌面共用；桌面本机窗口保留自己的外壳与本机专属能力
（虚拟列表、压缩视图、附件、diff/审批外壳、专用工具卡明细），并只做平台适配器注入。

**理由**：
- 远程客户端的能力集是桌面本机能力的子集，用能力位表达差异已经足够；
- 只迁**展示组件**（气泡/工具卡/审批卡）而不是整棵 1955 行聊天树：虚拟列表、压缩视图、
  附件、diff 仍由桌面负责，收益是"消息渲染只有一份"，成本可控；
- 反过来说，只要**远程**只有一套 UI，设计目标（不为手机单独维护界面）已经成立；
  桌面复用同一份展示组件进一步消除两套渲染的漂移。

**影响**：`?ui=shared` 只读预览页已随 B 项删除（它只是调试入口，不是产品路径）；
桌面默认路径是 `ChatPanel` → `MessageBubble`（桌面平台适配器）→ 共享气泡，
以及 `ToolCallCard` → `ToolCardView`。判据见 `src/test/ui-shared-bubble-wiring.test.tsx`（WIRE-1..6）
与 `src/test/ui-desktop-shared-path.test.tsx`（DTR-1..3）。

### 7.1 单写者租约（D-5，2026-11 已落地）

- 首个 `host.hello` 获得租约（TTL 90s，hello 续期）；他人 hello 返回 `leaseGranted=false` 与当前 holder；
- `host.lease.takeover` 第一次只返回 `needsConfirmation`，`confirm:true` 才接管并返回 `previousHolder`；
- 接管后 `prompt.send` 带旧 `clientId` ⇒ `LEASE_HELD`；不带 `clientId` 的旧客户端仍放行（兼容，但记录告警）。
