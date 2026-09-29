/**
 * 集成回归：`createEditFileTool()` / `createMultiEditTool()` **本身**
 * 不得受 `String.replace` 替换记号语义影响，且未命中时要给可行动提示。
 *
 * ## 为什么必须有这一层（不能只测 `replaceLiteral`）
 *
 * `edit-dollar-token.test.ts` 测的是 `replaceLiteral` 这个 helper。
 * 只测 helper 的话，**把 `tools.ts` 改回 `content.replace(oldString, newString)`
 * 而 helper 不动，所有测试照样全绿** —— 而这正是本次 bug 的形状：
 * helper 是新加的，bug 长在**调用点**。
 *
 * 所以这一层走**真实的 `execute()`**：真文件、真读写、真返回值。
 *
 * ## 为什么可以做到「零产品代码改动」
 *
 * `src/core/file-api.ts` 的唯一外部依赖是 `window.__TAURI__.core.invoke`。
 * 这里把它换成「转发给 Node 的 fs」的桩，映射到 Rust 侧真实的命令名/参数名
 * （`src-tauri/src/lib.rs:634` `read_file(path, encoding)`、
 * `:692` `write_file(path, content, encoding, workspace)`）。
 *
 * 于是整条链路（tool.execute → file-api → Tauri 边界）都被覆盖，
 * 而**不需要**给产品代码加测试专用分支。
 *
 * ## 为什么用 .txt
 *
 * `edit` 成功后会调 `autoLint(path)`；它对本仓 `LINTABLE_EXTENSIONS` 之外的扩展名
 * 直接 `return null`，所以 `.txt` 能在不 mock 的情况下走完整条成功路径。
 * 用 .ts 会去拉 tsc/eslint 子进程，把单测变成环境依赖。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEditFileTool,
  createMultiEditTool,
  type ToolContext,
} from "../core/llm/tools";

let dir: string;
let originalTauri: unknown;

/**
 * 把 `window.__TAURI__.core.invoke` 换成真实 Node fs。
 * 只实现被测路径用到的三个命令；其它命令抛错而不是静默返回 undefined
 * （静默 undefined 会让「桩没接对」看起来像「功能正常」）。
 */
