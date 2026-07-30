# 笔记本系统：未实现功能分析清单

> **生成日期**：2026-07-27
> **分析基础**：对比 `NOTEBOOK-FEATURE-GAP-ANALYSIS.md` 路线规划 + 4 个对标项目（NotebookLM / Lumina Note / Understand-Anything / oh-my-ppt）的完整功能集
> **代码审查范围**：`src/core/knowledge/` 全部模块 + `src/components/NotebookWorkspace.tsx` / `KnowledgeGraphView.tsx` / `PPTEditor.tsx`

---

## 一、已实现功能确认（基线）

在分析未实现功能前，先确认当前**已落地**的能力：

| # | 功能 | 实现文件 | 对标来源 |
|---|------|---------|---------|
| 1 | 笔记本 CRUD + 搜索 | `storage.ts` | NotebookLM |
| 2 | 来源管理（文本/文件/URL） | `storage.ts`, `extractor.ts` | NotebookLM |
| 3 | PDF 文本提取（纯 TS） | `pdf-extractor.ts` | NotebookLM |
| 4 | 文本分块 + Embedding 索引 | `chunker.ts`, `indexer.ts` | NotebookLM |
| 5 | 本地嵌入（ONNX WASM） | `local-embedding.ts` | 自研 |
| 6 | 语义检索 + 维度保护 + LRU 缓存 | `retriever.ts` | NotebookLM |
| 7 | 来源勾选框 + 检索范围过滤 | `retriever.ts` (`setActiveSourceFilter`) | NotebookLM |
| 8 | 笔记本摘要 + 建议问题 | `indexer.ts` | NotebookLM |
| 9 | 笔记 CRUD | `storage.ts` | NotebookLM / Lumina Note |
| 10 | Studio 内容生成（7 种类型） | `indexer.ts` (`generateStudioContent`) | NotebookLM |
| 11 | 三栏布局 + 视图切换 | `NotebookWorkspace.tsx` | NotebookLM |
| 12 | 知识图谱提取（LLM 实体/关系） | `graph-extractor.ts` | Understand-Anything |
| 13 | 知识图谱可视化（Canvas 力导向） | `KnowledgeGraphView.tsx` | Understand-Anything |
| 14 | 社区聚类（连通分量算法） | `graph-extractor.ts` | Understand-Anything |
| 15 | 图谱交互（搜索/拖拽/缩放/平移） | `KnowledgeGraphView.tsx` | Understand-Anything |
| 16 | PPT 生成（AI → HTML 幻灯片） | `ppt-generator.ts` | oh-my-ppt |
| 17 | PPT 编辑器（contentEditable + iframe） | `PPTEditor.tsx` | oh-my-ppt |
| 18 | PPT 主题系统（5 套主题） | `ppt-generator.ts` | oh-my-ppt |
| 19 | PPT 导出 HTML | `PPTEditor.tsx` | oh-my-ppt |
| 20 | 笔记链接存储（`note_links` 表） | `storage.ts` | Lumina Note |
| 21 | 三套皮肤兼容 | 全部组件 | 自研 |

---

## 二、未实现功能完整清单

### P0 — 核心缺失（严重影响可用性）

| # | 功能 | 对标项目 | 当前状态 | 差距描述 | 涉及文件（待创建/修改） |
|---|------|---------|---------|---------|----------------------|
| 1 | **Markdown 编辑器（实时预览）** | Lumina Note / NotebookLM | ⚠️ 仅 `textarea` | 笔记编辑器只是一个纯文本 `textarea`，无 Markdown 实时预览、语法高亮、LaTeX 渲染。对标项目使用 CodeMirror 或类似编辑器。 | `NotebookWorkspace.tsx` 中的 `NoteEditorDialog` |
| 2 | **WikiLinks 解析与 UI** | Lumina Note | ⚠️ 存储层已有 | `note_links` 表和 `addNoteLink`/`getBacklinks` 函数已存在，但**没有任何代码解析 `[[笔记标题]]` 语法**，也没有 UI 入口。用户无法在笔记中创建双向链接。 | `note-manager.ts` ← 待创建；`NotebookWorkspace.tsx` |
| 3 | **反向链接面板（Backlinks）** | Lumina Note | ⚠️ 存储层已有 | `getBacklinks()` 函数已实现，但**没有 UI 面板**展示哪些笔记引用了当前笔记。 | `BacklinksPanel.tsx` ← 待创建 |

### P1 — 重要缺失（影响核心体验）

