# ADR-0008：项目级文档索引与检索优先（Document Index & Retrieval-First）

- 状态：**提议（待用户确认 §19 的 5 个决策点）**
- 日期：2026-11-04
- 基线：1.18.5 ｜ `tsc` 0 ｜ 880 测试文件 / 9551 用例
- 取代：`22-DOCUMENT-INDEX-HANDOFF.md` 里「P0 先做渲染侧小步实现」的保守范围（该文件仍保留为任务交接与验收口径）
- 相关：`00-AGENT-HANDBOOK.md` §3（硬规则）、`06-DATA-STORAGE.md`（数据根/迁移）、`09-CURRENT-STATE.md` §6（结构债）

> 一句话：把「文档内容当聊天消息」改成「文档进项目级索引、模型按 citation 检索与定点阅读」。
> 目标不是更大的上下文窗口（100MB ≈ 2,000 次 `read`，1GB ≈ 20,000 次；1M 窗口是 20–60 倍差距）。

---

## 0. 实施状态（2026-11-04，P0 已落地）

**已实现**（判据见 `DOC-INDEX-P0-CRITERIA.md`）：

| 片 | 内容 | 落点 |
|---|---|---|
| P0a | 独立索引库 + 13 条 `documents.*` 命令 + FTS5 + 迁移/版本 | `src-tauri/codem-db/sql/documents.sql`、`src-tauri/codem-db/src/docs.rs`、`src-tauri/src/storage.rs`（`docs_engine` 分流） |
| P0b | 分块上传（4MB/块）、文本/docx/xlsx/pptx 提取、结构感知分块、摄取线程、进度/取消 | `src-tauri/src/documents/{mod,blob→mod,extract,chunk}.rs` |
| P0c | `doc_outline/doc_search/doc_read/doc_status`、`read` 重定向、ledger、状态 UI、四入口 | `src/core/llm/tools/document-tools.ts`、`src/core/document/*`、`src/components/{InputArea,FileUpload}.tsx` |
| P0d | PDFium 动态加载 + 页分类（text/mixed/scanned）+ 标题启发式 | `src-tauri/src/documents/pdf.rs` |

**与提案的差异（如实记录，均为「更稳」而非「更省」）**：

1. **中文切分沿用既有 bigram+unigram**（`codem-db::fts::tokenize`），**没有**引入 jieba：
   理由是与会话搜索同一套切分（行为一致、零新依赖），且子串召回更强；
   代价是索引体积更大 —— 由 DOCI-B1 实测后决定是否在 P1 换成分词。
2. **不写 `.blocks.jsonl`**：结构块直接进索引库（`document_blocks`），正文侧车只有 `text/<sha>.txt`。
   少一份可漂移的副本。
3. **恢复 = 检查点续跑（PDF 页级；其它格式幂等重跑）**：`document_ingest_state` 记录
   `bytes_done/pages_done/chunks_done`，`.part` 在 abort 时保留；下一次同 sha 摄取把 `.part`
   截断到检查点字节数，从 `pages_done` 之后继续解析、从 `next_chunk_no` 继续写块。
   **sha 变了**（同路径换内容）会清空旧块/页/检查点，避免用旧检查点套新文件。
4. **PDF 标题**：文本启发式（`第X章/Chapter N/1.2 标题`）+ **PDF 书签（outline）优先**（已接入）；
   按字号推断标题仍未做（pdfium-render 的 text-run 字号 API 未接）。
5. **视觉转录（Q6 图片页）已实现（P1 首个能力）**：扫描页/图片页由渲染侧调用视觉模型转写，
   Rust 负责渲染与索引（`documents_render_page` / `documents_ocr_write`），见下。

**已完成（2026-11-04 追加）**：

- **DOCI-B1 已实测**：1GiB 文本 609s / 1.7MiB/s / 409,880 块 / 索引 4,710MiB /
  **峰值 RSS 17.9MiB**（debug 构建；详见 [DOC-INDEX-BENCH.md](./DOC-INDEX-BENCH.md)）。
  基准抓到并修掉两个真 bug：FTS 按 UNINDEXED 列逐块删除导致 O(n²)、
  `push_text` 整段入缓冲击穿 800-token 目标。
- **PDFium 真机验收**：`tools/vendor/fetch-pdfium.mjs` 按固定版本 + sha256 拉取（不进仓库），
  Tauri 启动时把 `resource_dir()/pdfium/win32-x64` 写进 `CODEM_PDFIUM_DIR`；
  `#[ignore]` 用例 `extracts_text_from_real_pdf_with_pdfium` 已用真实 DLL 跑通
  （并抓到「绑定只能一次 ⇒ probe 后再提取全降级 needs_engine」的 bug，已改为进程级单次绑定）。
