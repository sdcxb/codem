# UI 工艺 P2 真机取证（2026-10-18）

构建：本地 `tauri build`（1.16.324 同版本，未发版）→ 静默安装 → WebView2 CDP 驱动。
浏览器渲染：Edge headless + CDP（组件目录页）。

## 1. 设置 → 外观（运行时）

`settings-appearance-edgefade-sound.png`

| 检查 | 结果 |
|---|---|
| 语义动效令牌在运行时解析 | `--ease-swift = cubic-bezier(.16, 1, .3, 1)`、`--ease-pop = cubic-bezier(.34, 1.56, .64, 1)` |
| 设置内容列挂了边缘渐隐 | `mask-image` 含 `linear-gradient(rgb(0,0,0) 0px, rgb(0,0,0) 28px, … calc(100% - 28px) …)` |
| 提示音开关存在且默认关 | `aria-checked="false"` |
| 点一下 / 再点一下 | `false → true → false`（验证后已恢复默认关） |

## 2. 组件目录（`docs/component-gallery.html`）

`component-gallery.png` —— 直接加载**真实** `src/styles.css` + `codem-ui.css` 渲染：
按钮/开关、工具卡 IN/OUT、Diff 统一 + 分屏、消息气泡「运行中追加」、引导栏（待接收 + 附件）、
滚动边缘渐隐、设置行窄容器换行。

## 3. 判据与变异（机器证据）

- 判据：`EDGEFADE-1..4`、`DIFFVIEW-1..5`、`VIEWTRANS-1..3`、`UIDOC-1/2`、`ROVING-1..5`、`SOUND-1..3`、`MOTION-1..3`
- 变异波次：`ui-craft-p2`（8 条全部对红，`restored=true`）
- 全量：712 文件 / 8395 通过 + 17 skipped，`tsc` 0；非 eval 审计链 27 项全过

## 4. 局限（诚实说明）

- View Transitions 的**动画本身**无法在截图里证明（只能证明代码路径与降级逻辑，判据 `VIEWTRANS-1..3`）；
  WebView2 对该 API 的支持随内核版本而定，不支持时自动退化为普通切换。
- 提示音只验证了开关状态与合成路径（假 AudioContext 断言振荡器/包络），**没有**在真机上听声音
  （默认关闭，避免打扰）。
