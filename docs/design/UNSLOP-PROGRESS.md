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
| **4B** | **非设置面全覆盖（页面/面板/弹窗）** | **✅ 2026-11-19** | **是** |
| **5A/5B** | **文件/终端/工作台 + 插件/市场/技能/智能体/MCP** | **✅ 2026-11-19** | **是** |
| **6A** | **三套皮肤在 v2 下的验收** | **✅ 2026-11-19** | **截图** |
| **6B** | **窄视口（390/768）布局** | **✅ 布局；真机 ❌ blocked** | **是（布局）** |
| **6C** | **无障碍：Esc / 可访问名 / 触控尺寸 / 焦点环** | **✅ 2026-11-19** | **是** |
| **7** | **收口：截图集 + 门禁复核 + 默认开关决策** | **✅ 2026-11-19** | **是** |
| 4 | 知识 / 文档 / 媒体 / 目标 | 待执行（并入 4B 的面覆盖） | 目标测试 |
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

### 3E.5 弹窗（同一批，第二轮）

逐个打开搜索 / 任务中心 / 记忆 / 插件管理 / 设置，采 `.modal-panel` 尺寸与控件刻度（`_unslop-dialog-audit.mjs`）：

| 弹窗 | before | after |
|---|---|---|
| 记忆 | 1000×787 · 圆角 10 · 高 15/21/23/25/27/33 · 字 11/12/13.33 · 圆角 0/6/8 | **1180×787 · 14 · 28 · 12 · 8** |
| 插件管理 | 1000×787 · 圆角 10 · 高 31/33 · 圆角 0/6 · 溢出 10 | **1180×787 · 14 · 28 · 8 · 溢出 3** |
| 任务中心 | 1180×720 · 圆角 10 · 高 26/27/40 · 圆角 0/4 | 圆角 **8** · 高 **28** |
| 搜索 | 660×443 · 14 | 不变（本来就合规） |
| 设置 | 1575×940 · 14 | 不变（最大档） |

**「窗口忽大忽小」在弹窗上的形态**：同为列表型弹窗却有 1000 与 1180 两种宽度，设置是满屏 1575；
同一批弹窗的控件高度 9 档。§16 之后：面板统一 14px 圆角、列表型弹窗统一 1180 上限、控件 28 / 8px / 12px。

### 3E.6 未做（下一轮接着做）

- **弹窗**（搜索 / 任务中心 / 插件市场 / 项目设置 / 确认框…）还没逐个采集；同一套脚本可用。
- 工具页余下 64 处溢出是同一页其它内联单行文本（工具参数说明），需逐个改两行。
- 记忆体检 17 处溢出是列表预览的**主动**截断（有省略号），不算缺陷。

---

## 3F. Batch 4B / 5A / 5B / 6A / 6B / 6C（2026-11-19）

### 3F.1 覆盖面测量

两份只读清单驱动：**110 条**页面/面板（侧栏 8、任务中心 8 页签、右栏 4、右浮层 6、对话头 5、终端、
文件/编辑器/工作台、插件市场、知识/文档/媒体…）+ **70 条**弹窗（App 级 modal、confirm、nb-dialog、
AI 回合类、市场类；其中 3 条不可达已标注）。脚本 `_unslop-surfaces-audit.mjs` 逐目标点击 → 量 → 截图 → 三路关闭。

结果：聊天主界面 18/22/23/25/27/32/34 · 11/13/14/16 → **28/32 · 12/14 · 8**；
记忆/MCP/技能/插件/笔记本/智能体 全部 **1179×786 · 28 · 12 · 8**；浮层（上下文/快照/侧边面板）与终端抽屉同刻度。

### 3F.2 两条真 bug

1. **切页签窗口忽大忽小**（用户原话）：`TaskCenter` 按 `activeTab` 在 `min(1180px,96vw)` 与
   `min(960px,92vw)` 之间切 —— 8 个页签横跳 220px。改为恒 1180，判据 DEDUP-7 同步改断言。
2. **中文界面里新对话页整页英文**：`NewChatPage` 用 `document.documentElement.lang === "zh"`，
   而 `index.html` 是 `zh-CN` ⇒ 永不成立。改用 `useLang()`。

### 3F.3 5A/5B 视觉（§18/§19）

文件/编辑器/终端/工作台：条 32、行 28、图标 24；去玻璃与彩色 glow；CI/CD 状态改 5px 点 + 文字；
diff 只留增删淡底。插件/市场/技能/智能体/MCP：卡片 surface + 发丝线 + 10px，去悬停抬升；
标签去胶囊；emoji 图标位用 `:not(:has(svg))` + `font-size: 0` 收成 28×28 中性底托。

### 3F.4 6B 窄视口（真 bug）

390×844：横向溢出 **39px → 0**、越界元素 **10 → 0**；768×1024 同样 0。
根因两条：① **hub / dream 两套皮肤根本没有汉堡按钮**（`WorkspaceFrame` 只在默认皮肤渲染，
`App.tsx` 两个分支也没传 prop）⇒ 窄屏没有打开侧栏的入口；② dream 装饰层与标题栏按钮组越界。
修法：三套都渲染并传 prop；窄屏收装饰、按钮组绝对定位、隐藏 `.app-menubar`；≤480 建议卡单列。
**真机仍 blocked**（无设备），未冒充。

### 3F.5 6C 无障碍

- **Esc 关不掉弹窗**（真 bug，App 级 `.modal-overlay` 没有 Esc 处理）⇒ `core/ui/escape-to-close.ts`，
  只点显式关闭按钮（不合成遮罩点击，避免被当成「拒绝」）；真机验证 MCP 弹窗 Esc 前 true → 后 false。
- **可访问名**：设置页 35 → 1、主界面 2 → 0、任务中心 2 → 0、插件 2 → 0（`core/ui/aria-label-form.ts`，
  label 配对 + placeholder 兜底 + 观察新增子树）。
- **触控尺寸**：13/15/18/54 → 0/2/1/0（收藏 12px→24、开关 23→24、紧凑模式 18→24）。
- **焦点环**：标题栏/侧栏/页签/菜单项补 `:focus-visible`（用 CDP 真键盘 Tab 验证，programmatic focus 不触发）。

### 3F.5b 安卓模拟器验证（用户授权用虚拟机）

AVD `codem-x86`（x86_64 / API 35 / 1080×2400）。原来那个 `emulator-5554` 系统服务只有 67 个、`pm`/`wm` 全挂，
`emu kill` 后 `-no-snapshot-load` 冷启动 `emulator-5556`（290 个服务）才可用。

1. **桌面 Web UI 在 Android Chrome**（`http://10.0.2.2:1420/?ui=v2`）**能渲染**：琥珀主色、发丝线、28px 控件都对；
   但缺 `window.__TAURI__` ⇒ 落进首次引导、拿不到数据 —— 只作兼容性观察，不当移动端形态。
   **由此抓到一条窄屏真问题**：窗口按钮绝对定位后压住右侧动作图标（齿轮与最小化重叠）⇒ 给 `.titlebar-nav-actions` 留占位。
2. **Flutter 原生客户端**（`Codem-Mobile-1.1.0-x86_64.apk`）`adb install` 成功、`MainActivity` 起来、首页正常。
   一致性发现：移动端强调色是**靛蓝**（`0xFF7C6CF0`），与桌面 v2 的琥珀 `#C6A15B` 不同一套；
   改 `mobile/lib/design/tokens.dart` 三个值即可，但本机**没有 Flutter SDK** ⇒ 只记不改（改完无法重建验证）。
3. 真机仍 blocked；`android-shell` 未重跑（它打的是 `packages/host/web`，与本次 `src/` UI 不是同一份代码）。

证据：`docs/design/audit/batch-6/after-android.md`；截图 `.preview-shot/unslop/android/*.png`。

### 3F.6 仍未做

- 真机 Android/iOS（blocked，无设备）。
- 设置页剩 1 个无可访问名控件、2 个 <24px 控件；无障碍只采样 4 个面。
- Batch 7：**是否把 v2 设为默认**（产品决策，需用户拍板）+ 最终截图集。

---

## 3G. Batch 7 收口（2026-11-19）

- 收口截图 10 张（默认皮肤、1440×900、`?ui=v2`）：主界面 / 设置-通用 / 设置-外观 / 任务中心-概览 /
  任务中心-看板 / 插件-已安装 / 插件-市场 / 终端抽屉 / 记忆 / 技能。路径 `.preview-shot/unslop/final/`。
- 门禁复核全绿：tsc 0；全量 vitest **10228 通过 / 18 skipped / 0 失败**（975 文件）；scan-ui 0/0；
  style-literals 11 族不涨；color-roles 51 对；token-hygiene / motion / doc-tokens；knip 46/30；
  reachability；OVERLAY-1b/1c；docs-bench-evidence BE-2。
- **默认仍是经典**：v2 通过「设置 → 外观 → 界面版本 → 新版（灰度）」开启（只写 localStorage）。
  切默认是产品决策，留给用户；改动点只有一处（`core/theme/ui-layer.ts` 的兜底值）。

### 仍未做（明确记账）

1. 真机 Android/iOS：无设备，blocked。
2. 设置页剩 1 个无可访问名控件、2 个 <24px 控件。
3. 右栏（改动/文件/子代理/浏览器）在没有打开项目时无法自动打开审计；AI 回合类弹窗与破坏性前置弹窗未自动驱动。
4. 三个不可达入口（ConfigEditor 死 prop、GitHubCloneDialog 无入口、游戏页刻意无入口）已记录，未动。

---

## 3H. 第 5 轮：全面测试 + 修复（2026-11-19）

用户口径：「功能、性能、数据链路、信息流、页面调用、页面交互全面测试；遇到 bug 修复（不论新旧、不论谁引入）；
以根治为目标；不要用绕开真实 bug 的方式让用例变绿」。这一节记的就是这一轮**测出来了什么、怎么修的、判据在哪**。

### 3H.1 测法（三层，互补）

| 层 | 做什么 | 覆盖 |
|---|---|---|
| 静态审计（3 份并行） | ①TS↔Rust 的 IPC 面（命令名/参数名/事件通道）②点击处理器的「静默失败」形态 ③渲染/数据路径性能 | 241 个前端调用点 / 133 个 Rust 命令 / 17 个事件通道 / 242 个 tsx |
| 运行时爬取 | 真机（Tauri WebView2 + CDP）点遍可达 UI：每个可点元素单独点一次，记录 console.error、未捕获拒绝、IPC 失败、空白浮层、无变化点击 | 805 次点击（主界面 + 8 个面板），破坏性动作按名单跳过并记账 |
| 端到端信息流 | 真实发消息（文本回合 + 工具回合），断言用户气泡、助手气泡、工具卡片、流式状态与全程零异常 | 2 个真实回合，0 异常 / 0 未捕获拒绝 / 0 IPC 失败 |

### 3H.2 数据链路（最严重的一类：静默失效）

**IPC 参数大小写**：Tauri v2 按 **camelCase** 从 JS 取键、再映射到 Rust 的 snake_case 参数；传错大小写**不报错**
（`Option<T>` 拿到 `None`、多余键被 serde 忽略）。实测 8 处：

- `write_file` 传 `sandbox_enabled` / `allowed_roots` ⇒ Rust 收到 `None` ⇒ 沙箱按「开着」处理（**用户关掉沙箱仍被拒**），
  且设置里的允许目录白名单**完全不生效**；
- `execute_command` 传 `timeout_ms` / `bash_path` ⇒ 超时回落到 Rust 默认 **600s**（卡死命令挂 10 分钟）、
  自定义 bash 路径失效。

修法是改键名（8 处），并加**判据**把这一类钉死：`src/test/ipc-arg-casing.test.ts`（新增两条）——
①每条 `invoke("cmd", {…})` 的键必须等于该命令 Rust 参数的 camelCase；②命令名必须真的在 `generate_handler!` 里。

**命令不存在**：CI/CD「保存工作流」调 `dialog_save` / `write_text_file` —— 全仓 133 个命令里**没有**这两个，
该按钮 100% 失败（错误只写进 `actionMsg`，看起来像偶发）。改成 Tauri v2 插件命令 `plugin:dialog|save`
（capabilities 已授权）→ 拿到用户选定路径后走本仓 `write_file`（用户选的路径不再走工作区守卫，语义见
`src/core/file-api.ts::writeFileAtUserChosenPath`）。上面第②条判据即为此设。

**每击键一次 IPC**：`useDraftPersistence` 把「防抖 500ms」与「切会话立即冲刷」写在同一条 effect 里，
依赖含 `draft` 而 cleanup 无条件写盘 ⇒ **每敲一个字一次 `settings.set`**，防抖被完全绕过。
拆成两条 effect（防抖只清定时器、冲刷只依赖 `draftKey`）；判据 `src/test/draft-persistence-ipc.test.ts`（4 条）。

**每击键 ≥3 次整份 JSON 解析**：`InputArea` 渲染体里 `getModelsForMode(mode)` → `getConfiguredApiModels()`
要对 `codem-settings`、动态模型、免费模型插件各 parse 一次。改为局部 `useMemo(mode, 版本号)`，
版本号由 `codem-settings-changed` 事件推进；判据 `src/test/input-models-memo.test.tsx`（3 条）。
**没有**做成模块级全局缓存：那份缓存判断不了「绕过 `setSetting` 的写入」（迁移/导入/插件/mock），
实测会让 4 个既有用例假红 —— 局部 memo 的失效点只有事件，语义清楚。

**附件 N+1**：`listMessagesFromIndex` 原来对**每条消息**调一次 `attachmentsFromMirror`，
而端口 `domains.find()` 是「整表复制 + 全量过滤」⇒ 读 M 条消息 = M 次整表复制（M=500/A=2000 时百万级行复制）。
改为按会话一次读完再按 `message_id` 分桶；判据 `src/test/attachment-bulk-read.test.ts`（2 条，断言只读 1 次）。

### 3H.3 页面交互（点了没反应 / 永久转圈 / 静默消失）