- **视觉转录（Q6）**：摄取完成且状态为 `needs_ocr` 时自动逐页转录：
  `documents_ocr_pending`（待转录页）→ `documents_render_page`（PDFium 渲染 PNG / 图片原图）
  → 视觉模型（主模型原生视觉优先，否则视觉代理）→ `documents_ocr_write`
  （追加正文侧车 + 建块/分块/FTS + 页 `ocr_state=done`）→ `documents_ocr_finish`（转 `ready`）。
  图片文档同样走这条路（页号 1）。判据：`src/test/doc-ocr.test.ts`、
  `docs.rs::ocr_pages_are_written_and_document_becomes_ready`、
  `pdf.rs::renders_page_to_png_with_pdfium`（真实 DLL）。
- **PDF 书签标题**：`doc.bookmarks()` 的标题/层级/目标页优先于文本启发式，生成标题块并作为
  后续正文的 heading 路径；无书签的 PDF 行为不变。
- **续跑（按字节检查点，PDF 页级）**：取消/崩溃后同 sha 重试不再从零开始：
  `.part` 保留并截断到检查点、PDF 从 `pages_done` 之后继续、块号/偏移续写。
  判据：`chunk.rs::pipeline_resumes_from_checkpoint_without_duplicating_chunks`、
  `docs.rs::resume_checkpoint_survives_same_sha_and_resets_on_new_sha`、
  `pdf.rs::resumes_pdf_from_page_two_without_reparsing_first`（真实 DLL）。
- **长文件进度**：摄取期每 700ms 发 `document://progress`（bytes/percent），
  状态条显示百分比；否则 11 分钟的索引期 UI 看起来像卡死。

**未完成（诚实清单）**：按字号推断 PDF 标题（pdfium-render 只暴露底层
`FPDFText_GetFontSize`，没有安全的高层 API；书签已覆盖有 outline 的 PDF）、
向量检索、跨文档问答。P1 前需要用户确认。


---

## 1. 问题（当前事实，代码级）

| 环节 | 现状 | 位置 |
|---|---|---|
| `read` | 单次 ≤50,000 字符 / 默认 2,000 行；`maxResultSizeChars: Infinity`（从不落 spill） | `src/core/llm/tools.ts:1423/1417/1397` |
| `read_attachment` | 默认 8,000 / 上限 50,000 **字符**，按字符 offset，无页/章节 | `src/core/llm/tools/read-attachment.ts:24/167` |
| Office/PDF 提取 | `read_file(encoding:'base64')` **整文件**进渲染进程 → `atob` → mammoth/JSZip / 自研 PDF 扫描 | `src/core/knowledge/extractor.ts:286-300`、`:252-267` |
| 上传入口 | docx/pdf **只留 name/size/mime**：无 `content`、无 `path`、无 `documentId` | `src/components/FileUpload.tsx:21-51` |
| 附件同步 | 无内容直接返回 ⇒ docx 连 `.attachments/` 都不进 | `src/core/llm/attachment-sync.ts:36-44` |
| 提示词死路 | 无内联内容时仍叫模型 `Call read_attachment(...)`，而该工具必回 `has no readable content` | `src/core/llm/attachment-formatter.ts:129-135`、`tools/read-attachment.ts:300-306` |
| 路径入口 | `extractFilePathsFromText` 只用于**工具输出**的可点链接；只匹配盘符/`./` 路径，裸相对路径与 fenced code 不区分 | `src/core/llm/tools.ts:375-404`、`:1217` |
| 粘贴 | 只处理 `image/*`；clipboard 里的文件被静默丢弃 | `src/components/InputArea.tsx:1143-1164` |
| OS 拖拽 | 外部文件生成 `content: ""` 的空壳附件 | `src/components/InputArea.tsx:1353-1362` |
| 压缩 | 70% 触发、保留 40% 窗口、近端 3 轮 ≤60 条；保留集里是**整段文档结果** | `src/core/llm/compaction-budget.ts` |

**结论**：这不是参数问题，是「文档没有原文句柄 + 没有结构 + 没有检索」的结构错配。

---

## 2. 决策摘要（10 条）

