# 皮肤系统设计与开发计划

> 文档创建：2026-07-19  
> 目标：实现三套皮肤切换（默认 / Hub / 梦幻），梦幻皮肤支持上传背景图自适应主题色

---

## 一、对标项目分析（Codex-Dream-Skin）

### 1.1 实现原理

Codex-Dream-Skin 通过 **CDP（Chrome DevTools Protocol）注入** 为 Codex 桌面端换肤，核心流程：

```
用户运行脚本 → 启动 Codex（带 --remote-debugging-port=9335）
→ 脚本通过 HTTP 获取 /json/list 页面目标
→ WebSocket 连接 ws://127.0.0.1:9335/devtools/page/{id}
→ Runtime.evaluate 注入 JS payload（含 CSS + 背景图 base64 + 主题配置）
→ Page.addScriptToEvaluateOnNewDocument 注册早期注入（页面刷新前生效）
→ MutationObserver 监听 DOM 变化，确保 Codex shell 就绪后注入
```

### 1.2 核心技术点

| 技术 | 说明 |
|------|------|
| CDP WebSocket | 通过 `ws://127.0.0.1:{port}/devtools/page/{id}` 连接渲染进程 |
| Runtime.evaluate | 注入完整的 JS payload（CSS + 图片 + 配置） |
| Page.addScriptToEvaluateOnNewDocument | 页面加载前注册注入脚本，实现持久化 |
| theme.json | 主题配置文件（id/name/image/appearance/art/palette） |
| 背景图 base64 | 图片转 data URL 直接注入 CSS 变量 `--dream-art` |
| CSS 变量 | `--dream-*` 系列变量定义颜色/阴影/透明度 |
| 安全区 | 根据 `art.focusX/focusY` 和 `art.safeArea` 调整内容布局 |
| 任务模式 | 首页全屏背景，任务页降低干扰（ambient/banner/off） |

### 1.3 Dream-Skin CSS 架构

```css
:root.codex-dream-skin {
  --dream-accent: oklch(0.66 0.15 18);         /* 强调色 */
  --dream-canvas: color-mix(...);               /* 画布背景 */
  --dream-surface: color-mix(...);              /* 表面层 */
  --dream-sidebar: color-mix(...);              /* 侧栏 */
  --dream-text: oklch(0.25 0.018 30);           /* 主文本 */
  --dream-immersive-edge: color-mix(...);       /* 沉浸式边缘 */
  /* ... 20+ CSS 变量 */
}

html.codex-dream-skin body {
  background: var(--dream-canvas) !important;
  background-image: var(--dream-art) !important;  /* 背景图 */
  background-size: cover !important;
}

html.codex-dream-skin .composer-surface-chrome {
  backdrop-filter: blur(14px) saturate(1.06) !important;  /* 毛玻璃 */
  background: color-mix(in oklab, var(--dream-surface-raised) 95%, transparent) !important;
}
```

### 1.4 我们的优势

由于 **我们是自己的应用**（Tauri + React），不需要 CDP 注入：
- ✅ 直接在 React 层管理主题状态
- ✅ CSS 变量直接写入 `:root`，无需 `!important` 覆盖
- ✅ 组件可直接读取主题配置，无需 DOM hack
- ✅ 背景图直接通过 React state 管理，无需 base64 注入
- ✅ 主题切换即时生效，无需重启或注入脚本

---

## 二、三套皮肤设计

### 2.1 默认皮肤（Default）

**当前样式**，保持不变。
- 暗色：`#0d1117` 背景，紫色 `#7c6cf0` 强调色
- 亮色：`#ffffff` 背景，紫色 `#6b5ce7` 强调色
- 两栏布局：左侧栏 + 右侧聊天区
- CSS 变量：`--bg-primary`、`--text-primary`、`--accent` 等

### 2.2 Hub 皮肤（1.html 样式）

**设计风格**：深色科技感 Hub 界面

