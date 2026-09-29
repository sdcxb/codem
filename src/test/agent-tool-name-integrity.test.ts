/**
 * 门禁：agent 定义与工具管理器里出现的**工具名**必须是真实存在的工具 id。
 *
 * ## 为什么需要它
 *
 * 权限判定是**精确匹配**（`src/core/permission/permission.ts:176`
 * `if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;`），
 * 所以规则里写错一个名字的后果是**静默失效**：不报错、不警告，
 * 只是那条 allow 永远不命中，工具退回默认的 `ask`。
 *
 * 真实案例（本次修掉）：`src/core/agent/agent.ts` 与 `src/components/AgentManager.tsx`
 * 共 7 处写的是 `lsp_tool`，而 LSP 工具的真实 id 是 `lsp`
 * （`src/core/llm/tools/lsp-tool.ts:259` `id: "lsp"`）。
 * 于是三个只读子智能体的 `{ tool: "lsp_tool", action: "allow" }` **从未生效过**，
 * 同时 `toolAllowlist` 里的 `lsp_tool` 也永远匹配不到任何已注册工具。
 *
 * ## 为什么静态扫描够用
 *
 * 本门禁只检查**字面量**工具名（`"lsp"` 这种），而错名恰恰就是字面量写错。
 * 动态/变量拼出来的名字不在检查范围 —— 那属于另一类问题，不该在这里假装覆盖。
 *
 * 例外：`zvec_grep_search` / `zvec_grep_rg` 由 MCP 运行时注册，静态扫描看不到，
 * 必须从 `concurrency-policy.ts` 的 `DYNAMIC_TOOL_ID_ALLOWLIST` 取。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DYNAMIC_TOOL_ID_ALLOWLIST } from "../core/llm/concurrency-policy";

/**
 * 扫描 src/core 收集内置工具 id。
 *
 * ## ⚠️ 必须同时匹配单引号和双引号
 *
 * 这个扫描我第一版只匹配了 `id: "..."`（双引号），于是 `subagent-tools.ts` 里
 * `id: 'subagent'`、`id: 'report'`、`id: 'send_message'` … 全被漏掉，
 * 本门禁当场误报这些**真实存在**的工具是幽灵名。
 *
 * 仓库里两种引号风格并存（`tools.ts` 用双引号、`subagent-tools.ts` /
 * `note-operations.ts` 用单引号），所以扫描必须两种都收。
 * 教训与 `concurrency-policy.ts` 里那条同源：**扫不到 ≠ 不存在**，
 * 先用扫描结果去删东西之前，必须先证明扫描口径是对的。
 */
function collectBuiltinToolIds(): Set<string> {
  const ids = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/id:\s*["']([a-z][a-z_0-9]*)["']/g)) {
        ids.add(m[1]);
      }
    }
  };
  walk(join(__dirname, "..", "core"));
  return ids;
}

let realIds: Set<string>;

beforeAll(() => {
  realIds = collectBuiltinToolIds();
  for (const id of DYNAMIC_TOOL_ID_ALLOWLIST) realIds.add(id);
});

describe("agent 工具名必须是真实 id", () => {
  it("扫描到的 id 数量合理（先证明扫描有效，否则下面的断言会全绿）", () => {
    expect(realIds.size).toBeGreaterThan(50);
    for (const anchor of ["read", "write", "edit", "bash", "lsp"]) {
      expect(realIds.has(anchor)).toBe(true);
    }
  });

  it("agent.ts 的 toolAllowlist 与 permissions 不含幽灵名", () => {
    const src = readFileSync(join(__dirname, "..", "core", "agent", "agent.ts"), "utf8");
    const ghosts: string[] = [];

    // toolAllowlist: ["read", "glob", ...]
    for (const m of src.matchAll(/toolAllowlist:\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].matchAll(/"([^"]+)"/g)) {
        // `"*"` 是合法的通配（matchPattern 首行就处理它），不是工具名
        if (name[1] !== "*" && !realIds.has(name[1])) ghosts.push(name[1]);
      }
    }
    // permissions: [{ tool: "read", action: "allow" }, ...]
    for (const m of src.matchAll(/\{\s*tool:\s*"([^"]+)"/g)) {
      if (m[1] !== "*" && !realIds.has(m[1])) ghosts.push(m[1]);
    }

    expect(
      [...new Set(ghosts)],
      `agent.ts 里这些工具名不对应任何真实 id（权限规则会静默失效）：${[...new Set(ghosts)].join(", ")}`,
    ).toEqual([]);
  });

  it("AgentManager.tsx 的工具勾选清单不含幽灵名", () => {
    // 该文件里是一个「每行一个带引号工具名」的数组字面量。
    //
    // 第一版这里把**所有**这样的行都当工具名核对，于是把 `create_note` 等
    // 误判成幽灵名 —— 它们其实是真的，只是定义在 `note-operations.ts`
    // 且用**单引号**，被当时的扫描口径漏掉了。
    // 现在扫描两种引号都收，这个断言才真正在测「名字是否存在」。
    const src = readFileSync(
      join(__dirname, "..", "components", "AgentManager.tsx"),
      "utf8",
    );
    const ghosts: string[] = [];
    for (const m of src.matchAll(/^\s*["']([a-z][a-z_0-9]*)["'],\s*$/gm)) {
      if (!realIds.has(m[1])) ghosts.push(m[1]);
    }
    expect(
      [...new Set(ghosts)],
      `AgentManager.tsx 里这些工具名不对应任何真实 id：${[...new Set(ghosts)].join(", ")}`,
    ).toEqual([]);
  });

  it("lsp 的错名不会回归（曾用 lsp_tool，导致 3 个只读智能体的 allow 规则从未生效）", () => {
    for (const f of [
      join(__dirname, "..", "core", "agent", "agent.ts"),
      join(__dirname, "..", "components", "AgentManager.tsx"),
    ]) {
      expect(readFileSync(f, "utf8")).not.toContain("lsp_tool");
    }
  });

  it("LSP 工具的真实 id 就是 lsp（权限规则必须按这个写）", () => {
    const lspSrc = readFileSync(
      join(__dirname, "..", "core", "llm", "tools", "lsp-tool.ts"),
      "utf8",
    );
    expect(lspSrc).toMatch(/id:\s*"lsp"/);
    expect(realIds.has("lsp")).toBe(true);
    expect(realIds.has("lsp_tool")).toBe(false);
  });
});
