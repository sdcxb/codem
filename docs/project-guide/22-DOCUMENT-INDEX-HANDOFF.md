# 22 · 项目级文档索引：重型任务移交方案

> **基线**：2026-11-04 ｜ 版本 **1.18.5**（GitHub `Latest`）｜ 全量 **880 文件 / 9551 用例 / 9534 通过 / 17 skipped / 0 失败** ｜ `tsc` 0。
>
> **本文件给新会话接“项目级文档索引”用。** 先读本文件，再读 `20-HEAVY-TASK-HANDOFF.md`、`00-AGENT-HANDBOOK.md`、`09-CURRENT-STATE.md`、`03-RUNTIME-FLOWS.md`、`06-DATA-STORAGE.md`。
>
> **一句话**：现在 Codem 只能把文档当“消息里的文本”逐页读；目标是把 **附件上传、对话里明确给出的路径、粘贴的文件/图片** 都变成项目级、可增量、可检索、可引用的文档索引，Agent 默认只读命中的段，而不是整篇进上下文。

---

## 1. 先给新会话的开场白（可直接粘贴）

```text
你在 C:\mimo-gui 接手 Codem 的“项目级文档索引”重型任务。先不要改代码。

按顺序读：
1. docs/project-guide/22-DOCUMENT-INDEX-HANDOFF.md（本文件）
2. docs/project-guide/20-HEAVY-TASK-HANDOFF.md
3. docs/project-guide/00-AGENT-HANDBOOK.md
4. docs/project-guide/09-CURRENT-STATE.md
5. docs/project-guide/03-RUNTIME-FLOWS.md 的“一轮对话/工具/存储”
6. docs/project-guide/06-DATA-STORAGE.md 的 schema/迁移/数据根

然后跑：
git status -sb
git log --oneline -5
npx tsc --noEmit
npx vitest run src/test/version-consistency.test.ts

任务边界：
- 先写 ADR/判据/最小实现计划，不要直接大改；
- 目标是“项目级文档索引 + 检索优先”，不是把上下文窗口调大；
- 附件上传、对话中明确路径、粘贴文件/图片三条入口都必须进索引；
- 先做 P0：schema + ingestion + doc_outline/doc_search/doc_read + 三条入口 + 状态 UI；
- 不做 OCR/向量/全书 map-reduce 的第二阶段，除非 P0 验收通过后用户确认。

硬规则：判据先行 + 变异自证；禁止 goal mode/自动续跑开发本仓库；
不要整树 git 操作；只按 PID 杀自己 spawn 的进程；发版前先问用户；
中文引号用「」；新文件 UTF-8 无 BOM；不要为让测试变绿而弱化完成门/验证门。

先向我汇报：你读到的当前链路、三条入口的现状、P0 的具体文件清单、第一批判据、风险和需要我拍板的问题；我确认后再动手。
```

---

## 2. 为什么必须做（当前事实）

用户日常工作：大量 `.docx/.pdf/.xlsx/.pptx/.md`，几十到几百 MB，多文件，多轮对话让模型读。

当前 Codem 的实际链路（证据见下）：

```text
附件 / 路径 / 粘贴
  → read / read_attachment / bash+python 提取
  → 工具结果作为 message 进入上下文
  → pruneStaleToolResults → selectMessagesByPriority → microCompact/fold
  → 70% 自动压缩（保留窗口 40%，最近 3 轮、最多 60 条）
  → 90% 水位提示；仍装不下 → context_overflow
```

关键限制：

