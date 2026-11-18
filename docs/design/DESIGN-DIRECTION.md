# Codem Design Direction — Unslop v2

> 执行契约。与 [UNSLOP-IMPLEMENTATION-PLAN.md](UNSLOP-IMPLEMENTATION-PLAN.md) 配套。
> 方向稿：[unslop-codem-v1.html](unslop-codem-v1.html)。

## 产品

本地优先的桌面 AI 编程代理，把对话、计划、工具调用、验证串成一条可审计的工作流。

## 性格

精确、技术、克制，有一点温度。不是“电子幽灵”，也不是“赛博管家”。

## 世界

工程工作台、终端、图纸、机房。不是紫色 SaaS 仪表盘，也不是游戏大厅。

## 两个高信息时刻

1. diff / 验证结果；
2. 上下文时间轴 / 任务图。

## 签名

细绿色状态点 + 等宽元数据（`ctx 68%`、`12 tools`、`2m 14s`）。  
不用 emoji 当签名。

---

## 颜色（深色默认）

```css
--ui-bg: #0e1012;
--ui-sidebar: #111316;
--ui-surface: #15181c;
--ui-surface-raised: #1a1e22;
--ui-surface-active: #20252a;
--ui-line: rgba(233, 230, 223, .09);
--ui-line-strong: rgba(233, 230, 223, .16);
--ui-text: #e9e6df;
--ui-text-secondary: #a8aaa5;
--ui-text-muted: #7c817b;
--ui-text-dim: #5f655f;
--ui-accent: #c6a15b;
--ui-accent-hover: #d2ad66;
--ui-accent-ink: #17130c;
--ui-success: #78b892;
--ui-danger: #d47c74;
--ui-info: #8aa6c8;
```

规则：

- accent 使用面积 < 5%；不做大面积背景、用户气泡、普通卡片。
- 绿色/红色只表意；不做装饰。
- 图表用独立 series 色，不抢 UI accent。
- 禁止彩色渐变/glow；surface 深度用中性 step + hairline。
- 数据可视化、用户内容、PPT 主题、代码高亮不受此限制。

## 颜色（亮色）

```css
--ui-bg: #f7f5f0;
--ui-sidebar: #f2efe8;
--ui-surface: #fffdf9;
--ui-surface-raised: #efece5;
--ui-surface-active: #e8e3da;
--ui-line: rgba(29, 27, 23, .10);
--ui-line-strong: rgba(29, 27, 23, .18);
--ui-text: #1d1b17;
--ui-text-secondary: #565a54;
--ui-text-muted: #73776f;
--ui-accent: #8a6a2f;
--ui-accent-ink: #fffdf9;
--ui-success: #2e7d57;
--ui-danger: #b3413b;
--ui-info: #3f6387;
```

执行时用对比度测试校准；正文 ≥ 4.5:1。

## 字体

```css
--ui-font-ui: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI",
  "Noto Sans SC", sans-serif;
--ui-font-mono: "Cascadia Code", "IBM Plex Mono", "SFMono-Regular",
  ui-monospace, monospace;
```

- 不引入网络字体；不依赖用户安装 IBM Plex。
- 字重 400/500；页面标题最多 600。
- 字号：meta 11–12、正文 13–14、页标题 24–28、对话标题 22–24。
- 不用 uppercase 宽字距标签；代码/缩写除外。
- 数字用 `font-variant-numeric: tabular-nums`。

## 图标

- lucide，16/18px，stroke 1.5。
- 状态：5px 圆点 + 文字。
- 不用 emoji 做图标/状态/标题/按钮。
- 图标按钮必须 `aria-label`，点击区 28/32px。

## 间距 / 圆角 / 阴影

- 间距 4px 阶梯：4/8/12/16/20/24/32/40/48。
- 控件 28–32 高；行 32；触控 40–44。
- 圆角：控件 8、卡片 10–12、面板 14；9999 只用于开关/头像/状态点。
- 深色阴影：surface step + hairline；浮层一档中性阴影；无彩色 glow。

## 动效

- `cubic-bezier(.22,1,.36,1)`。
- 120–180ms hover/press；160–220ms 菜单；300–500ms 面板。
- 只动 color/background/border/opacity/transform。
- 删除装饰性 pulse/glow/shimmer；保留“生成中/在线”的语义 pulse。

## 浮层

- `--z-modal` < `--z-dialog-overlay` < `--z-dialog`。
- 模态内破坏性操作内联确认，不嵌套模态。
- 统一走 `src/components/ui/*` 的 Dialog/Drawer/Popover/Menu/Tooltip。
- 不删/改 `data-testid`、`role`、`aria-*`、键盘快捷键。

---

## 三套皮肤

全部做，不允许隐藏/冻结：

| 皮肤 | 表面 | accent | 规则 |
|---|---|---|---|
| default | 石墨深色 + 亮色 | 琥珀 `#C6A15B` | 基准 |
| hub | 深黑表面 | 同琥珀 | 去掉橙/蓝光斑与彩色 glow；保留深色氛围 |
| dream | 暖纸/浅色 | 同琥珀 | 去掉粉色 accent/彩色 blob；用户背景图可保留但降存在感 |

