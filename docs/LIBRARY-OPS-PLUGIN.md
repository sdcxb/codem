# 图书馆运营监控插件（@codem/ui-library-ops）设计与实施记录

> 版本：v1.12.0（2026-09-10） | 插件路径：`src/plugins/library-ops/`
> 需求来源：以 ClawLibrary 的图书馆场景 + lobster-pet 的监控看板为参照，
> 把 Codem 的**团队角色与子智能体**可视化为在图书馆各岗位工作的动画角色，
> 并把图书馆作为监控界面内的场景；作为一个**完全独立、启停不影响现有功能**的大插件交付。

---

## 一、需求 → 实现对照

| 需求原文 | 落地实现 | 证据 |
| --- | --- | --- |
| 把不同的团队角色和子智能体，生成不同的动画角色 | `data/characters.ts` 的 `generateLook()`：12 调色板 × 4 身形 × 5 发型 × 6 头饰 × 6 道具 × 4 表情 = **34,560 种**外观，由角色 id 确定性生成；岗位影响头饰/道具 | `library-ops-characters.test.ts` LO-LOOK-1~8 |
| 在图书馆不同的地方工作 | `data/library-map.ts`：**10 个功能区**（前台/阅览大厅/编目室/代码工坊/写作工坊/档案室/机房/会议厅/借还台/静思角），按角色标签关键词自动分配岗位与工位槽位 | `library-ops-map.test.ts` LO-MAP-1~8、`library-ops-scene.test.ts` LO-SCENE-5 |
| 类似 ClawLibrary 的 OpenClaw 角色工作 | 等距 2.5D 图书馆（SVG 地板/区域/装饰 + DOM 角色层）、网格 BFS 寻路、到岗停留、头顶名牌与工作气泡、11 种工作动画 | `core/pathfinder.ts`、`core/scene-engine.ts`、`components/library/*` |
| 它只有一只小龙虾工作，咱们是一个团队在图书馆里工作 | 角色来源覆盖：队长会话 / 普通会话 / worktree 分支会话 / 运行时团队成员 / 子智能体 / 团队模板角色 / 兜底值班馆员，全部同时在场 | `core/telemetry-adapter.ts` 的 5 类来源 + 兜底 |
| 完全引用 lobster-pet 的监控界面 | `components/LibraryOpsPanel.tsx` 复刻「标题栏 + 卡片网格 + 场景嵌入 + 实时事件流」；`monitor/` 下 9 个面板：StatusCard 式状态卡、TaskGrid 式会话网格、ActivityViz 式热力图+环形图+小时柱状图、GatewayAgentsCard 式团队卡、TokenBar 式用量卡 | `library-ops-ui.test.tsx` LO-UI-3~9 |
| 把我们的图书馆作为 lobster-pet 监控界面内的场景 | 图书馆是监控面板的「图书馆」页签，与其它监控卡共享同一份 `LibrarySnapshot`；总览页还有场景缩略（岗位分布） | `LibraryPanel.tsx`、`OverviewPanel.tsx` 的 `MiniScenePreview` |
| 完全独立的大插件，启停不影响现有功能 | 只读宿主数据；挂 `app.overlay`（宿主已有消费点）→ **App.tsx 零改动**；禁用即不装配；面板关闭即停止采样 | `library-ops-integration.test.ts` LO-INT-1~7、LO-ADP-11 |

---

## 二、参考项目分析（实际克隆源码后逐项取舍）

两个项目均已 `git clone` 到本地逐一阅读（未复制代码或美术资源，只借鉴信息架构与交互母题）。

### 2.1 ClawLibrary（`shengyu-meng/ClawLibrary`，MIT）

