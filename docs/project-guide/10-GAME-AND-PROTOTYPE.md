# 10 · 内置大富翁与 Godot 重制实验

> 基线：2026-10-26 ｜ 1.16.330
> 本文把三条容易混淆的线分开：**内置 Phaser 插件**（已跟踪、属于产品）、**Godot 2.5D 重制原型**（未跟踪、实验）、**美术/研究资产**（未跟踪、多为游戏线产物）。
> 如果你只维护 Codem 主产品，可以只看 §1 与 §6；不要因为 `docs/` 里几百张棋盘图就以为主产品是游戏。

---

## 1. 三条线的边界

| 线 | 位置 | 是否跟踪 | 是否属于 Codem 产品 | 状态 |
|---|---|---|---|---|
| 内置大富翁（Phaser） | `src/plugins/monopoly-game/` | ✅ 跟踪 | ✅ 是（前端插件） | 已交付（v1.6.2，Phase 1–10）；**刻意无入口** |
| Godot 2.5D 重制 | `prototype/wealth-island-2.5d/`、`wealth-island-ground/`、`shenman/`、`shenman2d/` | ❌ 未跟踪 | ❌ 否（独立实验） | 可玩 v3 + v4 预览；未接主应用 |
| 美术/研究资产 | `art/`、`docs/ref-analysis/`、`docs/*.png` | ❌ 未跟踪 | ❌ 否 | 研究/美术中间产物；含 309 MB docs |

> `src-tauri`/`src` 的产品代码**不依赖** `prototype/` 或 `art/`；删掉它们不会影响 Codem 构建（但会丢实验）。

---

## 2. 内置大富翁插件（Phaser）

### 2.1 结构

```text
src/plugins/monopoly-game/
├─ index.ts                 导出 GameView/GameEngine/各系统/类型
├─ types.ts                 236 行：MapNode/LandTile/Facility/PlayerState/Card/Tool/Stock/Character/GameConfig/HUDState
├─ engine/                  14 个系统（约 15 万行中的核心）
│  ├─ GameEngine.ts         57 KB / 1552 行：回合流程、状态机、事件
│  ├─ AIPlayer.ts           16 KB：AI 买地/升级/决策
│  ├─ AuctionSystem.ts      拍卖
│  ├─ BankruptcySystem.ts   破产
│  ├─ CardSystem.ts         卡牌
│  ├─ Dice.ts               骰子
│  ├─ FacilitySystem.ts     设施（医院/监狱/银行/商店/公园/魔法屋/旅馆/加油站/新闻/命运/拍卖行/机场）
│  ├─ FortuneSystem.ts      命运/新闻
│  ├─ Player.ts             玩家状态
│  ├─ Property.ts           地产/过路费
│  ├─ SaveLoadSystem.ts     localStorage 3 槽位存档
│  ├─ ShopSystem.ts         商店
│  ├─ StockSystem.ts        股票
│  └─ ToolSystem.ts         道具
├─ scenes/                  Phaser 场景
│  ├─ BoardScene.ts         55 KB：棋盘渲染/移动/交互
│  ├─ BootScene.ts          启动/资源
│  └─ UIScene.ts            HUD
├─ components/              14 个 React 面板
│  ├─ GameView.tsx          游戏主视图
│  ├─ CharacterSelect.tsx   角色选择
│  ├─ ActionBar / PlayerCards / GameLog / AssetsPanel
│  ├─ CardPanel / ToolPanel / ShopPanel / AuctionPanel / BankPanel
│  ├─ SaveLoadPanel / HelpPanel / CharacterAvatar
├─ data/                    cards.json / tools.json / characters.json / game-config.json
├─ maps/                    5 张地图：ancient / city / island / space / taiwan
├─ styles/game.css
└─ assets/                  139 PNG + 9 OGG（精灵/音效）
```

### 2.2 玩法