| 要素 | 值 |
|------|-----|
| 背景色 | `#0a0a0a`（极深黑） |
| 面板色 | `#121212`（深灰） |
| 卡片色 | `#1c1c1e`（卡片灰） |
| 强调色 | `#ff6b00`（橙色） |
| 强调悬停 | `#e56000` |
| 主文本 | `#e0e0e0` |
| 次文本 | `#888888` |
| 边框 | `#2a2a2a` |
| 布局 | 三栏：左导航(260px) + 中内容 + 右侧栏(300px) |
| 顶部 | 50px 导航栏（Logo + 导航链接 + 操作区） |
| 卡片 | 左侧 4px 橙色边框，12px 圆角 |
| 代码块 | `#050505` 背景，`#a5d6ff` 代码色 |
| 输入框 | 橙色边框，12px 圆角 |
| 滚动条 | 6px 宽，`#333` 拇指 |

**Hub 皮肤特有组件**：
- **顶部导航栏**：Logo + 导航链接（首页/任务/Skills/Sites/PR/Automations）+ 搜索/通知/设置图标
- **右侧栏**：Agent 状态卡片（120px 头像 + 在线状态）+ 推荐任务列表
- **会话卡片网格**：3 列子卡片，带预览图 + token 统计 + 变更文件数
- **用户档案**：底部固定，带在线状态点 + 系统状态

### 2.3 梦幻皮肤（2.html 样式）

**设计风格**：浅色梦幻氛围感，支持背景图

| 要素 | 值 |
|------|-----|
| 应用背景 | `#fdf5f7`（粉白） |
| 主区域 | `#ffffff`（纯白，背景图覆盖） |
| 强调色 | `#e88c9a`（粉色） → **可从背景图动态提取** |
| 强调浅 | `#fce8eb` |
| 主文本 | `#6c474d` |
| 次文本 | `#a88a8f` |
| 浅文本 | `#d6b8be` |
| 边框 | `#f7dee2` |
| 卡片背景 | `rgba(255, 255, 255, 0.65)` + `backdrop-filter: blur(12px)` |
| 布局 | 两栏：左侧栏(220px) + 右侧主区域（背景图 + 毛玻璃卡片） |
| 标题 | `Dancing Script` 手写字体 64px |
| 装饰 | 花瓣图标（FontAwesome pagelines）左上右下浮动 |
| 拍立得 | 右下角浮动卡片（背景图缩略图 + 文字） |
| 输入框 | 毛玻璃 + 粉色阴影 `0 4px 12px rgba(232,140,154,0.15)` |
| 发送按钮 | 圆形 36px，粉色背景 + 粉色阴影 |
| 滚动条 | 4px 宽，`#f0cdd2` 拇指 |

**梦幻皮肤特有功能**：
- **背景图上传**：用户上传图片，作为主区域 `theme-container` 的背景
- **自适应主题色提取**：从上传的图片中提取主色调，自动调整 `--accent-pink` 等颜色
- **毛玻璃卡片层**：内容卡片半透明 + `backdrop-filter: blur(12px)`
- **装饰元素**：花瓣图标浮动、手写标题、拍立得照片
- **Polaroid 浮动卡片**：右下角浮动照片卡片

---

## 三、当前功能与皮肤要素映射关系

### 3.1 组件映射表