| 观察到的做法 | 本插件的取舍 |
| --- | --- |
| Phaser 3.90 + 2D 像素美术馆；`LibraryScene.ts` 96KB 单场景 | **不采用 Phaser**：Phaser 无法在 happy-dom 下运行，动画行为会变成黑盒。改为 SVG + DOM，把行为抽成纯状态机 |
| 12 个 `ResourcePartitionId` 资源分区（document/memory/skills/gateway/log/mcp/schedule/alarm/agent/task_queues/break_room…）+ `RoomBounds` + `labelAnchor` | **采用其思想**：改为 10 个「岗位区域」，每区有 `rect`/`station`/`capacity`/`token`/`keywords`/`activity` |
| `WorkStateProfile`：`stateId → zoneTypes / interfaceIds / outputCategoryIds / detailTemplates` | **采用**：本插件用 `ActorActivity → 岗位默认动作 + 语义令牌 + 图标`（`ACTIVITY_META`），并用 `resolveZoneId(roleLabel)` 做「角色 → 岗位」 |
| `walkGraph`（节点+边）+ 多边形碰撞 + BFS `computeRoute` | **改形**：开放平面瓦片地图 → 可通行网格 + 网格 BFS（更简单且可测：断言入口到 10 个岗位全部可达） |
| `spawnAgentActor / setAgentActorFocus / setAgentActorStatus / despawnAgentActor` | **采用**：`advanceScene()` 的增/改/删三分支 + `focus → bubble`、`status → 头顶名牌` |
| 多角色变体（`ActorVariantDef`）、阴影、名牌、思考气泡、到岗 linger | **采用**：`CharacterLook` 多维度变体 + `lo-shadow` + 名牌 + 气泡 + 到岗停驻 |
| 双语（`ui/locale.ts`，zh/en 房间名） | **采用**：所有面板与岗位名双语，走宿主 `useLang()` |

### 2.2 lobster-pet（`jiaweisibot/lobster-pet`，MIT）

| 观察到的做法 | 本插件的取舍 |
| --- | --- |
| Electron + React 19；`DetailPanel` = 标题栏（标题/刷新/关闭）+ Row1（`StatusCard` + `TaskGrid` + `ActivityViz`）+ Row2（`GatewayAgentsCard` + `CronList` + `MemoCard` + `MiniOffice`） | **采用**：`LibraryOpsPanel` = 标题栏（标题/实时状态/时钟/刷新/关闭）+ 左侧导航 + 内容区 + 右侧实时事件流；9 个面板对应其卡片族 |
| `ActivityViz`：14 天热力图 + 会话类型环形图 + 24 小时活跃柱状图 | **采用**：`monitor/charts.tsx` 的 `Heatmap` / `DonutChart` / `HourBars`，数据来自真实会话与消息时间戳 |
| `StatusCard`：状态点 + 描述 + 活跃任务 + 模型 + 累计 token/成本 | **采用**：总览页的 `StatCard` 网格 + 健康度环 + 数据源卡 |
| `TaskGrid`：最近会话卡片网格（图标/名称/状态点/通道/年龄/token） | **采用**：`SessionsPanel` |
| `GatewayAgentsCard` + `CronList`：智能体列表 + 定时任务 | **采用**：`TeamsPanel`（成员+任务看板）与时间线页 |
| `MiniOffice`：**把场景作为监控界面内的一个卡片**（iframe + postMessage 传状态） | **采用其核心思想**：图书馆是监控面板的一个页签，由同一份快照驱动；但不用 iframe，直接同进程渲染（避免二次加载与状态同步开销） |
| 卡片视觉：暗色磨砂玻璃 `.card` + `.section-title` + `.card-scroll` | **采用结构，不采用色值**：改为 Codem 皮肤令牌（`--bg-secondary` / `--border-primary` / `--radius-md` / `--shadow-md`），四套皮肤自动适配 |
| 宠物状态机：`idle/working/thinking/error/sleeping/happy`，30s 无活动转 sleeping | **采用**：本插件 11 种角色动画态；会话「6 小时无活动 → 休眠」同源思路 |

---

## 三、架构

