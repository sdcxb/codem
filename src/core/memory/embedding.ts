/**
 * 可选 embedding 的**重排支撑**（24 §P2「记忆摘要/索引缓存」之外的「可选向量/混合检索」）。
 *
 * ## 三条边界（缺一条就会变成"默认联网"或"持久化向量"）
 *
 * 1. **默认 null**：没有注入 embedder 时这里是零副作用的纯函数模块 —— 检索侧根本不会调用
 *    （`getMemoryEmbedder()` 返回 null ⇒ 走原来的纯词法路径、`backend` 也不变）；
 * 2. **向量不落盘**：缓存只是进程内的 `Map`，进程退出即失效。向量不是事实数据，落盘会带来
 *    「模型换了 / 维度变了 / 条目改了但旧向量还在」的一致性债 —— 本轮明确不做向量持久化；
 * 3. **可注入**：宿主 / 手机桥 / 测试只实现 `embed()`，检索侧只认 `id` / `dimensions` /
 *    `embed()` 三个字段，不关心背后是进程内模型、远程 API 还是假实现。
 *
 * ## 缓存键为什么是 `embedder.id + 文本 sha256`
 *
 * - 只按文本 hash：同一个 embedder 下"同一段文本"必然得到同一个向量（确定性假设，
 *   与向量模型的实际约定一致）；
 * - 必须带 `id`：换了实现（或同一实现的另一个版本）时**不许复用旧向量** —— 两个不同模型
 *   的向量空间不可比，混用会让余弦分变成噪声；
 * - 不用文本原文做键：记忆正文可达 10,000 字符，500 条原文留在内存里没有意义。
 */

/** 可注入的 embedding 实现（检索侧唯一依赖的接口面） */
export interface MemoryEmbedder {
  /** 实现标识（缓存键的一部分；换实现必须换 id，否则会复用旧向量） */
  id: string;
  /** 向量维度（返回形状校验的唯一依据） */
  dimensions: number;
  /** 批量取向量：返回顺序与入参一一对应，长度必须相等 */
  embed(texts: string[]): Promise<number[][]>;
}

/** 进程内当前 embedder（`null` = 纯词法，默认就是它） */
let activeEmbedder: MemoryEmbedder | null = null;

/**
 * 注入 / 撤销 embedder。
 *
 * 任何一次变更都**清空向量缓存**：同一个 `id` 换了实现（例如模型热更新）时，
 * 旧向量与新的向量空间不可比，复用就是静默的错误排序。代价只是一次冷启动。
 */
export function setMemoryEmbedder(embedder: MemoryEmbedder | null): void {
  activeEmbedder = embedder;
  embeddingCache.clear();
}

/** 当前 embedder（`null` ⇒ 检索侧走纯词法，不做任何额外调用） */
export function getMemoryEmbedder(): MemoryEmbedder | null {
  return activeEmbedder;
}

/** 向量缓存上限（按"文本条目"计，LRU 淘汰） */
const EMBEDDING_CACHE_MAX = 500;

/** 进程内向量缓存：`embedder.id + ":" + sha256(文本)` → 向量（不持久化） */
const embeddingCache = new Map<string, number[]>();

/**
 * 混合检索的**语义权重**（加在归一化词法分之上）。
 *
 * 取 0.6 而不是 0.5 的理由：
 * - 词法分归一化到 [0,1] 后，一次实体词（key）命中就是 1.0 —— 精确命中仍然压得住语义分；
 * - 而"正文里只出现过一次"这种弱命中只有 0.1，**允许语义近似条目压过它**是本功能的目的
 *   （否则"词不同但意思一样"的条目永远排在弱命中之后，等于没做混合检索）；
 * - 连续型权重便于以后按真机效果微调，但必须是**一个常量**（不引入第二套打分模型）。
 */
export const MEMORY_HYBRID_WEIGHT = 0.6;

/**
 * 词法分归一化的**参考满分**：`search()` 里一次 `key` 命中就 +10。
 *
 * 为什么不用"本轮候选里的最大值"做 min-max：那会把"本轮最强的那条"恒等于 1.0，
 * 于是**一条弱命中也能拿满分**，语义分永远翻不了身（最小候选集里只有一条弱命中时尤其明显）。
 * 用固定参考值 ⇒ 弱命中就是弱分，跨查询也可比。
 */
