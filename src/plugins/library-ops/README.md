# @codem/ui-library-ops — 图书馆运营监控（Library Ops Monitor）

> 完全独立、可启停的 Codem 大插件。
> 把**团队角色与子智能体**变成各自不同的动画角色，在 ClawLibrary 风格的图书馆里
> 各自的岗位上工作；监控界面完全对标 lobster-pet，并把图书馆作为监控界面内的**场景**。

---

## 1. 这个插件做什么

| 能力 | 说明 |
| --- | --- |
| **多角色图书馆** | 10 个功能区（前台 / 阅览大厅 / 编目室 / 代码工坊 / 写作工坊 / 档案室 / 机房 / 会议厅 / 借还台 / 静思角），每个角色按职责自动分配到对应岗位的工位上 |
| **角色自动生成** | 每个角色由 id 确定性生成外观：12 套调色板 × 4 种身形 × 5 种发型 × 6 种头饰 × 6 种道具 × 4 种表情（34,560 种组合）；岗位还会影响头饰与道具（队长戴礼帽、运维戴工帽、研究戴学者帽、编码戴耳机、写作戴贝雷帽） |
| **11 种工作动画** | 待命 / 行走 / 思考 / 阅读 / 撰写 / 执行 / 检索 / 等待授权 / 完成 / 出错 / 休眠 —— 由**真实工具调用与任务状态**驱动 |
| **运营监控看板** | 总览（KPI + 健康度 + 14 天热力图 + 会话类型环形图 + 小时活跃柱状图）、图书馆、团队、会话、工具、成本、错误、时间线、设置 9 个页签 + 右侧实时事件流 |
| **真实数据** | 会话 / 团队（AgentTeamsService）/ 子智能体（SubagentRuntime）/ 团队模板（SquadManager）/ 工具调用（消息流）/ token 与成本（CostTracker）/ 遥测事件，全部只读 |
| **场景嵌入监控** | 图书馆就是监控界面里的一个页签，与其它监控卡共享同一份快照（同一真相源，口径一致） |

### 角色来源 → 岗位映射

| 角色来源 | 展示类型 | 岗位判定依据 |
| --- | --- | --- |
| 团队队长会话 | 🎩 队长 | 角色标签关键词（队长 / 调度） |
| 普通会话 / worktree 分支会话 | 💬 会话 | 分支名与标题关键词 |
| 运行时团队成员（`TeamMember`） | 🧑‍💼 成员 | `member.role` 角色描述 |
| 子智能体（`SubagentTask`） | 🤖 子智能体 | `agentId`（explore / build / general） |
| 团队模板角色（无运行时成员时） | 🧑‍💼 成员 | `roleDescription` |
| 无任何数据时的兜底 | 🧩 系统 | 值班馆员（保证图书馆不空场） |

岗位关键词命中表见 `data/library-map.ts` 的 `keywords` 字段。

---

## 2. 目录结构

```
src/plugins/library-ops/
├── index.ts                      # 公共导出（组件 / store / 引擎 / 数据）
├── types.ts                      # 领域类型 + 活动元数据 + 默认设置
├── store.ts                      # zustand store（面板开关 / 采样调度 / 时间序列）
├── data/
│   ├── library-map.ts            # 等距地图：10 岗位 / 装饰 / 投影 / 岗位路由 / 槽位
│   └── characters.ts             # 角色外观生成器（确定性 + 岗位倾向 + 令牌化调色板）
├── core/
│   ├── pathfinder.ts             # 可通行网格 + BFS 寻路 + 等距投影
│   ├── scene-engine.ts           # 场景状态机（入场 / 行走 / 到岗 / 离场 / 气泡）
│   ├── telemetry-adapter.ts      # 真实 Codem 数据 → LibrarySnapshot（只读 + 可注入）
│   └── format.ts                 # 数值/时间格式化（全插件统一口径）
├── components/
│   ├── LibraryOpsLauncher.tsx    # 入口圆钮（挂 app.overlay，可拖拽 + 状态徽标）
│   ├── LibraryOpsPanel.tsx       # 监控界面外壳（Portal 全屏，9 页签）
│   ├── library/
│   │   ├── iso.ts                # 等距几何（角点/中心两套约定 + 立方体 + 网格线 + 窗）
│   │   ├── LibraryScene.tsx      # 图书馆场景（缩放/平移/定位/家具/角色层）
│   │   ├── SceneFurniture.tsx    # 8 类等距矢量家具
│   │   └── CharacterActor.tsx    # 角色 SVG（部件 + 11 种动画）
│   └── monitor/                  # common / charts / labels / 9 个监控面板
└── styles/library-ops.css        # 样式（只消费皮肤令牌）
```

