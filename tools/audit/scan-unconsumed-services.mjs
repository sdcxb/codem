#!/usr/bin/env node
/**
 * 服务级可达性门禁：`ctx.provide('x')` 之后**必须有人读**（`get('x')` / `ctx.x`）。
 *
 * ## 为什么需要（第 16 轮根因）
 *
 * `reachability-scan` 只看「文件有没有被 import」：provider 被 `builtin-registry` /
 * `config/codem.base.yml` 引用 ⇒ 文件级可达 ⇒ 门禁绿。但一个插件可以**装配了、服务也
 * provide 了，却没有任何消费方** —— `@codem/sandbox-policy` 就是这样活了十几个版本：
 * 启动日志、市场条目、单测全都在，命令却一条都没拦过。
 *
 * 本脚本把判据下沉到**服务**这一层：provide 了没人 get 的服务列为「死服务」；
 * 基线里的存量允许存在（历史债务），但**新增**一个死服务就会红。
 *
 * ## 判据边界（如实写）
 *
 * - 只识别字面量 `ctx.provide('name')` 与 `get('name')` / `ctx.name`；
 *   通过变量拼接的动态 `get` 识别不到 ⇒ 可能把「动态消费」误报为死服务（基线兜底）。
 * - `inject: ['x']` **不算消费**：它只保证依赖已提供，不代表有人读（sandbox 那族正是
 *   靠 inject 看起来“有人用”）。
 * - 测试、注册表、市场目录不算消费方（否则死代码会被自己的登记表“救活”）。
 *
 * 用法：
 *   node tools/audit/scan-unconsumed-services.mjs            # 打印死服务
 *   node tools/audit/scan-unconsumed-services.mjs --check    # 门禁：新增死服务 ⇒ 红
 *   node tools/audit/scan-unconsumed-services.mjs --write    # 重建基线（只在有意删除后）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const BASELINE = path.join(HERE, "unconsumed-services-baseline.json");

/** 测试、注册表、市场目录：它们的引用不算「生产消费方」 */
const IGNORED = [
  /(^|[\\/])src[\\/]test[\\/]/,
  /(^|[\\/])src[\\/]core[\\/]plugin-loader[\\/]builtin-registry\.ts$/,
  /(^|[\\/])src[\\/]core[\\/]provider[\\/]plugin-registry-provider\.ts$/,
  /(^|[\\/])src[\\/]core[\\/]plugin-market[\\/]dsh-market-catalog\.ts$/,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 纯函数：给定文件内容，返回未被读取的服务（便于单测与变异） */
export function findDeadServices(files) {
  const provided = [];
  const texts = [];
  for (const [file, text] of files) {
    texts.push([file, text]);
    if (/(^|[\\/])src[\\/]core[\\/]provider[\\/][^\\/]+\.ts$/.test(file)) {
      for (const m of text.matchAll(/ctx\.provide\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
        provided.push({ service: m[1], provider: file });
      }
    }
  }
  const dead = [];
  for (const item of provided) {
    const reGet = new RegExp("get\\(\\s*['\"]" + item.service + "['\"]");
    const reProp = new RegExp("ctx\\." + item.service + "\\b");
    let read = false;
    for (const [file, text] of texts) {
      if (file === item.provider) continue;
      if (IGNORED.some((re) => re.test(file))) continue;
      if (reGet.test(text) || reProp.test(text)) {
        read = true;
        break;
      }
    }
    if (!read) dead.push(item);
  }
  return dead.sort((a, b) => a.service.localeCompare(b.service));
}

export function scan() {
  const files = walk(path.join(ROOT, "src")).map((f) => [
    f.replace(/\\/g, "/"),
    fs.readFileSync(f, "utf8"),
  ]);
  return findDeadServices(files);
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return { services: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    return { services: parsed.services ?? {} };
  } catch {
    return { services: {} };
  }
}

function writeBaseline(dead) {
  const services = {};
  for (const item of dead) {
    const rel = path.relative(ROOT, item.provider).replace(/\\/g, "/");
    services[item.service] = { provider: rel, reason: "legacy-dead-service" };
  }
  const doc = {
    _doc:
      "服务级可达性基线：这些 service 被 ctx.provide 了但没有任何生产读取方。" +
      "新增条目会让 scan-unconsumed-services --check 变红；删掉 provider 或补上消费方后跑 --write 收缩。",
    generated_at: new Date().toISOString(),
    services,
  };
  fs.writeFileSync(BASELINE, JSON.stringify(doc, null, 1) + "\n", "utf8");
  console.log(`baseline written: ${dead.length} dead services -> ${path.relative(ROOT, BASELINE)}`);
}

const argv = process.argv.slice(2);
const dead = scan();
const baseline = loadBaseline();
const baselineNames = new Set(Object.keys(baseline.services));
const deadNames = new Set(dead.map((d) => d.service));

if (argv.includes("--write")) {
  writeBaseline(dead);
  process.exit(0);
}

if (argv.includes("--check")) {
  const added = dead.filter((d) => !baselineNames.has(d.service));
  const removed = [...baselineNames].filter((n) => !deadNames.has(n));
  if (removed.length) {
    console.log(`（基线里有 ${removed.length} 个服务已不再 dead，可跑 --write 收缩：${removed.join(", ")}）`);
  }
  if (added.length) {
    console.error("新增了「provide 了但没人 get」的服务：");
    for (const d of added) console.error(`  - ${d.service}  (${path.relative(ROOT, d.provider)})`);
    console.error("处置：补上消费方（get('服务名')），或证明它只是目录条目后跑 --write 登记基线。");
    process.exit(1);
  }
  console.log(`✅ 服务级可达性通过（存量 dead ${dead.length} 个，均已在基线）`);
  process.exit(0);
}

console.log(`dead services: ${dead.length}`);
for (const d of dead) console.log(`  ${d.service.padEnd(30)} ${path.relative(ROOT, d.provider)}`);
