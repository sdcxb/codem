#!/usr/bin/env node
/**
 * 精简 GitHub Releases：只保留 `keep-releases.txt` 里列出的核心版本，其余 Release 页删除。
 *
 * ## 为什么需要这个工具（以及为什么"以后别再堆"要靠写作规范而不是这个脚本）
 *
 * 每个版本都必须发布一个 Release —— 更新器读的是
 * `https://github.com/sdcxb/codem/releases/latest/download/latest.json`，
 * 而 `latest.json` 是**最新那个 Release 的资产**。所以"不发布中间版本"是做不到的，
 * 能做到、也必须做到的是：**Release 说明写成面向用户的功能说明**，
 * 而不是开发过程回执（"撤回我先前的错误结论""我自己引入又修掉的假警报"）。
 * 这个脚本只是事后打扫：把历史遗留的中间版本收掉，让 Releases 页只剩核心版本。
 *
 * ## 用法
 *
 * ```text
 * node tools/release/prune-releases.mjs            # 干跑：只列出会删哪些（默认）
 * node tools/release/prune-releases.mjs --apply    # 真删（保留 tag）
 * node tools/release/prune-releases.mjs --apply --cleanup-tags   # 连 tag 一起删（默认不删）
 * ```
 *
 * ## 安全约束（都是硬编码的，没有开关可以绕过）
 *
 * 1. **绝不删最新那个 Release**：它挂着 `latest.json`，删了自动更新链路就断。
 * 2. **绝不删 `keep-releases.txt` 里的版本**：文件缺失或为空则直接退出（拒绝"按空清单全删"）。
 * 3. **默认保留 git tag**：Release 页变干净，但版本指针与源码历史仍在。
 * 4. 删除前先打印完整清单，删完**回读**剩余数量并与预期比对（脚本自己的日志不算证据）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEP_FILE = join(HERE, "keep-releases.txt");
const APPLY = process.argv.includes("--apply");
const CLEANUP_TAGS = process.argv.includes("--cleanup-tags");

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

if (!existsSync(KEEP_FILE)) {
  console.error(`找不到保留清单 ${KEEP_FILE} —— 没有清单就不知道该留什么，拒绝继续（绝不做"按空清单全删"这种事）`);
  process.exit(2);
}
const keep = readFileSync(KEEP_FILE, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean);
if (keep.length === 0) {
  console.error("保留清单是空的 —— 拒绝继续");
  process.exit(2);
}

const all = JSON.parse(gh(["release", "list", "--limit", "1000", "--json", "tagName,createdAt,isLatest"]));
const byTag = new Map(all.map((r) => [r.tagName, r]));

const missing = keep.filter((t) => !byTag.has(t));
if (missing.length) {
  console.error(`保留清单里的这些版本在 GitHub 上不存在：${missing.join(", ")} —— 先核对清单，拒绝继续`);
  process.exit(2);
}

const latest = all.find((r) => r.isLatest);
if (!latest) {
  console.error("找不到 Latest Release —— 状态不明，拒绝继续");
  process.exit(2);
}
if (!keep.includes(latest.tagName)) {
  console.error(`Latest 是 ${latest.tagName}，但它不在保留清单里 —— 那会删掉挂着 latest.json 的那个 Release，拒绝继续`);
  process.exit(2);
}

const del = all.filter((r) => !keep.includes(r.tagName));
console.log(`共 ${all.length} 个 Release：保留 ${keep.length} 个，待删 ${del.length} 个（Latest=${latest.tagName}）`);
console.log(`保留：${keep.join(", ")}`);
console.log(`待删：${del.map((r) => r.tagName).join(", ") || "(无)"}`);

if (del.length === 0) {
  console.log("没有需要删除的 Release。");
  process.exit(0);
}
if (!APPLY) {
  console.log("\n这是干跑。要真删请加 --apply（默认保留 git tag）。");
  process.exit(0);
}

let failed = 0;
for (const r of del) {
  const args = ["release", "delete", r.tagName, "--yes"];
  if (CLEANUP_TAGS) args.push("--cleanup-tag");
  try {
    gh(args);
    console.log(`  deleted ${r.tagName}`);
  } catch (e) {
    failed++;
    console.error(`  FAILED  ${r.tagName}: ${String(e.stderr || e.message).split("\n")[0]}`);
  }
}

// 回读核对（脚本自己的"成功"日志不算证据）
const after = JSON.parse(gh(["release", "list", "--limit", "1000", "--json", "tagName,isLatest"]));
const afterTags = after.map((r) => r.tagName).sort();
const expected = [...keep].sort();
const sameSet = afterTags.length === expected.length && afterTags.every((t, i) => t === expected[i]);
console.log(`\n删除完成：失败 ${failed} 个；剩余 ${after.length} 个（期望 ${expected.length}）`);
console.log(`剩余集合与保留清单一致：${sameSet ? "是" : "否 —— " + JSON.stringify(afterTags)}`);
const afterLatest = after.find((r) => r.isLatest);
console.log(`Latest 仍是 ${afterLatest ? afterLatest.tagName : "(无)"}；tag ${CLEANUP_TAGS ? "已一并删除" : "全部保留"}`);
process.exit(failed === 0 && sameSet && afterLatest?.tagName === latest.tagName ? 0 : 1);
