/**
 * 判据用的"内容搜索"实现：真实 Node fs 上做一个朴素的全仓库子串搜索（第 124 波）。
 *
 * 为什么需要它：生产里这一节用应用自己的 `grepSearch`（Tauri IPC ✓，与 `grep` 工具同一条路 ✓），
 * 而 Vitest 里没有那套 IPC ✗ ⇒ 判据注入这个真实实现 ✓。
 *
 * 只在 `src/test/helpers/` 下 ⇒ **不在** FSG-1 门禁范围 ✓（门禁只扫 `src/core/llm/**` 的生产文件 ✓），
 * 所以这里用 `node:fs` 是允许的 ✓ —— 它就是"判据侧的真搜索" ✓。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", "dist", "build", "target", "coverage", "out", "vendor", "third_party"]);
const MAX_FILES = 4000;
const MAX_BYTES = 64 * 1024;

/**
 * 返回形如 `相对路径:行号: 内容` 的匹配行（与 `grepSearch` 的返回形状一致 ✓）。
 */
export function nodeGrepSource() {
  return async (pattern: string, root: string): Promise<string[]> => {
    const out: string[] = [];
    let scanned = 0;
    const walk = (dir: string, prefix: string, depth: number): void => {
      if (depth > 12 || scanned >= MAX_FILES) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (scanned >= MAX_FILES) return;
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, rel, depth + 1);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md)$/.test(e.name)) continue;
        try {
          if (statSync(full).size > MAX_BYTES) continue;
        } catch {
          continue;
        }
        scanned++;
        let text = "";
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (!text.includes(pattern)) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
            break; // 每个文件只留第一条，够定位就行
          }
        }
      }
    };
    walk(root, "", 0);
    return out;
  };
}
