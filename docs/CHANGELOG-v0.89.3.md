# v0.89.3 - 宠物窗口零漂移 + 多页打包 + 模型持久化修复

> 本次更新聚焦宠物窗口体验优化和模型设置持久化修复。通过 Vite 多页打包将宠物窗口 JS Bundle 从 3.4MB 降至 5.7KB，使用 Win32 SetWindowPos 单次原子调用实现零漂移的锚点 resize，并修复了应用重启后模式/模型恢复不正确的问题。

## 🚀 核心改进

### 一、宠物窗口多页打包 + 内存优化

**问题**：宠物窗口加载了主应用的 3.4MB JS Bundle，导致 WebView2 宠物进程内存虚高。

**方案**：Vite 多页打包（Multi-page Build），为宠物窗口创建独立轻量入口。

- 新增 `pet.html` + `src/pet-main.tsx` — 宠物窗口专用入口，仅加载 React + PetWindowApp + 最小 CSS
- `src/styles/pet-window.css` — 宠物窗口专用样式（透明背景 + 基础重置，不加载 8400 行主 CSS）
- `vite.config.ts` — `rollupOptions.input` 新增 `pet.html` 入口
- **JS Bundle 体积从 3.4MB 降至 5.7KB（-99.8%）**，WebView2 宠物进程内存大幅下降

### 二、宠物窗口锚点 resize（零漂移）

**问题**：气泡出现/消失时窗口尺寸变化导致宠物精灵图在屏幕上产生漂移。

**方案**：以精灵图水平中心 + 底部为锚点，使用单次 Win32 `SetWindowPos` 原子设置位置和尺寸。

- **Rust 端** `resize_pet_window_anchored` 命令：
  - 同步读取当前窗口物理位置和尺寸
  - 计算锚点 = 窗口水平中心 + 窗口底部
  - 单次 `SetWindowPos` 调用同时设置新位置和新尺寸（`SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS`）
  - 全程零异步间隙，零 `tauri://move` 事件竞态
- **前端** `PetWindowApp.tsx`：
  - 只传目标 `width/height` 给 Rust，不再计算位置
  - canvas `measureText` 精确测量气泡文本宽高（逐字符换行，兼容中英文混合）
  - 初始尺寸 = 精灵图宽 × (精灵图高 + 预留最小气泡高度)
  - 事件气泡出现时窗口动态扩展到精确容纳文本，消失后缩回紧凑尺寸

### 三、模型/模式持久化修复

**问题**：应用重启后，对话框顶部模型下拉列表默认显示 `mimo-v2.5-pro`，即使上次退出时使用的是 API 模式 + DeepSeek。

**根因**：
1. `App` 组件首次渲染时 SQLite 异步初始化尚未完成，`getSettingJSON` 读到空设置，fallback 到 `mimo-v2.5-pro`
2. `configureEngine` 在 `useEffect` 中立即调用时 DB 也未就绪，读到 `null` 不做任何操作
3. 应用关闭时 DB 使用 500ms 防抖保存，如果进程快速退出，最后一次写入丢失

**修复**：
- `App.tsx` — DB 初始化完成后（`initDatabase` + `migrateFromLocalStorage` 之后）同步调用 `configureEngine()`，确保正确读取持久化的模式/模型
- `App.tsx` — `close-requested` 事件 + `handleCloseChoice` 中调用 `flushDatabase()`，确保防抖写入在应用退出前立即刷盘
- `src/core/storage/index.ts` — 导出 `flushDatabase`

### 四、宠物状态扩展

- `PetOverlay.tsx` — `STATE_LABELS` 补全 `waiting` / `review` / `waving` 三个状态

## 🔧 技术细节

### 新增文件

| 文件 | 说明 |
|------|------|
| `pet.html` | 宠物窗口 HTML 入口 |
| `src/pet-main.tsx` | 宠物窗口 React 轻量入口（仅 React + PetWindowApp） |
| `src/styles/pet-window.css` | 宠物窗口专用最小样式 |
| `src/core/pet/pet-animation-utils.ts` | 宠物动画工具函数 |
| `docs/CHANGELOG-v0.89.3.md` | 本文件 |

### 修改文件

| 文件 | 说明 |
|------|------|
| `vite.config.ts` | 多页打包配置（rollupOptions.input 新增 pet.html） |
| `src-tauri/Cargo.toml` | 版本号 0.89.0 → 0.89.3；新增 `windows` crate 依赖 |
| `src-tauri/src/lib.rs` | 新增 `resize_pet_window_anchored` + `set_pet_window_geometry` 命令 |
| `src/components/PetWindowApp.tsx` | 重写为锚点定位策略 + canvas 测量 |
| `src/components/PetOverlay.tsx` | 补全 waiting/review/waving 状态 |
| `src/components/ChatPanel.tsx` | 模型列表过滤逻辑修正 |
| `src/components/ModelProfilePanel.tsx` | 模型配置面板布局修复 |
| `src/App.tsx` | DB 就绪后 configureEngine + 关闭时 flushDatabase |
| `src/core/storage/index.ts` | 导出 flushDatabase |
| `src/core/pet/pet-manager.ts` | 宠物管理器适配 |
| `src/core/pet/pet-store.ts` | 宠物状态 store 适配 |
| `src/core/pet/pet-types.ts` | 宠物类型定义扩展 |
| `src/core/knowledge/local-embedding.ts` | WASM 路径适配 |
| `src/core/storage/index.ts` | 导出 flushDatabase |
| `src/main.tsx` | 入口适配 |
| `package.json` / `tauri.conf.json` | 版本号 0.89.0 → 0.89.3 |

### 新增 Rust 依赖

- `windows = { version = "0.61", features = ["Win32_UI_WindowsAndMessaging", "Win32_Foundation"] }` — Win32 API SetWindowPos

## 📦 升级信息

- **版本**：0.89.0 → 0.89.3
- **新增依赖**：`windows` crate（Rust 端 Win32 API）
- **兼容性**：向后兼容
- **平台支持**：Windows 10/11

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 下载: https://github.com/sdcxb/codem/releases/tag/v0.89.3