```
                        ┌─────────────────────────────────────────┐
                        │  宿主 Codem（只读，零写入）              │
                        │  useProjectStore  useAppStore            │
                        │  AgentTeamsService  SubagentRuntime      │
                        │  SquadManager  AgentRegistry             │
                        │  CostTracker  TelemetryCollector         │
                        └──────────────────┬──────────────────────┘
                                           │ AdapterDeps（可注入 / 懒加载 / 逐源 try-catch）
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │ core/telemetry-adapter.ts                     │
                    │   collectSnapshotSync(deps) → LibrarySnapshot │
                    │   · actors[]（5 类来源 + 兜底）               │
                    │   · teams[] / metrics / events / activity     │
                    └───────┬───────────────────────────┬──────────┘
                            │                           │
                ┌───────────▼──────────┐    ┌───────────▼─────────────┐
                │ store.ts（zustand）   │    │ 监控面板（9 页签）       │
                │  open/tab/settings    │───▶│ Overview/Library/Teams/  │
                │  snapshot/scene/series│    │ Sessions/Tools/Cost/     │
                └───────────┬──────────┘    │ Errors/Timeline/Settings │
                            │               └───────────┬─────────────┘
                            ▼                           │
                ┌──────────────────────────┐            │
                │ core/scene-engine.ts     │            │
                │  advanceScene(prev,snap) │            │
                │  stepActorMovement()     │            │
                │  （纯函数，可单测）       │            │
                └───────────┬──────────────┘            │
                            ▼                           ▼
                ┌────────────────────────────────────────────────────┐
                │ components/library/LibraryScene.tsx                │
                │  SVG 地板/区域/装饰 + DOM 角色层（rAF 只改 transform）│
                │  components/library/CharacterActor.tsx（11 种动画）  │
                └────────────────────────────────────────────────────┘
```

### 关键数据流

1. 面板打开 → `store.refresh()` 按 `settings.refreshMs` 调 `collectSnapshot()`。
2. 适配层把宿主读接口的返回值归一化为 `LibrarySnapshot`（角色 / 团队 / 指标 / 事件 / 活动分布 / 来源健康）。
3. `store` 写入快照并把关键指标追加进 6 条时间序列环形缓冲（token / 成本 / 工具 / 活跃角色 / 完成任务 / 健康度）。
4. `LibraryScene` 在快照变化时调用 `advanceScene()` 重算场景状态（增/改/删角色、重算路径与工位）。
5. 场景的 rAF 循环只做两件事：`stepActorMovement()` 推进插值、直接写 DOM `transform`/`z-index`/`opacity`（不触发 React 重渲染）。
6. 所有面板消费同一份快照 → 场景与监控数值天然一致。

### 角色 → 岗位路由

```
roleLabel 关键词匹配（最长关键词优先）
  队长/captain/leader/调度      → front-desk    前台 · 调度台
  研究/分析/research/探索/评审   → reading-hall  阅览大厅
  索引/检索/catalog/grep        → catalog-room  编目室
  代码/实现/编码/dev/build/fix   → code-forge    代码工坊
  写作/文档/ppt/文案            → writing-studio 写作工坊
  记忆/归档/快照/memory         → archive       档案室
  运维/部署/后台/job/cron       → server-room   机房 · 后台
  协作/沟通/会议/team           → meeting-room  会议厅
  交付/汇总/输出/deliver        → checkout      借还台 · 交付
  空闲/待命/rest               → quiet-corner  静思角
  （未命中）                    → reading-hall（默认）
```

### 工具调用 → 角色动作

| 工具族 | 动作 | 动画 |
| --- | --- | --- |
| `read` / `grep` / `glob` / `list_dir` / `search_notebook` | `reading` | 俯身翻书 |
| `write` / `edit` / `multi_edit` / `apply_patch` | `writing` | 手部书写 |
| `bash` / `run_code` / `run_test` / `terminal_*` / `job_*` | `working` | 双臂操作 |
| `web_search` / `web_fetch` / `zvec_grep_search` | `searching` | 头部扫视 |
| `ask_user_question` / `exit_plan_mode` / 权限请求 | `blocked` | 呼吸闪烁 |
| `spawn_subagent` / `send_message` / `agent_teams_*` / `workflow` / `update_plan` | `thinking` | 头部倾斜 |
| 任务 `completed` / 子智能体 `completed` | `done` | 弹跳（保持 4s） |
| 任务 / 子智能体 `failed` | `error` | 抖动 |

