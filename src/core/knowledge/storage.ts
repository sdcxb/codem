/**
 * 笔记本式知识管理 — SQLite CRUD 存储层
 *
 * 对标 NotebookLM：Notebook → Source → Chunk → Retrieval
 * 笔记 (Note) 功能借鉴 Lumina Note 的笔记 CRUD 设计
 * 知识图谱 CRUD 借鉴 Understand-Anything 的图谱数据管理思路
 *
 * 笔记本、来源、文本块的增删改查操作。
 * 向量以 Float32Array → Base64 BLOB 方式存储。
 */

import {
  domainDelete,
  domainDeleteWhere,
  domainEnsureLoaded,
  domainPort,
  domainPortRegistered,
  domainReadMany,
  domainReadOne,
  domainWrite,
  reportWriteNotAccepted,
} from "../storage/domain-store";
import { getStoragePort, hasStoragePort } from "../storage/port";
import { reportPersistFailure } from "../storage/persist-failure";
import type {
  Notebook,
  NotebookSource,
  NotebookChunk,
  CreateNotebookInput,
  AddSourceInput,
  SummaryStatus,
  SourceStatus,
  SourceType,
  Note,
  CreateNoteInput,
  NoteLink,
  NoteContentType,
  NotebookGroup,
  CreateGroupInput,
  NoteVersion,
  GraphNode,
  GraphEdge,
  GraphData,
  EntityType,
  RelationType,
} from './types';

// ========== 表名与镜像上限 ==========

const T_NOTEBOOKS = "notebooks";
const T_SOURCES = "notebook_sources";
const T_CHUNKS = "notebook_chunks";
const T_NOTES = "notes";
const T_LINKS = "note_links";
const T_NODES = "graph_nodes";
const T_EDGES = "graph_edges";
const T_GROUPS = "notebook_groups";
const T_VERSIONS = "note_versions";

/**
 * `notebook_chunks` 的镜像上限刻意调小。
 *
 * 每行带一个 Base64 编码的 embedding（1536 维 ≈ 8KB 文本），默认上限 5000 行
 * 意味着几十 MB 常驻渲染进程内存 —— 这正是 P6 要消灭的那类占用。
 * 超过 2000 行（约 16MB）就放弃镜像、回退旧路径，而不是把渲染进程压死。
 *
 * ## ⚠️ 任务 C-3：这里的"放弃"曾经是**进程内永久**的，而且是**静默**的
 *
 * 原实现只做了一件事：超过 2000 行 → `RustDomainMirror` 把整张表标成 `refused`，
 * 而 `getChunks()` / `getChunkCount()` 在"镜像没接手"时**返回空结果**（`[]` / `0`）。
 * 于是全库累计块数一旦越过 2000：
 *
 * - `search_notebook` 得到的是"没有相关内容"（**冒充"确实没有"**）；
 * - `getChunkCount` 恒为 0，而它又被 `refreshNotebookCounts` **持久写回**
 *   `notebooks.chunk_count` —— 计数被写坏，且重启后依然是 0（越修越坏）。
 *
 * 同仓 `self-heal.ts` 已明写"读不到绝不返回 0"，这里违反了同一条原则。
 *
 * 现在分三层处理（`rust-port.ts` 的按表封顶本身在别人的文件里，见报告"需要他人配合"）：
 * 1. **镜像就绪** → 照常走镜像（快路径，一个字节没变）；
 * 2. **镜像被拒（超上限）** → 改走**按 notebook 的按需读**（`crud.list` + `notebook_id`
 *    过滤），并做**有界缓存**（`chunkCache`）。这是"按 notebook 分片"在本文件里
 *    能做到的那一半：封顶仍是整表的，但**读路径不再返回空**；
 * 3. 两者都不可用 → `getChunks` 抛**可区分**的"索引未就绪"错误（C-3 要求 ②），
 *    绝不返回 `[]` 冒充"没有内容"。
 *
 * 按需读是**异步**的，而这里的读接口是同步的（调用方遍布同步上下文）——
 * 所以缓存未命中时触发一次后台预取、**本次如实抛"未就绪"**，下一次同步读命中缓存。
 * 这与 `message.ts` 的 `attachments.content`（附件正文按 id 取）是同一套既有做法。
 */
const CHUNK_MIRROR_MAX = 2000;
const CHUNK_OPTS = { maxRows: CHUNK_MIRROR_MAX };

/**
 * 按 notebook 的块缓存（只在**镜像被拒**时才填）。
 *
 * 上限按 notebook 行数算（不是字节）：2000 行 ≈ 16MB，与 `CHUNK_MIRROR_MAX` 同一量级，
 * 所以"被拒之后"的常驻占用不会比"镜像生效"时更大。
 */
const CHUNK_CACHE_MAX_PER_NOTEBOOK = CHUNK_MIRROR_MAX;

/**
 * 缓存桶：`端口标识 → (notebookId → 块)`（任务 Y-2 的分端口分桶）。
 *
 * ## 为什么必须是两层，而不是"一个 Map + 换端口时 clear()"
 *
 * 读接口是**同步**的，而按需读是**异步**的（见 `warmChunksByNotebook`），
 * 所以缓存写入永远发生在"发起读"之后的好几个微任务/一次 IPC 之后。
 * 单层 Map 的形态是"换端口就整体作废"，而作废**只在下一次读缓存时发生**：
 *
 * ```
 * t0  currentChunkCache()            → 桶=A（此时端口还是 A）
 * t1  warmChunksByNotebook 发起 crud.list（await 中）
 * t2  端口被换成 B；某次读触发 currentChunkCache() → clear() → 桶=B
 * t3  A 的 job 回来，cache.set(nb, A 的块)  ← cache 是 t0 抓到的**同一个 Map**
 * t4  B 的读 currentChunkCache().get(nb) → **拿到 A 的数据**
 * ```
 *
 * 实测形态（审计探针原文）：
 * ```
 * PROBE chunk ids under port B: ["<threw>"]
 * AssertionError: expected [ '<threw>' ] to deeply equal [ 'B1' ]
 * ```
 * 也就是"B 端口读到 A 的数据" —— 注释自己写过，这种症状是**静默返回错内容**，
 * 比"读不到"严重得多。
 *
 * 分桶之后 `t3` 落进的是 **A 的桶**，B 的读永远只看 B 的桶，
 * 串味在结构上就不可能发生（不依赖"写回时复核"这种时序检查是否写全）。
 * 代价是端口 A 的桶会成为垃圾 —— 每次换端口时整体丢弃（见 `currentChunkCache`），
 * 与"单层 Map + clear"的清理时机**完全一致**，没有新增常驻。
 */
const chunkCacheBuckets = new Map<unknown, Map<string, NotebookChunk[]>>();

/**
 * 给端口实例取一个稳定的标识（分桶的键）。
 *
 * 用 `WeakMap` 而不是"端口对象本身"当键：`Map<StoragePort, …>` 会**强引用**端口，
 * 而端口持有镜像数据 —— 换端口之后旧端口的桶虽然被丢弃，但如果键仍是对象引用，
 * 旧端口对象本身也可能被这张表拖住（GC 语义说不清）。`WeakMap` + 数值 token
 * 让键是原始值，桶表里不含任何对象引用。
 */
const portTokens = new WeakMap<object, number>();
let nextPortToken = 1;

function portTokenOf(port: object | null): unknown {
  if (!port) return null; // A 态（端口未注册）
  try {
    let token = portTokens.get(port);
    if (token === undefined) {
      token = nextPortToken++;
      portTokens.set(port, token);
    }
    return token;
  } catch {
    // 极端环境（不可扩展对象等）：退回"弱标识不可用"这一态，绝不让缓存层抛错
    return null;
  }
}

/** 当前端口（端口查询自身出错时按"没有端口"处理，与 `chunkOnDemandPossible` 同一约定） */
function currentPort(): object | null {
  try {
    return hasStoragePort() ? (getStoragePort() as unknown as object) : null;
  } catch {
    return null;
  }
}

/**
 * 正在进行中的按需读。
 *
 * 键是 `token|notebookId` 而不是单独的 notebookId：端口 A 的 job 还在飞时，
 * 端口 B 对**同一个 notebook** 的读不该被 A 的在途 job 挡掉（那会让 B 这一轮
 * 读不到 —— 虽然不是串味，但同样是"换端口之后的错答复"）。
 */
const chunkWarmInFlight = new Set<string>();

function warmKeyOf(token: unknown, notebookId: string): string {
  return `${String(token)}|${notebookId}`;
}

/**
 * 取当前端口的缓存桶 —— **这个函数不会跨 `await` 使用**。
 *
 * 调用方分两类（这条纪律是 Y-2 的修法边界，改代码前先看自己在哪一类）：
 * 1. **同步读**（`getChunks` / `getChunkCountOrNull` / `chunkIndexState`）：
 *    当场取、当场用，`await` 边界不存在；
 * 2. **异步按需读**（`warmChunksByNotebook`）：必须在**开头**取桶，
 *    并且把"端口是否还是那一个"的判据一起取下来 —— 写回时先在 `finally`
 *    里核对端口没变，才 `bucket.set(...)`（写进的是**当初那个端口的桶**）。
 */
