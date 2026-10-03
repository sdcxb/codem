/**
 * 第 D8 波（假成功 A 类）：`edit` 的 `oldString` 在文件里出现**多次**时必须拒写。
 *
 * ## 修的是什么
 *
 * `edit-matchers.ts` 的 `replaceLiteral` 只换**第一处**，而 `edit` 工具没有唯一性检查：
 * `oldString` 命中两处以上时，它照样写盘并返回「Successfully edited」。
 * 模型因此拿到成功信号继续往下走，改错的地方要等到 build/test 失败才暴露。
 * 对标 DSH：`FS_AMBIGUOUS_EDIT`（"Multiple occurrences of old_str … Please ensure it is unique"）。
 *
 * ## 为什么断言分三层（缺一层就可能是空转）
 *
 * 1. `status === "error"` —— 走**真实链路**（`ToolRegistry.execute` → `classifyToolResult`），
 *    而不是直接调 `tool.execute` 看 `output`；否则「失败被判成 completed」这个缺陷本身没被覆盖。
 * 2. 磁盘**逐字节不变**（Buffer.equals）—— 光有错误文本、文件却被改了，等于没修。
 * 3. `write_file` 一次都没发 —— 证明拒绝发生在**替换之前**，而不是"先写了再报错"。
 *
 * 反向对照（positive control）：同一份文件上唯一命中的 `oldString` 必须照旧成功并落盘，
 * 否则这个测试只能证明「edit 坏了」。
 *
 * ## 桩
 *
 * 复用本仓既有模式（`edit-tool-integration.test.ts`）：把 `window.__TAURI__.core.invoke`
 * 换成转发 Node fs 的桩，命令名/参数名对齐 `src-tauri/src/lib.rs`。
 * 用 `.txt` 是为了绕开 `autoLint` 的 tsc/eslint 子进程（那是环境依赖，不是被测行为）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, createEditFileTool, createReadFileTool, type ToolContext } from "../core/llm/tools";

let dir: string;
let originalTauri: unknown;

/** 本用例期间所有 write_file 调用（用来证明"一个字节都没写"） */
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
  dir = mkdtempSync(join(tmpdir(), "codem-d8-"));
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
  registry.register(createEditFileTool());
  return registry;
}

/**
 * 第 95 波夹具：**先真的读一遍**（`fs-observation-policy` 的"读后写"前置条件）。
 *
 * 这些用例测的是**歧义即拒**，但 `edit` 现在要求"这个文件在本会话里被读过"。
 * 用真实 read 工具走这一步（而不是绕过策略），这些用例才仍然走产品真实链路；
 * 顺带把"取不到版本令牌 ⇒ 不谎报状态"的那条退化路径也覆盖到。
 */
async function readFirst(path: string): Promise<void> {
  await createReadFileTool().execute({ path }, makeCtx());
}

/** `target = 42;` 出现在第 2 行与第 5 行 */
const TWICE = [
  "alpha = 1;",
  "target = 42;",
  "beta = 2;",
  "gamma = 3;",
  "target = 42;",
  "delta = 4;",
  "",
].join("\n");

