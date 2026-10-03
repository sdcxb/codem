/**
 * 第 D9 波（假成功 A 类）：`multi_edit` **部分失败**必须判为 error。
 *
 * ## 修的是什么
 *
 * `multi_edit` 逐条应用编辑，失败的条目记进 `errors`、成功的照常落盘，
 * 最后返回 `Applied 2/3 edits to <path>. Errors: …` —— 既没有 `Error:` 前缀、
 * 也没有 `isError`。`multi_edit` 不在 `tool-result-status.ts` 的 `CONTENT_TOOLS`
 * 豁免名单里，于是分类器按首行前缀推断得到 `completed`：
 * 一半的编辑根本没写进文件，上层（`session/ui-handoff.ts` 的产物判定、委派汇报）
 * 却把它当成写完了。
 *
 * ## 为什么断言既要「error」又要「另外两条真的落盘了」
 *
 * 只断言 error，无法区分「部分失败被判成失败」与「整个请求被全或无地拒绝」——
 * 后者是**行为变更**（模型白写一次、且文件里已经有改动却没有回报），
 * 也会让「Applied 2/3 edits」这句事实描述失去意义。
 *
 * ## 桩
 *
 * 同 `edit-tool-integration.test.ts`：`window.__TAURI__.core.invoke` → Node fs。
 * `.txt` 绕开 `autoLint` 的子进程依赖。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, createMultiEditTool, createReadFileTool, type ToolContext } from "../core/llm/tools";

let dir: string;
let originalTauri: unknown;
let writeCalls: Array<Record<string, unknown>>;

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
            writeCalls.push(args);
            writeFileSync(args.path as string, args.content as string, "utf8");
            return null;
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-d9-"));
  writeCalls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: dir,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createMultiEditTool());
  return registry;
}

/**
 * 第 95 波夹具：**先真的读一遍**（`fs-observation-policy` 的"读后写"前置条件）。
 * 这些用例测的是**部分失败必须判 error**，而不是"读后写"；用真实 read 工具满足前置条件，
 * 链路才仍然是产品真实链路。
 */
async function readFirst(path: string): Promise<void> {
  await createReadFileTool().execute({ path }, makeCtx());
}

const BASE = "alpha = 1;\nbeta = 2;\ngamma = 3;\n";

describe("D9: multi_edit 部分失败必须判为 error，且成功的那几条确实落盘", () => {
  it("D9-1: 3 条里第 2 条找不到 → status=error、error 非空、第 1/3 条已落盘（真正的部分应用）", async () => {
    const file = join(dir, "partial.txt");
    writeFileSync(file, BASE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-1",
      "multi_edit",
      {
        path: file,
        edits: [
          { oldString: "alpha = 1;", newString: "alpha = 111;" },
          { oldString: "ZZZ_missing_ZZZ", newString: "beta = 222;" },
          { oldString: "gamma = 3;", newString: "gamma = 333;" },
        ],
      },
      makeCtx(),
    );

    // 1) 分类必须是失败，且 error 字段非空（下游按 status === "error" 判断产物/交付）
    expect(res.status).toBe("error");
    expect(typeof res.error).toBe("string");
    expect(res.error && res.error.length).toBeGreaterThan(0);

    // 2) 事实描述保留：2/3 成功
    expect(res.output).toContain("Applied 2/3 edits");

    // 3) 真的部分落盘：1 和 3 生效，2 的原文仍在
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toBe("alpha = 111;\nbeta = 2;\ngamma = 333;\n");
    expect(onDisk).toContain("alpha = 111;");
    expect(onDisk).toContain("gamma = 333;");
    expect(onDisk).toContain("beta = 2;");
    expect(onDisk).not.toContain("alpha = 1;");
    expect(onDisk).not.toContain("gamma = 3;");
    expect(writeCalls).toHaveLength(1);
  });

  it("D9-2: 反向对照 —— 全部成功仍是 completed（不能把成功也判成失败）", async () => {
    const file = join(dir, "all-ok.txt");
    writeFileSync(file, BASE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-2",
      "multi_edit",
      {
        path: file,
        edits: [
          { oldString: "alpha = 1;", newString: "alpha = 111;" },
          { oldString: "beta = 2;", newString: "beta = 222;" },
          { oldString: "gamma = 3;", newString: "gamma = 333;" },
        ],
      },
      makeCtx(),
    );

    expect(res.status).toBe("completed");
    expect(res.error).toBeUndefined();
    expect(res.output).toContain("Applied 3 edits");
    expect(readFileSync(file, "utf8")).toBe("alpha = 111;\nbeta = 222;\ngamma = 333;\n");
  });

  it("D9-3: 全部失败仍是 error（appliedCount === 0 早退分支不回退）", async () => {
    const file = join(dir, "all-fail.txt");
    writeFileSync(file, BASE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-3",
      "multi_edit",
      { path: file, edits: [{ oldString: "ZZZ_missing_ZZZ", newString: "x" }] },
      makeCtx(),
    );

    expect(res.status).toBe("error");
    expect(res.output).toContain("No edits could be applied");
    // 全失败时一个字节都不写（早退分支在 writeFile 之前）
    expect(readFileSync(file, "utf8")).toBe(BASE);
    expect(writeCalls).toHaveLength(0);
  });
});