function currentChunkCache(): Map<string, NotebookChunk[]> {
  const port = currentPort();
  const token = portTokenOf(port);
  let bucket = chunkCacheBuckets.get(token);
  if (!bucket) {
    /*
     * 端口变了（或这是第一个端口）：**丢弃所有旧桶**。
     *
     * 只保留"当前端口"一个桶，内存占用与改动前完全一样（旧版是单层 Map + clear）。
     */
    chunkCacheBuckets.clear();
    bucket = new Map<string, NotebookChunk[]>();
    chunkCacheBuckets.set(token, bucket);
  }
  return bucket;
}

/**
 * 本进程观察到的"`notebook_chunks` 镜像最近一次是否可用"。
 *
 * ⚠️ **这个标记只是诊断补充，不是 `chunkIndexState()` 的判据**。
 *
 * 起初我用它来回答"镜像现在可用吗"——那是错的：它记的是**上一次读**的结果，
 * 而镜像可能在两次读之间才刚刚加载完成（`ensureLoaded` 是异步的）。
 * 那样 `chunkIndexState()` 会持续谎报 "on-demand"（实测：镜像明明已经接手，
 * 状态却一直是 on-demand）。判据必须是**当场问镜像**
 * （`domainPort()`：端口在且该表已加载且未被拒），见 `chunkIndexState()`。
 */
let chunkMirrorLastSeenReady = false;

/**
 * 最近一次块读**看到**的镜像状态（诊断/测试用）。
 *
 * 与 `chunkIndexState()` 的区别：这个是"上次读到时的快照"，那个是"此刻问镜像的答案"。
 * 留它是因为"镜像从不可用变成可用"这个**转变**本身有诊断价值
 * （C-3 的现场就是"被拒之后一直没有恢复"）。
 */
export function chunkMirrorLastSeenReadyForDiagnostics(): boolean {
  return chunkMirrorLastSeenReady;
}

/** `notebook_chunks` 的读取状态 —— 供检索入口区分"索引未就绪"与"确实没有内容" */
export type ChunkIndexState = "mirror" | "on-demand" | "unavailable";

/**
 * 当前块索引的读取状态。
 *
 * 检索入口（`retriever.ts` / `search-notebook.ts` / `indexer.ts`）用它把
 * "索引还没就绪"和"笔记本里确实没有相关内容"**分开告诉 LLM** ——
 * 这两件事对模型的意义完全不同，混成一句"没有相关内容"就是撒谎。
 *
 * ## 判据是**当场问镜像**，不是缓存一个标记
 *
 * `domainPort(table)` 的语义正好是"端口在 **且** 该表镜像已加载且未被拒"，
 * 并且在未加载时会顺手触发一次惰性加载 —— 所以它就是"镜像现在可用吗"的权威答案。
 * 早先这里用"上次读的结果"当判据，会在"镜像刚刚加载完"的窗口里持续谎报
 * （实测：镜像已接手，状态却停在 on-demand）。
 */
export function chunkIndexState(): ChunkIndexState {
  if (isChunkMirrorReady()) return "mirror";
  if (!hasStoragePort()) return "unavailable";
  if (currentChunkCache().size > 0) return "on-demand";
  // 镜像没接手、缓存也还空 → 仍然走"按需读"这条路（会触发预取）
  return chunkOnDemandPossible() ? "on-demand" : "unavailable";
}

/** 镜像此刻是否可用（顺便把惰性加载触发掉，与 `domainPort` 的既有约定一致） */
function isChunkMirrorReady(): boolean {
  return domainPort(T_CHUNKS, CHUNK_OPTS) !== null;
}

/** 端口上是否具备按 notebook 按需读块的能力（`data.command` / `data.execute`） */
function chunkOnDemandPossible(): boolean {
  if (!hasStoragePort()) return false;
  try {
    return Boolean((getStoragePort().data as { execute?: unknown })?.execute);
  } catch {
    return false;
  }
}

/**
 * 后台按需拉某个 notebook 的全部块（只在镜像被拒时用）。
 *
 * 用 `crud.list` + `where: { notebook_id }`：**列名/表名由引擎侧核对**
 * （不存在会报错，不会静默少列），并且天然是"按 notebook 分片"的读。
 * 一次拉不完时分页继续（`has_more` 由引擎给，不靠"返回行数 == limit"猜）。
 *
 * ## 任务 Y-2：这一段的"缓存归属"原来是错的
 *
 * 原实现的开头是 `const cache = currentChunkCache()`，`await` 之后才 `cache.set(...)`；
 * 而端口的归属比较**只发生在 `currentChunkCache()` 被调用那一刻**。于是
 * "端口在 await 期间被换掉"时会出现：
 *
 * ```
 * t0  cache = currentChunkCache()  → 桶 A（chunkCachePort = A）
 * t1  await crud.list …（端口被换成 B；某次读把 chunkCache.clear() 成 B 的桶）
 * t2  cache.set(nb, A 的块)        → 写进的是 t0 抓到的**同一个 Map**（即 B 的桶）
 * ```
 *
 * 之后的 B 端口读会拿到 **A 的数据** —— 静默返回错内容，比读不到严重得多。
 *
 * ## 修法（两条一起，缺一不可）
 *
 * 1. **分桶**（`chunkCacheBuckets`）：缓存的键是"端口标识 + notebookId"，
 *    A 的 job 只能写进 A 的桶，结构上就不可能串味；
 * 2. **写回复核**：写回之前核对端口**还是当初那一个**（`currentPort() === portAtStart`），
 *    变了就**丢弃结果并如实上报** —— 因为这份数据对新端口未必成立
 *    （端口换了通常意味着换了库/换了会话），宁可让下一次读重新拉，也不落一份来路不明的数据。
 *
 * 为什么两条都要：只有 ② 的话，任何一处漏写复核就退化成原缺陷；
 * 只有 ① 的话，旧端口的数据会静默堆在一个永远没人读的桶里（不串味，但沉默）。
 *
 * @returns 本次预取的 Promise（**测试要确定性等待它，生产不等待**）。
 *   早先返回 `void` 且是 fire-and-forget，测试只能靠"等若干个微任务"猜时机 ——
 *   那会让"端口在 await 期间被换掉"这条竞态**无法被稳定复现**。
 *   返回一个可 await 的句柄不改变生产语义（`getChunks` 仍然立刻抛"未就绪"），
 *   只是把"这一轮预取什么时候结束"变成可观察的事实。
 */
function warmChunksByNotebook(notebookId: string): Promise<void> {
  // ① 开头就把"桶"与"端口"一起定下来（顺序在同一 tick 内，二者必然属于同一个端口）
  const bucket = currentChunkCache();
  const portAtStart = currentPort();
  const tokenAtStart = portTokenOf(portAtStart);
  const warmKey = warmKeyOf(tokenAtStart, notebookId);

  if (chunkWarmInFlight.has(warmKey)) return Promise.resolve();
  if (!chunkOnDemandPossible()) return Promise.resolve();
  chunkWarmInFlight.add(warmKey);

  return (async () => {
    try {
      const port = getStoragePort();
      const data = port.data as unknown as {
        command?: <T>(cmd: string, params?: Record<string, unknown>) => Promise<T>;
      };
      const rows: Record<string, unknown>[] = [];
      let offset = 0;
      // 有界分页：单 notebook 超过 20 页（20000 块）就停手，宁可少读也不把渲染进程压死
      for (let page = 0; page < 20; page++) {
        const params = { table: T_CHUNKS, where: { notebook_id: notebookId }, limit: 1000, offset };
        const res = data.command
          ? await data.command<{ items?: Record<string, unknown>[]; has_more?: boolean }>("crud.list", params)
          : ((await port.data.execute("crud.list", params)) as unknown as {
              items?: Record<string, unknown>[];
              has_more?: boolean;
            });
        const items = res?.items ?? [];
        rows.push(...items);
        if (!res?.has_more || items.length === 0) break;
        offset += items.length;
      }
      const converted = rows.map(wireToChunk);
      if (converted.length > CHUNK_CACHE_MAX_PER_NOTEBOOK) {
        // 单 notebook 就超过缓存预算：不缓存（避免"按需读"变成偷偷的整表常驻），如实上报
        reportPersistFailure(
          "chunk.onDemand",
          new Error(`笔记本 ${notebookId} 的文本块超过缓存上限 ${CHUNK_CACHE_MAX_PER_NOTEBOOK} 行`),
          `本次读到 ${converted.length} 块但未缓存；检索请缩小到具体来源`,
        );
        return;
      }
      /*
       * ② 写回复核：端口在 await 期间被换掉 → **丢弃**这份结果。
       *
       * 判据是**端口引用相等**（`currentPort()` 与开头那一次取值比），不猜任何内部状态。
       * 丢弃必须**如实上报**：否则表现成"按需读永远不命中"，
       * 下一次读照样抛"索引未就绪"，而没有任何痕迹指向"端口换了"。
       */
      if (currentPort() !== portAtStart) {
        reportPersistFailure(
          "chunk.onDemand",
          new Error("存储端口在按需读期间被更换"),
          `笔记本 ${notebookId} 的本次按需读作废（结果不属于当前端口，已丢弃；下一次读会重新拉）`,
        );
        return;
      }
      bucket.set(notebookId, converted);
    } catch (e) {
      reportPersistFailure("chunk.onDemand", e, `笔记本 ${notebookId} 的文本块未按需读到（下次读会再试一次）`);
    } finally {
      chunkWarmInFlight.delete(warmKey);
    }
  })();
}

