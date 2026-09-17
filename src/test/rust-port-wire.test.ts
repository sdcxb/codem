/**
 * 跨语言线协议测试（P3，TS 侧一半）。
 *
 * ## 为什么需要"另一半"
 *
 * `rust-port.ts` 按字段名解包 Rust 的响应。如果 Rust 侧把 `has_more` 改成 `hasMore`，
 * 或者把 `wal_size_bytes` 删掉：
 * - Rust 的测试照样绿（它只断言自己序列化的东西）；
 * - TS 编译照样过（它读的是 `unknown`）；
 * - **运行时静默拿到 `undefined`** —— 分页少读数据、健康面板显示空白，没人报错。
 *
 * 所以这个文件读**真实 Rust 引擎生成的金样本**
 * （`src-tauri/codem-db/tests/wire-fixtures.json`，由 `wire_contract.rs` 写出并断言），
 * 用 `RustStoragePort` 真解包一遍，验证渲染侧拿到的语义正确。
 *
 * 样本过期时（Rust 侧改了形状但没重跑）这里会红 —— 这正是想要的效果：
 * **协议变更必须同时改两边**。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RustStoragePort, type MirrorMessageRow, type StorageTransport } from "../core/storage/rust-port";
import { StorageError } from "../core/storage/port";

const FIXTURES_PATH = path.join(__dirname, "..", "..", "src-tauri", "codem-db", "tests", "wire-fixtures.json");

const fixtures: Record<string, any> = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf8"));

/**
 * 镜像字段清单（**第二份**盘点，与 `rust-port.test.ts` 的 `WIRE_SAMPLE` 同构）。
 *
 * 为什么要两份：`WIRE_SAMPLE` 证明"TS 会把登记的字段搬进镜像"，
 * 但它用的是**手写的 wire 行** —— 手写行里当然有你刚加的那个字段。
 * 真实的断裂点是另一半：**Rust 那行里根本没有这个字段**（`MESSAGE_SELECT` 漏列、
 * 列投影写错、`message_row` 下标错位），此时 `normalize()` 会安静地填默认值。
 *
 * `trimmed` 就是活例子：它缺了会被填成 `0`，而 `hiddenIds()` 把 `trimmed ≠ 1`
 * 当成"被上下文压缩" → 被索引裁剪的历史整批消失（`trim-hidden-marker` 的 TRIM-4 守这条）。
 * 所以这里用**引擎真生成的金样本**再验一遍字段齐不齐。
 *
 * 类型写成 `Record<keyof MirrorMessageRow, true>`：谁往镜像加字段，`tsc` 会同时点名两处。
 */
const MIRROR_FIELDS: Record<keyof MirrorMessageRow, true> = {
  id: true,
  session_id: true,
  role: true,
  content: true,
  reasoning: true,
  timestamp: true,
  model: true,
  status: true,
  hidden: true,
  generated_files: true,
  trimmed: true,
};


