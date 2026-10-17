# 运行中追加：可见性 + 附件（真机取证）

日期：2026-10-18
构建：本地 `tauri build` 产物 `Codem_1.16.324_x64-setup.exe`（静默安装）
驱动：WebView2 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）

## 用户报的两个缺陷

1. 对话执行中追加一句话、点「立刻引导」之后，界面上**什么都看不到**，刷新后更是消失。
2. 追加时贴了一张图，模型回复「没看到图片」。

## 根因（代码事实）

- 引导消息在消费点被拼成一条**只活在本次请求里**的临时 user 消息（不落库、不建索引），
  唯一的可见物是状态栏气泡，而"立刻引导"又会把它删掉 ⇒ 三个"看不见"叠加。
- `onSendGuidance(message)` 只有文本参数，附件在 `ChatPanel` 那一层就被丢掉；
  而图片块是由 `messagesToLLMMessages` 从**落库消息的 attachments** 转出来的
  ⇒ 不落库就永远没有图片。

## 修复后的行为（本次取证）

| 步骤 | 取证 | 结果 |
|---|---|---|
| 流式中输入文字 | `queued-with-attachment.png` | 状态栏条目显示「待接收」+ 附件缩略 + 文件名 |
| 点「立刻引导」 | `injected-badge-and-image.png` | 对话流出现一条带 ⚡「运行中追加」徽标的 user 消息，**图片红色 IMG 可见**，正文是用户原话（不是注入模板） |
| 刷新窗口 | `after-reload-still-there.png` | 消息仍在（`hasText=true`、徽标 1、附件消息 1） |

## 同一次运行里的量化结果

- 入队条目：`{ n: 1, attach: 1, thumbs: 1 }`（带图片缩略）
- 注入后：`badgeText="运行中追加"`，`attachments=1`，`imgs=1`，状态栏条目归零（已被消费）
- 刷新后：`{ hasText: true, badges: 1, attachMessages: 1 }`

## 边界与诚实说明

- 本次没有验证"视觉模型真的读到了这张图"：端到端取决于当前模型/视觉代理配置。
  能证明的是：附件随消息**落库**，`messagesToLLMMessages` 会把图片转成 `image_url` block
  （判据 `GUIDE-ATT-1`，变异自证：去掉按 id 取回正文 ⇒ 该判据变红）。
- 图是页面内 canvas 生成的 96×96 红底白字（避免把用户数据带进仓库）。
