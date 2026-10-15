/**
 * BOM-1：仓库里的文本文件**不许带 UTF-8 BOM**。
 *
 * ## 为什么要有这条（真机踩过）
 * 构建在 `vite build` 阶段失败：
 *   `Failed to load PostCSS config ... Unexpected token '\ufeff', "﻿{\n  "nam"... is not valid JSON`
 * 根因 = `package.json` 开头多了 BOM（PostCSS 在没有专门配置时会去 package.json 里找 postcss 段，
 * 于是那个 BOM 直接让 JSON.parse 失败）—— 而**类型检查与全量测试都是绿的**，
 * 这类问题只有真去构建才暴露 ⇒ 必须有机器判据。
 *
 * 顺带扫出来 55 个带 BOM 的文件（多数是历史遗留），全部剥掉。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "target", ".preview-shot", "dist", "coverage", ".tauri"]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".toml", ".rs", ".yml", ".yaml", ".txt",
]);

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".editorconfig") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out, depth + 1);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

describe("BOM-1 文本文件不许带 BOM", () => {
  it("全仓扫描：带 BOM 的文本文件必须为 0（它会炸掉 JSON/PostCSS 这类解析）", () => {
    const offenders: string[] = [];
    for (const f of walk(ROOT)) {
      let buf: Buffer;
      try {
        buf = fs.readFileSync(f);
      } catch {
        continue;
      }
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        offenders.push(path.relative(ROOT, f));
      }
    }
    expect(offenders, `这些文件开头有 BOM（构建会在 vite/JSON 解析阶段失败）：\n${offenders.join("\n")}`).toEqual([]);
  });
});
