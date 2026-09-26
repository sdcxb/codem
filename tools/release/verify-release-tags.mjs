/**
 * 发布台账核对：**release 的 tag 必须指向"装了那一版代码"的提交**（第 155 轮踩了两次，于是做成工具）。
 *
 * ## 为什么需要（同一个坑连续两轮）
 *
 * `gh release create <tag>` 是在**远端默认分支 HEAD** 上打 tag。本地还有没推的提交时，
 * tag 就会指到一个**比这个版本更老的提交**：
 *  - 第 154 轮实测：`v1.16.150…154` 五个 tag 全指向 `b4ae90d`（那是"第 110 轮"，早了 40 多轮）；
 *  - 第 155 轮又踩了一次：发布先于 push，`v1.16.155` 指到上一轮的 `6efdc93`。
 * 后果不是"更新器坏了"（它读 `releases/latest/download/latest.json` 那份资产，一直是对的），
 * 而是**源码与安装包对不上**：点开 release 的 commit 链接，看到的是不含本版修复的代码。
 *
 * ## 判据
 *
 * 对每个 tag：读它指向的提交里的 `package.json` 的 `version`，必须**等于 tag 名去掉 v**。
 * 对不上就报出来（`--fix` 会把它移到本地那个"版本号匹配的提交"上，需要该提交已推送到远端）。
 *
 * 用法：
 *   node tools/release/verify-release-tags.mjs                 # 核对最近 5 个 release
 *   node tools/release/verify-release-tags.mjs v1.16.155 ...   # 指定 tag
 *   node tools/release/verify-release-tags.mjs --fix           # 把对不上的 tag 移到正确提交
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXCEPTIONS_FILE = path.join(HERE, "release-tag-exceptions.json");
/** 已知例外（每条必须写清理由；见该文件里的 _note） */
const exceptions = existsSync(EXCEPTIONS_FILE) ? JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8")).exceptions ?? {} : {};

const argv = process.argv.slice(2);
const FIX = argv.includes("--fix");
const tags = argv.filter((a) => !a.startsWith("--"));

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/** 最近 5 个 release 的 tag（不指定时） */
function recentTags() {
  const out = gh(["release", "list", "--limit", "5", "--json", "tagName"]);
  return JSON.parse(out).map((r) => r.tagName);
}

/** tag 指向的提交里的 package.json 版本 */
function versionAtTag(tag) {
  try {
    const sha = gh(["api", `repos/{owner}/{repo}/git/refs/tags/${tag}`]);
    const commit = JSON.parse(sha).object.sha;
    const pkg = gh(["api", `repos/{owner}/{repo}/contents/package.json?ref=${commit}`, "-H", "Accept: application/vnd.github.raw"]);
    return { commit, version: JSON.parse(pkg).version };
  } catch (e) {
    return { commit: null, version: null, error: String(e.message ?? e).slice(0, 120) };
  }
}

/** 本地哪个提交的 package.json 版本号 = 这个 tag（用于 --fix） */
function localCommitFor(version) {
  try {
    const sha = git(["log", "--all", "--format=%H", "-S", `"version": "${version}"`, "--", "package.json"]).split("\n").filter(Boolean)[0];
    return sha ?? null;
  } catch {
    return null;
  }
}

const list = tags.length ? tags : recentTags();
const rows = [];
for (const tag of list) {
  const want = tag.replace(/^v/, "");
  const { commit, version, error } = versionAtTag(tag);
  const ok = version === want;
  rows.push({ tag, want, commit, version, ok, error, known: Boolean(exceptions[tag]) });
}

console.log("tag".padEnd(14) + "期望版本".padEnd(12) + "tag 里 package.json".padEnd(22) + "提交".padEnd(12) + "结论");
let bad = 0;
for (const r of rows) {
  if (!r.ok && !r.known) bad++;
  const verdict = r.error
    ? `❌ 读不到（${r.error}）`
    : r.ok
      ? "✅ 一致"
      : r.known
        ? "⚠️ 已知例外（见 release-tag-exceptions.json）"
        : "🔴 不一致（源码与安装包对不上）";
  console.log(
    r.tag.padEnd(14) + r.want.padEnd(12) + String(r.version ?? "-").padEnd(22) + String(r.commit ?? "-").slice(0, 7).padEnd(12) + verdict,
  );
}

const known = rows.filter((r) => !r.ok && r.known);
if (known.length) {
  console.log("\n已知例外：");
  for (const r of known) console.log(`   ${r.tag}：${exceptions[r.tag].reason}`);
}

if (bad === 0) {
  console.log(`\n✅ ${rows.length} 个 tag 全部指向"版本号与 tag 一致"的提交`);
  process.exit(0);
}

console.log(`\n🔴 ${bad} 个 tag 指向的提交里版本号与 tag 不一致（发布时本地还没 push 时就会这样）。`);
if (FIX) {
  for (const r of rows.filter((x) => !x.ok)) {
    const sha = localCommitFor(r.want);
    if (!sha) {
      console.log(`   ${r.tag}：本地找不到 package.json 版本号为 ${r.want} 的提交 —— 只能人工处理（该版本的版本号提交可能从未落地）`);
      continue;
    }
    try {
      gh(["api", "-X", "PATCH", `repos/{owner}/{repo}/git/refs/tags/${r.tag}`, "-f", `sha=${sha}`, "-F", "force=true"]);
      console.log(`   ${r.tag} → ${sha.slice(0, 7)}（已移动；**资产未动**）`);
    } catch (e) {
      console.log(`   ${r.tag}：移动失败 ${String(e.message ?? e).slice(0, 120)}（该提交推到远端了吗？）`);
    }
  }
} else {
  console.log("处置：`git push` 之后跑 `--fix` 把 tag 移到版本号匹配的提交（移动 tag **不动 release 资产**），");
  console.log("      或在 release 说明里写清为什么指向了别的提交。");
}
process.exit(1);
