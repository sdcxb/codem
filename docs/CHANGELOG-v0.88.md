# v0.88.0 - 桌面宠物系统 + 悬浮气泡通知

> 本次更新引入完整的桌面宠物系统，集成开源项目 Petdex (MIT License) 的宠物包格式和市场 API。宠物以独立透明窗口运行在桌面上，响应 Agent 工作状态实时切换动画，支持悬浮气泡通知、右键菜单、大小调节等功能。涉及 20+ 个新增/修改文件，+3000 行代码。

## 🐾 核心功能

### 一、桌面宠物系统（基于 Petdex 集成改造）

**独立窗口架构：**
- 宠物运行在 Tauri 创建的独立透明、无边框、置顶窗口中
- 独立于主应用窗口，主窗口最小化/隐藏时宠物仍然可见
- 透明背景 + `shadow(false)` 移除 Windows DWM 黑色边框
- 通过 Tauri IPC 事件实现主窗口与宠物窗口的状态同步

**精灵图动画引擎（`PetSprite.tsx`）：**
- 基于 CSS `background-position` 帧动画渲染精灵图
- 每帧 192×208px，8 列网格布局，`requestAnimationFrame` 按帧间隔切换
- `backgroundPosition` 与 `backgroundSize` 统一缩放坐标系，修复画面截断拼接问题
- 支持 idle / thinking / working / happy / sad / sleeping 六种动画状态

**Agent 生命周期映射（`pet-store.ts`）：**
- `idle`：Agent 空闲
- `thinking`：Agent 连接中 / 流式输出文本
- `working`：Agent 执行工具调用
- `happy`：Agent 成功完成（2 秒后回 idle）
- `sad`：Agent 出错（2 秒后回 idle）
- `sleeping`：空闲超 60 秒自动进入

**宠物市场（`PetMarketDialog.tsx`）：**
- 接入 Petdex 市场 Manifest API，浏览宠物目录
- 宠物卡片展示：CSS `steps()` 步进动画预览（preview.webp 单行条带）
- 三层图片加载回退：直连 → Rust 代理下载 → data URL
- 一键安装/卸载，搜索过滤，安装进度展示

**宠物管理（`pet-manager.ts`）：**
- 宠物包安装到 `~/.codem/pets/<slug>/` 目录
- `pet.json` 元数据解析 + `spritesheet.png` 精灵图加载
- 精灵图转 Data URL 传输（避免文件协议跨域问题）
- 安装/卸载/列表/激活全流程

### 二、悬浮气泡通知

- **气泡出现时机**：Agent 任务完成（区分"任务做完了！"和"回复完成了！"）、右键查看 Token
- **自定义称呼**：自动读取设置中「想让我怎么叫你」配置，气泡前缀拼接称呼（如"主人，任务做完了！"）
- **高度自适应**：`useLayoutEffect` 同步测量气泡 DOM 实际高度，窗口随内容动态扩展
- **增量位置调整**：气泡出现/消失时用 delta 增量计算窗口位置，宠物视觉保持静止
- **气泡动画**：`petBubbleIn` 关键帧动画（淡入 + 上移 + 缩放）
- **气泡小尾巴**：CSS 三角形指向宠物方向

### 三、右键原生菜单

- 改用 Rust 原生 `MenuBuilder` 弹出菜单，不受窗口边界裁剪
- 菜单项：宠物名称（标题）、关闭宠物、置顶切换、重置位置、查看剩余 Token
- 右键菜单事件通过 Tauri `app.emit` 转发到前端处理

### 四、设置面板集成

- 新增「宠物」设置 Tab（🐾 图标），位于多模态下方
- **启用/禁用开关**：一键启动/关闭桌面宠物
- **大小滑轨**：0.2x ~ 1.0x 缩放比例调节
- **透明度滑轨**：0.3 ~ 1.0 透明度调节
- **宠物市场入口**：浏览并安装新宠物
- **已安装宠物列表**：选择激活宠物、卸载
- 启动按钮三套主题自适应对比度

### 五、Token 查询功能

- 右键菜单「查看剩余 Token」→ Rust 发送 `pet-check-tokens-request` 事件
- 主窗口监听事件，调用 `engine.context.calculateBudgetFromMessages` 获取 Token 预算
- 气泡显示：`称呼，剩余 Token: 45,231 / 200,000（已用 154,769）`
- 窗口宽度自适应扩展，长文本不溢出

## 🔧 技术细节

### Rust 后端（`src-tauri/src/lib.rs`）

- `create_pet_window`：创建透明窗口，`.shadow(false)` + `.resizable(true)` + `.visible(true)`
- `close_pet_window`：关闭宠物窗口
- `show_pet_menu`：原生右键菜单，支持光标位置和宠物名称参数
- `on_menu_event`：处理菜单项点击，通过 `app.emit` 转发到前端
- 新增 `core:window:allow-set-shadow` capability

### 前端架构

- `PetWindowApp.tsx`：宠物窗口根组件，窗口尺寸/位置/气泡联动
- `PetSprite.tsx`：精灵图帧动画渲染（memo 优化）
- `PetMarketDialog.tsx`：市场浏览对话框
- `PetOverlay.tsx`：宠物覆盖层（备用方案）
- `pet-store.ts`：Zustand 状态管理，Agent 事件 → 宠物状态映射
- `pet-types.ts`：类型定义（PetDefinition / PetState / PetSettings / MarketPet）
- `pet-manager.ts`：本地宠物安装/加载/卸载
- `pet-market-client.ts`：Petdex 市场 API 客户端

### 其他改动

- `index.html`：`<title>` 更新为 "Codem"
- `main.tsx`：添加 `pet-window-mode` CSS class，透明背景
- `styles.css`：宠物窗口透明背景样式
- `App.tsx`：集成宠物状态同步 + 气泡通知 + Token 查询
- `THIRD_PARTY_NOTICES.md`：Petdex MIT License 集成声明
- `src/test/pet-system.test.ts`：宠物系统单元测试

## 📦 升级信息

- **版本**：0.87.0 → 0.88.0
- **新增依赖**：无（全部复用已有依赖）
- **新增文件**：`PetWindowApp.tsx`、`PetSprite.tsx`、`PetMarketDialog.tsx`、`PetOverlay.tsx`、`pet-store.ts`、`pet-types.ts`、`pet-manager.ts`、`pet-market-client.ts`、`THIRD_PARTY_NOTICES.md`、`pet-system.test.ts`
- **兼容性**：向后兼容
- **平台支持**：Windows 10/11

## 🔗 链接

- GitHub: https://github.com/sdcxb/codem
- 下载：https://github.com/sdcxb/codem/releases/tag/v0.88.0
