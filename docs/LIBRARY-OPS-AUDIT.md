# 图书馆运营监控插件 —— 全面审计报告（v1.12.0）

> 审计对象：`@codem/ui-library-ops`（`src/plugins/library-ops/`）
> 审计时间：2026-09-10 | 审计范围：与团队/子智能体联动真实性、角色与场景视觉对标水平、功能断点、Bug、潜在问题
> 结论：**四轮审计发现 28 项问题（P0 8 / P1 11 / P2 9），全部修复并补齐门禁测试；最终 184 测试文件 / 4413 用例通过，tsc 零错误，构建成功。**

---

## 一、审计方法

| 轮次 | 方法 | 覆盖 |
| --- | --- | --- |
| 第一轮 | **真实服务联动审计**：不用 fake，直接驱动 `AgentTeamsService` / `SubagentRuntime` / `SquadManager` / `AgentRegistry` / `CostTracker` 与真实 store，再经 `loadDefaultDeps()` 真实依赖路径采集 | 「能不能和团队及子智能体联动」 |
| 第二轮 | **代码级审查**：逐文件通读场景引擎 / 适配层 / 组件 / 样式 / 集成点 | 功能断点、逻辑 Bug |
| 第三轮 | **渲染几何审计**：用 headless Edge 渲染真实页面 + `--dump-dom`，再用脚本校验每个角色是否落在自己岗位的等距包围盒内、家具/网格/窗户数量、NaN 泄漏 | 「角色和场景是否画对」 |
| 第四轮 | **回归审计**：把前三轮发现的每类问题都写成门禁测试，复跑全量 | 防回归 |

视觉对标另外**实际克隆了两个参考项目源码逐文件阅读**（`shengyu-meng/ClawLibrary`、`jiaweisibot/lobster-pet`），对照其信息架构与美术做法。

---

## 二、问题清单与修复

### P0 — 功能性断点 / 数据错误（8 项）

| ID | 问题 | 证据 | 修复 |
| --- | --- | --- | --- |
| **P0-1** | **团队成员状态永不回落**：宿主 `AgentTeamsService.kick()` 跳过 `working` 成员，而任务进入终态时没人把成员置回 `idle` → 成员永久卡在「工作中」，调度器再也不派活，图书馆里该角色永远显示执行中 | `src/core/provider/agent-teams-service.ts` `update()` 只调 `updateTask` + `kick`；`kick` 对 `working` 成员 `continue` | 新增 `releaseAssigneeIfIdle()`：任务进终态 / 转派后，若该成员名下再无未完成（非终态）任务则置回 `idle`；`update()` 与 `reassign()` 均调用。门禁：LO-REAL-2 / LO-REAL-2b |
| **P0-2** | **活跃会话识别失效**：适配层按 `Set.has()` 判活跃，宿主 `useAppStore.activeSessions` 实为 `Map<string, boolean>` → 所有会话永远不是「活跃」，图书馆里没人显示工作中 | `src/store.ts` `activeSessions: Map<string, boolean>` | `isActive()` 同时支持 Map/Set；门禁：LO-ADP-13 |
| **P0-3** | **角色气泡永不消失**：`bubbleVisible()` 只被测试用到，组件直接按 `s?.bubble` 渲染 → 气泡挂上去就不再消失 | `LibraryScene.tsx` 渲染分支 | rAF 每帧写 `data-bubble="0/1"`，CSS 据此显隐；门禁：LO-RENDER-6 |
| **P0-4** | **到岗瞬间动画不切换**：SVG 的 `data-anim` 只在 React 重渲染时更新，而重渲染由「快照签名」驱动（1.5s 一次）→ 角色走到工位后最多 1.5s 仍播放「行走」 | `signature` 不含场景态 | rAF 每帧把 `a.anim` 直接写到 `svg[data-anim]`；门禁：LO-RENDER-6 |
| **P0-5** | **`done` 动画永久定格**：`desiredAnim` 只要数据态还是 `done` 就永远返回 `done`，`DONE_HOLD_MS` 形同虚设 | `scene-engine.ts` | 超过保持期回落 `idle`；门禁：LO-SCENE-12 |
| **P0-6** | **角色站到岗位外**：`stationSlot` 的环形扩张会取到区域矩形外的瓦片 → 角色站到走廊或别的岗位上 | 早期 `stationSlot` 无矩形裁剪 | 只取落在本区域矩形内的瓦片；场景引擎再吸附到「区域内 + 可通行」格；门禁：LO-GEO-6/7、LO-SCENE-13 |
| **P0-7** | **等距几何双重偏移**：`zonePolygon`/`floorPolygon`/`wallPath` 在 `tileToScreen` 之上又加半瓦片偏移 → 区域高亮整体放大并错位；网格图案原点与地板不对齐 | 早期 `LibraryScene` 内的 `zonePolygon` | 抽出 `components/library/iso.ts` 固化两套约定（`tilePoint` 角点 / `tileCenter` 中心），区域/地板/墙全部用块角点，网格改为 44 条精确直线；门禁：LO-GEO-1~5、LO-RENDER-1/4 |
| **P0-8** | **道具换手**：整个角色 SVG 会按朝向 `scaleX(±1)` 镜像，而 `Prop` 又按 `facing` 交换 x → 转向时道具从右手跳到左手 | `CharacterActor.tsx` `Prop({variant, facing})` | 道具固定同一只手，朝向只由 CSS `--lo-facing` 统一镜像；门禁：LO-UI-1/2 |

