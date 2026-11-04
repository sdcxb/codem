# DOC-INDEX P0 判据（项目级文档索引）

> 配套设计：`docs/architecture/ADR-0008-PROJECT-DOCUMENT-INDEX.md`
> 基线：1.18.5 ｜ `tsc` 0 ｜ 880 文件 / 9551 用例 ｜ HEAD `26a283b5`
>
> 纪律：**判据先行 + 变异自证**。每条判据都必须能用「把实现改坏」证明它会变红；
> 只写用例不做变异 = 没测。文档任务只放宽「必须跑构建/测试」的提示，**不放宽**代码验证门。

---

## 0. 实施状态（2026-11-04）

| 编号 | 状态 | 落地位置 |
|---|---|---|
| DOCI-1 | ✅ 已实现 | `src/test/doc-index-store.test.ts` |
| DOCI-2 | ✅ 已实现（Rust） | `codem-db/src/docs.rs` 内 `docs::tests::*`（去重/级联/幂等，**抓到过 id 跨集合冲突**） |
| DOCI-3 | ✅ 已实现（Rust） | `documents/extract.rs` 测试（docx 标题/表格、损坏文件必须 failed） |
| DOCI-4 | ✅ 已实现 | `src/test/doc-entries.test.ts`（路径 5 类边界 + 上传/粘贴/消息入口） |
| DOCI-5 | ✅ 已实现（Rust） | `documents/chunk.rs` 测试（分块/偏移回读/幂等/取消） |
| DOCI-6 | ✅ 已实现 | `src/test/doc-search-contract.test.ts`（预算/未就绪/needs_ocr 不假结论） |
| DOCI-7 | ✅ 已实现 | `src/test/doc-read-redirect.test.ts` |
| DOCI-8 | ✅ 已实现 | `src/test/doc-ledger.test.ts` |
| DOCI-9 | ✅ 已实现 | `src/test/doc-status-labels.test.ts`（纯函数判据） |
| DOCI-10 | ✅ 已实现 | `src/test/doc-entries.test.ts`（4MB 分块/空文件）+ Rust 取消/检查点 |
| DOCI-11 | ✅ 已实现 | `codem-db/src/docs.rs::reset` 测试 + `documents_rebuild`（宿主线程重放） |
| DOCI-12 | ✅ 已实现（**真实 PDFium 验收 + 三类标题**） | `documents/pdf.rs::extracts_text_from_real_pdf_with_pdfium`、`bookmarks` 路径、`font_heading_level_is_conservative`（字号兜底）；真实 DLL 解析真 PDF |
| DOCI-13 | ✅ 已实现（分类函数 + 真 PDF 页分类） | `documents/pdf.rs::tests::page_classification_*` + 真实 PDF 两页分类（text/scanned） |
| DOCI-14 | ✅ 已实现（P1 首个能力：视觉转录） | `docs.rs::ocr_pages_are_written_and_document_becomes_ready`、`src/test/doc-ocr.test.ts`、`pdf.rs::renders_page_to_png_with_pdfium`（真实 DLL） |
| DOCI-15 | ✅ 已实现（按字节检查点续跑，PDF 页级） | `chunk.rs::pipeline_resumes_from_checkpoint_without_duplicating_chunks`、`docs.rs::resume_checkpoint_survives_same_sha_and_resets_on_new_sha`、`pdf.rs::resumes_pdf_from_page_two_without_reparsing_first` |
| DOCI-B1 | ✅ **已实测（1GiB）** | `documents/chunk.rs::bench_large_document_indexing`（`#[ignore]`，`DOC_BENCH_MB=1024`）；结果见 `DOC-INDEX-BENCH.md` |

> 变异自证：DOCI-2 的 id 冲突、DOCI-3 的 UTF-8 截断、DOCI-6 的预算越界，都是在实现期判据真的变红后才修好的
> （见 Rust 测试注释与 `chunk.rs`/`extract.rs` 的判据说明）。剩余变异记录表按 §4 在提交时补。


---

## 1. 判据总表

