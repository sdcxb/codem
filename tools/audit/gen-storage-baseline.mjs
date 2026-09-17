/**
 * 生成 D 类（存储边界）迁移基线 allowlist（第 92 波）
 *
 * 迁移期允许清单**按文件**登记"待迁移模块"，每条写明理由与目标阶段；
 * 每迁移完一个模块就从清单里删掉它对应的条目（删不掉 = 迁移没做完，门禁会证明这一点）。
 *
 * 用法：node tools/audit/gen-storage-baseline.mjs [--apply]
 *   不带 --apply 时只打印将要写入的条目。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanStorageBoundary } from "./scan-storage-boundary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const ALLOWLIST = path.join(__dirname, "allowlist.json");

/** 按域给出理由与目标阶段（迁移顺序见 docs/ARCH-SQLITE-TO-RUST.md §3 P3） */
function describe(file) {
  if (file.endsWith("storage/database.ts")) {
    // 第 18 轮（L1）：这个文件已被删除。分支保留一行说明，免得有人以为它还该在清单里。
    return "（已删除）迁移期 WASM 实现本体：L1 收尾时随 sql.js 依赖一起移除";
  }
  if (file.includes("storage/port")) {
    return "端口定义本身（P0 新增，不含 SQL 访问）";
  }
  if (file.startsWith("src/core/storage/")) {
    return "P3-3 数据面核心（messages/events/sessions/attachments…）：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/core/knowledge/")) {
    return "P3-5 其余域（知识库/笔记/图谱）：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/core/issue/") || file.startsWith("src/core/inbox/") || file.startsWith("src/core/squad/")) {
    return "P3-5 其余域（议题/收件箱/小队）：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/core/auth/") || file.startsWith("src/core/goal/")) {
    return "P3-5 其余域（账号/目标）：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/core/session/")) {
    return "P3-4 会话与委派链路：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/core/telemetry/")) {
    return "P3-2 只追加面（遥测）：迁移后改为入队 + Rust 引擎";
  }
  if (file.startsWith("src/core/llm/")) {
    return "P3-4 Agentic Loop 链路（反馈/工具/计划）：迁移后改为仓储命令 + Rust 引擎";
  }
  if (file.startsWith("src/plugins/")) {
    return "P3-5 插件域（library-ops 等）：迁移后改为仓储命令 + Rust 引擎";
  }
  return "P3 待迁移模块：迁移后改为仓储命令 + Rust 引擎";
}

const result = scanStorageBoundary({ allowlist: { storageBoundary: [] } });
const files = [...new Set(result.findings.map((f) => f.file))].sort();

const entries = files.map((file) => ({
  file,
  reason: describe(file),
}));

if (!process.argv.includes("--apply")) {
  console.log(`将写入 ${entries.length} 条 D 类基线条目：`);
  for (const e of entries.slice(0, 12)) console.log(`  ${e.file}  →  ${e.reason}`);
  if (entries.length > 12) console.log(`  … 共 ${entries.length} 条`);
  process.exit(0);
}

const allow = JSON.parse(fs.readFileSync(ALLOWLIST, "utf8"));
allow.storageBoundary = entries;
fs.writeFileSync(ALLOWLIST, JSON.stringify(allow, null, 2) + "\n", "utf8");
console.log(`已写入 ${entries.length} 条 D 类基线条目到 tools/audit/allowlist.json`);