/**
 * 按需读路径下的块（未命中返回 undefined，调用方据此触发预取）。
 *
 * 读只认**当前端口**的桶（`currentChunkCache()`），所以永远读不到别的端口的数据。
 */
function onDemandChunks(notebookId: string): NotebookChunk[] | undefined {
  const hit = currentChunkCache().get(notebookId);
  if (hit) return hit;
  warmChunksByNotebook(notebookId);
  return undefined;
}

/**
 * **仅供测试**：等一次"按需读预取"真正结束（成功 / 作废 / 失败都算结束）。
 *
 * 为什么需要它：Y-2 的缺陷只在"端口在 await 期间被换掉"这一个窗口里出现，
 * 而这个窗口在测试里只能靠"控制异步读什么时候 resolve"来稳定复现 ——
 * 若拿不到预取的句柄，就只能等若干个微任务去猜，那是一条**靠时序碰运气**的回归测试
 * （本仓库已经吃过"时序碰运气"的亏，见 `chunkCachePort` 那段注释里的实测记录）。
 *
 * 它不是产品 API：名字带 `__` 前缀，生产代码不调用它。
 */
export function __warmChunksForTests(notebookId: string): Promise<void> {
  return warmChunksByNotebook(notebookId);
}

/**
 * **仅供测试**：当前进程里一共存了几个端口的缓存桶，以及每个桶（按端口 token）里的块数。
 *
 * 为什么需要它：Y-2 的缺陷是"**数据落进了错误的桶**"，而从一个端口的角度看，
 * 症状（本次读拿不到 / 抛未就绪）与"本来就该读不到"**一模一样** ——
 * 只断言"B 端口读不到 A 的数据"会分不清"修好了"与"结果被丢掉了"。
 * 有了桶视图，测试才能同时钉住两件事：
 * 1. B 的桶里**没有** A 的数据（不串味）；
 * 2. A 的数据**确实被丢掉了**（不是悄悄存在某个角落）。
 *
 * 另一个用途：反过来证明**修前的形态**（旧版本只有一层 `chunkCache`，
 * 没有这个概念）—— 对照探针靠它把"当时的缓存里到底是什么"打出来。
 */
export function __chunkCacheBucketsForTests(): Array<{ token: string; notInCurrentPort: boolean; entries: Record<string, string[]> }> {
  const currentToken = String(portTokenOf(currentPort()));
  return [...chunkCacheBuckets.entries()].map(([token, bucket]) => ({
    token: String(token),
    notInCurrentPort: String(token) !== currentToken,
    entries: Object.fromEntries([...bucket.entries()].map(([nb, chunks]) => [nb, chunks.map((c) => c.id)])),
  }));
}

/**
 * "该表镜像未接手"的可区分失败（C-3 要求 ②）。
 *
 * 为什么是**抛**而不是返回 `[]`：`getChunks` 的调用方（检索、图谱抽取、PPT 生成、
 * 来源预览）把空数组理解成"这个笔记本没有内容"。索引没就绪时返回空数组，
 * 就是让整条链路基于一个假前提工作 —— 那正是本仓库最在意的那类缺陷。
 */
export class ChunkIndexUnavailableError extends Error {
  constructor(message: string, readonly notebookId: string) {
    super(message);
    this.name = "ChunkIndexUnavailableError";
  }
}

// ========== Utils ==========

function generateId(): string {
  return `nb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateSourceId(): string {
  return `src_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateChunkId(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Float32Array → Base64 for BLOB storage */
export function embeddingToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Base64 BLOB → Float32Array */
export function base64ToEmbedding(b64: string): Float32Array | null {
  if (!b64) return null;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } catch {
    return null;
  }
}

/** JSON 文本 → 数组（解析失败一律当"没有"，与旧实现的 try/catch 一致） */
function parseJsonArray(json: unknown): string[] | undefined {
  if (typeof json !== "string" || !json) return undefined;
  try {
    return JSON.parse(json) as string[];
  } catch {
    return undefined;
  }
}

// ========== 行 ↔ 线协议行（P3 第 15 段：域镜像路由） ==========
//
// 这一段 9 张表全部走域名镜像。转换函数显式列出每一列：
// 旧实现用 `db.exec` 拿**位置数组**，靠下标取列（`row[9]` 之类），
// 增删一列就会整体错位；具名列 + 显式映射把这类错误变成编译期/测试期可见。

function wireToNotebook(row: Record<string, unknown>): Notebook {
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string) || undefined,
    summary: (row.summary as string) || undefined,
    summaryStatus: row.summary_status as SummaryStatus,
    sourceCount: Number(row.source_count ?? 0),
    chunkCount: Number(row.chunk_count ?? 0),
    groupId: (row.group_id as string) || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function notebookToWire(nb: Notebook): Record<string, unknown> {
  return {
    id: nb.id,
    name: nb.name,
    description: nb.description ?? null,
    summary: nb.summary ?? null,
    summary_status: nb.summaryStatus,
    source_count: nb.sourceCount,
    chunk_count: nb.chunkCount,
    group_id: nb.groupId ?? null,
    created_at: nb.createdAt,
    updated_at: nb.updatedAt,
  };
}

function wireToSource(row: Record<string, unknown>): NotebookSource {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    name: String(row.name),
    type: row.type as SourceType,
    content: (row.content as string) || undefined,
    filePath: (row.file_path as string) || undefined,
    url: (row.url as string) || undefined,
    mimeType: (row.mime_type as string) || undefined,
    size: (row.size as number) || undefined,
    status: row.status as SourceStatus,
    chunkCount: Number(row.chunk_count ?? 0),
    errorMessage: (row.error_message as string) || undefined,
    summary: (row.summary as string) || undefined,
    keyTopics: parseJsonArray(row.key_topics),
    createdAt: Number(row.created_at),
  };
}

function sourceToWire(s: NotebookSource): Record<string, unknown> {
  return {
    id: s.id,
    notebook_id: s.notebookId,
    name: s.name,
    type: s.type,
    content: s.content ?? null,
    file_path: s.filePath ?? null,
    url: s.url ?? null,
    mime_type: s.mimeType ?? null,
    size: s.size ?? null,
    status: s.status,
    chunk_count: s.chunkCount,
    error_message: s.errorMessage ?? null,
    summary: s.summary ?? null,
    key_topics: s.keyTopics ? JSON.stringify(s.keyTopics) : null,
    created_at: s.createdAt,
  };
}

function wireToChunk(row: Record<string, unknown>): NotebookChunk {
  const embeddingB64 = row.embedding as string | null;
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    notebookId: String(row.notebook_id),
    content: String(row.content),
    chunkIndex: Number(row.chunk_index),
    embedding: embeddingB64 ? base64ToEmbedding(embeddingB64) : null,
    tokenCount: Number(row.token_count ?? 0),
    createdAt: Number(row.created_at),
  };
}

function chunkToWire(c: NotebookChunk): Record<string, unknown> {
  return {
    id: c.id,
    source_id: c.sourceId,
    notebook_id: c.notebookId,
    content: c.content,
    chunk_index: c.chunkIndex,
    embedding: c.embedding ? embeddingToBase64(c.embedding) : null,
    token_count: c.tokenCount,
    created_at: c.createdAt,
  };
}

function wireToNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    sourceId: (row.source_id as string) || undefined,
    title: String(row.title),
    content: (row.content as string) || '',
    contentType: ((row.content_type as string) || 'markdown') as NoteContentType,
    tags: parseJsonArray(row.tags),
    pinOrder: Number(row.pin_order ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function noteToWire(n: Note): Record<string, unknown> {
  return {
    id: n.id,
    notebook_id: n.notebookId,
    source_id: n.sourceId ?? null,
    title: n.title,
    content: n.content ?? '',
    content_type: n.contentType ?? 'markdown',
    tags: n.tags ? JSON.stringify(n.tags) : null,
    pin_order: n.pinOrder ?? 0,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

function wireToNoteLink(row: Record<string, unknown>): NoteLink {
  return {
    id: String(row.id),
    sourceNoteId: String(row.source_note_id),
    targetNoteId: String(row.target_note_id),
    linkText: (row.link_text as string) || undefined,
    createdAt: Number(row.created_at),
  };
}

function wireToNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    label: String(row.label),
    entityType: row.entity_type as EntityType,
    description: (row.description as string) || undefined,
    sourceIds: parseJsonArray(row.source_ids) ?? [],
    chunkIds: parseJsonArray(row.chunk_ids) ?? [],
    weight: Number(row.weight ?? 1),
    communityId: (row.community_id as number) ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function nodeToWire(n: GraphNode): Record<string, unknown> {
  return {
    id: n.id,
    notebook_id: n.notebookId,
    label: n.label,
    entity_type: n.entityType,
    description: n.description ?? null,
    source_ids: JSON.stringify(n.sourceIds ?? []),
    chunk_ids: JSON.stringify(n.chunkIds ?? []),
    weight: n.weight,
    community_id: n.communityId ?? null,
    created_at: n.createdAt,
  };
}

function wireToEdge(row: Record<string, unknown>): GraphEdge {
  return {
    id: String(row.id),
    notebookId: String(row.notebook_id),
    sourceNodeId: String(row.source_node_id),
    targetNodeId: String(row.target_node_id),
    relationType: row.relation_type as RelationType,
    weight: Number(row.weight ?? 1),
    createdAt: Number(row.created_at),
  };
}

function edgeToWire(e: GraphEdge): Record<string, unknown> {
  return {
    id: e.id,
    notebook_id: e.notebookId,
    source_node_id: e.sourceNodeId,
    target_node_id: e.targetNodeId,
    relation_type: e.relationType,
    weight: e.weight,
    created_at: e.createdAt,
  };
}

function wireToGroup(row: Record<string, unknown>): NotebookGroup {
  return {
    id: String(row.id),
    name: String(row.name),
    parentId: (row.parent_id as string) || undefined,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: Number(row.created_at),
  };
}

function groupToWire(g: NotebookGroup): Record<string, unknown> {
  return {
    id: g.id,
    name: g.name,
    parent_id: g.parentId ?? null,
    sort_order: g.sortOrder ?? 0,
    created_at: g.createdAt,
  };
}

function wireToVersion(row: Record<string, unknown>): NoteVersion {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    title: String(row.title),
    content: String(row.content),
    tags: parseJsonArray(row.tags),
    versionNote: (row.version_note as string) || undefined,
    createdAt: Number(row.created_at),
  };
}

function versionToWire(v: NoteVersion): Record<string, unknown> {
  return {
    id: v.id,
    note_id: v.noteId,
    title: v.title,
    content: v.content,
    tags: v.tags ? JSON.stringify(v.tags) : null,
    version_note: v.versionNote ?? null,
    created_at: v.createdAt,
  };
}

// ========== Notebook CRUD ==========

export function createNotebook(input: CreateNotebookInput): Notebook {
  const now = Date.now();
  const id = generateId();
  const created: Notebook = {
    id,
    name: input.name,
    description: input.description,
    summary: undefined,
    summaryStatus: 'pending',
    sourceCount: 0,
    chunkCount: 0,
    groupId: input.groupId,
    createdAt: now,
    updatedAt: now,
  };
  if (domainWrite(T_NOTEBOOKS, [notebookToWire(created)], { scope: "notebook.create", note: "笔记本未保存" })) {
    return created;
  }
    reportWriteNotAccepted("notebook.create", "笔记本未保存");
    return created;
}

export function getNotebook(id: string): Notebook | null {
  const rust = domainReadOne(T_NOTEBOOKS, { id }, wireToNotebook);
  if (rust !== undefined) return rust;
    return null;
}

export function listNotebooks(): Notebook[] {
  const rust = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  if (rust) return rust.sort((a, b) => b.updatedAt - a.updatedAt);
    return [];
}

export function listNotebooksByGroup(groupId: string | null): Notebook[] {
  const rust = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  if (rust) {
    return rust
      // `group_id IS NULL` 与 `group_id = ?`：undefined 表示"未分组"
      .filter((nb) => (groupId === null ? nb.groupId === undefined : nb.groupId === groupId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
    return [];
}

export function updateNotebook(id: string, update: Partial<Pick<Notebook, 'name' | 'description' | 'summary' | 'summaryStatus' | 'groupId'>>): void {
  const fields: string[] = [];
  if (update.name !== undefined) fields.push('name');
  if (update.description !== undefined) fields.push('description');
  if (update.summary !== undefined) fields.push('summary');
  if (update.summaryStatus !== undefined) fields.push('summary_status');
  if (update.groupId !== undefined) fields.push('group_id');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateNotebook 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_NOTEBOOKS, { id }, wireToNotebook);
  if (current !== undefined) {
    if (current === null) return; // 笔记本不存在：旧实现是 UPDATE 影响 0 行
    const next: Notebook = {
      ...current,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.description !== undefined ? { description: update.description ?? undefined } : {}),
      ...(update.summary !== undefined ? { summary: update.summary } : {}),
      ...(update.summaryStatus !== undefined ? { summaryStatus: update.summaryStatus } : {}),
      ...(update.groupId !== undefined ? { groupId: update.groupId ?? undefined } : {}),
      updatedAt: Date.now(),
    };
    domainWrite(T_NOTEBOOKS, [notebookToWire(next)], {
      mode: "replace",
      scope: "notebook.update",
      note: "笔记本未更新（笔记本不存在或写入失败）",
    });
    return;
  }

    reportWriteNotAccepted("notebook.update", "笔记本未更新");
    return;
}

export function deleteNotebook(id: string): void {
  if (domainDelete(T_NOTEBOOKS, { id }, { scope: "notebook.delete", note: "笔记本未删除" })) return;
    reportWriteNotAccepted("notebook.delete", "笔记本未删除");
    return;
}

/**
 * Update aggregated counts after source/chunk changes.
 *
 * ## 任务 C-3（严重）：不得把"读不到"当成 0 写回
 *
 * 原实现无条件把 `getChunkCount()` 的结果写进 `notebooks.chunk_count`，
 * 而 `getChunkCount()` 在块镜像被拒（超过 `CHUNK_MIRROR_MAX`）或尚未就绪时**返回 0** ——
 * 于是 `refreshNotebookCounts` 每一次调用都把**真实计数覆盖成 0**，
 * 而且这个 0 是**持久化**的（重启后依旧是 0，镜像修好了也修不回来）。
 *
 * 现在两个计数各自区分三态：
 * - **镜像/按需读可用** → 用真实值；
 * - **端口未注册（A 态）** → 用可用的那份（`chunkCache` 或 0），并如实上报；
 * - **端口在但镜像未接手且按需读也拿不到** → **本次不写回**（宁可旧值，也不写一个假的 0）。
 *
 * 为什么要"跳过"而不是"上报后照写"：写回的是一个**用户可见的持久数字**，
 * 假 0 会一路显示在笔记本列表上，且没有任何迹象表明它是假的。
 */
export function refreshNotebookCounts(notebookId: string): void {
  const sourceCount = getSourceCountOrNull(notebookId);
  const chunkCount = getChunkCountOrNull(notebookId);
  const now = Date.now();

  /*
   * 只要有一个计数拿不到**真值**，就整体不写回：
   * 两个计数是同一行的两个列（`source_count` / `chunk_count`），
   * 写一半会让"计数与实际不符"变成更难查的形态。
   */
  if (sourceCount === null || chunkCount === null) {
    reportPersistFailure(
      "notebook.refreshCounts",
      new Error("计数读不到（该域镜像未接手或按需读不可用）"),
      `笔记本 ${notebookId} 的计数未刷新（**没有**写回 0 —— 旧值保留）`,
    );
    return;
  }

  // 迁移期：计数在**同一份数据**（镜像 / 按需读）上算完 → 整体写回 notebooks 行。
  const current = domainReadOne(T_NOTEBOOKS, { id: notebookId }, wireToNotebook);
  if (current !== undefined) {
    if (current === null) return;
    domainWrite(
      T_NOTEBOOKS,
      [notebookToWire({ ...current, sourceCount, chunkCount, updatedAt: now })],
      { mode: "replace", scope: "notebook.refreshCounts", note: "笔记本计数未刷新" },
    );
    return;
  }

    reportWriteNotAccepted("notebook.refreshCounts", "笔记本计数未刷新");
    return;
}

/**
 * 来源计数：**`null` = 读不到**（与"确实是 0 条"区分）。
 *
 * 这里的 `null` 不是内部实现细节，而是 C-3 的核心：
 * "读不到"和"是 0"在原实现里被压成了同一个 `0`，于是一个瞬时状态
 * （镜像还没加载完）被写成了永久的错误事实。
 */
function getSourceCountOrNull(notebookId: string): number | null {
  const rust = domainReadMany(T_SOURCES, (r) => r, { notebook_id: notebookId });
  if (rust) return rust.length;
  if (domainPortRegistered()) return null; // 端口在但镜像未接手 → 读不到
  return 0; // A 态（端口未注册）：没有别的来源，0 是诚实的
}

function rowToNotebook(row: any[]): Notebook {
  return {
    id: row[0] as string,
    name: row[1] as string,
    description: row[2] as string || undefined,
    summary: row[3] as string || undefined,
    summaryStatus: (row[4] as string) as SummaryStatus,
    sourceCount: row[5] as number,
    chunkCount: row[6] as number,
    groupId: row[9] as string || undefined,
    createdAt: row[7] as number,
    updatedAt: row[8] as number,
  };
}

// ========== Source CRUD ==========

export function addSource(input: AddSourceInput): NotebookSource {
  const now = Date.now();
  const id = generateSourceId();
  const created: NotebookSource = {
    id,
    notebookId: input.notebookId,
    name: input.name,
    type: input.type,
    content: input.content,
    filePath: input.filePath,
    url: input.url,
    mimeType: input.mimeType,
    size: input.size,
    status: 'pending',
    chunkCount: 0,
    createdAt: now,
  };
  if (domainWrite(T_SOURCES, [sourceToWire(created)], { scope: "source.add", note: "来源未保存" })) {
    return created;
  }
    reportWriteNotAccepted("source.add", "来源未保存");
    return created;
}

export function getSource(id: string): NotebookSource | null {
  const rust = domainReadOne(T_SOURCES, { id }, wireToSource);
  if (rust !== undefined) return rust;
    return null;
}

export function listSources(notebookId: string): NotebookSource[] {
  const rust = domainReadMany(T_SOURCES, wireToSource, { notebook_id: notebookId });
  if (rust) return rust.sort((a, b) => a.createdAt - b.createdAt);
    return [];
}

export function updateSource(id: string, update: Partial<Pick<NotebookSource, 'status' | 'chunkCount' | 'errorMessage' | 'summary' | 'keyTopics'>>): void {
  const fields: string[] = [];
  if (update.status !== undefined) fields.push('status');
  if (update.chunkCount !== undefined) fields.push('chunk_count');
  if (update.errorMessage !== undefined) fields.push('error_message');
  if (update.summary !== undefined) fields.push('summary');
  if (update.keyTopics !== undefined) fields.push('key_topics');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateSource 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_SOURCES, { id }, wireToSource);
  if (current !== undefined) {
    if (current === null) return; // 来源不存在：旧实现是 UPDATE 影响 0 行
    const next: NotebookSource = {
      ...current,
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.chunkCount !== undefined ? { chunkCount: update.chunkCount } : {}),
      ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage ?? undefined } : {}),
      ...(update.summary !== undefined ? { summary: update.summary } : {}),
      ...(update.keyTopics !== undefined ? { keyTopics: update.keyTopics ?? undefined } : {}),
    };
    domainWrite(T_SOURCES, [sourceToWire(next)], {
      mode: "replace",
      scope: "source.update",
      note: "来源未更新（来源不存在或写入失败）",
    });
    return;
  }

    reportWriteNotAccepted("source.update", "来源未更新");
    return;
}

