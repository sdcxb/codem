/**
 * 冻结的任务集 —— 「同模型、水平与 token 消耗不差于 DSH」这把尺子的**被测对象**。
 *
 * ## 为什么是文件而不是脑子里的一句话
 *
 * 交接单 §6 任务 2 要求先把验收标准变成可测的（用户选了 A 案）。可测的第一步是
 * **冻结任务集**：不冻结就没法对比（"边测边改"得到的数字没有意义）。
 * 所以任务集是**数据**，写在这里，改动要走 diff。
 *
 * ## 每个任务的形状
 *
 *   id        稳定标识（进了报告就别再改）
 *   category  覆盖口径：读代码 / 改小 bug / 加功能 / 重构 / 跑测试 / 多文件改动
 *   title     一句话
 *   prompt    给 agent 的**原话**（真实用户会怎么问）
 *   files     工作区的初始文件（工作区是**全新临时目录**，与主仓库无关）
 *   grade     客观判据：在工作区里跑，**退出码 0 = 通过**
 *   reference 已知正确解（**只用于证明判据会区分对错** —— 见 pipeline.selftest.mjs）
 *
 * ## 刻意的设计取舍（写出来，不藏）
 *
 * 1. **这里全是自包含的小工程**，不是真实仓库的 PR。好处：可复现、无网络、判据确定；
 *    代价：它衡量的是**链路与成本**（plumbing + token），对"大仓库里定位问题"的能力覆盖弱。
 *    真实仓库那一档要单独加（见 §"还差什么"）。
 * 2. **判据一律是行为判据**（跑测试、比输出），没有一条是"源码里有没有某个词"。
 * 3. **重构类任务天然难客观判据**：这里只判"行为不变 + 要求的出口存在"，不判"真的没有重复代码"。
 *    这条限制必须写进结论里，不能拿重构类分数当强证据。
 */