| 环节 | 现状 | 后果 |
|---|---|---|
| `read` | 单次 50,000 字符 / 2,000 行（`tools.ts`） | 100MB 文本约 2,000 次读取 |
| `read_attachment` | 默认 8K、最大 50K 字符，按字符 offset | 没有章节/页码结构，盲目翻页 |
| 文档提取 | `knowledge/extractor.ts` 把整个 Office 文件读成 base64，再在渲染进程解析 | 100MB 文件容易卡死/OOM |
| 文档索引 | `knowledge` 的 chunk/embedding 是 notebook 专用；chunk 镜像上限 2,000 行 | 不是项目文档库，装不下大 corpus |
| 压缩 | 通用对话摘要，保留最近 3 轮/最多 60 条；保留预算 = 窗口 40% | 单轮读几十份文档时保留集本身就超预算 |
| 工具结果 | `read` 不落 spill，`maxResultSizeChars: Infinity` | 每页都留在消息里，没有原文句柄 |
| 文档入口 | 附件只是 `MessageAttachment`；docx/pdf 没有持久原文/路径 | 无法在之后重新索引或引用 |

**结论**：这不是水位/压缩参数问题，是“文档内容被当成聊天消息”的结构错配。100MB 文档约需 2,000 次英文读取 / 600+ 次中文读取，合计 2,000 万–6,000 万 token；1M 窗口也只是 20–60 倍差距。

---

## 3. 三条入口的现状（必须改）

### 3.1 附件上传

现状：

- `src/components/FileUpload.tsx`：
  - 文本文件 ≤200KB 直接读入 `content`；
  - 图片读成 data URL；
  - **docx/pdf 等二进制文件没有 `content`、没有本地路径**，只保留名称/大小/MIME；
- `src/components/InputArea.tsx`：
  - `handleUpload` 只把 `MessageAttachment[]` 放进 pending；
  - `onSend` 后附件随消息落库，但**没有原始字节/路径可供再次解析**；
- `MessageAttachment`（`src/store.ts:80`）只有 `content/preview/sandboxPath`，没有 documentId/sourceId。

目标：

- 上传即入索引队列；返回 `documentId`，附件只携带 `documentId` 和展示信息；
- 二进制原文件落到受管目录（例如 `<dataRoot>/documents/blobs/<sha256>`），不要只塞进消息；
- 图片同样入索引：OCR/说明文本 + 元数据；没有 OCR 能力时明确标 `needs_ocr`，不要假装有正文。

### 3.2 对话里直接给路径

现状：

- `extractFilePathsFromText()` 已在 `src/core/llm/tools.ts:375` 存在，但当前**没有接进入口**；
- 模型只能看到文本路径，自己决定是否 `read`；不会自动索引。

目标：

- 用户消息发送时（或 Agent 回合开始前）解析**明确出现的本地路径**；
- 只索引：存在、可读、在允许根目录内、扩展名属于文档/图片的文件；
- 不因路径出现在代码片段/日志里就误索引；只处理当前用户消息，不扫历史；
- 同一文件按 `sha256 + mtime + size` 去重；
- 可增加显式命令 `/index <path>` / “把这份资料加入项目索引”，但**默认也要覆盖普通路径提及**。

### 3.3 对话窗口粘贴文件/图片

现状：

- `InputArea.tsx:1143` 的 `handlePaste` 只处理 clipboard 里的 `image/*`，转 data URL；
- 粘贴的文件（非图片）没有入口；
- 图片只作为消息附件，不进入文档索引。

目标：

- 粘贴图片：保存原图 → 入索引（OCR/vision 摘要 + 尺寸/哈希）；
- 粘贴文件（clipboard files）：与上传同一条 ingestion 管线；
- 粘贴的文本不自动当文档（它是消息正文）；
- 索引状态在附件 badge 上可见：`索引中 / 已索引 / 需 OCR / 失败`。

---

## 4. 目标架构

```text
入口层
  ├─ FileUpload / OS drop / paste image/file
  ├─ 用户消息路径解析（extractFilePathsFromText + 校验）
  └─ @mention / 文件树拖入
        │
        ▼
DocumentIngestionService（后台队列）
  ├─ 源登记：collection_id, source_kind, source_ref, sha256, mtime, size
  ├─ 去重/增量：hash 未变 → skip；路径变化 → 重新登记
  ├─ 提取：docx/pdf/xlsx/pptx/md/txt/图片 OCR
  ├─ 分块：章节/页/段落/表格 → chunk（500–1000 token，10–15% overlap）
  └─ 写入：documents / document_chunks / FTS5（可选 embedding）
        │
        ▼
DocumentIndex（SQLite，项目级持久）
        │
        ▼
Agent 工具
  ├─ doc_outline(collection)
  ├─ doc_search(collection, query, k, max_tokens)
  ├─ doc_read(collection, chunk_id/page, max_tokens)
  └─ doc_status(collection)
        │
        ▼
Context
  ├─ 只返回 snippet + citation（file/page/heading/chunkId）
  ├─ DocumentLedger（文件、目录、已读范围、事实、引用、未读）
  └─ 压缩保留 ledger，不保留全文
```