1. **作用域**：文档属于**项目**（`collection_id = projectId`）；无项目时 `session:<sessionId>`；不做全局库（接口预留）。
2. **索引库独立**：文档索引放在**独立 SQLite 库** `<dataRoot>/documents/index.db`，不进会话主库。理由：1GB 级索引会让主库的 VACUUM/checkpoint/损坏恢复/备份全部变慢；且**索引是可重建缓存**（blob 才是权威），与「JSONL 权威 / SQLite 可重建」的既有原则一致。
3. **重活在 Rust**：提取、分块、FTS 写入、页面渲染都在 Rust 后台线程完成；渲染进程只负责**入队 / 看进度 / 检索**。1GB 文件不可能靠 IPC 搬字节。
4. **文本侧车**：原文件进 `<dataRoot>/documents/blobs/<sha256>`；规范化文本进 `<dataRoot>/documents/text/<sha256>.txt` + `.blocks.jsonl`；chunk 行只存 **offset + preview**，正文按需 seek。
5. **检索 = BM25（FTS5）+ 中文分词（jieba-rs）**：不做 bigram 双份膨胀；查询侧同一套分词；向量检索留 P2（不在 P0 承诺）。
6. **PDF 统一用 PDFium**：文本、字号/位置（标题推断）、书签、页面渲染**一个引擎全部覆盖**；动态加载，缺失时显式降级，不假装成功。
7. **PDF 分类索引**：按页判定 `text / mixed / scanned`；文字页走文本索引；图片页用**视觉模型识图结果**作为该页正文（带 provenance），并保留页图供 `doc_read` 让模型看原图。
8. **无硬上限、分四档**：≤64MB 立即索引；64MB–1GB 后台全量索引；>1GB 先建大纲/摘要（Tier-1），再按需分段深索引（Tier-2）；只有超过可配置的安全上限（默认 8GB）才拒绝。
9. **工具契约固定**：`doc_outline / doc_search(≤6K) / doc_read(≤4K) / doc_status`；每条结果带 `documentId + page/heading + chunkId`；索引未就绪返回**状态**而不是「没有相关内容」。
10. **门禁不放松**：文档任务只放宽「必须跑构建/测试」的提示，不放宽代码验证门、完成门、既有判据。

---

## 3. 作用域与集合

| 场景 | `collection_id` | 跨会话复用 |
|---|---|---|
| 有项目 | `projectId` | 是（同项目所有会话） |
| 全局对话（无项目） | `session:<sessionId>` | 否（预留提升接口） |

- 同一物理文件被多个 collection 引用时：**blob/text 按 sha 只存一份**；document 行按 collection 各一份（去重键 `dedupe_key`），解析结果共享。
- P0 不做「全局资料库」；`documentId` 与 `collection_id` 分离，未来提升只需改归属，不动 blob。

---

## 4. 架构分层

```
入口层（渲染侧）
  ├─ 附件上传（原生文件对话框优先 → 真实路径；浏览器 input 兜底 → 分块 IPC）
  ├─ 粘贴（图片 / clipboard 文件）
  ├─ OS 拖拽（见 §13.4 的 dragDropEnabled 取舍）
  └─ 用户消息里的本地路径（存在性 + 允许根 + 扩展名 + fenced code 剔除）
        │  documents.ingest({collectionId, kind, path|blobChunks, name})
        ▼
Rust 摄取引擎（src-tauri/src/documents/，独立 worker 线程）
  ├─ 阶段机：登记 → 校验 → 提取 → 规范化 → 分块 → 索引 → 完成
  ├─ 流式：分块读、逐页处理、检查点、可取消、可崩溃恢复
  ├─ 提取器：text / docx / xlsx / pptx / pdf(PDFium) / image / 其他
  ├─ 分块：结构感知（heading/page/paragraph/table），offset 化
  └─ 写入：documents/index.db（WAL，单写者）+ 文本侧车
        │  事件：document://progress（阶段/页/块/百分比/ETA/可取消）
        ▼
索引库 documents/index.db（可重建）
        ▼
工具层（渲染侧）
  doc_outline / doc_search / doc_read / doc_status
        ▼
上下文
  DocumentLedger（尾部注入，≤2K token）+ 压缩后重新注入
```

**为什么提取必须在 Rust**：1GB 文件的 base64 光是字符串就 >1.3GB；渲染进程做等于自爆。当前 `knowledge/extractor.ts` 的 base64 路径**不改造、不复用**（它服务笔记本 RAG，有 2000 行镜像上限）。

---

## 5. 存储设计

### 5.1 数据根

```
<dataRoot>/documents/
  index.db                 # 独立 SQLite（WAL）
  blobs/<sha256>           # 上传/粘贴的原文件（只存一份）
  text/<sha256>.txt        # 规范化正文（页/段分隔）
  text/<sha256>.blocks.jsonl # 块表：kind/page/heading_path/text_offset/text_len
  pages/<sha256>/<n>.png   # 需要视觉索引或 doc_read 展示时的页图（可重建，可 LRU 清）
```

- 路径型文档（用户在对话里给路径）：**不复制**，只登记 `path + mtime + size + sha256`；移动/删除 → `stale`，检索默认排除。
- `pages/` 是缓存：可随时删除，删除后 `doc_read` 降级为「只有转录文本」。

### 5.2 `documents/index.db`（`PRAGMA user_version` 版本化，可整体重建）