---

## 四、集成点与回滚

### 4.1 宿主侧改动（4 个文件，全部为追加）

| 文件 | 改动 | 回滚方式 |
| --- | --- | --- |
| `src/core/provider/ui-library-ops-provider.ts` | 新增（注册入口到 `app.overlay`） | 删文件 |
| `src/core/ui-plugins/index.ts` | +2 行（导入 + 加入 `uiProviders`）+ 门控泛化（`GATED_PROVIDERS`，保留 ui-pet 原行为） | 删 2 行 |
| `src/core/plugin-loader/builtin-registry.ts` | +2 行（导入 + `registerBuiltinPlugin`） | 删 2 行 |
| `src/core/provider/plugin-registry-provider.ts` | +1 行（插件元数据） | 删 1 行 |

**`App.tsx` 未改动** —— 入口挂载在宿主已有的 `<SlotListBridge name="app.overlay" />` 上。

### 4.2 启停语义

- 插件管理里禁用 `@codem/ui-library-ops` → `ui-plugins/index.ts` 的门控跳过装配 →
  `app.overlay` 里没有入口组件 → 悬浮胶囊与面板都不存在。
- 面板关闭 → 采样定时器随 effect 清理，无后台轮询。
- 插件全程只读：`library-ops-integration.test.ts` LO-INT-7 用禁止词表
  （`setSetting` / `saveMessages` / `createMessage` / `updateSquad` / `deleteTeam` / …）
  把「不写宿主」变成门禁。

---

## 五、皮肤兼容（Skin Token Contract）

- 插件 CSS 与 TSX 内联样式**零硬编码色值**（`library-ops-integration.test.ts` LO-SKIN-1）。
- 使用的令牌全部落在契约允许的前缀集合内（LO-SKIN-2 白名单校验）。
- 半透明一律 `color-mix(in srgb, var(--token) N%, transparent)` 派生。
- 角色配色令牌化：12 套调色板全部是 `var(--token)`，皮肤切换时角色一起换色。
- 尊重 `prefers-reduced-motion`（LO-SKIN-4）。

---

## 六、测试矩阵（70 用例 / 6 文件）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `library-ops-map.test.ts` | 13 | 地图完整性、投影互逆、岗位路由、槽位稳定、可通行网格、BFS 最优性 |
| `library-ops-characters.test.ts` | 8 | 外观确定性/差异化/取值范围、岗位倾向、调色板令牌化、哈希与短 id |
| `library-ops-scene.test.ts` | 11 | 入场/到岗/离场淡出、分配稳定、工位分离、行走与朝向、动画映射、深度排序、统计、非法 dt |
| `library-ops-adapter.test.ts` | 13 | 5 类角色来源、指标聚合、活动分布、事件流去重排序、失败可见性、健康度、只读契约、缺省依赖 |
| `library-ops-integration.test.ts` | 16 | 注册链路、provider 装配/释放、目录结构、只读门禁、皮肤契约、设置持久化 |
| `library-ops-ui.test.tsx` | 9 | 角色 11 态渲染、差异化、面板 9 页签、场景渲染、角色选中、团队/成本/错误/时间线、设置持久化、Esc 关闭 |

```bash
npx vitest run src/test/library-ops-*.test.ts*
npx tsc --noEmit
```

---

## 七、像素美术场景集成（v1.13.0）

> 目标：把「美观」提到第一位——**直接使用参考项目的手绘像素美术资源**，
> 而不是程序化绘制的矢量替代品；同时满足许可合规与项目内声明。

### 7.1 资源来源与许可

