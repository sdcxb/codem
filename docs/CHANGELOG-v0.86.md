# v0.86.0 - 皮肤系统 + 窗口毛玻璃 + 自定义标题栏

> 本次更新实现了完整的皮肤系统（默认/Hub/梦幻三套皮肤）、Windows Mica 毛玻璃窗口效果、自定义标题栏，以及多处 UI 修复。

![v0.86 更新](https://github.com/sdcxb/codem/raw/master/docs/26720-1.jpg)

## 🎯 核心改进

### 1. 皮肤系统（三套皮肤完整实现）

**皮肤基础设施（Phase 1）：**
- 新增 `ThemeManager` 主题管理器，支持运行时切换皮肤
- 新增 `useSkin` Hook，提供皮肤状态和配置
- CSS 变量分层：默认皮肤变量 → 皮肤覆盖变量 → 主题覆盖变量
- `data-skin` 属性驱动 CSS 选择器，零 JS 重渲染

**三套皮肤：**
- **默认皮肤**：GitHub 暗色风格，紫色强调色，完全不透明背景
- **Hub 皮肤**：深色科技感，橙色强调色，三栏布局（顶部导航 + 左侧栏 + 主面板 + 右侧栏），对标 Codex Hub
- **梦幻皮肤（Dream）**：浅色梦幻氛围，粉色强调色，支持自定义背景图 + 装饰元素 + 毛玻璃面板，透明背景透出 Mica

**皮肤切换 UI（Phase 2）：**
- 新增 `SkinSelector` 组件，侧栏底部一键切换皮肤
- 皮肤选择持久化到 SQLite
- 梦幻皮肤支持配置：背景图、强调色提取、卡片透明度、模糊度、装饰元素开关

### 2. 窗口毛玻璃效果（Windows Mica）

**架构改动：**
- `tauri.conf.json`：`transparent: true` + `decorations: false`
- Rust 端 `window-vibrancy` crate：Win11 Mica（壁纸色调混合）+ Win10 Acrylic fallback
- macOS 端：`NSVisualEffectMaterial::HudWindow` 原生 vibrancy

**Mica 生效原理：**
- `decorations: false` 移除系统边框/标题栏 → WebView2 窗口完全透明 → Mica 透过透明区域可见
- 默认/Hub 皮肤：标题栏透明（Mica 可见），内容区不透明
- 梦幻皮肤：整个窗口透明（Mica + 背景图叠加）

**性能说明：**
- Mica 是 DWM 层静态色调混合，专为低功耗设计，GPU 开销极小
- 相比 CSS `backdrop-filter: blur()` 实时模糊，Mica 几乎零开销

### 3. 自定义标题栏

- 新增 `TitleBar.tsx` 组件：`data-tauri-drag-region` 支持拖拽窗口
- 最小化 / 最大化 / 关闭三个按钮，SVG 图标
- 最大化状态实时同步（500ms 轮询 `isMaximized`）
- 三套皮肤各有标题栏样式（透明背景 + 皮肤主题色）
- 关闭按钮 hover 红色（Windows 标准）
- `capabilities/default.json` 新增窗口控制权限（minimize/maximize/close/start-dragging 等）

### 4. Hub 皮肤 UI 修复

**消息气泡双边框修复：**
- 问题：`.message`（外层 flex 容器）和 `.message-content`（内层）都有背景和边框，导致双重边框
- 修复：`.message` 设为 `transparent !important` + `border: none !important`，只给 `.message-content` 设置背景和边框

**右侧边栏响应式修复：**
- 媒体查询断点从 `max-width: 1200px` 改为 `max-width: 1024px`，确保默认窗口尺寸下右侧栏可见

**Hub 背景不透明：**
- Hub 背景变量保持完全不透明（`#0a0a0a` 等纯色），只有标题栏透明

### 5. 梦幻皮肤 UI 修复

**消息气泡双边框修复：**
- 移除 `.message-bubble` 和 `.message` 的外层边框和阴影
- 只给 `.message-content` 设置毛玻璃背景 + 边框 + 圆角

**设置面板/模态框磨砂效果：**
- `.settings-panel`、`.project-manager`、`.config-editor`、`.modal-editor` 强制 0.95 不透明 + 20px blur
- 暗色梦幻模式下使用 `rgba(30, 30, 46, 0.95)` 背景

**技能选择弹窗毛玻璃：**
- `.skill-picker-popup` 添加 `backdrop-filter: blur(20px)` + 0.95 不透明背景
- 通用下拉菜单 `.dropdown-menu`、`.popover` 等同步添加毛玻璃效果

### 6. 默认皮肤背景不透明

- 所有背景变量 alpha 从 `0.85`/`0.90` 改为 `1`（完全不透明）
- 只有标题栏区域透出 Mica，内容区保持不透明

## 📦 升级信息

- **版本**：0.85.0 → 0.86.0
- **新增依赖**：无（`window-vibrancy` 已在 v0.70 引入）
- **兼容性**：向后兼容
- **平台支持**：Windows 10（Acrylic）/ Windows 11（Mica）/ macOS（NSVisualEffectView）

## 🧪 测试

- 全部 1482 个测试通过
- TypeScript 编译通过
- Rust cargo check 通过

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 下载：https://github.com/sdcxb/codem/releases/tag/v0.86.0