```sql
documents(
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- attachment | paste | path | drop
  source_ref TEXT,                 -- 附件 id / 规范化路径 / blob sha
  dedupe_key TEXT NOT NULL,        -- blob:<sha256> | path:<归一化路径>
  name TEXT, mime TEXT, size INTEGER, sha256 TEXT, mtime INTEGER,
  page_count INTEGER, block_count INTEGER, chunk_count INTEGER, text_bytes INTEGER,
  status TEXT NOT NULL,            -- pending | extracting | indexing | ready | failed
                                   -- needs_ocr | needs_password | needs_engine | stale | too_large
  error TEXT, outline_json TEXT, extractor_version INTEGER, metadata_json TEXT,
  created_at INTEGER, updated_at INTEGER,
  UNIQUE(collection_id, dedupe_key)
)
document_pages(document_id, page_no, kind,       -- text | scanned | mixed | blank
  text_source,                                    -- layout | vision | none
  text_bytes, ocr_state, ocr_model, image_path, updated_at,
  PRIMARY KEY(document_id, page_no))
document_blocks(document_id, block_no, page_no, kind, heading_path,
  text_offset INTEGER, text_len INTEGER,
  PRIMARY KEY(document_id, block_no))
document_chunks(document_id, chunk_no, page_from, page_to, heading_path,
  text_offset INTEGER, text_len INTEGER, token_count INTEGER, preview TEXT,
  PRIMARY KEY(document_id, chunk_no))
documents_fts(tokenized_text, document_id UNINDEXED, chunk_no UNINDEXED)  -- FTS5
document_ingest_state(document_id PRIMARY KEY, phase, bytes_done, pages_done, chunks_done, updated_at)
```

- **chunk 不存全文**（1GB 文档存两遍等于自找磁盘与 VACUUM 灾难）；`preview` 只放 ≤200 字符供 UI/outline。
- FTS5 只存**分词后的 token**（jieba），外部不复制原文。
- 检索：`MATCH` → 取 `chunk_no` + `bm25()` → 按 offset 从侧车切片拼 snippet（±80 字符窗口）。
- 删除：`documents.delete` 事务内删 chunks/fts/pages/state；blob 在「无其他 document 引用同一 sha」时删；写一条审计事件。

### 5.3 重建与损坏

- blob/侧车是权威，索引可重建：`documents.rebuild` 按 sha 重新提取分块（版本升级也走这条）。
- `index.db` 损坏：改名备份 → 建新库 → 标记全量重建（后台，进度可见）。**绝不**碰会话主库。

### 5.4 为什么不复用会话主库

| 维度 | 主库（codem-db） | 独立索引库 |
|---|---|---|
| 数据规模 | 会话/事件（MB–GB，可归档） | 文档索引（GB–100GB 级） |
| 权威性 | JSONL 权威 | blob 权威 |
| 恢复代价 | 从 JSONL 重建 | 从 blob 重建（可慢，可后台） |
| 门禁面 | schema.sql/tables.json/命令白名单/存储边界 | 独立迁移，不发散主库 |
| VACUUM/备份 | 用户数据，频繁 | 缓存，可丢 |

---

## 6. 摄取管线（流式、可恢复）

```
enqueue → verify（存在/可读/扩展名/根内/大小/安全上限）
        → extract（按格式；逐页/逐段推进）
        → normalize（写 text/*.txt + blocks.jsonl，边写边算 sha256）
        → chunk（结构感知，见 §7）
        → index（FTS 批量写，2000 chunk/事务）
        → done（写 outline/summary/统计，发事件）
```

- **检查点**：`document_ingest_state` 每 2s 或每 200 块落一次；崩溃/重启后从 `phase + 计数` 继续（提取阶段按页续、索引阶段按 chunk_no 续）。
- **取消**：协作式取消标志（每页/每 50 块检查一次）；取消后保留已写入的页与块，状态回 `pending`，不丢已完成工作。
- **并发**：两个队列 —— `fast`（≤16MB，并发 2）与 `heavy`（>16MB，串行 1）。重活不抢首屏：启动后 30s 内只跑 fast（与既有「维护让路」一致）。
- **进度事件**：`document://progress`（`documentId, phase, pagesDone/pagesTotal, chunksDone, percent, etaMs, cancelable`），节流 5 次/秒。
- **失败语义**：`failed` 带 `error` 与 `phase`；**绝不**把失败写成 `ready`，也绝不返回「没有相关内容」。

---

## 7. 分块与检索

### 7.1 分块（Q5）

- 目标 **500–1000 token/块**，重叠 **10–15%**（中文按字符近似：1 token ≈ 1 汉字）。
- 结构优先：**标题边界不跨越**；页边界尽量不跨越（跨页块记 `page_from/page_to`）；表格整体保留（>1.5× 块长时按行切并在每块重复表头）。
- 每块记：`page_from/page_to`、`heading_path`（如 `3.2 迁移`）、`ordinal`、`text_offset/len`、`token_count`、`content_hash`。
- `chunk_no` 确定性生成（`sha256(document_sha + block_range + chunk_ordinal)`）⇒ 重跑幂等。
- 1GB 文本量级：约 **30 万–60 万块**（按 800 token/块估算）。写入按 2,000 块/事务；**不经过 IPC**。

### 7.2 检索（P0：BM25）