配套开发工具（不参与打包）：`tools/preview/` 提供固定快照的视觉预览页 +
`audit-dom.mjs` DOM 结构审计脚本（校验角色是否落在自己岗位的等距包围盒内、
家具/网格/窗户数量、NaN 泄漏）。

---

## 3. 集成点（宿主侧改动一览）

| 文件 | 改动 |
| --- | --- |
| `src/core/provider/ui-library-ops-provider.ts` | **新增** provider：注册入口组件到 `app.overlay`，`provide('uiLibraryOps')` |
| `src/core/ui-plugins/gating.ts` | **新增**：禁用门控（短名 → 插件 id）独立成模块，装载器与测试共用 |
| `src/core/ui-plugins/index.ts` | 导入 + 加入 `uiProviders`；消费 `isUiProviderGated()` |
| `src/core/plugin-loader/builtin-registry.ts` | 注册 `@codem/ui-library-ops`（provides `uiLibraryOps` / inject `slots`） |
| `src/core/provider/plugin-registry-provider.ts` | 插件市场元数据（riskLevel safe + uiImpact） |
| `src/core/provider/agent-teams-service.ts` | **宿主修复**：任务进终态 / 转派后释放成员为 `idle`（原先成员会永久卡在 `working`） |

**`App.tsx` 零改动**：入口挂载在宿主已有的 `<SlotListBridge name="app.overlay" />` 上。

---

## 4. 启停语义（本插件最重要的约束）

- **启用**：入口圆钮出现在输入区上方右下角（可拖拽移动、双击复位，或 `Ctrl/Cmd+Shift+L`）；
  圆钮徽标显示当前工作中的角色数，有异常角色时显示 `!`。
- **禁用**（插件管理 → 关闭 `@codem/ui-library-ops`）：provider 不装配 →
  入口与面板都不存在，宿主 UI 与数据**零变化**。
- **面板关闭时**：停止采样，无任何后台轮询与定时器。
- **只读**：适配层只调用宿主服务的读接口；`library-ops-integration.test.ts` 的
  LO-INT-7 用禁止词表把「插件不得写宿主」变成门禁。

---

## 5. 皮肤兼容

插件样式只消费 Codem 设计令牌（`--bg-*` / `--text-*` / `--accent*` /
`--success|warning|error|info` / `--fs-*` / `--radius*` / `--shadow-*`），
半透明一律用 `color-mix(in srgb, var(--token) N%, transparent)` 派生，
**全文件零硬编码色值** —— 因此 default（亮/暗）、dream、hub 四态自动适配。
门禁：`src/test/library-ops-integration.test.ts` 的 LO-SKIN-1 ~ LO-SKIN-4。

角色配色同样令牌化：12 套调色板全部由 `var(--token)` 组成，皮肤切换时角色一起变。

---

## 6. 测试（9 文件 / 100 用例）