- 4 人局（1 人类 + 3 AI）；初始资金/天数/胜利条件可配（`game-config.json`：10000/15000/20000/30000；15/30/50/100 天；2/3/5/10 倍）。
- 回合：掷骰 → 移动 → 落点事件（买地/升级/付过路费/设施/卡牌/命运/商店/拍卖/股票/银行）→ 结束回合 → AI 行动。
- 地产：等级 0–5、连锁店、临时状态（封印/涨价）、过期日期。
- 设施：银行、医院、监狱、商店、公园、魔法屋、旅馆、加油站、新闻、命运、拍卖行、机场。
- 卡牌/道具/商店/拍卖/股票/破产。
- 存档：`monopoly_save_<slot>`，最多 3 槽，localStorage，版本 1.0.0。
- 地图：5 张 JSON（古代/城市/岛屿/太空/台湾）。

### 2.3 入口与当前状态

- 代码在 `src/plugins/monopoly-game`，由前端插件/懒加载分支挂载；**当前刻意无用户入口**（判据 `GAME-4` 钉住）。
- 底部面板的 `game` 成员在 `bottom-tab-entries.ts` 里明确“刻意无入口”；顶部页签栏也已移除。
- **不要“贴心地”补入口**，除非用户明确要求。历史决定：游戏是彩蛋/试验，不占主产品导航。
- 若要在开发环境看：可临时通过插件/懒加载分支或 Storybook 式挂载；不要改产品入口。

### 2.4 已知问题

- 游戏代码体量大（194 文件 / 846 KB），与主产品共享构建但很少维护；
- 存档只在 localStorage，不进 SQLite/JSONL；
- 地图/角色/数值平衡没有自动化判据（除 `monopoly-start-chain.test.ts`、`ui-game-switch.test.ts`）；
- 美术资产 139 PNG 增加安装包体积。

---

## 3. Godot 2.5D 重制（未跟踪实验）

### 3.1 定位

对标 `rich4-renew-app` 的 4 人经典大富翁规则，做 **2.5D 手绘棋盘质感**。Godot 4.7.2 / Web GL Compatibility / 1280×720。**不是 Codem 的一部分**，也不接主应用。

### 3.2 目录

```text
prototype/wealth-island-2.5d/
├─ scenes/
│  ├─ Board.tscn            主场景（可玩 v3）
│  ├─ BoardV4Preview.tscn   v4 预览（不覆盖 v3）
│  └─ Main.tscn             纯视觉 A/B
├─ scripts/
│  ├─ board.gd              44 KB：棋盘/规则/美术装配
│  ├─ board_v4_preview.gd   12 KB：v4 预览（斜投影/买/升/过路费/截图）
│  ├─ main.gd               视觉 A/B
│  ├─ rule_oracle.gd        T1–T15 GDScript oracle
│  ├─ v4_rules.gd           v4 买/升/同街/大地块/保险
│  ├─ v4_rules_test.gd      真实 v4 数据回归
│  ├─ v4_stocks.gd          12 股票/持股/董事长/企业费/分红/保险
│  └─ v4_stocks_test.gd     V4 STOCKS PASS
├─ assets/                  地面/建筑/树/码头/设施/角色/道具
├─ project.godot
└─ README.md
```

另有 `prototype/wealth-island-ground/`（地表实验）、`prototype/shenman/`、`prototype/shenman2d/`（角色/2D 实验）。

### 3.3 v4 数据（`art/wealth-island/rebuild/`）

| 项 | 值 |
|---|---:|
| 世界 | 2304 × 2304 |
| 节点 | 305 |
| 普通地 | 72（48×48 逻辑 / 44 可见） |
| 街道组 | 24（每街 3 块） |
| 大型地 | 8（96×96） |
| 企业 | 6（96×96） |
| 景观 | 26 |
| 股票 | 12 |

校验输出：`lands 72 streets 24 fac 8 comp 6 nodes 305 / errors 0`。

**冻结常量**：`CELL 32`、`LOT 48/44`、`LOT_PITCH 48`、`BIG 96/92`、`ROAD 44`、`BUILDING_SCALE 1.0`、`FRAME (8 - facing - rot) & 7`、`ANCHOR manifest/frame anchor_x/anchor_y`（逐帧，禁止 alpha bbox）。

**规则（冻结）**：

```text
streetToll = PI × Σ(同 owner / 同 name / 非连锁) tolls[level]
chainToll  = PI × 2000 × 连锁块数
买地 = (price + level × per_level) × PI
加盖 = per_level × PI
大地买/建 = price × PI
大地升 = fees[0] × PI
大地费 = fees[level] × PI × (天数 | 倍数)
股票：12 支、每股 10000；市场用存款、认购用现金；股价不乘 PI；15 日 fundMonth 分红
保险：days × 2000 × PI，从第一家 category4 企业出
```