- 中文：**jieba-rs**（MIT，默认词典约 4.8MB）在入库与查询两侧做同一套分词；英文/数字原样。
- 排序：`bm25()` + 同文档内相邻块轻微加权（可选）；`topK` 默认 8，上限 32。
- 结果预算：整次 `doc_search` 渲染文本 ≤6,000 token（超了按分数降序截断，并标 `truncated`）。
- snippet：从侧车按 offset 取块正文，命中词附近 ±80 字符窗口；不改写原文。

### 7.3 向量检索（不在 P0）

- 明确留到 P2：1GB 文档全量 embedding 的成本与收益必须先有实测，再决定「只嵌入标题/摘要」还是「分块嵌入」。
- 索引库已预留 `document_chunks` 结构，加向量列或旁表不需要改工具契约。

---

## 8. PDF 专项（Q4、Q6）

### 8.1 候选引擎对比（含淘汰理由）

| 方案 | 许可 | 文本质量（CJK/子集字体） | 版式信息 | 页面渲染 | 1GB 能力 | 结论 |
|---|---|---|---|---|---|---|
| **PDFium（pdfium-render）** | BSD-3 | 强（Chrome 同源） | 字符级：字号、位置、Unicode 映射错误标记 | 内建（位图/JPEG） | 强（按页随机访问） | **采用** |
| pdf.js（pdfjs-dist） | Apache-2.0 | 较好 | 算子表可推字号 | 需 canvas（WebView 内） | 中（内存/渲染在 WebView） | 备选（无 PDFium 时的降级） |
| MuPDF | **AGPL** | 很强 | 强 | 强 | 强 | **淘汰**（传染性许可） |
| Poppler / pdftotext | **GPL** | 强 | 中 | 无 | 需外挂二进制 | **淘汰**（分发与部署风险） |
| 纯 Rust（lopdf + 自研） | MIT | 弱（CJK/CMap 易错） | 弱 | 无 | 中 | 仅作最后兜底 |
| 商业 SDK | 商业 | 很强 | 很强 | 强 | 强 | 不需要 |
| PDF→DOCX 转换（LibreOffice 等） | MPL/LGPL + 体积 | PDF 导入走 Draw，段落/表格还原不可靠 | 差 | 无 | 差 | **淘汰作为索引路径** |

### 8.2 决策：PDFium（动态库，缺库即降级）

- 依赖：`pdfium-render = "0.9"`（动态绑定；不需要 V8/JS 版本），**随包分发** `pdfium.dll`（Windows x64；预编译包 `pdfium-win-x64.tgz` 约 3.7MB，解包后单 DLL 量级待实测）。
- 放置：`src-tauri/resources/pdfium/<platform>/`，Tauri `bundle.resources` 打包；运行时用 `resource_dir()` 解析，加载失败 → `Pdfium::bind_to_system_library()` 兜底。
- **降级诚实**：库缺失或加载失败 → 该 PDF 记 `status = needs_engine`（UI 明确提示「PDF 引擎未就绪」），不返回空文本、不标 `ready`。
- 线程：启用 `thread_safe`（内部互斥）；摄取只在一个 worker 线程用 PDFium，避免并行踩库。
- 许可合规：随包附 PDFium 的 `LICENSE` 与第三方声明；`docs/THIRD-PARTY-NOTICES` 增补。

### 8.3 提取内容

1. **逐页文本**：字符级（含字号、坐标）→ 行分组 → 段落块；页号稳定。
2. **标题推断**：全文正文字号中位数 M；块字号 ≥1.15M 且（短行 + 编号/加粗）→ 候选标题；结合**书签树**（PDF 自带 TOC 优先）。
3. **阅读顺序**：按坐标聚类（先列后行）修正双栏；PDFium 已给较合理的字符序，双栏页面做一次启发式合并。
4. **质量判定**：`unicode_map_error` 比例、控制字符比例、文本长度/页面积比 → 决定该页 `text / mixed / scanned`（阈值可调，判据锁定）。
5. **密码/加密**：P0 记 `needs_password`（UI 提示输入密码是 P1）。

### 8.4 关于「PDF 转成 Word 来精准索引」（Q6 前半）

- **不采用** PDF→DOCX 往返：LibreOffice 导入 PDF 走 Draw 模型，段落/标题/表格还原不可靠，等于用一次有损转换换一个「看起来像 Word」的文件。
- 采用**结构化 IR**（`document_blocks`）：页 → 块（标题/段落/列表/表格/图注）→ 标题层级。这正是 Word 能提供的结构，但由我们自己从 PDFium 的字符数据推断，**可测、可回归、无中间格式损耗**。
- 若用户需要「导出成 Word 交付」，那是**另一个需求**（P2 可选导出器），不影响索引路径。

### 8.5 图片页的视觉索引（Q6 后半）

```
页面分类为 scanned / mixed
  → PDFium 渲染该页（长边 ≤1600px，JPEG/PNG，目标 ≤1.5MB）
  → 视觉模型（用户当前 provider 的 vision 能力）
  → 返回页面转录/描述（要求：逐字转录 + 表格用 Markdown + 图注说明）
  → 写入 document_pages.text（text_source = vision, ocr_model 记录）
  → 进入分块与 FTS（与文本页同样的 citation 形态）
```

