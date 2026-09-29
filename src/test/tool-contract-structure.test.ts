/**
 * 门禁：契约声明的**结构完整性**。
 *
 * ## 这个门禁是为什么存在的
 *
 * 第 120/121 轮用脚本批量把 `contract: { … }` 插进 57 个工具定义。批量改写的
 * 真实事故（都发生过）：
 *
 * - 插入时凭空多出一行空行（`id` 与 `contract` 之间），看着无害但让后续
 *   正则/审计全部错位；
 * - 清理旧契约的正则只匹配了单行，把**多行**契约的 `contract: {` 那行孤立地
 *   留在文件里，同时吃掉了一个 `\r` ⇒ 出现「两行被连成一行」的畸形
 *   （`… },\r  guidance: …`）；
 * - 清理时只认 CRLF，遇到裸 LF 的残留就漏掉。
 *
 * 这三类都不影响类型检查（畸形仍在字符串里），所以必须有**独立的结构判据**。
 *
 * ## 第 121 轮：允许多行契约
 *
 * 给 `glob` 注册 `outputSchema` 之后，契约自然是多行的（含 schema 与渲染函数）。
 * 所以判据从「必须是单行」改为「**花括号必须配平**」，并保留「不得有空行残留」。
 * 只放宽"必须单行"这一条，其余不变 —— 放宽标准要有理由，且理由要写下来。
 */
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

/** 从 `contract: {` 起按花括号配平找到结束行；返回 null 表示未配平。 */
function contractEndLine(lines: string[], startIdx: number): number | null {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) return i;
  }
  return null;
}

describe("契约插入的结构完整性", () => {
  it("每个 id 后面的 contract 必须花括号配平、且 id 与 contract 之间无空行", () => {
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

        // 允许 id 块本身空一行（非契约工具的常见格式）；但空行后紧跟 contract
        // 就是批量插入留下的残迹
        let nextIdx = i + 1;
        if ((lines[nextIdx] ?? "") === "") {
          if (/^\s*contract:/.test(lines[nextIdx + 1] ?? "")) {
            problems.push(`${f}:${nextIdx + 1} id 与 contract 之间有空行（插入残留）`);
            nextIdx += 1;
          } else {
            continue; // 该工具没有契约
          }
        }
        if (!/^\s*contract:/.test(lines[nextIdx] ?? "")) continue;

        const end = contractEndLine(lines, nextIdx);
        if (end === null) {
          problems.push(`${f}:${nextIdx + 1} contract 花括号未配平`);
          continue;
        }
        // 结束行必须是一个以 `},` 收尾的属性（否则后面还粘着别的东西）
        if (!/\},$/.test(lines[end])) {
          problems.push(
            `${f}:${end + 1} contract 结束后一行不是 \`},\`：${lines[end].trim().slice(0, 60)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("不存在「被吞掉的行边界」（行内出现裸 \\r 把两行连成一行）", () => {
    const files = walk(join(__dirname, "..", "core"));
    const problems: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      // 逐行看：行内（非末尾）出现 \r 就是畸形。此前批量清理时出现过
      // `… },\r  guidance: …` 这种"两行连成一行"的形态。
      const lines = raw.split(/\n/);
      lines.forEach((line, i) => {
        const inner = line.replace(/\r$/, "");
        if (inner.includes("\r")) {
          problems.push(`${f}:${i + 1} 行内出现裸 \\r（行边界被吞）`);
        }
      });
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
