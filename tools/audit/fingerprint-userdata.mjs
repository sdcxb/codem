/**
 * 用户数据指纹（第 121 轮）：让"走查/探针没有改用户数据"从**愿望**变成**可测量的判据**。
 *
 * ## 为什么需要它
 *
 * 第 118 轮那次走查里，有一个入口**真的写了用户的库**：设置 →「运行登录测试」——
 * 它建了一行 `accounts`（`test-1790281722602`）又把它删掉，只在控制台留下一行
 * `[WriteAudit] crud.delete table=accounts`（走查读数里那条唯一的 warning）。
 * 护栏当时**没拦住它** —— 因为 `classifyClick` 的规则里没有"会写数据"这一类，
 * 而"运行登录测试"这几个字里也没有删除/清空之类的破坏性动词。
 *
 * 结论：**光靠文案名单守不住**（名单永远不全）。所以补一个**结果侧**的判据：
 * 走查前后各取一次指纹，**数据变了就是变了**，不依赖"我有没有想到那个入口"。
 *
 * ## 量什么
 *
 * - 主库文件（`%APPDATA%\com.codem.app\codem-db-rust.bin`）的 sha256、大小、mtime；
 * - WAL（`-wal`）与 shm（`-shm`）的 sha256/大小（**写入会先落 WAL**，只看主库会漏）；
 * - 权威日志目录 `sessions/` 的文件数与总字节数。
 *
 * ## 用法
 *
 *   node tools/audit/fingerprint-userdata.mjs --snapshot .preview-shot/_fp-before.json
 *   …走查/探针…
 *   node tools/audit/fingerprint-userdata.mjs --compare .preview-shot/_fp-before.json   # 有变化则退出码 1
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = path.join(os.homedir(), "AppData", "Roaming", "com.codem.app");

const sha256 = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

const statOf = (file) => {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  } catch {
    return null;
  }
};

export function fingerprint() {
  const main = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => /^codem-db-rust.*\.bin$/i.test(f)).map((f) => path.join(DATA_DIR, f))[0]
    : null;
  const out = { dataDir: DATA_DIR, main: null, wal: null, shm: null, sessions: null, at: new Date().toISOString() };
  if (main) {
    out.main = { file: path.basename(main), sha256: sha256(main), ...(statOf(main) ?? {}) };
    out.wal = { file: `${path.basename(main)}-wal`, sha256: sha256(`${main}-wal`), ...(statOf(`${main}-wal`) ?? {}) };
    out.shm = { file: `${path.basename(main)}-shm`, sha256: sha256(`${main}-shm`), ...(statOf(`${main}-shm`) ?? {}) };
  }
  const sessions = path.join(DATA_DIR, "sessions");
  if (fs.existsSync(sessions)) {
    const files = fs.readdirSync(sessions).filter((f) => f.endsWith(".jsonl"));
    out.sessions = { files: files.length, bytes: files.reduce((s, f) => s + (statOf(path.join(sessions, f))?.size ?? 0), 0) };
  }
  return out;
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const snap = argOf("--snapshot");
  const cmp = argOf("--compare");
  if (snap) {
    const fp = fingerprint();
    fs.writeFileSync(snap, JSON.stringify(fp, null, 2), "utf8");
    console.log(`快照已写入 ${snap}：主库 ${fp.main ? `${fp.main.size} B sha256=${fp.main.sha256.slice(0, 12)}…` : "(没找到)"}、会话日志 ${fp.sessions?.files ?? 0} 个 / ${fp.sessions?.bytes ?? 0} B`);
    process.exit(0);
  }
  if (cmp) {
    const before = JSON.parse(fs.readFileSync(cmp, "utf8"));
    const now = fingerprint();
    const diffs = [];
    for (const key of ["main", "wal", "shm", "sessions"]) {
      const a = before[key];
      const b = now[key];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${key}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
    if (diffs.length) {
      console.log("❌ 用户数据**变了**（走查/探针不是只读的）：");
      for (const d of diffs) console.log(`   - ${d}`);
      process.exit(1);
    }
    console.log(`✅ 用户数据与快照一致（主库 sha256=${now.main?.sha256.slice(0, 12) ?? "—"}…，WAL/shm/会话日志都没动）`);
    process.exit(0);
  }
  console.log(JSON.stringify(fingerprint(), null, 1));
  void ROOT;
}
