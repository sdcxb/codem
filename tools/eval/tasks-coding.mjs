/**
 * 第二档任务集 —— **专测「写代码 / 改 bug / 调试」**，也就是用户真正关心的那件事。
 *
 * ## 为什么要有第二档
 *
 * 第一档（`tasks.mjs`）实测被 **DSH 14/14 全过**，评测器自己标了 `control-saturated` ——
 * **那一档测不出编码水平**，只能测链路与成本。这一档是为此重做的，刻意让**根因与症状不在同一处**、
 * **修一个要动多处**、**有误导性线索**，这样才可能真正区分两种 harness 的编码能力。
 *
 * ## 难度是怎么设计出来的（每一类都对应一种真实的"agent 会栽"的方式）
 *
 * | 任务 | 栽点 |
 * |---|---|
 * | `hard-01-default-in-other-file` | 失败的测试名指向 A 文件，**根因在 B 文件**；A 里还有一个看着很像的 off-by-one 诱饵 |
 * | `hard-02-lost-wakeup` | 异步队列的经典**丢唤醒**：先入队后起消费就丢；要靠事件顺序推 |
 * | `hard-03-stale-memo` | 缓存键看似正确，但**输入被就地改过**；修在调用方会过、修在被调方才对 |
 * | `hard-04-one-cause-three-failures` | 三个不同文件各挂一条测试，**同一个根因**；逐个修会互相打脸 |
 * | `hard-05-cross-file-signature` | 改签名要**动四处调用点**，四种调用形态各不一样 |
 * | `hard-06-map-limit-order` | 并发上限 + **保序** + **首个错误传播**，三个约束一起满足 |
 * | `hard-07-parse-nested` | 解析器要支持**两层嵌套的引号**，只处理一层会过一半用例 |
 * | `hard-08-debug-from-log` | 只给一份**日志**和一段会误报的错误信息，要自己定位到真正的越界 |
 *
 * ## 与第一档共享的纪律
 *
 * 形状完全一样（`id/category/title/prompt/files/grade/reference`），所以 `run-arm.mjs`、桩臂、
 * 成对评测器**原样可用**；`validateTaskSet()` 的覆盖检查同样适用。
 * 判据一律是行为判据（退出码），没有一条是"源码里有没有某个词"。
 */