「`try { … } finally { … }` 没有 `catch`」是本轮出现最多的一种形态：`finally` 会复位忙碌标志，
但**异常继续上抛成未捕获拒绝**，用户看不到任何提示；有的连标志都没复位，按钮就永久转圈。修了 14 处
（宠物市场加载/安装/卸载、Ollama 检查/取模型、MCP 连接/断开/全部连接、技能安装、插件安装/检索、
DSH 外部插件卡加载/检查更新/升级），每处都补 `catch` + 具体错误文案 + 清忙碌标志，
判据 `src/test/async-handler-failures.test.tsx`（14 条，改前 14/14 红）。

另有 8 处「可见控件承诺了不会发生的事」：

| 位置 | 现象 | 修法 |
|---|---|---|
| 设置页内嵌 `ToolManager`/`AgentManager` 的关闭 X | 传的是 `() => {}`，点了完全没反应（同屏 `UsageStats` 的 X 却能返回） | 改成 `setActiveTab("general")`，与兄弟面板一致 |
| 笔记本输入区的「切换到计划模式」 | `onModeChange={() => {}}`，title 承诺切换但无反应 | 宿主没有该能力时**不渲染**按钮（不再骗用户） |
| `app.goal-bar` 插槽 | `<SlotBridge fallback={null} />` 不传 props，而 `GoalBar` 判 `goal === undefined ⇒ null` ⇒ 目标条**永远不显示** | 新增 `src/components/GoalBarConnected.tsx`（订阅目标事件 + 读当前会话目标 + 暂停/恢复），插件注册它；判据 `src/test/goal-bar-connected.test.tsx` |
| 六个面板的异步处理器 | 见上段 | 见上段 |

**剪贴板未捕获拒绝**：真机爬取打出 3 条 `NotAllowedError: Document is not focused` —— 窗口未聚焦时
`navigator.clipboard.writeText` 必拒，而十来处调用点不管返回值。新增唯一入口 `src/utils/clipboard.ts::copyText`
（Clipboard API → `execCommand` 兜底 → 返回布尔，绝不抛），11 处调用点改走它；
判据 `src/test/clipboard-copy.test.ts`（5 条）。

**赞/踩没有选中态语义**：只改行内 color/class，没有 `aria-pressed` ⇒ 读屏用户与自动化都看不出「评价过没有」。
补 `aria-pressed`；判据 `src/test/feedback-toggle-state.test.tsx`。

### 3H.4 性能（用户可感的三处）

| 修法 | 之前 | 之后 | 判据 |
|---|---|---|---|
| 合并气泡按内容缓存（`src/components/assistant-group-merge.ts`） | 每次渲染新建 `merged` 对象 ⇒ `MessageBubble` 的 `memo` 必然失效 ⇒ 每个 assistant 组每秒被强制重渲染约 20 次（10 次流式 flush + 10 次滚动），每次重跑 markdown 解析与全文 `autoLinkFilePaths` | 内容不变复用同一对象引用 | `src/test/chat-merge-cache.test.ts`（5 条） |
| 代码块懒加载 | Prism + 24 门语法**静态进主包**（首屏必解析） | 独立 chunk，首块代码出现时才拉 | 主包 3.04MB → **2.91MB**（实测构建产物）；占位块与最终形态同字体同底色 |
| `TitleBar` 最大化状态 | 500ms 一次 `isMaximized` IPC（空闲时每秒 2 次跨进程调用） | 改为 `resize` 事件 + rAF 合并 + `onResized` 监听 | 代码注释 + 真机爬取无 IPC 失败 |

顺带修：`ConversationOverview` 的限额 `useMemo` 依赖写的是 `[]` ⇒ 在用量页保存新限额后上方进度条仍按旧值画，
直到切走再切回；改为依赖 `stats.cost`。

### 3H.5 读数（本轮结束时的实测）

- `npx vitest run`：**10281 passed / 18 skipped / 984 files / 0 failed**；`tsc --noEmit` 0 错误；
- 结构门禁：`scan-ui` 0 error / 0 warn、`knip` 46/46 exports、30/30 types、可达性通过、
  `css-contract` 3129 个类快照对齐、颜色角色 51 对全登记；
- 运行时爬取（新构建）：**805 次点击 / 0 console.error / 0 未捕获拒绝 / 0 IPC 失败 / 0 空白浮层**；
- 端到端：文本回合与工具回合均通过（工具卡片 `1 个工具调用 / 1/1`），全程零异常。

### 3H.6 仓库内对应实现（证据落点）

| 结论 | 仓库内文件 |
|---|---|
| IPC 参数与命令名判据 | `src/test/ipc-arg-casing.test.ts`、`src/core/command-api.ts`、`src/core/file-api.ts` |
| CI/CD 保存工作流 | `src/core/dialog-api.ts`、`src/components/CicdPanel.tsx` |
| 草稿防抖 | `src/hooks/useDraftPersistence.ts`、`src/test/draft-persistence-ipc.test.ts` |
| 模型列表 memo | `src/components/InputArea.tsx`、`src/test/input-models-memo.test.tsx` |
| 附件批量读 | `src/core/storage/message.ts`、`src/test/attachment-bulk-read.test.ts` |
| 异步失败可见 | `src/test/async-handler-failures.test.tsx` 与其覆盖的 6 个组件 |
| 死键/静默失败 | `src/test/ui-feedback-and-dead-keys.test.tsx`、`src/components/GoalBarConnected.tsx` |
| 剪贴板 | `src/utils/clipboard.ts`、`src/test/clipboard-copy.test.ts` |
| 合并气泡缓存 | `src/components/assistant-group-merge.ts`、`src/test/chat-merge-cache.test.ts` |
| 样式令牌与占位块 | `src/styles/codem-ui.css`、`src/components/rich-content/RichContent.tsx` |

### 3H.7 仍未做（如实记账）

- **移动端配色未重建 APK**：`mobile/lib/design/tokens.dart` 已改（强调色由紫 `#7C6CF0` 改为琥珀 `#C6A15B`，
  浅色 `#6D5423` 保对比度），但本机**没有 Flutter SDK**（`flutter`/`dart` 均不在 PATH，也没有安装目录），
  所以改的是源码、**没有**重新构建与装机验证 —— 这一条不能算「已验证」。
- **真实 arm64 安卓机**仍未验证（前几轮只用 x86_64 模拟器；模拟器缺 Google Play/推送，PRoot 与厂商保活没覆盖）。
- 静态审计里另外几项**未修**（低收益/高不确定）：`Sidebar` 每 5s 对每个项目重读会话表、
  水位轮询每 3s 全量读一次消息、`App.tsx` 无选择器订阅整店（改动面太大，需单独一轮带回归基线）。
- 目标条目前只覆盖「显示 + 暂停/恢复/清除」，**编辑目标**入口未接线（`onEdit` 未传）。

## 3I. 第 6 轮：移动端装配验证 + 三项「改动面大」的性能债（2026-11-20）

用户口径：装 Flutter SDK、装完在模拟器上验配色；把上一轮判断「改动面大还没做」的三项**带回归基线**做掉。

### 3I.1 移动端：从「改了源码」到「装机可见」

| 步骤 | 结果 |
|---|---|
| Flutter SDK | 官方 stable **3.47.9**（Dart **3.13.7**，正好满足 `mobile/pubspec.yaml` 的 `sdk: ^3.13.7`），装在 `C:\dev\flutter`，zip 的 sha256 与官方 `releases_windows.json` 逐字一致 |
| 工具链 | `flutter doctor`：Android 工具链 ✅（SDK 36.0.0 / build-tools 36.0.0 / JDK 17.0.20 / 许可全部已接受）、`emulator-5556`（Android 15, x86_64）在线；只有 Chrome 缺席（与安卓无关） |
| 构建 | `flutter build apk --debug --target-platform android-x64` → `mobile/build/app/outputs/flutter-apk/app-debug.apk`（Gradle `assembleDebug` 96.5s，退出码 0） |
| 装机 | `adb -s emulator-5556 install -r` → `Success`；`am start` 后截图 |
| 配色（深色） | 徽标底色、`新会话` 主按钮、`全部` 选中 chip 边框、演示数据横幅、底部选中 tab **全部是琥珀 `#C6A15B` 系**，无紫色残留 |
| 配色（浅色） | 切到浅色主题：选中 chip 边框/填充、开关、选中 tab 是**深琥珀 `#6D5423` 系**，白底上对比清晰 |

⚠️ 这一条只覆盖 **x86_64 模拟器**。**arm64 真机仍未验证**（PRoot / 厂商保活 / 推送依旧没有证据）——
上一轮记的这条限制**依然成立**，只是「源码改了但没装机」这一半现在补上了。

### 3I.2 三项性能债（每项都有「改前红、改后绿」的基线）

**① 侧栏 5s 刷新：从 O(项目数 × 整表) 到 O(整表)，且定时器不再被重建**

- 改前：`loadAllSessions()` 对**每个项目**调一次 `getProjectSessions(p.id)` → `listSessions` → 端口
  `domains.find({project_id})`（实现是「整表复制 + 全量过滤」）；更糟的是它被塞进依赖 `[allSessions]`
  的 effect 里、定时器又调它 ⇒ 每次 tick 都在**清掉并重建** interval。
- 改后：新增 `listSessionsGroupedByProject()`（一次整表读 + 内存分桶，与 `listSessions` 共用
  `compareSessions` / `isChildSession` / `withPendingMessageWrites` 三处语义），侧栏心跳只建一次定时器，
  未读水位在**同一个 tick** 里用刚读到的数据重算；页面隐藏时跳过、变回可见立即补一拍。
- 判据：`src/test/sidebar-session-polling.test.tsx`。**变异自证**：把 `loadAllSessions` 退回「按项目逐个读」
  ⇒ 判据红（`逐项目读 0 次` 失败）。

**② 水位轮询：隐藏时不读（试过的「缓存键」方案被既有判据证否，已撤销）**

- 现场：`readContextWaterLevel()` 第一句就是 `listVisibleMessages()`（整会话读），而它被每 3 秒调一次；
  原来的 `waterCache` 键要**先读出 visible 才能算**，所以缓存只省了估算、没省那次读。
- 先做的方案（用会话行 `message_count/lastMessageAt` 当闸门键）**被 WL-3 / WL-5 证否**：
  压缩/隐藏会让消息集合变化而条数不变，闸门会让提示条在压缩后继续显示「上下文即将满」——
  那是把缺陷修出来了，所以整段撤销（`water-gate.ts` 与它的判据一起删掉）。
- 最终只做零语义风险的那一半：**页面隐藏时不轮询**，`visibilitychange` 变回可见立即补一拍；
  `ContextMonitor` 的 3s 轮询同样处理。
- 判据：`src/test/water-poll-visibility.test.ts`（隐藏 3 周期读 0 次；可见每周期 1 次；切回立即 1 次）。
  既有 24 条水位判据全绿（含 WL-3 / WL-5）。

**③ 外壳整店订阅：无关字段不许触发重渲染**

- 改前：`App` / `ChatPanel` / `Sidebar` / `InputArea` / `RightSidebar` 都是
  `const {...} = useAppStore()`（无选择器）⇒ Zustand v5 下等价于订阅整个 state ⇒ **任何一次 `set()`**
  （反馈、持久化告警、别的会话的活跃标记…）都会让外壳重渲染，App 一渲染就重建
  TitleBar / Sidebar / RightSidebar / ChatPanel 四棵子树。
- 改后：五个组件全部改成 `useShallow` 逐字段选择（动作单独选，引用稳定）。
- 判据：`src/test/store-subscription-baseline.test.tsx`：①往 `feedback` 写一条（侧栏不读它）⇒
  侧栏 commit 数**不变**；②`projects` 换一份 ⇒ commit 数**必须增加**（反向对照，防「永不更新的选择器」）；
  ③源码口径：五个文件里不许再出现 `= useAppStore();` / `= useProjectStore();`。
  **变异自证**：把 Sidebar 退回整店订阅 ⇒ ① 红（commit 4 vs 3）且 ③ 红。

### 3I.3 测量口径的一处更正（重要）

上一轮报告里的「爬取：0 IPC 失败」**是假读数**：本仓渲染侧走 `window.__TAURI__.core.invoke`
（`withGlobalTauri: true`），而 `__TAURI__.core` 是 **`Object.freeze` 的**（`invoke` 的 `writable:false`、
`configurable:false`），因此既包不住全局入口，也拦不到它内部闭包持有的 `__TAURI_INTERNALS__.invoke`。
本轮实测：手动装 wrapper 后 `__manual` 仍为空 ⇒ IPC 计数恒 0。

- **仍然可信**：`console.error` / `window.error` / `unhandledrejection`（这三个钩子是独立装的，
  上一轮抓到的「复制消息 → NotAllowedError 未捕获」就是它们抓出来的，那条修复真实有效）。
- **不可信**：IPC 失败计数（恒 0）、以及依赖它的「死点击」补充判据。
- 本轮的替代做法：把可验证的成本**下沉到判据层**（上面的三组基线 + 变异自证），
  运行层只保留可观测的 console/异常/崩溃/空白浮层检查。

### 3I.4 读数

- `tsc --noEmit` 0 错误；全量测试见本轮提交前的最后一条记录；
- Flutter 构建：`assembleDebug` 退出码 0，APK 装机成功，深浅两色截图见上表；
- 三个新判据文件：`sidebar-session-polling.test.tsx`、`water-poll-visibility.test.ts`、
  `store-subscription-baseline.test.tsx`，各自都有变异自证记录。

### 3I.5 仍未做（如实记账）

- **arm64 真机**（PRoot / WebView / 厂商保活）仍无证据；
- `App`/`ChatPanel` 的**流式期间**重渲染成本没有降：`messages` 仍是它们要读的字段，
  真正的解法是「把消息列表的渲染订阅从 App 里挪走」+ 给外壳子树加 memo 边界，
  那是另一次结构性改动（本轮只做了「无关字段」这一半，并给出了可复跑的基线）。
- 运行层 IPC 计数在 `__TAURI__.core` 被冻结的前提下无法实现；若要，得在 Rust 侧加计数或改前端封装，
  两者都超出「不改业务逻辑」的边界（前者可做，但需要改 Rust 并重启应用，留作下一轮）。

