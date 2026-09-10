# 图书馆运营监控插件（@codem/ui-library-ops）设计与实施记录

> 版本：v1.12.0 起（2026-09-10） | 插件路径：`src/plugins/library-ops/`
> 需求来源：以 ClawLibrary 的图书馆场景 + lobster-pet 的监控看板为参照，
> 把 Codem 的**团队角色与子智能体**可视化为在图书馆各岗位工作的动画角色，
> 并把图书馆作为监控界面内的场景；作为一个**完全独立、启停不影响现有功能**的大插件交付。
>
> ⚠️ v1.14.0 起：插件**不再有独立面板**，作为 `task-center.library` slot 的贡献者
> 渲染在宿主「任务管理」面板里（见第九节：与任务管理的融合）。

---

## 一、需求 → 实现对照

| 需求原文 | 落地实现 | 证据 |
| --- | --- | --- |
| 把不同的团队角色和子智能体，生成不同的动画角色 | `data/characters.ts` 的 `generateLook()`：12 调色板 × 4 身形 × 5 发型 × 6 头饰 × 6 道具 × 4 表情 = **34,560 种**外观，由角色 id 确定性生成；岗位影响头饰/道具 | `library-ops-characters.test.ts` LO-LOOK-1~8 |
| 在图书馆不同的地方工作 | `data/library-map.ts`：**10 个功能区**（前台/阅览大厅/编目室/代码工坊/写作工坊/档案室/机房/会议厅/借还台/静思角），按角色标签关键词自动分配岗位与工位槽位 | `library-ops-map.test.ts` LO-MAP-1~8、`library-ops-scene.test.ts` LO-SCENE-5 |
| 类似 ClawLibrary 的 OpenClaw 角色工作 | 等距 2.5D 图书馆（SVG 地板/区域/装饰 + DOM 角色层）、网格 BFS 寻路、到岗停留、头顶名牌与工作气泡、11 种工作动画 | `core/pathfinder.ts`、`core/scene-engine.ts`、`components/library/*` |
| 它只有一只小龙虾工作，咱们是一个团队在图书馆里工作 | 角色来源覆盖：队长会话 / 普通会话 / worktree 分支会话 / 运行时团队成员 / 子智能体 / 团队模板角色 / 兜底值班馆员，全部同时在场 | `core/telemetry-adapter.ts` 的 5 类来源 + 兜底 |
| 完全引用 lobster-pet 的监控界面 | `components/LibraryOpsTaskView.tsx` 复刻其 `DetailPanel` 的「状态条 + 左侧导航 + 卡片网格 + 实时事件流」；`monitor/` 下 8 个面板：StatusCard 式状态卡、TaskGrid 式会话网格、ActivityViz 式热力图+环形图+小时柱状图、TokenBar 式用量卡 | `library-ops-ui.test.tsx` LO-UI-3~9 |
| 把我们的图书馆作为 lobster-pet 监控界面内的场景 | 图书馆是「任务管理 → 图书馆」页签里的**场景子视图**（默认），与用量/会话/工具/成本/错误/时间线共享同一份 `LibrarySnapshot` | `LibraryPanel.tsx`、`LibraryOpsTaskView.tsx` |
| 完全独立的大插件，启停不影响现有功能 | 只读宿主数据；注册到 `task-center.library`（宿主新增的扩展页签 slot）→ 插件禁用时页签不出现；页签卸载即停止采样 | `library-ops-integration.test.ts` LO-INT-1~7、`library-ops-task-center.test.tsx` LO-TASK-1~7 |

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
| Electron + React 19；`DetailPanel` = 标题栏（标题/刷新/关闭）+ Row1（`StatusCard` + `TaskGrid` + `ActivityViz`）+ Row2（`GatewayAgentsCard` + `CronList` + `MemoCard` + `MiniOffice`） | **采用**：`LibraryOpsTaskView` = 状态条（实时状态/指标/时钟/刷新）+ 左侧子导航 + 内容区 + 右侧实时事件流；8 个子视图对应其卡片族（v1.14.0 起作为任务管理的一个页签，不再独立成面板） |
| `ActivityViz`：14 天热力图 + 会话类型环形图 + 24 小时活跃柱状图 | **采用**：`monitor/charts.tsx` 的 `Heatmap` / `DonutChart` / `HourBars`，数据来自真实会话与消息时间戳 |
| `StatusCard`：状态点 + 描述 + 活跃任务 + 模型 + 累计 token/成本 | **采用**：总览页的 `StatCard` 网格 + 健康度环 + 数据源卡 |
| `TaskGrid`：最近会话卡片网格（图标/名称/状态点/通道/年龄/token） | **采用**：`SessionsPanel` |
| `GatewayAgentsCard` + `CronList`：智能体列表 + 定时任务 | **采用**：`TeamsPanel`（成员+任务看板）与时间线页 |
| `MiniOffice`：**把场景作为监控界面内的一个卡片**（iframe + postMessage 传状态） | **采用其核心思想并进一步合并**：图书馆是宿主「任务管理」面板里的一个页签（v1.14.0），由同一份快照驱动；不用 iframe，直接同进程渲染（避免二次加载与状态同步开销） |
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

