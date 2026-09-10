# @codem/ui-library-ops — 图书馆运营监控（Library Ops Monitor）

> 完全独立、可启停的 Codem 大插件。
> 把**团队角色与子智能体**变成各自不同的动画角色，在**像素美术图书馆**里各自的岗位上工作；
> 监控界面完全对标 lobster-pet，并把图书馆作为监控界面内的**场景**嵌入。

> ⚠️ **美术资源许可**：默认「像素图书馆」场景使用第三方像素美术资源，
> **仅限非商业用途**（ClawLibrary CC BY-NC-SA 4.0 / Star-Office-UI 非商业）。
> 商业分发请把场景风格切到「等距矢量」（本项目自绘）或替换资源。
> 完整声明见 [`docs/ASSET-LICENSES.md`](../../../docs/ASSET-LICENSES.md)。

---

## 1. 这个插件做什么

| 能力 | 说明 |
| --- | --- |
| **两种场景风格** | **像素图书馆**（默认，集成 ClawLibrary 手绘像素美术：2752×1536 场景底图 + 家具层 + 12 个房间 + walkGraph 寻路）与**等距矢量**（本项目自绘，无第三方许可约束） |
| **多角色图书馆** | 像素场景里 12 个房间映射到 10 个职能岗位；角色沿上游手工标注的可行走主干行走，到岗后播放对应动作 |
| **角色精灵动画** | 集成 ClawLibrary 的 **Capy-Claw / Cat-Claw** 两套角色 × 12 套动作（work/read/idea/repair/error/sleep/coffee/rest/walk/stand_front/stand_back/lie_flat…），帧 128×128 @6fps；按角色 id 稳定分配变体 |
| **11 种工作动画** | 待命 / 行走 / 思考 / 阅读 / 撰写 / 执行 / 检索 / 等待授权 / 完成 / 出错 / 休眠 —— 由**真实工具调用与任务状态**驱动，映射到上游精灵动作 |
| **运营监控看板** | 布局对标 lobster-pet：**行 1** 状态卡(236px) + 最近会话卡网格 + 活动概览(热力图/环形图/小时柱状图)；**行 2** 左栈（团队卡 + 任务与工具卡 + 数据源与健康度卡）与**图书馆场景大卡** |
| **相机可交互** | 滚轮缩放（以指针为锚点，0.3×–3.2×）/ 拖拽平移 / 双击复位 / HUD 缩放与在馆统计 / 选中角色镜头平滑居中 |
| **真实数据** | 会话 / 团队（AgentTeamsService）/ 子智能体（SubagentRuntime）/ 团队模板（SquadManager）/ 工具调用（消息流）/ token 与成本（CostTracker）/ 遥测事件，全部只读 |

### 角色来源 → 岗位映射

| 角色来源 | 展示类型 | 岗位判定依据 |
| --- | --- | --- |
| 团队队长会话 | 🎩 队长 | 角色标签关键词（队长 / 调度） |
| 普通会话 / worktree 分支会话 | 💬 会话 | 分支名与标题关键词 |
| 运行时团队成员（`TeamMember`） | 🧑‍💼 成员 | `member.role` 角色描述 |
| 子智能体（`SubagentTask`） | 🤖 子智能体 | `agentId`（explore / build / general） |
| 团队模板角色（无运行时成员时） | 🧑‍💼 成员 | `roleDescription` |
| 无任何数据时的兜底 | 🧩 系统 | 值班馆员（保证图书馆不空场） |

岗位关键词命中表见 `data/library-map.ts` 的 `keywords` 字段；
岗位 → 像素房间映射见 `data/pixel-art.ts` 的 `ZONE_TO_ROOM`。

---

## 2. 目录结构