## 3J. 第 7 轮：把三项性能债**做完**（轮询 → 通知驱动；外壳不再随流式重渲染）（2026-11-20）

第 6 轮做的是「三项的第一半」：侧栏换成一次整表读、水位只加了可见性闸门、外壳换成逐字段选择。
这一轮把它们各自的**剩余成本**消掉 —— 全部有「改前红 / 改后绿」的基线，且每项都做了变异自证。

### 3J.1 地基：域写通知（`core/storage/domain-write-events.ts`）

侧栏 5s 重读、水位 3s 全量读，目的都只是「数据可能变了，再读一遍」。而写路径**知道**自己刚写了哪张表：
`domain-store.persistWriteThrough` 是唯一落点（镜像 `applyWriteMany` / `applyDelete` 之后）。
于是新增 `subscribeDomainWrites(listener)`，在落点通知；边界写在文件头：

- 只覆盖**本进程内**经 domain-store 的写；镜像整表重载与引擎侧主动推来的变化**收不到** ⇒ 订阅方必须保留低频兜底；
- 监听方抛错**不影响写**（写是事实，通知是尽力而为）。

判据 `src/test/domain-write-events.test.ts`（写 ⇒ 收到表名；监听抛错写仍返回 true；取消订阅后不再收到）。

### 3J.2 侧栏：每 5s 重读 → **有写才读**

- 心跳改为：订阅 `sessions` / `messages` 的域写 ⇒ **1.5s 合并窗口**后刷新一次；
  `isStreaming` 期间跳过（否则一个回合里消息表每 100ms 写一次，会把 5s 轮询变成 400ms 轮询，比原来更糟）；
  30s 安全轮询兜底；页面隐藏一律不读，切回立即补一次。
- 读数（判据实测）：无写入时 **10 秒 0 次整表读**（改前 2 次）；一次回合结束后的批量写只触发 **1 次**。
- 判据 `src/test/sidebar-session-polling.test.tsx`（5 条）。
  **变异自证**：①把心跳退回 `setInterval(refresh, 5000)` ⇒ 「10 秒 0 次」红（实测 3 次）；
  ②把 `notifyDomainWrite` 从落点删掉 ⇒ `domain-write-events` 判据红。

### 3J.3 水位：每 3s 整会话读 → **事件驱动 + 30s 兜底**

- 触发条件与提示条语义对齐：store 的 `messages` 引用变化（**2s 合并**）、`isStreaming` true→false（**立即**）、
  30s 兜底、`visibilitychange` 立即补拍；页面隐藏一律不读。
- 读数（判据实测）：挂载后 **9 秒内只读 1 次**（改前 4 次）；回合结束立刻多一次（比原来的 3s 轮询更及时）。
- `ContextMonitor` 面板同样处理：3s → 30s 兜底 + store 订阅（2s 合并 / 回合结束立即）。
- 判据 `src/test/water-poll-visibility.test.ts`（5 条）。
  **变异自证**：把轮询改回 3s ⇒ 「9 秒 1 次」红（实测 4 次）。

### 3J.4 外壳：App 不再订阅 `messages`（流式期间不重渲染）

自动保存原来是 App 里依赖 `[messages, isStreaming, loadedSessionId]` 的 effect —— 语义正确，
但它让 **App 必须订阅 `messages`**：流式期间每 100ms 一次 `appendToMessage` ⇒ 6500 行的 App 重渲染一次，
连带它渲染的 TitleBar / Sidebar / RightSidebar / ChatPanel 四棵子树（都不是 memo）。

- 搬到 `src/hooks/useSessionAutosave.ts`：**store 订阅**里按同一套规则写库
  （归属 = `loadedSessionId`；流式 2s 防抖；非流式立即；无归属/空列表不写；卸载清计时器）。
  日志仍走 `debugLog("autosave", …)`。
- App 的选择器里删掉 `messages`；其余用到 messages 的地方（模型切换前保存、模式切换前保存、
  切会话前保存、保存 AI 回复为笔记）改成**调用时刻** `useAppStore.getState().messages` —— 语义等价且更新鲜。
- 判据：`src/test/session-autosave-subscription.test.tsx`（6 条，逐条对齐原 effect 的语义）；
  `src/test/store-subscription-baseline.test.tsx` 增加「App 选择器里没有 `messages`」。
  **变异自证**：①订阅回调改成 no-op ⇒ 自动保存三条红；②把 `messages: s.messages` 加回 App 选择器 ⇒ 源码口径红。
- 影响范围说明（如实）：`ChatPanel` 仍然订阅 `messages` —— 它**必须**随流式更新才能显示文字；
  这一轮消掉的是「外壳跟着流式重渲染」这部分，不是「消息列表渲染」本身。

### 3J.5 运行层复测与一处探针更正

- 新构建爬取 **261 次点击 / 0 console.error / 0 未捕获拒绝 / 0 空白浮层**；
  测试会话里点会话行切换：4 条 → 0 条（空会话）→ 切回 4 条且标记仍在（`E2E-203988`）。
- 整页 reload 后助手消息与点赞状态仍在（持久化探针 `ok: true`）。
- **上一轮那个 65 条「死点击」是探针假阳性**，不是产品缺陷：爬虫每轮都会点「新建会话」，
  开发库攒到 174 个空会话；两个空会话互切时正文完全相同，而当时的 DOM 指纹不含「选中态」。
  已修探针（指纹加入当前选中会话/页签标题；「新建会话/新建项目」这类会创建实体的按钮改为跳过），
  复跑回到 **5 条**（都是窗口控制等已知的假阳性）。

### 3J.6 读数

- `tsc --noEmit` 0；全量测试 **10311 passed / 18 skipped / 991 files / 0 failed**；
- `scan-ui` 0 error / 0 warn、knip 46/46·30/30、可达性通过、上报点分诊 314=314=314；
- 新增判据文件：`domain-write-events.test.ts`、`session-autosave-subscription.test.tsx`，
  以及三处既有判据的锚点更新（`console-noise`、`feature-context-fixes` FC-I1b、`session-unread-badge` UNREAD-8）
  —— 三处都是「实现搬家、意图不变」，注释里写明了为什么改锚点。

### 3J.7 仍未做 / 已知边界

- **`ChatPanel` 流式重渲染**：它必须重渲染才能显示新文字；要再降只能把消息列表拆成独立订阅的子树
  （`MessageBubble` 已 memo、合并对象已按内容缓存，单次成本已经很低），属结构性重构，留待需要时再做；
- **arm64 真机**仍未验证；
- **运行层 IPC 计数**受 `__TAURI__.core` 冻结限制，无法在前端实现（要做得改 Rust 侧计数）。

### 3K. 第 7 轮续：把「剩余成本」也量出来，并补掉两处遗留死键（2026-11-20）

#### 3K.1 `ChatPanel` 流式重渲染：**量了，决定不做结构改造**

第 7 轮把 App 从 `messages` 订阅里摘掉后，唯一还在随流式重渲染的是 `ChatPanel`（它必须跟着新文字更新）。
但「还要不要继续拆」不该靠猜 —— 用一个 React `Profiler` 基准量了一下（临时脚本，未入库）：

| 场景 | commit 数 | 平均 commit | 最大 commit |
|---|---|---|---|
| 200 条消息挂载 | 5（含 effect 往返） | — | 109ms（仅挂载） |
| 流式追加 10 次（每次整条消息变） | 34 | **1.80ms** | 6.14ms |

流式 flush 间隔是 **100ms**，1.8ms ≈ 1.8% 的单核占用 —— 而把它拆成"独立订阅的子树"要动
滚动锚定、回合边界、虚拟化窗口三处（这三处都有判据钉着），收益 < 风险。
**结论：不做；并把这条测量写在这里**，免得下一个人再凭"看起来重"去重构。

#### 3K.2 两处遗留死键 / 静默失败（第 5 轮审计里 agent 标注"未做"的两条）

| 位置 | 现象 | 修法 | 判据 |
|---|---|---|---|
| `SettingsPanel` 的 `<PersonaManager onClose={() => {}} />` | 内嵌「人设」面板的关闭 X 是空函数（与 ToolManager/AgentManager 同型，那两处上一轮修了、这处漏了） | 改成 `setActiveTab("general")`（与兄弟面板一致） | `ui-feedback-and-dead-keys.test.tsx` B7-c |
| `ProjectManager.handleImport` | 无 `try/catch`：导入失败的 reject 没人接 ⇒ 弹窗不关、零提示 | 补 `try/catch`，复用同一块 `project-action-error` 横幅，文案「导入项目失败：…」 | 同文件 A1-d |

两条都做了变异自证（把修复改回去 ⇒ 对应判据红）。

#### 3K.3 本轮读数（追加）

- `tsc` 0；全量测试见提交前最后一条记录；`scan-ui` 0/0；
- `ui-feedback-and-dead-keys.test.tsx` 从 15 条增到 **17 条**（B7-c、A1-d）。

### 3L. 第 7 轮续：写入/命令类工具的端到端取证（前几轮没自动驱动到的面）（2026-11-20）

前几轮的端到端只覆盖了只读工具（glob/ls）。这一轮补了**会改文件、会跑命令**的两条：

| 探针 | 结果 |
|---|---|
| `write` 工具 | 助手回复「✅ 已完成：用 write 工具把 `<mark>` 写入 e2e-perm-test.txt（17 字节）」，文件在应用工作区里**确实存在且内容逐字一致**；读回校验也由模型自己做了（「与要求一致」） |
| `bash` 工具 | 命令输出里出现 `<mark>`，说明真的执行了；全程 0 console.error / 0 未捕获拒绝 |

两条都在开发实例（`.preview-shot/unslop/data-home`）上跑；**权限弹窗没有出现** ——
该实例的权限预设直接批准了这两类调用。也就是说：`PermissionDialog` 的**渲染与批准路径**
这一轮仍然没有被端到端覆盖（它由组件级判据守着，见 `v1.5.2-full-regression.test.ts` 的 J2 与
`permission-*` 系列）。要真机覆盖得把预设切到「严格」再跑一次，这一步留待下一轮（如实记账）。

#### 探针自身修掉的两个取样错误（不然会诬告产品）

1. **工作区路径**：开发实例的工具工作区是 `.preview-shot/unslop/data-home/workspace`，
   不是仓库根 —— 第一版探针去仓库根找文件，报「没写成功」，而模型其实写对了；
2. **回合开始时机**：Enter 之后约 1s 才进流式，第一版探针「没在流式 ⇒ 当作结束」，
   在回合刚开始时就去读结果，必然读到旧内容 ⇒ 假失败。现在先等流式开始（最多 20s）再判定。

另外，探针里用来判断"还在流式"的停止按钮选择器在本仓 UI 下**匹配不到**（`streamingStarted` 一直为 false）——
它不影响结果判定（判定看文件内容 / 命令输出），但这一条也记下来，免得下一个人以为流式状态没生效。

## 3M. 第 8 轮：把「仍未做」的三件做完（审批链路 / 运行层计数 / arm64 取证）（2026-11-20）

### 3M.1 审批链路端到端（之前唯一没有端到端证据的交互面）

**为什么之前看不到审批**：开发实例的安全模式是「完全访问」，且 `请求批准` 模式下**新建**文件也不问；
只有**覆盖已有文件**才触发审批。本轮按这个口径设计探针：

| 步骤 | 读数 |
|---|---|
| 预置 `e2e-approval.txt`，让模型用 `write` 覆盖它 | 出现 `inline-diff-review` 面板（截图 `permission-dialog*`），按钮：`批准 / 拒绝 / 全部批准 / 自定义` |
| 点「批准」 | 文件内容变成新值（逐字校验）；面板消失；回合继续 |
| 再覆盖一次，点「拒绝」 | 文件**保持原内容**（逐字校验）；助手回复里明确说明被拒绝 |
| 全程 | 0 `console.error`、0 未捕获拒绝 |

判据落在**文件系统 + 面板文本**上，不是"点到了按钮"就算过。截图：
`.preview-shot/unslop/e2e/approval-dialog.png`、`approval-dialog-deny.png`；
结构化结果 `approval-e2e-result.json`（`ok: true`）。

### 3M.2 运行层 IPC 计数（之前说"受 `__TAURI__.core` 冻结限制做不了"的那件）

**做在哪**：`src-tauri/src/storage.rs::storage_invoke` —— **所有仓储命令的唯一入口**，
在宿主进程里按命令名累加；新增两条**特例命令**（不进 `codem-db` 的 dispatch）：
`ipc_stats` / `ipc_stats_reset`。渲染侧 `invoke("storage_invoke", {command:"ipc_stats"})` 即可读。

- Rust 单测 `storage::tests::ipc_stats_counts_and_resets` 守住"累加 / 排序稳定 / reset 清零"
  （恒 0 的计数器最容易骗人，所以先证它真的会动）。
- **真机读数**（重编译二进制后重启开发实例，探针 `_e2e-ipc-stats.mjs`）：
  - **空闲 15 秒：0 条仓储命令**（`total: 0`）—— 侧栏/水位改成事件驱动的直接证据；
  - 一个普通回合：**25 条**，分布 `crud.upsert 5 / crud.list 4 / events.append 4 / fts.upsert 3 /
    messages.upsert_index 3 / settings.set 3 / events.append_batch 2 / settings.remove 1` —— 没有风暴。
- 结果：`.preview-shot/unslop/e2e/ipc-stats.json`（`ok: true`）。

⚠️ 口径说明：域镜像就绪后，`domainReadMany` 读的是**内存镜像**，本来就不产生 IPC。
所以这个计数证明的是"空闲没有 IPC 风暴"，**不是**"侧栏省下了 N 次 IPC"；
侧栏/水位省下的是**镜像扫描与消息解析**的 CPU（那部分由单元基线 + 变异自证守着，见 §3J）。

### 3M.3 arm64：能做的做完，不能做的说清楚