| # | 功能 | 对标项目 | 当前状态 | 差距描述 | 涉及文件（待创建/修改） |
|---|------|---------|---------|---------|----------------------|
| 4 | **PDF 原文渲染** | NotebookLM / Lumina Note | ❌ 仅文本提取 | 当前 PDF 只提取纯文本，没有使用 PDF.js 渲染原始页面。用户无法看到 PDF 原文。 | `PDFViewer.tsx` ← 待创建 |
| 5 | **PDF 高亮批注** | Lumina Note | ❌ 完全缺失 | 无批注层、无高亮功能、无批注持久化。`notebook_annotations` 表在规划中但未创建。 | `annotation-store.ts` ← 待创建；`PDFViewer.tsx` |
| 6 | **来源摘要卡片** | NotebookLM | ❌ 不支持 | 每个来源没有独立的摘要卡片。当前只有笔记本级别的摘要，缺少**单个来源**的摘要和关键话题。 | `indexer.ts` 修改 |
| 7 | **引用精确定位（页码/段落）** | NotebookLM | ⚠️ 仅 `[Source: name]` | 检索结果只有 `chunkIndex`，没有页码、段落号等精确定位信息。无法定位到原文具体位置。 | `retriever.ts`, `types.ts` 修改 |
| 8 | **引用跳转原文** | NotebookLM | ❌ 不支持 | 对话中点击引用标注无法跳转到来源原文。缺少来源原文查看器。 | `SourceViewer.tsx` ← 待创建 |
| 9 | **Word (.docx) 编辑** | Lumina Note | ❌ 完全缺失 | 不支持打开、预览、编辑 .docx 文件。无 `mammoth.js` 集成。 | `docx-import.ts`, `docx-export.ts` ← 待创建 |
| 10 | **TXT/MD 文件编辑器** | Lumina Note | ❌ 完全缺失 | 无法在笔记本内打开 .txt/.md 文件进行编辑。 | `DocEditor.tsx` ← 待创建 |
| 11 | **思维导图（Mind Map）** | NotebookLM | ❌ 完全缺失 | 无法生成 Mermaid 思维导图或任何形式的知识结构可视化思维导图。 | `content-generator.ts` 扩展 |
| 12 | **笔记本导出（Markdown/PDF）** | NotebookLM | ❌ 完全缺失 | 无法将笔记本内容（来源+笔记+生成内容）导出为 Markdown 或 PDF。 | `exporter.ts` ← 待创建 |
| 13 | **PPTX 导出** | oh-my-ppt | ❌ 仅 HTML 导出 | 只能导出 HTML，无法导出 .pptx 格式。需引入 `PptxGenJS`。 | `PPTEditor.tsx` 修改 |
| 14 | **AI 跨笔记操作工具** | Lumina Note | ❌ 完全缺失 | AI 无法在对话中创建笔记、编辑笔记、连接笔记。缺少 `create_note`、`edit_note`、`link_notes`、`list_notes` 工具。 | `create-note.ts`, `edit-note.ts`, `link-notes.ts` ← 待创建 |
| 15 | **AI 自动生成笔记** | NotebookLM / Lumina Note | ❌ 不支持 | AI 无法根据来源内容自动生成结构化笔记。当前 Studio 生成的内容保存为笔记，但不是 AI 主动操作。 | `content-generator.ts` 扩展 |
| 16 | **引导式学习路径** | Understand-Anything | ❌ 完全缺失 | 无法基于知识图谱的依赖关系自动生成学习顺序。 | `graph-extractor.ts` 扩展 |
| 17 | **图谱语义搜索** | Understand-Anything | ⚠️ 仅文本模糊搜索 | 图谱搜索只支持按名称模糊匹配，不支持语义搜索（embedding-based）。 | `KnowledgeGraphView.tsx`, `graph-extractor.ts` |
| 18 | **分层可视化** | Understand-Anything | ❌ 不支持 | 图谱节点没有按来源类型/主题分层着色。当前仅按实体类型着色。 | `KnowledgeGraphView.tsx` |

### P2 — 增强缺失（提升体验）