### 4.1 项目作用域

- 有 `currentProject`：`collection_id = projectId`，文档属于项目，跨会话可复用；
- 无项目（全局对话）：`collection_id = "session:<sessionId>"`，但保留未来提升到全局库的接口；
- 同一文件可属于多个 collection？P0 先允许“一条 source 记录 + 多个 collection 关联”，或直接按 collection 复制记录；必须明确去重边界，不能重复解析同一 hash。

### 4.2 数据模型（建议）

新增表（走 `codem-db` 迁移，不裸 SQL）：

```sql
document_collections(id, project_id, name, created_at, updated_at)
document_sources(
  id, collection_id, kind,            -- attachment | path | paste | mention
  source_ref,                          -- attachment id / absolute path / paste id
  original_name, mime_type, size, sha256, mtime,
  page_count, chunk_count, status,     -- pending | indexing | ready | failed | needs_ocr
  error, metadata_json, created_at, updated_at
)
document_chunks(
  id, source_id, ordinal, page, heading,
  text, token_count, content_hash, metadata_json
)
document_chunks_fts(text, source_id, chunk_id)  -- FTS5
document_index_jobs(id, source_id, status, progress, error, created_at, updated_at)
```

约束：

- `UNIQUE(collection_id, sha256)` 或 `UNIQUE(collection_id, canonical_path)`，按产品决定；
- `document_chunks` 不塞进消息表；
- 大文件原文放 `<dataRoot>/documents/blobs/<sha256>`（附件/粘贴），路径型文档可不复制，只登记路径 + hash；
- 删除/重建/移动要可追踪；路径型文档删除后标 stale，不静默保留旧正文。

### 4.3 提取与分块

必须复用/改造现有能力，但不能照搬当前 renderer base64 路径：

- 现有：`src/core/knowledge/extractor.ts`（docx/pdf/xlsx/pptx）、`pdf-extractor.ts`、`chunker.ts`、`indexer.ts`、`local-embedding.ts`；
- `extractFromOffice` 当前 `invoke('read_file', {encoding:'base64'})` 读整文件 → 渲染进程 `atob` → mammoth/JSZip；**100MB 不可接受**；
- P0 把 docx/pdf 提取放 Rust 侧或独立 worker：流式/有界读取，文件大小上限、超时、取消、进度；
- PDF 先支持文本型；扫描件标 `needs_ocr`，不要返回空文本冒充成功；
- 分块优先按标题/页/段落/表格；chunk 500–1000 token，overlap 10–15%；保留 `page`/`heading`/`table`；
- 图片：OCR（本地/服务）或 vision 描述；没有能力时只索引元数据并明确状态。

### 4.4 工具契约

```text
doc_outline(collection_id)
  → [{sourceId, name, pages, headings, chunkCount, status}]

doc_search(collection_id, query, topK=8, max_tokens=6000)
  → [{sourceId, chunkId, file, page, heading, snippet, score, tokenCount}]

doc_read(collection_id, chunkId | sourceId+page, max_tokens=4000)
  → {text, citation, hasMore}

doc_status(collection_id)
  → {files, indexed, pending, failed, needsOcr, totalChunks}
```

硬约束：

- 单次 `doc_search` ≤6K token；`doc_read` ≤4K token；
- 不返回整篇正文；
- 每个结果带稳定 citation：`sourceId + page/heading + chunkId`；
- 索引未就绪时返回明确状态，不返回“没有相关内容”；
- `read` 遇到 `.docx/.pdf/.xlsx/.pptx` 时转向文档工具，不返回二进制垃圾。

