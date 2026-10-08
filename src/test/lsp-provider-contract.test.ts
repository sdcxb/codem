/**
 * ★ 第 185 波（复审发现的新 bug）：**`ctx.lsp.*` 的参数名必须与工具 schema 一致**。
 *
 * ## 缺陷形态（复审取证，已在真机代码里确认）
 *
 * `lsp-tool` 的入参 schema 是 `{file, line, column, symbol}`，而 `lsp-provider` 传的是
 * `{filePath, line, character}` / `{filePath}` / `{query}` ⇒ `args.file` 恒 undefined
 * ⇒ **五个方法必然返回错误串**（`ctx.lsp.*` 整条对外通道是死的）。
 * 它藏得住的原因是文件头的 `// @ts-nocheck`（类型系统看不见参数不匹配）——
 * 本次修复同时去掉了那行，并补了可选 `cwd`（否则经这条入口读文件会绕过工作区检查）。
 *
 * ## 判据为什么这么写
 *
 * 断言的是**实际传给工具的实参形状**（用替身截获 `execLspTool` 的调用），
 * 而不是"文件里出现了 file: 字样" —— 后者正是第 184 波复审抓到的
 * "判据与实现互相证明"的假绿形态：把 `filePath` 改回 `file` 也不会让它变红。
 * LSPP-4 是反向对照：那几个**错的**名字一旦回来就必须红。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ op: string; args: Record<string, unknown>; cwd?: string }> = [];

vi.mock("../core/llm/tools/lsp-tool", () => ({
  execLspTool: async (op: string, args: Record<string, unknown>, cwd?: string) => {
    calls.push({ op, args, cwd });
    return "ok";
  },
}));

import { lspProvider } from "../core/provider/lsp-provider";

function mountProvider() {
  const provided: Record<string, any> = {};
  const ctx = {
    provide: (name: string, api: any) => {
      provided[name] = api;
      return () => {};
    },
  };
  lspProvider(ctx as any);
  return provided.lsp;
}

describe("第 185 波 · ctx.lsp 的参数契约", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("LSPP-1: hover/definition/references 必须传 `{file,line,column}`（不是 filePath/character）", async () => {
    const lsp = mountProvider();
    await lsp.hover("/ws/a.ts", 3, 5);
    await lsp.definition("/ws/a.ts", 1, 2);
    await lsp.references("/ws/a.ts", 7, 8);

    expect(calls.map((c) => c.op)).toEqual(["hover", "definition", "references"]);
    for (const c of calls) {
      expect(c.args, `${c.op} 必须给 \`file\`（工具 schema 的名字）`).toHaveProperty("file", "/ws/a.ts");
      expect(c.args).toHaveProperty("line");
      expect(c.args, `${c.op} 必须给 \`column\``).toHaveProperty("column");
    }
    expect(calls[0].args, "hover 的 column 应来自第三个实参").toMatchObject({ line: 3, column: 5 });
  });

  it("LSPP-2: workspaceSymbols 必须传 `{symbol}`（不是 query）", async () => {
    const lsp = mountProvider();
    await lsp.workspaceSymbols("MyClass");
    expect(calls[0].args, "工具 schema 里这个字段叫 symbol").toEqual({ symbol: "MyClass" });
  });

  it("LSPP-3: documentSymbols 必须传 `{file}`，并且 cwd 要透传（否则沙箱不生效）", async () => {
    const lsp = mountProvider();
    await lsp.documentSymbols("/ws/b.ts", "/ws");
    expect(calls[0].args).toEqual({ file: "/ws/b.ts" });
    expect(calls[0].cwd, "调用方给了工作区就必须传下去（读侧沙箱靠它）").toBe("/ws");
  });

  it("LSPP-4 反向对照：那几个**错的**字段名一旦回来就必须红（这条专治历史 bug）", async () => {
    const lsp = mountProvider();
    await lsp.hover("/ws/a.ts", 3, 5);
    await lsp.documentSymbols("/ws/a.ts");
    await lsp.workspaceSymbols("X");

    const all = JSON.stringify(calls.map((c) => c.args));
    expect(all, "不许再出现 filePath（工具 schema 没有这个字段）").not.toContain("filePath");
    expect(all, "不许再出现 character（工具 schema 用的是 column）").not.toContain("character");
    expect(all, "不许再出现 query（工具 schema 用的是 symbol）").not.toContain("query");
  });

  it("LSPP-5: 不传 cwd 时不许伪造一个（保持「不知道工作区就不检查」的既有语义）", async () => {
    const lsp = mountProvider();
    await lsp.hover("/ws/a.ts", 1, 1);
    expect(calls[0].cwd).toBeUndefined();
  });
});