| 事项 | 结果 |
|---|---|
| debug arm64 包 | `flutter build apk --debug --target-platform android-arm64 --split-per-abi` → `app-arm64-v8a-debug.apk`（264 MB，只含 `arm64-v8a`） |
| release arm64 包 | `--release --split-per-abi` → `app-arm64-v8a-release.apk`（**77 MB**），`libarm64-v8a/{libapp.so,libflutter.so}` **全部 AArch64 ELF**（`libapp.so` 8 MB 是 AOT 产物） |
| arm64 模拟器 | **不可能**：`FATAL | Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host`（实测输出原文） |
| 真机 | 无 arm64 设备可用 |

**本轮还查出一条真问题（比"没硬件"更值得记）**：
`mobile/android/app/src/main/jniLibs/` 只有 **x86_64** 的本机 Host 可执行文件
（`libproot.so` / `libproot_loader.so` / `libcodem_db.so` / `libnode.so`），`assets/abi.txt` 也写着 `x86_64`。
⇒ arm64 设备上 Flutter 界面能跑，但「本机 Host（PRoot/Ubuntu）」不可用。
**好在这条有明确的失败路径**：`LocalHostRuntime.installExes` 会抛
「APK 未包含 libproot.so（设备 ABI：arm64-v8a），请安装匹配 ABI 的安装包」——
不是崩溃、不是静默失败（代码里已有该判据式的提示）。

**要真正支持 arm64 还差**：交叉编译 aarch64 的 proot/proot_loader、aarch64 Android 的 node、
aarch64 的 `codem_db`，放进 `jniLibs/arm64-v8a/`；本机没有这套交叉工具链，**本轮不假装做了**。

### 3M.4 读数

- `tsc` 0；前端全量测试见提交前最后一条记录；Rust `cargo test --lib ipc_stats` 1 passed；
- `storage-command-parity` / `no-sync-mirror-reads` 全绿（新增特例命令不影响命令契约）；
- 新增探针：`_e2e-approval.mjs`、`_e2e-ipc-stats.mjs`、`_check-arm64-apk*.cjs`（都在 `.preview-shot/`，不进仓库）；
- 结构化证据：`.preview-shot/unslop/e2e/{approval-e2e-result.json,ipc-stats.json,arm64-*-check.json}`。

## 3N. 第 9 轮：排版事故的**系统性**排查与修复（挤压 / 竖排 / 静默裁切 / 文字间距）（2026-11-20）

用户现场：任务管理 → 子智能体 的状态条被压成一列（`1/0/6/0/0` 竖排），并指出「大量页面存在
要素挤压、换行与文字间距问题」，问「之前不是深度排查吗」。

### 3N.1 为什么之前会漏（先说清原因，再说修法）

之前的"深度排查"只有两层，**都不量排版**：

| 层 | 它查什么 | 为什么漏掉这次的问题 |
|---|---|---|
| `tools/ui-audit/scan-ui.mjs` | 源码级 token / 颜色角色 / 样式字面量 | `grid-template-columns: repeat(auto-fill, minmax(48px, max-content))` 是**合法 CSS**，lint 无感 |
| `.preview-shot/_crawl.mjs` | console 错误、死点击、空白浮层 | 挤压/竖排**不报错、不溢出控制台**，DOM 指纹甚至不变 |
| 人工走查截图 | 1440/1600 宽的主界面 | 只在**特定宽度**暴露：状态条在 1179px 时被 `auto-fill` 拆成 **23 条 40px 窄列** |

所以漏的不是"没查"，而是**没有几何判据**。这一轮补的就是这一层。

### 3N.2 新增：运行时布局审计 `tools/ui-audit/layout-audit.mjs`

CDP 驱动，导航 37 个场景（主界面 / 任务管理 8 个页签 + 子智能体两个子视图 / 5 个管理器 /
设置 24 个页面），用 `getBoundingClientRect` + `getComputedStyle` 量真实排版：

| 判据 | 抓什么 |
|---|---|
| R1 | `grid` 轨道 ≥5 而子元素 ≤4 ⇒ `auto-fill` 把一行拆成很多空列（本次的元凶形态） |
| R2 | `flex-direction: row` 的容器里子项**同 x 不同 y** ⇒ 本该横排的被挤成竖排 |
| R3 | 短标签（≤20 字、块级）被折成 ≥2 行 |
| R4 | `overflow:hidden` 且内容超出 ⇒ 静默裁切（已排除省略号/line-clamp/内层滚动容器） |
| R5 | 极窄/极矮但有文字的盒子（阈值已按实测定过） |
| R6 | 字距/行距离群（`letter-spacing` 比例、多行 `line-height < 1.15`） |
| profile | 每页的文字间距画像（字号 × letter-spacing、字号 × 行高比），用于跨页比较 |

用法：`npm run audit:layout`（默认 9224 / 1600×900），`--width=1100` / `--shots=true` / `--only=settings`。
产物在 `.preview-shot/unslop/layout-audit/`（不进仓库）。

### 3N.3 查出来并修掉的 6 个根因（每个都有前后读数）

| # | 位置 | 病 | 修 |
|---|---|---|---|
| 1 | `.lo-task__bar`（任务管理状态条，**用户截图那一处**） | `repeat(auto-fill, minmax(48px, max-content))` ⇒ 1179px 宽时 23 条轨道、每个子项独占一列；高度 108px、计数竖排 | 改 `display:flex; flex-wrap:nowrap`；`.lo-task__meta` 不换行、超宽横向滚动；时钟 `margin-left:auto`。修后：**一行 45px**，计数横排 |
| 2 | `.sp-slider-row`（设置 → 宠物 的「宠物大小 40%」） | 被误并进 `.kg-legend` 的 grid 选择器组（多行逗号组），滑块行变成 8 条 96px 轨道 ⇒ 标签/数值折行 | 从该组移除，保留它自己的 `display:flex; space-between` |
| 3 | `.lo-align`（子智能体 → 设置 的对齐预览） | 同一 `auto-fill` 形状：1280 宽实测 **6 条轨道 / 2 个子项**，220px 预览塞进 48px 列 | 改 flex-wrap |
| 4 | `.memory-item-header/key/badges`（记忆管理器） | 1280 宽时徽标组把标题挤到 ~100px，**13 条标题折成两行**；徽标自己竖排 3 行 | 标题 `flex:1; min-width:0; ellipsis; nowrap`，徽标组 `flex:0 0 auto; nowrap` |
| 5 | `.mc-entry-content`（设置 → 记忆体检） | `max-height:4em; overflow:hidden` **静默切掉正文**，没有任何"还有下文"的提示 | 两行 `-webkit-line-clamp`（有省略号），展开态还原 |
| 6 | `.usage-chart-bar-tooltip`（设置 → 用量统计） | 首/末柱的气泡绝对定位越出卡片 36px，被 `overflow:hidden` 裁掉（`scrollWidth 845 > 809`） | 首柱 `left:0`、末柱 `right:0`，不再居中溢出 |

### 3N.4 文字间距：量化结论

对 37 个场景收集了「字号 × letter-spacing / 字号 × 行高比」画像：

- **letter-spacing 全部是 `0px`**（没有页面在正文字距上乱来）；
- 行高比集中在 **1.50**（11/12/13px 正文）与 **1.70**（14px），个别 1.20 只出现在**按钮/链接**（正常）；
- 所以用户感知到的"文字间距问题"，在报告中这三处都能对应上**具体的挤压/裁切**：
  状态条竖排（1）、滑块行折行（2）、记忆条目两行挤压 + 正文静默裁切（4、5）。
  修完之后同一套画像保持不变（没有为了"看起来松"去动全局字距）。

### 3N.5 防回归：源码判据 `src/test/layout-regressions.test.ts`（7 条）

R1 那种形状在源码里"合法"，所以要把**根因形状**钉住：

1. **LAYOUT-1**：全仓 CSS 里不许再出现 `grid-template-columns: repeat(auto-fill, … max-content)`
   （允许清单：`.identity-emoji-grid` / `.bootstrap-emoji-grid` / `.lo-zone-occupants` —— 都是
   "很多等宽小格子、允许换行"的语义，注释里写了理由）；
2. LAYOUT-2：`.lo-task__bar` 必须 flex 单行；`.lo-task__meta` 必须 `nowrap`；
3. LAYOUT-3：`.sp-slider-row` 不许再出现在 `.kg-legend` 的 grid 选择器组里；
4. LAYOUT-4：记忆标题必须 `ellipsis + min-width:0`，徽标组必须 `nowrap`；
5. LAYOUT-5：记忆体检正文必须 line-clamp，且不许再写死 `max-height:4em`；
6. LAYOUT-6：用量图表首/末柱的气泡必须贴边；
7. LAYOUT-7：审计工具必须在仓库里，且 `npm run audit:layout` 可直接跑。

**变异自证**：把 `.sp-slider-row` 加回 grid 组 ⇒ LAYOUT-3 红；把 `.lo-task__bar` 改回 grid ⇒
LAYOUT-1 + LAYOUT-2 同时红；还原后 7/7 绿。

### 3N.6 读数

| 宽度 | 场景数 | R1/R2/R4（硬性） | 结论 |
|---|---|---|---|
| 1100×760 | 37 | **0** | 通过 |
| 1280×800 | 37 | **0** | 通过 |
| 1600×900 | 37 | **0** | 通过 |

（R3/R5/R6 的阈值按实测调过：行内代码跨行、`|`/`·` 分隔符、`1h` 这类计时都属正常，已排除并写进工具注释。）

**为什么这次能保证"全面"**：不是再截几张图看，而是把「每个页面 × 三个宽度」都跑成可数判据；
再加 7 条源码闸门，防止同类形状被写回来。仍有边界（如实记）：审计只覆盖**可导航到的页面**，
弹窗里的二级状态、hover/focus 态、以及 900px 以下的窄窄屏还没跑。


### 3N.7 补充（同日第二轮）：把覆盖面再扩一圈后新增的两个根因

第一版审计的 37 个场景只覆盖了「导航到的页面」，**弹窗里的一级状态**还没跑。扩了 4 个场景
（插件管理弹窗 / 搜索浮层 / 文件菜单 / 笔记本工作区）后，在 1280 宽又抓到两处：

| # | 位置 | 病 | 修 |
|---|---|---|---|
| 7 | `.ofm-compact-badge`（插件管理 → 免费模型卡片） | 长插件名把「外部服务」徽标挤成两行（「外部服 / 务」） | 徽标 `flex:0 0 auto; nowrap`，名称 `min-width:0; ellipsis; nowrap` |
| — | `notebook-workspace` 的终端区域 | 审计把 xterm 的字符网格当成了「字距异常」（`letter-spacing:2.4px` 是终端自己算的） | 属于**审计的误报**：R6 排除 `.xterm` 子树，工具注释写明理由 |

截图：`layout-audit/shots/dialog-plugins.png`（修前可见徽标折行），修后同一场景 0 违规。
场景总数 37 → **41**，三档宽度（1100/1280/1600）复跑：R1/R2/R4 与 R3/R5/R6 **全为 0**。

## 3O. 第 10 轮：arm64 交叉编译链 + arm64 宿主包（把「仍未做」的最后一条做掉）（2026-11-20）

§3M 的结论是「arm64 包能构建，但 `jniLibs` 只有 x86_64 宿主二进制 ⇒ 真机上的本机 Host 不可用；
要补 aarch64 的 proot/node/codem_db」。本轮把它补齐并**在 arm64 上真的跑起来**（QEMU 容器内）。

### 3O.1 交叉编译链（本次安装）

| 组件 | 版本 | 说明 |
|---|---|---|
| rust target | `aarch64-unknown-linux-gnu` | 产物在 arm64 Ubuntu rootfs 里跑（glibc） |
| **zig** | **0.13.0**（`C:\dev\zig-dl\zig-windows-x86_64-0.13.0`） | 当交叉链接器；zip 的 sha256 与官方 `index.json` 逐字一致 |
| **cargo-zigbuild** | **0.24.1** | 把 `--target` 交给 zig；Windows 上不需要 aarch64 sysroot |

为什么用 zig 而不是 `gcc-aarch64-linux-gnu`：本机没有 WSL 发行版，Windows 上也没有 aarch64 sysroot；
zig 自带 glibc 的 crt/libc 桩，一条命令就能产出可执行的 aarch64 ELF。

### 3O.2 工具与产物（都在仓库里，可复跑）

- 新增 [`tools/mobile/build-db-arm64.mjs`](tools/mobile/build-db-arm64.mjs) + `npm run db:build:arm64`：
  内部 `cargo zigbuild --target aarch64-unknown-linux-gnu`，`CARGO_TARGET_DIR=.linux-target`，
  **自检**产物是 ELF64/AArch64 且解释器为 `/lib/ld-linux-aarch64.so.1`（不是只看命令退出码）。
- 组装：`node android-shell/build.mjs --abi arm64` → `node mobile/android/tools/stage-local-host.mjs --abi arm64`
  → `flutter build apk --release --target-platform android-arm64 --split-per-abi`。
- 产物：`app-arm64-v8a-release.apk`（**117 MB**），其中
  `lib/arm64-v8a/`：`libapp.so`(8.4MB) / `libflutter.so`(157.7MB 解压) / `libnode.so`(112.1MB) /
  `libcodem_db.so`(3.0MB) / `libproot.so` / `libproot_loader.so` —— **全部 AArch64**；
  `assets/rootfs.tar` 101.8MB（arm64 Ubuntu 24.04）、`assets/abi.txt` = `arm64`。

### 3O.3 运行时验证（真 arm64 指令，Docker + QEMU binfmt）

`android-shell/verify-arm64.sh`（仓库里原有的脚本，本轮第一次真的跑通）：

```
docker run --rm --platform linux/arm64 -v C:\mimo-gui:/work -w /work \
  ubuntu:24.04 bash /work/android-shell/verify-arm64.sh
→ NODE_OK / APKDB_OK / LINUXDB_OK
→ HOST_OK hostId=host-706b6462 session=host-… count=1（APK 里的 db）
→ HOST_OK hostId=host-75786462 session=host-… count=1（交叉编译的 db）
→ ARM64_QEMU_RESULT=PASS
```

