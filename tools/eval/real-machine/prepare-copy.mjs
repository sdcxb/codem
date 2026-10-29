/**
 * 真机验证的**隔离副本**准备（只读真实数据根，所有写入都落在副本）。
 *
 * 用法：
 *   node tools/eval/real-machine/prepare-copy.mjs <目标根目录> [选项]
 *
 * 选项：
 *   --window <n>       把副本里 deepseek-flash 的 contextWindow 改成 n（默认不改）
 *   --threshold <0..1> 改副本的压缩阈值（默认不改）
 *   --seed <n>         造一个含 n 条消息（每条 5000 字）的合成会话
 *   --workdir          造一个隔离工作区 + 项目，并把"上次项目"指向它
 *
 * 关键：复制完 **checkpoint WAL 并删掉 -shm**。直接带着 -shm 启动会让 SQLite
 * 以为旧进程还持有锁 —— 真机实测会出现 `fts.upsert / messages.upsert_index`
 * 超过 60 秒的 IPC 超时（写入被放弃，副本丢消息）。这不是产品缺陷，是复制方式的问题。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [, , destRoot, ...rest] = process.argv;
if (!destRoot) {
  console.error("用法: node prepare-copy.mjs <目标根目录> [--window n] [--threshold x] [--seed n] [--workdir]");
  process.exit(2);
}
const flag = (name, fallback = null) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] ?? fallback : fallback;
};
const has = (name) => rest.includes(name);
const windowSize = flag("--window") ? Number(flag("--window")) : null;
const threshold = flag("--threshold") ? Number(flag("--threshold")) : null;
const seedCount = flag("--seed") ? Number(flag("--seed")) : 0;

const appRoot = path.join(process.env.APPDATA, "com.codem.app");
const dataDir = path.join(destRoot, "data");
fs.mkdirSync(destRoot, { recursive: true });
if (fs.existsSync(dataDir)) {
  console.error(`目标已存在，拒绝覆盖：${dataDir}`);
  process.exit(3);
}
fs.cpSync(appRoot, dataDir, { recursive: true });

const dbPath = path.join(dataDir, "codem-db-rust.bin");
const db = new DatabaseSync(dbPath);
/** 关键：checkpoint 掉副本里的 WAL，再删 -shm（见文件头） */
try {
  db.exec("pragma wal_checkpoint(TRUNCATE)");
} catch (e) {
  console.warn("wal_checkpoint 失败（继续）:", e.message);
}

const now = Date.now();
const result = { dataDir, windowSize, threshold, seed: null, workdir: null };

if (windowSize) {
  const row = db.prepare("select value from settings where key='codem-dynamic-models'").get();
  const models = JSON.parse(row.value);
  for (const m of models.deepseek ?? []) if (m.id === "deepseek-flash") m.contextWindow = windowSize;
  db.prepare("update settings set value=? where key='codem-dynamic-models'").run(JSON.stringify(models));
  result.windowSize = windowSize;
}
if (threshold !== null) {
  const row = db.prepare("select value from settings where key='codem-context-config'").get();
  const cfg = JSON.parse(row.value);
  cfg.compactionThreshold = threshold;
  db.prepare("update settings set value=? where key='codem-context-config'").run(JSON.stringify(cfg));
  result.threshold = threshold;
}

let workProjectId = null;
if (has("--workdir")) {
  const workdir = path.join(destRoot, "workspace");
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(
    path.join(workdir, "package.json"),
    JSON.stringify({ name: "real-machine-ws", version: "0.0.0", private: true }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(workdir, "README.md"), "# real-machine workspace\n\n仅用于真机验证，不是真实仓库。\n", "utf8");
  workProjectId = `realws-${now}`;
  db.prepare(
    "insert into projects (id, name, path, description, pinned, created_at, last_accessed_at) values (?, ?, ?, null, 0, ?, ?)",
  ).run(workProjectId, "real-machine-ws", workdir, now, now);
  db.prepare("update settings set value=? where key='codem-last-project'").run(JSON.stringify(workProjectId));
  db.prepare("update settings set value=? where key='codem-last-session'").run(JSON.stringify(""));
  result.workdir = { workdir, projectId: workProjectId };
}

if (seedCount > 0) {
  const projectId =
    workProjectId ??
    db.prepare("select project_id from sessions where project_id is not null order by message_count desc limit 1").get()?.project_id;
  if (!projectId) throw new Error("没有可用 project_id");
  const sid = `realcomp-${now}`;
  const title = `真机压缩验证 ${new Date(now).toISOString().slice(11, 19)}`;
  db.prepare(
    "insert into sessions (id, project_id, title, model, created_at, last_message_at, message_count, pinned, is_internal) values (?, ?, ?, ?, ?, ?, ?, 0, 0)",
  ).run(sid, projectId, title, "deepseek-flash", now, now + seedCount, seedCount);
  const filler = "压缩触发判据的填充正文，用于在隔离副本里构造高水位会话。";
  const body = (i) => `第 ${i} 步：把这一段规范整理成检查清单。` + filler.repeat(Math.ceil(5000 / filler.length)).slice(0, 5000);
  const insert = db.prepare(
    "insert into messages (id, session_id, role, content, reasoning, timestamp, model, prompt_tokens, completion_tokens, cost, status, hidden, trimmed) values (?, ?, ?, ?, null, ?, null, 0, 0, 0, 'done', 0, 0)",
  );
  const lines = [];
  for (let i = 0; i < seedCount; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = body(i);
    insert.run(`rc-${i}`, sid, role, content, now + i);
    lines.push(JSON.stringify({ v: 1, id: `rc-${i}`, sessionId: sid, role, content, timestamp: now + i, status: "done" }));
  }
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "sessions", `${sid}.jsonl`), lines.join("\n") + "\n", "utf8");
  result.seed = { sessionId: sid, title, messages: seedCount, chars: seedCount * 5000 };
}
db.close();

for (const name of ["codem-db-rust.bin-shm", "codem-db-rust.bin-wal"]) {
  const p = path.join(dataDir, name);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}
console.log(JSON.stringify(result, null, 1));
