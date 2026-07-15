# 非分段对话模式开发进度

## 目标
实现对话回答风格模式切换：分段模式（当前）和统一模式（新）。

## 设计决策
- 分隔线：细分割线区分不同 iteration
- reasoning：默认折叠
- 按钮位置：ChatPanel header
- 按钮图标：使用 📋（列表模式）和 📄（连续模式），避免与已有图标混淆

## 任务清单

### 1. store.ts — displayMode 状态 ✅
- `useAppStore` 新增 `displayMode: "segmented" | "unified"` 
- 默认值 `"segmented"`
- `setDisplayMode` action

### 2. i18n/lang.ts — 字符串 ✅
- `S.chat.displayModeSegmented` / `displayModeUnified`

### 3. App.tsx — runAgenticLoop 分流 ✅
- `case "start"` 中检查 `displayMode`
- unified 模式：不创建新 assistantMsgId，继续往同一条消息追加
- content 中插入 `\n---\n` 分隔标记
- reasoning 累积到同一条消息
- toolCall 累积到同一条消息的 toolCalls 数组

### 4. MessageBubble.tsx — unified 渲染 ✅
- 检测 message content 中的 `---` 分隔线，渲染为细分隔线
- reasoning 面板默认折叠（unified 模式）
- toolCalls 全部渲染在一个列表中

### 5. ChatPanel.tsx — 切换按钮 ✅
- header 中添加模式切换按钮
- 使用 📋/📄 图标
- 切换时保存到 store + settings

### 6. styles.css — 样式 ✅
- `.unified-separator` 分隔线样式
- `.display-mode-toggle` 按钮样式

### 7. 编译+测试 ✅
- vite build 通过
- vitest 测试通过

## 进度
- [x] 2026-07-15 全部完成，编译通过，测试通过