| 当前组件 | 默认皮肤 | Hub 皮肤 | 梦幻皮肤 |
|----------|----------|----------|----------|
| `Sidebar` | 左侧栏（项目+对话列表） | 左侧栏（导航菜单+项目+历史+用户档案） | 左侧栏（菜单+项目+任务+用户档案） |
| `ChatPanel` | 右侧聊天区 | 中间内容区（卡片式会话+代码块+子卡片网格） | 右侧主区域（背景图+毛玻璃卡片+输入区） |
| `InputArea` | 底部输入框 | 底部输入框（橙色边框+工具下拉+发送按钮） | 底部毛玻璃输入区（粉色+装饰） |
| `MessageBubble` | 消息气泡 | 主卡片 + 子卡片网格 | 毛玻璃卡片 |
| `SettingsPanel` | 设置面板 | 设置面板（Hub 配色） | 设置面板（梦幻配色） |
| `ProjectManager` | 项目管理 | 项目管理（Hub 配色） | 项目管理（梦幻配色） |
| `TerminalPanel` | 终端面板 | 终端面板（Hub 配色） | 终端面板（梦幻配色） |
| —（新增） | — | **TopNavbar** 顶部导航栏 | — |
| —（新增） | — | **RightSidebar** 右侧栏（Agent 状态+推荐任务） | — |
| —（新增） | — | **SessionCardGrid** 会话卡片网格 | — |
| —（新增） | — | — | **BackgroundLayer** 背景图层 |
| —（新增） | — | — | **PolaroidCard** 拍立得浮动卡片 |
| —（新增） | — | — | **ThemeExtractor** 主题色提取器 |

### 3.2 CSS 变量映射

当前项目已有 CSS 变量 → 皮肤系统扩展：

```css
/* 通用变量（所有皮肤共享） */
:root {
  --radius-sm / --radius / --radius-md / --radius-lg / --radius-full;
  --z-dropdown / --z-tooltip / --z-popover / --z-modal / --z-toast;
  --duration-fast / --duration-normal / --duration-slow;
  --transition-color / --transition-all;
}

/* 皮肤变量（通过 data-skin 属性切换） */
[data-skin="default"][data-theme="dark"] {
  --bg-primary: rgba(13, 17, 23, 0.85);
  --accent: #7c6cf0;
  /* ... 当前暗色变量 ... */
}

[data-skin="default"][data-theme="light"] {
  --bg-primary: rgba(255, 255, 255, 0.85);
  --accent: #6b5ce7;
  /* ... 当前亮色变量 ... */
}

[data-skin="hub"] {
  --bg-primary: #0a0a0a;
  --bg-panel: #121212;
  --bg-card: #1c1c1e;
  --bg-input: #151515;
  --accent: #ff6b00;
  --accent-hover: #e56000;
  --text-primary: #e0e0e0;
  --text-secondary: #888888;
  --border-primary: #2a2a2a;
  /* ... Hub 专属变量 ... */
  --hub-navbar-height: 50px;
  --hub-left-sidebar-width: 260px;
  --hub-right-sidebar-width: 300px;
}

[data-skin="dream"] {
  --bg-app: #fdf5f7;
  --bg-main: #ffffff;
  --accent: #e88c9a;           /* 可被动态覆盖 */
  --accent-light: #fce8eb;
  --text-primary: #6c474d;
  --text-secondary: #a88a8f;
  --text-muted: #d6b8be;
  --border-primary: #f7dee2;
  --card-bg: rgba(255, 255, 255, 0.65);
  /* ... 梦幻专属变量 ... */
  --dream-bg-image: none;      /* 背景图 URL */
  --dream-blur: 12px;          /* 毛玻璃模糊度 */
  --dream-shadow: 0 4px 12px rgba(232, 140, 154, 0.15);
}
```

### 3.3 Hub 皮肤布局映射

