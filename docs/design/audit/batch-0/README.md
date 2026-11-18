# Batch 0 · 基线证据

本目录只放**可复算的指纹**，不放截图本体。原因：基线截图来自本机真实会话，
含会话标题与项目路径；PNG 一旦写进 git 历史就无法撤回。截图的哈希记在
`capture.json`，需要人工评审时用下面的命令本机重拍。

## 采集条件

| 项 | 值 |
|---|---|
| 应用 | 装机版 Codem 1.18.14；其 UI 与仓库 `8ce08b43`（v1.18.14 发布提交）一致（`git diff v1.18.14 HEAD -- src/ packages/` 为空） |
| 视口 | CDP `Emulation.setDeviceMetricsOverride`：1440×900 @dsf1；该机布局宽度 1575 CSS px、984 CSS px 高（应用自带缩放，`capture.json` 逐张记录） |
| 主题 | 深色默认；亮色那张用临时改 `data-theme` 属性采集，**不写设置项** |
| 数据 | 本机真实库（未清空） |
| 状态还原 | 采集开始/结束均为 `theme=dark, skin=null, ui=null, overlays=0` |

## 复现

```powershell
# 1) 让应用带 CDP 启动（已启动的实例若没带，需重开）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"

# 2) 六张基线截图（.preview-shot/unslop/baseline/，不进 git）
node .preview-shot/_unslop-baseline.mjs

# 3) 布局指纹（元素数 + 每元素矩形；用于证明「只换 token、不改布局」）
node .preview-shot/_unslop-snapshot.mjs .preview-shot/unslop/snap.json
#    打开 v2 覆盖层再采一次：
node .preview-shot/_unslop-snapshot.mjs .preview-shot/unslop/snap-v2.json --ui=v2
```

协议（截图脚本已内置，必须一致才有可比性）：`Page.reload` → 等 `.app` 就绪 →
`Emulation.setDeviceMetricsOverride 1440×900@dsf1` → 注入 `animation:none;transition:none` 冻结动效 →
逐面采集 → 还原（移除冻结样式、清视口、关闭所有浮层）。

对比方式：两次 `snap*.json` 的 `count`、每个元素的 `box` 与 `layout` 必须完全一致；
`cls`/`textLen` 允许变化（那是换了 token 或文案）。脚本在 `.preview-shot/`（gitignored），
干净 clone 里没有，所以**结论**要回填到 `docs/design/UNSLOP-PROGRESS.md`。

## 读数（2026-11-18）

- 6 张截图：`108 KB – 229 KB`，sha256 见 `capture.json`；
- 可重复性（同一会话内按本协议连跑两遍）：**5 张逐字节相同**；
  `02-tasks-dark` 差 **1 字节 / 229 KB** —— 任务中心渲染相对时间与活动计数，冻结动画也消不掉，该面以布局指纹为准；
- 布局指纹：**2021** 个元素、`viewport 1575×984`，连续两次采集**逐字节相同**；
- 门禁基线（本次实测）：`scan-ui` error **0** / warn **0**；`style-literals` 11 族通过；
  `color-roles` 51 对通过、未解析 48 / 预算 49；`token-hygiene` 0 问题；`motion` 0 裸曲线；
  `doc-tokens` 通过。

## 口径（避免误读）

- 截图 sha256 **只在同一台机、同一数据状态、同一视口、同一协议**下可比 —— 会话多一条消息，哈希就会变。
  因此它证明的是「这一批没改视觉」，不是「任何人重跑都会得到同一串哈希」。
- 「关闭 v2 时逐像素不变」的**构造保证**是 `ui-layer.test.ts` 的作用域闸
  （`unslop-v2.css` 的每条选择器都必须带 `[data-ui="v2"]`），截图哈希只是旁证。
- 「v2 只改 token、不改布局」的**主判据**是布局指纹：开启前后 `count` 相同、每个元素的 `box` 与 `layout` 相同。
  比截图更可靠（不受实时文本影响），也比人眼看图更能定位到具体元素。