- `HOST_OK` 走的是真实 RPC：`host.hello` → `session.create` → `session.list`，不是「进程活着」；
- 另测 `codem-db init/health/counts`：59 张表、fts5、WAL、`ready:true`；
- 即：**arm64 node + host.mjs + codem-db 三者真的能一起工作**，且 APK 里那份 `libcodem_db.so` 同样能跑。

### 3O.4 边界（如实记）

1. **PRoot 本体没在容器里跑**：它是 Android bionic 链接（`/system/bin/linker64`），容器没有 bionic；
   只能核对 ELF/解释器与依赖（`libtalloc.so.2` / `libandroid-shmem.so` 都是 AArch64 且随包）；
2. **Android 沙箱/exec 策略、WebView、厂商保活**仍需 arm64 真机（x86_64 宿主上的 emulator 明确拒绝 arm64 镜像：
   `FATAL | Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host`）；
3. `stage-local-host.mjs` **一次只放一个 ABI**：本轮验证完已恢复 x86_64 stage（模拟器工作流不受影响）；
   arm64 产物留档 `.preview-shot/arm64/app-arm64-v8a-release.apk`（不进 git）。

### 3O.5 文档

- [`mobile/android/LOCAL_HOST_CONTRACT_ADDENDUM.md`](mobile/android/LOCAL_HOST_CONTRACT_ADDENDUM.md) 新增 §9：
  工具链、可复跑命令、APK 逐项 ELF 表、验证结果、边界。
- 至此 §3M 的第 3 条（arm64 只差宿主二进制）**已闭环**，剩余的唯一缺口是「arm64 真机上的 PRoot/Android 行为」。

## 3P. 第 11 轮：搜索框「底色溢出 + 宽度不够」与同一类「内层控件逃出容器」（2026-11-20）

用户现场（设置 → 高级 截图，红框）：左侧栏搜索框的灰底**溢出到胶囊边框外**、宽度也不够。

### 3P.1 根因（两条规则叠加，都是"毯式"覆盖）

1. `unslop-v2.css` 有一条「设置里**所有**输入框都染成 raised 底」：
   `[data-ui="v2"] .settings-panel :is(…, input[type="text"], …) { background: var(--ui-surface-raised); border-radius; }`
   特异度 **(0,3,1)**，压过了 `.settings-side-search .sp-search-input`（0,2,0）里的 `background: transparent`。
   搜索框是「**胶囊里嵌裸输入框**」的形态 ⇒ 输入框自己的底/圆角/高度一旦生效，就盖在胶囊边框上。
2. 该输入框被撑到 **38px**，而胶囊只有 **30px** ⇒ 上下各溢出 4px；再叠上底色，就是截图里的「灰块越过边框」。
3. 宽度观感「不够」也是同一件事：内层块比胶囊窄、又偏右（图标+间距之外的部分被底色填成一条），视觉上像两截。

### 3P.2 修法

- 那条毯式规则排除 chrome-less 输入框：`input[type="text"]:not(.sp-search-input)`；
- 胶囊与裸输入框的分工写死：`.settings-side-search { overflow: hidden }`；
  `.settings-side-search .sp-search-input { height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; }`。

### 3P.3 顺藤摸瓜：新增 R9 判据，再抓出 4 类同源问题

在布局审计（`tools/ui-audit/layout-audit.mjs`）里新增 **R9「子元素从父容器溢出」**：
父容器有边框/底色、`overflow: visible`、子元素是**静态定位**却比父容器大 >1.5px ⇒ 记违规。

三档宽度跑 41 个场景，R9 抓到 13 处，归并为 4 个根因（全部修掉）：

| # | 位置 | 病（实测） | 修 |
|---|---|---|---|
| 1 | 设置 → **安全** 的三个模式卡片 `.sp-mode-btn` | 被「设置里所有按钮统一 28px 高」压成 28px，而卡片内容是标题+说明 ⇒ **说明文字溢出卡片 32~44px**（视觉上文字压在下一行上） | 按钮高度规则排除卡片类（`.sp-mode-btn` / `.skin-card` / `.lo-session-card` / `.lo-scene-option`），高度按内容走（实测 74px，说明回到卡片内） |
| 2 | 设置 → **外观** 皮肤卡片 `.skin-card` | 同一条规则 ⇒ 预览图+名称+说明溢出 24px | 同上 |
| 3 | 任务管理里的 `.lo-session-card` / `.lo-scene-option` | 同一条规则的另一处作用域（弹窗/任务中心）⇒ 会话卡片溢出 12px、场景缩略图溢出 33px | 同一排除列表（两处毯式规则都加） |
| 4 | 技能/智能体工具栏「＋ 新建」`.agent-new-btn` | v2 把 `.market-skill-link-btn` 统一成 **28×28 正方形**（本意是纯图标按钮），但这个是**带文字**的 ⇒ 内容 36px 塞进 28px，图标向左溢出 4px | 正方形规则排除 `.agent-new-btn`；带文字按钮 `width: auto; padding: 0 var(--space-4); gap` |
| 5 | 设置 → **记忆体检管理器** | 统计×2 + 提示×3 + 待批准条 + 批次区 加起来比弹窗高，而列表区是 `flex:1` ⇒ **高度被压成 0**（列表整块不可见，内容从容器溢出） | 管理器 `overflow-y: auto`；列表区 `flex: 0 0 auto; height: clamp(300px, 46vh, 560px)` |

（第 5 条是"内容溢出"的另一面：不是子元素盖到外面，而是被压成 0；R9 的兄弟判据把它抓出来。）

### 3P.4 防回归（源码判据，全部变异自证）

`src/test/layout-regressions.test.ts` 新增 4 条：

- **LAYOUT-9**：毯式输入框规则必须 `:not(.sp-search-input)`；侧栏搜索输入框必须 `background: transparent` + `height: 100%`；胶囊必须 `overflow: hidden`。
  *变异*：把 `:not(.sp-search-input)` 删掉 ⇒ 红。
- **LAYOUT-10**：**两处**按钮高度规则（设置面板 / 弹窗+任务中心）都必须排除四类卡片。
  *变异*：删掉设置面板那条的排除列表 ⇒ 红。
- **LAYOUT-11**：正方形图标规则必须排除 `.agent-new-btn`，带文字按钮必须 `width: auto`。
- **LAYOUT-12**：记忆管理器必须可纵向滚动；列表区必须有 `height: clamp(` 且不许再 `flex: 1`（防止又压成 0）。

### 3P.5 读数

- 布局审计 **41 场景 × 1100/1280/1600 三档宽度**：R1/R2/R3/R4/R5/R6/R9 **全部为 0**；
- 修后截图：`settings-search-after.png`（单层胶囊，底色不再越界）、`security-mode-after.png`（模式卡片 74px，说明在卡内）；
- `scan-ui` **error 0 / warn 0**（过程中引入过一次 `css-class-duplicate`：我先把新规则追加成第二条 `.memory-manager`，已改为并入原规则 —— 这条门禁正好抓住了"补丁式追加"的毛病）；
- 全量测试 **10325 passed / 18 skipped / 992 files**；`tsc` 0；CSS 契约快照按有意改动更新（5+/2−）。

### 3P.6 这类问题的通用教训（写在这里，避免下次再犯）

1. **"毯式"覆盖（`[data-ui=v2] .settings-panel :is(input, button…)`）必须显式列出例外**：
   搜索框、卡片按钮这类"非标准控件"一旦被统一尺寸/底色命中，表现就是"颜色溢出/宽度不够/文字被压"。
2. 写控件样式时**先决定谁负责画外壳**：胶囊负责底/边框/圆角，内层只负责文字与光标；
   内层一旦也画底，就会在圆角处露出第二层。
3. **高度要"按内容"还是"统一"必须落到语义类名上**：卡片有 `.sp-mode-btn` / `.skin-card` 之类的名字，
   毯式规则就用 `:not()` 把它们排掉；不要指望"暂时没被扫到"。
4. 新补丁**并进已有规则**，不要追加同名顶格规则（scan-ui 的 `css-class-duplicate` 会红）。

## 3Q. 第 12 轮：把「没覆盖的状态」补齐 —— 二级页签 / hover / 键盘焦点 / 详情态 / 浮层 / 最小窗口（2026-11-20）

上一轮留了一句边界：「hover/focus 态、弹窗二级状态、900px 以下还没进自动化」。
本轮把这四类**全部**并进审计，并修掉它们挖出来的问题。

### 3Q.1 审计能力扩展（`tools/ui-audit/layout-audit.mjs`）

| 能力 | 做法 | 覆盖 |
|---|---|---|
| **二级页签** | 自动发现可见的 `[role=tab]` / `.sp-tab` / `.settings-subnav-pill` / `.usage-tab` / `.manager-tab`（排除侧栏/标题栏，最多 14 个），逐个点开再量 | 设置→高级 的 9 个页签、各管理器子导航、任务中心子页签 |
| **hover** | 每个场景取最多 8 个主内容区控件，`Input.dispatchMouseEvent` 真悬停，比较**元素自身 offset 尺寸**与**同父兄弟**的位移（按稳定 key 比较、跳过绝对定位、复现一次才记） | 新增 **R10**：hover 只许改颜色/阴影，不许改布局 |
| **键盘焦点** | 连按 Tab（最多 12 次），读 `:focus-visible` 的 outline 与最近的 `overflow:hidden` 祖先，判断环是否被裁 | 新增 **R11**：焦点环被裁 |
| **详情态** | manager/taskcenter 场景里点开第一张卡（`.market-skill-card` / `.memory-item` / `.notebook-card` / `.agent-card` / `.lo-session-card` …）再量 | 详情面板/编辑器 |
| **浮层** | 新增 3 个场景：模型菜单、斜杠命令、会话右键菜单；并新增 **R12**：浮层超出视口 | 菜单/气泡/下拉 |
| **最窄窗口** | 800×600（`tauri.conf.json` 的 `minWidth/minHeight` 就是它） | 之前只测到 1100 |

R1 也精化了：`auto-fit`（空轨道折叠成 0 宽）不再误报；卡片网格（子元素自带边框/底色、轨道 ≥100px）不算碎片化 —— 真 bug 是「裸文本 + 40~50px 窄轨道」。
R4 增加了「画布视口」豁免：绝对定位 + `transform` 的子层（场景图/缩放画布）被容器裁切是设计，不是文本被切。
R3 允许 `line-clamp` 的有界折行（有界 ≠ 挤压）。

### 3Q.2 修掉的问题（都是状态覆盖后才暴露的）

| # | 位置（状态） | 实测病象 | 修 |
|---|---|---|---|
| 1 | 设置→帮助 / 高级→恢复（二级页签） | `.recovery-panel .stat-cards` 是 `auto-fit`，R1 曾误报 —— 精化判据后确认布局正确 | 只改判据（不改样式） |
| 2 | 设置→高级 的模型菜单 / 插件市场「插件市场」页签 | 中文小标题带 `letter-spacing: 0.5px`（10~11px → 比例 0.05），汉字显得松散 | 模型菜单分组标题删掉字距；插件市场的中文标题改为 `zh ? 0 : 0.5` |
| 3 | 输入工具行（斜杠命令态 Tab） | 焦点环是**外扩**环，行是 `overflow:hidden` ⇒ 上下各被裁 ~2.5px | 改 inset 环；`outline: none !important` 压住 codem-ui 里两条外扩环规则（它们在同一元素上叠了两个环） |
| 4 | 右侧栏（Tab 到贴边控件） | 同上，环左侧溢出 7px 被裁 | 右侧栏可聚焦控件统一 inset 环 |
| 5 | 设置→外观 皮肤卡说明（800 宽） | 说明折两行且无界 | 两行 `line-clamp`（显式有界） |
| 6 | 任务中心 → 活跃时段卡（800×600） | 卡片 `max-height:320px` + body `overflow:hidden` ⇒ 底部数据**静默裁掉** | 三张统计卡 body 改 `overflow-y:auto` |
| 7 | 任务中心 子智能体→设置 操作行（900 宽） | 两个按钮各被压到 ~110px，「手动对位编辑器」折两行；小节标题「画面微调」也折行 | 操作行 `flex-wrap:wrap` + 按钮 `nowrap`；小节标题 `flex-wrap:wrap` + 提示 `nowrap` |
| 8 | 插件市场卡片页脚（1100 宽） | 「内置凭证管理（API key 存储）」被操作按钮挤成两行 | 页脚 `flex-wrap:wrap`；说明改为 `--note` 类 + 两行 clamp |
| 9 | 笔记本 工作区「摘要」小节标题 | 中文标题 0.5px 字距（R6） | 删掉该类的字距 |
| 10 | 任务中心总览 场景图（详情态） | R4 曾把「缩放画布的裁切」当文本裁切 | 判据豁免（见 3Q.1） |

### 3Q.3 防回归（源码判据）

`src/test/layout-regressions.test.ts` 新增 4 条，累计 **16 条**：

- **LAYOUT-13**：会裁切的容器（输入工具行 / 右侧栏）里，焦点环必须 `outline: none !important` + inset 环；
- **LAYOUT-14**：皮肤卡说明必须两行 clamp（`-webkit-` 与标准属性都写）；
- **LAYOUT-15**：三张统计卡 body 必须 `overflow-y: auto`（不许 `overflow: hidden`）；
- **LAYOUT-16**：审计工具必须带 R9/R10/R11/R12 与状态开关（子页签/hover/focus）—— 防止「以后又只测静态页」。

### 3Q.4 读数

| 宽度 | 场景数（含状态） | R1–R6 / R9–R12 |
|---|---|---|
| 800×600（最小窗口） | 44 场景 × (1 + 子页签 + hover + focus + 详情 + 浮层) | **0** |
| 900×700 | 同上 | **0** |
| 1100×760 | 同上 | **0** |
| 1280×800 | 同上 | **0** |
| 1600×900 | 同上 | **0** |

> 最终复跑（dist 为最终构建）：**800 / 900 / 1100 / 1280 / 1600 全部 0 违规**（含 R10/R11/R12）。

另有：`tsc` 0、`scan-ui` error 0 / warn 0、`css-contract` 快照按有意改动更新、全量测试见 §3Q.5。

### 3Q.5 追加两处（终轮复跑前发现）