export const TASKS = [
  // ---------------------------------------------------------------------------
  {
    id: "hard-01-default-in-other-file",
    category: "改小 bug",
    title: "失败的测试指向 A，根因在 B（还有一个诱饵）",
    prompt:
      "`node --test` 是红的。**注意：报错来自 `src/retry-fetch.js`，但真正的问题不一定在那里。** 先自己跑一遍、读代码定位根因再改。改完让 `node --test` 全绿，不要改 `test/` 下的文件。",
    files: {
      "src/retry-fetch.js": `import { DEFAULTS } from "./config.js";

/**
 * 带重试的取数。
 *
 * ⚠️ 这里看起来像一个 off-by-one：attempt < maxAttempts 让「最多 3 次」实际只跑 3 次。
 * 但那不是本次失败的原因 —— 先确认 maxAttempts 到底是多少。
 */
export async function fetchWithRetry(load, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await load(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
      "src/config.js": `/**
 * 全局默认值。
 *
 * TODO(运维): 当年为了压测把 maxAttempts 设成 1，之后忘了改回来。
 */
export const DEFAULTS = {
  maxAttempts: 1,
  timeoutMs: 5000,
};
`,
      "test/retry-fetch.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/retry-fetch.js";

test("默认应当重试 3 次（即最多调用 3 次）", async () => {
  let calls = 0;
  await assert.rejects(() =>
    fetchWithRetry(async () => {
      calls++;
      throw new Error("always fails");
    }),
  );
  assert.equal(calls, 3, "默认重试次数应为 3，实际调用了 " + calls + " 次");
});

test("显式传入时以传入为准", async () => {
  let calls = 0;
  await assert.rejects(() =>
    fetchWithRetry(async () => {
      calls++;
      throw new Error("nope");
    }, { maxAttempts: 5 }),
  );
  assert.equal(calls, 5);
});

test("成功时立即返回，不再重试", async () => {
  let calls = 0;
  const out = await fetchWithRetry(async (attempt) => {
    calls++;
    if (attempt === 1) return "ok";
    throw new Error("fail");
  });
  assert.equal(out, "ok");
  assert.equal(calls, 2);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/config.js": `export const DEFAULTS = {
  maxAttempts: 3,
  timeoutMs: 5000,
};
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-02-lost-wakeup",
    category: "改小 bug",
    title: "异步队列的丢唤醒（先入队就丢）",
    prompt:
      "`node --test` 是红的。这是一个经典的**丢唤醒**问题：在某些调用顺序下，已经入队的元素永远不会被取走。请修好它（不许改 `test/`），让 `node --test` 全绿。",
    files: {
      "src/queue.js": `/**
 * 一个极简的异步队列。
 *
 * ⚠️ 注意 take() 的等待方式：它只在**当时**有数据时立即返回，
 * 否则挂一个 resolver 等下一次 push。想想"先 push 再 take"和"先 take 再 push"两种顺序。
 */
export function createQueue() {
  const items = [];
  let waiting = null;
  return {
    push(item) {
      items.push(item);
    },
    take() {
      if (items.length > 0) return Promise.resolve(items.shift());
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    size() {
      return items.length;
    },
    _resolveWaiting(v) {
      if (waiting) {
        const r = waiting;
        waiting = null;
        r(v);
      }
    },
  };
}
`,
      "test/queue.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../src/queue.js";

/**
 * ⚠️ 每个 take 都必须**有界**。
 * 第一版第三个用例直接 \`await consumer\` —— 在丢唤醒的实现下它永远不返回，
 * 于是判据命令超时、任务被记成 **errored** 而不是 **failed**（"没跑起来" ≠ "跑了没做对"）。
 * 自证当场把它标出来了。所以这里统一用有界的 take。
 */
const TIMEOUT = "__timeout__";
const takeBounded = (q, ms = 300) =>
  Promise.race([q.take(), new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), ms))]);

test("先 push 再 take：立刻拿到", async () => {
  const q = createQueue();
  q.push(1);
  assert.equal(await takeBounded(q), 1);
});

test("先 take 再 push：等待者应当被 push 唤醒", async () => {
  const q = createQueue();
  const pending = q.take();
  q.push(42);
  const value = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 300))]);
  assert.equal(value, 42, "等待者没有被 push 唤醒（丢唤醒）");
});

test("交替 push/take 不应丢元素", async () => {
  const q = createQueue();
  const results = [];
  const consumer = (async () => {
    for (let i = 0; i < 3; i++) results.push(await takeBounded(q));
  })();
  for (let i = 0; i < 3; i++) {
    q.push(i);
    await new Promise((r) => setTimeout(r, 1));
  }
  await consumer;
  assert.deepEqual(results, [0, 1, 2]);
  assert.ok(!results.includes(TIMEOUT), "有 take 超时未返回 —— 元素被丢了");
});
`,
    },
    grade: "node --test",
    reference: {
      "src/queue.js": `/**
 * 修法：把「已经躺在 items 里但没人来取」这件事在唤醒时补上 ——
 * _resolveWaiting 之前先把队列里的元素交给等待者。
 *
 * 也就是说：**等待者被唤醒时，必须先看队列里有没有货，而不是依赖调用方把值传进来。**
 */