export function deleteSource(id: string): void {
  if (domainDelete(T_SOURCES, { id }, { scope: "source.delete", note: "来源未删除" })) return;
    reportWriteNotAccepted("source.delete", "来源未删除");
    return;
}

function rowToSource(row: any[]): NotebookSource {
  let keyTopics: string[] | undefined;
  const keyTopicsJson = row[13] as string;
  if (keyTopicsJson) {
    try { keyTopics = JSON.parse(keyTopicsJson); } catch { keyTopics = undefined; }
  }
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    name: row[2] as string,
    type: row[3] as SourceType,
    content: row[4] as string || undefined,
    filePath: row[5] as string || undefined,
    url: row[6] as string || undefined,
    mimeType: row[7] as string || undefined,
    size: row[8] as number || undefined,
    status: (row[9] as string) as SourceStatus,
    chunkCount: row[10] as number,
    errorMessage: row[11] as string || undefined,
    summary: row[12] as string || undefined,
    keyTopics,
    createdAt: row[14] as number,
  };
}

// ========== Chunk CRUD ==========

export function addChunk(chunk: Omit<NotebookChunk, 'id' | 'createdAt'>): NotebookChunk {
  const now = Date.now();
  const id = generateChunkId();
  const created: NotebookChunk = { ...chunk, id, createdAt: now };
  // 注意：这一行带 Base64 embedding，体积大。上限由 CHUNK_MIRROR_MAX 把住。
  if (domainWrite(T_CHUNKS, [chunkToWire(created)], { scope: "chunk.add", note: "文本块未保存", ...CHUNK_OPTS })) {
    // 写成功 = 镜像可用（`applyWriteMany` 只有表已镜像时才生效）→ 记下这个事实
    chunkMirrorLastSeenReady = true;
    return created;
  }
    reportWriteNotAccepted("chunk.add", "文本块未保存");

    return created;
}

export function addChunksBulk(notebookId: string, sourceId: string, chunks: { content: string; chunkIndex: number; embedding: Float32Array | null; tokenCount: number }[]): void {
  const now = Date.now();
  const rows = chunks.map((chunk) => {
    const row: NotebookChunk = {
      id: generateChunkId(),
      sourceId,
      notebookId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      embedding: chunk.embedding,
      tokenCount: chunk.tokenCount,
      createdAt: now,
    };
    return chunkToWire(row);
  });
  // 批量走**一次** crud.upsert：旧实现是 N 次 db.run（每条一次往返），
  // 这是"大文档批处理"最直接的瓶颈之一。
  if (domainWrite(T_CHUNKS, rows, { scope: "chunk.addBulk", note: "文本块未批量保存", ...CHUNK_OPTS })) {
    chunkMirrorLastSeenReady = true;
    return;
  }
    reportWriteNotAccepted("chunk.addBulk", "文本块未批量保存");
    if (domainPortRegistered()) chunkMirrorLastSeenReady = false;
    return;
}

/**
 * 取某个笔记本的全部文本块。
 *
 * ## 任务 C-3（严重）：原来在镜像被拒时返回 `[]`，冒充"这个笔记本没有内容"
 *
 * 返回空数组的代价不是"少几条结果"，而是**整条知识链路基于假前提工作**：
 * `retriever.ts` 检索不到 → `search_notebook` 告诉 LLM"没有相关内容"；
 * `graph-extractor.ts` 抽不出图谱；PPT 生成拿到空内容。用户看到的是
 * "我的资料不见了"，而不是"索引没就绪"。
 *
 * 现在：
 * - 镜像就绪 → 走镜像（快路径，行为不变）；
 * - 镜像被拒但按需读可用 → 返回按需读缓存；**缓存未命中时抛
 *   `ChunkIndexUnavailableError`**（这一次同步读拿不到，下一次命中）——
 *   调用方可以据此给 LLM 一个**明确的"索引未就绪"**结论；
 * - 端口都没有 → 同样抛（A 态：本进程没有可用存储）。
 *
 * ⚠️ 这是**行为变更**（从"返回 []"变成"可能抛"）。所有调用点都在本仓库内，
 * 已逐个改为先问 `chunkIndexState()` 或在本地 catch 后给出可区分结论；
 * 契约测试 `knowledge-chunk-mirror-refusal.test.ts` 守住两侧。
 */
export function getChunks(notebookId: string): NotebookChunk[] {
  const rust = domainReadMany(T_CHUNKS, wireToChunk, { notebook_id: notebookId }, CHUNK_OPTS);
  if (rust) {
    chunkMirrorLastSeenReady = true;
    return rust.sort((a, b) => a.chunkIndex - b.chunkIndex);
  }
  // 镜像没接手。**先看这到底是"没加载"还是"被拒/被逐出"**（C-3 要求 ③ 的前提）
  chunkMirrorLastSeenReady = false;
  const onDemand = onDemandChunks(notebookId);
  if (onDemand) return [...onDemand].sort((a, b) => a.chunkIndex - b.chunkIndex);
  throw new ChunkIndexUnavailableError(
    `笔记本 ${notebookId} 的文本块索引尚未就绪（镜像未接手，按需读正在后台进行）—— 这**不是**"没有相关内容"`,
    notebookId,
  );
}

/**
 * `getChunks` 的**不抛**形态：把三态压成一个可判别的结果。
 *
 * ```ts
 * const r = getChunksOrStatus(id);
 * if (!r.ok) return `索引未就绪（${r.state}）`;   // ← 明确结论，而不是"没有相关内容"
 * use(r.chunks);
 * ```
 *
 * 为什么提供它：`getChunks` 现在会抛（C-3 要求 ②），而调用点遍布同步上下文
 * （UI effect、摘要生成、图谱抽取、PPT 生成）。让每个调用点各写一个 try/catch
 * 只会重复 8 次同样的判断 —— 收进一个函数，顺便保证**每一处**都拿到同一套三态。
 */
export function getChunksOrStatus(
  notebookId: string,
): { ok: true; chunks: NotebookChunk[]; state: ChunkIndexState } | { ok: false; state: ChunkIndexState; reason: string } {
  try {
    return { ok: true, chunks: getChunks(notebookId), state: chunkIndexState() };
  } catch (e) {
    if (e instanceof ChunkIndexUnavailableError) {
      return { ok: false, state: chunkIndexState(), reason: e.message };
    }
    throw e;
  }
}

/**
 * 取某个笔记本的块数。
 *
 * ## 任务 C-3：区分 `null`（读不到）与 `0`（确实是 0）
 *
 * 公开契约保持 `number`（既有调用点按数字用，不破坏它们的类型），
 * 但内部把"读不到"如实报出来 —— **绝不**再让 `refreshNotebookCounts`
 * 把"读不到"当 0 写回库。
 */
export function getChunkCount(notebookId: string): number {
  return getChunkCountOrNull(notebookId) ?? 0;
}

/** 块计数：`null` = 读不到（镜像未接手且按需读缓存也没有） */
function getChunkCountOrNull(notebookId: string): number | null {
  const rust = domainReadMany(T_CHUNKS, (r) => r, { notebook_id: notebookId }, CHUNK_OPTS);
  if (rust) {
    chunkMirrorLastSeenReady = true;
    return rust.length;
  }
  chunkMirrorLastSeenReady = false;
  const onDemand = currentChunkCache().get(notebookId);
  if (onDemand) return onDemand.length;
  // 缓存没有 → 触发一次预取（下一次读命中），本次如实返回"读不到"
  warmChunksByNotebook(notebookId);
  if (!hasStoragePort()) return 0; // A 态：本进程没有可用存储，0 是诚实的
  return null;
}

