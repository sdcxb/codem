/**
 * 门禁：并发安全名单里的每个名字都必须是**真实存在的工具 id**，
 * 且默认配置不得与权威名单分叉。
 *
 * ## 为什么需要它
 *
 * `concurrency-policy.ts` 出现之前，同一个名单在三处各自硬编码，而且两份主名单里
 * **大多数名字不对应任何真实工具**：
 *
 * - `streaming-executor.ts` 默认名单 9 个 → 真实存在的只有 `read` / `grep` / `glob` / `lsp`
 * - `tool-pipeline.ts` 名单 9 个 → 真实存在的只有 `read` / `grep` / `glob` / `web_search`
 *
 * 幽灵名（`read_file`、`list_directory`、`codebase_search`、`web_fetch` …）不会报错、
 * 不会警告，只是**静默地把本该并行的调用串行化**，同时让读代码的人以为
 * 「所有只读工具都能并行」。而真实存在且只读的 `web_search` 反而不在任何名单里。
 *
 * 这类错误无法靠类型系统发现（都是 `string[]`），所以必须有一道
 * 「名单 vs 真实 id 全集」的交叉核对。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CONCURRENCY_SAFE_TOOL_IDS,
  DEFAULT_CONCURRENCY_SAFE_TOOLS,
  DYNAMIC_TOOL_ID_ALLOWLIST,
} from "../core/llm/concurrency-policy";

/**
 * 扫描 `src/core/**` 收集所有**内置**工具 id。
 *
 * ## 口径的边界（重要，别把这个扫描当权威）
 *
 * 工具工厂里写的是 `id: "xxx"`，所以这个正则在源码里能看到**内置工具**的全部 id。
 * 但它**看不到运行时注册的工具** —— 典型是 MCP 提供的那些：
 * `tools/zvec-tool.ts` 的 `createZvecTool()` 写的是 `id: name`，而 `name` 是运行时
 * 从 zvec-grep MCP 服务器拿到的，源码里没有字面量。
 *
 * 这条边界不是假设，是踩过的坑：我第一版门禁只信这个扫描，于是把真实存在的
 * `zvec_grep_search` 判成了幽灵名删掉，`zvec-tool-sync.test.ts` 当场变红。
 * 所以扫描结果必须并上 `DYNAMIC_TOOL_ID_ALLOWLIST` 才能当「真实 id 全集」用。
 */
function collectBuiltinToolIds(): Set<string> {
  const ids = new Set<string>();
  const root = join(__dirname, "..", "core");

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const text = readFileSync(full, "utf8");
      // 两种引号都要收：本仓 `tools.ts` 用双引号，`subagent-tools.ts` /
      // `note-operations.ts` 用单引号。第一版只收双引号，把单引号文件的工具
      // 全漏了，导致误报（详见 agent-tool-name-integrity.test.ts 的注释）。
      for (const m of text.matchAll(/id:\s*["']([a-z][a-z_0-9]*)["']/g)) {
        ids.add(m[1]);
      }
    }
  };

  walk(root);
  return ids;
}

let realIds: Set<string>;

beforeAll(() => {
  realIds = collectBuiltinToolIds();
  // 并上运行时注册的 id，才是「真实 id 全集」
  for (const id of DYNAMIC_TOOL_ID_ALLOWLIST) realIds.add(id);
});

describe("并发安全名单：每个名字都必须是真实工具 id", () => {
  it("扫描到的内置 id 数量合理（证明扫描确实读到了文件）", () => {
    // 如果扫描写错了目录，realIds 会是空的，下面的断言就会「全部通过」——
    // 这正是假绿。所以先钉住「扫描到了东西」。
    expect(realIds.size).toBeGreaterThan(50);
    // 几个一定存在的核心工具作为锚点
    for (const anchor of ["read", "write", "edit", "grep", "glob", "bash"]) {
      expect(realIds.has(anchor)).toBe(true);
    }
  });

  it("名单里没有幽灵名", () => {
    const ghosts = CONCURRENCY_SAFE_TOOL_IDS.filter((n) => !realIds.has(n));
    expect(
      ghosts,
      `以下名字不对应任何真实工具（历史上就是这么混进名单的）：${ghosts.join(", ")}`,
    ).toEqual([]);
  });

  it("已知的幽灵名不会回归", () => {
    // 这些名字被 UI 的 switch / micro-compact 的 case 防御性处理过，
    // 看起来像"支持"，所以特别容易被再次写进名单。
    //
    // 注意 zvec_grep_search / zvec_grep_rg **不在此列**：它们是真的（MCP 提供），
    // 只是静态扫描看不到。把它们当幽灵名删掉正是我犯过的错。
    const knownGhosts = [
      "read_file",
      "list_directory",
      "list_dir",
      "codebase_search",
      "file_search",
      "web_fetch",
    ];
    for (const g of knownGhosts) {
      expect(CONCURRENCY_SAFE_TOOL_IDS).not.toContain(g);
    }
  });

  it("zvec 搜索工具必须留在名单里（曾经被我误删）", () => {
    // zvec-tool-sync.test.ts 守着这条。它红了说明这是真回归，不是测试过时。
    for (const z of ["zvec_grep_search", "zvec_grep_rg"]) {
      expect(CONCURRENCY_SAFE_TOOL_IDS, `${z} 应当可并发`).toContain(z);
    }
  });

  it("动态 id 例外名单里的每个名字都必须在并发名单或 MCP 工具面里说得通", () => {
    // 例外名单本身也要防滥用：它只能是 MCP/运行时来源，
    // 不能变成「扫描失败就往这儿塞」的后门。这里断言它与并发名单一致。
    for (const id of DYNAMIC_TOOL_ID_ALLOWLIST) {
      expect(CONCURRENCY_SAFE_TOOL_IDS).toContain(id);
    }
  });

  it("真正只读且已存在的工具必须在名单里（web_search 曾整体缺席）", () => {
    for (const must of ["read", "grep", "glob", "web_search"]) {
      expect(CONCURRENCY_SAFE_TOOL_IDS, `${must} 应当可并发`).toContain(must);
    }
  });

  it("有副作用的工具绝不在名单里", () => {
    for (const unsafe of ["write", "edit", "multi_edit", "bash"]) {
      expect(CONCURRENCY_SAFE_TOOL_IDS).not.toContain(unsafe);
    }
  });

  it("默认配置与权威名单一致（防止两份真相再次分叉）", () => {
    expect(DEFAULT_CONCURRENCY_SAFE_TOOLS).toEqual([...CONCURRENCY_SAFE_TOOL_IDS]);
  });
});