### 4.1 宿主侧改动（追加为主）

| 文件 | 改动 | 回滚方式 |
| --- | --- | --- |
| `src/core/provider/ui-library-ops-provider.ts` | 新增（注册图书馆视图到 `task-center.library`；快捷键 + 事件别名） | 删文件 |
| `src/core/slots/declare-slots.ts` | +1 行（声明 `task-center.library` 扩展页签 slot） | 删 1 行 |
| `src/components/TaskCenter.tsx` | +条件页签「图书馆」+ `<SlotBridge name="task-center.library" />`（无贡献者时不显示） | 删该页签与 SlotBridge |
| `src/core/slots/SlotBridge.tsx` | +`useSlotHasEntries()`（宿主判断扩展页签是否显示） | 删该 hook |
| `src/core/ui-plugins/index.ts` | +2 行（导入 + 加入 `uiProviders`）+ 门控泛化（`GATED_PROVIDERS`，保留 ui-pet 原行为） | 删 2 行 |
| `src/core/plugin-loader/builtin-registry.ts` | +2 行（导入 + `registerBuiltinPlugin`） | 删 2 行 |
| `src/core/provider/plugin-registry-provider.ts` | +1 行（插件元数据） | 删 1 行 |

**`App.tsx` 仍未改动** —— 图书馆视图是 TaskCenter 里由 slot 渲染出来的，
快捷键/事件走宿主已有的 `codem:open-task-center`。

### 4.2 启停语义

- 插件管理里禁用 `@codem/ui-library-ops` → `ui-plugins/index.ts` 的门控跳过装配 →
  `task-center.library` 没有贡献者 → 任务管理里的「图书馆」页签**不出现**
  （其余 8 个页签完全不受影响）；若禁用发生在面板打开期间，页签消失并回落到「概览」。
- 页签卸载（切到别的页签 / 关闭任务管理）→ 采样定时器随 effect 清理，无后台轮询。
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

### 7.4 场景图片可替换（上传 / 内置预设）

「画面」与「布局」解耦：角色坐标、岗位标签、点击热区都来自固定数据，
图片只是一个铺满 1920×1072 显示画布的图层，所以**换图不需要改任何坐标**。

| 来源 | 实现 | 存储 |
| --- | --- | --- |
| 内置像素画 `claw` | 上游 `scene-floor` + `scene-objects` 两层 | 仓库 `public/library-ops/claw-library/` |
| 内置场景图 `ai-library-01` | 单层整图（2752×1536） | 仓库 `public/library-ops/scenes/` |
| 用户上传 `custom` | 单层整图 | 浏览器 IndexedDB（`codem-library-ops` / `scene-images`，Blob 原样存） |

- **入口**：设置 →「场景图片」卡片（画廊 / 上传 / 删除 / 微调），或直接把图片**拖到场景上**；
- **校验**：格式（PNG/JPG/WebP/AVIF/GIF/BMP）、体积（≤32MB）、尺寸（≥640×360）、
  比例偏离 16:9 超过 8% 时提醒「会被拉伸」（`core/scene-image.ts`，全部纯函数、可单测）；
- **持久化**：`core/scene-image-db.ts` 用 IndexedDB 存 Blob（避免 localStorage 5MB 配额），
  读出后 `URL.createObjectURL` 渲染；无 IndexedDB 时降级为「本次会话有效」并明确提示；