export const MEMORY_HYBRID_LEXICAL_REF = 10;

/**
 * 余弦相似度（`-1..1`）。
 *
 * 维度不一致 / 含非法值 ⇒ 返回 `NaN`（调用方按"这一条没有语义信号"处理，绝不当 0 分之外的
 * 任何东西 —— 悄悄当成 0 会把"算不出来"伪装成"不相关"）。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 批量取向量（带进程内 LRU 缓存）。
 *
 * 行为契约：
 * - 命中的文本**不重复调用** `embed()`；未命中的**去重后一次批量**取回（同一段文本在候选池里
 *   出现两次也不会取两遍）；
 * - 返回顺序与 `texts` 严格一一对应；
 * - 形状不符（条数 / 维度 / 非有限数）⇒ **抛错**。调用方（混合检索）捕获后回退纯词法，
 *   不把"embedder 坏了"演成"没有相关记忆"。
 */
export async function embedTexts(
  embedder: MemoryEmbedder,
  texts: readonly string[],
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const out: Array<number[] | undefined> = new Array(texts.length);
  /** 未命中的文本：key → 原文 + 它出现的全部下标（同文本只取一次向量） */
  const pending = new Map<string, { text: string; indices: number[] }>();

  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] ?? "");
    const key = `${embedder.id}:${sha256Hex(text)}`;
    const cached = embeddingCache.get(key);
    if (cached) {
      // LRU：命中后移到队尾（Map 的插入序就是淘汰序）
      embeddingCache.delete(key);
      embeddingCache.set(key, cached);
      out[i] = cached;
      continue;
    }
    const slot = pending.get(key);
    if (slot) slot.indices.push(i);
    else pending.set(key, { text, indices: [i] });
  }

  if (pending.size > 0) {
    const keys = [...pending.keys()];
    const vectors = await embedder.embed(keys.map((k) => pending.get(k)!.text));
    if (!Array.isArray(vectors) || vectors.length !== keys.length) {
      throw new Error(
        `embedder「${embedder.id}」返回 ${Array.isArray(vectors) ? vectors.length : "非数组"} 条向量，期望 ${keys.length} 条`,
      );
    }
    for (let j = 0; j < keys.length; j++) {
      const vector = vectors[j];
      if (
        !Array.isArray(vector) ||
        vector.length !== embedder.dimensions ||
        !vector.every((n) => Number.isFinite(n))
      ) {
        throw new Error(
          `embedder「${embedder.id}」返回的向量形状不符（期望 ${embedder.dimensions} 维有限数）`,
        );
      }
      const key = keys[j];
      embeddingCache.set(key, vector);
      for (const index of pending.get(key)!.indices) out[index] = vector;
    }
    // LRU：超上限时淘汰最旧的条目
    while (embeddingCache.size > EMBEDDING_CACHE_MAX) {
      const oldest = embeddingCache.keys().next().value;
      if (oldest === undefined) break;
      embeddingCache.delete(oldest);
    }
  }

  return out as number[][];
}

// ========== SHA-256（同步、无平台依赖） ==========

/**
 * 纯 TS 的 SHA-256（十六进制小写）。
 *
 * 为什么不用 `node:crypto` / `crypto.subtle`：
 * - 渲染侧的 `node:crypto` 是 Vite 的**桩**（`src/stubs/node-crypto-stub.ts` 用 FNV-1a 顶替，
 *   不是真 SHA-256）；
 * - `crypto.subtle.digest` 是异步的，而缓存查找要在一次 `embedTexts` 里同步完成，且部分
 *   WebView 源（非安全上下文）没有 `subtle`。
 * 这里只需要"内容指纹"（不是安全哈希），但既然注释写了 sha256 就必须是**真的** sha256 ——
 * 已用空串 / `"abc"` 两个标准向量手工核对过。
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * 导出给**索引缓存**复用（`memory-index.ts` 的正文指纹 / payload 哈希）。
 *
 * 为什么复用同一份而不是各写一份：两处都是"内容指纹"，一旦算法不同，
 * "缓存命中"与"向量缓存命中"会对同一段正文给出不同的 key —— 那是两台机器上跑同一份数据
 * 却得到不同结果的经典来源。这里只做一件事，实现只有一处。
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // 补位：0x80 + 若干 0x00 + 8 字节大端长度，总长必须是 64 的整数倍
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}
