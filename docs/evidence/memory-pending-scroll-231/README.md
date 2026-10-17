# 记忆面板「待批准列表」滚不动 —— 真机取证（第 231 波）

用户实报：面板头部写着「待批准的自动记忆（11 条）」，列表**只显示 7 条、没有滚动条**，
第 8 条被裁在底部，剩下几条**既看不到也批不了**。

## 现场

- 隔离数据根 `CODEM_DATA_HOME=%TEMP%\codem-mem231\data`（**没碰用户真实数据根**，也没安装/覆盖用户版本）；
- 库里造 **12 条 pending**（写入引擎的 `memory` 表 `id='default'`，`version:2` 载荷，`scope: platform` ⇒ 任何位置可见）；
- 只按 PID 结束自己 spawn 的实例；CDP 连 WebView2，`Emulation.setDeviceMetricsOverride` 把视口压到
  **1200×700**（这台机器的默认窗口足够高，12 条放得下，缺陷不显形 —— 这一点本身也是"为什么用户会撞上、
  而我们平时看不到"的解释）；
- 量测脚本：`.preview-shot/_mem231-probe.mjs`（判据 + 截图）、
  `.preview-shot/_mem231-before-emulate.mjs`（修前形态复现）、`.preview-shot/_mem231-repro.mjs`（造数据/起停）。

## 修前 / 修后

| 量（VP 1200×700，12 条 pending） | 修前 | 修后 |
| --- | --- | --- |
| `.memory-manager` | y 71 → 629（高 558） | y 71 → 629（高 558） |
| `.memory-pending-section` | y 289 → **908**（高 **619**，比面板高 61px） | y 289 → 583（高 **294**，被 `max-height: 55%` 收住） |
| `section.overflowY` | `visible` | `hidden`（裁住自身，滚动交给内部） |
| 滚动区 | **不存在** | `.memory-pending-list`：y 419 → 583（高 **164**，`overflow-y: auto` + `min-height: 0`） |
| 设 `scrollTop = 400` 之后 | section / list / manager **全部仍是 0**（`moved: false`） | list **0 → 311.7**（`moved: true`） |
| 第 12 条 `getBoundingClientRect()` | y 859 → **895**（越过面板底边 629，也在视口 700 之外） | y 547 → **583**（完整落在列表 419–583 与面板之内） |
| `elementFromPoint`（第 12 条中心） | `modal-overlay`（不是它自己） | `memory-pending-check`（第 12 条自己的勾选框） |
| 顶部标题 / 批量栏（滚动前后） | — | y **301→301**（高 118）/ y **350→350**，**不随列表滚走** |
| 判据脚本退出码 | **1**（`verdict: 被裁在面板外`） | **0**（`ok: true`） |

截图：
- `before-clipped.png` —— 修前形态（第 1–5 条可见，第 6 条被底边裁断，没有滚动条）；
- `after-scroll-to-12.png` —— 修后（列表滚到末尾，第 9–12 条可见，第 12 条带「批准 / 拒绝」，
  右侧有列表自己的滚动条；顶部标题与两个批量栏仍在原位）。

> 说明：修前的原始构建（`codem.exe`）在本轮被重新构建覆盖了，所以 `before-clipped.png`
> 是在**当前构建**上用 CDP 注入旧的三条声明（`flex: none` / `max-height: none` / `overflow: visible`）
> 复现出来的 —— 修法只动那三条 + 滚动区那一条，注入旧值即回到修前形态；
> 上表"修前"一列的数值来自**改代码之前**对当时构建的实测（section 619 / scrollTop 不动 / 第 12 条 bottom 895），
> 与注入复现的数值一致（复现值：section 908 底、list 476 不可滚、第 12 条 bottom 895）。

## 根因（一行）

`.memory-pending-section` 既没有高度约束也没有 `overflow` ⇒ 12 条把它撑到 619px，而面板只有 558px；
**没有任何元素负责滚动**，溢出被祖先 `.app-content` 的 `overflow: hidden` 裁掉 ⇒ 第 8 条起不可达。

## 修法

1. `.memory-pending-section`：`display: flex; flex-direction: column; min-height: 0; max-height: 55%;
   flex: 0 0 auto; overflow: hidden` —— 可压缩到上限，到了上限就不再让位（真机对照：`flex: 0 1 auto`
   会被压到 246px，列表只剩 104px ≈ 3 条；`0 0 auto` 稳在 307px，列表 164px ≈ 4 条）；
2. 拆成**不滚的头** `.memory-pending-head`（标题读数 / 手势提示 / 勾选+批量 / 本批+一键全部，`flex: none`）
   与**唯一滚动区** `.memory-pending-list`（`flex: 1 1 auto; min-height: 0; overflow-y: auto;
   overscroll-behavior: contain`）；
3. 展开块的 DOM 位置不变（仍在条目里、因而仍在滚动区内）⇒ 展开一条只撑大 scrollHeight，后面的条目照样能滚到。

## 判据

- 单测（happy-dom，无布局引擎）：`src/test/memory-pending-scroll.test.tsx` 的 `MPS-231-1..4`
  （声明判据 + 12 条全在滚动区里 + 头在滚动区外 + 展开块仍在滚动区 + 语义未变）；
- 真机几何：`.preview-shot/_mem231-probe.mjs`（`ok: true` / 退出码 0 才算过）；
- 变异：`tools/mutate/specs/memory-pending-scroll-231.mjs` 的 5 条（去掉 `overflow-y` / 去掉两处
  `min-height: 0` / head 改成可收缩 / 换掉滚动区类名 ⇒ 全部点名变红，`restored=true`）。

## 已知未做（如实）

待批准区占 55% 上限、内容区在 700px 高的小窗口且 pending 很多时会被压到很小（它有内部滚动，
但可视高度接近 0）—— 这是这块面板**在窄窗口下的既有过度订阅**（修前内容区同样是 0，本次没有变更差），
真要治得动顶部那几块固定高度（统计/搜索/过滤/提示），属另一件事，本波没做。