export function deleteChunksBySource(sourceId: string): void {
  const removed = domainDeleteWhere(
    T_CHUNKS,
    (row) => row.source_id === sourceId,
    "id",
    { scope: "chunk.deleteBySource", note: "文本块未删除", ...CHUNK_OPTS },
  );
  if (removed !== null) return;
    reportWriteNotAccepted("chunk.deleteBySource", "文本块未删除");
    // 删除没接手同样意味着镜像不可用（读路径要走按需读）
    if (domainPortRegistered()) chunkMirrorLastSeenReady = false;
    return;
}

function rowToChunk(row: any[]): NotebookChunk {
  const embeddingB64 = row[5] as string;
  return {
    id: row[0] as string,
    sourceId: row[1] as string,
    notebookId: row[2] as string,
    content: row[3] as string,
    chunkIndex: row[4] as number,
    embedding: embeddingB64 ? base64ToEmbedding(embeddingB64) : null,
    tokenCount: row[6] as number,
    createdAt: row[7] as number,
  };
}

// ========== Note CRUD ==========

function generateNoteId(): string {
  return `note_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createNote(input: CreateNoteInput): Note {
  const now = Date.now();
  const id = generateNoteId();
  const created: Note = {
    id,
    notebookId: input.notebookId,
    sourceId: input.sourceId,
    title: input.title,
    content: input.content ?? '',
    contentType: input.contentType ?? 'markdown',
    tags: input.tags,
    pinOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (domainWrite(T_NOTES, [noteToWire(created)], { scope: "note.create", note: "笔记未保存" })) {
    return created;
  }
    reportWriteNotAccepted("note.create", "笔记未保存");
    return created;
}

export function getNote(id: string): Note | null {
  const rust = domainReadOne(T_NOTES, { id }, wireToNote);
  if (rust !== undefined) return rust;
    return null;
}

export function listNotes(notebookId: string): Note[] {
  const rust = domainReadMany(T_NOTES, wireToNote, { notebook_id: notebookId });
  if (rust) return rust.sort((a, b) => (b.pinOrder - a.pinOrder) || (b.updatedAt - a.updatedAt));
    return [];
}

export function updateNote(id: string, update: Partial<Pick<Note, 'title' | 'content' | 'tags' | 'pinOrder' | 'sourceId'>>): void {
  const fields: string[] = [];
  if (update.title !== undefined) fields.push('title');
  if (update.content !== undefined) fields.push('content');
  if (update.tags !== undefined) fields.push('tags');
  if (update.pinOrder !== undefined) fields.push('pin_order');
  if (update.sourceId !== undefined) fields.push('source_id');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateNote 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_NOTES, { id }, wireToNote);
  if (current !== undefined) {
    if (current === null) return; // 笔记不存在：旧实现是 UPDATE 影响 0 行
    const next: Note = {
      ...current,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.content !== undefined ? { content: update.content } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      ...(update.pinOrder !== undefined ? { pinOrder: update.pinOrder } : {}),
      ...(update.sourceId !== undefined ? { sourceId: update.sourceId ?? undefined } : {}),
      updatedAt: Date.now(),
    };
    domainWrite(T_NOTES, [noteToWire(next)], {
      mode: "replace",
      scope: "note.update",
      note: "笔记未更新（笔记不存在或写入失败）",
    });
    return;
  }

    reportWriteNotAccepted("note.update", "笔记未更新");
    return;
}

export function deleteNote(id: string): void {
  if (domainDelete(T_NOTES, { id }, { scope: "note.delete", note: "笔记未删除" })) return;
    reportWriteNotAccepted("note.delete", "笔记未删除");
    return;
}

export function deleteNotesByNotebook(notebookId: string): void {
  const removed = domainDeleteWhere(
    T_NOTES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "note.deleteByNotebook", note: "笔记本的笔记未删除" },
  );
  if (removed !== null) return;
    reportWriteNotAccepted("note.deleteByNotebook", "笔记未按笔记本删除");
    return;
}

function rowToNote(row: any[]): Note {
  let tags: string[] | undefined;
  const tagsJson = row[6] as string;
  if (tagsJson) {
    try { tags = JSON.parse(tagsJson); } catch { tags = undefined; }
  }
  return {
    id: row[0] as string,
    notebookId: row[1] as string,
    sourceId: row[2] as string || undefined,
    title: row[3] as string,
    content: row[4] as string || '',
    contentType: (row[5] as string || 'markdown') as NoteContentType,
    tags,
    pinOrder: row[7] as number || 0,
    createdAt: row[8] as number,
    updatedAt: row[9] as number,
  };
}

// ========== Note Links ==========

/**
 * 新增一条笔记链接。
 *
 * 第 84 波（A 类：静默空写）：原来 `INSERT OR IGNORE` 后无脑返回 void ——
 * 被唯一约束忽略（链接已存在）与"真的插进去了"完全无法区分，调用方却按"已创建"计数。
 *
 * @returns 是否真的插入了新行（false = 该链接已存在，本次没有新增）
 */
export function addNoteLink(sourceNoteId: string, targetNoteId: string, linkText?: string): boolean {
  const id = `link_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  // 迁移期：先在镜像里判断"这条链接是否已存在"，再决定写不写。
  //
  // **旧实现的返回值其实永远是 true**：`note_links` 表上**没有唯一约束**
  // （schema 里只有两个普通索引 idx_note_links_source / _target），
  // 所以 `INSERT OR IGNORE` 从来不会 IGNORE，`getRowsModified()` 也永远 > 0。
  // 已实测确认（同一对节点/链接连插两次都会落库）。
  // 这里保留"是否存在"的判断语义（调用方按它计数），并把重复写入真正挡掉。
  const existing = domainReadMany(T_LINKS, wireToNoteLink, {
    source_note_id: sourceNoteId,
    target_note_id: targetNoteId,
  });
  /**
   * **端口已注册就必须由端口接手**（第 42 轮修正的读写分裂）。
   *
   * `domainReadMany` 在**镜像未加载完**时返回 `undefined`（设计如此：未加载完不路由），
   * 而下面原来直接回退旧库 —— 于是出现本进程内的读写分裂：
   *
   * - 写：落到旧库（`note_links` 那一行只存在于旧库）；
   * - 读/删：稍后镜像加载完成，`getNoteLinks` / `deleteNoteLinksBySource` 都走镜像 →
   *   **刚写的链接读不到，也删不掉**（删除按 source 在镜像里找不到旧行）。
   *
   * 真机对应的形态：保存带 `[[WikiLink]]` 的笔记后反向链接面板是空的；
   * 重复保存时旧链接残留（`note-links-order.test.ts` 的 NL-2 抓到的就是它）。
   *
   * 修法：端口在 → **等镜像就绪后再写**（一次性回调，不轮询）；端口不在 → 才回退旧库。
   * 这与消息路径（`message.ts` 的 `onSessionMessagesReady`）是同一套做法。
   */
  const portReady = domainPortRegistered();
  if (portReady) {
    const writeViaPort = () => {
      const again = domainReadMany(T_LINKS, wireToNoteLink, {
        source_note_id: sourceNoteId,
        target_note_id: targetNoteId,
      });
      if (again && again.length > 0) return; // 期间已被写入：不重复
      domainWrite(
        T_LINKS,
        [{
          id,
          source_note_id: sourceNoteId,
          target_note_id: targetNoteId,
          link_text: linkText ?? null,
          created_at: now,
        }],
        { scope: "noteLink.add", note: "笔记链接未保存" },
      );
    };
    if (existing) {
      if (existing.length > 0) return false; // 已存在：本次没有新增
      writeViaPort();
      return true;
    }
    // 镜像未就绪：注册一次"就绪后写入"，并如实告知调用方"本次尚未落地"
    domainEnsureLoaded(T_LINKS, writeViaPort);
    return false;
  }

    reportWriteNotAccepted("noteLink.add", "笔记链接未保存");
    return false;
}

export function getNoteLinks(noteId: string): NoteLink[] {
  const rust = domainReadMany(T_LINKS, wireToNoteLink);
  if (rust) {
    return rust.filter((l) => l.sourceNoteId === noteId || l.targetNoteId === noteId);
  }
    return [];
}

export function getBacklinks(noteId: string): NoteLink[] {
  const rust = domainReadMany(T_LINKS, wireToNoteLink, { target_note_id: noteId });
  if (rust) return rust;
    return [];
}

function rowToNoteLink(row: any[]): NoteLink {
  return {
    id: row[0] as string,
    sourceNoteId: row[1] as string,
    targetNoteId: row[2] as string,
    linkText: row[3] as string || undefined,
    createdAt: row[4] as number,
  };
}

// ========== 知识图谱 CRUD ==========
// 借鉴思路来源: Understand-Anything — 使用图谱存储实体关系
// 我们自研实现: SQLite 存储节点和边, 不依赖外部图谱数据库