- **provenance 可见**：`doc_read` 结果标注「本页文本来自视觉转录（模型 X）」，模型与用户都能分辨。
- **原始页图保留**：当主模型支持视觉时，`doc_read(page, mode:"image")` 可返回页图；否则返回转录文本。
- **成本与上限**：页数 × 单页 token 在开始前估算并展示（「预计 N 页，约 X 图，估算成本 Y」）；可设 `visionOcrMaxPages`（默认 500/文档）与全局每日预算；可取消、按页断点续跑；页图按 sha 缓存，重复页（封面/页眉）不重复调用。
- **不假装**：视觉调用失败该页记 `ocr_state = failed` + 原因，文档整体 `needs_ocr` 而不是 `ready`。

---

## 9. 格式支持矩阵

| 格式 | P0 能力 | 提取器 | 结构 |
|---|---|---|---|
| `.txt/.md/.markdown/.rst` | 全文索引 | Rust 流式（BufReader） | 标题（Markdown `#`）/段落 |
| `.csv/.tsv` | 全文 + 表头 | Rust 流式 | 每 N 行一块，块首重复表头 |
| `.json/.yaml/.xml` | 全文索引 | Rust 流式 | 顶层键/节点切块 |
| `.docx/.doc` | 全文 + 标题/表格 | Rust：zip 流式 + `word/document.xml`（`w:pStyle` 判标题、`w:tbl` 判表格） | 标题层级/段落/表格 |
| `.xlsx/.xls` | 按 sheet 索引 | Rust：zip + `sharedStrings` + `sheetN.xml` | sheet 名 → heading |
| `.pptx/.ppt` | 按页索引 | Rust：zip + `slides/slideN.xml` | 幻灯片号 → page |
| `.pdf` | 文本页 + 视觉页 | PDFium（§8） | 页/标题/表格/图注 |
| 图片（png/jpg/webp…） | 元数据 + 视觉转录 | Rust 元数据 + 视觉模型 | 单页 |
| 其他（zip/二进制） | 只登记元数据 | — | `status = unsupported`（明确状态） |

> `knowledge/extractor.ts` 与 `pdf-extractor.ts` **保持不动**：它们服务笔记本 RAG，现有判据（`phase-b-f-regression` 等）继续守住。

---

## 10. 工具契约

| 工具 | 参数 | 返回 | 硬约束 |
|---|---|---|---|
| `doc_outline` | `collection_id?`, `document_id?` | `[{documentId, name, pages, headings[], chunkCount, status, error?}]` | 只返回结构，不返回正文 |
| `doc_search` | `collection_id?`, `query`, `document_id?`, `topK=8`, `max_tokens=6000` | `[{documentId, chunkId, file, pageFrom, pageTo, headingPath, snippet, score, tokenCount}]` | 总预算 ≤6K；未就绪返回 `{status, indexing?}` |
| `doc_read` | `chunkId` 或 `documentId+page`, `max_tokens=4000`, `mode?: text\|image` | `{text, citation, provenance, hasMore}` | ≤4K；不返回整篇 |
| `doc_status` | `collection_id?` | `{files, ready, indexing, pending, failed, needsOcr, needsEngine, stale, totalChunks, bytes}` | 永远给出**可行动**状态 |

- `read` 对 `.docx/.doc/.xlsx/.xls/.pptx/.ppt/.pdf` 返回**结构化重定向**（含 `collection_id` 与「未索引时的下一步」），绝不返回二进制或「文件为空」。
- 工具可见性：本 collection 有 document 行（含 pending）时才注入 doc_* 工具；否则隐藏（沿用 `read_attachment` 的条件可见模式，省每轮固定 token）。
- `doc_*` 标记为 `readOnly: true, concurrencySafe: true`（与 `read/grep/glob` 同档）。

### 10.1 citation 规范

```
[file: 报告.docx | page: 12 | heading: 3.2 迁移 | chunk: d3f1…-0042]
```

- `documentId` 与 `chunkId` 必填；`page/heading` 有则填，无则省略（不编造）。
- 视觉转录页追加 `source: vision(<model>)`。

---

## 11. 上下文集成（DocumentLedger）

- 每次工具返回后更新会话级 ledger：文件清单（名称/页数/哈希前缀/状态）、已读 chunk、已确认事实 + citation、未读章节。
- 注入 `trailingTurnContext`（**不是 system 前缀**，保前缀缓存），预算 ≤2,000 token。
- 压缩：ledger 作为独立段保留；已关闭文档只留「文件 + 已用 citation」两行。
- P0 不改 `planCompactionKeep` 算法（只保证压缩后 ledger 重新注入）；算法改动留 P1 并单独出判据。

---

## 12. 三条入口（+ 拖拽）与字节通道