### P1 — 体验 / 健壮性 / 契约（11 项）

| ID | 问题 | 修复 |
| --- | --- | --- |
| **P1-1** | 场景画布 1408×768 在面板里被压到 ~0.45 倍，角色只有 20 多像素，看不清 | 新增滚轮缩放（以指针为锚点，0.3×–3×）、拖拽平移、双击复位、HUD 缩放按钮 |
| **P1-2** | 采样若一次挂住，`sampling` 永久为 `true` → 面板停止刷新 | `withTimeout(collectSnapshot(), 15s)`；门禁：LO-STORE-* |
| **P1-3** | 点岗位没有反馈（只有高亮） | 岗位详情卡：职责 / 在岗人数 / 容量告警 / 在岗角色列表（可点选定位）；门禁：LO-UI-11 |
| **P1-4** | 岗位超容量无提示 | 分布列表显示 `n/cap` 并在超容时用告警色；门禁：LO-UI-11 |
| **P1-5** | 装饰是文字字形（▤ ▭ ❦ ✦），远低于参考项目美术水平 | 新增 `SceneFurniture.tsx`：8 类等距矢量家具（书架带书脊、长桌、终端带屏与键盘、柜台、绿植、台灯带光晕、地毯、台阶），每个家具三面明暗由 `color-mix` 派生；门禁：LO-RENDER-3 |
| **P1-6** | 墙是一块平板，纵深弱 | 背墙 + 5 扇窗（等距平行四边形）；门禁：LO-RENDER-4 |
| **P1-7** | 入口圆钮无状态提示 | 徽标显示工作中角色数（有异常时显示 `!` 并转告警色）；门禁：LO-UI-10 |
| **P1-8** | 耳机横梁 `path fill="none"` 被 `.lo-hat path { fill }` 覆盖成实心块；`.lo-trim-band` 被 `.lo-hat rect` 覆盖，帽带色失效 | 提高对应规则特异性（`.lo-hat .lo-headphone-band` / `.lo-hat .lo-trim-band`）；门禁：LO-SKIN-3 + LO-UI-1 |
| **P1-9** | 角色定位与 SVG 尺寸硬编码耦合（`-26px / -68px`），名牌位置随布局漂移 | 角色以「脚下（瓦片中心）」为锚点：wrap 零尺寸 + SVG 绝对定位 + `translateX(-50%)`；名牌/气泡绝对定位 |
| **P1-10** | 「在场景中查看」不会把镜头移到角色身上 | 选中角色时镜头平滑居中（三次缓出，340ms）；门禁：LO-RENDER-7 |
| **P1-11** | 面板切走再切回，角色全部重新从入口走一遍 | `LibraryScene` 新增 `initialScene`，`LibraryPanel` 挂载时读回 store 里的场景态 |

### P2 — 代码质量 / 可测性（9 项）

| ID | 问题 | 修复 |
| --- | --- | --- |
| **P2-1** | 场景/适配层关键几何与联动没有门禁测试 | 新增 3 个测试文件：真实联动（8 例）、几何不变量（9 例）、渲染几何（7 例） |
| **P2-2** | `kindLabel`/`timeOf`/`clock`/`severityZh` 在多个面板各写一遍 | 抽出 `components/monitor/labels.ts` |
| **P2-3** | `characters.shortId` 与 `format.shortId` 同名不同义 | 删除前者，统一用 `format.shortId` |
| **P2-4** | `formatDuration` / `formatDay` 无调用方 | 删除，保持导出面诚实 |
| **P2-5** | `clampTile` 死代码 | 删除 |
| **P2-6** | 插件禁用门控逻辑埋在 `ui-plugins/index.ts`（该文件 import 全部 UI 插件包，测试拉起来要 5s+） | 抽到 `src/core/ui-plugins/gating.ts`；门禁：LO-INT-8 |
| **P2-7** | 场景缺可测性挂钩 | 区域组加 `data-zone-id`、角色 wrap 加 `data-zone-id`，支撑 DOM 结构审计与渲染测试 |
| **P2-8** | 岗位区域不可键盘访问 | `<g role="button" tabIndex={0} aria-label>` + Enter/Space 触发 |
| **P2-9** | 缺少可重复的视觉/DOM 审计手段 | 新增 `tools/preview/`（vite 预览页 + `audit-dom.mjs` DOM 结构审计脚本，产物已 gitignore） |
| **P2-10** | 新增的真实联动测试会写内存 DB，触发 500ms 防抖持久化；文件结束时定时器仍在途 → 偶发 `Worker exited unexpectedly`（全量套件约 25% 概率 exit≠0，虽 0 failed 但 CI 会红） | 测试文件 `afterAll` 调 `flushDatabase()` 清掉防抖定时器并等落盘链完成；连续 4 次全量复跑均 exit 0 |

