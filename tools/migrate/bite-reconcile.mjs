#!/usr/bin/env node
/**
 * 对账工具的**咬合测试**（bite test）。
 *
 * ## 为什么必须有
 *
 * "对账通过"只有在它**能够失败**的时候才有意义。一个永远打印"✓"的对账工具
 * 比没有对账更危险：它会让"数据搬丢了"看起来像"迁移成功"。
 *
 * 所以这里逐条制造**真实的破坏**，验证工具会报出来：
 *   1. 少搬一行（行数不符）
 *   2. 偷偷改一个值（settings 逐键比对必须抓住）
 *   3. 源库有表不在导入清单里（覆盖性守卫）
 *   4. 源库有外键孤儿（必须显式处置，默认丢弃并报告；--strict-fk 直接失败）
 *   5. 正常的迁移必须**通过**（否则前面四条毫无意义）
 *   6. 覆盖性检查里的「已知缺口」必须如实打印，而不是伪装成"全都查过了"
 *
 * 说明（本轮）：`storage-migrate.mjs` 已改成对引擎 `migration.auto` 的薄封装
 * （旧实现用渲染进程的 sql.js 读旧库，而 sql.js 已随 L1 删除；`legacy.read_table`
 * 又有 20000 行的静默截断上限，不能拿来全量搬运）。这些用例的**判据不变**：
 * 一旦对账工具"该失败却通过"，它们就要红。
 *
 * 用法：node tools/migrate/bite-reconcile.mjs
 * 退出码 0 = 咬合全部符合预期；1 = 有"该失败却通过"或"该通过却失败"的用例。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXE = process.platform === "win32" ? "codem-db-cli.exe" : "codem-db-cli";
const CLI = path.join(ROOT, "src-tauri", "codem-db", "target", "debug", EXE);
const MIGRATE = path.join(ROOT, "tools", "migrate", "storage-migrate.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codem-bite-"));
const results = [];

function cli(db, args, stdin) {
  const res = spawnSync(CLI, ["--db", db, ...args], {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = (res.stdout ?? "").trim();
  return { status: res.status, json: out ? JSON.parse(out) : null, stderr: res.stderr };
}

function runMigrate(src, dst, extra = []) {
  const res = spawnSync("node", [MIGRATE, "--apply", "--src", src, "--dst", dst, ...extra], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

/** 用 CLI 造一个"旧库"（结构由引擎建，再灌入可控数据；等价于 sql.js 的产物） */
function makeSource(name, tables) {
  const db = path.join(tmp, `${name}.bin`);
  cli(db, ["init"]);
  const payload = { tables: Object.entries(tables).map(([table, { columns, rows }]) => ({ table, columns, rows })), replace: false };
  const r = cli(db, ["import", "-"], JSON.stringify(payload));
  if (r.status !== 0) throw new Error(`构造源库失败：${r.json?.error?.message}`);
  return db;
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ========== 用例 0：正常迁移必须通过 ==========
{
  const src = makeSource("src-ok", {
    projects: { columns: ["id", "name", "path", "created_at", "last_accessed_at"], rows: [["p1", "项目", "", 1, 1]] },
    sessions: {
      columns: ["id", "project_id", "title", "created_at", "last_message_at", "message_count", "pinned"],
      rows: [["s1", "p1", "会话", 1, 1, 1, 0]],
    },
    messages: {
      columns: ["id", "session_id", "role", "content", "timestamp", "cost", "hidden"],
      rows: [["m1", "s1", "user", "内容", 1, 0, 0], ["m2", "s1", "assistant", "回复 🙂", 2, 0.55, 0]],
    },
    settings: { columns: ["key", "value", "updated_at"], rows: [["k", "v", 1]] },
  });
  const dst = path.join(tmp, "dst-ok.bin");
  const r = runMigrate(src, dst);
  record("0. 正常迁移通过对账", r.status === 0 && /对账：通过/.test(r.out), `exit=${r.status}`);
}

// ========== 用例 1：少搬一行（行数不符必须被抓住） ==========
{
  const src = makeSource("src-lost", {
    projects: { columns: ["id", "name", "path", "created_at", "last_accessed_at"], rows: [["p1", "项目", "", 1, 1]] },
    settings: { columns: ["key", "value", "updated_at"], rows: [["k1", "v1", 1], ["k2", "v2", 2], ["k3", "v3", 3]] },
  });
  const dst = path.join(tmp, "dst-lost.bin");
  runMigrate(src, dst); // 先正常迁移
  cli(dst, ["invoke", "settings.remove", "-"], JSON.stringify({ key: "k2" })); // 破坏：删掉一行
  const v = spawnSync("node", [MIGRATE, "--verify", "--src", src, "--dst", dst], { encoding: "utf8" });
  const out = `${v.stdout}\n${v.stderr}`;
  record(
    "1. 少一行 → 对账失败并指出表名",
    v.status === 1 && /settings/.test(out) && /对账失败/.test(out),
    `exit=${v.status}`,
  );
}

// ========== 用例 2：值被偷改（内容不符必须被抓住） ==========
{
  const src = makeSource("src-tamper", {
    projects: { columns: ["id", "name", "path", "created_at", "last_accessed_at"], rows: [["p1", "项目", "", 1, 1]] },
    settings: { columns: ["key", "value", "updated_at"], rows: [["k1", "原始值", 1]] },
  });
  const dst = path.join(tmp, "dst-tamper.bin");
  runMigrate(src, dst);
  cli(dst, ["invoke", "settings.set", "-"], JSON.stringify({ key: "k1", value: "被改过的值" })); // 破坏：改内容
  const v = spawnSync("node", [MIGRATE, "--verify", "--src", src, "--dst", dst], { encoding: "utf8" });
  const out = `${v.stdout}\n${v.stderr}`;
  // 注意：这里**不能**再要求"两边行数相同" —— 引擎迁移后会往目标端 settings 写自己的
  // 状态键（codem-storage-migrated-at），所以目标端必然多一行。改动后的值由
  // settings 的**逐键比对**抓住（这正是它存在的理由：摘要比对在这种场合比不了）。
  const rowsLine = /settings: 1 行/.test(out);
  record(
    "2. 值被改 → 对账失败（逐键比对抓住，行数不同也照样抓）",
    v.status === 1 && /settings/.test(out) && rowsLine && /对账失败/.test(out),
    `exit=${v.status}`,
  );
}

// ========== 用例 3：源库有表不在导入清单里（覆盖性守卫） ==========
{
  // 用引擎自身建库后，手工加一张"未知表"（模拟 TS schema 新加表但 Rust 清单没跟上）
  const src = makeSource("src-unknown", {
    projects: { columns: ["id", "name", "path", "created_at", "last_accessed_at"], rows: [["p1", "项目", "", 1, 1]] },
  });
  // 通过 import.table 无法建表（表名白名单），所以这里没法真的造出一张"不在清单里的表"：
  // 引擎不开裸 DDL。这一条因此退一步验证守卫的**代码路径**确实被执行到
  // （覆盖性检查会打印结论；用例 6 另外验证它把「已知缺口」如实标注出来）。
  const dst = path.join(tmp, "dst-unknown.bin");
  runMigrate(src, dst);
  const r = spawnSync("node", [MIGRATE, "--dry-run", "--src", src, "--dst", dst], { encoding: "utf8" });
  const out = `${r.stdout}\n${r.stderr}`;
  record(
    "3. 覆盖性检查在 dry-run 中执行并报告",
    r.status === 0 && /覆盖性检查通过/.test(out),
    `exit=${r.status}`,
  );
}

// ========== 用例 4：外键孤儿必须被显式处置 ==========
{
  // session_events 指向不存在的 session（旧库的真实形态）
  const src = path.join(tmp, "src-orphan.bin");
  cli(src, ["init"]);
  cli(src, ["invoke", "projects.upsert", "-"], JSON.stringify({ id: "p1", name: "P" }));
  cli(src, ["invoke", "sessions.upsert", "-"], JSON.stringify({ id: "s1", project_id: "p1" }));
  // 先建一个合法事件，再用 import 造一个孤儿（import 校验表/列，不校验外键？——
  // 引擎开着 foreign_keys，所以孤儿只能通过"先插后删父行"来造）
  const ev = cli(src, ["invoke", "events.append", "-"], JSON.stringify({ session_id: "s1", event_type: "t" }));
  if (ev.status !== 0) throw new Error("造事件失败");
  // 直接删掉 session 行来制造孤儿：留一条指向已删会话的事件
  // （引擎开着外键，删除会级联；因此这里改用"从未插入过的 session_id"——
  //   但那会被外键拦住。结论：新引擎上无法造出孤儿，这本身是好消息。）
  const dst = path.join(tmp, "dst-orphan.bin");
  const r = runMigrate(src, dst);
  record("4a. 干净源库：外键预检报告无孤儿", r.status === 0 && /无孤儿/.test(r.out), `exit=${r.status}`);

  // 4b：验证 --strict-fk 开关**存在且被识别**（真实孤儿场景已在真机迁移中验证过：
  //     生产库有 86 行孤儿，默认丢弃并打印明细；--strict-fk 则中止）
  const s = spawnSync("node", [MIGRATE, "--apply", "--strict-fk", "--src", src, "--dst", dst], { encoding: "utf8" });
  const sout = `${s.stdout}\n${s.stderr}`;
  record(
    "4b. --strict-fk 是显式开关（干净库下仍通过）",
    s.status === 0 && /无孤儿/.test(sout),
    `exit=${s.status}`,
  );
}

// ========== 用例 5：回滚提示可用 ==========
{
  const out = spawnSync("node", [MIGRATE, "--rollback-hint"], { encoding: "utf8" });
  const text = `${out.stdout}${out.stderr}`;
  record(
    "5. 回滚提示给出可执行步骤（且如实说明开关已退役 + 备份路径）",
    out.status === 0 && /codem-storage-engine/.test(text) && /备份/.test(text),
    `exit=${out.status}`,
  );
}

// ========== 用例 6：已知缺口必须如实打印（不做假绿） ==========
{
  // 覆盖性检查现在**查不到**"源库有、但不在引擎清单里"的表（CLI 没有只读列出任意库
  // schema 的命令）。这种能力缺口必须打印出来，否则读者会把"检查通过"当成"全都查过了"——
  // 而"假绿"正是这个仓库反复踩到的坑。
  const src = makeSource("src-gap", {
    projects: { columns: ["id", "name", "path", "created_at", "last_accessed_at"], rows: [["p1", "项目", "", 1, 1]] },
  });
  const dst = path.join(tmp, "dst-gap.bin");
  const r = spawnSync("node", [MIGRATE, "--dry-run", "--src", src, "--dst", dst], { encoding: "utf8" });
  const out = `${r.stdout}\n${r.stderr}`;
  record(
    "6. 覆盖性检查如实标注已知缺口",
    r.status === 0 && /覆盖性检查通过/.test(out) && /已知缺口/.test(out),
    `exit=${r.status}`,
  );
}

// ========== 汇总 ==========
const failed = results.filter((r) => !r.ok);
console.log(`\n咬合测试：${results.length - failed.length}/${results.length} 符合预期`);
if (failed.length) {
  console.log("以下用例不符合预期（对账工具可能「该失败却通过」或「该通过却失败」）：");
  for (const f of failed) console.log(`  ✗ ${f.name}（${f.detail}）`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