| 文件 | 覆盖 |
| --- | --- |
| `src/test/library-ops-map.test.ts` | 地图完整性 / 投影互逆 / 岗位路由 / 槽位稳定 / 可通行网格 / BFS 最优性（13 例） |
| `src/test/library-ops-characters.test.ts` | 外观确定性 / 取值范围 / 岗位倾向 / 调色板令牌化 / 越界安全（8 例） |
| `src/test/library-ops-scene.test.ts` | 入场 / 到岗 / 离场淡出 / 分配稳定 / 工位分离 / 行走与朝向 / 动画映射 / done 衰减 / 工位不越界 / 深度排序 / 统计 / 非法 dt（13 例） |
| `src/test/library-ops-adapter.test.ts` | 角色来源 / 指标聚合 / 活动分布 / 事件流 / 失败可见性 / 健康度 / 只读契约 / 缺省依赖 / Map 形态活跃会话（13 例） |
| `src/test/library-ops-integration.test.ts` | 注册链路 / provider 装配与释放 / 目录结构 / 只读门禁 / 皮肤契约 / 设置持久化 / 禁用门控（17 例） |
| `src/test/library-ops-real-integration.test.ts` | **真实服务联动**：真 AgentTeamsService 建队派活 / 成员释放 / 团队模板 / 成本 / 依赖形状 / 子智能体 / 归档不残留（8 例） |
| `src/test/library-ops-geometry.test.ts` | 等距几何不变量：角点/中心关系 / 区域多边形 / 地板 / 网格线 / 立方体 / 槽位在区域内且可通行（9 例） |
| `src/test/library-ops-scene-render.test.tsx` | **渲染几何**：区域多边形 / 角色落在自己岗位包围盒 / 8 类家具三面齐全 / 网格与窗 / 无 NaN / rAF 动画同步 / 选中高亮（7 例） |
| `src/test/library-ops-ui.test.tsx` | 角色 11 态渲染 / 差异化 / 面板 9 页签 / 场景渲染 / 角色选中 / 团队/成本/错误/时间线 / 设置持久化 / Esc 关闭 / 徽标 / 岗位详情 / HUD（12 例） |

```bash
npx vitest run src/test/library-ops-*.test.ts src/test/library-ops-*.test.tsx
```

审计结论与问题清单见 `docs/LIBRARY-OPS-AUDIT.md`。

---

## 7. 设计决策记录

| 决策 | 取舍 |
| --- | --- |
| **DOM + SVG，不用 Phaser** | 大富翁插件用了 Phaser，但 Phaser 无法在 happy-dom 下单测；本插件把「动画行为」做成可测的纯状态机（`scene-engine.ts`），场景用 SVG 地板 + DOM 角色层，逐帧只改 `transform`（不触发 React 重渲染） |
| **角色外观程序化生成，不用精灵图** | 无外部美术资源与授权问题；12×4×5×6×6×4 组合足以让一个团队里人人不同；且完全跟随皮肤令牌 |
| **网格 BFS 寻路** | ClawLibrary 用 walkGraph + 多边形碰撞，需要手工维护美术坐标；本插件是开放平面瓦片地图，网格 BFS 更简单且可测（LO-PATH-3 断言入口到 10 个岗位全部可达） |
| **挂 `app.overlay` 而非改 App.tsx** | 宿主已有该 list 型 slot 的消费点，插件自挂载 → App.tsx 零改动，禁用即彻底消失 |
| **采样只在面板打开时进行** | 关闭面板/禁用插件后宿主零开销；`refreshMs` 可调（1s ~ 10s）；入口徽标只在挂载时采样一次 |
| **健康度加权公式** | 完成率 40% + 无错率 35% + 活跃度 25%；缺数据时按中性值处理，不虚高 |
| **相机可缩放/平移/定位** | 画布 1408×768 直接塞进面板会把角色压到 20 多像素，故提供滚轮缩放 + 拖拽平移 + 双击复位 + 选中角色平滑居中 |

---

## 8. 参考项目

- [shengyu-meng/ClawLibrary](https://github.com/shengyu-meng/ClawLibrary) —— 2D 像素图书馆 + 角色在资源分区工作的视觉母题、
  `WorkStateProfile`（工作状态 → 岗位/产出类别）、walkGraph + BFS 路由。
- [jiaweisibot/lobster-pet](https://github.com/jiaweisibot/lobster-pet) —— 桌面宠物 + 运营监控看板：
  `DetailPanel` 的「标题栏 + 卡片网格 + 场景嵌入」布局、`StatusCard` / `TaskGrid` /
  `ActivityViz`（14 天热力图 + 会话类型环形图 + 小时活跃柱状图）/ `TokenBar` / 实时事件流。

两个项目均为 MIT；本插件**未复制其代码或美术资源**，只借鉴了信息架构与交互母题，
并按 Codem 的皮肤令牌体系与可测试性要求重新实现。
