# 二次升级 Phase A–F 真机验收证据（2026-10-28）

口径：连 **release 构建的真实窗口**（`src-tauri/target/release/codem.exe`，14:56/16:5x 构建），
用 CDP 的 `Emulation.setDeviceMetricsOverride` 切**渲染视口**（不是往页面里注入假 DOM），
逐档截图并用 `Runtime.evaluate` 读真实 DOM 计算值。

- 截图：`phase-a-b-1600.png` / `phase-a-b-1400.png` / `phase-a-b-1280.png` / `phase-e-1080-125.png` / `phase-e-1080-150.png` / `phase-d-narrow-520.png`
- 读数：`readings.json`（每张截图的视口、内容列、Composer、右栏宽、字体族/字号/`text-rendering`、`scrollbar-gutter`，以及 PNG 的 sha256）
- Phase F 专项：`phase-f-rail-480.png` + `phase-f-rail-480.json`（走产品路径：点「展开」→ 聚焦分隔条 → 方向键 ×N）

## 读数摘要

| 档位 | 视口 | 内容列 | Composer | delta |
|---|---|---|---|---|
| 1600×900 | 1750 CSS px* | 820 | 820 | **0** |
| 1400×735 | 1531 CSS px* | 820 | 820 | **0** |
| 1280×800 | 1400 CSS px* | 732 | 732 | **0** |
| 1080p @125% | 1680 CSS px* | 820 | 820 | **0** |
| 1080p @150% | 1400 CSS px* | 732 | 732 | **0** |

\* 应用窗口本身带 DPR 3 + 缩放，`Emulation` 的 width 与页面报告的 `innerWidth` 不是 1:1；
表里写的是**页面自报**的 CSS 视口（`window.innerWidth`），这也是所有断点判断的依据。

- `text-rendering: auto`（`optimizeLegibility` 已移除）；`font-family` 仍是 `AlimamaFangYuanTi, -apple-system, …`（**字体族未改**）。
- `scrollbar-gutter: stable both-edges` 生效（Phase A 的 11px 来源）。

## Phase F（右栏拉宽）

走产品路径把右栏从收起 → 展开 → 方向键调宽：

| 状态 | 右栏 | 内容列 | Composer | 横向溢出 |
|---|---|---|---|---|
| 展开后（记忆宽度 428） | 428 | 642 | 712 | 无 |
| 键调 8 步后 | 556 | 514 | 536 | 无 |

结论：**没有横向溢出**，正文仍是可读宽度；但右栏很宽时正文列会比 Composer **窄约 22px** ——
原因是 `scrollbar-gutter: both-edges` 为滚动条两侧各留了位置（Phase A 的代价）。
默认档位（1400，右栏默认 360/400）下两者**完全相等**（见上表 delta 0）。
这条残差已写进 `docs/audit/FULL-SYSTEM-AUDIT-HANDOFF.md` §11.13，不假装它不存在。