```
┌─────────────────────────────────────────────────────────┐
│ TopNavbar (50px)                                         │
│ [CODEX HUB]  首页 任务 Skills Sites PR Automations  🔍🔔⚙│
├──────────┬──────────────────────────┬───────────────────┤
│ LeftSidebar│ CenterContent            │ RightSidebar      │
│ (260px)   │                          │ (300px)           │
│           │ ┌──────────────────────┐ │ ┌───────────────┐ │
│ ▶ 正在进行 │ │ MainCard             │ │ │ Agent Card    │ │
│ 🔖 稍后看  │ │ (当前会话/代码块)     │ │ │ (头像+状态)    │ │
│ 📁 项目    │ │                      │ │ └───────────────┘ │
│ 🕐 历史    │ └──────────────────────┘ │                   │
│           │ ┌────┐ ┌────┐ ┌────┐     │ 推荐任务           │
│ ── 项目 ──│ │Sub │ │Sub │ │Sub │     │ ┌─────────────┐  │
│ kin       │ │Card│ │Card│ │Card│     │ │ Task Item   │  │
│ haiker    │ └────┘ └────┘ └────┘     │ └─────────────┘  │
│ kol.red   │                          │ ┌─────────────┐  │
│           │ ┌──────────────────────┐ │ │ Task Item   │  │
│ ── 历史 ──│ │ ChatInput           │ │ └─────────────┘  │
│ 迁移问题   │ │ (📎 描述任务... ▶)   │ │                   │
│           │ └──────────────────────┘ │                   │
│ ── 用户 ──│                          │                   │
│ [Avatar]  │                          │                   │
│ 在线 ●    │                          │                   │
└──────────┴──────────────────────────┴───────────────────┘
```

**映射关系**：
- `Sidebar` → `LeftSidebar`（增加导航菜单区、底部用户档案）
- `ChatPanel` → `CenterContent`（增加主卡片边框、子卡片网格）
- `InputArea` → `ChatInput`（增加工具下拉、橙色发送按钮）
- **新增** `TopNavbar`：Logo + 导航链接 + 操作图标
- **新增** `RightSidebar`：Agent 状态卡片 + 推荐任务列表
- **新增** `SessionCardGrid`：历史会话的卡片网格展示

### 3.4 梦幻皮肤布局映射

```
┌──────────────────────────────────────────────────────────┐
│ TitleBar (38px)  菜单/导航                  — □ ×         │
├──────────┬───────────────────────────────────────────────┤
│ Sidebar  │ MainContent                                    │
│ (220px)  │ ┌─────────────────────────────────────────┐   │
│          │ │ ThemeContainer                           │   │
│ Codex ✦  │ │ ┌──背景图───────────────────────────┐  │   │
│ 🔍       │ │ │  🌸 装饰                           │  │   │
│          │ │ │                                    │  │   │
│ ✏ 新建    │ │ │  Arina Hashimoto (手写体)          │  │   │
│ 🕐 已安排  │ │ │  我们该构建什么？                   │  │   │
│ 🔌 插件    │ │ │                                    │  │   │
│ 📊 站点    │ │ │  ┌──毛玻璃卡片──┐ ┌──卡片──┐      │  │   │
│ 🌿 拉取    │ │ │  │ 探索代码      │ │ 构建功能│      │  │   │
│ 💬 聊天    │ │ │  └──────────────┘ └────────┘      │  │   │
│          │ │ │                                    │  │   │
│ ─ 项目 ─│ │ │  ┌──毛玻璃输入区──────────────┐     │  │   │
│ 有菜星球  │ │ │  │ 📎 随心输入...         ❤  │     │  │   │
│ 穿搭灵感  │ │ │  │ ＋ 完全访问  5.6 Sol 🎤▶│     │  │   │
│          │ │ │  └──────────────────────────┘     │  │   │
│ ─ 任务 ─│ │ │                           ┌──拍立得──┐│   │
│ 看作品    │ │ │                           │ 📷 图片  ││   │
│ 听歌单    │ │ │                           │ 陪伴应援 ││   │
│          │ │ │                           └─────────┘│   │
│ ─ 用户 ─│ │ └────────────────────────────────────────┘   │
│ [Avatar] │ │                                              │
│ 继续设置  │ └──────────────────────────────────────────┘   │
└──────────┴───────────────────────────────────────────────┘
```