- **画面微调**：缩放 0.5–2×、位移 ±600px；设置卡里还有把房间框叠在缩略图上的对位预览；
- **对位编辑器**（AI 图与内置布局对不上时用）：
  - 场景右下角 ✥ 进入对位模式（Esc 退出），**直接在场景上拖动**：
    拖房间框 = 移动房间（工作锚点 + 标签一起走），拖右下角小方块 = 改尺寸，
    拖圆点 = 改路网节点（BFS 邻接表按覆盖版本号自动重建）；
  - 覆盖层按**场景图片 id** 分别保存（`codem-library-ops-layout`），换图互不污染；
    模块级注册表 `data/layout-override.ts` 供引擎读取 → **引擎签名零改动**；
  - 拖动过程只改本地预览，松手才提交（不每帧写 localStorage）；
- **渲染**：像素画图层用 `image-rendering: pixelated`（最近邻，不糊），
  照片式/平滑场景图用默认插值；图片层单独承载微调 transform，角色层不受影响。

### 7.5 监控面板布局对标 lobster-pet

lobster-pet 的 `DetailPanel` 是「单屏卡片网格」：

```
行 1：状态卡(236px) │ 最近会话卡网格(1fr) │ 活动概览(1.45fr)
行 2：左栈 ── 团队卡 │ 任务与工具卡
             └ 数据源与健康度卡          │ 图书馆场景大卡(1fr)
行 3：6 张紧凑 KPI 卡（含迷你折线）
```

**场景从「一个页签」变成「监控界面里的一张卡」**（对标其 `MiniOffice`），
与其它监控卡共享同一份快照。v1.14.0 起整个图书馆视图并入宿主「任务管理」面板（见第九节）。

---

## 九、与任务管理的融合（v1.14.0）

### 9.1 重叠分析（逐页签对照）

宿主「任务管理」面板（`src/components/TaskCenter.tsx`，8 个页签）与图书馆插件
（`LibraryOpsPanel`，9 个页签）逐项对照：

| 图书馆页签 | 任务管理对应页签 | 数据来源 | 结论 |
| --- | --- | --- | --- |
| 总览（KPI / 健康度 / 14 天热力图 / 小时柱状 / 会话类型环形） | 概览（委派/自动化/Issue/Inbox 统计 + 最近活动） | 两边都聚合会话/任务/事件 | **同义入口**：导航重复。图书馆的「用量」视角（token/成本/健康/活动分布）任务管理没有 → 保留为子视图「用量」 |
| 团队（成员 + 任务看板 + 完成率） | 团队（Squad 模板 + agent-teams 运行时活动） | `AgentTeamsService` / `SquadManager` | **完全重复** → 删除，按钮跳转到任务管理「团队」 |
| 会话（会话列表 + 活跃态 + 消息数） | 委派 / 子智能体（按任务维度，不是会话维度） | `useProjectStore.sessions` | 视角互补（会话维度 vs 任务维度） → 保留为子视图「会话」 |
| 工具（调用频次排行 + 流水） | 无 | 消息流 toolCalls | **独有** → 保留 |
| 成本（token 构成 + 成本趋势） | 无 | `CostTracker` | **独有** → 保留 |
| 错误（阻塞/出错角色 + 失败任务 + 来源健康） | 无（收件箱有错误通知） | `LibrarySnapshot` | **独有** → 保留 |
| 时间线（事件流 + 类别过滤） | 收件箱（通知聚合，已读/未读） | `snapshot.events` / `InboxManager` | 互补（原始事件流 vs 通知中心） → 保留 |
| 设置（采样/场景/皮肤） | 无 | 插件 localStorage | **独有** → 保留 |
| 图书馆（动画场景 + 花名册 + 岗位分布） | 无 | 场景引擎 | **独有（插件核心价值）** → 作为默认子视图 |
| —（无） | Issues / 看板 / 自动化 | `IssueManager` / `AutomationManager` | 任务管理独有，图书馆不重复 |

**结论**：两个面板的重叠集中在「入口层」——两个独立的悬浮入口 / 面板让用户在
两处看到同一批团队、会话、任务数据；图书馆真正独有的是**动画场景**与
**用量/工具/成本/错误/时间线**这几张任务管理没有的卡。因此不是「二选一」，
而是**把图书馆降级为任务管理的一个页签**：删掉重复页签，保留独有视图。