```
src/plugins/library-ops/
├── index.ts                      # 公共导出（组件 / store / 引擎 / 数据 / 几何）
├── types.ts                      # 领域类型 + 活动元数据 + 默认设置（含 sceneStyle）
├── store.ts                      # zustand store（子视图 / 采样调度 / 时间序列 / 两套场景态）
├── data/
│   ├── library-map.ts            # 岗位地图：10 岗位 / 装饰 / 投影 / 岗位路由 / 工位槽位
│   ├── characters.ts             # 角色外观生成器（等距场景用，确定性 + 岗位倾向 + 令牌化调色板）
│   └── pixel-art.ts              # 像素资源清单：房间 / walkGraph / 精灵表元数据 / 岗位→房间映射
├── core/
│   ├── pathfinder.ts             # 等距：可通行网格 + BFS 寻路
│   ├── scene-engine.ts           # 等距场景状态机（纯函数）
│   ├── pixel-path.ts             # 像素：walkGraph 图最短路 + 房间工位排布
│   ├── pixel-scene.ts            # 像素场景状态机（纯函数）
│   ├── telemetry-adapter.ts      # 真实 Codem 数据 → LibrarySnapshot（只读 + 可注入）
│   └── format.ts                 # 数值/时间格式化（全插件统一口径）
├── components/
│   ├── LibraryOpsViewShell.tsx   # 两个页签共用的外壳（状态条 + 子导航 + 内容区 + 可选事件流）
│   ├── LibraryOpsBoardView.tsx   # 「看板」页签接管视图（看板/用量/工具/错误/时间线）
│   ├── LibraryOpsSceneView.tsx   # 「子智能体」页签接管视图（场景/设置）
│   ├── library/
│   │   ├── iso.ts                # 等距几何（角点/中心两套约定 + 立方体 + 网格线 + 窗）
│   │   ├── PixelLibraryScene.tsx # 像素图书馆场景（默认，ClawLibrary 美术）
│   │   ├── LibraryScene.tsx      # 等距矢量场景（备用，本项目自绘）
│   │   ├── SceneFurniture.tsx    # 8 类等距矢量家具
│   │   └── CharacterActor.tsx    # 等距角色 SVG（11 种动画）
│   └── monitor/                  # common / charts / labels / EventList / SceneImageCard / 8 个监控面板
└── styles/library-ops.css        # 样式（只消费皮肤令牌）

public/library-ops/               # 第三方像素美术资源（仅限非商业，见 docs/ASSET-LICENSES.md）
├── claw-library/                 # 图书馆场景 + Capy/Cat 角色精灵（CC BY-NC-SA 4.0）
├── star-office/                  # 办公室场景资源（非商业）
└── lobster-pet/                  # 设计参考声明（无美术资源）
```

配套开发工具（不参与打包）：`tools/preview/` 提供固定快照的视觉预览页 +
`audit-dom.mjs` DOM 结构审计脚本（校验角色是否落在自己岗位的等距包围盒内、
家具/网格/窗户数量、NaN 泄漏）。

---

## 3. 集成点（宿主侧改动一览）

| 文件 | 改动 |
| --- | --- |
| `src/core/provider/ui-library-ops-provider.ts` | **新增** provider：注册图书馆视图到 `task-center.library`，`provide('uiLibraryOps')`；`Ctrl/Cmd+Shift+L` 与 `codem:open-library-ops` → 打开「任务管理 → 图书馆」 |
| `src/core/ui-plugins/gating.ts` | **新增**：禁用门控（短名 → 插件 id）独立成模块，装载器与测试共用 |
| `src/core/ui-plugins/index.ts` | 导入 + 加入 `uiProviders`；消费 `isUiProviderGated()` |
| `src/core/plugin-loader/builtin-registry.ts` | 注册 `@codem/ui-library-ops`（provides `uiLibraryOps` / inject `slots`） |
| `src/core/provider/plugin-registry-provider.ts` | 插件市场元数据（riskLevel safe + uiImpact） |
| `src/core/provider/agent-teams-service.ts` | **宿主修复**：任务进终态 / 转派后释放成员为 `idle`（原先成员会永久卡在 `working`） |