| 编号 | 判据 | 判据文件 | 变异（必须红） |
|---|---|---|---|
| DOCI-1 | 索引库落地：独立库建表/版本/持久化；**主库 schema 零变化** | `src/test/doc-index-store.test.ts` | 删表 / 删迁移 / 把表塞进主库 |
| DOCI-2 | 幂等与去重：同 blob 二次摄取不重复解析；路径内容变更全量替换；删除级联干净 | `src/test/doc-index-dedupe.test.ts` | 去掉 `UNIQUE(document_id, dedupe_key)` 或删源分支 |
| DOCI-3 | 提取诚实：docx/xlsx/pptx 有结构；损坏/不支持必须 `failed`/`unsupported`，绝不 `ready` | `src/test/doc-extract-honesty.test.ts` | 失败分支写 `ready` |
| DOCI-4 | 四入口：路径 / 上传分块 / 粘贴图片+文件 / 拖拽，全部落到同一个资源登记；路径解析的 7 个边界 | `src/test/doc-entries.test.ts` | 摘掉任一入口 / 去掉围栏剔除 |
| DOCI-5 | 结构感知分块：标题不跨块、页区间正确、表格带表头、重叠 10–15%、`chunk_no` 确定性 | `src/test/doc-chunking.test.ts` | 去掉标题边界约束 / 改 overlap 越界 |
| DOCI-6 | 检索契约：`doc_search` ≤6K token、字段齐全、中文命中、未就绪返回状态 | `src/test/doc-search-contract.test.ts` | 调高预算 / 删 citation 字段 / 未就绪回空 |
| DOCI-7 | `read` 对二进制文档结构化重定向，不吐二进制；`.md/.txt` 行为不变 | `src/test/doc-read-redirect.test.ts` | 去掉重定向 |
| DOCI-8 | Ledger 注入尾部（非 system 前缀）、≤2K token、压缩后重注 | `src/test/doc-ledger.test.ts` | 拼进 system / 超预算 |
| DOCI-9 | 状态 UI：5 态徽标 + 状态条；失败可见；`needs_ocr` 不得显示「已索引」 | `src/test/doc-status-ui.test.tsx` | `failed → ready` 映射 |
| DOCI-10 | 大文件有界：任何单次传输 ≤4MB；摄取时事件循环不被饿死；取消与检查点可恢复 | `src/test/doc-ingest-bounds.test.ts` | 整文件 base64 / 去掉检查点 |
| DOCI-11 | 重建：删 `index.db` 后从 blob 重建，chunk 集合与检索恢复 | `src/test/doc-index-rebuild.test.ts` | 重建跳过 FTS |
| DOCI-12 | PDF 文本页（PDFium）：页数/页文本/三类标题（书签 → 文本模式 → 字号兜底）；引擎缺失 → `needs_engine` | `src/test/doc-pdf-text.test.ts` | 无引擎仍标 `ready` |
| DOCI-13 | PDF 分类：文本页 / 图片页 / 混合页判定正确；图片页 → `needs_ocr` | `src/test/doc-pdf-classify.test.ts` | 全标 `text` |
| DOCI-14 | 视觉索引：`text_source=vision` + 页 `ocr_model` + heading `第N页（视觉转录）`；单页失败 `ocr_state=failed` 且可重试，文档保持 `needs_ocr` | `src/test/doc-ocr.test.ts` + `docs.rs::ocr_pages_are_written_and_document_becomes_ready` | 失败仍标 `ready` / 失败页不再列出 |
| DOCI-15 | 续跑：abort 保留检查点；同 sha 重试从 `pages_done` 之后续写，块号唯一、偏移可回读；sha 变了必须清空旧块/检查点 | `chunk.rs::pipeline_resumes_from_checkpoint_without_duplicating_chunks` + `docs.rs::resume_checkpoint_survives_same_sha_and_resets_on_new_sha` | 从头重跑（块数翻倍）/ 新 sha 复用旧检查点 |
| DOCI-B1 | 基准（1GB）：提取耗时 / 峰值 RSS / 索引库大小实测入库 | `documents/chunk.rs::bench_large_document_indexing` + `docs/architecture/DOC-INDEX-BENCH.md` | 不适用（基准先于调参） |

---

## 2. 每条判据的断言细节

