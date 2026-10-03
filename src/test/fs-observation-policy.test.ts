/**
 * `fs-observation-policy`：**读后写**与**版本比对（CAS）**（第 95 波，交接单 §3.5）。
 *
 * ## 缺陷形态（修之前：一点拦截都没有）
 *
 * `src/core/provider/fs-observation-policy-provider.ts` 全文 16 行、只有文件监听的防抖配置，
 * **名字与能力不符**（很容易让人以为已经有保护）。于是两类事故没有任何拦截：
 *   1. 模型**没读过**就 `edit` / 覆盖 `write`（内容来自压缩后的记忆或猜测）⇒ 改错地方、覆盖掉没见过的东西；
 *   2. 模型**读过**，但文件在这期间被改过（用户手动改 / git 切换 / 子智能体改）⇒ 仍然照着旧内容下手。
 *
 * ## 判据（走**真实的工具 `execute()`**：真文件、真读写、真返回值）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | OBS-1 | 存在一个文件，**没读过**就 `edit` | 拒绝、带 `FS_NOT_OBSERVED`、`isError`、**文件一个字节没变** |
 * | OBS-2 | 先 `read` 再 `edit` | 成功，内容真的改了 |
 * | OBS-3 | `read` → *在背后改掉文件* → `edit` | 拒绝、带 `FS_STALE_OBSERVATION`、文件保持"背后改过的那一版" |
 * | OBS-4 | 已存在的文件，**没读过**就 `write`（覆盖） | 拒绝、带 `FS_NOT_OBSERVED`、内容不变 |
 * | OBS-5 | `write` 一个**新路径** | 放行（创建不破坏任何东西） |
 * | OBS-6 | `read` 之后再 `write` 覆盖 | 放行 |
 * | OBS-7 | `write` 新建 → 紧接着 `edit` | 放行（**自己的写入也算观察**，不必重读） |
 * | OBS-8 | 已有文件、没读过、但**没有会话归属** | 放行（无 owner 时不启用 —— 见 `fs-observation.ts` 模块头的取舍） |
 * | OBS-9 | 已有文件、没读过，`write` + `append: true` | 放行（追加不破坏已有内容，且它是分块写入的落地方式） |
 * | OBS-10 | `multi_edit` 同 OBS-1 的形态 | 同样拒绝（两条编辑入口共用一个判据） |
 *
 * ## 变异自证
 *
 * - 去掉 `edit`/`multi_edit` 里的 `checkEditAllowed` 调用 ⇒ OBS-1 / OBS-3 / OBS-10 变红；
 * - 让 `decideWriteIntent` 放行"未观察但已存在" ⇒ OBS-4 变红；
 * - 去掉 `read` 成功后的 `noteObservedPresent` ⇒ OBS-2 / OBS-6 变红（"读过"这条信息没被记下）。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReadFileTool,
  createEditFileTool,
  createMultiEditTool,
  createWriteFileTool,
  type ToolContext,
} from "../core/llm/tools";
import { __resetFsObservationPolicy } from "../core/llm/fs-observation";

let dir: string;
let originalTauri: unknown;

/**
 * `window.__TAURI__.core.invoke` 的桩：转发给 Node 的 fs。
 *
 * ⚠️ 字段名必须是**线上真实的名字**（camelCase，Rust 侧 `rename_all = "camelCase"`）。
 * 这一条曾经是错的：桩返回 camelCase 而真机返回 snake_case，于是"桩比真机更对"、
 * 缺陷在测试里看不见（第 95 波实测：真机键是 `next_offset`，前端读 `nextOffset`）。
 * 现在 Rust 侧有 `wire_naming_tests` 把线上名字钉住了。
 */