**`App.tsx` 零改动**：图书馆视图是任务管理面板里由 `task-center.library` slot
渲染出来的；打开入口走宿主已有的 `codem:open-task-center`。

---

## 4. 启停语义（本插件最重要的约束）

- **启用**：插件接管任务管理的**两个**页签 ——「看板」（看板/用量/工具/错误/时间线）与
  「子智能体」（场景/设置）；`Ctrl/Cmd+Shift+L` 或派发 `codem:open-library-ops` 直接打开
  「子智能体 → 场景」。
- **禁用**（插件管理 → 关闭 `@codem/ui-library-ops`）：provider 不装配 →
  两个 slot 均无贡献者 → 看板回退宿主 Issues 看板、子智能体回退宿主列表，宿主数据**零变化**。
- **页签切走 / 关闭任务管理时**：停止采样，无任何后台轮询与定时器。
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

## 6. 测试（11 文件 / 130 用例）

| 文件 | 覆盖 |
| --- | --- |
| `src/test/library-ops-map.test.ts` | 地图完整性 / 投影互逆 / 岗位路由 / 槽位稳定 / 可通行网格 / BFS 最优性（13 例） |
| `src/test/library-ops-characters.test.ts` | 外观确定性 / 取值范围 / 岗位倾向 / 调色板令牌化 / 越界安全（8 例） |
| `src/test/library-ops-scene.test.ts` | 入场 / 到岗 / 离场淡出 / 分配稳定 / 工位分离 / 行走与朝向 / 动画映射 / done 衰减 / 工位不越界 / 深度排序 / 统计 / 非法 dt（13 例） |
| `src/test/library-ops-adapter.test.ts` | 角色来源 / 指标聚合 / 活动分布 / 事件流 / 失败可见性 / 健康度 / 只读契约 / 缺省依赖 / Map 形态活跃会话（13 例） |
| `src/test/library-ops-integration.test.ts` | 注册链路 / provider 装配与释放 / 目录结构 / 只读门禁 / 皮肤契约 / 设置持久化 / 禁用门控（17 例） |
| `src/test/library-ops-real-integration.test.ts` | **真实服务联动**：真 AgentTeamsService 建队派活 / 成员释放 / 团队模板 / 成本 / 依赖形状 / 子智能体 / 归档不残留（8 例） |
| `src/test/library-ops-geometry.test.ts` | 等距几何不变量：角点/中心关系 / 区域多边形 / 地板 / 网格线 / 立方体 / 槽位在区域内且可通行（9 例） |
| `src/test/library-ops-scene-render.test.tsx` | **等距渲染几何**：区域多边形 / 角色落在自己岗位包围盒 / 8 类家具三面齐全 / 网格与窗 / 无 NaN / rAF 动画同步 / 选中高亮（7 例） |
| `src/test/library-ops-pixel.test.ts` | **像素场景数据**：岗位→房间映射 / walkGraph 连通 / 路由 / 精灵表自洽 / 11 状态映射 / 场景推进 / 工位不重叠 / 变体分配 / **资源文件真实存在** / 许可声明齐备（12 例） |
| `src/test/library-ops-pixel-render.test.tsx` | **像素场景渲染**：图层 / 12 房间 / 精灵 URL 与帧偏移 / 角色落在自己房间 / 房间点击 / 资源缺失降级 / 选中高亮（6 例） |
| `src/test/library-ops-ui.test.tsx` | 角色 11 态渲染 / 差异化 / 图书馆视图 8 个子视图 / 两种场景风格 / 角色选中 / 团队/成本/错误/时间线 / 设置持久化 / Esc 关闭 / 徽标 / 岗位详情 / HUD（12 例） |

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
| **注册到 `task-center.library` 而非改 App.tsx** | 宿主新增扩展页签 slot，插件自挂载 → App.tsx 零改动，禁用即页签消失 |
| **采样只在图书馆页签可见时进行** | 切走页签/禁用插件后宿主零开销；`refreshMs` 可调（1s ~ 10s）；入口徽标只在挂载时采样一次 |
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