### 3.4 视觉/投影

- 斜投影：`S=1.2175`、`K=√0.5`、`θ=-22.5°`；地面走仿射，建筑直立贴在 `project(x,y)`；支持 8 视角（`θ=-22.5+45×rot`）；
- 建筑 16 方向（22.5°）、树/码头 8 方向；5 级住宅/商店 + 独立旅馆 + 特殊建筑（度假村/剧院/灯塔）；
- 角色 Q 版沈曼：正/侧/背 3 张 + 镜像（不是真正 8 方向）；
- 地面 2304，Blender + 程序化草簇/石/花；海岸/水道/码头仍在迭代。

### 3.5 运行 / 验收命令

```powershell
cd C:\tools\godot
.\Godot_v4.7.2-stable_win64_console.exe --path C:\mimo-gui\prototype\wealth-island-2.5d --rendering-driver opengl3
# 街道镜头
.\Godot_v4.7.2-stable_win64_console.exe --path C:\mimo-gui\prototype\wealth-island-2.5d --rendering-driver opengl3 -- --street
# v4 预览
.\Godot_v4.7.2-stable_win64_console.exe --path C:\mimo-gui\prototype\wealth-island-2.5d --rendering-driver opengl3 -- --full
```

无头回归：

```text
--test-buy   → V4_BUY id=2 owner=1 level=1 money=12000->10600
--test-turn  → V4_TURN node=195->8 money=12000
--test-toll  → V4_TOLL id=8 street=中央大街 amount=2200 money=12000->9800
```

### 3.6 当前状态（v4）

**已做**

- v4 数据原型：72 地 / 24 街 / 8 大地 / 6 企业 / 26 景观 / 305 节点；
- v4 地表骨架：不规则海岸 + 沙滩/浅水/深海、5×5 直街（44px 金边）、顶部 T 口、左侧外环死路、2 个水池/运河、底部 3 个离岛；
- `BoardV4Preview.tscn`：72 地 + 24 街 + 8 大地 + 6 企业 + 26 景观进入 Godot；48/96 建筑按等级缩放；斜投影；HUD；左键选地/B 买/U 升级；
- v4 规则/股票/保险 oracle 与回归；
- 8 视角旋转、16 方向建筑、树/码头 8 帧、海面背景兜底、部分街道细节。

**未做 / 已知差距**

- 海岸/水道/码头/地形贴图未最终化；
- 48/96 建筑 sprite 未按 manifest/逐帧 anchor 重标定（当前是 alpha bbox 过渡）；
- 未接进 Godot 主场景（v3 仍是主场景）；
- 规则内核/UI/股市/保险未接主流程；
- 真实 v4 24 街组价格梯度未定；
- 角色侧/背与正面不完全一致；
- 地面仍以程序化为主，离手绘密度有差距；
- 视觉 A/B 仍明显弱于对标项目。

> 结论：**v4 是数据/视觉原型，不是可交付游戏**。不要把 `docs/board-v4-full.png` 当成“已完成”。

---

## 4. 美术/研究资产（未跟踪）

| 位置 | 内容 | 说明 |
|---|---|---|
| `art/wealth-island/` | 1727 文件：地面/建筑/树/码头/道具/角色/切图脚本 | 大量中间产物；`rebuild/` 是 v4 数据与生成脚本 |
| `docs/ref-analysis/` | 原版地图 0–107 的逆向研究（Markdown 数万字 + 截图 + CSV） | 含 `.tmp-*.py` 临时脚本；不要当产品文档 |
| `docs/*.png` | 棋盘/建筑/角色/美术 A/B 截图（数百张，单张可达 12 MB） | 体积大；多数是实验记录 |
| `.rich4-renew-ref/` | rich4-renew-app 研究克隆（GPL-3.0） | 已加入 `.gitignore`，**永不入库/不随产品分发** |

**边界**：