| 来源 | 收录内容 | 美术许可 | 可商用 |
| --- | --- | --- | --- |
| [ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) | **图书馆场景底图 + 家具层 + Capy/Cat 两套角色 × 12 动作精灵表**（2752×1536 场景、128×128 帧 @6fps） | CC BY-NC-SA 4.0 | ❌ |
| [Star-Office-UI](https://github.com/ringhyacinth/Star-Office-UI) | 办公室场景、猫咪/星星角色、机房、海报、绿植、咖啡机等 | 仅限非商业 | ❌ |
| [lobster-pet](https://github.com/jiaweisibot/lobster-pet) | **仅设计参考**（监控看板信息架构），未收录美术资源 | MIT | ✅ |

**刻意排除**：Star-Office-UI 里的 `guest_role_*` / `guest_anim_*` 来自 LimeZu，
其许可禁止再分发（"You may not redistribute it or resell it"），
`scripts/sync-library-ops-assets.mjs` 显式跳过。

**合规履行**：每个来源目录含 `SOURCE.md`（出处 / 逐文件改动 / 义务）+ 上游 LICENSE 原文；
`THIRD_PARTY_NOTICES.md` + `docs/ASSET-LICENSES.md` 全量声明；
插件设置页「美术资源许可」卡在运行时可见；非商业限制有**替代方案**——
`sceneStyle: "iso"` 的等距矢量场景由本项目自绘，无第三方约束。

### 7.2 资源管道

`scripts/sync-library-ops-assets.mjs`：PNG → WebP（**30.1MB → 5.1MB**，视觉无损）+ 写 SOURCE.md + 复制 LICENSE。
产物提交到仓库（`public/library-ops/`），Vite 原样拷贝到 `dist/library-ops/`。

### 7.3 场景实现

- **坐标系统**：沿用上游逻辑坐标 1920×1080（`map.logic.json` 的 `baseResolution`），
  贴图按 `displaySize` 1920×1072 显示；
- **房间**：上游 12 个资源分区（含 bounds / labelAnchor / workZone）映射到本插件 10 个职能岗位
  （`ZONE_TO_ROOM`）；**上游 mcp / images / log / schedule 四个房间的 workZone 锚点落在房间矩形外**，
  集成时按 28px 边距夹回房间内（`workAnchor()`）；
- **寻路**：直接使用上游手工标注的 `walkGraph`（20 节点 / 19 边）做 BFS 图最短路，
  末端直连工作锚点（`core/pixel-path.ts`）；
- **角色**：DOM + 精灵表背景定位逐帧动画（`background-position`），
  帧尺寸/列行数/fps 全部取自上游 `manifest.json`；按角色 id 稳定分配 Capy / Cat 变体；
- **工作状态 → 动作**：11 种状态映射到上游动作
  （walk / work / read / idea / repair / error / sleep / coffee / rest / stand_front / stand_back / lie_flat…）；
- **相机**：滚轮缩放（0.3×–3.2×，指针锚点）/ 拖拽平移 / 双击复位 / 选中角色平滑居中；
- **降级**：资源缺失时显示提示并引导切到「等距矢量」场景。

### 7.4 监控面板布局对标 lobster-pet

lobster-pet 的 `DetailPanel` 是「单屏卡片网格」：

```
行 1：状态卡(236px) │ 最近会话卡网格(1fr) │ 活动概览(1.45fr)
行 2：左栈 ── 团队卡 │ 任务与工具卡
             └ 数据源与健康度卡          │ 图书馆场景大卡(1fr)
行 3：6 张紧凑 KPI 卡（含迷你折线）
```

**场景从「一个页签」变成「监控界面里的一张卡」**（对标其 `MiniOffice`），
与其它监控卡共享同一份快照；同时保留全屏「图书馆」页签供放大观察。

---

## 八、已知边界与后续可做

| 项 | 现状 | 后续 |
| --- | --- | --- |
| 缓存命中 token | 适配层预留 `tokensCached` 字段，当前 CostTracker 聚合口径未提供 | 接入 provider 上报的 cache 字段 |
| 权限/审批等待态 | 只能从工具名（`ask_user_question` 等）推断 | 接入 `PermissionRequest` 待决队列，角色真正站到「等待授权」岗位 |
| 场景地图 | 单层平面（10 岗位） | 可扩展多层/多馆，按项目分馆 |
| 角色移动 | 网格 BFS + 线性插值 | 可加转弯缓动、避让、结伴同行 |
| 历史回放 | 只有最近 120 个采样点 | 可接 EventLog 做时间轴回放 |