export const TASKS = [
  // ---------------------------------------------------------------- 读代码
  {
    id: "read-01-which-functions-mutate",
    category: "读代码",
    title: "读代码判断哪些导出函数有副作用",
    prompt:
      "读 `src/a.js` 与 `src/b.js`（**不要修改它们**）。判断上面导出的四个函数里，哪些会**改动传入的对象或外部状态**（也就是有副作用）。" +
      "把答案写进 `ANSWER.md`，格式是**一行**：\n\nmutating=<函数名>,<函数名>\n\n" +
      "按字母序排列、逗号分隔、不带空格。没有的话就写 `mutating=`。",
    files: {
      "src/a.js": `export function sum(list) {
  let total = 0;
  for (const n of list) total += n;
  return total;
}

export function pushAll(target, items) {
  for (const item of items) target.push(item);
  return target.length;
}
`,
      "src/b.js": `export function toSortedCopy(list) {
  return [...list].sort((a, b) => a - b);
}

export function writeNote(fs, path, text) {
  fs.writeFileSync(path, String(text), "utf8");
  return text.length;
}
`,
      "verify-answer.mjs": `import { readFileSync } from "node:fs";
const EXPECTED = ["pushAll", "writeNote"];

let text = "";
try {
  text = readFileSync("ANSWER.md", "utf8");
} catch {
  console.error("找不到 ANSWER.md");
  process.exit(1);
}

const match = /^\\s*mutating\\s*=\\s*(.*)$/m.exec(text);
if (!match) {
  console.error("ANSWER.md 里找不到 mutating= 这一行");
  process.exit(1);
}

const got = match[1]
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .sort();

if (got.length !== EXPECTED.length || got.some((v, i) => v !== EXPECTED[i])) {
  console.error("答案不对：期望 " + JSON.stringify(EXPECTED) + "，实际 " + JSON.stringify(got));
  process.exit(1);
}
console.log("答案正确");
`,
    },
    grade: "node verify-answer.mjs",
    reference: {
      "ANSWER.md": "mutating=pushAll,writeNote\n",
    },
  },

  // ---------------------------------------------------------------- 改小 bug
  {
    id: "bug-01-paginate-off-by-one",
    category: "改小 bug",
    title: "分页在整除时多出一页",
    prompt:
      "`src/paginate.js` 里的 pageCount 有问题：总数正好被每页条数整除时，它多算了一页（比如 total=20, size=10 应该 2 页，它给 3）。修掉它，并保证 `node --test` 全绿。",
    files: {
      "src/paginate.js": `export function pageCount(total, size) {
  if (size <= 0) throw new Error("size must be positive");
  return Math.floor(total / size) + 1;
}

export function pageSlice(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`,
      "test/paginate.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCount, pageSlice } from "../src/paginate.js";

test("整除时不多算一页", () => {
  assert.equal(pageCount(20, 10), 2);
  assert.equal(pageCount(0, 10), 0);
});

test("不整除时向上取整", () => {
  assert.equal(pageCount(21, 10), 3);
  assert.equal(pageCount(1, 10), 1);
});

test("无效 size 要报错", () => {
  assert.throws(() => pageCount(10, 0));
});

test("分片", () => {
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [3, 4]);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/paginate.js": `export function pageCount(total, size) {
  if (size <= 0) throw new Error("size must be positive");
  if (total <= 0) return 0;
  return Math.ceil(total / size);
}

export function pageSlice(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
`,
    },
  },
  {
    id: "bug-02-debounce-drops-trailing",
    category: "改小 bug",
    title: "debounce 丢掉最后一次调用",
    prompt:
      "`src/debounce.js` 的实现丢掉了尾调用：连续触发后，最后一次调用没有被执行。修好它，保证 `node --test` 全绿。",
    files: {
      "src/debounce.js": `export function debounce(fn, waitMs) {
  let timer = null;
  return function debounced(...args) {
    // BUG：等待期内再次触发就直接丢掉，没有顺延 —— 最后一次调用永远不会执行。
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, waitMs);
  };
}
`,
      "test/debounce.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { debounce } from "../src/debounce.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("连续调用只执行一次，且参数是最后一次的", async () => {
  const seen = [];
  const fn = debounce((v) => seen.push(v), 20);
  fn(1); fn(2); fn(3);
  await sleep(80);
  assert.deepEqual(seen, [3]);
});

test("间隔大于 wait 的两次调用都会执行", async () => {
  const seen = [];
  const fn = debounce((v) => seen.push(v), 20);
  fn(1);
  await sleep(60);
  fn(2);
  await sleep(60);
  assert.deepEqual(seen, [1, 2]);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/debounce.js": `export function debounce(fn, waitMs) {
  let timer = null;
  let pending = null;
  return function debounced(...args) {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const callArgs = pending;
      pending = null;
      fn.apply(this, callArgs);
    }, waitMs);
  };
}
`,
    },
  },
  {
    id: "bug-03-duration-missing-hour",
    category: "改小 bug",
    title: "时长解析不认识 h",
    prompt:
      "`src/duration.js` 的 parseDuration 只认 m 和 s，不认 h（`1h30m` 应该等于 5400 秒）。补上，并保证 `node --test` 全绿。",
    files: {
      "src/duration.js": `const UNIT_SECONDS = { m: 60, s: 1 };

export function parseDuration(text) {
  const re = /(\\d+)([a-z])/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    const unit = UNIT_SECONDS[m[2]];
    if (unit === undefined) throw new Error("unknown unit: " + m[2]);
    total += Number(m[1]) * unit;
    matched = true;
  }
  if (!matched) throw new Error("no duration found: " + text);
  return total;
}
`,
      "test/duration.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/duration.js";

test("分钟与秒", () => {
  assert.equal(parseDuration("2m30s"), 150);
});

test("小时", () => {
  assert.equal(parseDuration("1h"), 3600);
  assert.equal(parseDuration("1h30m"), 5400);
});

test("未知单位要报错", () => {
  assert.throws(() => parseDuration("5x"));
});
`,
    },
    grade: "node --test",
    reference: {
      "src/duration.js": `const UNIT_SECONDS = { h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  const re = /(\\d+)([a-z])/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    const unit = UNIT_SECONDS[m[2]];
    if (unit === undefined) throw new Error("unknown unit: " + m[2]);
    total += Number(m[1]) * unit;
    matched = true;
  }
  if (!matched) throw new Error("no duration found: " + text);
  return total;
}
`,
    },
  },
  {
    id: "bug-04-swallowed-rejection",
    category: "改小 bug",
    title: "错误被吞掉，调用方拿到 undefined",
    prompt:
      "`src/load.js` 在文件读不到时把错误吞了、返回 undefined，调用方分不清「没有数据」和「读失败」。让它在读失败时抛出，保证 `node --test` 全绿。",
    files: {
      "src/load.js": `export async function loadJson(readFile, path) {
  try {
    const text = await readFile(path);
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}
`,
      "test/load.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJson } from "../src/load.js";

test("正常解析", async () => {
  const data = await loadJson(async () => '{"a":1}', "x.json");
  assert.deepEqual(data, { a: 1 });
});

test("读失败必须抛出，而不是返回 undefined", async () => {
  await assert.rejects(() => loadJson(async () => { throw new Error("ENOENT"); }, "x.json"));
});

test("坏 JSON 也必须抛出", async () => {
  await assert.rejects(() => loadJson(async () => "not json", "x.json"));
});
`,
    },
    grade: "node --test",
    reference: {
      "src/load.js": `export async function loadJson(readFile, path) {
  const text = await readFile(path);
  return JSON.parse(text);
}
`,
    },
  },

  // ---------------------------------------------------------------- 加功能
  {
    id: "feat-01-chunk",
    category: "加功能",
    title: "实现 chunk(array, size)",
    prompt:
      "在 `src/chunk.js` 里实现并导出 `chunk(array, size)`：把数组按 size 切块，最后一块可以短。size <= 0 要抛错。让 `node --test` 全绿。",
    files: {
      "src/chunk.js": `export function chunk(array, size) {
  throw new Error("not implemented");
}
`,
      "test/chunk.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "../src/chunk.js";

test("等分", () => {
  assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("最后一块可以短", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("空数组", () => {
  assert.deepEqual(chunk([], 3), []);
});

test("size 必须为正", () => {
  assert.throws(() => chunk([1], 0));
  assert.throws(() => chunk([1], -1));
});
`,
    },
    grade: "node --test",
    reference: {
      "src/chunk.js": `export function chunk(array, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error("size must be a positive integer");
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}
`,
    },
  },
  {
    id: "feat-02-format-bytes",
    category: "加功能",
    title: "实现人类可读的字节数格式化",
    prompt:
      "在 `src/format-bytes.js` 里实现并导出 `formatBytes(n)`：按 1024 进制、保留 1 位小数、单位用 B/KiB/MiB/GiB，负数抛错。让 `node --test` 全绿。",
    files: {
      "src/format-bytes.js": `export function formatBytes(n) {
  throw new Error("not implemented");
}
`,
      "test/format-bytes.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes } from "../src/format-bytes.js";

test("小于 1024 用 B 且不带小数", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
});

test("1024 进制与一位小数", () => {
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MiB");
});

test("负数抛错", () => {
  assert.throws(() => formatBytes(-1));
});
`,
    },
    grade: "node --test",
    reference: {
      "src/format-bytes.js": `const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export function formatBytes(n) {
  if (typeof n !== "number" || Number.isNaN(n) || n < 0) throw new Error("n must be a non-negative number");
  if (n < 1024) return n + " B";
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(1) + " " + UNITS[unit];
}
`,
    },
  },
  {
    id: "feat-03-retry-backoff",
    category: "加功能",
    title: "实现带退避上限的重试",
    prompt:
      "在 `src/retry.js` 里实现并导出 `retry(fn, { attempts, baseDelayMs, maxDelayMs, sleep })`：失败重试，延迟按 baseDelayMs 指数增长但不超过 maxDelayMs；attempts 用尽后把最后一个错误抛出。sleep 由调用方注入（便于测试）。让 `node --test` 全绿。",
    files: {
      "src/retry.js": `export async function retry(fn, options) {
  throw new Error("not implemented");
}
`,
      "test/retry.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

function recorder() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

test("第一次就成功则不 sleep", async () => {
  const r = recorder();
  const out = await retry(async () => 42, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: r.sleep });
  assert.equal(out, 42);
  assert.deepEqual(r.delays, []);
});

test("失败后重试，延迟指数增长", async () => {
  const r = recorder();
  let n = 0;
  const out = await retry(async () => { n++; if (n < 3) throw new Error("boom"); return "ok"; },
    { attempts: 5, baseDelayMs: 10, maxDelayMs: 1000, sleep: r.sleep });
  assert.equal(out, "ok");
  assert.deepEqual(r.delays, [10, 20]);
});

test("延迟不超过上限", async () => {
  const r = recorder();
  let n = 0;
  await retry(async () => { n++; if (n < 6) throw new Error("x"); return 1; },
    { attempts: 10, baseDelayMs: 10, maxDelayMs: 30, sleep: r.sleep });
  assert.ok(r.delays.every((d) => d <= 30), JSON.stringify(r.delays));
});

test("用尽后抛出最后一个错误", async () => {
  const r = recorder();
  await assert.rejects(
    () => retry(async () => { throw new Error("final"); }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2, sleep: r.sleep }),
    /final/,
  );
});
`,
    },
    grade: "node --test",
    reference: {
      "src/retry.js": `export async function retry(fn, options) {
  const attempts = options?.attempts ?? 1;
  const baseDelayMs = options?.baseDelayMs ?? 0;
  const maxDelayMs = options?.maxDelayMs ?? Number.MAX_SAFE_INTEGER;
  const sleep = options?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer");

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}
`,
    },
  },
  {
    id: "feat-04-csv-quoted-commas",
    category: "加功能",
    title: "CSV 行解析要处理引号里的逗号",
    prompt:
      "在 `src/csv.js` 里实现并导出 `parseCsvLine(line)`：按逗号分列，但双引号包起来的字段里的逗号不算分隔符；`\"\"` 表示一个字面双引号。让 `node --test` 全绿。",
    files: {
      "src/csv.js": `export function parseCsvLine(line) {
  return String(line).split(",");
}
`,
      "test/csv.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../src/csv.js";

test("普通行", () => {
  assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
});

test("引号里的逗号不分列", () => {
  assert.deepEqual(parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"]);
});

test("转义的双引号", () => {
  assert.deepEqual(parseCsvLine('"he said ""hi""",x'), ['he said "hi"', "x"]);
});

test("空字段保留", () => {
  assert.deepEqual(parseCsvLine("a,,c"), ["a", "", "c"]);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/csv.js": `export function parseCsvLine(line) {
  const text = String(line);
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}
`,
    },
  },

  // ---------------------------------------------------------------- 多文件改动
  {
    id: "multi-01-rename-across-files",
    category: "多文件改动",
    title: "把 formatName 改名成 displayName 并更新所有调用点",
    prompt:
      "把 `src/format.js` 导出的 `formatName` 重命名为 `displayName`，并更新仓库里所有调用点（`src/user.js`、`src/report.js`、`test/*`）。旧的 `formatName` 不要再导出。让 `node --test` 全绿。",
    files: {
      "src/format.js": `export function formatName(user) {
  return user.first + " " + user.last;
}
`,
      "src/user.js": `import { formatName } from "./format.js";

export function greet(user) {
  return "Hello, " + formatName(user) + "!";
}
`,
      "src/report.js": `import { formatName } from "./format.js";

export function report(users) {
  return users.map((u) => formatName(u) + "\\n").join("");
}
`,
      "test/format.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import * as format from "../src/format.js";
import { greet } from "../src/user.js";
import { report } from "../src/report.js";

const alice = { first: "Alice", last: "L" };

test("displayName 存在，旧的 formatName 不再导出", () => {
  assert.equal(typeof format.displayName, "function");
  assert.equal(format.formatName, undefined);
});

test("displayName 行为不变", () => {
  assert.equal(format.displayName(alice), "Alice L");
});

test("调用点都跟着改了", () => {
  assert.equal(greet(alice), "Hello, Alice L!");
  assert.equal(report([alice]), "Alice L\\n");
});
`,
    },
    grade: "node --test",
    reference: {
      "src/format.js": `export function displayName(user) {
  return user.first + " " + user.last;
}
`,
      "src/user.js": `import { displayName } from "./format.js";

export function greet(user) {
  return "Hello, " + displayName(user) + "!";
}
`,
      "src/report.js": `import { displayName } from "./format.js";

export function report(users) {
  return users.map((u) => displayName(u) + "\\n").join("");
}
`,
    },
  },
  {
    id: "multi-02-add-field-end-to-end",
    category: "多文件改动",
    title: "新增字段要贯通「写入 → 序列化 → 读回」",
    prompt:
      "`notes` 这个字段现在只在内存里，落盘后被丢掉。让它贯通三个文件：`src/store.js`（保存）、`src/serialize.js`（序列化/反序列化）、`src/load.js`（读回）。让 `node --test` 全绿。",
    files: {
      "src/serialize.js": `export function toRecord(note) {
  return { id: note.id, title: note.title };
}

export function fromRecord(record) {
  return { id: record.id, title: record.title };
}
`,
      "src/store.js": `import { toRecord } from "./serialize.js";

export function createStore() {
  const saved = new Map();
  return {
    save(note) {
      saved.set(note.id, JSON.stringify(toRecord(note)));
    },
    dump() {
      return [...saved.values()];
    },
  };
}
`,
      "src/load.js": `import { fromRecord } from "./serialize.js";

export function loadAll(records) {
  return records.map((r) => fromRecord(JSON.parse(r)));
}
`,
      "test/roundtrip.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { loadAll } from "../src/load.js";

test("notes 字段要能原样往返", () => {
  const store = createStore();
  const note = { id: "n1", title: "T", notes: ["a", "b"] };
  store.save(note);
  const back = loadAll(store.dump());
  assert.deepEqual(back, [note]);
});

test("没有 notes 的旧记录也要能读", () => {
  const back = loadAll([JSON.stringify({ id: "n2", title: "old" })]);
  assert.equal(back[0].id, "n2");
  assert.equal(back[0].title, "old");
});
`,
    },
    grade: "node --test",
    reference: {
      "src/serialize.js": `export function toRecord(note) {
  const record = { id: note.id, title: note.title };
  if (note.notes !== undefined) record.notes = note.notes;
  return record;
}

export function fromRecord(record) {
  const note = { id: record.id, title: record.title };
  if (record.notes !== undefined) note.notes = record.notes;
  return note;
}
`,
    },
  },

  // ---------------------------------------------------------------- 跑测试
  {
    id: "test-01-make-failing-suite-pass",
    category: "跑测试",
    title: "让一个已经存在的失败测试套件变绿（不许改测试）",
    prompt:
      "`node --test` 现在是红的。让实现符合测试的期望 —— **不要修改 test/ 下的任何文件**。全绿即可。",
    files: {
      "src/text-window.js": `export function window(text, offset, limit) {
  return text.slice(offset, limit);
}
`,
      "test/text-window.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { window } from "../src/text-window.js";

test("limit 是长度，不是结束下标", () => {
  assert.equal(window("abcdef", 1, 3), "bcd");
});

test("offset 越界返回空串", () => {
  assert.equal(window("abc", 10, 5), "");
});

test("负数 offset 视作 0", () => {
  assert.equal(window("abc", -5, 2), "ab");
});
`,
    },
    grade: "node --test",
    reference: {
      "src/text-window.js": `export function window(text, offset, limit) {
  const start = Math.max(0, Number(offset) || 0);
  const count = Math.max(0, Number(limit) || 0);
  return text.slice(start, start + count);
}
`,
    },
  },
  {
    id: "test-02-unicode-codepoint-window",
    category: "跑测试",
    title: "按码点而不是 UTF-16 单元切窗口",
    prompt:
      "`node --test` 是红的：窗口切分把非 BMP 字符切坏了。让实现按**码点**处理（不许改 test/）。全绿即可。",
    files: {
      "src/codepoint-window.js": `export function head(text, count) {
  return text.slice(0, count);
}
`,
      "test/codepoint-window.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { head } from "../src/codepoint-window.js";

const withEmoji = "a😀b";

test("按码点取前 2 个", () => {
  assert.equal(head(withEmoji, 2), "a😀");
});

test("结果里不许出现孤立代理项", () => {
  const out = head(withEmoji, 2);
  assert.equal(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/.test(out), false);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/codepoint-window.js": `export function head(text, count) {
  return Array.from(text).slice(0, count).join("");
}
`,
    },
  },

  // ---------------------------------------------------------------- 重构
  {
    id: "refactor-01-extract-validation",
    category: "重构",
    title: "把重复的校验抽成一个函数",
    prompt:
      "`src/a.js` 与 `src/b.js` 里各抄了一份一模一样的校验逻辑。抽到 `src/validate.js` 并让两处都用它 —— 行为不许变。让 `node --test` 全绿。",
    files: {
      "src/a.js": `export function createUser(input) {
  if (!input || typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("name is required");
  }
  if (!Number.isInteger(input.age) || input.age < 0) {
    throw new Error("age must be a non-negative integer");
  }
  return { name: input.name.trim(), age: input.age };
}
`,
      "src/b.js": `export function updateUser(existing, input) {
  if (!input || typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("name is required");
  }
  if (!Number.isInteger(input.age) || input.age < 0) {
    throw new Error("age must be a non-negative integer");
  }
  return { ...existing, name: input.name.trim(), age: input.age };
}
`,
      "test/validate.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import * as validate from "../src/validate.js";
import { createUser } from "../src/a.js";
import { updateUser } from "../src/b.js";

test("共享校验函数存在", () => {
  assert.equal(typeof validate.validateUserInput, "function");
});

test("行为不变：两条路径都照旧报错", () => {
  assert.throws(() => createUser({ name: "", age: 1 }), /name is required/);
  assert.throws(() => createUser({ name: "x", age: -1 }), /non-negative integer/);
  assert.throws(() => updateUser({}, { name: "  ", age: 1 }), /name is required/);
});

test("行为不变：正常输入照旧通过", () => {
  assert.deepEqual(createUser({ name: " x ", age: 3 }), { name: "x", age: 3 });
  assert.deepEqual(updateUser({ id: 1 }, { name: "y", age: 4 }), { id: 1, name: "y", age: 4 });
});
`,
    },
    grade: "node --test",
    reference: {
      "src/validate.js": `export function validateUserInput(input) {
  if (!input || typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("name is required");
  }
  if (!Number.isInteger(input.age) || input.age < 0) {
    throw new Error("age must be a non-negative integer");
  }
  return { name: input.name.trim(), age: input.age };
}
`,
      "src/a.js": `import { validateUserInput } from "./validate.js";

export function createUser(input) {
  const clean = validateUserInput(input);
  return { name: clean.name, age: clean.age };
}
`,
      "src/b.js": `import { validateUserInput } from "./validate.js";

export function updateUser(existing, input) {
  const clean = validateUserInput(input);
  return { ...existing, name: clean.name, age: clean.age };
}
`,
    },
  },
];

/** 覆盖口径 → 任务数。用来确认任务集**确实覆盖了**承诺的六个类别。 */
export const CATEGORIES = [
  "读代码",
  "改小 bug",
  "加功能",
  "重构",
  "跑测试",
  "多文件改动",
];

export function validateTaskSet(tasks = TASKS) {
  const problems = [];
  const seen = new Set();
  for (const task of tasks) {
    for (const field of ["id", "category", "title", "prompt", "files", "grade", "reference"]) {
      if (task[field] === undefined) problems.push(`${task.id ?? "?"} 缺字段 ${field}`);
    }
    if (seen.has(task.id)) problems.push(`任务 id 重复：${task.id}`);
    seen.add(task.id);
    if (!CATEGORIES.includes(task.category)) problems.push(`${task.id} 的类别不认识：${task.category}`);
    if (!task.files || Object.keys(task.files).length === 0) problems.push(`${task.id} 没有初始文件`);
    if (!task.reference || Object.keys(task.reference).length === 0) {
      problems.push(`${task.id} 没有参考解（就没法证明判据会区分对错）`);
    }
  }
  const covered = new Set(tasks.map((t) => t.category));
  for (const category of CATEGORIES) {
    if (!covered.has(category)) problems.push(`类别「${category}」一个任务都没有 —— 覆盖口径不成立`);
  }
  return problems;
}