function generateNodeId(): string {
  return `node_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateEdgeId(): string {
  return `edge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function addGraphNode(
  notebookId: string,
  label: string,
  entityType: EntityType,
  description?: string,
  sourceIds: string[] = [],
  chunkIds: string[] = [],
  weight: number = 1.0,
): GraphNode {
  const id = generateNodeId();
  const now = Date.now();
  const created: GraphNode = {
    id,
    notebookId,
    label,
    entityType,
    description,
    sourceIds,
    chunkIds,
    weight,
    createdAt: now,
  };
  if (domainWrite(T_NODES, [nodeToWire(created)], { scope: "graph.addNode", note: "图谱节点未保存" })) {
    return created;
  }
    reportWriteNotAccepted("graph.addNode", "图谱节点未保存");
    return created;
}

export function getGraphData(notebookId: string): GraphData {
  const rustNodes = domainReadMany(T_NODES, wireToNode, { notebook_id: notebookId });
  if (rustNodes) {
    const rustEdges = domainReadMany(T_EDGES, wireToEdge, { notebook_id: notebookId }) ?? [];
    // 旧 SQL：nodes 按 weight DESC，edges 无 ORDER BY
    return { nodes: rustNodes.sort((a, b) => b.weight - a.weight), edges: rustEdges };
  }
    return { nodes: [], edges: [] };
}

export function addGraphEdge(
  notebookId: string,
  sourceNodeId: string,
  targetNodeId: string,
  relationType: RelationType = 'related',
  weight: number = 1.0,
): GraphEdge | null {
  const id = generateEdgeId();
  const now = Date.now();
  const edge: GraphEdge = { id, notebookId, sourceNodeId, targetNodeId, relationType, weight, createdAt: now };

  // 迁移期：先在镜像里查"同一条边是否已存在"。
  //
  // **注意**：`graph_edges` 表上**没有唯一约束**（只有普通索引），
  // 所以旧实现的 `INSERT OR IGNORE` 永远不会 IGNORE —— 同一条边可以重复落库
  // （已实测：同一对节点连写两次，counts 返回 2）。
  // 这里保留旧实现的返回语义（总是返回构造出的 edge），但把重复写入挡掉，
  // 顺带让原来那个"永远不触发"的 catch→null 分支重新有意义。
  const existing = domainReadMany(T_EDGES, wireToEdge, {
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    relation_type: relationType,
  });
  if (existing) {
    if (existing.length > 0) return existing[0];
    const written = domainWrite(T_EDGES, [edgeToWire(edge)], { scope: "graph.addEdge", note: "图谱边未保存" });
    return written ? edge : null;
  }

    reportWriteNotAccepted("graph.addEdge", "图谱边未保存");
    return null;
}

export function deleteGraphData(notebookId: string): void {
  const removedEdges = domainDeleteWhere(
    T_EDGES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "graph.deleteEdges", note: "图谱边未删除" },
  );
  const removedNodes = domainDeleteWhere(
    T_NODES,
    (row) => row.notebook_id === notebookId,
    "id",
    { scope: "graph.deleteNodes", note: "图谱节点未删除" },
  );
  if (removedEdges !== null && removedNodes !== null) return;
    reportWriteNotAccepted("graph.deleteData", "图谱数据未删除");
    return;
}

export function updateNodeCommunity(nodeId: string, communityId: number): void {
  const current = domainReadOne(T_NODES, { id: nodeId }, wireToNode);
  if (current !== undefined) {
    if (current === null) return; // 节点不存在：旧实现是 UPDATE 影响 0 行
    domainWrite(T_NODES, [nodeToWire({ ...current, communityId })], {
      mode: "replace",
      scope: "graph.updateCommunity",
      note: "节点社区未更新",
    });
    return;
  }
    reportWriteNotAccepted("graph.updateCommunity", "节点社区未更新");
    return;
}

/**
 * 查找或创建节点（按 label 匹配）。
 *
 * ## 归一处理（原实现有一处**返回值与落库不一致**）
 *
 * 旧实现在命中已有节点时：
 * - 先把 `weight` 加 1，再把**合并后的** source/chunk ids 写回库；
 * - 但**返回值**却是 `sourceIds: sourceId ? [sourceId] : []`、`weight: 2` —— 也就是
 *   "只有这一个 id、权重恒为 2"的字面量，而不是真实落库的值。
 *
 * 镜像路径如果照抄这个字面量，调用方拿到的节点就会与库里不一致（而且这个不一致
 * 会一路传下去）。这里改为**返回真实状态**：合并后的 ids 与真实的 weight。
 * 这是行为修正，不是行为变更 —— 落库内容与旧实现完全一致。
 */
export function findOrCreateNode(
  notebookId: string,
  label: string,
  entityType: EntityType,
  description?: string,
  sourceId?: string,
  chunkId?: string,
): GraphNode {
  const rust = domainReadMany(T_NODES, (r) => r, { notebook_id: notebookId, label });
  if (rust) {
    if (rust.length > 0) {
      const row = rust[0];
      const existing = wireToNode(row);
      const sourceIds = [...existing.sourceIds];
      const chunkIds = [...existing.chunkIds];
      if (sourceId && !sourceIds.includes(sourceId)) sourceIds.push(sourceId);
      if (chunkId && !chunkIds.includes(chunkId)) chunkIds.push(chunkId);
      const bumped: GraphNode = { ...existing, weight: existing.weight + 1, sourceIds, chunkIds };
      domainWrite(T_NODES, [nodeToWire(bumped)], {
        mode: "replace",
        scope: "graph.findOrCreateNode",
        note: "节点权重/引用未更新",
      });
      return bumped;
    }
    return addGraphNode(notebookId, label, entityType, description, sourceId ? [sourceId] : [], chunkId ? [chunkId] : []);
  }

    reportWriteNotAccepted("graph.findOrCreateNode", "节点未创建");
    return addGraphNode(notebookId, label, entityType, description, sourceId ? [sourceId] : [], chunkId ? [chunkId] : []);
}

// ========== Notebook Group CRUD (A14) ==========

