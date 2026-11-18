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
| 1A | `App.tsx` 三份主区抽成 `WorkspaceFrame`（纯结构） | **✅ 2026-11-18 完成** | **是** |
| 1B | 壳层 + 聊天视觉 | **✅ 2026-11-18 完成（见 §3B，含一处后移）** | **是** |
| 2 | 任务 / 团队 / 记忆 | **✅ 2026-11-18（视觉 + 文案缺陷；团队深层面板随 5A）** | 目标测试 |
| 3 | 设置 + 引导 + 错误恢复 | **✅ 2026-11-18（视觉 + 人设/状态文案；身份 emoji 见 §3D.3）** | **是** |
| **4A** | **界面缺陷审计与修复（设置 23 子页 + 生产构建白屏）** | **✅ 2026-11-18** | **是** |
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

## 3A. Batch 1A · 执行结果（2026-11-18 完成）

### 3A.1 实际落地

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/components/workspace/WorkspaceFrame.tsx` | 新增 | `WorkspaceMainColumn`（三份主区 → 一份实现）+ `WorkspaceFrame`（三套皮肤的布局包裹） |
| `src/components/HubLayout.tsx` | 修改 | 新增可选 `rightRail`：传入即用 App 构造的右栏；不传回落旧行为 |
| `src/App.tsx` | 修改 | 400 行三份 → `renderWorkspace()` 一次构造（侧栏/主列/右栏各一份）+ 三个 `variant` |
| `src/test/workspace-frame.test.tsx` | 新增 | 10 例：三档布局摆放、主列节点顺序与渲染条件、**App 里这些块只能各出现一次** |
| `src/test/ui-batch-a-d.test.ts` | 修改 | E6 从「三处 `onFork={handleFork}`」收紧为「只有一处共享接线 + 零内联实现」 |
| `src/test/phase-b-f-regression.test.ts` | 修改 | 笔记本横幅断言改为「实现住在主列组件、App 负责传状态」 |

**顺带修掉的真实漂移**：迁移前 hub 的右栏由 `HubLayout` 自渲染，**少传 `sessionId` / `workspace` / `agents`** ——
同一块面板在 hub 下少了三样数据。现在三套皮肤共用一份右栏节点（判据：`workspace-frame.test.tsx` 的 hub 用例）。

### 3A.2 等价性取证（真机、真源码）

做法：`npm run dev`（Vite）+ 直接启动 `src-tauri/target/debug/codem.exe`（带 CDP 9224、独立 `CODEM_DATA_HOME` 与
`WEBVIEW2_USER_DATA_FOLDER`），与**装机版 1.18.14**（pre-refactor，CDP 9222）在同一份数据上逐元素对比。

| 项 | 结果 |
|---|---|
| 元素数 | **2021 = 2021** |
| 逐元素 tag / class / `data-testid` / role | 0 处差异 |
| 逐元素矩形 | 0 处差异 |
| 9 项布局计算属性（display/position/flex/overflow/grid/align/justify） | 0 处差异 |
| 截图 | 43 px、单通道 1（LCD 次像素抗锯齿的捕获路径差，容差内） |

证据：`.preview-shot/unslop/batch1a/dom-compare.json`（`identical: true, problemCount: 0`）。

### 3A.3 踩到的坑（写进配方，后面每批都要用）

1. **dev 版白屏**不是代码问题：`Page.reload` 后 dev 模式要等 Vite 模块图 + 900 MB 库初始化，
   原等待条件（20s）不够 → 判据读到"3 个元素"。现改为等 `.panel-content` 出现、上限 90s。
2. **CDP 端口起不来**的根因是 **WebView2 复用已运行实例的 user-data 目录**：
   装机版已在跑，dev 版拿到同一个 browser 进程（那个进程没有 `--remote-debugging-port`），
   于是 env 里的端口不起作用。修法：dev 版额外给 `WEBVIEW2_USER_DATA_FOLDER`。

---

## 3B. Batch 1B · 执行结果（2026-11-18 完成）

### 3B.1 落地内容

| 范围 | 做法 | 证据 |
|---|---|---|
| 字体 | `--font-ui-default` / `--font-mono` 改指 v2 系统栈（`unslop-tokens.css` 桥接），全站 9 个消费点零改动跟随 | 截图 03-on-dark 的字形 |
| accent 淡底 | 定义 `--accent-soft`（此前只在 dream 皮肤里定义，6 处兜底真的在画紫色） | `ui-token-canonical` |
| codem-ui 漏接令牌 | `--message-actions-*` / `--run-bar-*` / `--surface-1/2` / `--surface-hover` / `--composer-bg` / `--titlebar-bg` 全部重指到 `--ui-*` | 同上 |
| 壳层 | 标题栏 40px、菜单/侧栏/行/项目行/会话行、rail、右栏 tab、panel-sidebar：中性面 + 发丝线；去 `backdrop-filter`；分组标题去全大写宽字距 | `unslop-v2.css` §2–3 |
| 聊天头 | **10 个控件 → 3 + overflow**（侧栏开关 / 会话标题 / 模型 + `⋯` 菜单 7 项），每项有文字名与 `aria-checked`，Escape 关闭并还焦 | 新组件 + `chat-header-overflow.test.tsx`（5 例） |
| 消息 | 用户气泡中性面 + 10px 圆角 + 发丝线、无阴影；正文行高 1.62；元信息 mono + `tabular-nums` | §5、§8 |
| 工具卡 | 从"左侧 2px 线"改为 surface + 发丝线 + 10px 圆角；渐变分隔线换实线 | §6 |
| 状态 | `任务完成` 胶囊 → 5px 绿点 + 文字（勾选图标隐藏）；`tool-card-status` / `agent-detail-status` 同样去胶囊；未读/计数去掉实心色块 | §8、§2 |
| Composer | 12px 圆角单层面、焦点只改边框（去掉 18px 琥珀光晕）、输入 48–220px、发送键 32px 琥珀方块 | §7 |
| Diff | 作为"唯一富表现"：12px 圆角、中性头、mono 文件名、批准的实心绿 / 拒绝的描边红 | §9 |
| 浮层 | search / popover / toast / boot splash 全部去模糊、去彩色 glow | §11 |
| 皮肤 | dream 的 6 处 `!important` 毛玻璃在 v2 下取消 | §12 |
| emoji | 剥注释口径 **274 行 / 55 文件 → 253 行 / 48 文件**；聊天壳层（ChatPanel / MessageBubble / ToolCallCard / Diff / InputArea / Feedback / ContextBadge / Slash）**渲染态 emoji = 0** | 棘轮基线已收紧 |
| 文案 | `🔴 上下文即将满！请立即压缩` → `上下文接近上限，可压缩`；`⏳/✅/⚠️/💰/▼/▶/■` 等状态字形全部改为文字或 lucide | 同上 |

### 3B.2 判据

- 新增 `src/test/chat-header-overflow.test.tsx`（5 例：可访问名/aria-expanded、menuitemcheckbox 与 checked、选中即关、禁用项不可点、Escape 还焦）；
- `ui-layer.test.ts` 的作用域闸顺手修了一个**假红**：选择器切分现在按括号深度切（`:is(:hover, :focus-visible)` 里的逗号不再被当成分隔符），并新增了一条切分器自测；
- emoji / 文案棘轮基线按"清掉多少收紧多少"更新（274→253 行、55→48 文件）。

### 3B.3 本批踩到并修掉的坑

1. **CRLF 锚点**：`git` 在 Windows 工作副本里是 CRLF，脚本里用 `\n` 拼的多行锚点全部匹配不到。
   配方：先 `const EOL = src.includes("\r\n") ? "\r\n" : "\n"`，再用 `L(...)` 拼锚点。
2. **`:is(a, b)` 逗号**：作用域闸按逗号切选择器会把 `:focus-visible)` 当成一条选择器 → 假红。
3. **knip `types` 棘轮**：`export interface CompactionBannerStatus` / `export type ChatPanelProps` 属于"只在文件内用"的导出，
   当场把 types 从 30 顶到 32 → 去掉 `export` 即回落（判据当场抓到，说明棘轮有效）。

### 3B.4 后移项（如实记）

- **专属右侧 Context 标尺**：方向稿里的右侧栏（Context 68% + 工作集 + Session + Next）需要一个**新的入口**（新 tab 或常驻列），
  属产品决策（入口/占位/移动端表现），不在"换视觉"范围内。本批先完成既有的上下文面板与元信息样式；
  标尺本体随 Batch 4（知识/文档/媒体）或用户拍板入口后单独做。
- **控件尺度的全量统一**：本批统一了头部（28）、输入区（48–220）、反馈/操作（24）、qa-turn（24）；
  其余列表行随各自批次（2 任务/3 设置/5A 文件）落地 —— 口径已写进 §3B.1。

---

## 3C. Batch 2 · 执行结果（任务中心 / 团队列表 / 记忆）

### 3C.1 视觉（`unslop-v2.css` §13）

- 任务中心：面板 14px 圆角 + 发丝线；页签从"胶囊 + 图标"改成**下划线**；按钮分主次
  （主操作 = 琥珀实心，其余 = 描边幽灵）；`tc-field` 用 raised 面 + 发丝线，焦点只改边框。
- 团队：`squads-card` / `tc-editor` 统一 raised 面 + 10px 圆角；计数徽标去胶囊改 mono 描边。
- 记忆：面板 14px 圆角；七连数字改 **mono 数值 + 小标签**（结构未重构，数字墙仍在，见 §3C.3）；
  条目 hover/选中走 surface 阶梯；作用域徽标去胶囊；notice 改成"中性面 + 左侧 2px accent"。

### 3C.2 文案缺陷修复（跨批，属真实缺陷）

| 规则 | 修前 | 修后 | 做法 |
|---|---:|---:|---|
| 禁用词 | 12 | **0** | 一键安装→安装、一键全部批准→全部批准、放心重试→可以重试、开箱即用→已内置、Bot 主人→Bot 账号、一键操作→快捷操作 |
| greeting | 1 | **0** | `准备好了，开始吧。` → `开始使用` |
| 感叹号 | 11 | **0** | `任务完成！…` / `创建成功！` / `回滚成功！` / `安装成功!` / `回复完成了！` 等改陈述句 |
| raw Markdown | 52 | **8** | 只剥**纯文本渲染**处（`notice` / JSX 文本 / `window.confirm`）；`App.tsx` 里走 Markdown 渲染器的消息保留 `**` |

**为什么 raw Markdown 没清零**：第一次用"全仓剥星号"的做法把 `App.tsx` 里会走 Markdown 渲染的
消息内容也剥了 —— 那些位置的 `**` 是**有效格式**，剥掉等于改行为。已回滚，改为只处理确认是纯文本的位置。
剩下 8 处全部在 `App.tsx` 的 `content:` 字符串里（Markdown 渲染），是**正确保留**。

### 3C.3 后移

- 记忆面板的"七连数字墙"只是改成 mono + 小一档，**没有**重构成"分组信息行"（方向稿的形态）。
  那需要改 `MemoryManager` 的 JSX 结构（新增分组容器/字段标签），属结构改动，放 Batch 4 一起做。
- 团队/智能体的深层面板（`AgentManager` / `AgentTeamsPanel` / `IssueDetailPanel`）随 **5A**。

---

## 3D. Batch 3 · 执行结果（设置 / 引导 / Git 环境）

### 3D.1 视觉（`unslop-v2.css` §14）

- 设置面板：14px 圆角 + 中性面；左栏页码 32px、当前项 = 中性面 + 左侧 2px accent（不再是彩色胶囊）；
  分节标题 20px/600；输入、下拉、文本域统一 8px 圆角 + 发丝线，焦点只改边框（去掉外发光）。
- 身份选择（人设/头像）：按钮是"可选项"，选中只加深面与线，不做彩色填充。
- 引导向导：卡片 = 中性面 + 发丝线；主按钮 = 琥珀实心。

### 3D.2 文案

| 项 | 修前 | 修后 |
|---|---|---|
| 人设预设 | `数字精灵 / 赛博管家 / 电子幽灵` | `文档助手 / 运维助手 / 研究助手`（两处：设置 + 引导向导；自由输入框不受影响） |
| 未确认保存横幅 | `⚠️ 未确认保存：…`（3 条中英各一） | `未确认保存：…` |
| Git 环境 | `🌿 Git 偏好配置` / `🔄 自动 Commit` / `✅ 已保存` / `🏗️ 环境脚本配置` | 去掉字形 |
| CI-CD | `⚠ 上一个操作…` / `✅ … OK` / `❌ ${error}` / `⚠ {error}` | 去掉字形（失败由 `actionMsg` 文案本身表达） |

emoji 棘轮：252 行 / 48 文件 → **233 行 / 47 文件**。

### 3D.3 未做及原因（需要拍板，不是漏做）

**身份头像的 12 个 emoji 预设没有换成 lint 图标。** 原因：`identity.emoji` 是**存在 settings 里的用户数据**
（自由输入框还能填任意字符），渲染侧直接 `{identity.emoji}` 输出。换图标 = 改数据模型 + 改所有渲染点，
属于"改 store / 数据"（第一轮明确排除）。若要按方向稿执行，需要先定：图标用**名字**存（`shield`）还是
**组件映射**、旧数据怎么迁移、自由输入还能不能填 emoji —— 三个都是产品决策。

同批确认：`SettingsPanel` 里仍有约 20 处 `log("✅ …")`，那是**自检面板的开发者输出**（不是用户文案），按口径不计入。

---

## 3E. Batch 4A · 界面缺陷审计与修复（2026-11-18）

用户实报：设置页及其子页、弹窗里「要素被压缩 / 换行 / 对齐 / 切页签窗口忽大忽小 / 同层字号不一致 /
按钮风格不一致 / 字体图标行距不一致」。这一轮先把这些说法变成**可数指标**，再逐项修。

### 3E.1 仪器

`.preview-shot/_unslop-ui-audit.mjs`：CDP 连真机 → 进设置 → 逐个点 23 个左栏页签 → 每页采一份指标 + 截图。
指标全部来自 `getComputedStyle` / `getBoundingClientRect`（不看截图）：面板尺寸、控件高度档、控件字号档、
控件尺寸种类、圆角种类、溢出（`scrollWidth-clientWidth>2`）、压缩（行高 < 1.15×字号）、
图标与文字中心线偏差、label 与控件左边缘差。
两轮：**before = 装机版 1.18.14（v1）**、**after = 同源码构建 + `[data-ui=v2]`**。
完整方法、复现命令、未做项：`docs/design/audit/batch-4a/README.md`。

### 3E.2 数字（23 个设置子页）

| 指标 | before（v1） | after（v2） |
|---|---|---|
| 面板尺寸 | 全部 1575×940 | 全部 1575×940（**本来就没跳变**，这条排除） |
| 控件高度档 | 21/24/26/27/28/29/30/31/33/34/36/40/46（每页 9–12 档） | **28 / 32**（20 页只有两档） |
| 控件字号档 | 10/11/12/13/13.33/16/20（每页 6–7 种） | **12**（22/23 页；连接手机仍有一处 10） |
| 圆角种类 | 每页最多 5 种 | **2 种**（控件 8 + 开关 9999） |
| 图标与文字中心线偏差 | 每页 24–30 处（侧栏固定 **-2.9px**） | 每页 1–10 处（侧栏 **0**） |
| 压缩 | 「通用」页 40 处 | **0**（21 页为 0，另 2 页各 1） |
| 文本溢出 | 工具页 91 / 记忆体检 17 | 工具页 **64** / 记忆体检 17（预览主动截断） |

### 3E.3 改了什么

1. `.settings-sidebar-item`：31→32px，图标盒 16px、文字行高 **16px**（与图标同高）⇒ 中心线偏差 **2.9px → 0**。
2. 设置页紧凑控件统一 **28px 高 / 8px 圆角 / 12px 字**；开关保留 24px 胶囊（语义）；整行大卡片、
   图标格、头像、返回键、虚线投放区**不参与**收敛（不同控件类型，不是刻度不一致）。
3. 二级页签 26px 圆胶囊 → 28px 方角 + 下划线；记忆体检 21px 小胶囊 → 28px。
4. 设置页字号收敛到 11 / 12 / 14 / 20 四档。
5. 工具列表描述：单行+手截 100 字 → **两行截断**（实测被裁 18–77px 的 10 条描述可读了）。
6. 设置 → 外观新增「界面版本：经典 / 新版（灰度）」开关（只写 localStorage，不动业务逻辑）。

### 3E.4 同批修掉的生产级 P0：打包后白屏

构建产物一启动就 `Uncaught ReferenceError: Cannot access 'v0' before initialization`（v0 = `AgenticLoop`），
窗口全白；dev 下完全看不到。根因：12 处 `await import("…/core/llm")` 让 Rollup 为 barrel 生成**急切求值**的
命名空间字面量，而 barrel 在环上（`index → agentic-loop → tools → read-attachment → store → core/store → index`），
求值从环另一侧进入时先读 `AgenticLoop` ⇒ TDZ。
修法：新增叶子门面 `src/core/llm/engine-access.ts`（只再导出 `getLLMEngine` / `peekLLMEngine` 两个**函数声明**），
13 处动态导入改为指向它 ⇒ barrel 不再有急切命名空间对象。判据 `src/test/llm-barrel-tdz.test.ts` 扫全仓：
任何动态导入解析到 `core/llm/index.ts` 一律红。
连带：`core/llm/index.ts` 因此从「隐式 entry（被动态导入）」变成普通模块，knip 立刻报出它 100+ 条
「未使用导出」—— 这些是 barrel 的公开面，正确做法是把它像另外 21 个门面一样写进 `knip.json` 的 `entry`；
`tools/audit/knip-gate.mjs` 的门面交叉对账也相应改为「**不可达**的门面才必须在可达性白名单里」
（可达的门面登记进白名单会被可达性门禁判成过期条目）。

### 3E.5 未做（下一轮接着做）

- **弹窗**（搜索 / 任务中心 / 插件市场 / 项目设置 / 确认框…）还没逐个采集；同一套脚本可用。
- 工具页余下 64 处溢出是同一页其它内联单行文本（工具参数说明），需逐个改两行。
- 记忆体检 17 处溢出是列表预览的**主动**截断（有省略号），不算缺陷。

---

## 4. Batch 1A 的实现细节（留档）

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