| # | 位置 | 病 | 修 |
|---|---|---|---|
| 11 | 800×600 笔记本详情的输入工具行 | 行只有 69px，内容 129px ⇒ 右侧按钮被 `overflow:hidden` 裁掉 | `@media (max-width:900px)` 允许工具行换行（产品最小窗口 800，仍能操作全部按钮） |
| 12 | 弹窗关闭按钮里的 `.sr-only` | 1×1 屏读专用文本被 R4/R5 当「裁切/过窄」误报 | 审计对 `.sr-only` 豁免（设计如此，不是 bug） |

### 3Q.6 仍未覆盖（如实记，不再含糊）

1. **hover 只取每个场景前 8 个主内容控件、focus 只走 12 次 Tab** —— 不是全量穷举；如果某控件排在后面，仍可能漏；
2. **需要真实交互才能出现的二级弹窗**（写入覆盖时的 inline diff 审批、模型调用中的工具确认、拖拽中间态）没有场景：它们需要跑一次真实模型回合；
3. **800 以下（如 640）不在产品的最小窗口范围内**（`minWidth: 800`），未测；
4. 真机（Android / 桌面安装包）上的 WebView 字体度量与开发实例不同，本审计是 Chromium 开发实例口径。

## 3R. 第 13 轮：穷举 hover/focus + 真实模型审批弹窗（把最后两类边界压掉）（2026-11-20）

上一轮还留着两条边界：「hover 只取 8 个控件、focus 只走 12 次 Tab（采样不是穷举）」
与「真实模型回合才出现的审批弹窗没有场景」。本轮两条都压掉，并按用户要求用了**真实模型回合**。

### 3R.1 从「采样」到「按类名穷举」

| 能力 | 旧 | 新 |
|---|---|---|
| hover | 每场景取前 8 个控件（按类名+文字去重） | **按类名去重后穷举**（默认上限 80）：每类一个代表，仍用真实鼠标悬停，稳定 key 比较兄弟位移、复现一次才记 |
| focus | 连按 12 次 Tab（只能覆盖 tab 序列前 12 个） | **按类名穷举可聚焦元素**（默认上限 120）：先按一次 Tab 进入键盘模态，再逐个 `el.focus()` 读 `:focus-visible` 几何 |

实测覆盖量：单个场景 hover 15–22 个类、focus 19–25 个类（旧版分别是 8 与 12）。

### 3R.2 真实模型审批弹窗（新场景 `dialog-approval`）

流程（只在 `--real-model` 时启用，避免例行审计烧 token）：
1. 把安全模式切到**请求批准**（必须先切，再发消息 —— 第一次跑 NO-PANEL 就是顺序错了）；
2. 预置工作区文件 → 用 composer 发「覆盖写入」指令 → 等 `.inline-diff-review` 出现（最长 150s）；
3. **面板打开状态下**量布局（含 hover/focus 探针）→ 截图 → 点「批准」→ 恢复完全访问 → 删探针文件。

真实回合实测：面板出现、`dialog-approval` 基线 0 违规；顺带抓到并修掉 **1 个真问题**：
「思考」按钮（`.reasoning-toggle`）在 24px 高、`overflow:hidden` 的 `.reasoning-row` 里，焦点环上下被裁
→ 改 inset 环（R11 复测通过）。

### 3R.3 静态分析（子智能体）+ 它带出的修复

并行跑了一个只读子智能体，扫全仓 CSS 的 `:hover` 与 `:focus-visible`，产出 18 条 hover 风险、
12 条焦点环裁剪、2 条焦点反馈缺失。真正修掉的：

| # | 问题 | 修 |
|---|---|---|
| 1 | **特异度战**：全局兜底环 `:is(...[tabindex]):focus-visible` 是 **(0,3,0)**，各处 inset 修复只有 (0,2,0) 且无 `!important` ⇒ 外扩环被重新画出来再被容器裁掉 | 所有 inset 环统一加 `outline: none !important`；并把「已知会裁切的容器」收敛成**一条策略**：容器内可聚焦元素一律 inset 环（`.chat-body / .settings-body / .modal-editor / .task-center-panel / .notebook-manager / .terminal-drawer / .lo-task__content / .sidebar / .right-sidebar / .input-tools-left / .reasoning-row / .memory-list`） |
| 2 | 设置左侧栏搜索框**完全没有焦点指示**（input `outline:none`，胶囊无 `:has` 环） | `.settings-side-search:has(.sp-search-input:focus-visible)` 画 inset 环 + 边框色 |
| 3 | 笔记本管理器/终端抽屉的关闭按钮贴边，环被裁 | 已并入上面的统一策略 |
| 4 | 两处**悬空选择器列表**（尾部逗号 + 段落横幅注释）：`.message-paragraph-actions,` 把未读徽标样式并给了段落操作条；`.project-open-btn, .new-chat-btn, .sidebar-config-btn,` 把 `.chat-panel` 并进了按钮样式 | 删除 0 引用的悬空选择器；新增判据 LAYOUT-20 防复发 |
| 5 | 第三处悬空列表把 `html.pet-window-mode, html.pet-window-mode body,` 并进 `.guidance-messages-bar` | 补齐 pet-window-mode 的透明背景规则，隔离 guidance 样式 |
| 6 | `.lo-pixel-room` 外扩环被 `.lo-scene`（overflow hidden）裁 | 改 inset 环 |
| 7 | `.sidebar-user-me--clickable` 贴侧栏边，环被裁 | 改 inset 环 |

**判据新增**：LAYOUT-20（悬空选择器列表）、LAYOUT-21（裁切容器统一 inset 策略）、LAYOUT-22（全局环下 inset 必须 `!important`），累计 **22 条**。

### 3R.4 读数

**终轮（最终构建，穷举 hover/focus + R13）**：

| 宽度 | 场景（含二级页签 / hover 穷举 / focus 穷举 / 详情 / 浮层） | R1–R6 / R9–R13 |
|---|---|---|
| 800×600（最小窗口） | 44 场景 × 状态 | **0** |
| 900×700 | 同上 | **0** |
| 1100×760 | 同上 | **0** |
| 1280×800 | 同上 | **0** |
| 1600×900 | 同上 | **0** |

真实模型审批场景（1280，面板打开态）：dialog-approval **0 违规**（hover 23 个类 / focus 23 个类），
跑完安全模式恢复「完全访问」、探针文件已删除。

### 3R.6 审查驱动的补充修复（第二轮，同轮内）

把改动交给一个只读审查子智能体后，它找出 7 处问题（含 2 处既有判据变红、1 处真实双环、1 处选中态丢失），逐条修掉：

| # | 审查发现 | 修法 |
|---|---|---|
| 1 | `USERCLICK-197-4` 仍断言旧的 `outline: 2px solid var(--accent)` ⇒ 变红 | 断言更新为新的 inset box-shadow 契约（意图不变：键盘用户必须看得见），并注明为什么改成 inset |
| 2 | 删除悬空选择器后 `css-contract` 快照过期（31 条差异） | `node tools/ui-audit/css-contract.mjs --write` 重建快照 |
| 3 | 宽策略给 `.sp-search-input` 也上了 inset 环，压掉它自己的 `box-shadow:none` ⇒ 侧栏搜索框**双紫环** | 宽策略加 `:not(.sp-search-input)`；胶囊的 `:has` 环是唯一指示 |
| 4 | `.skin-card.active` / `.sidebar-project-btn.active` 的选中环是 box-shadow，会被 inset 焦点环顶掉 | 这两类改用**内嵌 outline**（`outline-offset: -2px`）画焦点：与 box-shadow 可叠加、不被祖先裁切 |
| 5 | R11 看到 `outline:none` 直接返回 `hasRing:false`，调用方只消费 `clipped` ⇒ 删掉 inset 也不红 | 新增 **R13**：可聚焦元素既无 outline、也无 box-shadow、祖先也没有环 ⇒ 「键盘焦点不可见」；同时支持 `forced-colors` 回退 |
| 6 | 审批场景：安全模式是持久化设置，失败路径会留在「请求批准」；清理写在 record 内、面板关闭后才跑 hover/focus；二级页签会重复 record | 抽出 `setSecurityMode`（切换 + 验证 + 3 次重试）、`cleanupApproval`（重复批准 → 等 `.run-status-bar` 消失 → 恢复模式 → 删文件）；失败路径也清理；审批场景不再展开二级页签；`try/finally` 保证清理 |
| 7 | LAYOUT-20 正则漏检/误报；LAYOUT-22 的 `continue` 会静默通过 | LAYOUT-20 改为**按大括号深度扫描**（只算深度 0 的逗号，声明里的多值不误报）；LAYOUT-22 改为「规则 + 其后 400 字符内必须出现 `outline: none !important`」，缺失直接红；新增 LAYOUT-23（选中环用内嵌 outline、宽策略排除三类元素） |

**真实模型场景的收尾实测**：跑完后安全模式恢复为「完全访问」、探针文件已删除（`file: False`）。

### 3R.7 边界（进一步收窄后仍存在的，如实记）

1. **hover/focus 按类名去重**：同一类里不同实例（内容长度、disabled 态）不会逐个覆盖；
2. **真实模型场景只有审批弹窗**：工具确认、失败重试、取消/中断这些弹窗还没做场景；
3. 侧栏行悬停「时间↔操作」互换是**有意的**（给操作让位），审计把侧栏排除在 hover 探针外；
4. 800 以下（640 等）不在产品最小窗口范围；
5. R13 用「祖先 3 层内有没有 box-shadow」判断“焦点反馈画在祖先上”，更深层的自定义指示器可能漏判。


## 3S. 第 14 轮：同类多实例 + 真实模型「工具错误 / 取消 / 工具确认」（2026-11-21）

上一轮留的两条边界是：① hover/focus 只按类名各测一个代表；② 真实模型场景只覆盖审批弹窗。
本轮都推进了，其中「工具确认」**没能在这个 dev 工作区触发**，如实记在 §3S.4。

### 3S.1 同类多实例（`--multi`）

同一个类不再只测一个代表，而是按 **disabled / 文本长度档（0,S,M,L）/ 宽度档（<120, 120–220, ≥220）** 再分变体。
宽度档是关键：同一类的卡片在不同栅格里可用宽度不同，折行往往只发生在窄档实例上。

实测覆盖增量（1280×800）：

| 场景 | hover | focus |
|---|---|---|
| `dialog-plugins`（插件市场，卡片长短不一） | 23 → **28**（+22%） | 26 → **30**（+15%） |
| `manager-skills`（同类卡片尺寸一致） | 25 → 26 | 27 → 28 |

### 3S.2 三个真实模型场景

| 场景 | 做法 | 结果 |
|---|---|---|
| `dialog-tool-error` | 让模型 `read` 一个沙箱外路径 → 量工具失败态（错误行 + 沙箱说明） | 真跑通，0 违规 |
| `dialog-abort` | 发长任务 → 流式中量一次（`dialog-abort::streaming`）→ 点 `.cancel-btn` 取消 → 再量停止态 | 真跑通，两种状态各 0 违规 |
| `dialog-tool-confirm` | 请求批准 + 危险命令（`rm -rf /tmp/...`）→ 等 `.permission-overlay` | **未触发**（见 §3S.4），场景记录失败证据后跳过，不伪装通过 |

### 3S.3 做这三个场景时踩到并修掉的工具缺陷

1. **提示词注入错误**：`sendPrompt` 把 `" + JSON.stringify(text) + "` 写进了 `evalJs` 的单引号串里，
   页面把这段当字面量 → 实际发出去的是 `JSON.stringify(text) +` 这行残片（模型直接指出“上游拼错了变量”）。
   改成 **Node 侧字符串拼接**注入，并加验证：composer 里必须是原文。
2. **合成 Enter 不可靠**：页面内 `new KeyboardEvent("keydown", …)` 在部分状态下不提交（消息停在输入框）。
   改成点 `.send-btn:not(.cancel-btn)`，失败再回退到 **CDP 真实键盘事件**；审批场景的 Enter 也换成真实键盘事件。
3. **没有面板时不再重复记录**：`dialog-tool-confirm` 未触发时原本会再记一条同名场景（量到的是已结束页面），
   现在用 `SKIP_SCENE` 跳过并只保留那条带 `note` 的失败记录。

### 3S.4 为什么「工具确认」没触发（证据，而不是猜测）

在 dev 工作区把安全模式切到「请求批准」（按钮文案已验证），发一条「用 bash 执行
`rm -rf /tmp/lo-nonexistent-probe-<ts>`」的指令。结果：

- 没有出现 `.permission-overlay`（90s 轮询）；
- 回合结束后模型自述「上一条 `rm -rf` 通过了」，并指出「只读的 Test-Path 反而被沙箱拒绝」；
- 同一会话里 `read /tmp/...` 被沙箱直接拒绝（有明确 Sandbox 文案）。

结论（当前可证）：在这个 dev 数据目录里，**危险 bash 没有走人工确认弹窗**，而是被沙箱/权限层直接处理。
可能原因（未证实）：项目级安全模式覆盖、或权限层的 always-allow 记忆。
因此本场景**保持失败记录**（`navOk:false` + note），等能复现时再补；不把它算成“已覆盖”。

### 3S.5 读数

| 宽度 | 模式 | 结果 |
|---|---|---|
| 1280×800 | `--multi`（全 44 场景 + 状态） | **0 违规** |
| 800×600（最小窗口） | `--multi` | **0 违规** |
| 1280×800 | 真实模型 `dialog-approval` / `dialog-tool-error` / `dialog-abort` | **0 违规** |

判据累计 **25 条**（新增 LAYOUT-24 多实例模式、LAYOUT-25 真实场景与失败证据）。

### 3S.6 边界（本轮之后）

1. 多实例的变体是**启发式分档**（文本长度/宽度），不是逐一实例穷举；同档内仍只测一个；
2. 「工具确认」弹窗在当前 dev 工作区复现不到，属于**记录在案的未覆盖**（§3S.4）；
3. 失败重试没有独立弹窗 UI，工具错误态由 `dialog-tool-error` 覆盖；
4. 取消只测了「停止后回到空闲」，没有测“取消后立刻再发一条”的竞态。