describe("D8: edit 的 oldString 命中多处时必须拒写（歧义即拒）", () => {
  it("D8-1: 命中 2 处 → status=error、点名处数与行号、磁盘逐字节不变、一次 write_file 都不发", async () => {
    const file = join(dir, "twice.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);
    const before = readFileSync(file);

    const res = await makeRegistry().execute(
      "tc-1",
      "edit",
      { path: file, oldString: "target = 42;", newString: "target = 99;" },
      makeCtx(),
    );

    // 1) 走真实分类链路：必须是失败，而不是「把失败写在文本里但判成 completed」
    expect(res.status).toBe("error");
    expect(res.error, "error 字段必须给出可行动的原因").toBeTruthy();
    expect(res.output.startsWith("Error:")).toBe(true);
    // 2) 可行动：几处、在哪几行
    expect(res.output).toContain("appears 2 times");
    expect(res.output).toContain("(lines 2, 5)");
    expect(res.output).toMatch(/include more surrounding context/i);

    // 3) 磁盘逐字节不变
    const after = readFileSync(file);
    expect(after.equals(before), "歧义编辑必须一个字节都不写").toBe(true);
    // 4) 拒绝发生在替换之前：根本没发过 write_file
    expect(writeCalls).toHaveLength(0);
  });

  it("D8-2: 反向对照 —— 唯一命中仍然成功并真的落盘（证明 D8-1 不是「edit 坏了」）", async () => {
    const file = join(dir, "unique.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-2",
      "edit",
      { path: file, oldString: "alpha = 1;", newString: "alpha = 111;" },
      makeCtx(),
    );

    expect(res.status).toBe("completed");
    expect(res.output).toContain("Successfully edited");
    expect(writeCalls).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(
      ["alpha = 111;", "target = 42;", "beta = 2;", "gamma = 3;", "target = 42;", "delta = 4;", ""].join("\n"),
    );
  });

  it("D8-3: 唯一命中 + 带上下文的 oldString 可以改到第二处（模型按提示加语境后仍能达成目的）", async () => {
    const file = join(dir, "context.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-3",
      "edit",
      { path: file, oldString: "gamma = 3;\ntarget = 42;", newString: "gamma = 3;\ntarget = 99;" },
      makeCtx(),
    );

    expect(res.status).toBe("completed");
    expect(res.output).toContain("Successfully edited");
    expect(readFileSync(file, "utf8")).toBe(
      ["alpha = 1;", "target = 42;", "beta = 2;", "gamma = 3;", "target = 99;", "delta = 4;", ""].join("\n"),
    );
  });

  it("D8-4: 命中 3 处时处数与行号都列全", async () => {
    const file = join(dir, "three.txt");
    writeFileSync(file, "x = 1;\nx = 1;\nx = 1;\n", "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-4",
      "edit",
      { path: file, oldString: "x = 1;", newString: "x = 2;" },
      makeCtx(),
    );

    expect(res.status).toBe("error");
    expect(res.output).toContain("appears 3 times");
    expect(res.output).toContain("(lines 1, 2, 3)");
    expect(readFileSync(file, "utf8")).toBe("x = 1;\nx = 1;\nx = 1;\n");
  });

  it("D8-5: 未命中仍然走「找不到」那条路（歧义检查不吞掉原分支）", async () => {
    const file = join(dir, "missing.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-5",
      "edit",
      { path: file, oldString: "zzz_not_there_zzz", newString: "x" },
      makeCtx(),
    );

    expect(res.status).toBe("error");
    expect(res.output).not.toContain("appears");
    expect(res.output).toMatch(/no similar content|not found/i);
    expect(readFileSync(file, "utf8")).toBe(TWICE);
  });

  it("D8-6: oldString === newString 且命中多处 → 仍然拒绝（且磁盘不变）", async () => {
    const file = join(dir, "noop-multi.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);
    const before = readFileSync(file);

    const res = await makeRegistry().execute(
      "tc-6",
      "edit",
      { path: file, oldString: "target = 42;", newString: "target = 42;" },
      makeCtx(),
    );

    // 无变化的写盘同样不该发生：两处一模一样正说明意图没有唯一确定
    expect(res.status).toBe("error");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(writeCalls).toHaveLength(0);
  });

  it("D8-7: oldString === newString 且只命中一处 → 成功、磁盘内容不变（不误伤无变化编辑）", async () => {
    const file = join(dir, "noop-single.txt");
    writeFileSync(file, TWICE, "utf8");
    await readFirst(file);

    const res = await makeRegistry().execute(
      "tc-7",
      "edit",
      { path: file, oldString: "delta = 4;", newString: "delta = 4;" },
      makeCtx(),
    );

    expect(res.status).toBe("completed");
    expect(readFileSync(file, "utf8")).toBe(TWICE);
  });
});
