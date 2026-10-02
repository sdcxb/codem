/**
 * 第 D10 波（假成功 A 类）：`write` 的「Write not executed」必须判为 error。
 *
 * ## 修的是什么
 *
 * 用户对一次覆盖写给出**一次性自定义指示**（`onWriteConfirm` 返回 `action: "custom"`）时，
 * `write` 工具返回的 output 以 `Write not executed.` 开头 —— 文件**一个字节都没写**，
 * 但这条返回既没有 `Error:` 前缀、也没有 `isError`，而 `write` 不在
 * `tool-result-status.ts` 的 `CONTENT_TOOLS` 豁免名单里，于是分类器按首行前缀推断
 * 得到 `completed`：界面显示成功、`ui-handoff` 把它算成"产出"、委派汇报说写完了。
 *
 * `tool-result-status.ts` 文件头点名的正是这一类缺陷，第 84 波只覆盖了首行恰好
 * 以 `Error:` 开头的路径 —— 这条首行是英文叙述，正好漏在网外。
 *
 * ## 为什么断言「没写盘」而不是「输出里有某个词」
 *
 * 缺陷的本质是**状态说假话**，所以断言必须落在 (a) 分类链路给出的 status/error，
 * 以及 (b) 磁盘逐字节不变 + 一次 `write_file` 都没发。只断言 output 文本的话，
 * 把 `isError` 去掉这个测试照样绿 —— 那就没有覆盖到修复。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ToolRegistry,
  createWriteFileTool,
  type ToolContext,
  type WriteConfirmResult,
} from "../core/llm/tools";

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
  dir = mkdtempSync(join(tmpdir(), "codem-d10-"));
  writeCalls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 走到 `Write not executed` 分支的**三个**前置条件（缺一就到不了）：
 *   1. 文件已存在且非空（`existingContent.length > 0`）；
 *   2. 相似度 < `OVERWRITE_SIMILARITY_THRESHOLD`（0.1 ÷ `tools.ts:321`）；
 *   3. `ctx.onWriteConfirm` 存在**且** `securityMode === "ask"`（默认值）。
 */
const EXISTING = "alpha = 1;\nbeta = 2;\ngamma = 3;\n";
const TOTALLY_DIFFERENT = "完全无关的新内容，与旧内容没有任何一行重合\n";

function makeCtx(onWriteConfirm: ToolContext["onWriteConfirm"]): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: dir,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    securityMode: "ask",
    onWriteConfirm,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createWriteFileTool());
  return registry;
}

describe("D10: write 的 Write not executed 分支必须判为 error", () => {
  it("D10-1: custom 指示 → status=error、error 非空、磁盘逐字节不变、没发过 write_file", async () => {
    const file = join(dir, "target.txt");
    writeFileSync(file, EXISTING, "utf8");
    const before = readFileSync(file);

    let confirmCalls = 0;
    const res = await makeRegistry().execute(
      "tc-1",
      "write",
      { path: file, content: TOTALLY_DIFFERENT },
      makeCtx(async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "custom", instruction: "只把 beta 那一行改成 20，不要整文件覆盖" };
      }),
    );

    // 前置条件成立：确实走到了需要确认的那条路（不是「没触发确认所以没写」）
    expect(confirmCalls).toBe(1);

    // 1) 分类链路的判定必须是失败
    expect(res.status).toBe("error");
    expect(typeof res.error).toBe("string");
    expect(res.error && res.error.length).toBeGreaterThan(0);
    expect(res.error).toContain("Write not executed");

    // 2) 文件确实没写
    expect(readFileSync(file).equals(before), "用户指示未被采纳前必须一个字节都不写").toBe(true);
    expect(writeCalls).toHaveLength(0);
  });

  it("D10-2: 反向对照 —— accept 时真的写盘且判为 completed（证明 D10-1 不是「write 坏了」）", async () => {
    const file = join(dir, "accepted.txt");
    writeFileSync(file, EXISTING, "utf8");

    let confirmCalls = 0;
    const res = await makeRegistry().execute(
      "tc-2",
      "write",
      { path: file, content: TOTALLY_DIFFERENT },
      makeCtx(async (): Promise<WriteConfirmResult> => {
        confirmCalls++;
        return { action: "accept" };
      }),
    );

    expect(confirmCalls).toBe(1);
    expect(res.status).toBe("completed");
    expect(res.output).toContain("Successfully wrote");
    expect(readFileSync(file, "utf8")).toBe(TOTALLY_DIFFERENT);
    expect(writeCalls).toHaveLength(1);
  });

  it("D10-3: reject 分支（同类的「没写盘」路径）本来就是 error，未被本次修复影响", async () => {
    const file = join(dir, "rejected.txt");
    writeFileSync(file, EXISTING, "utf8");
    const before = readFileSync(file);

    const res = await makeRegistry().execute(
      "tc-3",
      "write",
      { path: file, content: TOTALLY_DIFFERENT },
      makeCtx(async (): Promise<WriteConfirmResult> => ({ action: "reject" })),
    );

    expect(res.status).toBe("error");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(writeCalls).toHaveLength(0);
  });
});