export function createQueue() {
  const items = [];
  let waiting = null;
  const flush = () => {
    if (waiting && items.length > 0) {
      const r = waiting;
      waiting = null;
      r(items.shift());
    }
  };
  return {
    push(item) {
      items.push(item);
      flush();
    },
    take() {
      if (items.length > 0) return Promise.resolve(items.shift());
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    size() {
      return items.length;
    },
    _resolveWaiting() {
      flush();
    },
  };
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-03-stale-memo",
    category: "改小 bug",
    title: "缓存键看似正确，但输入被就地改过",
    prompt:
      "`node --test` 是红的：缓存会返回**过期**结果。请修好（不许改 `test/`），让 `node --test` 全绿。想清楚该修在调用方还是被调方。",
    files: {
      "src/memo.js": `/**
 * 按 JSON 形状做键的记忆化。
 *
 * 看起来没问题：JSON.stringify(args) 就是「参数的内容」。
 * 但参数是**可变对象** —— 调用方改完再调用时，内容变了、键也变了，这一层其实是对的。
 * 真正的问题是**第一次调用之后调用方把对象改了**，而缓存里存的那份与外面那份**是同一个引用**。
 */
export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const value = fn(...args);
    cache.set(key, value);
    return value;
  };
}
`,
      "test/memo.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { memoize } from "../src/memo.js";

test("相同入参只算一次", () => {
  let calls = 0;
  const f = memoize((o) => {
    calls++;
    return o.value * 2;
  });
  assert.equal(f({ value: 2 }), 4);
  assert.equal(f({ value: 2 }), 4);
  assert.equal(calls, 1);
});

test("返回的对象不能被外部改动影响缓存", () => {
  const f = memoize((o) => ({ doubled: o.value * 2 }));
  const first = f({ value: 3 });
  assert.deepEqual(first, { doubled: 6 });
  // 外部把拿到的那份改了
  first.doubled = 999;
  const second = f({ value: 3 });
  assert.deepEqual(second, { doubled: 6 }, "缓存被外部改动污染了");
});

test("缓存里存的对象不能被后续外部改动污染", () => {
  const f = memoize((o) => ({ v: o.value }));
  const a = f({ value: 1 });
  a.v = 100;
  assert.deepEqual(f({ value: 1 }), { v: 1 });
});
`,
    },
    grade: "node --test",
    reference: {
      "src/memo.js": `/**
 * 修法：**进出都隔离** ——
 * · 出：把算出来的对象**深拷贝**再存进缓存（缓存里那份与给外面那份不是同一个引用）；
 * · 返回：每次返回**再拷一份**（外面改它不影响缓存）。
 *
 * 两个方向都要做：只做一边仍然会有一条用例红。
 */
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return clone(cache.get(key));
    }
    const value = fn(...args);
    cache.set(key, clone(value));
    return clone(value);
  };
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-04-one-cause-three-failures",
    category: "改小 bug",
    title: "三处失败、一个根因（逐个修会互相打脸）",
    prompt:
      "`node --test` 有三条失败，分别在三个不同文件里。它们是**同一个根因**。请找到那个根因并修它（不许改 `test/`），让 `node --test` 全绿。",
    files: {
      "src/round.js": `/**
 * 金额取整到分。
 *
 * BUG：toFixed(2) 返回的是**字符串**，而且它按「四舍五入」（实际是浮点近似）处理，
 * 对 0.005 这类中间值给出的是 0.01 还是 0.00 取决于二进制表示 —— 三个调用方各自踩到了不同的表现。
 */
export function roundToCents(amount) {
  return Number((amount).toFixed(2));
}
`,
      "src/invoice.js": `import { roundToCents } from "./round.js";

export function lineTotal(unitPrice, quantity) {
  return roundToCents(unitPrice * quantity);
}
`,
      "src/tax.js": `import { roundToCents } from "./round.js";

export function withTax(subtotal, rate) {
  return roundToCents(subtotal * (1 + rate));
}
`,
      "src/split.js": `import { roundToCents } from "./round.js";

export function splitEvenly(total, parts) {
  return roundToCents(total / parts);
}
`,
      "test/round.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { roundToCents } from "../src/round.js";

test("半分值向偶数取整（银行家舍入）", () => {
  // 0.005 -> 0.00，0.015 -> 0.02（半到偶）
  assert.equal(roundToCents(0.005), 0);
  assert.equal(roundToCents(0.015), 0.02);
});

test("普通值正常", () => {
  assert.equal(roundToCents(1.234), 1.23);
  assert.equal(roundToCents(1.235), 1.24);
});

test("结果是数字而不是字符串", () => {
  assert.equal(typeof roundToCents(2.5), "number");
  assert.ok(Number.isInteger(roundToCents(2.5) * 100), "必须落在整分上");
});
`,
      "test/callers.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { lineTotal } from "../src/invoice.js";
import { withTax } from "../src/tax.js";
import { splitEvenly } from "../src/split.js";

test("发票行合计落在整分上", () => {
  assert.equal(lineTotal(0.1, 3), 0.3);
  assert.ok(Number.isInteger(lineTotal(19.99, 7) * 100));
});

test("含税金额落在整分上", () => {
  assert.ok(Number.isInteger(withTax(0.07, 0.13) * 100));
});

test("均分金额落在整分上", () => {
  assert.ok(Number.isInteger(splitEvenly(10, 3) * 100));
});
`,
    },
    grade: "node --test",
    reference: {
      "src/round.js": `/**
 * 修法：**在整数分上算，最后再除回去** —— 避免二进制浮点在中途产生 0.30000000000000004 这类值。
 * 一条根因修好，三个调用方一起变绿。
 */
export function roundToCents(amount) {
  if (!Number.isFinite(amount)) throw new Error("amount must be finite");
  const cents = amount * 100;
  const rounded = Math.round(cents);
  // 半到偶：正好落在 .5 上时取偶
  const adjusted = Math.abs(cents % 1) === 0.5 ? (rounded % 2 === 0 ? rounded : rounded - Math.sign(cents)) : rounded;
  return adjusted / 100;
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-05-cross-file-signature",
    category: "多文件改动",
    title: "改签名要动四处，四种调用形态",
    prompt:
      "`renderList` 现在需要支持一个可选的 `{ separator }` 选项，默认是换行。请改 `src/render.js` 的签名，并更新**所有**调用点（`src/page.js`、`src/report.js`、`src/email.js`、`src/cli.js`），让 `node --test` 全绿。**不要改 `test/`。**",
    files: {
      "src/render.js": `export function renderList(items) {
  return items.join("\\n");
}
`,
      "src/page.js": `import { renderList } from "./render.js";

export function page(items) {
  return "<ul>" + renderList(items) + "</ul>";
}
`,
      "src/report.js": `import { renderList } from "./render.js";

export function report(items, compact) {
  const body = renderList(items);
  return compact ? body.replace(/\\n/g, " ") : body;
}
`,
      "src/email.js": `import { renderList } from "./render.js";

export function email(items) {
  return renderList([...items, "— sent by Codem"]);
}
`,
      "src/cli.js": `import { renderList } from "./render.js";

export function cli(items) {
  const lines = renderList(items).split("\\n");
  return lines.length;
}
`,
      "test/render.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { renderList } from "../src/render.js";
import { page } from "../src/page.js";
import { report } from "../src/report.js";
import { email } from "../src/email.js";
import { cli } from "../src/cli.js";

test("默认分隔符是换行", () => {
  assert.equal(renderList(["a", "b"]), "a\\nb");
});

test("可以传自定义分隔符", () => {
  assert.equal(renderList(["a", "b"], { separator: ", " }), "a, b");
});

test("四个调用点都还工作", () => {
  assert.equal(page(["a", "b"]), "<ul>a\\nb</ul>");
  assert.equal(report(["a", "b"], true), "a b");
  assert.equal(email(["a"]), "a\\n— sent by Codem");
  assert.equal(cli(["a", "b", "c"]), 3);
});

test("自定义分隔符要能穿透调用点", () => {
  assert.equal(report(["a", "b"], true, { separator: " | " }), "a | b");
});
`,
    },
    grade: "node --test",
    reference: {
      "src/render.js": `export function renderList(items, options = {}) {
  const separator = options.separator ?? "\\n";
  return items.join(separator);
}
`,
      "src/page.js": `import { renderList } from "./render.js";

export function page(items, options) {
  return "<ul>" + renderList(items, options) + "</ul>";
}
`,
      "src/report.js": `import { renderList } from "./render.js";

export function report(items, compact, options) {
  const body = renderList(items, options);
  return compact ? body.replace(/\\n/g, " ") : body;
}
`,
      "src/email.js": `import { renderList } from "./render.js";

export function email(items, options) {
  return renderList([...items, "— sent by Codem"], options);
}
`,
      "src/cli.js": `import { renderList } from "./render.js";

export function cli(items, options) {
  const lines = renderList(items, options).split("\\n");
  return lines.length;
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-06-map-limit-order",
    category: "加功能",
    title: "并发上限 + 保序 + 首个错误传播（三个约束一起）",
    prompt:
      "在 `src/map-limit.js` 里实现并导出 `mapLimit(items, limit, fn)`：① 同时进行的 `fn` 数量**永不超过** `limit`；② 返回值顺序与输入**一致**（不是完成顺序）；③ 任一 `fn` 抛错时，整体以一个错误 reject（不要继续起新的）。让 `node --test` 全绿。",
    files: {
      "src/map-limit.js": `export async function mapLimit(items, limit, fn) {
  throw new Error("not implemented");
}
`,
      "test/map-limit.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/map-limit.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("顺序与输入一致（即便完成顺序不同）", async () => {
  const out = await mapLimit([30, 10, 20], 3, async (ms) => {
    await sleep(ms);
    return ms;
  });
  assert.deepEqual(out, [30, 10, 20]);
});

test("并发数永不超过 limit", async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([1, 1, 1, 1, 1, 1], 2, async (v) => {
    live++;
    peak = Math.max(peak, live);
    await sleep(5);
    live--;
    return v;
  });
  assert.deepEqual(out, [1, 1, 1, 1, 1, 1]);
  assert.ok(peak <= 2, "并发峰值 " + peak + " 超过了 limit=2");
});

test("出错时整体 reject", async () => {
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async (v) => {
      if (v === 2) throw new Error("boom");
      return v;
    }),
    /boom/,
  );
});

test("空数组与 limit 大于长度", async () => {
  assert.deepEqual(await mapLimit([], 3, async (v) => v), []);
  assert.deepEqual(await mapLimit([1, 2], 10, async (v) => v * 2), [2, 4]);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/map-limit.js": `export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;

  const worker = async () => {
    while (true) {
      if (firstError) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        return;
      }
    }
  };

  const workers = [];
  const width = Math.min(limit, items.length);
  for (let i = 0; i < width; i++) workers.push(worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-07-parse-nested",
    category: "加功能",
    title: "解析器要支持两层嵌套（只做一层会过一半）",
    prompt:
      "在 `src/template.js` 里实现并导出 `renderTemplate(text, vars)`：把 `{{name}}` 替换成 `vars.name`；`{{#if x}}...{{/if}}` 在 `x` 为真时保留内部、为假时整段去掉；**两种结构可以嵌套一层**（`{{#if}}` 里再出现 `{{var}}`，以及 if 里再套 if）。缺失的变量替换成空串。让 `node --test` 全绿。",
    files: {
      "src/template.js": `export function renderTemplate(text, vars) {
  throw new Error("not implemented");
}
`,
      "test/template.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "../src/template.js";

test("变量替换", () => {
  assert.equal(renderTemplate("你好 {{name}}", { name: "世界" }), "你好 世界");
});

test("缺失变量变空串", () => {
  assert.equal(renderTemplate("[{{nope}}]", {}), "[]");
});

test("if 真值保留、假值整段去掉", () => {
  assert.equal(renderTemplate("a{{#if x}}B{{/if}}c", { x: true }), "aBc");
  assert.equal(renderTemplate("a{{#if x}}B{{/if}}c", { x: false }), "ac");
});

test("if 里面套变量", () => {
  assert.equal(renderTemplate("{{#if x}}hi {{name}}{{/if}}", { x: true, name: "q" }), "hi q");
});

test("if 里面再套 if（两层）", () => {
  assert.equal(
    renderTemplate("{{#if a}}A{{#if b}}B{{/if}}{{/if}}", { a: true, b: true }),
    "AB",
  );
  assert.equal(
    renderTemplate("{{#if a}}A{{#if b}}B{{/if}}{{/if}}", { a: true, b: false }),
    "A",
  );
  assert.equal(
    renderTemplate("{{#if a}}A{{#if b}}B{{/if}}{{/if}}", { a: false, b: true }),
    "",
  );
});
`,
    },
    grade: "node --test",
    reference: {
      "src/template.js": `function evalIfBlocks(text, vars, startIndex = 0, stopAtClose = false) {
  let out = "";
  let i = startIndex;
  while (i < text.length) {
    if (stopAtClose && text.startsWith("{{/if}}", i)) {
      return { text: out, next: i + "{{/if}}".length };
    }
    if (text.startsWith("{{#if ", i)) {
      const end = text.indexOf("}}", i);
      const name = text.slice(i + "{{#if ".length, end).trim();
      const inner = evalIfBlocks(text, vars, end + 2, true);
      if (vars[name]) out += inner.text;
      i = inner.next;
      continue;
    }
    if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i);
      const name = text.slice(i + 2, end).trim();
      const value = vars[name];
      out += value === undefined || value === null ? "" : String(value);
      i = end + 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return { text: out, next: i };
}

export function renderTemplate(text, vars) {
  return evalIfBlocks(String(text), vars ?? {}).text;
}
`,
    },
  },

  // ---------------------------------------------------------------------------
  {
    id: "hard-08-debug-from-log",
    category: "跑测试",
    title: "只有一份日志和一段会误报的错误信息",
    prompt:
      "`node --test` 是红的，而且报出来的错误信息会**误导**你。先跑一次、读 `logs/run.log`、再读代码，定位**真正的**越界点并修好（不许改 `test/` 和 `logs/`），让 `node --test` 全绿。",
    files: {
      "logs/run.log": `[12:00:01] pipeline start items=4
[12:00:01] stage=parse index=0 ok
[12:00:01] stage=parse index=1 ok
[12:00:01] stage=parse index=2 ok
[12:00:01] stage=parse index=3 ok
[12:00:01] stage=aggregate windowSize=3
[12:00:01] ERROR in window loop: reading index 3 of window buffer (len 3)
[12:00:01] hint: parse stage looked fine; check the aggregator's bound
`,
      "src/aggregate.js": `/**
 * 按窗口聚合。
 *
 * ⚠️ 第一版这里写成 \`i + windowSize <= items.length\`，那其实是**对的** ——
 * 于是三个用例全过、任务变成"什么都不做也能过"（在测空气）。自证当场把它标红了。
 * 现在故意留一个真实的 off-by-one：循环上界写成 \`i < items.length - windowSize\`，
 * **最后一个窗口会被整段丢掉**。
 *
 * logs/run.log 里那句越界记录是**早于这次改动**的旧日志，会把人往"越界"上带，
 * 真正要看的是"为什么少了最后一个窗口"。
 */
export function aggregate(items, windowSize) {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error("windowSize must be >= 1");
  const out = [];
  for (let i = 0; i < items.length - windowSize; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += items[i + j];
    }
    out.push(sum);
  }
  return out;
}
`,
      "src/pipeline.js": `import { aggregate } from "./aggregate.js";

export function pipeline(raw, windowSize) {
  const parsed = raw.map((v) => Number(v));
  return aggregate(parsed, windowSize);
}
`,
      "test/pipeline.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { pipeline } from "../src/pipeline.js";
import { aggregate } from "../src/aggregate.js";

test("日志里的那条输入：4 个元素、窗口 3，应当得到 2 个窗口", () => {
  assert.deepEqual(pipeline(["1", "2", "3", "4"], 3), [6, 9]);
});

test("窗口大于长度返回空", () => {
  assert.deepEqual(aggregate([1, 2], 5), []);
});

test("非法窗口要报错", () => {
  assert.throws(() => aggregate([1], 0));
});

test("常规情况", () => {
  assert.deepEqual(aggregate([1, 2, 3, 4, 5], 2), [3, 5, 7, 9]);
});
`,
    },
    grade: "node --test",
    reference: {
      "src/aggregate.js": `/**
 * 修法：循环上界必须保证**窗口完全落在数组内**；
 * 这里真正的问题是内层循环用了 i + j 但外层允许 i + windowSize === items.length 的下一轮，
 * 于是滑动到最后一格时内层读到了 length。改成显式算出最后一个合法起点。
 */
export function aggregate(items, windowSize) {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error("windowSize must be >= 1");
  const out = [];
  const lastStart = items.length - windowSize;
  for (let i = 0; i <= lastStart; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const value = items[i + j];
      if (value === undefined) throw new Error("window ran past the end of the array");
      sum += value;
    }
    out.push(sum);
  }
  return out;
}
`,
    },
  },
];

/** 覆盖口径（与第一档同一套） */
export const CATEGORIES = [
  "读代码",
  "改小 bug",
  "加功能",
  "重构",
  "跑测试",
  "多文件改动",
];

/**
 * 这一档**刻意不求覆盖全六个口径** —— 它的目标是"能区分编码水平"，不是"口径齐全"。
 * 所以校验只查字段完整、id 唯一、有参考解、以及**至少覆盖 4 类**。
 */
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
  if (covered.size < 4) problems.push(`只覆盖了 ${covered.size} 个口径，至少要 4 个`);
  return problems;
}
