# 设置子页 · 界面缺陷审计（Batch 4A）

## 仓库内对应实现（证据的落点）

| 改动 | 仓库内文件 |
|---|---|
| 设置页控件刻度 / 侧栏对齐 / 二级页签 | `src/styles/unslop-v2.css` §15 |
| 界面版本开关（经典 / 新版） | `src/components/SettingsPanel.tsx`（外观页）+ `src/core/theme/ui-layer.ts` |
| 工具描述两行截断 | `src/components/ToolManager.tsx` |
| 生产构建白屏（TDZ）修复 | `src/core/llm/engine-access.ts` + `src/test/llm-barrel-tdz.test.ts` |

## 为什么做这个

用户实报：「设置页面及其子页面、弹窗里有非常多的界面问题 —— 要素被压缩、换行、对齐、
同一个父窗口里切页签时窗口忽大忽小、同层级字体大小不一致、按钮风格和 Codem 自己不一致、
字体图标行距不一致」。这类描述没法直接当验收，先把它变成**可数的指标**。

## 怎么量

`.preview-shot/_unslop-ui-audit.mjs`：CDP 连真机 → 进设置 → **逐个点 23 个左栏页签** →
每页采一份指标 + 一张截图。指标全部来自 `getComputedStyle` / `getBoundingClientRect`：

| 指标 | 定义 | 对应用户说的 |
|---|---|---|
| 面板尺寸 | `.settings-panel` 的 w×h | 「窗口忽大忽小」 |
| 控件高度档 / 字号档 | 紧凑按钮（h≤40 且非开关）去重后的高度/字号集合 | 「同层级字体大小不一致」「按钮风格不一致」 |
| 控件尺寸种类 | 紧凑按钮 w×h 去重 | 同上 |
| 圆角种类 | 按钮圆角去重 | 「按钮风格不一致」 |
| 溢出 | `overflow≠visible` 且 `scrollWidth-clientWidth>2` 或 `scrollHeight-clientHeight>2` | 「要素被压缩」 |
| 压缩 | 文本行高 < 1.15×字号 | 「行距不一致」 |
| 图标偏差 | 同一按钮内 svg 中心与文字中心线的差（>1px 计一次） | 「字体图标行距不一致」 |
| 对齐偏差 | 同一 `.setting-group` 里 label 与控件左边缘差（>1px） | 「对齐问题」 |

两轮采集，同一台机、同一数据、同一协议（reload → 就绪 → 1440×900@dsf1 → 冻结动画）：

- **before**：装机版 1.18.14（经典界面，v1）→ `.preview-shot/unslop/audit-v1/`
- **after**：同源码构建 + `[data-ui="v2"]`（设置 → 外观 → 界面版本 → 新版）→ `.preview-shot/unslop/audit/`

## 结果（23 个设置子页）

| 指标 | before（v1） | after（v2） |
|---|---|---|
| 面板尺寸一致性 | 全部 1575×940 | 全部 1575×940（**本来就没有跳变**，这条排除） |
| 控件高度档 | 21/24/26/27/28/29/30/31/33/34/36/40/46（**9–12 档**） | **28 / 32**（20 页只有这两档；工具页多一个 24 的图标钮） |
| 控件字号档 | 10/11/12/13/13.33/16/20（**6–7 种**） | **12**（22/23 页）；连接手机页仍有一处 10 |
| 圆角种类 | 1/3/4/5 种（同一页最多 5） | **2 种**（控件 8 + 开关 9999） |
| 压缩（行高 < 1.15×字号） | 0（旧判据口径下）／新版判据在"通用"页抓到 40 处 | **0**（23 页里 21 页为 0，另 2 页各 1） |
| 图标与文字中心线偏差 | 每页 **24–30 处**（全部侧栏行，固定偏 **-2.9px**） | 每页 **1–10 处**（侧栏 0；余下是自绘图标按钮） |
| 文本溢出 | 工具页 **91**、记忆体检 17 | 工具页 **64**（长描述已改两行，余下是其它内联单行）、记忆体检 17（预览截断，有省略号） |

## 改了什么

1. `.settings-sidebar-item`：31px → 32px，图标盒固定 16px、文字行高 **16px**（与图标同高）
   ⇒ 中心线偏差 **2.9px → 0**。
2. 设置页所有紧凑控件统一到 **28px 高 / 8px 圆角 / 12px 字**；开关保留 24px 与胶囊圆角（语义要求）；
   整行大卡片（模式卡）、图标格（身份头像）、头像、返回键、虚线投放区**不参与**收敛（它们是不同控件类型）。
3. 二级页签（26px 圆胶囊）→ 28px 方角 + 下划线；记忆体检里 21px 的小胶囊 → 28px 方角小按钮。
4. 设置页字号收敛到 11（元信息）/ 12（正文、按钮）/ 14（小节）/ 20（页标题）四档。
5. 工具列表的描述：由「单行 + 手截 100 字 + 省略号」改为**两行截断**（实测被裁 18–77px 的
   10 条描述现在可读）。
6. 设置 → 外观新增「界面版本：经典 / 新版（灰度）」开关（写 `localStorage`，不改任何业务逻辑），
   让这套改动**在界面里可达**，而不是只能改 localStorage。

## 复现

```powershell
# 1) 构建（dev 服务器在本机会进入"接受连接但永不响应"，所以用 dist + 静态服务器）
npx vite build
node .preview-shot/_unslop-static-server.mjs          # 把 dist 挂在 1420

# 2) 启动带 CDP 的源码版（独立数据根 + 独立 WebView2 profile，见 UNSLOP-PROGRESS §3A.3）
$env:CODEM_DATA_HOME="C:\mimo-gui\.preview-shot\unslop\data-home"
$env:WEBVIEW2_USER_DATA_FOLDER="C:\mimo-gui\.preview-shot\unslop\wv2-data"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9224"
Start-Process "C:\mimo-gui\src-tauri\target\debug\codem.exe"

# 3) 审计（v2：9224；经典：--app 连装机版的 9222）
node .preview-shot/_unslop-ui-audit.mjs
node .preview-shot/_unslop-ui-audit.mjs --app
```

截图：`.preview-shot/unslop/audit/settings-00.png` … `settings-22.png`（v2）与
`.preview-shot/unslop/audit-v1/settings-*.png`（v1）。

## 已知未做

- **弹窗**（非设置类：搜索、任务中心、插件市场、项目设置、确认框）还没逐个数完；
  同一套脚本可以复用（打开浮层后采集 `.modal-panel` 尺寸 + 控件刻度）。
- 记忆体检的 17 处"溢出"是**列表预览的主动截断**（有省略号），不算缺陷；若要统一，
  应改成"点击展开"而不是放宽盒宽。
- 工具页余下 64 处溢出属于同一页里**其它**内联单行文本（工具参数说明等），需要逐个改成两行。
