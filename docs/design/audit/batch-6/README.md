# Batch 6 · 三套皮肤 / 窄视口 / 无障碍

> 口径说明：本批次**没有真机**（这台机器上没有 Android/iOS 设备），所以「移动端」只验证
> **窄视口布局**（390×844、768×1024 的 CSS 视口），不冒充真机可用性。真机验证仍是 blocked。

## 6A 三套皮肤

在 v2 下逐套切换（设置 → 外观 → 皮肤）并截图：`default` / `hub` / `dream`。
三套都能正常渲染 v2 层：hub 的三栏与顶栏保留、dream 的装饰层与浅色调保留，
控件刻度、发丝线、琥珀主色来自同一套 `--ui-*` 令牌（皮肤只换令牌与背景层）。

截图：`.preview-shot/unslop/skins/{default,hub,dream}.png`

**已知差异（皮肤自己的选择，不是缺陷）**：dream 的发送按钮用的是它自己的强调色（深绿），
因为它覆盖了 `--accent*`；v2 的规则本身没有为任何皮肤写分支。

## 6B 窄视口

| 视口 | 横向溢出 | 越界元素 | 汉堡可见 | 输入区宽 | 主区宽 | 抽屉宽 |
|---|---|---|---|---|---|---|
| 390×844 | **0px**（改前 39 → 43） | **0**（改前 10） | true（改前不存在） | 340 | 340 | 280 |
| 768×1024 | 0px | 0 | true | 718 | 718 | 280 |

修的三件事（两件是真 bug）：

1. **hub / dream 两套皮肤在窄视口没有汉堡按钮** —— `WorkspaceFrame` 只在默认皮肤的裸 fragment 里
   渲染 `mobileSidebarToggle`，`App.tsx` 的 hub / dream 分支也没传这个 prop ⇒
   390px 下 `document.querySelector(".mobile-sidebar-toggle")` 为 null，**没有任何入口能打开侧栏**。
   现在三套都渲染、三个分支都传。
2. **横向溢出 39px**：dream 皮肤的装饰层（`.dream-decoration.rose-right` 右边缘 422px）与
   标题栏按钮组（右边缘 433px）。窄视口收起装饰、按钮组改绝对定位贴右内边距、应用菜单
   （`.app-menubar`）隐藏。
3. **汉堡按钮压住标题栏左区**：窄视口把标题栏的应用名收掉，给汉堡留 `--space-14` 的占位。

手机竖屏（≤480）另加两条：建议卡改单列（两列时中文一行只有 4 个字）、快速访问网格单列。

## 6C 无障碍

| 面 | 可交互 | 无可访问名（改前 → 改后） | <24px（改前 → 改后） |
|---|---|---|---|
| 主界面 | 129 | 2 → **0** | 13 → **0** |
| 设置-通用 | 307 | 35 → **1** | 15 → **2** |
| 任务中心 | 156 | 2 → **0** | 18 → **1** |
| 插件管理 | 199 | 2 → **0** | 54 → **0** |

三件事：

1. **Esc 关不掉弹窗（真 bug）**：App 级 `.modal-overlay` 这批是早期手写结构，只有「点遮罩 / 点关闭」
   两条路，而遮罩不可聚焦 ⇒ 键盘用户被卡住。新增 `src/core/ui/escape-to-close.ts`：
   只点**显式的关闭按钮**（`[aria-label^="关闭"]`、`.modal-close` 等），不合成遮罩点击
   （那可能被权限确认类弹窗解读成「拒绝」）。真机验证：MCP 管理弹窗 Esc 前 `true` → Esc 后 `false`。
   判据 `src/test/escape-to-close-modal.test.ts` 6 例（含「没有显式关闭按钮时什么都不做」）。
2. **35 个控件没有可访问名**：设置页 26 处 `<label>` 没有 `for`、控件没有 `id`。
   新增 `src/core/ui/aria-label-form.ts`：label 配对 + placeholder/同行文字兜底，
   用 `installAutoAriaLabels()` 观察新增子树（异步挂载的会话/弹窗也能覆盖）。
   判据 `src/test/aria-label-form.test.ts` 9 例（含幂等与「后挂载」用例）。
3. **触控尺寸与焦点环**：收藏星标 12px 宽 → 24；开关 39×23 → ≥24 高；紧凑模式按钮 18 → 24；
   给标题栏/侧栏/页签/菜单项补 `:focus-visible` 环（实测真实 Tab 后 outline 为琥珀 75%，
   programmatic focus 不触发 `:focus-visible`，所以审计改用 CDP 真键盘 Tab 验证）。

## 未做（明确留给下一轮）

- **真机**（Android / iOS）：没有设备，blocked。
- 设置页还剩 **1 个**没有可访问名的控件、**2 个** <24px 控件（都不到 WCAG 的硬性边界但不完美）。
- 无障碍审计只覆盖 4 个面（主界面/设置/任务中心/插件管理），其余弹窗未逐一采样。

## 复现

```powershell
node .preview-shot/_unslop-mobile-check.mjs   # 两个视口 + 抽屉
node .preview-shot/_unslop-a11y-audit.mjs     # 可访问名 / 触控尺寸
node .preview-shot/_skins-shot2.mjs           # 三套皮肤截图
```