/** 把金样本按命令喂给端口 */
function transportBackedByFixtures(map: Record<string, unknown>, health?: unknown): StorageTransport {
  return {
    invokeCommand: async (command: string) => {
      if (!(command in map)) throw new Error(`金样本里没有 ${command} 的响应（测试需要更新 fixture）`);
      return map[command] as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () =>
      (health ?? {
        ok: true,
        result: {
          ready: true,
          path: "C:/x.bin",
          size_bytes: 11137024,
          journal_mode: "wal",
          wal_size_bytes: 0,
          tables: 45,
          fts_module: "fts5",
          last_error_code: null,
        },
      }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true, detail: "ok" } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
}

describe("线协议 —— Rust 生成的金样本必须被 TS 端口正确解包", () => {
  it("WIRE-0: 金样本不能过期太久（太久说明没人重跑 Rust 侧，契约已经在漂）", () => {
    const at = fixtures._generatedAtMs;
    expect(typeof at, "金样本缺少 _generatedAtMs（重跑 wire_contract 生成）").toBe("number");
    const ageDays = (Date.now() - at) / 86_400_000;
    // 阈值 30 天：不是"精确性"要求，而是防止"改了 Rust 返回形状却从没重跑样本"这种静默漂移。
    // 真过期了就重跑：npm run db:test
    expect(
      ageDays,
      `金样本已 ${ageDays.toFixed(1)} 天未重生成；请运行 npm run db:test（会重写 wire-fixtures.json）`,
    ).toBeLessThan(30);
  });

  it("WIRE-1: 金样本存在且形状完整（防止「悄悄没生成」）", () => {
    expect(fixtures._comment).toBeTruthy();
    for (const key of ["write", "list", "single", "missing", "count", "error_not_found", "error_constraint", "error_unsupported", "error_bad_param"]) {
      expect(fixtures[key], `金样本缺少 ${key}`).toBeTruthy();
    }
  });

  it("WIRE-2: 分页读解包正确（字段名错位会在这里立刻暴露）", async () => {
    const port = new RustStoragePort(transportBackedByFixtures({ "messages.list": fixtures.list }));
    const page = await port.data.query<any>("messages.list", { session_id: "s1" }, { limit: 2 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(typeof page.hasMore).toBe("boolean");
    // 关键：hasMore 不能是 undefined（那会被 Boolean() 变成 false，导致漏读后续页）
    expect(page.hasMore).not.toBeUndefined();
    const first = page.items[0];
    expect(first.status).toBe("done");
    expect(first.session_id).toBe("s1");
    expect(typeof first.content).toBe("string");
  });

  it("WIRE-3: 单条命中与未命中", async () => {
    const port = new RustStoragePort(
      transportBackedByFixtures({ "messages.get": fixtures.single, "messages.missing": fixtures.missing }),
    );
    const hit = await port.data.query<any>("messages.get", { id: "m1" });
    expect(hit.items).toHaveLength(1);
    expect(hit.items[0].id).toBe("m1");

    const miss = await port.data.query<any>("messages.missing", { id: "nope" });
    expect(miss.items, "item:null 必须归一成空列表").toEqual([]);
  });

  it("WIRE-4: 计数三件套（total/visible/hidden）都要拿到", async () => {
    const port = new RustStoragePort(transportBackedByFixtures({ "messages.count": fixtures.count }));
    const r = await port.data.query<{ count: number; total: number; visible: number; hidden: number }>(
      "messages.count",
      { session_id: "s1" },
    );
    const stats = r.items[0];
    expect(stats.total).toBe(1);
    expect(stats.visible).toBe(1);
    expect(stats.hidden).toBe(0);
  });

  it("WIRE-5: 四类错误的 code / retryable 全部按契约映射", async () => {
    const cases: Array<[string, string, boolean]> = [
      ["error_not_found", "messages.update", false],
      ["error_constraint", "messages.create", false],
      ["error_unsupported", "sql.raw", false],
      ["error_bad_param", "messages.badparam", false],
    ];
    for (const [fixtureKey, command, retryable] of cases) {
      const port = new RustStoragePort(
        transportBackedByFixtures({ [command]: fixtures[fixtureKey] }),
      );
      const err = await port.data.query(command, {}).catch((e) => e as StorageError);
      expect(err, `${fixtureKey} 必须抛 StorageError`).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe(fixtures[fixtureKey].error.code);
      expect((err as StorageError).retryable).toBe(retryable);
      // hint 要带过去，日志与界面直接用
      expect((err as StorageError).detail).toBeTruthy();
    }
  });

  it("WIRE-6: 写命令的 written 能被解包（A 类防线：写入必须有回报）", async () => {
    const port = new RustStoragePort(transportBackedByFixtures({ "settings.set": fixtures.write }));
    const r = await port.data.execute("settings.set", { key: "k", value: "v" });
    expect(typeof r.written).toBe("number");
    expect(r.written).toBeGreaterThan(0);
  });

  it("WIRE-7: 对账摘要的**跨语言一致性**（真实 bug 的回归守卫）", async () => {
    // 背景：`cost REAL` / `weight REAL` 存整数值时，Rust 看到 Real(0.0)、
    // sql.js 给出 number(0)。两边若编码不同，摘要必然不同 ——
    // 表现为"行数一致、逐行一致、摘要不同"，极难定位（实测踩过一次）。
    // 这里用 Rust 生成的金样本锁住两边一致：
    const sample = fixtures.digestSample;
    expect(sample, "金样本缺少 digestSample").toBeTruthy();

    const { digestRows } = await import("../../tools/migrate/lib/digest.mjs");
    const js = digestRows(sample.rows);
    expect(
      js.digest,
      `摘要跨语言不一致：JS=${js.digest} Rust=${sample.result.digest}。` +
        `改动 digest.mjs 或 migrate.rs 的 value_bytes 时，两边必须同步。`,
    ).toBe(sample.result.digest);
    expect(js.rows).toBe(sample.result.rows);
  });

  it("WIRE-8: 摘要必须能区分类型与边界（1 与 \"1\"、1 与 1.5、列边界）", async () => {
    const { digestRows } = await import("../../tools/migrate/lib/digest.mjs");
    expect(digestRows([[1]]).digest).not.toBe(digestRows([["1"]]).digest);
    expect(digestRows([[1]]).digest).not.toBe(digestRows([[1.5]]).digest);
    expect(digestRows([["ab", "c"]]).digest).not.toBe(digestRows([["a", "bc"]]).digest);
    expect(digestRows([["a"], ["b"]]).digest).not.toBe(digestRows([["a", "b"]]).digest);
    expect(digestRows([[null]]).digest).not.toBe(digestRows([[""]]).digest);
    // 整数值的浮点与整数摘要**必须相同**（这是与 Rust 约定好的规则，不是缺陷）
    expect(digestRows([[0]]).digest).toBe(digestRows([[0.0]]).digest);
  });

  /**
   * WIRE-9：**真实 Rust 行**必须带齐镜像要搬的每一个字段。
   *
   * 这是"字段清单"这道闸门的第三层，三层缺一不可：
   *
   * | 层 | 位置 | 抓的是 |
   * | --- | --- | --- |
   * | 编译期 | `WIRE_SAMPLE: Record<keyof MirrorMessageRow, unknown>` | 加字段却没登记 |
   * | 行为（合成行） | `MIRROR-FIELDS` | 登记了却没在 `normalize()` 里搬 |
   * | **本层（真实行）** | 引擎生成的金样本 | **Rust 那行里压根没有这个字段** |
   *
   * 第三层为什么必须存在：前两层都用**手写**的 wire 行 —— 手写行里当然有你刚加的那个字段。
   * 而真正的断裂点在 Rust 侧（`MESSAGE_SELECT` 漏列、列投影漏一列、`message_row` 下标错位），
   * 此时 `normalize()` 会安静地填默认值：`trimmed` 缺 → `0` → `hiddenIds()` 把这一行
   * 当成"被上下文压缩" → 被索引裁剪的历史整批消失。**这正是第 44 轮真机上发生的事，
   * 只不过那次断在 TS 侧（`normalize` 没搬），断在 Rust 侧的样子与它一模一样。**
   */
  it("WIRE-9: 金样本里的真实 Rust 行必须带齐镜像要搬的每一个字段", async () => {
    const rows: Array<Record<string, unknown>> = fixtures.list?.result?.items ?? [];
    expect(rows.length, "金样本里没有 messages.list 的行（fixture 需要重跑）").toBeGreaterThan(0);

    for (const [label, row] of [["list", rows[0]], ["single", fixtures.single?.result?.item]] as const) {
      expect(row, `金样本缺少 ${label} 行`).toBeTruthy();
      const missing = (Object.keys(MIRROR_FIELDS) as Array<keyof MirrorMessageRow>).filter(
        (k) => !(k in (row as Record<string, unknown>)),
      );
      expect(
        missing,
        `Rust 的 ${label} 行缺少镜像要搬的字段：${missing.join(", ")} —— ` +
          `缺字段时 normalize() 会填默认值（trimmed 缺 → 0 → 被当成"压缩隐藏" → 用户历史消失）`,
      ).toEqual([]);
    }

    // 标量字段还必须是数字形态：`"1"` 这种字符串会被 Number() 悄悄接受，
    // 但 null/undefined 不会 —— 上面那条已经拦住 undefined，这里补一条类型断言。
    const first = rows[0];
    for (const key of ["hidden", "trimmed"] as const) {
      expect(typeof first[key], `${key} 必须是 number（线上行形状）`).toBe("number");
    }
  });
});