| 入口 | 接入点 | 字节通道 | 备注 |
|---|---|---|---|
| 附件上传 | `FileUpload.tsx` | **原生文件对话框**（`@tauri-apps/plugin-dialog`，已在 `NotebookManager` 使用）→ 真实路径 → Rust 直接流式读；浏览器兜底 `input` → 分块 base64（4MB/块）→ Rust 追加写 | 1GB 走对话框不搬字节 |
| 粘贴 | `InputArea.handlePaste` | 图片：单块 base64（小）；clipboard 文件：同上传 | 文本粘贴**不**当文档 |
| 消息内路径 | `App.handleSend`（发送前） | Rust 直接读路径 | 存在 + 扩展名 + 允许根 + fenced code 剔除 + 20 条上限；UI 可撤销 |
| OS 拖拽 | `InputArea.onDrop` | 同上传 | 见 §12.1 |

### 12.1 拖拽的真实路径问题

- 现状 `tauri.conf.json` 里 `app.windows[0].dragDropEnabled: false` ⇒ Tauri 不接管系统拖拽，HTML5 只拿到 `File`（无路径）。
- 若要「拖入 1GB 文件直接流式读」，需要打开 `dragDropEnabled` 并监听 Tauri 的 drag-drop 事件；代价是 HTML5 拖拽（文件树内部拖拽依赖 `application/x-file-path` 自定义类型）需要同步改造与回归。
- **P0 决策**：拖拽仍走「分块 IPC 写 blob」（有上限，建议 ≤256MB），**不**动 `dragDropEnabled`；大文件引导用户用「上传」按钮（对话框路径）。P1 再评估打开 Tauri 拖拽。

---

## 13. 上限、配额与策略（Q3）

### 13.1 无硬上限，分四档

| 档 | 条件（默认） | 行为 |
|---|---|---|
| A 立即 | ≤64MB | 入 fast 队列，全量索引（秒级），完成前 `doc_search` 返回 `indexing` |
| B 后台 | 64MB–1GB | 入 heavy 队列，全量索引，进度可见，可取消 |
| C 分级 | 1GB–8GB | **先**建大纲 + 每节摘要（Tier-1，分钟级）；全文索引需用户点「深度索引」或首次 `doc_search` 命中该文件时后台建（Tier-2） |
| D 拒绝 | >`documentMaxBytes`（默认 8GB） | 只登记元数据 + `status = too_large`，UI 给可操作建议（拆分/转文本） |

- 阈值与上限全部是**设置项**（`codem-document-index` 设置块），默认值可按实测调整；判据锁定的是「档位行为」而不是具体数字。
- 另设 `documentMaxPages`（默认 50,000）与 `documentMaxChars`（默认 20 亿字符，约 1GB 文本），超限降级为 Tier-1 + `too_large`。

### 13.2 磁盘预算

- `documentIndexQuotaBytes`（默认 20GB）：统计 `documents/` 总大小（index.db + blobs + text + pages）。
- 超 80% 提示；超 100% 停止自动索引（只保留 Tier-1），并给「清理页图缓存 / 删旧文档 / 调整配额」三个动作。
- `pages/` 优先 LRU 清理（可再生）。

### 13.3 时间/内存边界（设计约束）

| 资源 | 约束 |
|---|---|
| 单次内存峰值 | 提取缓冲 ≤8MB；PDFium 单页位图 ≤64MB（1600px 长边）；分块缓冲 ≤4MB |
| 单文件提取时间 | 无硬超时，但**分页/分段检查点**保证可中断；UI 显示 ETA |
| 索引写入 | 2,000 chunk/事务；SQLite `synchronous=NORMAL` |
| 渲染进程 | **零字节大文件搬运**（除浏览器兜底分块 4MB/块） |

> 以上「1GB 需要多久、索引多大」都属于**量级估算**；P0 必须有一条基准判据（DOCI-B1）在真实 1GB 样本上量出：提取耗时、峰值 RSS、索引库大小、检索 p50/p95。没有实测数字不算完成。

---

## 14. 隐私与安全

- 只索引：存在、可读、扩展名在支持表内、且位于**允许根**（当前项目根 / `<dataRoot>` / 用户显式选过的目录）的文件。
- 消息内路径自动索引**可撤销**（UI 一行「已加入索引」+ 撤销），并有全局开关 `documentAutoIndexFromMessage`（默认开）。
- 不索引：`node_modules`、`.git`、系统目录、浏览器缓存、`.env`（凭据类）。
- 文档正文作为**数据**注入（沿用现有 `formatAttachmentsInline` 的 data-isolation 头），防止文档内提示注入。
- 删除文档：删 chunks/fts/pages/text；blob 无引用时删；写审计事件；不写用户数据的双份副本。

---

## 15. 非目标（P0 明确不做）