function generateGroupId(): string {
  return `grp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createGroup(input: CreateGroupInput): NotebookGroup {
  const now = Date.now();
  const id = generateGroupId();
  const created: NotebookGroup = {
    id,
    name: input.name,
    parentId: input.parentId,
    sortOrder: 0,
    createdAt: now,
  };
  if (domainWrite(T_GROUPS, [groupToWire(created)], { scope: "group.create", note: "分组未保存" })) {
    return created;
  }
    reportWriteNotAccepted("group.create", "笔记本分组未保存");
    return created;
}

export function listGroups(parentId?: string | null): NotebookGroup[] {
  const rust = domainReadMany(T_GROUPS, wireToGroup);
  if (rust) {
    const filtered = parentId === undefined
      ? rust
      : rust.filter((g) => (parentId === null ? g.parentId === undefined : g.parentId === parentId));
    // 旧 SQL：ORDER BY sort_order ASC, name ASC
    return filtered.sort((a, b) => (a.sortOrder - b.sortOrder) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
    return [];
}

/**
 * 更新笔记本分组。
 *
 * ## 任务 C-9：`parentId` 无法被**置空**（`null` 被当成"未提供"）
 *
 * 原签名是 `Pick<NotebookGroup, 'name' | 'parentId' | 'sortOrder'>`，
 * 判据是 `update.parentId !== undefined`。而 UI 想把一个子分组移出父分组时
 * 传的是 `parentId: null`（"显式置空"是这类树形结构的自然写法）——
 * `null !== undefined` 成立，于是它**进得了** fields…
 * 但紧接着 `...(update.parentId !== undefined ? { parentId: update.parentId ?? undefined } : {})`
 * 里那个 `?? undefined` 又把 `null` 抹成了 `undefined`，最后 `groupToWire` 写回 `parent_id: null`
 * —— 这一条"绕了一圈又恰好写对"。
 *
 * 真正坏掉的是**类型**：`Pick<...>` 的 `parentId` 是 `string | undefined`，
 * 传 `null` 在 TS 下是**类型错误**，调用方只能 `as any` 或干脆不传 ——
 * 也就是说"移出分组"这条路在类型层面就是堵死的（这也是为什么
 * `grep updateGroup` 在生产代码里 0 个调用点：接不上）。
 *
 * 现在把 `null` 与 `undefined` **显式分开**，并在签名里如实表达：
 * - `undefined` = 未提供（不动这一列）；
 * - `null` = **显式置空**（把分组移出父分组，写 `parent_id = NULL`）。
 *
 * `sortOrder` 没有"空值"语义，保持原样。
 */
export function updateGroup(
  id: string,
  update: {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
  },
): void {
  const fields: string[] = [];
  if (update.name !== undefined) fields.push('name');
  if (update.parentId !== undefined) fields.push('parent_id');
  if (update.sortOrder !== undefined) fields.push('sort_order');

  if (fields.length === 0) {
      // 第 86 波：空更新原来静默返回 —— 调用方以为"更新成功"，实际没有任何写入
      console.warn(`[storage.ts] updateGroup 调用未提供任何可更新字段 —— 本次没有任何写入`);
      return;
    }

  const current = domainReadOne(T_GROUPS, { id }, wireToGroup);
  if (current !== undefined) {
    if (current === null) return; // 分组不存在：旧实现是 UPDATE 影响 0 行
    const next: NotebookGroup = {
      ...current,
      ...(update.name !== undefined ? { name: update.name } : {}),
      /*
       * ⚠️ 这里**不能**写 `update.parentId ?? undefined`：那正是把"显式置空"重新
       * 变成"未提供"的地方（两者都落到 `undefined`，而 `undefined` 在
       * `groupToWire` 里恰好也写成 null —— 于是"对"得毫无保障，换个序列化就错）。
       * 直接透传 `null`，让 wire 层的 `?? null` 做唯一一次归一。
       */
      ...(update.parentId !== undefined ? { parentId: update.parentId ?? undefined } : {}),
      ...(update.sortOrder !== undefined ? { sortOrder: update.sortOrder } : {}),
    };
    domainWrite(T_GROUPS, [groupToWire(next)], {
      mode: "replace",
      scope: "group.update",
      note: "分组未更新（分组不存在或写入失败）",
    });
    return;
  }

    reportWriteNotAccepted("group.update", "笔记本分组未更新");
    return;
}

export function deleteGroup(id: string): void {
  // 先把该分组下的笔记本移到"未分组"（旧实现是 `UPDATE notebooks SET group_id = NULL WHERE group_id = ?`），
  // 再删分组。两步都必须走域端口：只删旧库的话，下一次整体写回会把 group_id 又写回去。
  const moved = domainReadMany(T_NOTEBOOKS, wireToNotebook);
  let handled = false;
  if (moved) {
    const inGroup = moved.filter((nb) => nb.groupId === id);
    if (inGroup.length > 0) {
      domainWrite(T_NOTEBOOKS, inGroup.map((nb) => notebookToWire({ ...nb, groupId: undefined })), {
        mode: "replace",
        scope: "group.ungroup",
        note: "分组下的笔记本未移到未分组",
      });
    }
    handled = domainDelete(T_GROUPS, { id }, { scope: "group.delete", note: "分组未删除" });
  }
  if (handled) return;

    reportWriteNotAccepted("group.delete", "笔记本分组未删除");
    return;
}

function rowToGroup(row: any[]): NotebookGroup {
  return {
    id: row[0] as string,
    name: row[1] as string,
    parentId: row[2] as string || undefined,
    sortOrder: row[3] as number,
    createdAt: row[4] as number,
  };
}

// ========== Note Version History (A17) ==========

function generateVersionId(): string {
  return `ver_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 保存一条笔记版本。
 *
 * ## 任务 C-8：`if (!note) return;` 原来是**静默丢弃**
 *
 * 读笔记走 `getNote()`，而它在端口没接手（B 态：镜像未就绪）时返回 `null`。
 * 原实现把"读不到"与"这条笔记不存在"合并成同一个 `return` ——
 * 于是**自动版本历史会静默断档**：用户在编辑笔记，每次保存都该留一版，
 * 而库里一条版本都没有，界面上也没有任何提示。
 *
 * 现在两态分开：
 * - 端口在但镜像未接手 → 可重试失败，如实上报（`noteVersion.save`）；
 * - 笔记确实不存在 → 业务失败（旧实现也是不写，但要**说清**为什么）。
 */
export function saveNoteVersion(noteId: string, versionNote?: string): void {
  const note = getNote(noteId);
  if (!note) {
    reportPersistFailure(
      "noteVersion.save",
      new Error(
        domainPortRegistered()
          ? "端口已注册但 notes 镜像未接手（未就绪 / 未镜像）"
          : `notes 里没有 id=${noteId}`,
      ),
      domainPortRegistered()
        ? `笔记 ${noteId} 的版本未保存 —— 本次读不到该笔记（**不是**"笔记不存在"），稍后会再试`
        : `笔记 ${noteId} 的版本未保存：该笔记不存在（可能已被删除）`,
    );
    return;
  }

  const id = generateVersionId();
  const now = Date.now();
  const created: NoteVersion = {
    id,
    noteId,
    title: note.title,
    content: note.content,
    tags: note.tags,
    versionNote,
    createdAt: now,
  };
  if (domainWrite(T_VERSIONS, [versionToWire(created)], { scope: "noteVersion.save", note: "笔记版本未保存" })) {
    return;
  }
    reportWriteNotAccepted("noteVersion.save", "笔记版本未保存");
    return;
}

export function listNoteVersions(noteId: string): NoteVersion[] {
  const rust = domainReadMany(T_VERSIONS, wireToVersion, { note_id: noteId });
  if (rust) return rust.sort((a, b) => b.createdAt - a.createdAt);
    return [];
}

export function getNoteVersion(versionId: string): NoteVersion | null {
  const rust = domainReadOne(T_VERSIONS, { id: versionId }, wireToVersion);
  if (rust !== undefined) return rust;
    return null;
}

/**
 * 把笔记恢复到某个历史版本。
 *
 * ## 任务 C-8：`if (!version) return;` 原来是静默丢弃
 *
 * 与 `saveNoteVersion` 同一个形状、同一个错误：`getNoteVersion` 在镜像未接手时返回
 * `null`，原实现直接 `return` —— 用户点"恢复此版本"，界面没反应、库里没任何变化、
 * 日志里也没有一行。现在把"未就绪"与"版本不存在"分开如实上报。
 */
export function restoreNoteVersion(versionId: string): void {
  const version = getNoteVersion(versionId);
  if (!version) {
    reportPersistFailure(
      "noteVersion.restore",
      new Error(
        domainPortRegistered()
          ? "端口已注册但 note_versions 镜像未接手（未就绪 / 未镜像）"
          : `note_versions 里没有 id=${versionId}`,
      ),
      domainPortRegistered()
        ? `恢复未执行：本次读不到版本 ${versionId}（**不是**"该版本不存在"），稍后会再试`
        : `恢复未执行：版本 ${versionId} 不存在（可能已被清理）`,
    );
    return;
  }

  // Save current state as a new version before restoring
  saveNoteVersion(version.noteId, 'Auto-saved before restore');

  // Restore the note to the version's content
  let tags: string[] | undefined;
  if (version.tags) {
    try { tags = JSON.parse(version.tags as any); } catch { tags = undefined; }
  }
  updateNote(version.noteId, {
    title: version.title,
    content: version.content,
    tags,
  });
}

export function deleteNoteVersion(versionId: string): void {
  if (domainDelete(T_VERSIONS, { id: versionId }, { scope: "noteVersion.delete", note: "笔记版本未删除" })) return;
    reportWriteNotAccepted("noteVersion.delete", "笔记版本未删除");
    return;
}

function rowToVersion(row: any[]): NoteVersion {
  let tags: string[] | undefined;
  const tagsJson = row[4] as string;
  if (tagsJson) {
    try { tags = JSON.parse(tagsJson); } catch { tags = undefined; }
  }
  return {
    id: row[0] as string,
    noteId: row[1] as string,
    title: row[2] as string,
    content: row[3] as string,
    tags,
    versionNote: row[5] as string || undefined,
    createdAt: row[6] as number,
  };
}

// ========== Graph Node/Edge Edit (C3) ==========

export function updateGraphNode(
  nodeId: string,
  update: Partial<Pick<GraphNode, 'label' | 'entityType' | 'description'>>,
): void {
  const current = domainReadOne(T_NODES, { id: nodeId }, wireToNode);
  if (current !== undefined) {
    if (current === null) return; // 节点不存在：旧实现是 UPDATE 影响 0 行
    const next: GraphNode = {
      ...current,
      ...(update.label !== undefined ? { label: update.label } : {}),
      ...(update.entityType !== undefined ? { entityType: update.entityType } : {}),
      ...(update.description !== undefined ? { description: update.description ?? undefined } : {}),
    };
    domainWrite(T_NODES, [nodeToWire(next)], {
      mode: "replace",
      scope: "graph.updateNode",
      note: "图谱节点未更新（节点不存在或写入失败）",
    });
    return;
  }

    reportWriteNotAccepted("graph.updateNode", "图谱节点未更新");
    return;
}

export function deleteGraphNode(nodeId: string): void {
  // 旧实现是两条 DELETE：先删所有与该节点相连的边，再删节点本身。
  const removedEdges = domainDeleteWhere(
    T_EDGES,
    (row) => row.source_node_id === nodeId || row.target_node_id === nodeId,
    "id",
    { scope: "graph.deleteNodeEdges", note: "节点相连的边未删除" },
  );
  const removedNode = domainDelete(T_NODES, { id: nodeId }, { scope: "graph.deleteNode", note: "节点未删除" });
  if (removedEdges !== null && removedNode) return;
    reportWriteNotAccepted("graph.deleteNode", "图谱节点未删除");
    return;
}

export function deleteGraphEdge(edgeId: string): void {
  if (domainDelete(T_EDGES, { id: edgeId }, { scope: "graph.deleteEdge", note: "图谱边未删除" })) return;
    reportWriteNotAccepted("graph.deleteEdge", "图谱边未删除");
    return;
}

export function getGraphEdgeById(edgeId: string): GraphEdge | null {
  const rust = domainReadOne(T_EDGES, { id: edgeId }, wireToEdge);
  if (rust !== undefined) return rust;
    return null;
}