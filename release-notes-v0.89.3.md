# v0.89.3 — 宠物窗口零漂移 + 多页打包 + 模型持久化修复

## 🚀 核心改进

### 宠物窗口多页打包 + 内存优化
- Vite 多页打包，宠物窗口 JS Bundle 从 3.4MB 降至 5.7KB（-99.8%）
- WebView2 宠物进程内存大幅下降

### 宠物窗口锚点 resize（零漂移）
- 单次 Win32 `SetWindowPos` 原子设置位置+尺寸，精灵图屏幕位置完全不动
- canvas `measureText` 精确测量气泡文本宽高，动态扩展窗口
- 初始尺寸紧凑（精灵图宽 × 精灵图高 + 预留最小气泡高度），气泡出现时动态扩展

### 模型/模式持久化修复
- 修复应用重启后默认显示 `mimo-v2.5-pro` 而非上次使用的 API 模式 + DeepSeek 的问题
- DB 初始化完成后同步调用 `configureEngine()`，正确恢复持久化的模式/模型
- 应用关闭时调用 `flushDatabase()`，确保防抖写入在退出前立即刷盘

### 宠物状态扩展
- 补全 `waiting` / `review` / `waving` 三个宠物状态

## 📦 安装包

- `Codem_0.89.3_x64-setup.exe` — NSIS 安装包（推荐）
- `Codem_0.89.3_x64_en-US.msi` — MSI 安装包

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 完整更新日志: https://github.com/sdcxb/codem/blob/master/docs/CHANGELOG-v0.89.3.md