### DOCI-1 索引库落地
- 临时数据根上 `documents.open` → `PRAGMA user_version = 1`；表 `documents/document_pages/document_blocks/document_chunks/document_ingest_state` 存在；`documents_fts`（FTS5）存在。
- 写一条 document + 200 chunk → 关库 → 重开：行数一致、`MATCH` 仍命中。
- **主库零变化**：`src-tauri/codem-db/sql/tables.json` 与 `schema.sql` 的 `git diff` 为空；主库 `CREATE TABLE` 计数不变。
- `documents.*` 在 `codem-db::COMMANDS` 白名单里，且 `check-command-parity` 通过。

### DOCI-2 幂等与去重
- 同 sha 二次 `ingest`：`documents` 行数不变、`chunk_no` 集合完全相同、结果 `deduped: true`、提取器调用计数为 0。
- 同路径内容变更（改写文件）：sha 变 → 旧 chunk 全删、新 chunk 写入、`extractor_version` 保留。
- 删除 document：`document_chunks` 0 行、`MATCH` 0 命中、`pages/` 目录清空；blob 被另一 collection 引用时**保留**，否则删除。
- 路径型文件被移走：`doc_status` 标 `stale`，`doc_search` 默认不返回它（`include_stale: true` 才返回）。

### DOCI-3 提取诚实
- `.docx` fixture（3 标题 + 1 表格）→ `status=ready`，`outline_json.headings` 含 3 条，`blocks` 里有 `kind=table`。
- `.xlsx`（2 sheet）→ `heading_path` 含 sheet 名。
- `.pptx`（3 页）→ `page_count=3`。
- 截断的 docx（前 200 字节）→ `status=failed` + `error` 非空 + `phase=extract`。
- `.zip`（不在支持表）→ `status=unsupported`（明确状态，不是 `ready`，也不是「无内容」）。

### DOCI-4 四入口
| 子项 | 断言 |
|---|---|
| 路径 | 绝对路径 / 裸相对 `docs/a.md` / 带空格 / 中文名 → 登记；不存在 / `.exe` / fenced code 内 → 不登记；>20 条截断 |
| 上传 | 3×4MB 分块 → blob 落盘、`sha256(disk) == sha256(bytes)`、`kind=attachment` |
| 粘贴图片 | `kind=paste`、页 `kind=scanned`、`status=needs_ocr`、原图在 blobs |
| 粘贴文件 | 同上传（`kind=paste`） |
| 拖拽 | `kind=drop`，有字节（不是 `content: ""`） |

### DOCI-5 分块
- 6 个标题的 fixture：任一 chunk 的 `heading_path` 只对应一个标题段（标题不跨块）。
- chunk 的 `page_from/page_to` 与 fixture 页号一致；跨页块允许，但必须记两页。
- 表格 >1.5× 块长时按行切，每块首行 == 表头。
- 重叠字符数 / 块长 ∈ [10%, 15%]。
- 同 sha 重复摄取 → `chunk_no` 集合逐字相同（确定性）。

### DOCI-6 检索契约
- 构造 8 个 chunk、每块 800 字符 → `doc_search` 返回 8 条时总 token ≤6,000（用 `estimateDocTokens` 断言），且 `truncated=true`。
- 每条含 `documentId/chunkId/file/pageFrom/pageTo/headingPath/snippet/score/tokenCount`。
- 中文查询「迁移」命中含「数据迁移」的块；英文 `migration` 命中英文块（两侧分词一致）。
- 索引未完成 → 返回 `{status:"indexing", percent}`；`needs_ocr` → `{status:"needs_ocr"}`；**不得**返回空数组冒充「没有相关内容」。

### DOCI-7 `read` 重定向
- `read("x.pdf")` / `read("x.docx")`：输出含 `doc_outline` 提示 + `collection_id`，**不含**替换字符/二进制片段；`isError=false` 且 `metadata.redirect="document"`。
- `read("x.md")` 与现状逐字一致（回归）。