beforeAll(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  originalTauri = w.__TAURI__;
  w.__TAURI__ = {
    core: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
          case "read_file":
            return readFileSync(args.path as string, "utf8");
          case "write_file":
            writeFileSync(args.path as string, args.content as string, "utf8");
            return null;
          case "read_file_lines": {
            const offset = (args.offset as number | undefined) ?? 1;
            const limit = (args.limit as number | undefined) ?? 2000;
            const lines = readFileSync(args.path as string, "utf8").split("\n");
            return {
              text: lines.slice(offset - 1, offset - 1 + limit).join("\n"),
              totalLines: lines.length,
              hasMore: offset - 1 + limit < lines.length,
            };
          }
          case "file_version": {
            try {
              const st = statSync(args.path as string);
              return `${st.size}:${Math.round(st.mtimeMs * 1e6)}`;
            } catch {
              return null; // 不存在 —— 与 Rust 侧同形（None ⇒ null）
            }
          }
          default:
            throw new Error(`test stub: unhandled tauri command "${command}"`);
        }
      },
    },
  };
});

afterAll(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  if (originalTauri === undefined) delete w.__TAURI__;
  else w.__TAURI__ = originalTauri;
});

function makeCtx(sessionId: string | undefined): ToolContext {
  return {
    ...(sessionId ? { sessionId } : {}),
    messageId: "test-message",
    cwd: dir,
    abort: new AbortController().signal,
  } as ToolContext;
}

const SESSION = "sess-fs-observation";
const BASE = "alpha = 1;\nbeta = 2;\ngamma = 3;\n";

function makeFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-fsobs-"));
  // 每个用例从干净观察开始（观察是进程级共享的，否则上一个用例的"读过"会漏进来）
  __resetFsObservationPolicy();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fs-observation-policy：读后写（第 95 波）", () => {
  it("OBS-1: 没读过就 edit → 拒绝（FS_NOT_OBSERVED），文件一个字节没变", async () => {
    const file = makeFile("a.txt", BASE);

    const res = await createEditFileTool().execute(
      { path: file, oldString: "beta = 2;", newString: "beta = 99;" },
      makeCtx(SESSION),
    );

    expect(res.output, "必须说清「先读再改」，并带上拒绝码").toContain("FS_NOT_OBSERVED");
    expect(res.output).toContain("read");
    expect(res.isError, "拒绝必须标成错误（否则又是「没写盘却报成功」）").toBe(true);
    expect(readFileSync(file, "utf8"), "拒绝的语义是**零字节改动**").toBe(BASE);
  });

  it("OBS-2 反向对照: 先 read 再 edit → 成功，内容真的改了", async () => {
    const file = makeFile("b.txt", BASE);

    await createReadFileTool().execute({ path: file }, makeCtx(SESSION));
    const res = await createEditFileTool().execute(
      { path: file, oldString: "beta = 2;", newString: "beta = 99;" },
      makeCtx(SESSION),
    );

    expect(res.isError, "读过之后必须放行").toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe("alpha = 1;\nbeta = 99;\ngamma = 3;\n");
  });

  it("OBS-3: 读完之后文件被改过 → 拒绝（FS_STALE_OBSERVATION），不许照旧内容下手", async () => {
    const file = makeFile("c.txt", BASE);

    await createReadFileTool().execute({ path: file }, makeCtx(SESSION));
    // 保证 mtime 一定不同（同长度改写靠 mtime 判）
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(file, "alpha = 1;\nbeta = 77;\ngamma = 3;\n", "utf8"); // "别人"改了

    const res = await createEditFileTool().execute(
      { path: file, oldString: "beta = 2;", newString: "beta = 99;" },
      makeCtx(SESSION),
    );

    expect(res.output, "必须认出「你读过之后它变了」").toContain("FS_STALE_OBSERVATION");
    expect(res.isError).toBe(true);
    expect(readFileSync(file, "utf8"), "拒绝时不许落盘（否则就覆盖掉了别人的改动）").toBe(
      "alpha = 1;\nbeta = 77;\ngamma = 3;\n",
    );
  });

  it("OBS-4: 已存在的文件没读过就覆盖 write → 拒绝（FS_NOT_OBSERVED），内容不变", async () => {
    const file = makeFile("d.txt", BASE);

    const res = await createWriteFileTool().execute(
      { path: file, content: "全没了\n" },
      makeCtx(SESSION),
    );

    expect(res.output).toContain("FS_NOT_OBSERVED");
    expect(res.isError).toBe(true);
    expect(readFileSync(file, "utf8"), "没看过的内容不许被覆盖掉").toBe(BASE);
  });

  it("OBS-5: 写一个**新路径** → 放行（创建不破坏任何东西，不需要先观察）", async () => {
    const file = join(dir, "brand-new.txt");

    const res = await createWriteFileTool().execute(
      { path: file, content: "新文件\n" },
      makeCtx(SESSION),
    );

    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe("新文件\n");
  });

  it("OBS-6: read 之后再覆盖 write → 放行", async () => {
    const file = makeFile("e.txt", BASE);

    await createReadFileTool().execute({ path: file }, makeCtx(SESSION));
    const res = await createWriteFileTool().execute(
      { path: file, content: "整份替换\n" },
      makeCtx(SESSION),
    );

    expect(res.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe("整份替换\n");
  });

  it("OBS-7: 自己 write 出来的文件紧接着 edit → 放行（自己的写入也算观察）", async () => {
    const file = join(dir, "f.txt");

    await createWriteFileTool().execute({ path: file, content: BASE }, makeCtx(SESSION));
    const res = await createEditFileTool().execute(
      { path: file, oldString: "gamma = 3;", newString: "gamma = 4;" },
      makeCtx(SESSION),
    );

    expect(res.isError, "写完再改是常见节奏，不该被拦").toBeFalsy();
    expect(readFileSync(file, "utf8")).toContain("gamma = 4;");
  });

  it("OBS-8: 没有会话归属时不启用（放行）—— 取舍写在 fs-observation.ts 模块头", async () => {
    const file = makeFile("g.txt", BASE);

    const res = await createEditFileTool().execute(
      { path: file, oldString: "beta = 2;", newString: "beta = 5;" },
      makeCtx(undefined),
    );

    expect(res.isError, "无 owner 时一律拒绝会把没有会话的调用整体打断").toBeFalsy();
    expect(readFileSync(file, "utf8")).toContain("beta = 5;");
  });

  it("OBS-9: append 模式不受覆盖策略约束（追加是分块写入的落地方式）", async () => {
    const file = makeFile("h.txt", BASE);

    const res = await createWriteFileTool().execute(
      { path: file, content: "delta = 4;\n", append: true },
      makeCtx(SESSION),
    );

    expect(res.isError, "追加不破坏已有内容，不该被拦").toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe(BASE + "delta = 4;\n");
  });

  it("OBS-10: multi_edit 与 edit 共用同一条前置判定（没读过同样拒绝）", async () => {
    const file = makeFile("i.txt", BASE);

    const res = await createMultiEditTool().execute(
      { path: file, edits: [{ oldString: "beta = 2;", newString: "beta = 6;" }] },
      makeCtx(SESSION),
    );

    expect(res.output).toContain("FS_NOT_OBSERVED");
    expect(res.isError).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(BASE);
  });

  it("OBS-11: 读一个**不存在**的文件之后再 write 它 → 放行（确认不存在也是一种观察）", async () => {
    const file = join(dir, "later.txt");

    const readRes = await createReadFileTool().execute({ path: file }, makeCtx(SESSION));
    expect(readRes.output, "read 一个不存在的文件必须如实报错").toMatch(/Error/);

    const writeRes = await createWriteFileTool().execute(
      { path: file, content: "先看了，它确实不在\n" },
      makeCtx(SESSION),
    );
    expect(writeRes.isError).toBeFalsy();
    expect(readFileSync(file, "utf8")).toBe("先看了，它确实不在\n");
  });
});
