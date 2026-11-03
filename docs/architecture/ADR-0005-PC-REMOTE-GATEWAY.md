# ADR-0005：PC 远程访问 = 桌面数据的网关（取代 ADR-0004 Phase 3）

- 状态：**接受**
- 日期：2026-11-02
- 取代：`ADR-0004-DATA-PLANE.md` 的 Phase 3（Host 单写/桌面迁移）；ADR-0004 仅保留 Phase 1 工作区结论作为历史
- 相关：ADR-0001、ADR-0002、ADR-0003

## 1. 产品目标（原话）

> PC 和手机可以各自有自己的项目和对话，互不干扰；手机额外可以访问 PC 的项目，远程处理 PC 的项目和会话。

因此：

- **手机本机模式**：手机自己的 Host、自己的数据根、自己的项目/会话，独立于 PC；
- **手机远程模式**：访问 **PC 桌面进程自己的**项目/会话；
- **PC 桌面**：始终是 PC 数据的唯一拥有者与唯一写者；
- **不做**：桌面与手机共用一份数据库、把桌面库迁到 Host、让 Host 接管桌面数据。

## 2. 为什么不走 ADR-0004 Phase 3

Phase 3 让 Host 成为唯一写者、桌面改成 Host 客户端，会把“PC 自己的数据”交给另一个进程/数据根：

- PC 不再是数据主人；
- 需要迁移桌面库、改 58k 行桌面 UI、Host 崩溃则桌面不能聊天；
- 与“互不干扰、各自拥有”直接冲突。

结论：**Phase 3 取消**。两套独立数据是目标，不是要消灭的问题；需要补的是“PC 数据对手机的远程入口”。

## 3. 目标架构

```
PC 桌面 Codem（唯一写者）
├─ 桌面 UI / 项目 / 会话 / SQLite+JSONL / Agent 循环
└─ 远程网关（loopback，桌面进程内）
      ├─ 静态共享 UI（packages/ui 构建物）
      ├─ 鉴权/配对
      └─ JSON-RPC + SSE  ⇄ 转发到桌面渲染层（存储/循环/审批）

手机 App
├─ 本机模式：手机自己的 Host（Android PRoot），独立数据
└─ 远程模式：连 PC 网关，看到 PC 桌面会话/项目，远程跑 PC 的循环
```

关键约束：

1. 网关**不拥有数据**：它只把请求转给桌面渲染层，读写都落在桌面现有库/工作区；
2. 网关不跑第二套 Agent 循环；
3. 手机本机 Host 不变；
4. 不需要数据迁移；
5. PC 离线时手机远程不可用（这是正确语义：访问的就是 PC 上的东西）。

## 4. 实现选型

**桌面进程内的 loopback 网关（Rust HTTP + 渲染层桥）**，而不是 Host sidecar：

- 复用旧 phone-link 的“Rust 监听 + Tauri 事件桥到渲染层”内核（`src-tauri/src/phone/mod.rs` + `src/core/phone-link/phone-link.ts` 在 HEAD 里仍可恢复）；
- 旧实现只保留：loopback HTTP/SSE、桌面会话/循环转发、审批、静态 UI 服务；
- **丢弃**旧实现的：LAN/TLS/自签 CA/二维码/旧 app.html/旧自建中继；
- 鉴权/配对复用新 Host 的设计（6 位码、HttpOnly cookie、设备撤销），在 Rust 网关侧实现或抽取共享库；
- 协议与共享 UI 复用现有 `packages/ui`，不维护第二套手机页面。

不在本方案内：

- Host sidecar 作为 PC 远程数据源（保留给手机本机模式/未来桌面后台任务，但不服务 PC 远程）；
- 桌面与手机共用 SQLite；
- 任何数据迁移。

## 5. 里程碑

### M1 只读（先证明“手机看到 PC 桌面会话”）

- 桌面启动网关（loopback、随机端口、配对/本机凭据）；
- 手机加载共享 UI → 配对 → `session.list/get` 来自桌面库；
- 只读：列表、历史消息、项目/工作区信息；
- 判据：桌面新建会话后手机可见；手机看不到手机本机会话；网关停止则不可用；无第二份库。

### M2 写：prompt/审批/取消

- `prompt.send` 转发到桌面 Agent 循环，事件经 SSE 回流；
- 审批转发到桌面 `DecisionTray`/或手机直接批（产品决策：远程审批由手机批，桌面显示状态）；
- 租约：桌面是写者，远程会话同一时间只允许一个远程客户端；
- 判据：手机发一轮、桌面看到同一条消息；工具审批生效；取消生效；桌面历史落库。

### M3 文件/差异/变更

- 网关转发桌面工作区的文件树/预览/diff/变更；
- 复用共享 `FileTree/PatchDiffView`；不做 Host 的 `.codem-attachments` 复制逻辑。

### M4 收尾

- 删除“PC 远程走 Host sidecar”的 UI/文档路径；Host 仅保留手机本机；
- 端到端真机：手机远程 PC、手机本机、两者互不干扰；
- 配对/撤销/离线/重启用例。

## 6. 影响

- 不再需要 Phase 3 迁移；桌面数据零改动；
- 需要恢复/重建桌面网关（规模小于 Phase 3，仍是多轮工作）；
- 手机远程与手机本机是两条路径，必须保证 UI 文案清楚“当前连的是 PC 还是本机”；
- 安全：网关必须只绑 loopback + 配对；读敏感文件策略沿用“共享项目需审批”的结论（M3 落实）。

## 7. 当前状态与下一步

- 已完成：Phase 1 工作区共享（Host sidecar 场景）、配对/cookie/本机鉴权、共享 UI/文件/差异/变更；
- 已完成：**M1 桌面网关只读**（loopback + 随机端口 + 6 位配对 + `session.list/get` + 共享 UI）；
- 已完成：**M2 写 + 审批 + 取消 + 事件流**
  （`prompt.send` / `run.cancel` / `approval.list` / `approval.respond`；
  网关 `/events` SSE 支持 `Last-Event-ID` 续传、缺口 reset、终态保留；
  共享 UI 的写模式由 `host.hello.capabilities` 决定，M1 的注入标记已删除）；
- 已完成：**M3 文件 / 差异 / 变更**（`workspace.*`、`session.changes`；共享 `FileTree` / `PatchDiffView`，
  `gateway-workspace.ts` + 判据 `gateway-workspace.test.ts` / `gateway-changes.test.ts`）；
- 真机用例：`GATEWAY-M2-DEVICE-CASES.md`（`android-shell/spike-desktop-gateway.mjs`）；
- 剩余（M2 诚实缺口）：`run.guidance`、`session.create`、`attachment.put`、
  `session.get` 的工具行形状与 `hasMore`；
- 明确停止：ADR-0004 Phase 3；**桌面 Host sidecar 不再服务 PC 远程**，Host 只保留给 Android 本机模式。