1. 向量检索 / embedding（P2；先测成本与收益）。
2. 全书 map-reduce 摘要（P2）。
3. 全量 OCR（P0 只做 PDF 图片页的视觉转录；纯图片文档只索引元数据 + `needs_ocr`）。
4. PDF→DOCX 转换作为索引路径（§8.4）。
5. 全局资料库、跨项目共享（P3）。
6. 语料级 Q&A 的“自动读完全书再回答”（那是检索策略问题，用 ledger + 多轮检索解决）。
7. 复制路径型文件进受管目录（§5.1：路径型只登记）。

---

## 16. 分阶段计划（每阶段自带判据与验收）

| 阶段 | 内容 | 判据 |
|---|---|---|
| **P0a 索引库与命令面** | `documents/index.db` 迁移、4 条命令、blob/侧车、重建、`documents.*` IPC 契约 | DOCI-1、DOCI-2、DOCI-B1（基准骨架） |
| **P0b 摄取引擎与入口** | 六类提取器、分块、FTS、进度/取消/检查点、四入口、状态机 | DOCI-3、DOCI-4、DOCI-5、DOCI-9、DOCI-10 |
| **P0c 工具 / ledger / UI** | 4 工具、`read` 重定向、ledger、徽标与状态条 | DOCI-6、DOCI-7、DOCI-8、DOCI-11 |
| **P0d PDF 文本页** | PDFium 接入、页/标题/表格、`needs_engine` 降级、分类 | DOCI-12、DOCI-13 |
| **P1 视觉索引** | 图片页渲染 + 视觉转录 + 成本控制 + `doc_read` 图像模式 | DOCI-14（待 P0 验收后确认） |
| **P2 语义层** | 向量 / 摘要 / 跨文档问答 | 另行立 ADR |

> 用户确认的边界：OCR / 向量 / 全书 map-reduce 属下一阶段，**P0 验收通过后**再启动。

---

## 17. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| PDFium 打包/加载失败 | PDF 全部不可索引 | 动态加载 + `needs_engine` 显式降级 + 加载自检判据；pdf.js 作 P1 备选 |
| 1GB 文档阻塞磁盘 | UI/其他 IO 变慢 | heavy 队列串行 + 低优先级 + 分块写 + 进度可取消 |
| FTS 索引体积超预期 | 磁盘告警 | 配额 + Tier-1/Tier-2 分级 + 基准判据先量后调 |
| 视觉转录成本/延迟 | 用户意外等待 | 预估展示 + 页数上限 + 断点续跑 + 缓存 |
| 既有判据冲突 | 误判回归 | `knowledge/*` 不动；`read` 重定向只对二进制文档扩展名；先单跑相关判据 |
| 索引库损坏 | 检索不可用 | 可重建（blob 权威）+ 后台重建进度 |
| 主库/索引库双写不一致 | 状态错乱 | 索引库为唯一写者；主库只存「文档会话引用」（附件 id → documentId 的映射放在索引库） |

**回退**：`documentAutoIndexFromMessage` 关 + `documentIndexEnabled` 关 → 行为回到 1.18.5（附件仍是附件，工具不注入）；索引库可整体删除。

---

## 18. 与既有架构的边界

- **不改** `codem-db` 主库 schema、`tables.json`、主命令白名单（避免触发 schema parity / 主库存储债）。
- **不改** `knowledge/*`（笔记本 RAG 保持原状）。
- **不改** `planCompactionKeep`（P0 只做 ledger 注入与重注）。
- 新命令沿用 `storage_invoke` 通道（`documents.*` 进 `codem-db::COMMANDS` 白名单），这样 `check-command-parity` 继续有效。
- 新增 Rust 模块遵循既有惯例：同步 `_impl` 主体 + `#[cfg(test)]` 直接驱动（见 `read_file_lines_impl` 的判据写法）。

---

## 19. 待用户确认的 5 个决策点

| # | 决策 | 推荐 | 不选的后果 |
|---|---|---|---|
| D1 | PDF 引擎用 **PDFium**（随包 ~4MB 压缩 / 单平台 DLL） | 采用 | 只剩 pdf.js（渲染侧、1GB 吃力）或纯 Rust（CJK 差） |
| D2 | 文档索引放**独立库** `documents/index.db` | 采用 | 主库膨胀，VACUUM/备份/损坏恢复变慢 |
| D3 | 大文件走**原生文件对话框拿路径**（+ 拖拽维持分块 IPC 兜底） | 采用 | 1GB 上传要 256+ 次 IPC，慢且脆 |
| D4 | 视觉索引（图片页转录）排在 **P1**，P0 只做分类 + `needs_ocr` | 采用 | P0 周期显著变长，且成本模型未验 |
| D5 | 1GB–8GB 采用 **Tier-1 先可用 / Tier-2 按需深索引** | 采用 | 全部立即索引会阻塞磁盘与 UI 数十分钟 |

---

## 20. 判据索引

判据矩阵、变异自证与验收命令见 `docs/architecture/DOC-INDEX-P0-CRITERIA.md`（DOCI-1…DOCI-14）。