- 这些内容不是 Codem 产品的一部分；
- 不要 `git add -A`；不要把它们打进安装包；
- 若要把 Godot 原型转正，先决定：放独立仓库、放 `prototype/` 跟踪、还是继续本地实验；
- 引用第三方素材/规则时保留 `THIRD_PARTY_NOTICES.md` 与许可说明。

---

## 5. 相关文档（游戏线）

| 文档 | 内容 | 状态 |
|---|---|---|
| `docs/BOARD-GAMEPLAY.md` | 财富岛 v5 玩法/节点/地块/建筑/8 视角/岔路/AB | 当前较新（2026-10-25） |
| `docs/REBUILD-SPEC.md` | v4 重构规格/数据模型/规则/验收 T1–T15 | 当前（2026-10-26） |
| `docs/ART-DIRECTION.md` | 逐轮美术目标/尝试/指标/失败记录 | 当前 |
| `docs/ART-DELIVERY.md` | 验收矩阵/证据/已知差距 | 当前 |
| `docs/MONOPOLY-ART-BIBLE.md` / `MONOPOLY-ART-TARGET.md` | 美术圣经/目标 | 历史/参考 |
| `docs/MONOPOLY-GODOT-PLAN.md` / `MONOPOLY-REBUILD-PLAN.md` | 计划稿 | **缺历史横幅，导致 `docs-current-gap-list` 失败** |
| `docs/MONOPOLY-2.5D-DEMO.md` / `SCALE-COMPARISON.md` / `GROUND-STYLE-PIPELINE.md` | 2.5D/比例/地表管线 | 实验记录 |
| `prototype/wealth-island-2.5d/README.md` | 运行/操作/美术管线/验收/目录 | 当前 |
| `docs/ref-analysis/` | 原版地图/经济/股票/企业研究 | 未跟踪研究 |

---

## 6. 如果要继续这条线

### 6.1 先做决定

1. **它是产品还是实验？** 当前是实验；不要默认接主应用。
2. **放哪个仓库？** 继续在 `C:\mimo-gui\prototype`（未跟踪）会一直有“干净 clone 不可复现”的问题。
3. **v3 还是 v4？** v4 是预览；v3 是当前可玩。不要直接覆盖 v3。
4. **美术预算？** 16 方向建筑 + 8 方向树/码头 + 角色 8 方向是真成本；当前角色只有 3 张 + 镜像。

### 6.2 技术顺序（建议）

1. 先把 v4 数据/规则 oracle 跑通（T1–T15；`v4_rules_test.gd`、`v4_stocks_test.gd`）；
2. 再做 48/96 建筑 sprite + 逐帧 anchor（替换 alpha bbox 过渡）；
3. 再做海岸/水道/码头/地形；
4. 最后接 Godot 主场景/UI/规则；
5. 每一步保留截图 + A/B + 回归输出；不要用“看起来更好”代替证据。

### 6.3 不要做

- 不要把 `prototype/`、`art/`、`docs/ref-analysis/` 提交进主仓库（除非用户拍板）；
- 不要把 Godot 原型接进 Tauri 安装包（体积/许可/构建复杂度）；
- 不要为了游戏线改主产品的入口/底部页签（`GAME-4` 钉住“刻意无入口”）；
- 不要用游戏线的 BOM 文件/计划稿去证明主产品质量。

---

## 7. 当前游戏线对主产品的影响

| 影响 | 说明 |
|---|---|
| 测试失败 1 | 18 个未跟踪游戏文档带 BOM ⇒ `no-bom.test.ts` 红 |
| 测试失败 2 | 两份 `MONOPOLY-*-PLAN.md` 缺历史横幅 ⇒ `docs-current-gap-list.test.ts` 红 |
| 仓库体积 | `docs/` 309 MB、`art/` 1727 文件、`prototype/` 2330 文件；git 不跟踪，但本地占空间 |
| 构建 | 不进入 `dist`/安装包（`src/plugins/monopoly-game` 除外，它是产品插件） |
| 文档 | 大量 `docs/*.png` 与 `MONOPOLY-*`/`ART-*` 稿混在数百份 md 中，容易误导新会话 |

> 处理建议：把游戏线文档移到 `docs/game/`（或独立仓库），给 `MONOPOLY-*-PLAN.md` 加历史横幅，给 18 个 BOM 文件去 BOM；这样主产品测试可以全绿，且不丢实验。