### 4.5 Context 集成

- `DocumentLedger` 每轮注入尾部（不是 system 前缀），2K token 内；
- 记录：文件清单/哈希/目录、已读 chunk、已确认事实 + citation、未读章节；
- 压缩时保留 ledger；已关闭文档段可摘要，活动段不压；
- 不要用“再写一段提示词”替代结构；工具契约 + ledger + compaction 才是结构。

---

## 5. P0 实施顺序（新会话按这个做）

### Step 0：ADR + 判据

- 写 `docs/architecture/ADR-0008-PROJECT-DOCUMENT-INDEX.md`：
  - 作用域（project vs session）；
  - 三条入口；
  - 存储/提取/分块/检索；
  - 隐私/沙箱/大小上限；
  - 非目标（OCR 全量、向量、map-reduce 第二阶段）。
- 先写判据（至少）：

| 编号 | 判据 |
|---|---|
| DOCI-1 | 上传 `.docx` 后产生 source + chunks，状态 `ready`，重启后仍在 |
| DOCI-2 | 上传 `.pdf` 文本型可检索；扫描件标 `needs_ocr`，不假成功 |
| DOCI-3 | 对话里出现存在的 `.md/.docx` 路径 → 自动登记；不存在的路径不登记 |
| DOCI-4 | 粘贴图片 → 保存原图 + OCR/vision 索引；无 OCR 标 `needs_ocr` |
| DOCI-5 | 同一文件重复上传/重复路径 → 按 hash 去重，不重复解析 |
| DOCI-6 | `doc_search` 返回 ≤6K token 的 snippet + citation；`doc_read` ≤4K |
| DOCI-7 | 大文件（先 10MB，后 100MB）索引不阻塞 UI、有进度、可取消 |
| DOCI-8 | 删除文档/文件移动 → 索引标 stale/删除，不返回旧正文 |
| DOCI-9 | 现有 9534 测试不回归；代码验证门不变 |

### Step 1：存储 + 迁移

- 新增 SQLite 表/迁移；
- 类型化仓储，不写裸 SQL；
- 数据根 `documents/blobs` 的清理/配额；
- 先做 schema 判据 + 迁移回滚。

### Step 2：IngestionService

- 入队、并发限制、取消、重试、进度；
- 源登记（attachment/path/paste）；
- hash/mtime/size 增量；
- 提取器：先复用 `knowledge` 的格式支持，但改成 Rust/worker、有界读取；
- 分块 + FTS5 写入；
- 失败如实记录，不把“提取失败”标 ready。

### Step 3：三条入口接线

- `FileUpload.tsx`：上传即入队，附件携带 `documentId`；docx/pdf 不再只留元数据；
- `InputArea.handlePaste`：图片/文件入队；
- `InputArea` / `App` 发送前：解析用户消息路径（`extractFilePathsFromText` + 存在性/根目录校验）入队；
- OS drop：同上传；
- 项目切换/会话切换：collection 绑定；状态 UI。

### Step 4：工具 + 提示 + ledger

- 新增 `doc_outline/doc_search/doc_read/doc_status`；
- 工具注册、schema、guidance；`read` 文档扩展名重定向；
- system/tail guidance：文档任务先 outline/search，不整篇读；
- `DocumentLedger` 注入与压缩保留；
- 上下文预算：`doc_search` ≤6K，`doc_read` ≤4K。

### Step 5：验收

- 10MB/100MB、200 文件、多格式；
- 附件/路径/粘贴/重启；
- 引用回溯；
- 内存/CPU/取消；
- 现有全量测试 + 新判据。

---

## 6. 关键文件（新会话从这里读/改）