### DOCI-8 Ledger
- 一轮里先 `doc_search` 再构造下一次请求：`trailingTurnContext` 含 ledger 段，`estimateDocTokens(ledger) ≤ 2000`。
- `system` 消息内容不包含 ledger（前缀缓存判据：同一会话两轮 system 字节相同）。
- 触发压缩后，下一轮 ledger 仍在（重新注入）。

### DOCI-9 状态 UI
- 徽标 5 态：`索引中 / 已索引 / 需 OCR / 需引擎 / 失败`。
- `failed` 有原因气泡；`needs_ocr` 文案**不得**出现「已索引」。
- 索引完成事件到达后 1s 内徽标变化（无刷新）。

### DOCI-10 有界与可恢复
- 传输层 spy：所有 `documents.blobChunk` 调用的 payload ≤4MB；**不存在**一次整文件 base64。
- 摄取 64MB 文本时，定时器 100ms 拍点连续 20 拍不超时（事件循环未被饿死）。
- 取消：`documents.cancel` 后 2s 内进入 `pending`，已写 chunk 保留、可续。
- 检查点：注入异常中断后重开 → 续跑，`chunk_no` 无重复、无空洞。

### DOCI-11 重建
- 删 `index.db`（保留 blobs/text）→ `documents.rebuild` → `documents` 行与 `chunk_count` 恢复，`MATCH` 命中恢复；重建期间 UI 显示进度。

### DOCI-12 / DOCI-13 PDF
- 文本型 PDF（2 页文字 + 书签）→ `page_count=2`、每页文本非空、`headings` 来自书签。
- 伪装失败：把 pdfium 路径指向不存在目录 → 该 PDF `needs_engine`，`doc_search` 返回该状态。
- 分类 fixture（1 文本页 + 1 纯图片页 + 1 图文页）→ `pages.kind = text / scanned / mixed`。
- 图片页在 P0：`needs_ocr`；在 P1：视觉转录后 `ready` 且页 `text_source=vision`。

### DOCI-B1 基准
- 样本：1GB `.txt`、1GB `.docx`（多图）、1GB `.pdf`（文本型 1 万页）各一份（生成器脚本产出，不入库）。
- 记录：提取耗时、峰值 RSS、`index.db` 大小、`text/` 大小、`doc_search` p50/p95、100 并发查询稳定性。
- 首次实测后把数字写进 `DOC-INDEX-BENCH.md`，并据此调整 §13 的默认档位；**没有实测数字不算 P0 完成**。

---

## 3. 验收命令（每片结束都要跑）

```powershell
npx tsc --noEmit
npx vitest run src/test/doc-*.test.ts          # 本片判据
cargo test --manifest-path src-tauri/codem-db/Cargo.toml   # 索引库命令
cargo test --lib --manifest-path src-tauri/Cargo.toml      # 基线 241 passed / 2 ignored
npm run audit:schema-parity        # 主库 schema 不许动
npm run audit:command-parity       # 新命令双向对齐
npm run audit:storage-boundary     # 渲染侧不许裸 SQL
npm run audit:unrouted-db
npm run audit:reachability
npm run audit:report-sites         # 新增上报点必须分诊
npm run audit:knip                 # 未使用导出不许增长
npm run audit:docs                 # 新文档无 BOM / 版本一致
# 改 UI 时：
node tools/ui-audit/css-contract.mjs --write
npx vitest run src/test/css-integrity.test.ts src/test/ui-consistency.test.ts
# 最后：
npx vitest run                     # 全量（基线 9551 / 0 失败）
```

---

## 4. 变异自证记录表（2026-11-04 实测）

脚本：本轮临时脚本（逐条改坏→跑判据→按原字节还原；结果已固化在本表，脚本不留在仓库）。
结果：**7/7 全部变红，无效 0 条**；还原后 `tsc` 0、6 个判据文件 42 用例全绿、`no-bom` 通过。

