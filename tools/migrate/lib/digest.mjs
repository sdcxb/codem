/**
 * 与 Rust 侧 `codem-db/src/migrate.rs::value_bytes` **逐字节一致**的摘要实现。
 *
 * ## 为什么两边必须自己算、而不是比"导出的 JSON 字符串"
 *
 * 对账要在**两个引擎各自眼里**算出同一个值，才能真正证明"数据搬对了"。
 * 如果先各自导出成 JSON 再比字符串，那么差异可能来自序列化层而不是数据本身
 * （键顺序、数字格式、转义差异），对账结论就不可信了。
 *
 * ## 规则（改这里必须同时改 Rust）
 *
 * - 值先加**类型标签**（`N`/`I`/`R`/`T`/`B`），避免 `1` 与 `"1"`、`1` 与 `1.0` 撞摘要；
 * - 文本按 UTF-8 原样，不做转义；
 * - 数字用十进制文本（浮点去掉无意义的 `.0`）；
 * - 每列后加 `0x1f`、每行后加 `0x1e`（否则 `("ab","c")` 与 `("a","bc")` 会撞）；
 * - 哈希是 64 位 FNV-1a，结果输出为 16 位小写十六进制。
 *
 * ⚠️ 本文件是**纯 JS**（`.mjs`），不要写 TS 类型注解 —— 它由 `node` 直接执行，
 * 没有转译步骤（早先写过一次带注解的版本，node 直接语法报错）。
 */

// 与 Rust 的 i64 基准值一致（-0x7a5b2a3d1c4f9e11）
const OFFSET_BASIS = -0x7a5b2a3d1c4f9e11n;
const PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** 把 i64 语义的哈希转成与 Rust `{:016x}` 相同的字符串 */
function toHex(big) {
  const unsigned = big < 0n ? big + (1n << 64n) : big;
  return unsigned.toString(16).padStart(16, "0");
}

class Digest {
  constructor() {
    this.h = OFFSET_BASIS;
    this.encoder = new TextEncoder();
  }

  byte(b) {
    // Rust 侧是 i64 的 wrapping_mul：这里先按 64 位无符号算，再折回 i64 语义
    this.h = (this.h ^ BigInt(b)) & MASK64;
    this.h = (this.h * PRIME) & MASK64;
    if (this.h > (1n << 63n) - 1n) this.h -= 1n << 64n;
  }

  text(s) {
    const bytes = this.encoder.encode(s);
    for (const b of bytes) this.byte(b);
  }

  /** 一个值（与 Rust `value_bytes` 对应） */
  value(v) {
    if (v === null || v === undefined) {
      this.byte(0x4e); // 'N'
      return;
    }
    if (typeof v === "number") {
      // 整数值一律按 'I' 编码：sql.js 不区分 INTEGER 与"整数值的 REAL"，
      // `Number.isInteger(0)` 对 `cost REAL` 里的 0 也为真。Rust 侧有同样的规则
      // （见 migrate.rs 的 value_bytes），两边必须一致 —— 否则行数一致、逐行一致，
      // 但摘要对不上，会被误判成"数据搬错了"。
      if (Number.isInteger(v)) {
        this.byte(0x49); // 'I'
        this.text(String(v));
      } else {
        this.byte(0x52); // 'R'
        this.text(normalizeFloat(v));
      }
      return;
    }
    if (typeof v === "bigint") {
      this.byte(0x49);
      this.text(v.toString());
      return;
    }
    if (typeof v === "string") {
      this.byte(0x54); // 'T'
      this.text(v);
      return;
    }
    if (v instanceof Uint8Array) {
      this.byte(0x42); // 'B'
      let hex = "";
      for (const b of v) hex += b.toString(16).padStart(2, "0");
      this.text(hex);
      return;
    }
    // 兜底：按文本处理（Rust 侧不会出现这种情况）
    this.byte(0x54);
    this.text(String(v));
  }

  columnSeparator() {
    this.byte(0x1f);
  }

  rowSeparator() {
    this.byte(0x1e);
  }

  hex() {
    return toHex(this.h);
  }
}

/**
 * 浮点归一：整数型浮点已经走 'I' 分支；其余用最短往返表示。
 *
 * JS 的 `String(n)` 与 Rust 的 `{}`（Display for f64）都是"最短且能往返"的表示，
 * 因此 `0.55` 两边都是 `"0.55"`。这也是选 FNV-1a + 十进制文本的原因：
 * 两边都不需要额外的浮点格式化实现。
 */
function normalizeFloat(n) {
  if (Number.isFinite(n)) return String(n);
  if (Number.isNaN(n)) return "nan";
  return n > 0 ? "inf" : "-inf";
}

/**
 * 对一组行算摘要。
 *
 * ⚠️ 两端必须用**相同的列顺序**（`SELECT *` 在两端都按 CREATE TABLE 的列序返回），
 * 所以调用方不要自己重排列。
 */
export function digestRows(rows) {
  const d = new Digest();
  for (const row of rows) {
    for (const v of row) {
      d.value(v);
      d.columnSeparator();
    }
    d.rowSeparator();
  }
  return { rows: rows.length, digest: d.hex() };
}

/**
 * 摘要算法自检。
 *
 * 这些断言不是"测试的意义上的测试"，而是**迁移工具启动时的前置检查**：
 * 如果摘要算法本身坏了（例如类型标签失效），对账会"全都通过"而数据其实是错的 ——
 * 那种失败比不对账更危险。
 */
export function digestSelfCheck() {
  if (digestRows([[1, "a"]]).digest !== digestRows([[1, "a"]]).digest) {
    throw new Error("摘要不稳定：同样输入算出不同结果");
  }
  if (digestRows([[1, "a"]]).digest === digestRows([[1, "b"]]).digest) {
    throw new Error("摘要区分不出内容差异");
  }
  if (digestRows([[1]]).digest === digestRows([["1"]]).digest) {
    throw new Error('类型标签失效：整数 1 与文本 "1" 撞了摘要');
  }
  if (digestRows([["ab", "c"]]).digest === digestRows([["a", "bc"]]).digest) {
    throw new Error("列分隔符失效：列边界不同却撞了摘要");
  }
  if (digestRows([["a"], ["b"]]).digest === digestRows([["a", "b"]]).digest) {
    throw new Error("行分隔符失效：行边界不同却撞了摘要");
  }
  if (digestRows([[null]]).digest === digestRows([[""]]).digest) {
    throw new Error("NULL 与空串撞了摘要");
  }
}
