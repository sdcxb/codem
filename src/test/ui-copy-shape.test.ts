/** 文案形制门禁：placeholder 不是句子，别用 "搜索技能..." 这类拖尾省略号。 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, surfaceFiles } from "./helpers/ui-text-scan";

const PLACEHOLDER = /placeholder=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;

describe("UI 文案形制：placeholder", () => {
  it("不以省略号收尾（URL 模板除外）", () => {
    const hits: string[] = [];
    for (const rel of surfaceFiles()) {
      if (!rel.endsWith(".tsx")) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      for (const m of source.matchAll(PLACEHOLDER)) {
        const text = m[1] ?? m[2] ?? m[3] ?? "";
        if (/^https?:\/\//.test(text)) continue;
        if (/(?:\.\.\.|…)\s*$/.test(text)) hits.push(`${rel}: ${text}`);
      }
    }
    expect(hits, `placeholder 不要拖省略号：\n  ${hits.join("\n  ")}`).toEqual([]);
  });
});