| 判据 | 改坏了什么（实现） | 结果 | 证据 |
|---|---|---|---|
| DOCI-6（预算） | `truncateToTokens` 恢复「先收字符再判越界」 | 🔴 1 失败 | `doc-search-contract`：doc_read 预算断言 `≤220` 失败 |
| DOCI-6（单命中） | `fitSearchHits` 的 `perHitMaxTokens` 900 → 9000 | 🔴 1 失败 | 单命中 ≤900 token 断言失败 |
| DOCI-6（不伪装） | `notReadyAnswer` 的未就绪分支短路（`if (false && …)`） | 🔴 1 失败 | 「索引中返回状态」断言失败（退化成空结果） |
| DOCI-7（重定向） | `BINARY_DOC_EXTENSIONS` 清空 | 🔴 8 失败 | 7 种扩展名 + 集合提示共 8 条失败 |
| DOCI-4（URL） | 去掉路径扫描前的 URL 剥离 | 🔴 1 失败 | `https://…/a.pdf` 被当成本地文件 |
| DOCI-10（分块） | `BLOB_CHUNK_BYTES` 4MB → 64MB | 🔴 1 失败 | 9.5MB 文件的分块数/单块上界断言失败 |
| DOCI-9（OCR 诚实） | `needs_ocr` 徽标改成「已索引/ok」 | 🔴 2 失败 | 「不得显示成已索引」+ tone 断言失败 |

**实现期自然失败（比刻意变异更强的证据，均已修）**：

| 现象 | 抓它的判据 | 根因 |
|---|---|---|
| `UNIQUE constraint failed: documents.id` | `docs::tests::upsert_is_idempotent_per_collection_and_key` | 主键哈希没带 `collection_id`，跨集合同毫秒撞 id |
| `T:�` / `T:�题`（一个汉字被劈成两半） | `extract::tests::xml_scanner_splits_tags_and_text` | 512KB 缓冲边界直接整段 `from_utf8_lossy` |
| 预算 2,007 > 2,000 | `doc-ledger` | ledger 截断没给后缀预留 token |
| `第 3 节`/`第一章` 不被识别为标题 | `pdf::tests::heading_heuristics_are_conservative` | 编号解析不允许空格、不认中文数字、句子误判 |
| 16MB 索引要 111 秒（应为线性） | `bench_large_document_indexing`（DOCI-B1） | FTS 按 UNINDEXED 列逐块删除 ⇒ O(n²) |
| 每块 ~5.2KB / ~1,700 token | `pipeline_chunks_structure_and_is_idempotent` | `push_text` 整段入缓冲击穿 800-token 目标 |

**Rust 侧脚本变异（2026-11-04 补跑，6/6 全红）**：

| 判据 | 改坏了什么 | 结果 |
|---|---|---|
| DOCI-1 | 跳过 `documents_fts` 建表（`execute_batch("")`） | 🔴 exit 101（检索不到块） |
| DOCI-5 | 块 `text_offset` +2 | 🔴 exit 101（偏移回读断言失败/越界） |
| DOCI-11 | `reset` 不再删 FTS 行 | 🔴 exit 101（`health.fts_rows` 断言失败） |
| DOCI-15 | 忽略检查点（`match None::<ResumePoint>`） | 🔴 exit 101（正文丢首段/块重复） |
| DOCI-15 | sha 变化不清旧数据（`if false && sha_changed`） | 🔴 exit 101（旧块仍在） |
| DOCI-12 | 字号标题恒返回 `Some(1)` | 🔴 exit 101（正文小字号行被误判标题） |

> 规则：**没做变异的判据不得声明完成**。变异只允许临时改、随改随还原；不允许提交改坏的实现。
> DOCI-1/5/11/15 的脚本变异已补齐；DOCI-2/3 由上面的「自然失败」证明。
> 峰值 RSS 已由 1GiB 基准实测（17.9MiB），不再声明为“未测”。

---

## 5. 与既有判据的边界

1. **不修改** `knowledge/*` 及其判据（`phase-b-f-regression`、`notebook-*`、`regression-knowledge-full`）。
2. `read` 重定向只对二进制文档扩展名生效；`.md/.txt/.csv/.json` 等文本行为逐字不变（DOCI-7 有回归断言）。
3. 不改 `planCompactionKeep` 的保留算法；只测「压缩后 ledger 重注」。
4. 文档-only 回合仍可免「必须跑构建/测试」提示；但**代码改动、判据文件、门禁一律不放宽**。
5. 允许新增判据文件；**不允许**删除/跳过既有判据来换绿。