beforeAll(() => {
  const w = globalThis as unknown as Record<string, unknown>;
  originalTauri = w.__TAURI__;
  w.__TAURI__ = {
    core: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        switch (command) {
          case "read_file": {
            const p = args.path as string;
            const enc = args.encoding as string | undefined;
            if (enc === "base64") return Buffer.from(readFileSync(p)).toString("base64");
            return readFileSync(p, "utf8");
          }
          case "write_file": {
            writeFileSync(args.path as string, args.content as string, "utf8");
            return null;
          }
          case "read_file_lines": {
            const p = args.path as string;
            const offset = (args.offset as number | undefined) ?? 1;
            const limit = (args.limit as number | undefined) ?? 2000;
            const lines = readFileSync(p, "utf8").split("\n");
            return { content: lines.slice(offset - 1, offset - 1 + limit).join("\n"), total_lines: lines.length };
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

function makeCtx(): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-message",
    cwd: dir,
    abort: new AbortController().signal,
  } as ToolContext;
}

function makeFile(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const BASE = "alpha = 1;\nbeta = 2;\ngamma = 3;\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codem-edit-it-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("edit 工具（真实 execute 链路）：$ 记号不得损坏文件", () => {
  const tokenCases: Array<[string, string]> = [
    ["$&", "beta = $&;"],
    ["$$", 'beta = "$$";'],
    ["$`", "beta = $`;"],
    ["$'", "beta = $';"],
    ["${x}", "beta = `v=${x}`;"],
    ["$1", 'beta = "$1";'],
  ];

  for (const [token, newString] of tokenCases) {
    it(`${token}：磁盘上的字节与期望完全一致`, async () => {
      const file = makeFile("a.txt", BASE);
      const tool = createEditFileTool();

      const res = await tool.execute(
        { path: file, oldString: "beta = 2;", newString },
        makeCtx(),
      );

      expect(res.output).toContain("Successfully edited");
      // 真正的断言：磁盘内容逐字节等于期望
      expect(readFileSync(file, "utf8")).toBe(`alpha = 1;\n${newString}\ngamma = 3;\n`);
    });
  }

  it("反面对照：裸 replace 造出的「损坏版本」确实与期望不同（证明上面 6 个 case 不是恒真）", () => {
    const damaged = BASE.replace("beta = 2;", "beta = $';");
    expect(damaged).not.toBe("alpha = 1;\nbeta = $';\ngamma = 3;\n");
  });

  it("多行 newString 含 $ 记号也逐字写入", async () => {
    const file = makeFile("b.txt", BASE);
    const tool = createEditFileTool();
    const newString = "beta = `\n  x: $&,\n  y: $$,\n`;";

    const res = await tool.execute(
      { path: file, oldString: "beta = 2;", newString },
      makeCtx(),
    );
    expect(res.output).toContain("Successfully edited");
    expect(readFileSync(file, "utf8")).toBe(`alpha = 1;\n${newString}\ngamma = 3;\n`);
  });

  it("桩未接对时会抛错，而不是静默变成「功能正常」", async () => {
    const tool = createEditFileTool();
    const res = await tool.execute(
      { path: join(dir, "nope.txt"), oldString: "a", newString: "b" },
      makeCtx(),
    );
    // 读不存在的文件 → 走 catch 分支，必须报 Error 而不是 Successfully
    expect(res.output).toContain("Error:");
    expect(res.output).not.toContain("Successfully");
  });
});

describe("multi_edit 工具（真实 execute 链路）：$ 记号不得损坏文件", () => {
  it("多步编辑中任一步含 $ 记号都不损坏", async () => {
    const file = makeFile("c.txt", BASE);
    const tool = createMultiEditTool();

    const res = await tool.execute(
      {
        path: file,
        edits: [
          { oldString: "alpha = 1;", newString: "alpha = $&;" },
          { oldString: "beta = 2;", newString: "beta = $$;" },
          { oldString: "gamma = 3;", newString: "gamma = $';" },
        ],
      },
      makeCtx(),
    );

    expect(res.output).toContain("Applied 3 edits");
    expect(readFileSync(file, "utf8")).toBe("alpha = $&;\nbeta = $$;\ngamma = $';\n");
  });

  it("全部编辑失败时不写盘（appliedCount === 0 早退）", async () => {
    const file = makeFile("d.txt", BASE);
    const before = readFileSync(file, "utf8");
    const tool = createMultiEditTool();

    const res = await tool.execute(
      { path: file, edits: [{ oldString: "nonexistent = 9;", newString: "x" }] },
      makeCtx(),
    );

    expect(res.output).toContain("No edits could be applied");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("edit 未命中：给可行动提示而不是一句 not found", () => {
  it("缩进不一致时，提示里带上真实候选与行号", async () => {
    const file = makeFile("e.txt", "line one\n    indented line\nline three\n");
    const tool = createEditFileTool();

    // 注意：oldString 的前导空白必须**比文件里更多**，这样 indexOf 才会真的失败。
    // 若写成 "  indented line"（2 空格）它是 "    indented line"（4 空格）的子串，
    // 精确匹配就成功了，根本走不到候选提示分支 —— 这个测试会变成假通过。
    const res = await tool.execute(
      { path: file, oldString: "      indented line", newString: "x" },
      makeCtx(),
    );

    expect(res.output).toContain("Error:");
    expect(res.output).toContain("line 2");
    expect(res.output).toMatch(/verbatim|Do NOT guess/i);
    // 未命中绝不能写盘
    expect(readFileSync(file, "utf8")).toBe("line one\n    indented line\nline three\n");
  });

  it("完全不像时说找不到，并给出文件规模", async () => {
    const file = makeFile("f.txt", BASE);
    const tool = createEditFileTool();

    const res = await tool.execute(
      { path: file, oldString: "totally unrelated zzz", newString: "x" },
      makeCtx(),
    );

    expect(res.output).toMatch(/no similar content/i);
    expect(res.output).toMatch(/3 lines/);
  });
});