| # | 功能 | 对标项目 | 当前状态 | 差距描述 | 涉及文件（待创建/修改） |
|---|------|---------|---------|---------|----------------------|
| 19 | **来源关键话题提取** | NotebookLM | ✅ 已实现 | 来源摘要生成时同时提取关键话题标签, 在来源卡片中展示 | `indexer.ts` |
| 20 | **YouTube 字幕提取** | NotebookLM | ❌ 不支持 | 无法从 YouTube URL 提取字幕作为来源。 | `extractor.ts` 修改 |
| 21 | **对话历史搜索** | — | ❌ 不支持 | 无法全文搜索笔记本内的历史对话。 | 新建搜索模块 |
| 22 | **闪卡生成 + 间隔重复** | Lumina Note | ❌ 完全缺失 | 无法从笔记内容生成闪卡，无间隔重复学习功能。 | `flashcard.ts` ← 待创建 |
| 23 | **发现相关来源** | NotebookLM | ❌ 不支持 | 无法根据笔记本内容推荐相关网络资源（需 Web Search）。 | 新建推荐模块 |
| 24 | **AI 知识清理** | Lumina Note | ❌ 不支持 | AI 无法识别重复笔记、建议合并、自动分类整理。 | `note-manager.ts` 扩展 |
| 25 | **阅读模式** | Lumina Note | ✅ 已实现 | NoteEditor 支持预览模式, 隐藏 Markdown 标记, 渲染排版 | `NoteEditor.tsx` |
| 26 | **LaTeX 公式渲染** | Lumina Note | ❌ 不支持 | 笔记内容不支持 LaTeX 数学公式渲染。 | `NotebookWorkspace.tsx` |
| 27 | **演讲者备注 UI** | oh-my-ppt | ✅ 已实现 | PPT 编辑器底部新增备注编辑区域, 保存到 Slide.notes 字段 | `PPTEditor.tsx` |
| 28 | **幻灯片动画/过渡效果** | oh-my-ppt | ❌ 不支持 | 幻灯片之间无过渡动画，放映时无动画效果。 | `PPTEditor.tsx` 修改 |
| 29 | **全屏放映模式** | oh-my-ppt | ✅ 已实现 | 新增 PresentMode 组件, 全屏 iframe 渲染, 键盘翻页 (←→/Space/Esc), 显示备注 | `PPTEditor.tsx` |
| 30 | **角色自适应 UI** | Understand-Anything | ❌ 不支持 | 无法根据用户角色（初学者/专家）调整图谱详情层级。 | `KnowledgeGraphView.tsx` |
| 31 | **增量图谱分析** | Understand-Anything | ❌ 每次全量重建 | 每次点击「重新提取」会 `deleteGraphData` 后全量重建，不支持仅分析新增来源。 | `graph-extractor.ts` 修改 |
| 32 | **领域视图（Domain View）** | Understand-Anything | ❌ 不支持 | 无法将知识映射到业务流程（领域/流程/步骤）以水平图展示。 | 新建组件 |
| 33 | **Diff 影响分析** | Understand-Anything | ❌ 不支持 | 来源内容变更后，无法可视化变更对整个知识图谱的影响范围。 | 新建模块 |

### P3 — 远期功能

| # | 功能 | 对标项目 | 当前状态 | 差距描述 |
|---|------|---------|---------|---------|
| 34 | **音频文件支持（STT）** | NotebookLM | ❌ 不支持 | 需要 Whisper STT 集成，依赖较重 |
| 35 | **Audio Overview（播客摘要）** | NotebookLM | ❌ 不支持 | 需要 TTS + 播客脚本生成 |
| 36 | **插件系统** | Lumina Note | ❌ 不支持 | 笔记本扩展插件架构，远期规划 |
| 37 | **多语言图谱支持** | Understand-Anything | ⚠️ 仅 zh/en | 图谱提取支持 zh/en，但不支持 ja/ko/ru/es 等多语言 |
| 38 | **共享笔记本** | NotebookLM | ❌ 不支持 | 桌面应用架构，暂不纳入 |
| 39 | **笔记本分组** | NotebookLM | ❌ 不支持 | 多个笔记本的组织和管理（文件夹/标签） |

---

## 三、按对标项目分组统计

### NotebookLM（共 15 项核心功能）

| 状态 | 数量 | 功能 |
|------|------|------|
| ✅ 已实现 | 7 | 笔记本 CRUD、来源管理、源接地问答、建议问题、笔记 CRUD、Studio 生成（7 种）、来源勾选 |
| ❌ 未实现 | 8 | PDF 渲染+批注、来源摘要卡片、引用精确定位+跳转、思维导图、YouTube 字幕、音频支持、Audio Overview、笔记本导出、发现相关来源 |

### Lumina Note（共 12 项核心功能）

| 状态 | 数量 | 功能 |
|------|------|------|
| ✅ 已实现 | 3 | 笔记 CRUD、笔记链接存储（底层）、多 AI 提供商（项目已有） |
| ❌ 未实现 | 9 | Markdown 编辑器（CodeMirror）、WikiLinks 解析 UI、反向链接面板、Word 编辑、TXT/MD 编辑、闪卡、AI 跨笔记操作、阅读模式、LaTeX 渲染 |

### Understand-Anything（共 10 项核心功能）

