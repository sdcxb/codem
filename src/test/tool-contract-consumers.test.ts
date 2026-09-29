/**
 * 门禁：`ToolContract` 的每个字段都必须**有真实消费者**。
 *
 * ## 为什么要这条
 *
 * 这次契约化的动因，是本仓反复出现的同一类缺陷：**看起来在工作、其实没接线**。
 * 本轮之前已经数出八处（`$` 记号静默改坏文件、`oldString not found` 无可行动信息、
 * 调度顺序被打乱、并发名单幽灵名、`lsp_tool` 错名、永不生效的
 * `threshold = 80000`、`goalSummary` 只打日志不注入、`output-contract`
 * 建好框架但没有任何工具注册契约）。
 *
 * 契约化本身最容易复现这个病：照抄 zcode 的 15 个字段，然后有四五个字段
 * **没有任何读取方** —— 那就只是把「七组名单」换成「一堆空壳字段」。
 * 所以这里把「每个字段必须有消费者」变成机器判据。
 *
 * ## 判据形状
 *
 * 从 `ToolContract` 接口里**解析出字段名**（而不是手写一份清单 ——
 * 手写清单会在有人加字段时忘记同步），然后断言每个字段名在
 * **消费者文件**里被读取过。
 *
 * 消费者文件是显式列出的白名单：新增消费者时要更新它，这本身是有意的摩擦
 * ——「这个字段谁在读」必须是个能被回答的问题。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTRACT_SRC = join(__dirname, "..", "core", "llm", "tool-contract.ts");

/**
 * 允许「读取契约字段」的文件。
 *
 * - `tool-contract.ts`：解析默认值的地方（`resolveToolContract`）
 * - 下面几个是真正的消费者
 */
const CONSUMER_FILES = [
  "src/core/llm/tool-contract.ts",
  "src/core/llm/streaming-executor.ts",
  "src/core/llm/tool-pipeline.ts",
  "src/core/llm/tool-result-storage.ts",
  "src/core/llm/agentic-loop.ts",
];

/** 从 `export interface ToolContract { … }` 里取字段名。 */
function declaredFields(): string[] {
  const src = readFileSync(CONTRACT_SRC, "utf8");
  const start = src.indexOf("export interface ToolContract {");
  expect(start, "找不到 ToolContract 接口").toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf("\n}", start));
  const fields: string[] = [];
  for (const m of body.matchAll(/^\s{2}(\w+)\??:/gm)) {
    fields.push(m[1]);
  }
  return fields;
}

describe("契约字段必须都有消费者（防造空壳）", () => {
  const fields = declaredFields();

  it("解析到了字段（证明解析本身有效，否则下面会全部空转）", () => {
    expect(fields.length).toBeGreaterThanOrEqual(5);
    // 几个确定存在的锚点
    expect(fields).toContain("readOnly");
    expect(fields).toContain("timeoutMs");
  });

  it("每个字段都在消费者里被读过", () => {
    const consumers = CONSUMER_FILES.map((rel) => ({
      rel,
      text: readFileSync(join(__dirname, "..", "..", rel), "utf8"),
    }));

    const orphans: string[] = [];
    for (const field of fields) {
      // 在**除 tool-contract.ts 之外**的消费者里找读取点：
      // 只看 `c.<field>` / `contract.<field>` / `<field>:` 这类访问形态
      const readPattern = new RegExp(`\\.${field}\\b`);
      const readByNonResolver = consumers.some(
        (c) => c.rel !== "src/core/llm/tool-contract.ts" && readPattern.test(c.text),
      );
      if (!readByNonResolver) orphans.push(field);
    }

    expect(
      orphans,
      `这些契约字段没有任何消费者 —— 加了只会是空壳（本轮已修过 8 处「建了没接线」）：${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("消费者白名单里的文件都真实存在（防白名单过期）", () => {
    for (const rel of CONSUMER_FILES) {
      expect(() => readFileSync(join(__dirname, "..", "..", rel), "utf8"), `${rel} 不存在`).not.toThrow();
    }
  });
});
