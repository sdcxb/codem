/**
 * 通用 `protocol_selection_id` 派生（阶段 R3）。
 *
 * 这是它们**通用**的方案（`protocol.py:126-133`）：
 *
 *     raw = f"1:{runtime}:{catalog_type}:{canonical_json(identity)}"
 *     digest = base64url(sha256(raw)).rstrip("=")
 *     return f"sel_{catalog_type}_{digest[:24]}"
 *
 * 其中 `canonical_json` = Python 的
 * `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`。
 *
 * ⚠️ **`dsh` 这个运行时不用它** —— DSH 那一支用 `dsh:model:` / `dsh:permission:`
 * （见 `dsh-selection-id.ts`）。这里实现它是为了：
 * 1. 其他运行时（claude / codex）走这条；
 * 2. 有一处**独立实现**能对照，从而把"我们用对了方案"变成可判定的
 *    （R3-9 就是拿两者互不相等来钉的）。
 */

const enc = (s: string) => new TextEncoder().encode(s);

/** 规范 JSON：键**递归排序**、紧凑分隔符、非 ASCII 原样输出。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

/** base64url（无填充）。 */
function base64urlNoPad(bytes: Uint8Array): string {
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += T[(n >> 18) & 63] + T[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += T[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += T[n & 63];
  }
  return out;
}

/**
 * SHA-256（纯同步实现）。
 *
 * 为什么不用 `crypto.subtle`：它是**异步**的，而 selectionId 的派生要能在
 * **纯函数、同步**的上下文里用（目录构造、判据比对都希望是同步的）。
 * 这里实现的是标准 FIPS 180-4 SHA-256，用公开测试向量钉住（见判据 R3-8）。
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  // padding：0x80 + 0×k，使 (len + 1 + k) % 64 == 56，再接 8 字节大端位长
  const withPad = new Uint8Array((((len + 9) + 63) & ~63));
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLenHi);
  dv.setUint32(withPad.length - 4, bitLenLo);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

/**
 * `protocol_selection_id(runtime, catalog_type, identity)` —— 与 `protocol.py:126-133` 一致。
 *
 * `identity` 会被规范 JSON 化后再进 sha256，所以**键序无关但内容敏感**。
 */
export function protocolSelectionId(
  runtime: string,
  catalogType: string,
  identity: unknown,
): string {
  const raw = `1:${runtime}:${catalogType}:${canonicalJson(identity)}`;
  const digest = base64urlNoPad(sha256(enc(raw)));
  return `sel_${catalogType}_${digest.slice(0, 24)}`;
}