## 3T. 第 15 轮：安全闸门修复 + 取消后重发竞态（2026-11-21）

上一轮留了两条边界：「工具确认弹窗在 dev 工作区触发不到」「取消后立刻重发的竞态没测」。
按用户要求，这一轮不绕过去：先把触发不到的原因查清（三个只读子智能体并行调查），
再修根因、补场景、逐条做变异自证。

### 3T.1 为什么「请求批准」对 rm -rf 不弹窗（根因，两条同时成立）

| # | 根因 | 证据（修前） |
|---|---|---|
| 1 | `bash-analyzer.ts` 的 Unix 危险清单**只有注入/外联**类，没有任何删除命令 | `analyzeBashCommand("rm -rf /tmp/x")` → `write`；`evaluateWithBashAnalysis` 原样返回 `allow` |
| 2 | `PermissionEvaluator.evaluate()` 先问 agent registry，build agent 是 `{tool:"*", action:"allow"}` ⇒ 默认 6 条 bash 安全规则（rm -rf→ask、sudo→ask…）**是死代码** | 无 mock 时 `evaluate("bash","rm -rf /tmp/x","build")` → `allow`；仓库自己的测试注释也写着「规则表整体成了死代码」 |
| 3 | 沙箱只从命令文本抽盘符/UNC/`..`，**不抽 POSIX 绝对路径** | `read /tmp/x` 被拒（走 args.path），`rm -rf /tmp/x` 却放行 |
| 4 | 分析器抛错时 agentic-loop 只 `warn`，继续用 `allow` | fail-open；`isAutoApprovable` / `tool-gates` 都是 fail-closed |
| 5 | `terminal_send` 往 PTY 打字**没有审批通道**，也不做危险分析 | 模型可绕过 bash 权限层直接 `rm -rf` |
| 6 | 「始终允许」的记忆支持**通配**匹配；危险命令升级被它短路 | 一条 `rm -rf *` 的会话记忆能放行 `rm -rf /` |

另一个事实：审批面板早就改成了 `.decision-tray`（旧 `.permission-overlay` 是历史外壳）——
上一轮场景选不到它，也是「触发不到」的一部分原因。

### 3T.2 修法（每条都有判据）

| 修复 | 做法 |
|---|---|
| 危险命令识别 | 新增**按命令段分类**（`;` / `&&` / `||` / `|` / 换行），只在**命令位置**匹配；覆盖递归/强制删除（rm、del/rd、find -delete、rimraf、shred…）、git 数据丢失（clean -f、push --force、reset --hard、checkout .、branch -D、stash drop）、提权/关机/杀进程、Windows 磁盘/注册表/服务/账号命令、`> /dev/sdX`、fork bomb、PowerShell cmdlet（含 `powershell/pwsh -Command` 外壳与大小写混写） |
| 规则不再被 agent 短路 | `evaluate()` 改成「规则表与 agent 权限合并取最严格」：**deny > ask > allow**；硬拒绝（.git/.env/node_modules）优先于「始终允许」 |
| 危险命令只认精确放行 | 新增 `getExactAlwaysAllow()`；分析器升级危险命令时只认**命令原文完全一致**的会话记忆，通配条目不抑制升级 |
| 分析器失败 fail-closed | 抛错时把 `rawAction` 升级为 `ask`（与 tool-gates 一致） |
| 沙箱补 POSIX 路径 | 从命令文本抽取 `/tmp`、`/etc/...`、`/dev/...` 等；`/s`、`/q` 这类开关不误判 |
| 终端工具 | `terminal_send` 在 ask/auto 下复用 `refuseDangerousCommand`（无审批通道 ⇒ 直接拒绝并告诉模型改用 bash）；full 模式放行 |
| 场景选择器 | 审计认 `.decision-tray`（同时兼容旧 `.permission-overlay` / `.inline-diff-review`） |

### 3T.3 取消后立刻重发（真实竞态，已修）

调查结论：`handleCancel` 只调 `setStreaming(false)`，而 store 的 `isStreaming = activeSessions.size > 0`
⇒ 取消瞬间仍算「流式中」，`ChatPanel` 把下一条消息分流成 guidance；已取消的回合不会消费 guidance，
气泡被 `clearGuidanceMessages()` 清掉、文本只留在内存队列 → **消息发出去就没了**。

| 修复 | 说明 |
|---|---|
| 取消即清忙碌态 | `setSessionActive(id, false)` + `setStreaming(false)`；同时把挂起的审批/覆盖写确认 resolve 掉（deny/cancel），避免 Promise 永久悬挂 |
| guidance 兜底 | 没有在跑的回合 → 走普通发送；取消窗口（activeSessions 已清、引擎锁未释放）→ 等锁释放后普通发送；`sendGuidance` 返回 null 也兜底 |
| 忙锁等待 | 前台回合启动时若会话仍在执行，等最多 10s（正常取消是毫秒级），不再把刚取消的回合误判成「已有一轮在跑」 |
| 跨回合定时器 | 回合序号 `turnTokenRef` 守卫 2s 进度清理 / 2.5s 宠物卡归位，避免旧回合的定时器清新回合的状态 |

### 3T.4 验证

- 真实模型 `dialog-tool-confirm`：`.decision-tray` 真实出现并完成布局测量（0 违规），跑完恢复「完全访问」、无残留面板；
- 真实模型 `dialog-abort-resend`：取消后**不等空闲**立刻再发 → 连跑 2 次都起了新回合（navOk: true）；
- 新增判据：`DANGER-15`（19+ 条破坏性命令、复合命令、PS 外壳、误报锚定、规则不被短路、精确放行）、`CANCEL-15`（取消清态/审批收口/guidance 兜底/定时器守卫/忙锁等待）、`SHLEAK-3c/3d`（POSIX 路径、开关参数不误拦）、`LAYOUT-26`（审计认 `.decision-tray` 与重发场景）；
- 变异自证：删掉 rm 规则 → 5 条红；把 evaluator 的 ask/allow 顺序换回旧写法 → 红；删 `setSessionActive(false)` → CANCEL-15 红；还原后全绿；
- 全量 **10388 passed / 18 skipped / 994 files**；`tsc` 0；`scan-ui` 0/0；上报点 314=314=314。

### 3T.5 仍未覆盖 / 明确不做

1. `sandbox-acl.blockedCommands` 与 `sandbox-policy-provider` 的两份清单**没有生产调用者**（死清单）——第 15 轮已记录；第 16 轮已连同 6 个从未装配消费的沙箱插件一起删除；
2. `run_code` 的 `sdk.bash` 对危险命令**任何模式都拒绝**（没有审批通道），这是既有设计，未改成「full 放行」；
3. `terminal_send` 只分析 `submit=true` 的整行文本；分多次输入拼出的危险命令（先 `rm -r` 再回车）无法从单条文本识别；
4. 审批弹窗的真实模型场景只覆盖「危险 bash」与「覆盖写」两类；工具重试/取消后的审批收口只做了单元级验证；
5. 取消后**立刻**重发的窗口在真人手速下更宽，但自动化只在 1280 宽度、单会话验证过。

## 3U. 第 16 轮：删掉「从未被消费」的沙箱骨架 + 服务级可达性门禁（2026-11-21）

起因是第 15 轮结论里的一句「`sandbox-acl.blockedCommands` 与 `sandbox-policy-provider`
没有生产调用者」。追下去发现这不是「开发了功能后来废弃」，而是**插件化迁移时批量生成的
能力骨架，从第一天起就没有消费方**。

### 3U.1 取证：它们是怎么活下来的

| 时间/提交 | 事件 |
|---|---|
| `1800c627` v0.99.0 | 5 层工具管线落地，真实沙箱在 `tool-pipeline` 的 `SandboxGuard`（按工具契约 + 工作区路径） |
| `ef4bb9f2` v1.0.0 / `588b0c90` v1.3.0 | Cordis 插件化：把能力拆成 `src/core/provider/*`，沙箱拆成 6 个插件，只声明 `provides/inject` |
| `4bf486d0` v1.1.0 | `agentic-loop` 加了 `D2: Initialize process-level sandbox ACL guard` —— **只初始化、打日志、从不查询** |
| `3862b51d` v1.5.1 | YAML 声明式装配把 6 个插件写进 `config/codem.base.yml` ⇒ 启动时真的 apply、服务真的 provide，仍然零读取 |
| `e4a921f7` v1.9.7 | 插件市场把 3 条 dsh 沙箱包映射到内置插件，给了它**产品可见性** |

假信号有五层：① 文件级可达性门禁只看 import（provider 被注册表/YAML 引用 ⇒ 绿）；
② 单测直接 `new SandboxGuard()` 测 ACL 自己；③ 启动日志「Sandbox ACL initialized」；
④ `@ts-nocheck` + `ctx: any` 掩盖没有消费方；⑤ 市场目录/文档服务列表把它写成既有能力。

全仓测算（删除前）：195 个 `ctx.provide` 服务里只有 57 个有真实读取方；沙箱 6 个服务
（sandbox / sandboxPolicy / bashSandbox / fsSandbox / pwshSandbox / sandboxWindowsAcl）
读取方全部为 0（`sandbox` 的两个读取方本身也无人读，且 `exec` 签名对不上 ⇒ 从未执行过）。

### 3U.2 删除（A 路线）

- **保留**：`sandbox-acl.ts` 的开关判定（`isSandboxAclEnabled`，含 fail-open 处理）、
  允许目录（`getSandboxAllowedDirs` / `isWithinAllowedDirs` / `add` / `remove` / `normalize`）、
  路径规范化；这些被设置页、`SandboxAllowPrompt`、`tools` / `file-api` / `tool-pipeline` /
  `desktop-engine` / `handoff-sandbox` 真实使用。
- **删除**：`SandboxPolicy` / `SandboxCheckResult` / `createDefaultPolicy` / `createStrictPolicy` /
  `SandboxGuard`（ACL 类）/ `initSandboxGuard` / `initDefaultSandbox` / `getSandboxGuard` /
  `sandboxGlobToRegex` / 17 条 `blockedCommands` / 环境变量过滤；
  6 个 provider 文件；`builtin-registry` 6 条注册 + import；`config/codem.base.yml` 6 块；
  `plugin-registry-provider` 6 条目录元数据；`dsh-market-catalog` 3 条锚；`codem.yml` 1 条；
  `agentic-loop` 的死初始化；`core/llm/index.ts` 的 re-export；`service-types` 的 `SandboxService`。
- 测试：删除 8 个 ACL 内部文件/用例组；把「工作区外拒绝 / 工作区内放行」改写成
  **真实管线**断言（`READ-BOUND-1..3` + `functional-chain` Chain 5），并做变异自证
  （把管线守卫改成恒放行 → 新用例红）。
- `scripts/verify-package-invariants.ts`：区分运行时值与类型导出；退役
  `registerOutputContract` / `validateToolOutput` / `deriveMessagesFromEvents`；
  `core/storage` 门面补 `EventLog` / `getEventLog` / `EventProjection`。26/26 通过。

### 3U.3 用户状态迁移

旧版本的禁用列表里可能留着 6 个已删插件 id：界面会静默忽略（不炸），但用户下一次点开关
会把垃圾原样写回。`reconcileDisabledPluginsAtBoot` 增加**显式退役名单剪枝**
（`RETIRED_DISABLED_PLUGIN_IDS`），剪枝时用 `saveDisabledPlugins` 一次写完 DB + 戳 + 镜像 + 戳；
不做「未知即清」的通用过滤（降级/动态插件的合法未知 id 要保留）。

### 3U.4 新增门禁（防复发）

1. `tools/audit/scan-unconsumed-services.mjs` + `unconsumed-services-baseline.json`：
   扫 `ctx.provide('x')` 与 `get('x')` / `ctx.x`；**新增**「provide 了没人读」的服务 ⇒ 红；
   存量 133 个 dead service 进基线（历史债，显式登记）。`inject:` 不算消费，注册表/市场/测试不算消费方。
   接入 `npm run audit`。
2. `retired-sandbox-plugins.test.ts`：退役插件在「注册表 / 装配 YAML / 插件目录 / 市场目录 /
   `codem.yml`」五处都不许回潮，provider 文件必须物理删除，服务不许回到 dead 基线。
3. `unconsumed-services-gate.test.ts`：扫描器纯函数契约（有 get ⇒ 不算 dead；注册表/inject 不算消费）
   + 基线覆盖当前全仓。

### 3U.5 验证

- 全量：**995 文件 / 10371 通过 / 18 skipped / 0 失败**；
- `tsc` 0；`knip` 棘轮 46/30/10、binaries 0（把 `rustup` 登记为合法外部工具）；
- 覆盖率：全局 72.31 / 69.34 / 64.62 / 60.68，按棘轮上调阈值；
  `coverage-per-file --check` 通过（删掉 4 个已不存在文件的地板，其余地板不降）；
- `audit:docs`、上报点 314=314=314、可达性、fail-open 21 处、语法门禁全部通过；
- 真实模型行为未改（本轮不动权限/取消链路）；残留的 `sandbox` 服务与插件条目已从
  运行时和产品目录同时消失。
**顺带修掉的两处判据缺陷**（都是本轮全量跑出来的，不是绕过去）：
- coverage-per-file-baseline.json 删掉 4 个已不存在文件的地板后 _count 没同步，
  COV-FILE-2 按精确数对账 ⇒ 红；改为写入真实条数（321），判据本身保留「表非空/非全 0」。
- FT-WIRE-3 在并行满载时会在第二次文件树刷新落地前采快照（偶发红）；
  改成「连续两次采样一致才快照」，并保留逐字相等的严格断言。

### 3U.6 边界（如实记）

1. 服务级基线里仍有 **133 个**「provide 无 get」的历史服务（本轮只清沙箱族，不假装全清）；
   新门禁只保证「不再新增」。
2. 插件总数 208 → 202、市场目录 50 → 48；插件管理器/市场计数无精确断言，但截图与旧文档会失真。
3. ACL 里的 `.env` 读拦截、环境变量过滤**没有**在真实管线里重建 —— 它们从未生效过；
   若产品需要，应作为独立能力设计（写侧 `.env` 仍由权限规则 deny）。
