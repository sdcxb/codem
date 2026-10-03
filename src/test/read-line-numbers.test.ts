/**
 * 第 113 波：**带行号的读取 + 编辑对行号前缀的容错**。
 *
 * ## 为什么（有我们自己的实测证据）
 *
 * 逐条翻我们自己的会话时发现：需要"行号"时，agent 会**绕道 shell** ——
 * repo-02 那一次里两次（`node -e "…lines.slice(1405,1530).map((l,i)=>…1406+i…)"`、
 * 甚至 `python -c "…i+1+': '+lines[i]…"`），run-2 里又出现一次 `node -e "…readFileSync…"`。
 * 代价是：多一次工具调用 + 引号地狱（本仓纪律里专门写过"别用 node -e 夹引号"）。
 *
 * 根因是"位置感"不一致：`grep` 的结果**带** `line`，`read` **不带** ⇒ 想看行号只能自己造。
 *
 * ## 判据（都走**真实链路**：真临时文件 + 真工具 + 只把 Tauri 桩成 Node fs）
 *
 * · LN-1：`read({ line_numbers: true })` 每行带 1-based 行号，且从 `offset` 起算；
 * · LN-2 反向对照：不传时**一个行号都不许加**（默认输出形状不变）；
 * · LN-3：`edit` 容忍"从带行号读取里复制过来"的锚点（逐行剥掉 `\d+\t`）仍能精确命中并落盘；
 * · LN-4 反向对照：**没有**行号前缀的锚点行为不变（容错没有把锚点改坏）。
 *
 * 变异自证：删掉渲染器里的编号分支 ⇒ LN-1 红；去掉 `stripLineNumberGutter` ⇒ LN-3 红。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { renderReadOutput } from "../core/llm/tool-output-shapes";
import { createDefaultToolRegistry, type ToolContext } from "../core/llm/tools";

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
          case "read_file_lines": {
            // 与 Rust 侧同形：按 [offset, offset+limit) 取行、带 totalLines/hasMore
            const text = readFileSync(args.path as string, "utf8");
            const all = text.split("\n");
            const offset = Number(args.offset ?? 1);
            const limit = Number(args.limit ?? 2000);
            const slice = all.slice(offset - 1, offset - 1 + limit);
            return {
              text: slice.join("\n"),
              totalLines: all.length,
              hasMore: offset - 1 + limit < all.length,
            };
          }
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
  (globalThis as unknown as Record<string, unknown>).__TAURI__ = originalTauri;
});

beforeEach(() => {
  writeCalls = [];
  dir = mkdtempSync(join(tmpdir(), "codem-line-numbers-"));
});

function ctx(): ToolContext {
  return { cwd: dir, sessionId: "ln-session", abort: new AbortController().signal } as ToolContext;
}

describe("第 113 波：读取带行号 + 编辑容错", () => {
  it("LN-1: line_numbers 打开时每行带 1-based 行号，且从 offset 起算", async () => {
    const file = join(dir, "sample.txt");
    writeFileSync(file, "line-A\nline-B\nline-C\n", "utf8");
    const registry = createDefaultToolRegistry();
    const tool = registry.get("read")!;
    const result = await (tool as any).execute({ path: file, offset: 2, limit: 2, line_numbers: true }, ctx());
    const text = String(result.output ?? "");
    expect(text, `实际输出：${text.slice(0, 900)}`).toContain("2\tline-B");
    expect(text, "第 3 行要标成 3").toContain("3\tline-C");
    expect(text, "不该把第 1 行当成本次读取").not.toContain("line-A");
  });

  it("LN-2 反向对照: 不传 line_numbers 时输出形状与从前一致（不加任何行号）", async () => {
    const file = join(dir, "sample.txt");
    writeFileSync(file, "line-A\nline-B\n", "utf8");
    const registry = createDefaultToolRegistry();
    const tool = registry.get("read")!;
    const result = await (tool as any).execute({ path: file }, ctx());
    const text = String(result.output ?? "");
    expect(text).toContain("line-A");
    expect(text, "不许出现任何行号前缀").not.toMatch(/^\s*\d+\t/m);
  });

  it("LN-3: edit 能吃下「带行号复制」的锚点并正确落盘", async () => {
    const file = join(dir, "edit-me.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
    const registry = createDefaultToolRegistry();
    const readTool = registry.get("read")!;
    const tool = registry.get("edit")!;
    // 先把文件"读过" —— 第 95 波的 fs-observation-policy 要求**读后写**（这是特性，不是障碍）
    await (readTool as any).execute({ path: file }, ctx());
    // 模拟模型从带行号的读取里整段复制：每行前缀 `行号\t`
    const result = await (tool as any).execute(
      { path: file, oldString: "1\talpha\n2\tbeta", newString: "1\tALPHA\n2\tBETA" },
      ctx(),
    );
    const text = String(result.output ?? "");
    expect(text, `不应当匹配失败：${text.slice(0, 160)}`).not.toMatch(/not found/i);
    expect(text.toLowerCase()).toContain("success");
    // 落盘内容：锚点被剥掉了行号，写进去的也不该带行号
    expect(readFileSync(file, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
  });

  it("LN-4 反向对照: 不带行号的锚点照常工作（容错没有改坏正常路径）", async () => {
    const file = join(dir, "edit-me.txt");
    writeFileSync(file, "alpha\nbeta\ngamma\n", "utf8");
    const registry = createDefaultToolRegistry();
    const readTool = registry.get("read")!;
    const tool = registry.get("edit")!;
    await (readTool as any).execute({ path: file }, ctx());
    const result = await (tool as any).execute({ path: file, oldString: "beta", newString: "BETA" }, ctx());
    expect(String(result.output ?? "").toLowerCase()).toContain("success");
    expect(readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("LN-5: 渲染器单元级 —— startLine 缺省时从 1 开始（不给 startLine 也不能出错）", () => {
    const out = renderReadOutput({ path: "a.ts", content: "x\ny", notices: [], lineNumbers: true });
    expect(out).toContain("1\tx");
    expect(out).toContain("2\ty");
  });
});
