/**
 * DOCS-KEY：**关键文档必须在库里**（2026-10-18 文档策略）。
 *
 * 背景：`.gitignore` 里有 `docs/*.md`（大量 docs 是本地工作稿），此前靠"记得 `git add -f`"
 * 才能让接手文档进仓库 —— 那是一次性的口头约定，换成别人/下次就断了。
 * 现在改成两层：
 * 1. `.gitignore` 用 negation 显式放行关键文档（`!docs/...`）；
 * 2. 本判据验证这些文件**既存在、又真的被 git 跟踪、且不再被忽略**。
 *
 * 判据 `DOCSKEY-1..3`。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..", "..");

/** 下一个会话必须读到的文档（改列表要同步 .gitignore 的 negation） */
const KEY_DOCS = [
  "docs/HANDOVER-2026-10-17.md",
  "docs/HANDOFF-NEXT-SESSION.md",
  "docs/GAP-LIST.md",
  "docs/NEW-SESSION-START.md",
  "docs/RELEASE-GUIDE.md",
  "docs/DEAD-CODE-TRIAGE.md",
  "docs/PROJECT-GUIDE.md",
  "docs/ui-spec.md",
];

function git(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? "") };
  }
}

describe("DOCSKEY 关键文档强制入库", () => {
  it("DOCSKEY-1: 关键文档都存在", () => {
    const missing = KEY_DOCS.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, `关键文档缺失：${missing.join(", ")}`).toEqual([]);
  });

  it("DOCSKEY-2: 关键文档都被 git 跟踪（不是只有本地一份）", () => {
    const untracked = KEY_DOCS.filter((rel) => !git(["ls-files", "--error-unmatch", rel]).ok);
    expect(untracked, `这些关键文档没有入库（下一个会话拿不到）：${untracked.join(", ")}`).toEqual([]);
  });

  it("DOCSKEY-3: .gitignore 的 negation 生效（不再处于 ignored 状态）", () => {
    /*
     * 必须带 `--no-index`：默认模式下 `check-ignore` 对**已跟踪**文件永远返回"不忽略"，
     * 于是"有人删了 negation"这类回归它抓不到（2026-10-18 变异自证当场发现）。
     * `--no-index` 让 git 只按规则算"假如现在 add 它，会不会被忽略"。
     */
    const stillIgnored = KEY_DOCS.filter((rel) => git(["check-ignore", "-q", "--no-index", rel]).ok);
    expect(stillIgnored, `仍被忽略（negation 没覆盖）：${stillIgnored.join(", ")}`).toEqual([]);
  });
});
