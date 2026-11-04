# 文档索引基准（DOCI-B1）

> 目的：用**真实管线**回答「1GB 文档能不能索引、要多久、索引多大」，而不是估算。
> 环境：Windows / NTFS / 本机 SSD；debug 构建（`cargo test --lib`，未开 `--release`）。
> 日期：2026-11-04。命令：

```powershell
$env:DOC_BENCH_MB="1024"
cargo test --manifest-path src-tauri/Cargo.toml --lib bench_large_document -- --ignored --nocapture
```

## 一、被测链路

`extract_text` 流式读 → `Pipeline` 分块（800 token 目标 / 12% 重叠）→ SQLite 写
`document_chunks/blocks/pages` + FTS5（中文 bigram）→ 正文侧车落盘。
基准里**包含**：抽取、分块、FTS 写入、侧车写盘、最终状态回写；**不包含**：blob 上传与 UI 渲染。

## 二、结果（debug 构建）

| 输入 | 耗时 | 吞吐 | 分块数 | 索引库 | 正文侧车 | 峰值 RSS | 状态 |
|---|---|---|---|---|---|---|---|
| 4 MiB | 1.86s | 2.2 MiB/s | 1,602 | 17.3 MiB | 4.0 MiB | — | ready |
| 16 MiB | 7.88s | 2.0 MiB/s | 6,405 | 74.4 MiB | 16.0 MiB | 16.9 MiB | ready |
| 64 MiB | 35.8s | 1.8 MiB/s | 25,617 | 296.7 MiB | 64.0 MiB | 32.8 MiB | ready |
| **1024 MiB（1GiB）** | **609.17s（≈10.2 分钟）** | **1.7 MiB/s** | **409,880** | **4,710.8 MiB（≈4.6 GiB）** | **1,024.2 MiB** | **17.9 MiB** | **ready** |

> 说明：4/16/64MiB 行是「分块切分修复后」的读数；1GiB 行的 RSS 是进程峰值工作集
> （`GetProcessMemoryInfo.PeakWorkingSetSize`，含整个测试进程）。1GiB 的 RSS 反而低于 64MiB，
> 因为 64MiB 那次跑在同一进程的多次基准之后（峰值只增不减，属测量口径，不是回退）。
> 峰值 RSS 不随输入线性增长 ⇒ 1GB 文件不会整体进内存。

派生结论：

- **磁盘放大**：索引库 ≈ 输入 × 4.6；加上正文侧车，总占用 ≈ 输入 × 5.6。1GB 文档要预留 ~6GB。
- **吞吐**：1.5–2.2 MiB/s。11 分钟是**可接受但需要进度**的量级 ⇒ 摄取期每 700ms 发一次
  `document://progress`（bytes/percent），UI 状态条显示百分比。
- **内存**：峰值 RSS 实测 16.9–32.8 MiB（16–64MiB 输入），1GiB 输入 17.9 MiB（同进程多次基准的峰值口径）。
  实现上只在内存里保留当前分块（≤800 token）与一个 256KB 写缓冲，1GB 文件不会整体进内存。

## 三、这套基准抓到的两个真 bug（已修）

### 1. FTS 删除是整表扫描 ⇒ O(n²)

- 现象：4MiB 1.8s、16MiB **111s**（4 倍数据、60 倍耗时），64MiB 根本跑不完。
- 根因：`DELETE FROM documents_fts WHERE document_id=? AND chunk_no=?` 的
  `document_id` 是 **UNINDEXED** ⇒ 每写一块都整表扫一遍。
- 修复：给 FTS 行一个稳定 `rowid = FNV1a(document_id + chunk_no)`，按 rowid 删除；
  文档首块（`chunk_no == 0`）时做一次整文档清理兜底旧数据。
- 结果：4/16/64MiB 变为 1.8s / 7.3s / 31.5s，线性。

### 2. 分块目标被上游段落粒度击穿

- 现象：64MiB → 12,747 块，每块约 5.2KB（≈1,700 token），远超 800 token 目标。
- 根因：`extract_text` 按段调用 `push_text`（一段最多约 5,000 字符），`push_text`
  整段入缓冲后才判断阈值 ⇒ 一块 = 一整段。
- 修复：`push_text` 内按剩余 token 预算**切分**输入（UTF-8 安全），单块始终受目标约束。
- 结果：1GiB → 409,880 块 ≈ 每块 800 token，检索粒度与 `doc_read` 预算恢复设计值。

## 四、复现与边界

- 基准测试是 `#[ignore]`：默认 CI 不跑（要写 GB 级临时文件）。
- `DOC_BENCH_MB` 可调（默认 64）；1GiB 需要 ≥ 8GB 空闲磁盘。
- debug 构建吞吐不代表 release；release 预期更快（未测，不写数字）。
- 只测纯文本；docx/xlsx/pptx/PDF 的解析开销取决于文件结构与页数，未在本基准内。