### 9.2 融合后的结构（v1.14.0：并入「看板」）

```
任务管理（TaskCenter，宿主，固定 8 个页签）
├── 概览 / 委派 / 子智能体 / 自动化 / Issues / 看板 / 团队 / 收件箱
└── 看板（slot: task-center.board；插件启用时接管，禁用时回退宿主 Issues 看板）
    ├── 看板      ← 宿主 Issues 看板（默认视图）
    ├── 场景      ← 像素/等距图书馆场景 + 花名册 + 角色详情 + 岗位分布
    ├── 用量      ← KPI/健康/活动分布 + token 构成/成本趋势（原「总览」+「成本」合并）
    ├── 工具 / 错误 / 时间线 / 设置
    └── 右侧实时事件流（可在设置里关掉）
```

- **为什么并进看板**：图书馆场景的初衷就是「谁在做什么、在哪做」的可视化看板，
  与宿主「看板」页签（Issues 按状态分列）是同一类信息的不同表达；
  分成两个页签会让用户在两处看到同一批团队/会话/任务。
- 看板页签会把面板加宽到 1180px（`data-wide="1"`），场景才有足够空间；
- 打开方式：任务管理 →「看板」页签，或 `Ctrl/Cmd+Shift+L` / `codem:open-library-ops`
  （派发宿主已有的 `codem:open-task-center`，`detail.tab = "board"`）；
  旧的 `tab: "library"` 会被 `normalizeTab()` 归一为 `board`。

### 9.3 实现要点

| 关注点 | 做法 |
| --- | --- |
| 宿主扩展点 | `declare-slots.ts` 声明 `task-center.board`（single）；`BoardTab` = `<SlotBridge name="task-center.board" fallback={IssueBoard} />`（`IssueBoard` 是从原 `BoardTab` 抽出的纯看板组件） |
| 插件侧 | provider 注册 `LibraryOpsBoardView` 到该 slot（React.lazy，独立 chunk）；视图切换器渲染 7 个视图，其中「看板」直接渲染宿主的 `IssueBoard` |
| 采样生命周期 | 视图挂载 → `refresh()` + `setInterval(settings.refreshMs)`；卸载 → `clearInterval`。切视图/关面板即停，无后台轮询 |
| 删除的东西 | `components/LibraryOpsPanel.tsx`、`components/LibraryOpsLauncher.tsx`、`components/monitor/SessionsPanel.tsx`、store 的 `open/openPanel/closePanel/togglePanel`、`MonitorTab` 的 `overview/teams/sessions/cost`、CSS 的 `.lo-overlay/.lo-shell*` |
| 设置项语义 | `defaultTab` → 看板页签打开时的默认视图（默认 `board`）；`autoOpen` → 启动时自动打开「任务管理 → 看板」（默认关） |
| 皮肤/许可 | 不变：CSS 只用皮肤令牌；美术许可卡仍在「设置」视图里 |

### 9.4 场景图可上传 + 自动对位（v1.14.0）

**上传**：设置 →「场景图片」可切换内置像素画 / 内置 AI 场景图，或把图片**拖到场景上**上传；
图片以 Blob 存 IndexedDB（`codem-library-ops` / `scene-images`），不写宿主数据。
`scripts/build-library-ops-scene-preset.mjs` 可把任意图规范化成 2752×1536 的内置预设。

**自动对位**（`core/scene-align.ts`，纯函数）：

1. 上传图缩到 96×54 灰度网格；
2. **地面掩码** = 亮度高于均值 92% 且 3×3 局部方差 ≤ 260 的像素（地面平滑，墙线/家具边缘被排除）；
3. **目标掩码** = 内置 12 个房间矩形栅格化（内缩 12%）；
4. 在「缩放 0.86–1.14 × 平移 ±9%/±9%」粗网格（7×9×9）+ 最优解附近精搜索上最大化 **IoU**；
5. 输出 `{scale,x,y}`（与 CSS `transform-origin: 50% 50%` 同一变换约定）+ 置信度；
   置信度 ≥ `ALIGN_MIN_SCORE`(0.42) 自动应用，否则只提示「建议手动微调」。

上传后自动跑一次；设置卡里可点「自动对位」重跑、点「手动对位编辑器」进入对位模式
（拖房间框/走道节点，按场景图分别持久化）。

