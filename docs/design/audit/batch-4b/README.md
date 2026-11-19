# 覆盖面审计 · 设置页之外（Batch 4B）

## 仓库内对应实现（证据的落点）

| 改动 | 仓库内文件 |
|---|---|
| 任务中心宽度恒定 / 页签刻度 | `src/components/TaskCenter.tsx` + `src/styles/unslop-v2.css` §17、§20 |
| 弹窗与浮层刻度（§16/§17） | `src/styles/unslop-v2.css` |
| 对话输入区与工具条（§20） | `src/styles/unslop-v2.css` |
| 面板/弹窗清单（只读分析结论） | 本文件的「范围」小节 + `src/components/**` 对应组件 |

## 范围

两份实测清单（只读分析产出）驱动：

- **页面/面板**：侧栏 8 个入口、任务中心 8 个页签、右栏 4 个页签、右浮层 6 个页签、对话头浮层 5 个、
  终端抽屉、文件/编辑器/工作台、插件与市场、知识/文档/媒体等共 **110 条**（含不可达项）；
- **弹窗**：**70 条**（App 级 `.modal-overlay`、`.modal-editor[aria-label=…]`、`.confirm-dialog`、
  `.nb-dialog`、`.search-dialog`、AI 回合类、市场类…），并标出可自动打开 / 需要前置状态 / 不可达。

## 怎么量

`_unslop-surfaces-audit.mjs`：CDP 真机 → 逐目标执行「点击序列」→ 量**当前可见的根面板** →
截图 → 关闭（点遮罩 + Esc + 浮层关闭按钮三路兜底）。指标与设置审计同一套
（控件高度档/字号档/圆角种类/溢出/压缩/图标文字偏差）。

三个口径修正（都是被实测逼出来的，写进脚本注释）：

1. 点击只认**可见**元素 —— 侧栏在桌面/移动/rail 三处各渲染一份，第一份常常是隐藏的；
2. **滚动容器**与**主动截断**（line-clamp / ellipsis / 带「展开」按钮）不算「要素被压缩」；
3. **插件像素场景**（`.lo-pixel-room` 等 library-ops 内容）不参与壳层刻度 —— 方向稿明确允许
   「像素图书馆作为插件内容时刻保留」。

## 结果

| 面 | before | after |
|---|---|---|
| 对话主界面 | 控件 18/22/23/25/27/32/34 · 字号 11/13/14/16 | **28/32 · 12/14 · 圆角 8** |
| 任务中心 8 页签 | **宽度在 960 / 1180 之间跳**（切页签窗口忽大忽小） | **全部 1180×720** |
| 任务中心控件 | 28/33 · 12/13 | **28 · 12** |
| 智能体管理 | 899×786 | **1179×786** |
| 笔记本管理 | 899 宽 | **1179×786** |
| 浮层-上下文 | 控件 16/27 · 字号 10/12 · 圆角 4 | **28 · 12 · 8** |
| 浮层-文件快照 | 31 · 6 | **28 · 8** |
| 终端抽屉 | 27 · 6 | **28 · 8** |
| 记忆/MCP/技能/插件 | 1179×786 · 28 · 12 · 8（§16 已收敛） | 同左 + 溢出 0 |

**这一批最值钱的一条**：任务中心的面板宽度原来由 `activeTab` 决定
（`wide = board | subagents | overview | bots` → `min(1180px,96vw)`，其余 `min(960px,92vw)`），
切页签时整个窗口会横跳 220px —— 正是用户说的「同一个父窗口按钮切换时窗口忽大忽小」。
已改为**恒定 1180**（`TaskCenter.tsx`），窄页签多出来的空间留给内容。

## 复现

```powershell
npx vite build
node .preview-shot/_unslop-static-server.mjs
$env:CODEM_DATA_HOME="…\data-home"; $env:WEBVIEW2_USER_DATA_FOLDER="…\wv2-data"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224"
Start-Process "…\src-tauri\target\debug\codem.exe"
node .preview-shot/_unslop-surfaces-audit.mjs
node .preview-shot/_unslop-ui-audit.mjs          # 设置 23 页
node .preview-shot/_unslop-dialog-audit.mjs      # 弹窗
```

截图：`.preview-shot/unslop/audit-surfaces/*.png`；表格：同目录 `summary.md`。

## 未覆盖 / 已知限制

- **右栏（改动/文件/子代理/浏览器）** 在没有打开项目的状态下是 24px 折叠条，脚本打不开；
  需要「有项目 + 有改动」的前置状态。
- **AI 回合类弹窗**（权限确认、计划批准、澄清表单、变更审查、交互表单…）需要真实回合，
  不适合自动驱动；已列出清单，留待真机手测。
- **需破坏性前置**的弹窗（删除项目/MCP/技能、插件禁用级联、发布技能）未自动打开。
- **不可达**：`ConfigEditor`（`Sidebar.onConfig` 是死 prop）、`GitHubCloneDialog`（无 UI 入口）、
  `bottomTab==="game"`（刻意无入口）—— 已记录，脚本不去点。
- 弹窗的 **Esc 关闭缺失**（App 级 `.modal-overlay` 都没有 Esc 处理器）是一个真实可用性缺陷，
  归到 Batch 6C（无障碍）统一走 `useDismissableLayer`。