**映射关系**：
- `Sidebar` → `Sidebar`（精简菜单 + 粉色图标 + 继续设置卡片）
- `ChatPanel` → `ThemeContainer`（背景图 + 毛玻璃内容层）
- `MessageBubble` → 毛玻璃卡片
- `InputArea` → 毛玻璃输入区（粉色圆形发送按钮 + 装饰元素）
- **新增** `BackgroundLayer`：背景图管理（上传/选择/自适应）
- **新增** `PolaroidCard`：右下角拍立得浮动卡片
- **新增** `ThemeExtractor`：从图片提取主色调的 Canvas 工具

---

## 四、架构设计

### 4.1 主题管理器

```
src/core/theme/
├── index.ts              # 导出入口
├── theme-manager.ts      # ThemeManager 类（单例）
├── theme-extractor.ts    # 从图片提取主色调（Canvas API）
├── theme-storage.ts      # 主题持久化（settings 表）
├── types.ts              # 类型定义
└── presets/              # 预设主题配置
    ├── default.json
    ├── hub.json
    └── dream.json
```

### 4.2 类型定义

```typescript
// src/core/theme/types.ts

type SkinId = 'default' | 'hub' | 'dream';

interface SkinConfig {
  id: SkinId;
  name: string;
  description: string;
  // 布局配置
  layout: {
    leftSidebarWidth: number;
    rightSidebarWidth?: number;       // Hub 专属
    topNavbarHeight?: number;         // Hub 专属
    titleBarHeight?: number;          // Dream 专属
  };
  // 颜色配置（CSS 变量值）
  colors: {
    bgPrimary: string;
    bgSecondary: string;
    bgCard?: string;
    accent: string;
    accentHover: string;
    textPrimary: string;
    textSecondary: string;
    textMuted?: string;
    borderPrimary: string;
    [key: string]: string;            // 允许扩展
  };
  // 梦幻皮肤专属
  dream?: {
    backgroundImage?: string;         // data URL 或文件路径
    blurRadius: number;               // 毛玻璃模糊度
    cardOpacity: number;              // 卡片透明度
    decorations: boolean;             // 是否显示装饰元素
    polaroid: boolean;                // 是否显示拍立得
    scriptFont: boolean;              // 是否使用手写字体
  };
}

interface ThemeState {
  skin: SkinId;
  themeMode: 'light' | 'dark';       // 明暗模式（仅 default 皮肤有效）
  dreamConfig?: DreamConfig;          // 梦幻皮肤的自定义配置
}

interface DreamConfig {
  backgroundImage: string | null;     // base64 或文件路径
  extractedPalette: ExtractedPalette | null;
  customAccent?: string;              // 用户自定义强调色
  blurRadius: number;
  cardOpacity: number;
  decorations: boolean;
  polaroid: boolean;
}

interface ExtractedPalette {
  dominant: string;       // 主色调
  accent: string;         // 强调色
  background: string;     // 背景色
  isDark: boolean;        // 是否暗色图
  palette: string[];      // 完整色板（6色）
}
```

### 4.3 主题色提取器

```typescript
// src/core/theme/theme-extractor.ts

export class ThemeExtractor {
  /**
   * 从图片中提取主色调
   * 使用 Canvas API + 颜色量化算法
   */
  static async extractPalette(imageSrc: string): Promise<ExtractedPalette> {
    // 1. 加载图片到 Canvas（缩放到 100x100 降低计算量）
    // 2. 读取像素数据
    // 3. K-Means 颜色聚类（k=6）
    // 4. 计算主色调、强调色、背景色
    // 5. 判断明暗（平均亮度 > 0.5 为亮色）
    // 6. 返回色板
  }

  /**
   * 计算颜色亮度
   */
  static getLuminance(r: number, g: number, b: number): number {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  /**
   * 将 RGB 转换为 CSS 颜色字符串
   */
  static rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
  }
}
```

### 4.4 Zustand Store 集成

```typescript
// 在 src/store.ts 中扩展
interface AppStore {
  // ... 现有状态 ...
  skin: SkinId;
  dreamConfig: DreamConfig | null;
  setSkin: (skin: SkinId) => void;
  setDreamBackground: (imageSrc: string | null) => Promise<void>;
  setDreamConfig: (config: Partial<DreamConfig>) => void;
}
```

