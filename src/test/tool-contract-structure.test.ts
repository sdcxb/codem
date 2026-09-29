import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") || f.endsWith(".tsx")) out.push(f);
  }
  return out;
}

describe("契约插入的结构完整性", () => {
  it("每个 id 后面紧跟的 contract 都必须是完整单行、且 id 与 contract 之间无空行", () => {
    const files = walk(join(__dirname, "..", "core"));
    const problems: string[] = [];
    for (const f of files) {
      // 按行切分后先剥掉行尾空白 —— 本仓同时存在 LF 与 CRLF 文件，
      // 带着 \r 去匹配闭合会假红（第一版就是这么错的）
      const lines = readFileSync(f, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trimEnd());
      for (let i = 0; i < lines.length; i++) {
        if (!/^\s*id:\s*['"][a-z_0-9]+['"],$/.test(lines[i])) continue;
        const next = lines[i + 1] ?? "";
        if (next === "") {
          // 非契约工具允许 id 块本身空一行；但空行后紧跟 contract 就是插入残留
          if (/^\s*contract:/.test(lines[i + 2] ?? "")) {
            problems.push(`${f}:${i + 2} id 与 contract 之间有空行（插入残留）`);
          }
          continue;
        }
        if (/^\s*contract:/.test(next) && !/\},$/.test(next)) {
          problems.push(`${f}:${i + 2} contract 未闭合于单行: ${next.trim()}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("契约条数合理（防止批量插入只成功了一部分）", () => {
    const files = walk(join(__dirname, "..", "core"));
    let n = 0;
    for (const f of files) {
      n += (readFileSync(f, "utf8").match(/^\s*contract:\s*\{/gm) ?? []).length;
    }
    console.log(`\n契约条数: ${n}\n`);
    expect(n).toBeGreaterThanOrEqual(50);
  });
});