| 文件 | 作用 |
|---|---|
| `src/components/FileUpload.tsx` | 上传入口；当前只读 200KB 文本/图片，二进制无原文 |
| `src/components/InputArea.tsx` | `handleUpload` / `handlePaste` / `onSend`；三条入口的 UI 交汇 |
| `src/store.ts:80` | `MessageAttachment` 形状；要加 documentId/sourceId |
| `src/core/llm/tools.ts:375` | `extractFilePathsFromText`；已存在但未接进入口 |
| `src/core/knowledge/extractor.ts` | docx/pdf/xlsx/pptx 提取；**当前 base64 整文件路径必须改** |
| `src/core/knowledge/chunker.ts` | 现有分块器，可复用/改 page/heading |
| `src/core/knowledge/indexer.ts` | 现有 embedding 索引管线，可参考，不要直接套 notebook 生命周期 |
| `src/core/knowledge/storage.ts:91` | chunk 镜像 2,000 行上限；项目库不能沿用这个读法 |
| `src/core/llm/agentic-loop.ts` | 工具循环、`buildMessages`、压缩；ledger/工具接入点 |
| `src/core/llm/context-fold.ts` | 工具结果裁剪；文档句柄/不整篇读的边界 |
| `src/core/llm/compaction-budget.ts` | 压缩保留/摘要；文档感知压缩接入点 |
| `src-tauri/codem-db/sql/schema.sql` | 迁移/schema（以实际路径为准） |
| `src-tauri/src/storage.rs` / `codem-db` | 仓储命令、单写者、authorizer |

先读这些文件的注释；仓库里很多“为什么”写得很细，别只按表面改。

---

## 7. 不能做的事

1. 不要把上下文窗口调大当解法（100MB 是 20–60 倍 1M，不是 1.2 倍）。
2. 不要把整个 docx/pdf 读成 base64 塞进渲染进程（当前 `knowledge` 的旧路径）。
3. 不要把整篇文档 `print` 到 bash 工具输出（一次几十万 token）。
4. 不要为“文档任务”弱化代码验证门；只放宽文档-only 的“必须跑测试/构建”提示。
5. 不要整树 `git add -A`；不要提交 `.codem/`、`dist/`、`art/`、`prototype/`。
6. 不要索引用户没明确给出的整个磁盘/主目录；路径必须在项目/沙箱允许根内。
7. 不要把“提取失败/扫描件无文本”标成 ready 或“没有相关内容”。
8. 不要在没有 P0 验收前先做向量/OCR/全书 map-reduce；先让基本索引和引用闭环。

---

## 8. 需要用户拍板的问题

新会话应在写 ADR 前问清（可先按推荐默认实现，再让用户改）：

1. **作用域**：文档默认属于当前项目；无项目时 session-scoped。是否要“全局资料库”？
2. **路径索引触发**：用户消息里出现路径就自动索引，还是必须 `/index` 明确确认？推荐“存在且是文档扩展名就自动登记，UI 可撤销”。
3. **单文件上限**：100MB/200MB/500MB？超过上限是拒绝还是只索引元数据？
4. **OCR/vision**：本地 OCR、云 OCR、还是只标 needs_ocr？推荐 P0 先标状态，P1 接本地 OCR。
5. **是否复制原文件**：附件/粘贴复制到受管 blobs；路径型文档只登记路径，不复制。是否接受路径型文件移动后 stale？
6. **删除策略**：删除 source 时删 chunks + blob？保留审计？
7. **向量检索**：P0 只 FTS5，P1 再 embedding；是否接受？

---

## 9. 交接质量自检

新会话答得出这 8 条，才算读懂：

1. 当前 `read` / `read_attachment` / 压缩的硬限制分别是什么？
2. 为什么 100MB 文档不可能靠“更大窗口”解决？
3. 附件上传现在为什么不能索引 docx？缺什么？
4. 对话路径和粘贴图片分别从哪个函数接入？
5. 为什么 `knowledge` 的 notebook RAG 不能直接当项目文档索引？
6. 文档 chunk 必须带哪些 citation 字段？
7. 文档-only 与代码任务的验证门边界是什么？
8. P0 的第一批判据是哪几条？

答不出就回读本文件与 `20`/`00`/`09`，不要开始改代码。
