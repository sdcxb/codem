# Codem Mobile 设计基线（Flutter 原生客户端）

> 状态：N0 设计基线 · 2026-11-03
> 目标：把 Codem 桌面「高信号、低装饰、炭黑+紫」的工作台美学，翻译成手机的单栏聚焦形态。
> 原则：**信息高密度、操作低密度、渐进披露、低装饰高反馈。**

## 1. 设计 DNA（从桌面继承什么）

| 维度 | 桌面事实 | 移动端继承 |
|---|---|---|
| 底色 | 深炭黑（`#0F1217`），不是蓝黑 | 同色；表面分 3 档：`#0F1217` / `#1A1D23` / `#20242C` |
| 主色 | 紫罗兰只做焦点/发送/选中（`#7C6CF0`） | 同色；不做大面积紫色背景 |
| 材质 | 扁平 + 1px 细线 + 极轻阴影 | 不用玻璃拟态、不用大渐变；用表面色差补层级 |
| 排版 | 左对齐、重标题、mono 元数据 | 正文 16sp / 行高 1.6；标题 600；元数据 mono 12sp |
| 形状 | 8–14px 圆角，控件偏小 | 10–16px；Sheet 顶部 24；不做全屏 24px 圆角 |
| 图标 | 线性图标、单色、16–18px | 同一套 Lucide；视觉 20–22，点击区 ≥44 |
| 布局 | 左栏项目/会话 + 中栏对话 + 右栏改动/上下文 | 单栏聚焦 + 底部 Sheet；不缩成三栏 |
| 状态 | 小圆点、细徽标、低饱和 | 小圆点 + 文字；不只靠颜色 |

**不继承**：13–14px 正文、56px 行高、三栏并置、hover 提示、右键菜单、小点击区。

## 2. 手机端密度模型（三层）

### 2.1 扫视层（会话列表）

- 行高 **72**，两行：标题 16/600 + 项目·时间 mono 12；
- 一屏 5–7 条；
- 当前会话：左 2px 紫线 + 8% 紫底 + 字重加粗；
- 主操作只有「新会话 / 继续」，其余进 overflow。

### 2.2 聚焦层（聊天）

- 正文 **16sp / 行高 1.6**，最大宽度 680；
- 用户消息：右侧、紫 10% 底、圆角 16；
- 助手消息：无气泡、全宽；
- 工具卡：默认折叠一行摘要；运行中左侧紫线呼吸；
- 代码块 12–13sp mono，横向滚动；
- 一屏一个主操作：发送/停止；审批出现时审批优先。

### 2.3 详情层（Sheet）

- 改动/文件/上下文/设置 Sheet 可以高密度：12sp mono、表格、diff；
- 关闭/行点击区 ≥44；
- 可搜索、可复制、可滚动。

## 3. Tokens

### 3.1 Dark

```
canvas        #0F1217
surface       #1A1D23
surfaceRaised #20242C
hairline      rgba(255,255,255,0.06)
textPrimary   #E8E8EC
textSecondary #9A9AA3
accent        #7C6CF0
accentPressed #6555E0
userBubble    rgba(124,108,240,0.10)
codeBg        #0B0D11
success       #4ADE80
warning       #F5C26B
danger        #F87171
```

### 3.2 Light

```
canvas        #FAFAF9
surface       #FFFFFF
surfaceRaised #F4F4F2
hairline      #E7E5E4
textPrimary   #1A1A1A
textSecondary #6B6B6B
accent        #6555E0
accentPressed #5546C8
userBubble    #F1EFFE
codeBg        #F6F6F4
```

### 3.3 字体

- UI：`AlimamaFangYuanTiVF`（桌面同款；打包前子集化并确认商用授权），fallback `PingFang SC`/`Noto Sans SC`/`Inter`。
- 代码/元数据：`JetBrains Mono` 或 `SF Mono`。
- 字阶：Display 32/38、Title 24/30、Section 18/26、Body 16/24、Meta 12/16、Code 13/20。
- 中文标题字距 -0.3；正文不用全大写。

### 3.4 间距/圆角

- 间距：4 / 8 / 12 / 16 / 24 / 32。
- 圆角：10（小控件）/ 14（卡片）/ 16（输入卡）/ 24（Sheet 顶部）。
- 触控：最小 44×44；主要按钮高 48。

## 4. 关键页面

### 4.1 首页

```
┌──────────────────────────────┐
│ Codem              ● 我的 PC │
│ ┌ 全部项目 ▾ ┐               │
│                              │
│ 最近                          │
│ ┃ 修复登录态丢失              │
│ ┃ codem/app · 2 分钟前        │
│   重构支付回调                │
│   api/pay · 昨天              │
│                              │
│        [ + 新会话 ]           │
└──────────────────────────────┘
   会话        项目        设置
```

- 顶部只放字标 + 主机状态 pill；项目筛选一行横向 chip。
- 会话行 72；活跃项三重编码。
- 底部导航 3 个；进入聊天后隐藏底栏。
- 新会话为底部悬浮 pill。

### 4.2 聊天

- AppBar：返回 + 标题 + 连接状态；模型/主机收进「更多」。
- 压缩/系统提示：一行 12sp 灰字 + 详情。
- 用户消息右紫底；助手无气泡；工具卡折叠；审批卡在 Composer 上方。
- Composer：圆角 16；附件、@、模型 chip、48×48 紫色发送。
- 键盘弹起：Composer 上移，列表保持位置。

### 4.3 Sheet

- 改动 / 文件 / 上下文：顶部 Segmented；等宽表格；行点击 44。
- 主机：本机/远程 Segmented、设备行（在线点/延迟/最后在线）。
- 模型：列表 + 当前项紫勾。
- 设置：分组卡片；开关整行可点。

## 5. 动效与反馈

- 150–220ms，`easeOutCubic`；不弹簧回弹。
- 页面转场：淡入 + 8px 上移。
- Sheet：上滑 240ms；scrim 40%。
- 发送/审批：轻触觉；流式光标 1s 闪烁；工具运行紫线 1.6s 呼吸。
- 支持「减少动态效果」。

## 6. 反模式

- 不做桌宠/像素人/二次元插画；
- 不做玻璃拟态、彩虹渐变、发光边框；
- 不用 Material 默认紫/默认圆角/默认 AppBar；
- 不把桌面三栏缩成手机三栏；
- 不把正文放大到 18–20 的消费级尺寸；
- 不用大面积紫色卡片；
- 不用 emoji 当图标；
- 不依赖 hover/右键；
- 不只靠颜色表达状态。

## 7. Flutter 落地

- `lib/design/tokens.dart`：颜色/间距/圆角/字阶/动效，`ThemeExtension`。
- `lib/design/theme.dart`：`CodemTheme.dark()` / `light()`。
- `lib/design/components/`：`CodemAppBar`、`HostPill`、`SessionRow`、`MessageView`、`ToolCard`、`ApprovalCard`、`Composer`、`CodemSheet`、`ChangeList`、`ContextPanel`。
- 图标：`lucide_icons`。
- 字体：Alimama 子集 + fallback；代码 JetBrains Mono。
- Golden Test：首页/聊天/Sheet × 深/浅。
- `Design Gallery` 路由：不接后端，先真机看 token/组件。

## 8. 验收（N0）

1. 深浅两套主题在 360/390/430dp 下不溢出；
2. 所有可点击元素 ≥44×44；
3. 正文 16sp、元数据 ≥12sp、对比度 ≥4.5:1；
4. 首页/聊天/Sheet 三屏真机截图；
5. Golden 测试通过；
6. 单手 5 任务（继续会话、发消息、审批、看 diff、切主机）可用。