### 9.5 界面自适应与图标/样式统一（v1.14.0）

| 问题 | 原因 | 处理 |
| --- | --- | --- |
| 元素挤压 / 重叠 / 裁切 | 版面写死（236px 列、`min-height:460px`、事件流 280px、侧栏 300px）+ 断点用**视口**宽度判断（面板宽度其实是 `min(1180px,96vw)`）+ 子视图被 `flex:1` 塞进固定高度 | `.lo-task` 设为**容器**（`container-type: inline-size`），全部改 `minmax()/clamp()`，断点改 `@container lo (…)`；**内容区滚动、子视图自然高度**；新增 `audit-layout.mjs` 逐视图检查 |
| 场景 + 花名册在窄容器挤成两列 | 固定两列网格 | ≤980px 改上下两段（下段 ≤45%，卡片内部滚动） |
| 样式自成一套 | 圆角 12–16px、半透明底色、uppercase 小标题 | 对齐宿主 `.card`/`.badge`：10px 圆角 + `--bg-secondary` + `--border-primary` + hover 边框 |
| 图标是 emoji | 数据层 `icon` 存 emoji | `components/icons.tsx`（`LoIcon` + `LO_ICONS`，49 个语义名 → lucide-react），数据层改存 `LoIconName` |

**自动门禁**：
- `tools/preview/audit-layout.mjs` —— headless 在 7 种窗口宽度（1600/1440/1280/1100/980/860/760）
  下逐个渲染插件视图，读页面自检写入的 `#layout-audit`（横向 >6px / 纵向 >4px 裁切、
  兄弟元素重叠 >4×4px），要求全部为 0；
- `src/test/library-ops-icons.test.tsx` LO-ICON-1~5 —— 图标名登记、源码无 emoji、
  `LoIcon` 渲染 svg、公共组件渲染 svg、样式层无死样式 + 含容器查询规则。

### 9.6 验证

- `library-ops-task-center.test.tsx` LO-TASK-1~7：任务管理固定 8 个页签（无「图书馆」）/
  无贡献者渲染宿主 Issues 看板 / 有贡献者渲染接管视图（7 个视图）/
  `initialTab=board` 直达 / 贡献者被移除时回退看板 / 快捷键与事件别名 / slot 声明；
- `library-ops-ui.test.tsx` LO-UI-3~12：挂载 `LibraryOpsBoardView`，断言无独立面板外壳、
  7 个视图、场景/用量/错误/时间线/设置渲染、挂载采样 + 卸载停止；
- `library-ops-align.test.ts` LO-ALIGN-1~7：灰度化 / 地面掩码 / 房间掩码 / 已知变换反解 /
  端到端 adjust 与低置信度 / clamp / 解码降级；
- 全量 `npx vitest run` 196 文件 / 4533 用例通过（+15 跳过）+ `tsc` 零错误 + DOM 审计 0 issue +
  版面审计 7 种宽度全 0。

### 9.7 第二轮去重与宿主审计（v1.14.0 收尾）

**去重（图书馆 ↔ 任务管理）**：

| 重叠 | 决策 | 落点 |
| --- | --- | --- |
| 「概览」最近活动 ↔ 插件「时间线」 | 概览只留**最近 5 条**，全量入口给「查看完整时间线」（`useSlotHasEntries(TASK_CENTER_BOARD_SLOT)` 判定插件是否启用，禁用时不出现） | `OverviewTab.tsx` |
| 插件「场景」↔ 宿主「子智能体 / 团队」 | 场景是**同一份数据的可视化表达**，面板内明确标注，不再重复明细列表 | `LibraryPanel.tsx` |
| 自动化触发器 ↔ 设置面板自动化设置 | 唯一编辑入口是「任务管理 → 自动化」，设置面板只留跳转提示 | `SettingsPanel.tsx` |
| 插件元数据里的旧「图书馆页签」按钮 id | 删除 `task-center-library-tab`，`degradedTo` 改为「看板回退」 | `plugin-registry-provider.ts` |

**宿主侧审计（不是插件缺陷，但会影响看板体验）**：任务管理 8 个页签 + 看板页签两轮共修
29 项（第一轮 15 项：P0 1 / P1 7 / P2 7；第二轮独立复审 14 项：P1 2 / P2 8 / P3 4），
详见 `CHANGELOG.md` 的「审计与修复：任务管理」两张表。与插件直接相关的两项：