- 三套共享 `WorkspaceFrame` 与组件，不允许各自独立布局。
- 三套只允许换 `--ui-*` token 和背景层；控件/圆角/字体/图标/文案规则一致。
- 原有单模式皮肤（hub 深色、dream 浅色）不强行新造另一模式；该模式下必须完整验收。

## 手机端

完整做，不另立计划：

- 同一套 `--ui-*` token、字体、图标、文案；
- 触控 ≥ 44px；安全区；键盘避让；返回键；
- 桌面浮层 → 移动底部 sheet；无 hover-only；
- 覆盖配对、会话列表、聊天、输入、审批、变更、文件浏览、Diff、详情、信息、浏览器；
- 桌面与手机 token 同源，禁止两套色值漂移。

## 插件

- `library-ops` 统一：壳层/面板/表格/按钮/弹窗用共享组件；像素图书馆可作为插件内容时刻保留，但降饱和、去霓虹/emoji。
- `monopoly-game` 游戏先不做。
- 插件 CSS 必须作用域隔离，不能污染主 UI/手机 UI。

---

## 文案规则

### 语气

- 陈述句；短标签；不用感叹号。
- 不问候、不卖萌、不“加油”。
- 说清“发生什么 / 下一步做什么”，不堆形容词。

### 术语表

| 统一使用 | 避免 |
|---|---|
| 会话 | 对话（指 session 时） |
| 任务 | 委派、工作项（视上下文） |
| 团队 | 群、小队（除非产品名） |
| 记忆 | 知识（memory 语境） |
| 上下文 | 水位、context（中文正文） |
| 压缩 | 压缩上下文（首次出现可解释） |
| 换段 | 分段、segment（中文正文） |
| 模型 | provider（面向用户时） |
| 批准 / 拒绝 | 通过、同意（审批按钮） |
| 安装 | 一键安装 |
| 已内置 | 开箱即用 |

### 禁用/替换

- `电子幽灵` → `研究助手`
- `赛博管家` → `运维助手`
- `数字精灵` → `文档助手`
- `准备好了，开始吧。` → `开始使用`
- `去市场看看吧~` → `暂无已安装的宠物。打开市场`
- `一键安装` → `安装`
- `开箱即用` → `已内置`
- `放心重试` → `可以重试`
- `🔴 上下文即将满！请立即压缩` → `上下文接近上限。压缩后继续。`
- 所有 `✅/❌/⚠️/🔴` 状态 → 图标 + 文字 / 状态点
- 所有 `**...**` raw Markdown → 正常文本/强调组件

### 禁用词（营销/口语/夸张）

`超级`、`无缝`、`丝滑`、`魔法`、`神器`、`黑科技`、`王炸`、`颠覆`、`革命性`、`赋能`、`解锁`、`释放`、`终极`、`极致`、`完美`、`领先`、`唯一`、`最强`、`顶级`、`秒级`、`零门槛`、`全自动`、`智能化`、`AI 赋能`、`爽`、`牛逼`、`搞定`、`咱们`、`小伙伴`、`主人`、`喵`、`汪`、`悄悄`、`偷偷`、`放心`、`一键`、`开箱即用`。

> 固定功能名（如“一键安装”如果产品正式名称就是它）可保留，但普通按钮一律写“安装”。

### 句式规则

- 无 greeting（`欢迎回来`、`你好`、`准备好了吗`）。
- 无感叹号；无 `!!`；短标签/按钮不带句号。
- placeholder 不写 `Search anything...`；写 `搜索`。
- 不用 `+12%!!`；写 `+12% vs 上月`。
- 不写未经验证的 `10,000+ teams`、`99.9%`、`最快`。
- 数字统一格式、tabular-nums；不写 `$123,456` 这类假数据。
- 标签 sentence case；不用 `NAVIGATION` 式全大写宽字距（代码/缩写除外）。
- 不用斜体强调；用字重/颜色。

### 不清理

- 用户消息、模型输出、导入的 Markdown/HTML；
- 插件/市场第三方描述；
- 代码标识符、路径、日志、测试。

---

## 组件规则

1. 颜色只用 token；禁止新增 hex/rgb 到页面。
2. 按钮/输入/选择器/弹窗/菜单用共享组件；不新写 `.btn` 变体。
3. 状态用 `StatusDot` + 文字；不用彩色 pill。
4. 统计数字用 primary text；只有异常用 semantic color。
5. 列表行统一高度/间距；不要每页一套。
6. 空/加载/错误状态统一 `EmptyState` / `Skeleton` / `ErrorState`。
7. 表格/列表数字用 tabular-nums；单位统一。
8. 模态/抽屉必须能被 Escape 关闭，焦点回到触发点。
9. 任何新样式必须在 dark + light 两套截图。

---

## 禁止

- 用新装饰替代旧装饰（噪点、发光、玻璃、渐变）。
- 为了“统一”删功能/合并入口/改交互。
- 改 store/IPC/工具调用/权限/事件。
- 改 `data-testid`、`role`、键盘行为。
- 在 UI 文案里写 Markdown。
- 用 emoji 当图标/状态。
- 覆盖用户 PPT/文档内容配色。
- 把游戏/用户内容/插件像素场景强行改成工作台风格（插件 chrome 要统一，内容可保留）。
