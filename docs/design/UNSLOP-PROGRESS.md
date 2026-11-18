# Unslop 进度与批次账本

> 执行契约：[UNSLOP-IMPLEMENTATION-PLAN.md](UNSLOP-IMPLEMENTATION-PLAN.md) · [DESIGN-DIRECTION.md](DESIGN-DIRECTION.md)
> 方向稿：[unslop-codem-v1.html](unslop-codem-v1.html)
> 本文件是**唯一**的批次状态账本：每批结束时更新「状态 / 证据 / 已知差异 / 门禁读数」。
> 建立时间：2026-11-18 ｜ 基线提交 `8ce08b43`（v1.18.14）｜ 工作分支 `design/unslop-v2`

---

## 0. 批次总表

| 批次 | 内容 | 状态 | 全量门禁 |
|---|---|---|---|
| 0 | 基线与护栏（token 层 + 选择器作用域闸 + 文案/emoji 棘轮 + 基线截图） | **✅ 2026-11-18 完成** | 否（目标测试） |
| 1A | `App.tsx` 三份主区抽成 `WorkspaceFrame`（纯结构） | 进行中 | **是** |
| 1B | 壳层 + 聊天视觉 | 待执行 | **是** |
| 2 | 任务 / 团队 / 记忆 | 待执行 | 目标测试 |
| 3 | 设置 + 引导 + 错误恢复 | 待执行 | **是** |
| 4 | 知识 / 文档 / 媒体 / 目标 | 待执行 | 目标测试 |
| 5A | 文件 / Git / 终端 / MCP / 技能 / 市场 | 待执行 | 目标测试 |
| 5B | 插件 UI（library-ops；monopoly 除外） | 待执行 | **是** |
| 6A | 三套皮肤迁移（default / hub / dream） | 待执行 | **是** |
| 6B | 手机端完整迁移（packages/ui + android-shell） | 待执行 | **是** |
| 6C | 共享 UI / 宿主 / 集成 | 待执行 | 目标测试 |
| 7 | 清理与发布 | 待执行 | **是** |

---

## 1. 本仓实测口径（2026-11-18，`8ce08b43`）

计划书里的数字与本次实测有出入的地方，以本表为准（后续每批只更新变化项）：

| 项 | 实测 | 计划书 |
|---|---|---|
| `src/components` 下 `.tsx` | **201** | 201 |
| `*Panel.tsx` | **25** | 25 |
| `*Dialog.tsx` | **10** | 12 |
| CSS 文件（`src` + `packages/ui`） | **11**（`styles.css` 717,308 B） | 10 |
| `style={{` 内联样式 | **1,388** | ~1222 |
| `data-testid=` | **182** | — |
| `packages/ui/src` 文件 | **34**（`ui.css` 59,171 B） | 34 |
| `library-ops` tsx/css | **21** | 20 tsx + 69 KB CSS |

CSS 内既有漂移（本次实测，用于逐批对账「只降不升」）：

| 指标 | `styles.css` | `codem-ui.css` | `skin-hub.css` | `skin-dream.css` | 其它 |
|---|---:|---:|---:|---:|---|
| `#7c6cf0` | 42 | 5 | 0 | 0 | `packages/ui/src/ui.css` 1 |
| 其它紫色族（`#8b5cf6/#a78bfa/#6555e0/#5b46cf/#5a4bd1`） | 10 | 2 | 1 | 0 | — |
| `radial-gradient` | 10 | 3 | 2 | 2 | `notebook-workspace` 1、library-ops 1 |
| `linear-gradient` | 13 | 3 | 0 | 1 | `notebook-workspace` 2、`ui.css` 2 |
| `--shadow-glow` | 8 | 0 | 2 | 0 | — |
| `text-transform: uppercase` | 25 | 1 | 0 | 0 | `notebook-workspace` 7 |
| `var(--radius-full)` | 44 | 9 | 0 | 0 | `notebook-workspace` 6、`ui.css` 6 |
| `backdrop-filter` | 42 | 28 | 0 | 43 | library-ops 4 |
| `AlimamaFangYuanTi` | 4 | — | — | — | `main.tsx` / 设置字体项 |

文案/emoji（**剥掉注释后**统计，语料 = `src/components` + `src/App.tsx` + `packages/ui/src`，排除 `*.test.*`）：

| 项 | 值 |
|---|---|
| 含 emoji 的文件 | **55** |
| 含 emoji 的行 | **280** |
| 最多的文件 | `SettingsPanel.tsx` 41、`App.tsx` 23、`GitInfoPanel.tsx` 17、`ppt/EditorToolbar.tsx` 17、`ppt/PPTEditor.tsx` 14 |