### 4.5 CSS 变量注入

在 `App.tsx` 的根组件中，通过 `useEffect` 监听 `skin` 和 `dreamConfig` 变化，动态设置 `document.documentElement` 的 `data-skin` 属性和 CSS 变量：

```tsx
useEffect(() => {
  const root = document.documentElement;
  root.setAttribute('data-skin', skin);

  if (skin === 'dream' && dreamConfig?.extractedPalette) {
    const { accent, dominant, background, isDark } = dreamConfig.extractedPalette;
    root.style.setProperty('--dream-accent', accent);
    root.style.setProperty('--dream-bg', background);
    root.style.setProperty('--dream-text', isDark ? '#ffffff' : '#6c474d');
    if (dreamConfig.backgroundImage) {
      root.style.setProperty('--dream-bg-image', `url(${dreamConfig.backgroundImage})`);
    }
    root.style.setProperty('--dream-blur', `${dreamConfig.blurRadius}px`);
    root.style.setProperty('--dream-card-opacity', `${dreamConfig.cardOpacity}`);
  }
}, [skin, dreamConfig]);
```

---

## 五、开发计划

### Phase 1：主题基础设施（预计 2-3 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 1.1 创建类型定义 | `src/core/theme/types.ts` | SkinId, SkinConfig, DreamConfig 等 |
| 1.2 创建主题预设 | `src/core/theme/presets/*.json` | 三套皮肤的默认配置 |
| 1.3 实现主题管理器 | `src/core/theme/theme-manager.ts` | 单例，管理切换/持久化 |
| 1.4 实现主题色提取器 | `src/core/theme/theme-extractor.ts` | Canvas K-Means 颜色提取 |
| 1.5 实现主题持久化 | `src/core/theme/theme-storage.ts` | settings 表存储 |
| 1.6 扩展 Zustand Store | `src/store.ts` | 添加 skin/dreamConfig 状态 |
| 1.7 CSS 变量系统扩展 | `src/styles.css` | 添加 `[data-skin="hub"]` 和 `[data-skin="dream"]` 变量块 |
| 1.8 App.tsx 注入 | `src/App.tsx` | useEffect 监听 skin，设置 data-skin 属性和 CSS 变量 |

### Phase 2：皮肤切换 UI（预计 1-2 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 2.1 皮肤选择器组件 | `src/components/SkinSelector.tsx` | 设置面板中的皮肤切换 UI |
| 2.2 集成到设置面板 | `src/components/SettingsPanel.tsx` | 添加"外观 → 皮肤"设置项 |
| 2.3 梦幻背景上传 | `src/components/DreamBgUploader.tsx` | 上传图片 + 预览 + 主题色提取 |
| 2.4 梦幻配置面板 | `src/components/DreamConfigPanel.tsx` | 模糊度/透明度/装饰开关 |

### Phase 3：Hub 皮肤适配（预计 3-4 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 3.1 Hub CSS 样式 | `src/styles/skin-hub.css` | 完整 Hub 皮肤样式 |
| 3.2 TopNavbar 组件 | `src/components/TopNavbar.tsx` | 顶部导航栏 |
| 3.3 RightSidebar 组件 | `src/components/RightSidebar.tsx` | Agent 状态 + 推荐任务 |
| 3.4 SessionCardGrid 组件 | `src/components/SessionCardGrid.tsx` | 会话卡片网格 |
| 3.5 Sidebar Hub 适配 | `src/components/Sidebar.tsx` | 条件渲染导航菜单/用户档案 |
| 3.6 ChatPanel Hub 适配 | `src/components/ChatPanel.tsx` | 主卡片边框 + 子卡片网格 |
| 3.7 InputArea Hub 适配 | `src/components/InputArea.tsx` | 橙色边框 + 工具下拉 |
| 3.8 App.tsx 布局切换 | `src/App.tsx` | Hub 三栏布局条件渲染 |

