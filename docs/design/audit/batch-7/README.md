# Batch 7 · 收口（证据集与待决策项）

## 这一批做了什么

1. **统一协议重拍了 10 张收口截图**（默认皮肤、1440×900、`[data-ui="v2"]`）：
   主界面 / 设置-通用 / 设置-外观 / 任务中心-概览 / 任务中心-看板 / 插件-已安装 /
   插件-市场 / 终端抽屉 / 记忆管理 / 技能管理。
   路径：`.preview-shot/unslop/final/01-main.png` … `10-skills.png`（截图不进仓库）。
2. 把「是否把 v2 设为默认」**留在用户手里**（见文末），没有擅自切默认。
3. 复核全部硬门禁与全量测试（见下表）。

## 门禁复核（2026-11-19）

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run` | **10228 通过 / 18 skipped / 0 失败**（975 文件） |
| `tools/ui-audit/scan-ui.mjs` | 0 error / 0 warn（1036 文件） |
| `audit:style-literals` | 11 族全部不超过基线（9 族已下降） |
| `audit:color-roles` | 51 对已登记且过对比度；未解析 48（预算 49） |
| `audit:token-hygiene` / `audit:motion` / `audit:doc-tokens` | 全部通过 |
| `tools/audit/knip-gate.mjs` | exports 46/46、types 30/30；门面 21/白名单 20/可达 1 |
| `reachability-scan.mjs --check` | 通过（无过期条目） |
| `OVERLAY-1b/1c`（浮层关闭唯一实现） | 通过（Esc 走 `useDismissableLayer`） |
| `docs-bench-evidence` BE-2 | 通过（审计文档指向仓库内文件） |

## 全流程账本

| 批次 | 内容 | 状态 |
|---|---|---|
| 0 | 基线护栏：v2 token 层、作用域闸、文案/emoji 棘轮 | ✅ |
| 1A | `WorkspaceFrame` 抽出（三份主区收一份） | ✅ |
| 1B | 壳层与聊天视觉：琥珀/中性面、头部 3+overflow、状态去胶囊 | ✅ |
| 2 | 任务/团队/记忆视觉 + 全仓文案缺陷 | ✅ |
| 3 | 设置/引导/Git 环境视觉 + 人设与状态文案 | ✅ |
| 4A | 设置 23 子页控件刻度收敛 + **生产构建白屏（TDZ）修复** | ✅ |
| 4A-续 | 弹窗规范化（尺寸/圆角/控件刻度） | ✅ |
| 4B | 非设置面全覆盖审计：110 页面 + 70 弹窗；**切页签窗口跳变**与**新对话页英文**两条真 bug | ✅ |
| 5A/5B | 文件/终端/工作台 + 插件/市场/技能/智能体/MCP（§18/§19） | ✅ |
| 6A | 三套皮肤在 v2 下验收（截图 3 张） | ✅ |
| 6B | 窄视口 390/768：溢 0、汉堡 3 套皮肤都有、抽屉可用；**真机 blocked** | ✅ 布局 |
| 6C | **Esc 关弹窗**、**可访问名 35→1**、触控尺寸 54→0、焦点环真键盘验证 | ✅ |
| 7 | 收口截图集 + 门禁复核 + 默认开关决策 | 本文件 |

## 待决策（需要用户拍板）

1. **是否把 v2 设为默认？** 现在默认仍是经典，入口在 设置 → 外观 → 界面版本 → 新版（灰度）。
   切默认只需改一处：`src/core/theme/ui-layer.ts` 的 `readUiLayer()` 兜底值 + 一处判据。
2. **设置页剩余无障碍项**：1 个控件仍无可访问名、2 个 <24px（都不到 WCAG 硬边界）——
   要不要为它们单独改 TSX（会动到两个设置子组件的结构）。
3. **真机移动端**：需要一台 Android 设备（或你确认只保桌面窄窗口）。

## 复现

```powershell
node .preview-shot/_unslop-final-shots.mjs     # 10 张收口截图
node .preview-shot/_unslop-ui-audit.mjs        # 设置 23 页
node .preview-shot/_unslop-surfaces-audit.mjs  # 页面/面板/浮层 25 面
node .preview-shot/_unslop-a11y-audit.mjs      # 无障碍 4 面
node .preview-shot/_unslop-mobile-check.mjs    # 两个窄视口
```