1. 看板缺 `blocked` / `cancelled` 列 —— 这两类 Issue 在「看板」页签上会**直接消失**（插件接管后
   默认视图就是它），已补齐 7 列；
2. 看板内容区 `overflow: hidden` —— 列多/窗口窄时无法滚动，已恢复滚动。

回归用例：`src/test/task-center-audit-fixes.test.tsx`（TC-AUDIT-* 12 例）+
`src/test/task-center-audit-fixes-2.test.tsx`（TC-AUDIT2-* 14 例，含
「面板打开期间跟随页签请求」「无项目不跨项目串数据」「收件箱点击穿透到 Issue 详情」
「single 槽位最高优先级胜出」）。

### 9.9 第二轮收敛：场景归「子智能体」+ 角色绑定规则（v1.15.0）

用户反馈「任务管理里还有很多功能与看板重叠」，逐条分析后整改：

| 用户意见 | 判断 | 落地 |
| --- | --- | --- |
| 「概览的最近活动可以用看板的用量替代」 | **基本成立**（细节：活动明细的对应视图是「时间线」，「用量」是 KPI/成本/分布） | 概览只留四张统计卡 + 「活动与用量」入口（`用量` / `时间线` 两个按钮直达看板子视图）；插件禁用时仍回退宿主活动预览 |
| 「子智能体情况可以用场景显示」「看板里的设置移到这里」 | **成立** —— 场景里站着的就是队长/成员/子智能体，设置调的也全是场景显示 | 新增宿主扩展点 `task-center.subagents`，插件 `LibraryOpsSceneView`（**场景 | 设置**）接管；「看板」收敛为 看板/用量/工具/错误/时间线；`Ctrl/Cmd+Shift+L` 改为打开「子智能体 → 场景」 |
| 「角色应该和团队、子智能体绑定；没有团队也没有子智能体时只剩队长待命」 | **成立** —— 之前每个会话都变成一个角色，馆内会被闲置会话塞满 | 角色来源收敛为：队长（当前会话 + 各运行时团队队长）/ 团队成员 / 子智能体 / **仅在途委派**的目标会话；闲置会话与团队模板角色不再入馆 |

**新的页签分工**：

```
任务管理（TaskCenter，宿主 8 个页签）
├── 概览        统计卡 + 「活动与用量」入口（→ 看板 → 用量 / 时间线）
├── 委派 / 自动化 / Issues / 团队 / 收件箱
├── 子智能体    ← slot: task-center.subagents（插件接管：场景 | 设置；禁用时回退宿主列表）
└── 看板        ← slot: task-center.board（插件接管：看板 | 用量 | 工具 | 错误 | 时间线）
```

**跨页签跳转**：插件内统一走 `useLibraryOps.requestView(view)` ——
视图属于本宿主就本地切，否则派发宿主已有的 `codem:open-task-center`（`detail.view`）让宿主切页签；
「用量 → 场景 →」、设置卡里的「手动对位编辑器」都走这条链路（宿主不依赖插件）。

**角色绑定表**（`telemetry-adapter.ts`）：

| 来源 | 条件 | 标签 |
| --- | --- | --- |
| 队长 | 当前会话 + 未归档运行时团队的 `captainSessionId` | `队长 · <团队>` / `队长 · 主控` |
| 团队成员 | 团队成员（`removed` 除外） | `成员 · <角色>` |
| 子智能体 | 全部 `SubagentTask`（**有团队、无团队都显示**） | `子智能体 · <agentId>` |
| 协作会话 | 仅在途委派（pending/running）的 `targetSessionId` | `委派 · 协作会话` |
| ~~普通会话~~ | 不再入馆（原先每个会话一个角色） | — |
| ~~团队模板角色~~ | 不再占位（原先「没建队却满馆人」） | — |

⇒ **没有团队、没有子智能体、没有在途委派时，馆内只有队长一个角色，处于待命态**；
「用量」页的场景大卡与「场景」视图共用同一份快照，行为一致。

**审计/预览同步升级**：`tools/preview` 支持 `?host=scene`（渲染场景宿主）与
`?audit=1&view=<子视图>`；`audit-layout.mjs` 新增 `--host=` 参数，
现在按页签分别跑（board 5 视图 / scene 2 视图 × 7 种窗口宽度）。

