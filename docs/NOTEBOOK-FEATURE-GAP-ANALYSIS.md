# 笔记本系统功能分析与对标方案

> **文档目标**：全面分析 mimo-gui 笔记本系统与 Google NotebookLM 的功能差距，借鉴开源项目 Lumina Note 的设计经验，并整合 Word/TXT 文档编辑与 PDF 高亮批注需求，形成完整的演进路线图。
>
> **创建日期**：2026-07-27
> **当前版本**：v0.89.3

---

## 目录

1. [现状评估：当前笔记本系统能力盘点](#1-现状评估当前笔记本系统能力盘点)
2. [对标 NotebookLM：功能差距分析](#2-对标-notebooklm功能差距分析)
3. [借鉴 Lumina Note：开源项目功能分析](#3-借鉴-lumina-note开源项目功能分析)
4. [新增需求：Word/TXT 编辑 + PDF 批注](#4-新增需求wordtxt-编辑--pdf-批注)
5. [完整功能差距矩阵](#5-完整功能差距矩阵)
6. [技术架构方案](#6-技术架构方案)
7. [分阶段实施路线图](#7-分阶段实施路线图)
8. [优先级与工作量估算](#8-优先级与工作量估算)

---

## 1. 现状评估：当前笔记本系统能力盘点

### 1.1 已实现功能清单

| 模块 | 功能 | 实现状态 | 涉及文件 |
|------|------|---------|---------|
| **笔记本 CRUD** | 创建/删除/搜索/重命名 | ✅ 完成 | `storage.ts`, `NotebookManager.tsx` |
| **来源管理** | 文本/文件/URL 三类来源 | ✅ 完成 | `storage.ts`, `extractor.ts` |
| **文本提取** | 40+ 种文本文件格式 + HTML→Text | ✅ 完成 | `extractor.ts` |
| **PDF 提取** | 纯 TS 零依赖 PDF 文本提取 | ✅ 基础完成 | `pdf-extractor.ts` |
| **文本分块** | 段落优先→句子分割→重叠窗口 | ✅ 完成 | `chunker.ts` |
| **Embedding 索引** | 批量 Embedding + SQLite BLOB 存储 | ✅ 完成 | `indexer.ts` |
| **本地嵌入** | ONNX WASM 零外部依赖 | ✅ 完成 | `local-embedding.ts` |
| **语义检索** | Cosine 相似度 + Top-K + 阈值过滤 | ✅ 完成 | `retriever.ts` |
| **维度保护** | 嵌入模型切换后旧索引自动跳过 | ✅ 完成 | `retriever.ts` |
| **查询缓存** | LRU 缓存（50 条）避免重复 Embedding | ✅ 完成 | `retriever.ts` |
| **笔记本摘要** | LLM 自动生成摘要（前 50 chunks） | ✅ 完成 | `indexer.ts` |
| **建议问题** | LLM 根据来源内容生成 5 个引导问题 | ✅ 完成 | `indexer.ts` |
| **笔记本对话** | RAG 上下文注入 + `search_notebook` 工具 | ✅ 完成 | `App.tsx`, `search-notebook.ts` |
| **知识隔离** | 每个笔记本对话仅使用该笔记本知识 | ✅ 完成 | `App.tsx` |
| **索引进度** | 实时进度回调（currentChunk/totalChunks） | ✅ 完成 | `indexer.ts` |
| **配置面板** | 分块参数/检索参数可配置 | ✅ 完成 | `SettingsPanel.tsx` |
| **增量索引** | 新增来源只处理新内容 | ✅ 完成 | `indexer.ts` |

### 1.2 当前架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    当前笔记本系统架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  UI 层                                                       │
│  ├── NotebookManager.tsx  (列表/创建/删除/来源管理/建议问题)   │
│  └── SettingsPanel.tsx    (分块/检索参数配置)                 │
│                                                             │
│  核心层                                                      │
│  ├── types.ts        (Notebook/Source/Chunk/RetrievalResult) │
│  ├── storage.ts      (SQLite CRUD + Embedding 序列化)         │
│  ├── extractor.ts    (文本提取: txt/md/code/url/html)        │
│  ├── pdf-extractor.ts(PDF 文本提取: 纯 TS 零依赖)             │
│  ├── chunker.ts      (段落→句子→重叠窗口分块)                 │
│  ├── indexer.ts      (提取→分块→Embedding→存储 管道)          │
│  └── retriever.ts    (语义检索: cosine + top-K + 缓存)       │
│                                                             │
│  存储层                                                      │
│  └── SQLite (notebooks / notebook_sources / notebook_chunks) │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 当前系统定位

当前系统是一个 **RAG 问答型笔记本**：用户上传文件 → 自动索引 → 在笔记本范围内进行知识问答。核心能力是「知识检索 + AI 问答」，但缺少**文档编辑、笔记管理、知识结构化、内容生成**等 NotebookLM 的核心体验。

---

## 2. 对标 NotebookLM：功能差距分析

### 2.1 NotebookLM 核心功能全景

基于 Google NotebookLM (https://notebooklm.google.com/) 的公开功能和特性：

| 功能域 | NotebookLM 功能 | 描述 |
|--------|----------------|------|
| **来源管理** | 多格式来源 | PDF、Google Docs、Google Slides、粘贴文本、网页 URL、YouTube 视频、音频文件 |
| **来源处理** | 自动摘要 | 每个来源自动生成摘要卡片 |
| **来源处理** | 来源关键话题 | 自动提取每个来源的关键话题 |
| **对话** | 源接地问答 | 回答仅基于笔记本内的来源，避免幻觉 |
| **对话** | 引用标注 | 回答中标注来源引用，可点击跳转到原文位置 |
| **对话** | 建议问题 | 基于来源内容自动生成建议问题 |
| **内容生成** | 笔记 (Notes) | 用户创建笔记，可将 AI 回答保存为笔记 |
| **内容生成** | 简报文档 (Briefing Doc) | 自动生成结构化简报 |
| **内容生成** | 学习指南 (Study Guide) | 自动生成学习指南（问答、关键词、摘要） |
| **内容生成** | FAQ | 自动生成常见问答 |
| **内容生成** | 时间线 (Timeline) | 从来源中提取时间线 |
| **内容生成** | 思维导图 (Mind Map) | 可视化知识结构 |
| **音频** | Audio Overview | 将笔记本内容生成播客式音频摘要 |
| **发现** | 发现相关来源 | 根据笔记本内容推荐相关网络资源 |
| **协作** | 共享笔记本 | 多人共享和协作编辑笔记本 |
| **组织** | 笔记本分组 | 多个笔记本的组织和管理 |

### 2.2 逐项差距分析

#### 2.2.1 来源管理差距

| NotebookLM 功能 | 我们的状态 | 差距 | 优先级 |
|----------------|-----------|------|--------|
| PDF 来源 | ✅ 基础支持（纯 TS 提取文本） | 缺少 PDF 原文渲染、批注、页面引用 | P1 |
| Google Docs/Slides | ❌ 不支持 | 架构差异（无 Google 账号集成），不纳入 | — |
| 粘贴文本 | ✅ 支持 | 无差距 | — |
| 网页 URL | ✅ 支持（Rust http_get + HTML→Text） | 无差距 | — |
| YouTube 视频 | ❌ 不支持 | 可通过 URL 提取字幕实现，中优先级 | P2 |
| 音频文件 | ❌ 不支持 | 需要 Whisper STT，依赖较重 | P3 |
| 来源摘要卡片 | ❌ 不支持 | 每个来源缺少独立摘要 | P1 |
| 来源关键话题 | ❌ 不支持 | 缺少自动话题提取 | P2 |
| 来源选择/开关 | ❌ 不支持 | NotebookLM 可勾选/取消来源影响对话范围 | P1 |

#### 2.2.2 对话与检索差距

| NotebookLM 功能 | 我们的状态 | 差距 | 优先级 |
|----------------|-----------|------|--------|
| 源接地问答 | ✅ 支持（RAG 注入） | 无差距 | — |
| 引用标注 | ⚠️ 基础支持 | `[Source: name]` 格式，但缺少**精确定位**（页码/段落） | P1 |
| 建议问题 | ✅ 支持 | 无差距 | — |
| 多轮上下文 | ✅ 支持 | 无差距 | — |
| 对话中引用跳转 | ❌ 不支持 | 点击引用无法跳转到来源原文 | P1 |
| 来源范围筛选 | ❌ 不支持 | 对话时无法选择仅使用部分来源 | P1 |
| 对话历史搜索 | ❌ 不支持 | 无法搜索历史对话 | P2 |

#### 2.2.3 内容生成差距（最大差距）

| NotebookLM 功能 | 我们的状态 | 差距 | 优先级 |
|----------------|-----------|------|--------|
| 笔记 (Notes) | ❌ 完全缺失 | **核心差距**：无法创建、编辑、管理笔记 | P0 |
| 保存 AI 回答为笔记 | ❌ 完全缺失 | 无法将对话中的有价值回答保存为笔记 | P0 |
| 简报文档 (Briefing Doc) | ❌ 不支持 | 无法自动生成结构化文档 | P1 |
| 学习指南 (Study Guide) | ❌ 不支持 | 无法生成问答/关键词/摘要学习材料 | P1 |
| FAQ 生成 | ❌ 不支持 | 无法自动生成常见问答 | P2 |
| 时间线 (Timeline) | ❌ 不支持 | 无法从来源中提取时间线 | P2 |
| 思维导图 (Mind Map) | ❌ 不支持 | 无法可视化知识结构 | P1 |
| 大纲生成 | ❌ 不支持 | 无法自动生成文档大纲 | P2 |

#### 2.2.4 音频差距

| NotebookLM 功能 | 我们的状态 | 差距 | 优先级 |
|----------------|-----------|------|--------|
| Audio Overview（播客式音频摘要） | ❌ 不支持 | 需要 TTS + 脚本生成，依赖较重 | P3 |
| 音频播放控制 | ❌ 不支持 | 依赖上一项 | P3 |

#### 2.2.5 发现与协作差距

| NotebookLM 功能 | 我们的状态 | 差距 | 优先级 |
|----------------|-----------|------|--------|
| 发现相关来源 | ❌ 不支持 | 根据笔记本内容推荐网络资源（需要 Web Search） | P2 |
| 共享笔记本 | ❌ 不支持 | 桌面应用架构，暂不纳入 | — |
| 笔记本导出 | ❌ 不支持 | 无法导出笔记本内容（Markdown/PDF） | P1 |
| 笔记本导入 | ⚠️ 部分支持 | 可通过添加来源间接导入 | P2 |

### 2.3 NotebookLM 差距总结

```
差距严重度分布：

P0（核心缺失）：
  ├── 笔记系统（创建/编辑/管理笔记）
  └── 保存 AI 回答为笔记

P1（重要缺失）：
  ├── 来源摘要卡片
  ├── 来源选择/开关
  ├── 引用精确定位（页码/段落）+ 跳转
  ├── 简报文档生成
  ├── 学习指南生成
  ├── 思维导图
  ├── 笔记本导出（Markdown/PDF）
  └── PDF 原文渲染 + 批注

P2（增强缺失）：
  ├── 来源关键话题
  ├── YouTube 字幕提取
  ├── 对话历史搜索
  ├── FAQ 生成
  ├── 时间线生成
  ├── 发现相关来源
  └── 大纲生成

P3（远期）：
  ├── 音频文件支持（STT）
  └── Audio Overview（播客式摘要）
```

---

## 3. 借鉴 Lumina Note：开源项目功能分析

### 3.1 Lumina Note 概览

> **项目地址**：https://github.com/blueberrycongee/lumina-note
> **技术栈**：Electron 41 + React 18 + TypeScript + CodeMirror + opencode SDK
> **定位**：人类可编辑的 Markdown 笔记工作区 + AI 智能体跨笔记操作

Lumina Note 的核心理念：**笔记始终是人类可拥有和可编辑的，AI 在同一工作区内提供辅助**。

### 3.2 可借鉴功能清单

| 功能 | Lumina Note 实现 | 借鉴价值 | 对应我们的差距 |
|------|-----------------|---------|--------------|
| **Markdown 编辑器** | CodeMirror 实时预览 + 阅读模式 + LaTeX | 提供笔记编辑基础 | 笔记系统 P0 |
| **WikiLinks** | `[[笔记名]]` 双向链接 | 知识关联与网络化 | 知识结构化 P1 |
| **反向链接 (Backlinks)** | 自动追踪哪些笔记引用了当前笔记 | 知识关联发现 | 知识结构化 P1 |
| **知识图谱 (Graph View)** | 可视化笔记间的链接关系 | 知识全景可视化 | 思维导图 P1 |
| **PDF + 批注** | PDF 查看与标注 | 文档批注能力 | PDF 批注 P1 |
| **闪卡 (Flashcards)** | 从笔记生成闪卡 | 学习辅助工具 | 学习指南 P2 |
| **AI 跨笔记操作** | opencode SDK 智能体可读写/重整/摘要/连接笔记 | AI 深度参与笔记管理 | 笔记系统 P0 |
| **多 AI 提供商** | OpenAI/Claude/Gemini/DeepSeek/Kimi/智谱/MiMo/Groq/OpenRouter/Ollama | 多模型灵活选择 | ✅ 已有 |
| **Agent Skills** | 自定义命令和技能 | 可扩展 AI 能力 | ✅ 已有技能系统 |
| **插件系统** | 开发者预览插件 | 可扩展性 | 远期 P3 |
| **文档引擎 (Doc Engine)** | docx 导入/导出 + IR 结构树 + OpenOffice 渲染参考 | Word 文档编辑基础 | Word 编辑 P1 |
| **Cloud Sync** | 云端同步（开发中） | 跨设备同步 | 远期 |
| **移动端** | iOS/Android 原生应用 | 移动端访问 | 远期 |
| **自托管中继** | 自托管服务 | 数据自主 | 远期 |
| **外观插件** | 主题/外观可定制 | 个性化 | ✅ 已有皮肤系统 |

### 3.3 重点借鉴分析

#### 3.3.1 Markdown 笔记编辑器（核心借鉴）

Lumina Note 使用 CodeMirror 构建 Markdown 编辑器，支持：
- 实时预览（Live Preview）
- 阅读模式（Reading Mode）
- LaTeX 公式渲染
- 语法高亮

**借鉴方案**：
- 我们可使用 `@codemirror/markdown` + `@codemirror/language-data` 构建编辑器
- 或使用更轻量的 `react-markdown` + `@uiw/react-md-editor`
- 需要与现有 Tauri 文件系统打通（读写 `.md` 文件）

#### 3.3.2 WikiLinks + Backlinks + Graph View（知识网络化）

Lumina Note 的知识结构化三件套：
- **WikiLinks**：`[[笔记标题]]` 自动链接到其他笔记
- **Backlinks**：反向链接面板显示引用当前笔记的所有笔记
- **Graph View**：力导向图可视化笔记间的关系网络

**借鉴方案**：
- WikiLinks 解析：正则匹配 `\[\[([^\]]+)\]\]`，建立链接索引
- Backlinks：SQLite 存储 `note_links` 表（source_note_id → target_note_id）
- Graph View：使用 `react-force-graph` 或 `d3-force` 渲染

#### 3.3.3 AI 跨笔记操作（Agent 深度集成）

Lumina Note 的 AI 智能体可以：
- 读写笔记（read/write files）
- 重整文件夹结构（reorganize folders）
- 摘要 PDF（summarize PDFs）
- 连接相关笔记（connect related notes）
- 生成闪卡（generate flashcards）
- 清理混乱知识（clean up messy knowledge）

**借鉴方案**：
- 复用我们已有的 `agentic-loop` + 工具系统
- 新增笔记本操作工具：`create_note`、`edit_note`、`link_notes`、`list_notes`
- AI 可以在笔记本内直接创建笔记、连接笔记、生成学习材料

#### 3.3.4 文档引擎（Word 编辑借鉴）

Lumina Note 的 Doc Engine 路线图提供了有价值的参考：
- **IR（中间表示）**：抽象文档结构树（block/inline/style 三层）
- **docx 导入/导出**：`docxImport.ts` / `docxExport.ts`
- **渲染策略**：利用 OpenOffice/LibreOffice (soffice headless) 做 docx → PDF 渲染
- **AI 友好**：AI 直接操作 IR，而非 DOM

**借鉴方案**：
- 使用 `docx` npm 包（JavaScript docx 生成库）实现 .docx 导入/导出
- 使用 `mammoth.js` 实现 .docx → HTML 转换（只读预览）
- TXT/MD 编辑使用 CodeMirror
- 不追求与 Word 完全一致的排版，优先保证可用性

---

## 4. 新增需求：Word/TXT 编辑 + PDF 批注

### 4.1 Word 文档编辑

| 需求 | 方案 | 依赖 |
|------|------|------|
| .docx 文件打开/预览 | `mammoth.js`（docx → HTML 转换） | ~150KB |
| .docx 文件编辑 | `docx` npm 包（程序化生成/修改 docx） | ~500KB |
| .docx 文件导出 | `docx` npm 包 | 同上 |
| 富文本编辑器 | TipTap（基于 ProseMirror）或轻量 contentEditable | ~200KB |
| 格式支持 | 标题/段落/列表/表格/加粗/斜体/链接/图片 | — |

**技术方案**：
```
用户打开 .docx
  ├── mammoth.js → HTML 预览（只读模式）
  └── 用户点击「编辑」
      ├── 转换为内部 Markdown IR（标题/段落/列表/表格/强调）
      ├── TipTap 编辑器 → 实时编辑
      └── 保存时 → docx 包序列化为 .docx 文件
```

### 4.2 TXT 文档编辑

| 需求 | 方案 | 依赖 |
|------|------|------|
| .txt/.md 文件编辑 | CodeMirror 6（轻量、高性能） | ~300KB |
| 语法高亮 | `@codemirror/language-data` | 包含在上方 |
| 实时预览 | `react-markdown` + `remark-gfm` | ~100KB |
| 自动保存 | 防抖 2s 自动保存到文件 | 无新依赖 |

### 4.3 PDF 高亮批注

| 需求 | 方案 | 依赖 |
|------|------|------|
| PDF 渲染 | PDF.js (`pdfjs-dist`) | ~300KB |
| PDF 批注 | `pdf-annotate` 或自实现批注层 | ~100KB |
| 高亮标注 | 文本选中 → 高亮 + 存储坐标 | — |
| 批注持久化 | SQLite 存储批注数据（页码/坐标/颜色/文本） | 无新依赖 |
| 批注同步索引 | 高亮文本自动作为知识来源补充索引 | 无新依赖 |

**技术方案**：
```
用户打开 PDF 来源
  ├── PDF.js 渲染 PDF 页面（Canvas）
  ├── pdf-annotate 叠加批注层
  │     ├── 文本选中 → 高亮标注（黄/绿/红）
  │     ├── 批注气泡 → 添加评论
  │     └── 下划线/删除线
  ├── 批注数据 → SQLite (notebook_annotations 表)
  │     └── { id, source_id, page, x, y, width, height, type, color, text, comment }
  └── 高亮文本 → 自动提取 → 补充索引到 notebook_chunks
```

**PDF.js + pdf-annotate 集成方案**：

```typescript
// 批注数据结构
interface PDFAnnotation {
  id: string;
  sourceId: string;       // 关联的 notebook_source
  notebookId: string;
  page: number;           // 页码 (0-based)
  rects: Rect[];          // 高亮区域坐标数组
  type: 'highlight' | 'underline' | 'comment';
  color: string;          // 颜色 hex
  text: string;           // 被标注的文本
  comment?: string;       // 批注评论
  createdAt: number;
  createdBy: 'user' | 'ai'; // 标注者
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
```

---

## 5. 完整功能差距矩阵

### 5.1 功能对比总表

| # | 功能 | NotebookLM | Lumina Note | 我们当前 | 目标 | 优先级 |
|---|------|-----------|-------------|---------|------|--------|
| **来源管理** | | | | | | |
| 1 | PDF 来源 | ✅ | ✅ | ⚠️ 文本提取 | 渲染+批注+提取 | P1 |
| 2 | 来源摘要卡片 | ✅ | — | ❌ | 每来源独立摘要 | P1 |
| 3 | 来源关键话题 | ✅ | — | ❌ | 自动话题提取 | P2 |
| 4 | 来源选择/开关 | ✅ | — | ❌ | 勾选影响对话范围 | P1 |
| 5 | YouTube 字幕 | ✅ | — | ❌ | URL 提取字幕 | P2 |
| 6 | 音频文件 | ✅ | — | ❌ | Whisper STT | P3 |
| **笔记系统** | | | | | | |
| 7 | 创建/编辑笔记 | ✅ | ✅ | ❌ | Markdown 编辑器 | **P0** |
| 8 | 笔记列表/管理 | ✅ | ✅ | ❌ | 笔记 CRUD + 分类 | **P0** |
| 9 | 保存 AI 回答为笔记 | ✅ | — | ❌ | 一键保存对话片段 | **P0** |
| 10 | WikiLinks | — | ✅ | ❌ | `[[链接]]` 双向链接 | P1 |
| 11 | 反向链接 | — | ✅ | ❌ | Backlinks 面板 | P1 |
| 12 | 知识图谱 | ✅ | ✅ | ❌ | 可视化笔记网络 | P1 |
| **文档编辑** | | | | | | |
| 13 | TXT/MD 编辑 | — | ✅ | ❌ | CodeMirror 编辑器 | P1 |
| 14 | Word (.docx) 编辑 | — | ⚠️ | ❌ | mammoth + docx 包 | P1 |
| 15 | PDF 高亮批注 | — | ✅ | ❌ | PDF.js + pdf-annotate | P1 |
| 16 | 文档导出 | ✅ | — | ❌ | 导出 MD/PDF/DOCX | P1 |
| **内容生成** | | | | | | |
| 17 | 简报文档 | ✅ | — | ❌ | 自动生成结构化简报 | P1 |
| 18 | 学习指南 | ✅ | — | ❌ | 问答+关键词+摘要 | P1 |
| 19 | 思维导图 | ✅ | — | ❌ | Mermaid 思维导图 | P1 |
| 20 | FAQ 生成 | ✅ | — | ❌ | 自动 FAQ | P2 |
| 21 | 时间线 | ✅ | — | ❌ | 事件时间线提取 | P2 |
| 22 | 闪卡 | — | ✅ | ❌ | 间隔重复闪卡 | P2 |
| **对话与检索** | | | | | | |
| 23 | 引用精确定位 | ✅ | — | ⚠️ | 页码/段落级引用+跳转 | P1 |
| 24 | 引用跳转原文 | ✅ | — | ❌ | 点击引用→打开来源定位 | P1 |
| 25 | 来源范围筛选 | ✅ | — | ❌ | 对话时选择来源子集 | P1 |
| 26 | 对话历史搜索 | — | — | ❌ | 全文搜索历史对话 | P2 |
| **AI 智能体** | | | | | | |
| 27 | AI 跨笔记操作 | — | ✅ | ❌ | 读写/连接/重整笔记 | P1 |
| 28 | AI 生成笔记 | ✅ | ✅ | ❌ | 根据来源自动生成笔记 | P1 |
| 29 | AI 清理知识 | — | ✅ | ❌ | 整理/去重/分类笔记 | P2 |
| **音频** | | | | | | |
| 30 | Audio Overview | ✅ | — | ❌ | 播客式音频摘要 | P3 |
| **发现与协作** | | | | | | |
| 31 | 发现相关来源 | ✅ | — | ❌ | Web Search 推荐 | P2 |
| 32 | 笔记本导出 | ✅ | — | ❌ | 导出整个笔记本 | P1 |

### 5.2 差距可视化

```
功能成熟度雷达图（当前 vs 目标）：

                    来源管理
                   ╱        ╲
                  60%  ──→  90%
                 ╱            ╲
   文档编辑                对话检索
   0%   ──→  80%          70% ──→ 95%
                 ╲            ╱
                  笔记系统
                  0%  ──→  90%
                 ╱            ╲
   AI 智能体              内容生成
   30%  ──→  85%         0%  ──→ 80%
                   ╲        ╱
                    音频/协作
                   0%  ──→  20%
```

---

## 6. 技术架构方案

### 6.1 目标架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    升级后笔记本系统架构                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  UI 层                                                           │
│  ├── NotebookManager.tsx        (笔记本列表+管理)                 │
│  ├── NotebookDetail.tsx         (笔记本详情: 来源+笔记+对话)       │
│  ├── NoteEditor.tsx             (Markdown/文本编辑器)      ← 新增 │
│  ├── DocxEditor.tsx             (Word 文档编辑器)          ← 新增 │
│  ├── PDFViewer.tsx              (PDF 渲染+批注)            ← 新增 │
│  ├── KnowledgeGraph.tsx         (知识图谱可视化)           ← 新增 │
│  ├── ContentGenerator.tsx       (简报/学习指南/FAQ 生成)   ← 新增 │
│  └── MindMapView.tsx            (思维导图)                 ← 新增 │
│                                                                  │
│  核心层                                                          │
│  ├── knowledge/               (已有 RAG 管道)                      │
│  │   ├── types.ts              + Note/Annotation/GeneratedContent │
│  │   ├── storage.ts            + notes/annotations/links 表       │
│  │   ├── extractor.ts          (已有)                              │
│  │   ├── pdf-extractor.ts      (已有)                              │
│  │   ├── chunker.ts            (已有)                              │
│  │   ├── indexer.ts            (已有) + 批注索引                   │
│  │   ├── retriever.ts          (已有) + 笔记检索                   │
│  │   ├── note-manager.ts       (笔记 CRUD + WikiLinks)     ← 新增 │
│  │   ├── annotation-store.ts   (PDF 批注存储)              ← 新增 │
│  │   ├── content-generator.ts  (简报/指南/FAQ/时间线)       ← 新增 │
│  │   └── graph-builder.ts      (知识图谱构建)              ← 新增 │
│  │                                                               │
│  ├── doc/                     (文档编辑引擎)               ← 新增 │
│  │   ├── docx-import.ts        (mammoth.js docx → HTML)           │
│  │   ├── docx-export.ts        (docx 包 HTML → docx)              │
│  │   ├── ir.ts                 (文档中间表示)                      │
│  │   └── pdf-viewer.ts         (PDF.js 封装)                      │
│  │                                                               │
│  └── llm/tools/               (已有工具系统)                      │
│      ├── search-notebook.ts    (已有)                              │
│      ├── create-note.ts        (AI 创建笔记)               ← 新增 │
│      ├── edit-note.ts          (AI 编辑笔记)               ← 新增 │
│      └── link-notes.ts         (AI 连接笔记)               ← 新增 │
│                                                                  │
│  存储层                                                          │
│  └── SQLite                                                      │
│      ├── notebooks              (已有)                              │
│      ├── notebook_sources       (已有)                              │
│      ├── notebook_chunks        (已有)                              │
│      ├── notes                  (笔记)                     ← 新增 │
│      ├── note_links             (WikiLinks 关系)           ← 新增 │
│      ├── notebook_annotations   (PDF 批注)                 ← 新增 │
│      └── generated_contents     (生成内容)                 ← 新增 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 数据模型扩展

```sql
-- 笔记表
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  source_id TEXT,               -- 关联的来源（可选，AI 生成时标注）
  title TEXT NOT NULL,
  content TEXT NOT NULL,         -- Markdown 内容
  content_type TEXT DEFAULT 'markdown',  -- markdown/docx/txt
  tags TEXT,                     -- JSON 数组
  pin_order INTEGER,             -- 置顶排序
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE SET NULL
);

-- WikiLinks 关系表
CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  link_text TEXT,               -- 链接显示文本
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);

-- PDF 批注表
CREATE TABLE IF NOT EXISTS notebook_annotations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  page INTEGER NOT NULL,         -- 页码 (0-based)
  rects TEXT NOT NULL,           -- JSON: [{x, y, width, height}, ...]
  type TEXT NOT NULL,            -- highlight/underline/comment
  color TEXT DEFAULT '#ffeb3b',
  text TEXT,                     -- 被标注的文本
  comment TEXT,                  -- 批注评论
  created_by TEXT DEFAULT 'user', -- user/ai
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_annotations_source ON notebook_annotations(source_id);

-- 生成内容表（简报/学习指南/FAQ/时间线等）
CREATE TABLE IF NOT EXISTS generated_contents (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  type TEXT NOT NULL,            -- briefing/study_guide/faq/timeline/mindmap
  title TEXT NOT NULL,
  content TEXT NOT NULL,         -- Markdown/JSON 内容
  source_filter TEXT,            -- 生成时使用的来源 ID 列表 (JSON)
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_generated_notebook ON generated_contents(notebook_id);
```

### 6.3 新增依赖评估

| 依赖 | 用途 | 体积 (gzip) | 必要性 |
|------|------|------------|--------|
| `pdfjs-dist` | PDF 渲染 | ~300KB | P1 必需 |
| `pdf-annotate` | PDF 批注层 | ~100KB | P1 必需 |
| `@codemirror/markdown` | Markdown 编辑 | ~150KB | P0 必需 |
| `@codemirror/language-data` | 语法高亮 | ~100KB | P1 必需 |
| `mammoth` | docx → HTML 只读 | ~150KB | P1 必需 |
| `docx` | 程序化生成 docx | ~200KB | P1 必需 |
| `react-markdown` + `remark-gfm` | Markdown 预览 | ~80KB | P0 必需 |
| `react-force-graph-2d` | 知识图谱 | ~120KB | P1 可选 |

**总体增量**：~1.2MB（gzip 后 ~400KB），可接受。

---

## 7. 分阶段实施路线图

### Phase NB-1：笔记系统基础（P0 核心，2 周）

> **目标**：建立笔记创建、编辑、管理能力，实现「保存 AI 回答为笔记」。

| 编号 | 任务 | 涉及文件 | 天数 |
|------|------|---------|------|
| NB-1.1 | 数据模型扩展（notes 表） | `types.ts`, `storage.ts` | 1 |
| NB-1.2 | 笔记 CRUD（创建/编辑/删除/列表） | `note-manager.ts` ← 新增 | 2 |
| NB-1.3 | Markdown 编辑器（CodeMirror 集成） | `NoteEditor.tsx` ← 新增 | 3 |
| NB-1.4 | 笔记列表 UI + 笔记本详情视图重构 | `NotebookManager.tsx` | 2 |
| NB-1.5 | 「保存 AI 回答为笔记」按钮 | `MessageBubble.tsx`, `App.tsx` | 1 |
| NB-1.6 | 笔记与来源关联（从来源生成笔记） | `note-manager.ts` | 1 |

**验收标准**：
- [ ] 用户可在笔记本内创建、编辑、删除 Markdown 笔记
- [ ] 用户可将 AI 对话回答一键保存为笔记
- [ ] 笔记列表显示标题、摘要、更新时间、关联来源
- [ ] 笔记编辑器支持 Markdown 实时预览

### Phase NB-2：文档编辑 + PDF 批注（P1，3 周）

> **目标**：支持 Word/TXT 文档编辑和 PDF 高亮批注。

| 编号 | 任务 | 涉及文件 | 天数 |
|------|------|---------|------|
| NB-2.1 | TXT/MD 文件编辑器（CodeMirror） | `DocEditor.tsx` ← 新增 | 2 |
| NB-2.2 | docx 导入（mammoth.js → HTML 预览） | `docx-import.ts` ← 新增 | 2 |
| NB-2.3 | docx 编辑（IR + 导出） | `docx-export.ts` ← 新增 | 3 |
| NB-2.4 | PDF.js 渲染集成 | `PDFViewer.tsx` ← 新增 | 2 |
| NB-2.5 | PDF 批注层（pdf-annotate） | `PDFViewer.tsx` | 3 |
| NB-2.6 | 批注持久化（SQLite） | `annotation-store.ts` ← 新增 | 1 |
| NB-2.7 | 高亮文本自动索引到知识库 | `indexer.ts` 修改 | 1 |
| NB-2.8 | 来源原文查看器（点击引用跳转） | `SourceViewer.tsx` ← 新增 | 2 |

**验收标准**：
- [ ] 用户可打开 .txt/.md 文件进行编辑并保存
- [ ] 用户可打开 .docx 文件预览，可编辑后导出
- [ ] 用户可在 PDF 上进行高亮、下划线、评论批注
- [ ] PDF 批注数据持久化到 SQLite
- [ ] PDF 高亮文本自动补充到笔记本索引
- [ ] 对话中点击引用可跳转到来源原文位置

### Phase NB-3：知识结构化（P1，2 周）

> **目标**：实现 WikiLinks、反向链接、知识图谱，让知识网络化。

| 编号 | 任务 | 涉及文件 | 天数 |
|------|------|---------|------|
| NB-3.1 | WikiLinks 解析与存储 | `note-manager.ts` | 2 |
| NB-3.2 | 反向链接（Backlinks）面板 | `BacklinksPanel.tsx` ← 新增 | 1 |
| NB-3.3 | 知识图谱可视化 | `KnowledgeGraph.tsx` ← 新增 | 3 |
| NB-3.4 | 来源选择/开关（对话范围筛选） | `NotebookManager.tsx` | 1 |
| NB-3.5 | 来源摘要卡片 | `indexer.ts` 修改 | 1 |
| NB-3.6 | 引用精确定位（页码/段落） | `retriever.ts` 修改 | 2 |

**验收标准**：
- [ ] 笔记中 `[[笔记标题]]` 自动创建双向链接
- [ ] 反向链接面板显示引用当前笔记的所有笔记
- [ ] 知识图谱可视化笔记间的关系网络
- [ ] 对话时可勾选/取消来源影响检索范围
- [ ] 每个来源显示独立摘要卡片
- [ ] AI 回答引用标注精确到页码/段落

### Phase NB-4：内容生成引擎（P1，2 周）

> **目标**：实现简报文档、学习指南、思维导图等自动内容生成。

| 编号 | 任务 | 涉及文件 | 天数 |
|------|------|---------|------|
| NB-4.1 | 内容生成框架（类型+模板+存储） | `content-generator.ts` ← 新增 | 1 |
| NB-4.2 | 简报文档生成（Briefing Doc） | `content-generator.ts` | 2 |
| NB-4.3 | 学习指南生成（Study Guide） | `content-generator.ts` | 2 |
| NB-4.4 | 思维导图生成（Mermaid mindmap） | `content-generator.ts` | 1 |
| NB-4.5 | FAQ 生成 | `content-generator.ts` | 1 |
| NB-4.6 | 时间线生成 | `content-generator.ts` | 1 |
| NB-4.7 | 生成内容管理 UI | `ContentGenerator.tsx` ← 新增 | 2 |
| NB-4.8 | 笔记本导出（Markdown/PDF 打包） | `exporter.ts` ← 新增 | 2 |

**验收标准**：
- [ ] 一键生成简报文档（结构化摘要 + 关键要点）
- [ ] 一键生成学习指南（问答 + 关键词 + 摘要）
- [ ] 一键生成思维导图（Mermaid 可视化）
- [ ] 一键生成 FAQ（常见问答对）
- [ ] 一键生成时间线（事件 + 日期排序）
- [ ] 生成内容可保存为笔记或导出

### Phase NB-5：AI 智能体增强（P1，1.5 周）

> **目标**：AI 可跨笔记操作，自动生成/连接/整理笔记。

| 编号 | 任务 | 涉及文件 | 天数 |
|------|------|---------|------|
| NB-5.1 | `create_note` 工具 | `create-note.ts` ← 新增 | 1 |
| NB-5.2 | `edit_note` 工具 | `edit-note.ts` ← 新增 | 1 |
| NB-5.3 | `link_notes` 工具 | `link-notes.ts` ← 新增 | 1 |
| NB-5.4 | `list_notes` 工具 | `list-notes.ts` ← 新增 | 0.5 |
| NB-5.5 | AI 自动生成笔记（从来源） | `content-generator.ts` | 2 |
| NB-5.6 | AI 知识清理（去重/分类/整理） | `note-manager.ts` | 2 |

**验收标准**：
- [ ] AI 可在对话中直接创建笔记
- [ ] AI 可编辑已有笔记内容
- [ ] AI 可自动建立笔记间的 WikiLink 关联
- [ ] AI 可根据来源内容自动生成结构化笔记
- [ ] AI 可识别重复笔记并建议合并

### Phase NB-6：增强功能（P2，2 周）

> **目标**：补齐中优先级功能。

| 编号 | 任务 | 天数 |
|------|------|------|
| NB-6.1 | 来源关键话题提取 | 1 |
| NB-6.2 | YouTube 字幕提取 | 2 |
| NB-6.3 | 对话历史搜索 | 1 |
| NB-6.4 | 闪卡生成 + 间隔重复 | 3 |
| NB-6.5 | 发现相关来源（Web Search） | 2 |
| NB-6.6 | 大纲生成 | 1 |

### Phase NB-7：远期功能（P3，视需求）

| 编号 | 任务 | 说明 |
|------|------|------|
| NB-7.1 | 音频文件支持 | 集成 Whisper STT |
| NB-7.2 | Audio Overview | TTS + 播客脚本生成 |
| NB-7.3 | 插件系统 | 笔记本扩展插件 |

---

## 8. 优先级与工作量估算

### 8.1 工作量汇总

| 阶段 | 优先级 | 工作量 | 说明 |
|------|--------|--------|------|
| Phase NB-1 | **P0** | 2 周 | 笔记系统基础（核心缺失） |
| Phase NB-2 | **P1** | 3 周 | 文档编辑 + PDF 批注 |
| Phase NB-3 | **P1** | 2 周 | 知识结构化（WikiLinks + 图谱） |
| Phase NB-4 | **P1** | 2 周 | 内容生成引擎 |
| Phase NB-5 | **P1** | 1.5 周 | AI 智能体增强 |
| Phase NB-6 | **P2** | 2 周 | 增强功能 |
| Phase NB-7 | **P3** | 待定 | 远期功能 |
| **合计** | | **~12.5 周** | P0+P1 约 10.5 周 |

### 8.2 建议实施顺序

```
Week 1-2:   Phase NB-1 (笔记系统基础)
Week 3-5:   Phase NB-2 (文档编辑 + PDF 批注)
Week 6-7:   Phase NB-3 (知识结构化)
Week 8-9:   Phase NB-4 (内容生成引擎)
Week 10-11: Phase NB-5 (AI 智能体增强)
Week 12-13: Phase NB-6 (增强功能)
```

### 8.3 里程碑版本规划

| 版本 | 内容 | 对标完成度 |
|------|------|-----------|
| v0.90 | Phase NB-1：笔记系统基础 | NotebookLM 对标 40% |
| v0.91 | Phase NB-2：文档编辑 + PDF 批注 | NotebookLM 对标 55% |
| v0.92 | Phase NB-3：知识结构化 | NotebookLM 对标 70% |
| v0.93 | Phase NB-4：内容生成引擎 | NotebookLM 对标 85% |
| v0.94 | Phase NB-5：AI 智能体增强 | NotebookLM 对标 90% + Lumina 借鉴 80% |
| v0.95 | Phase NB-6：增强功能 | NotebookLM 对标 95% |

### 8.4 与竞品最终对标

| 维度 | NotebookLM | Lumina Note | 我们（目标） |
|------|-----------|-------------|------------|
| 来源管理 | 95% | 70% | **90%** |
| 笔记系统 | 90% | 95% | **90%** |
| 文档编辑 | 10% | 85% | **80%** |
| PDF 批注 | 30% | 80% | **85%** |
| 知识结构化 | 70% | 90% | **85%** |
| 内容生成 | 95% | 20% | **85%** |
| 对话检索 | 95% | 60% | **95%** |
| AI 智能体 | 50% | 85% | **85%** |
| 音频 | 90% | 0% | **20%** |
| 协作 | 80% | 30% | **10%** |

### 8.5 核心差异化优势

在完成上述路线图后，我们相比 NotebookLM 和 Lumina Note 的差异化优势：

1. **桌面原生 + 隐私优先**：本地 SQLite 存储，数据不上云（vs NotebookLM 云端）
2. **编程能力集成**：笔记本可与编程对话、Worktree、技能系统无缝联动（vs 两者均无）
3. **多模型灵活选择**：支持 CLI 模式（MiMo）+ API 模式（任意 OpenAI 兼容）+ 本地嵌入（vs NotebookLM 仅 Gemini）
4. **宠物系统联动**：笔记本事件可触发桌面宠物通知（独有）
5. **PDF 批注 + RAG 一体化**：PDF 高亮文本自动进入知识索引（vs NotebookLM 无批注，Lumina 无 RAG）
6. **Word 编辑 + AI 一体化**：Word 文档编辑与 AI 知识管理在同一应用内（vs 两者均不完整）
7. **一键安装零配置**：Tauri 打包，无需 Docker/Node.js/Python 环境（vs Lumina 需 Bun + opencode）

---

## 9. 新增对标：Understand-Anything 知识图谱分析

> **来源**：https://github.com/Egonex-AI/Understand-Anything
> **Star**：76,000+ | **语言**：TypeScript | **协议**：MIT

### 9.1 项目概述

Understand-Anything 是一个将任意代码库、知识库或文档转化为**交互式知识图谱**的开源工具。核心理念是"教学型图谱 > 炫技型图谱"——不只是展示复杂度，而是帮助用户理解每个部分如何组合在一起。

### 9.2 核心功能分析

| 功能 | 说明 | 对我们的借鉴价值 |
|------|------|-----------------|
| **结构化知识图谱** | 将文件/函数/类/依赖关系构建为可交互的力导向图，每个节点可点击、搜索、探索 | ⭐⭐⭐ 笔记本来源和笔记可图谱化 |
| **领域视图（Domain View）** | 将知识映射到业务流程（领域、流程、步骤），以水平图展示 | ⭐⭐ 笔记本主题分类可视化 |
| **知识库分析** | 指向 wiki/知识库目录，LLM 提取实体、关系、主张，构建社区聚类图 | ⭐⭐⭐ 笔记本来源知识图谱核心 |
| **引导式导览（Guided Tours）** | 按依赖顺序自动生成架构走查路径 | ⭐⭐ 笔记本"学习路径"生成 |
| **模糊+语义搜索** | 同时支持按名称和按语义搜索图谱节点 | ⭐⭐⭐ 笔记本来源+笔记统一搜索 |
| **Diff 影响分析** | 查看修改对整个系统的影响范围 | ⭐ 来源变更影响分析 |
| **角色自适应 UI** | 根据用户角色（初级开发/PM/高级用户）调整详情层级 | ⭐⭐ 笔记本视图密度切换 |
| **分层可视化** | 按架构层（API/Service/Data/UI/Utility）自动分组着色 | ⭐⭐ 笔记本来源类型分层 |
| **语言概念解释** | 12种编程模式在上下文中解释 | ⭐ 可选的知识增强 |
| **社区聚类** | 力导向图 + 社区发现算法，自动分组相关节点 | ⭐⭐⭐ 笔记自动分类 |

### 9.3 技术架构关键点

```
Understand-Anything 架构
├── packages/core        — 共享分析引擎 (types, persistence, tree-sitter, search, schema, tours)
├── packages/dashboard   — React + TypeScript Web Dashboard
│   ├── React Flow       — 图谱渲染引擎
│   ├── Zustand          — 状态管理
│   └── TailwindCSS v4   — 样式
├── agents/              — 多 Agent 管道
│   ├── project-scanner  — 项目扫描
│   ├── file-analyzer    — 文件分析
│   ├── architecture-analyzer — 架构分析
│   ├── tour-builder     — 导览构建
│   └── graph-reviewer   — 图谱审查
└── skills/              — 技能定义
```

### 9.4 我们可对标的关键功能

**P0 — 知识图谱核心**：
1. **来源知识图谱**：将笔记本内所有来源内容构建为力导向图，节点 = 关键概念/实体，边 = 语义关系
2. **图谱交互**：节点可点击查看详情、高亮关联、拖拽布局
3. **社区聚类**：自动发现知识主题集群，帮助用户理解知识结构

**P1 — 增强功能**：
4. **引导式学习路径**：基于知识图谱的依赖关系自动生成学习顺序
5. **语义+模糊搜索**：在图谱中搜索任意概念
6. **分层可视化**：按来源类型/主题分类着色

### 9.5 技术选型建议

| 组件 | Understand-Anything 方案 | 我们的方案 |
|------|-------------------------|-----------|
| 图谱渲染 | React Flow | **react-force-graph-2d**（已在 Lumina Note 中验证） |
| 状态管理 | Zustand | 现有 useAppStore + 新建 graphStore |
| 图谱数据 | JSON 文件 | SQLite 新增 `graph_nodes` + `graph_edges` 表 |
| 实体提取 | LLM Agent 管道 | 复用现有 LLM provider + RAG 基础设施 |
| 社区发现 | 前端算法 | 前端力导向 + 简单聚类算法 |

---

## 10. 新增对标：oh-my-ppt HTML PPT 生成

> **来源**：https://github.com/arcsin1/oh-my-ppt
> **Star**：1,785+ | **语言**：TypeScript | **协议**：Apache-2.0

### 10.1 项目概述

oh-my-ppt 是一个**本地优先**的 AI PPT 生成桌面应用。用户描述需求（演讲/课程/故事），AI 自动生成精美的 HTML 幻灯片。支持离线工作，Electron 桌面应用。

### 10.2 核心功能分析

| 功能 | 说明 | 对我们的借鉴价值 |
|------|------|-----------------|
| **AI 生成 HTML PPT** | 自然语言描述 → AI 生成完整的 HTML 幻灯片 | ⭐⭐⭐ 笔记本 Studio 核心 |
| **本地优先/离线工作** | 所有数据存储在本地，无需云端 | ⭐⭐⭐ 与我们 Tauri 桌面定位一致 |
| **HTML 幻灯片渲染** | 纯 HTML/CSS 渲染，无需 Office | ⭐⭐⭐ 轻量级方案 |
| **PPT 编辑器** | 可编辑生成的幻灯片内容 | ⭐⭐⭐ 笔记本内 PPT 编辑 |
| **PPTX 导出** | 可导出为 .pptx 格式 | ⭐⭐ 与 Office 兼容 |
| **设计系统** | 内置精美设计模板 | ⭐⭐ PPT 美观度保障 |
| **Drizzle ORM** | 使用 Drizzle 进行数据库管理 | ⭐ 数据层参考 |
| **Electron 桌面** | Electron + Vite 构建 | — 我们用 Tauri |

### 10.3 技术架构关键点

```
oh-my-ppt 架构 (Electron)
├── src/main/          — Electron 主进程
├── src/preload/       — 预加载脚本
├── src/renderer/      — 渲染进程 (React 前端)
│   ├── PPT 编辑器     — 幻灯片编辑界面
│   ├── AI 生成        — 自然语言 → HTML 幻灯片
│   └── 导出功能       — HTML → PPTX
├── src/shared/        — 共享类型和工具
├── drizzle.config.ts  — Drizzle ORM 数据库配置
└── electron-builder.yml — 打包配置
```

### 10.4 我们可对标的关键功能

**P0 — PPT 生成核心**：
1. **AI 生成 HTML 幻灯片**：基于笔记本来源内容，AI 生成完整的 HTML 格式 PPT
2. **幻灯片预览**：在笔记本工作区内预览生成的 PPT
3. **PPT 保存为笔记**：生成的 PPT 可保存为笔记本笔记

**P1 — PPT 编辑**：
4. **幻灯片编辑器**：可编辑幻灯片内容（标题、正文、布局）
5. **模板系统**：内置多种设计模板
6. **PPTX 导出**：导出为 .pptx 格式

**P2 — 高级功能**：
7. **幻灯片动画**：过渡动画效果
8. **演讲者备注**：每页幻灯片的演讲备注
9. **主题切换**：幻灯片主题色/字体切换

### 10.5 技术选型建议

| 组件 | oh-my-ppt 方案 | 我们的方案 |
|------|---------------|-----------|
| 桌面框架 | Electron | **Tauri**（已有） |
| PPT 渲染 | HTML/CSS | **HTML/CSS**（iframe 渲染） |
| PPT 编辑 | 自研编辑器 | **contentEditable + 自研简化编辑器** |
| PPTX 导出 | PptxGenJS | **PptxGenJS**（npm 包） |
| AI 生成 | LLM API | 复用现有 LLM provider |
| 数据存储 | Drizzle ORM + SQLite | **SQLite**（已有） |
| 模板系统 | 内置 CSS 主题 | **CSS 主题 + JSON 配置** |

### 10.6 PPT 生成 Prompt 设计

```typescript
// 基于笔记本来源内容生成 PPT 的 Prompt 模板
const PPT_PROMPT = `
基于以下知识库内容，生成一份 ${slideCount} 页的 HTML 幻灯片演示。

要求：
1. 每页幻灯片为完整的 HTML+CSS 代码
2. 使用 16:9 宽高比 (1280x720)
3. 包含标题页、内容页、总结页
4. 设计风格：${theme}
5. 使用 Markdown 友好的排版
6. 每页幻灯片用 <slide> 标签包裹

知识库内容：
${notebookContent}

输出格式：
<slides>
  <slide>...</slide>
  <slide>...</slide>
</slides>
`;
```

---

## 11. 更新后的完整功能差距矩阵

| 功能领域 | NotebookLM | Lumina Note | Understand-Anything | oh-my-ppt | 我们当前 | 差距 | 优先级 |
|---------|-----------|-------------|---------------------|-----------|---------|------|--------|
| **知识图谱** | Mind Map 卡片 | 力导向图全屏 | ⭐⭐⭐ 图谱核心 | — | ❌ 无 | P0 | **P0** |
| **PPT 生成** | Studio 内生成 | — | — | ⭐⭐⭐ HTML PPT | ❌ 无 | P0 | **P0** |
| **PPT 编辑** | — | — | — | ⭐⭐ 编辑器 | ❌ 无 | P1 | **P1** |
| **PPTX 导出** | — | — | — | ⭐⭐ 导出 | ❌ 无 | P1 | **P1** |
| **社区聚类** | — | — | ⭐⭐⭐ 自动聚类 | — | ❌ 无 | P1 | **P1** |
| **引导式学习** | — | — | ⭐⭐ Tours | — | ❌ 无 | P1 | **P1** |
| **语义搜索图谱** | — | — | ⭐⭐⭐ 图谱搜索 | — | ❌ 无 | P1 | **P1** |
| **来源勾选框** | ✅ | — | — | — | ✅ 已实现 | — | — |
| **三栏布局** | ✅ | — | — | — | ✅ 已实现 | — | — |
| **Studio 生成** | ✅ | — | — | — | ✅ 已实现 | — | — |
| **笔记 CRUD** | ✅ | ✅ | — | — | ✅ 已实现 | — | — |
| **引用标注** | ✅ | — | — | — | ✅ 已实现 | — | — |
| **保存为笔记** | ✅ | — | — | — | ✅ 已实现 | — | — |
| **Word/TXT 编辑** | — | ✅ docx | — | — | ❌ 无 | P1 | **P1** |
| **PDF 批注** | 预览 | ✅ 批注 | — | — | ❌ 无 | P1 | **P1** |
| **WikiLinks** | — | ✅ | — | — | ❌ 无 | P2 | **P2** |
| **闪卡** | — | ✅ | — | — | ❌ 无 | P2 | **P2** |
| **Audio Overview** | ✅ | — | — | — | ❌ 无 | P2 | **P2** |

---

## 12. 更新后的分阶段实施路线图

### Phase G：知识图谱（新增） — 预计 2 周

| 任务 | 说明 | 优先级 |
|------|------|--------|
| G1. 图谱数据模型 | `graph_nodes` + `graph_edges` 表 | P0 |
| G2. 实体提取管道 | LLM 从来源 chunks 提取实体和关系 | P0 |
| G3. 图谱可视化 | react-force-graph-2d 力导向图渲染 | P0 |
| G4. 节点交互 | 点击查看详情、高亮关联、拖拽 | P0 |
| G5. 社区聚类 | 自动发现知识主题集群 | P1 |
| G6. 图谱搜索 | 语义+模糊搜索图谱节点 | P1 |
| G7. 引导式学习路径 | 基于图谱依赖生成学习顺序 | P1 |
| G8. 分层可视化 | 按来源类型/主题着色 | P2 |

### Phase H：PPT 生成与编辑（新增） — 预计 2 周

| 任务 | 说明 | 优先级 |
|------|------|--------|
| H1. PPT 生成 Prompt | 基于笔记本来源生成 HTML 幻灯片 | P0 |
| H2. 幻灯片渲染 | iframe 渲染 HTML 幻灯片预览 | P0 |
| H3. PPT 保存为笔记 | 生成结果存入 notes 表 | P0 |
| H4. Studio PPT 入口 | Studio 下拉菜单新增"PPT 演示"选项 | P0 |
| H5. 幻灯片编辑器 | contentEditable 编辑幻灯片内容 | P1 |
| H6. 模板系统 | 内置 5+ 种设计模板 | P1 |
| H7. PPTX 导出 | PptxGenJS 导出 .pptx 文件 | P1 |
| H8. 演讲者备注 | 每页幻灯片备注 | P2 |

---

## 附录 A：NotebookLM 完整功能参考

> 来源：https://notebooklm.google.com/

### 核心功能
1. **笔记本创建**：创建主题笔记本，每个笔记本是独立知识域
2. **来源添加**：PDF、Google Docs、Google Slides、粘贴文本、网页 URL、YouTube、音频
3. **来源摘要**：每个来源自动生成摘要
4. **源接地对话**：回答仅基于笔记本来源
5. **引用标注**：回答中标注来源，可点击跳转
6. **建议问题**：基于来源生成引导问题
7. **笔记**：创建笔记，保存 AI 回答为笔记
8. **简报文档**：自动生成结构化简报
9. **学习指南**：问答 + 关键词 + 摘要
10. **FAQ**：常见问答
11. **时间线**：事件时间线
12. **思维导图**：知识结构可视化
13. **Audio Overview**：播客式音频摘要
14. **发现相关来源**：推荐网络资源
15. **共享笔记本**：多人协作

## 附录 B：Lumina Note 完整功能参考

> 来源：https://github.com/blueberrycongee/lumina-note

### 核心功能
1. **Markdown 编辑**：CodeMirror 实时预览 + 阅读模式 + LaTeX
2. **WikiLinks**：`[[笔记名]]` 双向链接
3. **反向链接**：Backlinks 面板
4. **知识图谱**：力导向图可视化
5. **PDF + 批注**：PDF 查看与标注
6. **闪卡**：从笔记生成闪卡
7. **AI 跨笔记操作**：读写/重整/摘要/连接/生成
8. **多 AI 提供商**：OpenAI/Claude/Gemini/DeepSeek/Kimi/智谱/MiMo/Groq/OpenRouter/Ollama
9. **Agent Skills**：自定义命令和技能
10. **插件系统**：开发者预览
11. **文档引擎**：docx 导入/导出 + IR + OpenOffice 渲染参考
12. **Cloud Sync**：云端同步（开发中）
13. **移动端**：iOS/Android 原生应用
14. **自托管中继**：自托管服务
15. **外观插件**：主题/外观可定制

## 附录 C：Understand-Anything 完整功能参考

> **来源**：https://github.com/Egonex-AI/Understand-Anything
> **Star**：76,000+ | **语言**：TypeScript | **协议**：MIT

### 核心功能
1. **结构化知识图谱**：文件/函数/类/依赖 → 可交互力导向图
2. **领域视图（Domain View）**：代码 → 业务流程映射（领域/流程/步骤）
3. **知识库分析**：wiki/知识库 → LLM 提取实体关系 → 社区聚类图
4. **引导式导览（Guided Tours）**：按依赖顺序自动生成架构走查
5. **模糊+语义搜索**：按名称或语义搜索图谱节点
6. **Diff 影响分析**：修改的影响范围可视化
7. **角色自适应 UI**：初级开发/PM/高级用户不同详情层级
8. **分层可视化**：按架构层（API/Service/Data/UI/Utility）着色
9. **语言概念解释**：12种编程模式上下文解释
10. **多 Agent 管道**：project-scanner / file-analyzer / architecture-analyzer / tour-builder / graph-reviewer
11. **多平台支持**：Claude Code / Codex / Cursor / Copilot / Gemini CLI / OpenCode / Pi Agent / Vibe CLI / Trae
12. **增量分析**：仅重新分析变更文件，减少 token 消耗
13. **自动更新**：Git post-commit hook 触发重新分析
14. **多语言支持**：en / zh / zh-TW / ja / ko / ru / es / tr

## 附录 D：oh-my-ppt 完整功能参考

> **来源**：https://github.com/arcsin1/oh-my-ppt
> **Star**：1,785+ | **语言**：TypeScript | **协议**：Apache-2.0

### 核心功能
1. **AI 生成 HTML PPT**：自然语言描述 → AI 生成完整 HTML 幻灯片
2. **本地优先/离线工作**：所有数据存储在本地，无需云端
3. **HTML 幻灯片渲染**：纯 HTML/CSS 渲染，无需 Office
4. **PPT 编辑器**：可编辑生成的幻灯片内容
5. **PPTX 导出**：导出为 .pptx 格式
6. **设计系统**：内置精美设计模板
7. **桌面应用**：Electron + Vite 构建
8. **Drizzle ORM**：Drizzle 数据库管理
9. **幻灯片缩略图导航**：左侧缩略图列表
10. **全屏预览**：幻灯片全屏展示模式