| 状态 | 数量 | 功能 |
|------|------|------|
| ✅ 已实现 | 4 | 结构化知识图谱、图谱交互、社区聚类、知识库分析 |
| ❌ 未实现 | 6 | 领域视图、引导式导览、图谱语义搜索、Diff 影响分析、角色自适应 UI、增量分析 |

### oh-my-ppt（共 8 项核心功能）

| 状态 | 数量 | 功能 |
|------|------|------|
| ✅ 已实现 | 5 | AI 生成 HTML PPT、HTML 幻灯片渲染、PPT 编辑器、设计模板、本地优先 |
| ❌ 未实现 | 3 | PPTX 导出、幻灯片动画、全屏放映模式 |

---

## 四、差距严重度分布图

```
未实现功能严重度分布（共 39 项）：

P0（核心缺失）：3 项
  ├── Markdown 编辑器（实时预览）
  ├── WikiLinks 解析与 UI
  └── 反向链接面板

P1（重要缺失）：15 项
  ├── PDF 原文渲染 + 批注
  ├── 来源摘要卡片
  ├── 引用精确定位 + 跳转
  ├── Word/TXT 文档编辑
  ├── 思维导图
  ├── 笔记本导出
  ├── PPTX 导出
  ├── AI 跨笔记操作工具
  ├── AI 自动生成笔记
  ├── 引导式学习路径
  ├── 图谱语义搜索
  └── 分层可视化

P2（增强缺失）：16 项
  ├── 来源关键话题
  ├── YouTube 字幕
  ├── 对话历史搜索
  ├── 闪卡 + 间隔重复
  ├── 发现相关来源
  ├── AI 知识清理
  ├── 阅读模式 / LaTeX
  ├── 演讲者备注 UI
  ├── 幻灯片动画 / 放映模式
  ├── 角色自适应 UI
  ├── 增量图谱分析
  ├── 领域视图
  └── Diff 影响分析

P3（远期）：5 项
  ├── 音频 STT
  ├── Audio Overview
  ├── 插件系统
  ├── 多语言图谱
  └── 共享/分组
```

---

## 五、建议实施优先级

### 第一优先（P0，预计 1.5 周）
1. **Markdown 编辑器**：引入 `@uiw/react-md-editor` 或 CodeMirror，替换 `textarea`，支持实时预览
2. **WikiLinks 解析**：实现 `[[笔记标题]]` 正则解析 + 自动建立 `note_links` 记录
3. **反向链接面板**：在笔记编辑器侧边展示 Backlinks

### 第二优先（P1 核心，预计 4 周）
4. **PDF 渲染 + 批注**：集成 `pdfjs-dist`，实现高亮/评论/持久化
5. **引用精确定位 + 跳转**：检索结果增加页码/段落信息，点击跳转到来源原文
6. **来源摘要卡片**：索引时为每个来源生成独立摘要
7. **Word/TXT 编辑**：集成 `mammoth.js`（docx 预览）+ CodeMirror（txt/md 编辑）
8. **思维导图**：基于 Mermaid mindmap 语法生成
9. **笔记本导出**：导出为 Markdown 打包
10. **PPTX 导出**：集成 `PptxGenJS`
11. **AI 跨笔记工具**：实现 `create_note`/`edit_note`/`link_notes` 工具
12. **引导式学习路径**：基于图谱拓扑排序生成学习顺序

### 第三优先（P2 增强，预计 3 周）
13. **来源关键话题** / **YouTube 字幕** / **对话历史搜索**
14. **闪卡生成** / **AI 知识清理**
15. **阅读模式** / **LaTeX 渲染**
16. **PPT 演讲者备注 UI** / **放映模式** / **动画**
17. **图谱语义搜索** / **增量分析** / **分层可视化**

### 第四优先（P3 远期，视需求）
18. 音频 STT / Audio Overview
19. 插件系统
20. 多语言 / 共享 / 分组

---

## 六、技术依赖预估

| 新增依赖 | 用途 | 体积 (gzip) | 优先级 |
|---------|------|------------|--------|
| `@uiw/react-md-editor` | Markdown 编辑+预览 | ~120KB | P0 |
| `pdfjs-dist` | PDF 渲染 | ~300KB | P1 |
| `mammoth` | docx → HTML | ~150KB | P1 |
| `PptxGenJS` | PPTX 导出 | ~200KB | P1 |
| `react-markdown` + `remark-gfm` | Markdown 渲染（阅读模式） | ~80KB | P2 |
| `katex` | LaTeX 公式 | ~60KB | P2 |

**总增量**：~910KB（gzip 后约 300KB）