### Phase 4：梦幻皮肤适配（预计 3-4 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 4.1 Dream CSS 样式 | `src/styles/skin-dream.css` | 完整梦幻皮肤样式 |
| 4.2 BackgroundLayer 组件 | `src/components/BackgroundLayer.tsx` | 背景图管理 |
| 4.3 PolaroidCard 组件 | `src/components/PolaroidCard.tsx` | 拍立得浮动卡片 |
| 4.4 装饰元素组件 | `src/components/DreamDecorations.tsx` | 花瓣/手写标题等 |
| 4.5 Sidebar Dream 适配 | `src/components/Sidebar.tsx` | 粉色图标 + 继续设置卡片 |
| 4.6 ChatPanel Dream 适配 | `src/components/ChatPanel.tsx` | 毛玻璃卡片 |
| 4.7 InputArea Dream 适配 | `src/components/InputArea.tsx` | 毛玻璃输入区 + 粉色按钮 |
| 4.8 MessageBubble 适配 | `src/components/MessageBubble.tsx` | 毛玻璃消息卡片 |
| 4.9 App.tsx 布局切换 | `src/App.tsx` | Dream 两栏布局 + 背景图层 |

### Phase 5：自适应主题色（预计 2 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 5.1 图片加载 + Canvas 像素采样 | `src/core/theme/theme-extractor.ts` | 缩放到 100x100 |
| 5.2 K-Means 颜色聚类 | `src/core/theme/theme-extractor.ts` | k=6 聚类 |
| 5.3 色板推导 | `src/core/theme/theme-extractor.ts` | 主色/强调色/背景/明暗判断 |
| 5.4 CSS 变量动态注入 | `src/App.tsx` | 提取结果写入 `--dream-*` 变量 |
| 5.5 预设主题色 | `src/core/theme/presets/dream-colors.json` | 内置色板（粉色/蓝色/绿色等） |

### Phase 6：测试与优化（预计 2 小时）

| 任务 | 文件 | 说明 |
|------|------|------|
| 6.1 皮肤切换测试 | `src/test/skin-system.test.ts` | 切换/持久化/恢复 |
| 6.2 主题色提取测试 | `src/test/theme-extractor.test.ts` | 各色系图片提取 |
| 6.3 布局适配测试 | `src/test/skin-layout.test.ts` | 三栏/两栏布局 |
| 6.4 性能优化 | — | CSS 变量切换的 transition 优化 |
| 6.5 边界处理 | — | 无背景图/提取失败/超大图片 |

---

## 六、技术决策

### 6.1 为什么不用 CSS-in-JS？

- 当前项目使用纯 CSS + CSS 变量，性能更好
- CSS 变量支持运行时动态修改，无需重新渲染组件
- 保持与现有代码风格一致

### 6.2 为什么用 data-skin 属性而非 class？

- `data-skin` 语义更清晰，表示"皮肤"而非"样式类"
- 不与组件 CSS class 冲突
- 支持 CSS 属性选择器 `[data-skin="hub"]`
- 可扩展更多皮肤

### 6.3 主题色提取为什么用 Canvas 而非第三方库？

- 无需引入额外依赖
- Canvas API 是浏览器原生支持
- K-Means 算法简单高效（100x100 像素，6 聚类中心）
- 提取速度 < 100ms，用户体验好

### 6.4 Hub 右侧栏和顶部导航栏的数据来源？

- **Agent 状态**：从当前会话的 agent 状态获取（正在工作/空闲）
- **推荐任务**：从历史会话中分析提取（或预设模板）
- **导航链接**：对应应用内功能页面（聊天/Skills/MCP/项目等）
- **子卡片网格**：从项目内历史会话生成（token 统计 + 文件变更数）

---

## 七、风险与注意事项