4. `sandbox-mode-consistency` 的「唯一读点」判据不再钉行号（改钉文件 + 唯一性）。
5. `docs:sync` 的测试计数基线仍停在 966 个文件；发版前需刷新（非阻塞警告）。

### 3V. 第 17 轮：插件审计 / 敏感读 / 子进程环境（一次做完）

### 3V.1 修订了 3U 的两条结论

- 3U.6 说「ACL 里的 .env 读拦截、环境变量过滤没有在真实管线里重建」——本轮重建了：
  读侧规则表复用 Host 的 `packages/host/src/sensitive-paths.ts`（唯一来源，不新造第二套
  `.env` 正则），执行点覆盖 read/grep/glob/lsp/bash/terminal/run_code/workflow/
  read_attachment/MCP 资源/自动注入/读缓存；子进程环境在 Rust 侧按共享 JSON allowlist 剥离。
- 3U.3 的 133 条「provide 无 get」基线**已删除**。基线不是删代码的替代品：本轮改为
  `src/core/provider/provider-audit.json` 的**四分类**（registration/service/inject-dependency/
  wrapper/dynamic），每个 provide 必须有 kind；wrapper 在注册表里必须是 `core: true`
  （UI 不再出现可关但关了没用的假开关）。旧扫描器/基线/门测试文件已删除。

### 3V.2 关键证据（评审抓到的、会翻车的点）

1. Cordis `ctx.provide` 按值存、同名**硬抛**（`cordis/src/reflect.ts:288-291`）；
   dsh-compat 原来在 YAML 与 `App.tsx` **双加载**，第二个 fiber 的 provide 必抛并变 FAILED，
   而 disable 只能卸载 YAML fiber。已删除 App 直连，补 `plugin-single-load.test.ts`。
2. 34 个市场 bundled 锚里 20 个的 provider 在旧「死服务」基线内；7 个 LLM provider 的真实
   副作用是 `llm.registerProvider`，7 个 UI 插件是 `slots.register`，另有 17 组 inject-only
   依赖（guard/commands/sessionCheckpoint/hostClient/skill…）。所以**按「没人 get」删插件**
   会砍功能/启动 PENDING；本轮只做分类与 core 收口，不删这些插件。
3. 读主路径是 `readFileLines`（`tools.ts:1497`），不是 `readFile`；full 短路在
   `agentic-loop.ts:1928`，auto 的 `isAutoApprovable` 对非 bash 恒 true；旧 S2 规则
   `**/.env` 在 Windows 路径上基本不命中（`matchPattern` 的 `^.*.*/`）。因此策略放在
   代码（`security/sensitive-read.ts`）+ 工具体 + 权限层，而不是只加规则表。
4. 隐藏泄漏面：`task-keyword-search` 每回合自动 grep 全仓并以 `[源码命中]` 注入上下文
   （`agentic-loop.ts:2975 → task-keyword-search.ts:521/533/450`）、读缓存同回合二次读、
   `run_code/workflow` 的 `sdk.bash` 文本、`read_attachment` 任意 `target.path`、
   `read_mcp_resource` 的 URI。均已加对应判定/过滤。
5. 子进程 env 有 4 个生产面：`execute_command`、`spawn_pty`、`mcp_stdio_connect`、OFM node；
   `CommandBuilder` 种子 = 进程 env + 注册表 Environment，且清空 env 不回填 PATH 会让
   `cmd.exe` 按 cwd 相对解析（工作区投毒执行）。已改为 allowlist + 绝对 shell 路径；
   MCP 调用方显式 env 在策略之后覆盖（用户凭据保留）。

### 3V.3 判据

- `provider-audit.test.ts`（19 条）：清单漂移、注释里的 provide 不算、`getCtxService` 算消费、
  inject-only 分类、市场锚不判 wrapper、每个 wrapper 在注册表里 `core: true`。
- `plugin-single-load.test.ts`：dsh-compat 只由 YAML 装配一次。
- `sensitive-read-policy.test.ts` / `sensitive-read-enforcement.test.ts`：Windows 绝对/相对路径、
  `.env.example` 放行、git/ssh/私钥/云凭据、shell 读写 11+ 写法、file-api 默认拒绝、
  grep/glob 过滤与计数。
- `secret-env-policy.test.ts`：默认不继承、密钥名剥/工具链名留、代理 userinfo 剥。
- Rust：`secret_env` 18 条（含真子进程）、`ofm` 3 条、`execute_command` 6 条；3 次变异自证。
- 反例：沙箱关闭 ≠ 敏感文件可读（`run-code-sdk-sandbox-read` T2-G 已改成两条相反断言）。

### 3V.4 边界（如实记）

1. `classifySensitivePath` 是**工作区相对路径**词法判定；符号链接/junction、8.3 短名、ADS
   未做 realpath，属于残余绕过面（Rust 侧 `read_file` 仍只做工作区判定）。
2. 非 file:// 的 MCP 资源 URI 无法从名字判断内容是否敏感（由 server 自理）；只在 file/绝对
   路径形态拦截。
3. env allowlist 默认剥离会改变「子进程能看见宿主环境」的行为；设置面板提供整份继承的
   逃生开关（默认关），不提供自定义名单（避免第五套分类）。
4. 插件数量未减少：78 个 wrapper 仍保留（功能多走模块单例），只是 `core: true` 不可关闭；
   旧 133 条基线删除，但「无 get」的服务仍有一部分作为 plugin-api 存在——这是如实分类，
   不是宣称它们都被删除。

### 3W. 第 17 轮补丁：realpath + MCP 资源审批（P0/P1）

### 3W.1 P0：敏感路径按**真实路径**判定

- 新增 Rust 命令 `resolve_canonical_path` / `resolve_canonical_paths`（`src-tauri/src/lib.rs`），
  复用写侧同一份 `resolve_sandbox_path`（解析 symlink/junction/最近存在祖先、剥 `\\?\`）。
- `file-api` 新增 `canonicalizePathForSecurity` / `canonicalizePathsForSecurity`；
  `assertSensitiveReadAllowed` 改为 async，按 canonical + 字面两条路径判定。
- 权限层 `checkPermission` 在读工具上先 canonicalize 再判敏感（否则 `notes.txt -> .env`
  这种名字无害的链接不会弹审批）。
- grep 结果新增 `filterSensitiveGrepMatchesCanonical`：整页路径一次批量 canonicalize，
  再按真实路径过滤；grep/lsp/task-keyword-search/run_code 全部改走它。
- shell 文本新增 `detectSensitiveShellAccessCanonical`：先批量解析命令 token 的真实路径，
  再把「规范路径敏感」反馈给同步检测器；`cat notes.txt`（notes.txt -> .env）能识别为读。
- Windows ADS（`file.txt:stream`）默认文件视图看不到内容，按敏感 ask 处理。
- 判据：Rust `resolve_canonical_path_follows_junction_to_target`（真建 junction，解析到区外
  目标且判越界）、`canonical_expands_existing_8_3_short_name`（真造 8.3 短名并断言展开）；
  JS mock `resolve_canonical_path` 的 `notes.txt -> .env` 被拒、shell `cat notes.txt` 识别为读、
  grep canonical 过滤计 1 个跳过。

### 3W.2 P1：非文件 MCP 资源

- `isFileLikeResourceUri`：只认 `file://`、绝对路径、UNC；`memory://`/`db://` 等未知 scheme
  无法从 URI 判断内容。
- `checkPermission` 与 `permissions-provider` 对非文件 MCP 资源在 ask/auto 强制 `ask`
  （full 放行）；用户按资源审批一次，不再是「无法判定就静默读」。
- file:// / 绝对路径仍先 canonicalize 再判敏感。

### 3W.3 仍然保留的边界

1. shell 文本层 `cat notes.txt`（notes.txt 是链接到 .env）无法只靠参数 canonicalize 识别；
   它仍依赖沙箱在真实路径上的越界判定，以及敏感文件的**直接名字**检测。这是文本解析的边界，
   不是本次 realpath 能闭合的；要闭合只能把 shell 关进更小的能力沙箱。
2. 8.3 短名由 `std::fs::canonicalize` 对**已存在**路径展开（Rust 判据真造长目录、取
   `%~sI` 短名、断言解析到同一长路径）；不存在的新文件没有可读内容，走词法祖先。
3. 非文件 MCP 资源的审批是「按 URI 首次询问」，不是内容级 DLP；server 返回什么仍由 server 决定。
4. Windows ADS（`file.txt:stream`）已按敏感 ask 处理（默认文件视图看不到内容）；
   直读 token 的 symlink 已由 canonical shell 检测覆盖，但**脚本内部再拼路径**仍属文本解析边界。

﻿### 3X. 第 18 轮：按 unslop 全量清理（2026-11-24）

### 3X.1 屏幕级重构

- 恢复提示：技术 dump 从默认文案移到折叠的「详情」，24h 后旧事故不再常驻；提示下移到标题栏下方。
- 任务概览：四张等宽 KPI 卡 → 一条 4 项指标条；移除概览里的「场景实况」缩略；空活动不再画空热力图 + 大 0 圆环。
- 插件管理：198 张 emoji 卡片墙 → 密集列表（图标 / 名称+版本 / 描述 / 类型 / 依赖 / 操作）；manifest emoji 不再渲染，按 category 映射 lucide；统计改一行 mono meta；筛选收敛为 4 段。
- 设置：页面标题 20/600、section 16/500；底栏只保留「保存设置」主操作；模型选择加宽并显示完整名称。
- 记忆：顶部 8 个数字 → 待批准 / 已生效 / 体积 3 个主指标；batch id 降级为 11px mono；三段长说明进 details。
- 技能：拖拽区从首屏大块收成一行提示，只在拖入时显示目标区；默认选中第一个技能，详情区不再空白。

### 3X.2 Emoji / 图标

- 19 个文件里的可见 chrome emoji 全部换 lucide（PPT、Git、文件、目标、MCP、多模态、Recovery、Heartbeat、Notebook 等）；身份头像 / 宠物等产品内容保留。
- 新增 `ui-visible-emoji` 门禁（JSX 文本 + 属性/表达式，排除 console/log），chrome 目标 0。
- `ui-no-emoji` 棘轮从 233 行 / 47 文件收紧到 **16 行 / 6 文件**（剩余全部是身份/宠物 emoji 选择器、权限/输入端把 emoji 当兼容 key 的映射表；没有可见 chrome emoji）。

### 3X.3 表面与门禁

- 管理面 v2 重置旧玻璃/发光/彩色渐变/uppercase；开关打开态不再用 accent 铺满。
- 新增 `ui-copy-shape`（placeholder 不以省略号收尾）、`ui-v2-surface`（无渐变/glow/玻璃/uppercase，section ≤ page title，开关不用 accent）。
- 移除任务/场景重构后遗留的 19 个死 CSS 类；GitInfoPanel 的内联样式收成类；CSS 快照、icon 基线、time DST 例外表按实际迁移更新。

### 3X.4 验证

- 全量：1008 文件 / 10457 用例，10439 通过 / 18 skipped / 0 失败。
- tsc 0；knip 46/30/9；ui-consistency / no-bom / visible-emoji / copy-shape / v2-surface 全绿。
- 新增/更新任务、library-ops、插件、设置、记忆、恢复提示的定向判据共 40+ 条。

### 3Y 2026-11-25 · 第二轮非 emoji 收口

- 阅读刻度：v2 正文 14 / 次要 13 / meta 12 / 区块 17 / 页面 24；页面标题与 section 不再倒挂。
- 动效：六条语义曲线收敛到 `cubic-bezier(0.22, 1, 0.36, 1)`，删除 `ease-pop` 回弹；新增单曲线判据。
- 图标：v2 的 lucide 统一 1.5 描边；顶部图标按钮 28→32。
- Chat：StatsLine 改成默认折叠的「运行详情」；新增 TurnEvidenceRail（文件变更 + 最近验证，带通过/失败文字，不把会话记录说成本轮）。
- 插件：全部视图按 core→provider→tool→ui→compat→other 分组；deps=0 不再显示「—」；≤1360px 保留说明/类型、只隐藏依赖，≤1120px 才收成三列。
- 设置：模型行独占宽度、「配置方案」左对齐为子行；底栏成为 sticky action bar（次操作左、保存右），内容底部留出 footer 高度。
- 弹窗：插件/技能/记忆/任务标题、工具栏与列表统一 24px 水平留白，修掉文字贴边。
- 任务/活动：空态不再画 0% 健康环/全零字段；团队空态给「打开团队 →」，任务活动空态给「查看时间线」；技术 footer 改成「同时最多 N 个 · 委派最多 M 层」。
- 验证：全量 **1013 文件 / 10488 用例，10470 通过 / 18 skipped / 0 失败**；tsc 0；scan-ui 0/0；mutation artifact 重跑；coverage 门禁通过。

### 3Z 2026-11-25 · 第三轮硬收口（图标 / accent / 边框）

- 图标：TSX 与 packages/ui 共 664+41 处字面量从 10/12/14 统一到 16；控件 24 → 20；24 只保留在 6 个插画/头像/空态文件；新增 `ui-icon-scale` 判据（禁止 10/12/14/18，24 只允许登记文件）。
- accent：`unslop-v2.css` 从 30 处降到 15 处；任务/插件/设置/记忆的导航链接、审批开关、安装按钮、筛选 chip 改中性；每屏只剩主操作/当前选择/瞬态进度。
- 边框：移除任务卡、消息气泡、model/context/scope badge、活动行、jobs 行、证据 rail 下线等逐项边框；任务中心/插件市场/AgentPanel 的内联 1px 边框全部改成语义 class；设置表单行不再逐行画线。
- 新判据：`ui-accent-budget`（accent 总数 ≤15 + 禁止装饰 selectors）、`ui-border-density`（插件行/任务卡/记忆项/内联边框）、`ui-icon-scale`（16/20 + 24 allowlist）。
- 验证：全量 **1013 文件 / 10488 用例，10470 通过 / 18 skipped / 0 失败**；tsc 0；scan-ui 0/0；coverage 门禁通过。

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