### 9.8 看板子视图与实时事件流的冲突（v1.14.1）

**现象**：v1.14.0 上线后用户反馈「看板里的看板子视图内容被实时事件遮挡」。

**原因**：`.lo-task__body` 是三栏 flex（导航 + 内容 + 事件流）。事件流固定占
`clamp(200px, 24cqw, 280px)`，看板 7 列的最小宽度是 `7×180 + 6×12 + 24 = 1344px`，
内容区只剩 ~800px → 右侧 3 列被挤出可视区；更糟的是宿主 `IssueBoard` 的
`height: 100%` 在内容区里会多出 24px（盒模型差异），把它的横向滚动条推到折叠线以下，
用户既看不到被切掉的列，也看不到滚动条 —— 观感就是「被事件流盖住了」。

**处理**：

| 关注点 | 做法 |
| --- | --- |
| 看板让位 | 看板子视图**默认不渲染**事件流（`feedVisible = showEventFeed && tab !== "timeline" && (tab !== "board" || feedOnBoard)`）；状态条新增「实时事件」开关（`layout-panel-left`，`aria-pressed`）供临时打开 |
| 铺满内容区 | 插件侧新增 `.lo-board-host` 包裹宿主 `IssueBoard`（`flex: 1 1 auto; min-height: 0`），看板正好等于内容区高度，横向滚动条落在可视区内 |
| 7 列一屏排完 | 宿主列最小宽度改走 CSS 变量 `--issue-col-min`（默认 180px 不变，保持宿主回退时的可读性），插件在看板宿主上收紧到 128px：宽面板内容区 1089px 可放下 `7×128 + 6×12 + 24 ≈ 1020px`，`scrollWidth == clientWidth` |
| 其它视图 | 不变：场景/用量/工具/错误/设置仍按设置显示事件流（内容宽度 809px + 事件流 280px） |

**审计为什么没抓到（已修）**：旧 `tools/preview` 只渲染插件的子视图容器
（`<div class="lo-task"><div class="lo-task__body"><main class="lo-task__content">`），
既没有导航栏也没有事件流，而且根本不渲染宿主看板（`AuditedView` 对 `board` 返回占位）。
现在预览改为渲染**真实的** `LibraryOpsBoardView`，并在审计模式下把宿主 `IssueBoard`
真组件一起测（`issue-stub.ts` 提供固定 Issue 数据、`store-stub.ts` 顶掉会拉进 sql.js 的项目 store），
同时加载宿主全局样式 `src/styles.css`（`* { box-sizing: border-box }` + 皮肤令牌）以保证几何一致。
子视图审计 6 → 7（含「看板」），并新增 `tools/preview/probe-layout.mjs` 打印
body/导航/内容区/事件流/看板宿主的矩形与 `scrollWidth`，用于定位「被遮挡 / 被裁切」类问题。

---

## 十、已知边界与后续可做

| 项 | 现状 | 后续 |
| --- | --- | --- |
| 缓存命中 token | 适配层预留 `tokensCached` 字段，当前 CostTracker 聚合口径未提供 | 接入 provider 上报的 cache 字段 |
| 权限/审批等待态 | 只能从工具名（`ask_user_question` 等）推断 | 接入 `PermissionRequest` 待决队列，角色真正站到「等待授权」岗位 |
| 场景地图 | 单层平面（10 岗位） | 可扩展多层/多馆，按项目分馆 |
| 场景图片 | 可上传替换画面（IndexedDB）+ 自动对位；房间框与走道可在对位模式里拖动，按图分别保存 | 可做「逐房间」自动对位（当前只做全局相似变换）与对位数据导出/分享 |
| 角色移动 | 网格 BFS + 线性插值 | 可加转弯缓动、避让、结伴同行 |
| 历史回放 | 只有最近 120 个采样点 | 可接 EventLog 做时间轴回放 |
| 与任务管理的边界 | 占两个宿主页签：**看板**（看板/用量/工具/错误/时间线）与**子智能体**（场景/设置）；概览只留入口，活动明细不在宿主重复 | 若宿主新增「用量」页签，把「用量」移过去；「团队」页签若要展示成员动态，可复用场景的 actor 数据 |