1. **布局破坏风险**：Hub 和 Dream 皮肤改变了布局结构（三栏/两栏），需要条件渲染
   - 解决：在 App.tsx 中根据 `skin` 条件渲染不同布局
   - 组件内部通过 `useSkin()` hook 获取当前皮肤，条件渲染皮肤专属元素

2. **CSS 优先级冲突**：多套皮肤的 CSS 可能冲突
   - 解决：每套皮肤的 CSS 使用 `[data-skin="xxx"]` 前缀隔离
   - 默认皮肤不加前缀（作为 fallback）

3. **梦幻皮肤性能**：背景图 + 毛玻璃可能影响性能
   - 解决：背景图压缩到 1920x1080，毛玻璃使用 `will-change: backdrop-filter`
   - 低性能设备可关闭毛玻璃

4. **主题色提取精度**：K-Means 可能提取到不准的颜色
   - 解决：提供手动调整入口（用户可覆盖自动提取的颜色）
   - 内置预设色板作为 fallback

5. **Hub 右侧栏在小屏幕的适配**：三栏布局需要足够宽度
   - 解决：屏幕宽度 < 1200px 时隐藏右侧栏，改为抽屉式

---

## 八、文件清单

### 新增文件（22 个）

```
src/core/theme/
├── index.ts
├── types.ts
├── theme-manager.ts
├── theme-extractor.ts
├── theme-storage.ts
└── presets/
    ├── default.json
    ├── hub.json
    ├── dream.json
    └── dream-colors.json

src/components/
├── SkinSelector.tsx
├── DreamBgUploader.tsx
├── DreamConfigPanel.tsx
├── TopNavbar.tsx
├── RightSidebar.tsx
├── SessionCardGrid.tsx
├── BackgroundLayer.tsx
├── PolaroidCard.tsx
└── DreamDecorations.tsx

src/styles/
├── skin-hub.css
└── skin-dream.css

src/test/
├── skin-system.test.ts
├── theme-extractor.test.ts
└── skin-layout.test.ts
```

### 修改文件（8 个）

```
src/styles.css              — 扩展 CSS 变量系统，引入 skin-hub.css 和 skin-dream.css
src/store.ts                — 添加 skin/dreamConfig 状态和 actions
src/App.tsx                 — 布局条件渲染 + CSS 变量动态注入
src/components/Sidebar.tsx  — 适配 Hub/Dream 皮肤布局
src/components/ChatPanel.tsx — 适配 Hub/Dream 皮肤布局
src/components/InputArea.tsx — 适配 Hub/Dream 皮肤样式
src/components/MessageBubble.tsx — 适配 Dream 毛玻璃卡片
src/components/SettingsPanel.tsx — 集成皮肤选择器
```

### 参考文件（已下载）

```
docs/dream-skin-reference.css  — Codex-Dream-Skin 的 CSS 参考
docs/1.html                    — Hub 皮肤设计稿
docs/2.html                    — 梦幻皮肤设计稿
docs/dream-reference.jpg       — 梦幻皮肤参考图
```

---

## 九、预计工作量

| Phase | 任务 | 预计时间 |
|-------|------|----------|
| Phase 1 | 主题基础设施 | 2-3h |
| Phase 2 | 皮肤切换 UI | 1-2h |
| Phase 3 | Hub 皮肤适配 | 3-4h |
| Phase 4 | 梦幻皮肤适配 | 3-4h |
| Phase 5 | 自适应主题色 | 2h |
| Phase 6 | 测试与优化 | 2h |
| **合计** | | **13-17h** |

---

## 十、里程碑

- **M1**：Phase 1-2 完成 → 可切换三套皮肤（Hub/Dream 为基础样式）
- **M2**：Phase 3 完成 → Hub 皮肤完整可用（三栏布局 + 右侧栏 + 顶部导航）
- **M3**：Phase 4-5 完成 → 梦幻皮肤完整可用（背景图 + 毛玻璃 + 自适应主题色）
- **M4**：Phase 6 完成 → 测试通过，发布 v0.86