---

## 三、验证证据

### 3.1 真实服务联动（不依赖 fake）

```
LO-REAL-1 真实建队 + 加成员 + 建任务 → kick 派活 → 快照出现队长与工作中成员   ✓
LO-REAL-2 任务完成 → 成员释放回 idle（宿主修复回归）                          ✓
LO-REAL-2b 成员名下有多个任务时，完成一个不会误释放                            ✓
LO-REAL-3 真实团队模板（SquadManager）→ 模板角色入馆待命并落在对应岗位         ✓
LO-REAL-4 真实 AgentRegistry / CostTracker 接线（成本进入指标）               ✓
LO-REAL-5 loadDefaultDeps 每个来源都能取到正确形状（无断链）                   ✓
LO-REAL-6 真实 SubagentTask 形状（经 runtime）→ 子智能体角色正确入馆           ✓
LO-REAL-7 团队删除/归档后不再出现在快照（不残留幽灵角色）                       ✓
```

### 3.2 渲染几何（headless Edge 真实渲染 + DOM 审计）

```
actors                    24   （12 角色 × 2 处渲染）
zones                     20   （10 × 2，均为 4 顶点多边形）
actorsInOwnZone        12/12   ← 每个角色都落在自己岗位的等距包围盒内
furniture                 84   （42 件 × 2，8 类家具三面齐全）
gridLines                 88   （44 × 2 = (cols+1)+(rows+1)）
windows / walls       10 / 4
dirty_NaN / undefined  0 / 0
issues                   []
```

### 3.3 回归

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | **184 文件 / 4413 通过 / 15 跳过 / 0 失败** |
| 插件自身测试 | 9 文件 / 100 用例 |
| `npx vite build` | 成功（插件懒加载 chunk） |
| DOM 结构审计 | `tools/preview/audit-dom.mjs` 退出码 0 |

---

## 四、与参考项目的对标结论

| 维度 | ClawLibrary | lobster-pet | 本插件 |
| --- | --- | --- | --- |
| 场景 | Phaser 3 像素美术（webp 房间切片 + 6 层渲染） | 像素办公室（iframe + postMessage） | **SVG 等距矢量**：地板/网格/背墙/窗/10 区域/8 类家具 + DOM 角色层 |
| 角色 | 单只小龙虾（精灵图多状态） | 单只龙虾 | **12 角色同屏**，每个角色确定性生成外观（12×4×5×6×6×4 = 34560 种）+ 11 种工作动画 |
| 岗位 | 12 个资源分区 | 办公室工位 | **10 个职能岗位**，按角色标签关键词自动分配 + 区域内工位槽位 |
| 寻路 | walkGraph + 多边形碰撞 + BFS | 固定工位 | **网格 BFS**（入口到 10 个岗位全部可达，最短步数） |
| 监控 | 房间/资源信息面板 | **卡片网格看板**（StatusCard/TaskGrid/ActivityViz/TokenBar/事件流） | **完整复刻其信息架构**：标题栏 + 9 页签 + KPI 卡 + 健康度环 + 14 天热力图 + 环形图 + 小时柱状图 + 实时事件流；图书馆作为「场景」页签 |
| 皮肤 | 单一深色 | 单一深色 | **四套皮肤自适应**（default 亮/暗、dream、hub），零硬编码色值 |

**差距与取舍**：参考项目用的是像素美术资源（webp 精灵图/房间切片），本插件选择程序化矢量绘制——代价是不如手绘像素图有「质感」，收益是零美术资源依赖、零授权风险、四套皮肤自动适配、且全部几何可被自动化测试验证。角色数量与职能分工则明确超过两个参考项目（它们都只有一只角色）。

---

## 五、已知边界（未修复，非缺陷）

| 项 | 说明 |
| --- | --- |
| 缓存命中 token | 适配层保留 `tokensCached` 字段，宿主 CostTracker 聚合口径暂未提供该值，面板显示「—」而非编造 0 |
| 等待授权态 | 只能从工具名（`ask_user_question` / `exit_plan_mode`）推断，未接入待决权限队列 |
| 历史回放 | 只有最近 120 个采样点的内存时间序列，未接 EventLog 做时间轴回放 |
| 单层地图 | 10 个岗位的单层平面，未做多层/分馆 |