---

## 2. Batch 0 · 执行结果（2026-11-18 完成）

### 2.0 实际落地

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/core/theme/unslop-tokens.css` | 新增 | v2 调色板唯一真相源（暗/亮两档）+ 桥接层；原始色值只在这里出现 |
| `src/styles/unslop-v2.css` | 新增 | 覆盖层；每条选择器带 `[data-ui="v2"]`；当前只含 `::selection` / `::placeholder` 两条 |
| `src/core/theme/ui-layer.ts` | 新增 | `data-ui` 档位：`?ui=v2`（不落盘）> `localStorage` > 默认 v1（**移除**属性） |
| `src/test/ui-layer.test.ts` | 新增 | 8 例：开关语义 + 作用域闸 + 覆盖层无颜色字面量 |
| `src/test/ui-token-canonical.test.ts` | 新增 | 12 例：CSS↔`tokens.json` 逐值一致 + 两档令牌集合相同 + 无几何令牌 + 对比度实算 |
| `src/test/ui-no-emoji.test.ts` | 新增 | 4 例：emoji 行/文件/逐文件棘轮 |
| `src/test/ui-copy-guard.test.ts` | 新增 | 3 例：禁用词/greeting/感叹号/raw Markdown 棘轮 |
| `src/test/helpers/ui-text-scan.ts` | 新增 | 用 TypeScript AST 取「JSX 文本 + 字符串/模板字面量」，注释天然不参与 |
| `tools/ui-audit/copy-guard-baseline.json` | 新增 | 两条棘轮的基线（emoji 274 行 / 55 文件；banned 12 / greeting 1 / 感叹号 11 / raw MD 52） |
| `docs/design/tokens.json` | 新增 | 机读真相源 + 校准记录（与 CSS 逐值一致） |
| `src/main.tsx` | **3 行** | 两个 CSS import + `applyUiLayer()`（在 render 之前） |
| `docs/design/audit/batch-0/*` | 更新 | 采集协议改为「reload + 冻结 + 移焦 + 隐藏光标」 |

**未落地（按门禁事实后移，理由见 §2.1）**：`components/ui` 基础件骨架、字体/几何令牌。

### 2.0b 判据与变异自证（四条都验证过"改坏会红"）

| 判据 | 变异 | 结果 |
|---|---|---|
| 作用域闸 | 往 `unslop-v2.css` 加 `.message-bubble { color: red }` | 🔴 `offenders: [".message-bubble"]`；还原后 🟢 8/8 |
| CSS↔JSON 逐值 | 把 `--ui-accent: #c6a15b` 改成 `#c6a15c` | 🔴 漂移比对报出 accent；还原后 🟢 |
| emoji 棘轮 | 往 `ChatPanel.tsx` 加 `<span>🚀</span>` | 🔴 行数/文件数/逐文件三条全红；还原后 🟢 |
| 文案棘轮 | 同一处加「一键完成」 | 🔴 `banned 12 → 13` 并打印 file:line；还原后 🟢 |

### 2.0c 视觉验收（同机、同数据、同协议）

| 检查 | 结果 |
|---|---|
| 关闭档位 vs 已提交基线 | **0 像素差异**（哈希相同） |
| 引入两个样式表但**不开启** vs 未引入 | 43 px 变化、单通道最大 **1/255**（LCD 次像素抗锯齿的捕获路径差异，非视觉变化；容差 ≤200 px 且 ≤4/255） |
| 开启 v2 后的布局指纹 | 元素数 **2021 = 2021**，每元素 `box` 与 9 项布局属性**全部相同**，0 处差异 |
| 皮肤令牌解析（`data-skin=hub/dream` + v2） | `--accent` 都是 `#c6a15b`、`--bg-primary` 都是 `#0e1012` → v2 压过 hub 的橙色与 dream 的粉色 |
| 截图 | `03-on-dark` / `04-on-light`（见 `.preview-shot/unslop/batch0/`） |

### 2.0d 门禁读数（Batch 0 结束时）

`tsc` 0；四个新判据 27 例全绿；`scan-ui` error 0 / warn 0；`style-literals` 11 族不涨；
`color-roles` 51 对 + 未解析 48/49；`token-hygiene` 0；`motion` 0 裸曲线；`doc-tokens` 通过；
`knip` 棘轮无增长（exports 46/46）；`reachability` 通过；`vite build` 通过。

### 2.0e 过程中发现并修掉的两个坑（都会让"像素验收"假红）

1. **聊天输入区会自动聚焦 ⇒ 文本光标闪烁不是 CSS 动画**，`animation:none` 停不住它。
   同一页面 3 次重载得到 3 个不同哈希。修法：采集前 `document.activeElement.blur()` + `caret-color: transparent`。
2. **CDP 截图会在"合成面/主帧"两条路径间交替**，Windows 的 LCD 次像素抗锯齿只在其一生效：
   同一视图连续两张差 **43 px、每通道 1/255**（标题行次像素）。修法：像素比对带容差
   （≤200 px 且 ≤4/255），并**以布局指纹为主判据**。

---

## 2A. Batch 0 · 原始计划（留档，含与执行的差异）

目标：**不动视觉**，只建立「可回滚、可对比、可判红」的底座。默认关闭时逐像素不变。

### 2.1 决策与偏差（先说清，避免后面返工）

计划的原文写「`src/components/ui/` 新增基础件骨架」。**本次不这样做**，理由是三条既有门禁会当场判红：

1. `tools/audit/knip-gate.mjs`：新增**未被消费的导出**会增加 `exports` 棘轮计数 → 红；
2. `scan-ui` 的 `css-class-unused`（warn，`warnCount` 同样只降不升）：定义了但没人用的类 → 黄；
3. `scan-ui` 的 `css-var-unused`（warn）：定义了但没人 `var()` 的令牌 → 黄。

所以 Batch 0 只交付**被消费的**东西：token 层（自身即消费方，映射到既有语义令牌）、选择器作用域闸、文案/emoji 棘轮、基线证据。基础件（Button/Input/Dialog…）随 **Batch 1B 与第一个真实调用点同时落地** —— 这也是计划 §5.3 的原话（「Batch 0 不假设已有基础件可用」）。

另外两条执行口径：

- **默认档位**：本仓 `DEFAULT_THEME = "light"`（`src/core/theme/theme-default.ts`），与方向稿「深色默认」不同。Batch 0/1A **不碰**默认档位；v2 的深/浅两档都在同一批验收。是否把产品默认改成 `dark` 属产品行为变更，需要单独立项，不阻塞前两批。
- **`--ui-*` 色值放在 `src/core/theme/`**：`scan-ui` 的 `color-hardcoded-css` 是 **error** 级，而令牌定义源必须写原始色值。本仓已有的同类豁免就是「令牌定义源」（`^src/core/theme/`、`src/styles/skin-*.css`）。把 v2 调色板放进 `src/core/theme/unslop-tokens.css` **复用既有豁免，不新增任何 allowlist 条目**；覆盖层 `src/styles/unslop-v2.css` 只写 `var()`，因此不享受豁免，任何硬编码都会真红。

### 2.2 新增文件（6 个）

| 文件 | 内容 | 为什么必须存在 |
|---|---|---|
| `src/core/theme/unslop-tokens.css` | v2 调色板唯一真相源：深色 `:root[data-ui="v2"]` / 亮色 `:root[data-ui="v2"][data-theme="light"]`，定义 `--ui-*` 并把它们**映射**到既有语义令牌（`--bg-primary` / `--accent` / `--border-primary` / `--text-primary` / `--font-ui` …） | ① 色值只能有一个真相源；② 映射即消费，保证 `--ui-*` 零死令牌；③ 不写进 `styles.css`（717 KB，回滚代价大） |
| `src/styles/unslop-v2.css` | 覆盖层骨架：目前只含 `[data-ui="v2"]` 作用域说明 + 后续批次挂载点（**无任何组件规则**） | 后续每批只往这里加，不散落 |
| `src/core/theme/ui-layer.ts` | 读取并应用 `data-ui` 档位：`localStorage["codem-ui-layer"]` → 生效；`?ui=v2` 只作 QA 覆盖（不写回） | 没有开关就没法「默认不变 + 验收时打开」 |
| `src/test/ui-layer.test.ts` | 单测：默认不设属性；`?ui=v2` 生效且不落盘；`localStorage=v2` 生效；`v1` 移除属性 | 证明「关闭 = 完全无副作用」 |
| `src/test/ui-token-canonical.test.ts` | 断言 `unslop-tokens.css` 的每个 `--ui-*` 与 `docs/design/tokens.json` **逐值一致**；深/亮两档都覆盖；正文对比度 ≥ 4.5:1、accent 面积规则靠后续批次 | 让 `tokens.json` 从第一天起就是**载荷**，而不是又一份会腐化的文档；6B 的手机 parity 直接复用 |
| `src/test/ui-copy-guard.test.ts` | ① 剥注释后统计禁用词/口语/greeting/感叹号，**棘轮**（只降不升）；② 渲染字符串里出现 `**` 的条数棘轮 | 文案清理是三批的慢变量，必须有棘轮，否则永远"下一批再说" |
| `src/test/ui-no-emoji.test.ts` | 剥注释后统计 emoji 的**文件数/行数**棘轮；排除 `src/plugins/monopoly-game/**`（游戏美术，约定不做）与 `*.test.*`；其余全部计入（`icon-map.ts` 的工具 emoji 属真 chrome，留给 5A 清，棘轮先记账，不做文件白名单） | 280 行 emoji 不可能一批清完；棘轮是唯一能证明"只降"的机制 |
| `docs/design/tokens.json` | 与 `unslop-tokens.css` 同值的机读真相源（深/亮两档） | 6B「桌面与手机 token 同源」的前置；Batch 0 就建，避免后面两套色值 |
| `docs/design/audit/batch-0/` | `capture.json`（6 张截图的视口/状态/sha256）+ `layout-fingerprint.json`（元素数 + 指纹哈希）+ `README.md`（复现命令、红≠失败的口径） | 基线证据要能被下一批复跑 |

### 2.3 修改文件（3 个，都是 1–3 行）

| 文件 | diff | 风险 |
|---|---|---|
| `src/main.tsx` | `+ import "./core/theme/unslop-tokens.css";`（在 `styles.css` 之后、皮肤之前）、`+ import "./styles/unslop-v2.css";`（在最后）、bootstrap 里 `+ applyUiLayer();`（与 `applyAppearanceAttributes()` 并列，首帧前） | 极低：默认档下两文件无命中规则；`applyUiLayer()` 在不开启时**不写** `data-ui` |
| `package.json` | 无新增依赖（lucide-react / Radix 已在） | — |
| `docs/design/DESIGN-DIRECTION.md` | 补「默认档位以 `theme-default.ts` 为准」一句口径说明 | 文档 |

### 2.4 关键设计：作用域闸（Batch 0 最重要的一条判据）

Batch 0 把「v2 只改 token、不改布局」变成**结构不可违反**，而不是靠人盯着截图：

```
ui-layer.test.ts 断言：
  unslop-v2.css 里每一条选择器都必须以 [data-ui="v2"] 开头
  （`:root[data-ui="v2"]`、`[data-ui="v2"] .x` 均满足；`@media` 内的规则同样受检）
```

推论：只要这条绿，`data-ui` 未开启时**不可能**有样式生效 → 「关闭时逐像素一致」是**构造保证**，截图只是旁证。

**中间态说明（不是 bug）**：Batch 0 的 v2 token 对三套皮肤同时生效（这是 DESIGN-DIRECTION 的目标态：
三套共用琥珀 + 中性表面）。因此打开 v2 后，hub 仍是旧布局 + 橙色光斑、dream 仍是旧粉色派生 ——
这些由 **6A** 清掉，Batch 0/1A 不动它们。`--ui-*` 的取值优先级：`:root[data-ui="v2"]`（0,2,0）
高于 `[data-theme="dark"]` / `[data-skin="hub"]`（0,1,0），所以不需要 `!important`。

### 2.5 验收（Batch 0 完成时必须全部给读数）

```powershell
npx tsc --noEmit
npx vitest run src/test/ui-layer.test.ts src/test/ui-token-canonical.test.ts `
  src/test/ui-copy-guard.test.ts src/test/ui-no-emoji.test.ts
node tools/ui-audit/scan-ui.mjs            # error 0 / warn 0 必须不变
npm run audit:style-literals               # 11 族不涨
npm run audit:color-roles                  # 51 对 + 未解析 48（预算 49）
npm run audit:token-hygiene
npm run audit:motion
npm run audit:doc-tokens
node tools/audit/knip-gate.mjs             # exports 棘轮不涨
node tools/audit/reachability-scan.mjs --check
```

视觉证据（同一台机、同一数据状态、同一采集协议）：

1. **主判据 = 布局指纹**：打开 / 关闭 v2 时 `layout-fingerprint` 的元素数、每元素 `box`、9 项布局计算属性**完全一致**
   （只有颜色/字体 token 允许变）；
2. **旁证 = 截图哈希**：关闭（默认）时 6 张与 `docs/design/audit/batch-0/capture.json` 一致；
   其中 `02-tasks-dark` 渲染实时值，允许 ≤1 字节差（实测）；
3. 三套皮肤（default / hub / dream）各一张 chat 截图，证明 v2 token 在 `[data-skin]` 下同样生效。

采集协议（脚本内置）：`Page.reload` → 等 `.app` 就绪 → `Emulation 1440×900@dsf1` →
注入 `animation:none;transition:none` → 采集 → 还原（移除冻结、清视口、关浮层）。不 reload 直接拍会让
焦点/滚动/动画相位进入像素，哈希不可复现（实测差 1–29 字节）。

---

## 3. 基线截图（Batch 0 · before）

采集条件：装机版 1.18.14（UI 与 `8ce08b43` 一致），CDP 视口 `Emulation 1440×900 @dsf1`（布局宽度 1575 CSS px，见 `capture.json`），深色默认 + 临时切亮色，数据为真实本地库。

| # | 文件 | 内容 | 观察到的问题（对应批次） |
|---|---|---|---|
| 01 | `01-chat-dark.png` | 对话主界面 | 紫色 accent 溢出（用户气泡/会话选中/发送键）、`任务完成` 胶囊、圆形头像块（1B） |
| 02 | `02-tasks-dark.png` | 任务中心 | 等宽统计卡 + 胶囊 tab（2） |
| 03 | `03-memory-dark.png` | 记忆面板 | 七连数字墙、`**对话级默认直接生效**` **raw Markdown**（2） |
| 04 | `04-settings-dark.png` | 设置 · 通用 | `叫我什么/我是什么` + 「数字精灵/赛博管家/电子幽灵」人设 + 12 个 emoji 身份选择器 + 紫色 segmented（3） |
| 05 | `05-chat-light.png` | 对话 · 亮色 | 亮色下同一套紫色与胶囊（1B） |
| 06 | `06-search-modal-dark.png` | 搜索/命令面板（模态） | 浮层为自定义壳、无统一 token（1B） |

原始 PNG 在 `.preview-shot/unslop/baseline/`（**不进 git**：截图含本机会话标题与项目路径，写进历史不可逆）。
仓库里只提交可复算的指纹与复现命令，见 `docs/design/audit/batch-0/`。

**复现命令**（窗口状态会自动还原，只读不写设置）：

```powershell
# 应用需带 CDP 启动：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
node .preview-shot/_unslop-baseline.mjs          # 6 张截图 + capture.json
node .preview-shot/_unslop-snapshot.mjs out.json # 布局指纹（元素数 + 矩形）
```

---

## 4. Batch 1A 的前置事实（已实测，用于排期）

`App.tsx` 里三份主区：`skin==="hub"` 5634–5765、`"dream"` 5766–5888、默认 5889–6033。

| 块 | 行数 | 三份差异 |
|---|---|---|
| 主列（compaction 横幅 → notebook 横幅 → ChatPanel → 终端抽屉 → 四个可选页签 → 游戏） | hub 81 / dream 81 / default 90（**去掉换行差异后逐 token 相同**） | 只有 notebook 横幅的 JSX 换行不同，DOM 等价 |
| `Sidebar` 入参 | 20 行 × 2（dream/default **完全相同**） | hub 多一层 `sidebar={…}` 包裹 + `sidebarOpen ? … : null` |
| `RightSidebar` 入参 | 15 行 × 2（dream/default **完全相同**） | hub 的右栏由 `HubLayout` 内部渲染，**少传 `sessionId` / `workspace` / `agents`** —— 这是计划书说的"三份漂移"的第一处实证 |

Batch 1A 的路线（纯结构，不改事件）：

1. 新 `src/components/workspace/WorkspaceFrame.tsx`：`WorkspaceMainColumn`（81 行 ×3 → 1）+ `WorkspaceFrame`（`variant` 选择 Hub/Dream/裸 fragment，DOM 结构保持）；
2. `sidebarNode` / `rightRailNode` 提到 `return` 之前各算一次；
3. `HubLayout` 新增可选 `rightRail?: ReactNode`（传入即替换内部 `RightSidebar`），消掉上面第三行的漂移；
4. 判据：`src/test/workspace-frame.test.ts`（渲染三档，断言 `data-testid`/`role`/按钮集合等价）+ 三档截图 + 布局指纹逐元素相同。

---

## 5. 已知差异与不做

- `monopoly-game` 不在范围（保留自身视觉），`shell-ops` 无 UI。
- 用户内容/模型输出/PPT 主题/代码高亮的 emoji 与配色**不清**。
- `.preview-shot/` 已被 `.gitignore` 忽略（含全部截图与探针脚本），干净 clone 无法复跑像素比对 —— 因此每批的**结论**要落到本文件与 `docs/design/audit/<batch>/` 的指纹里。
- 手机真机不可用时只能标 `blocked`；模拟器结果不得写成真机。
