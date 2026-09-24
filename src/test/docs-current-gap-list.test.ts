/**
 * 「当前缺口只有一份清单」的门禁（第 72 轮审计 D 项）
 *
 * ## 要守的是什么（真机可见的形态）
 *
 * `docs/` 下有上百份历史文档，其中一批文件名看起来就是"当前待办/当前缺口"。
 * 实测的后果：对着 `TODO.md` 读出来的"还没做"里有相当一部分**早就做完了**
 * （`InlineMessageEdit` / `ScrollbarMarkers` / `ScrollToBottomIndicator` 都在代码里），
 * 而且 `PROJECT-GUIDE.md` 的文档索引当时还写着 `TODO.md`"✅ 最新 / 了解当前待办" ——
 * 于是"缺口清单"变成了谣言来源，任何人照着它干活都会做无用功。
 *
 * 处置：**只保留一份**当前清单 `docs/GAP-LIST.md`，其余计划/缺口类文档一律加
 * 「历史文档（不再维护）」横幅并指回它。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | DOCS-1 | `docs/GAP-LIST.md` 必须存在，且写清"这是唯一清单"与"未关闭项"两件事 |
 * | DOCS-2 | 文件名匹配 `GAP\|PLAN\|ROADMAP\|TODO\|STATUS\|TRIAGE\|UNIMPLEMENTED\|REMEDIATION\|DEFERRED` 的 `docs/*.md` **必须**带横幅（白名单：`GAP-LIST.md`） |
 * | DOCS-3 | 横幅必须**指回** `GAP-LIST.md`（只有一句"历史文档"而没有出口 = 读者还是不知道该看哪） |
 * | DOCS-4 | `PROJECT-GUIDE.md` 的文档索引**不许**再把 `TODO.md` 说成"当前待办/最新"，且必须指向 `GAP-LIST.md` |
 *
 * ## 关于"规则写在哪"
 *
 * 横幅规则的真源是**本文件**（机器判据）；加横幅的工具
 * `.preview-shot/banner-historical-docs.mjs` 用的是同一套正则，
 * DOCS-5 会核对两边没漂（工具里的正则字符串必须和这里一致）。
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const GAP_LIST = path.join(DOCS, "GAP-LIST.md");

/** 名字像"当前待办/当前缺口"的文档必须带横幅 */
const STALE_NAME_RE = /(GAP|PLAN|ROADMAP|TODO|STATUS|TRIAGE|UNIMPLEMENTED|REMEDIATION|DEFERRED)/i;
/** 当前清单白名单（只有它自己） */
const CURRENT = new Set(["GAP-LIST.md"]);
const BANNER_MARK = "历史文档（不再维护）";

function staleDocs(): string[] {
  return fs
    .readdirSync(DOCS)
    .filter((n) => n.endsWith(".md") && !CURRENT.has(n) && STALE_NAME_RE.test(n))
    .sort();
}

describe("当前缺口清单只有一份（第 72 轮审计）", () => {
  it("DOCS-1: `docs/GAP-LIST.md` 存在，并写明『唯一清单』与『未关闭项』", () => {
    expect(fs.existsSync(GAP_LIST), "当前清单必须存在 —— 否则所有历史文档又都像「当前」了").toBe(true);
    const text = fs.readFileSync(GAP_LIST, "utf8");
    expect(text, "必须说清自己是唯一清单").toContain("唯一一份");
    expect(text, "必须有『未关闭』一节（否则读者不知道还差什么）").toContain("未关闭");
    expect(text, "必须说明怎么核对（不能只有结论）").toContain("怎么核对的");
  });

  it("DOCS-2: 计划/缺口类历史文档必须带『历史文档（不再维护）』横幅", () => {
    const missing = staleDocs().filter((n) => !fs.readFileSync(path.join(DOCS, n), "utf8").includes(BANNER_MARK));
    expect(
      missing,
      `这些文档的名字看起来像"当前待办/当前缺口"，却没有横幅（读者会当真）：\n  - ${missing.join("\n  - ")}\n` +
        `修法：node .preview-shot/banner-historical-docs.mjs --apply`,
    ).toEqual([]);
    // 反向对照：规则真的在判（把一份**当前**清单排除掉，不至于"所有文档都要横幅"）
    expect(staleDocs(), "至少要覆盖到那批名字里带 GAP/PLAN/TODO 的文档").toContain("TODO.md");
    expect(staleDocs()).not.toContain("GAP-LIST.md");
  });

  it("DOCS-3: 横幅必须**链到** `GAP-LIST.md`（有出口，不能只说「这是历史」）", () => {
    /*
     * ⚠️ 判据是**链接目标**，不是"正文里出现过 GAP-LIST.md"。
     * 第一版按后者判，突变验证当场把它拆穿了：把横幅里的链接删掉之后，
     * 正文那句"请在 `GAP-LIST.md` 与代码里各复核一次"仍然让判据成立 ⇒
     * 那条 Mutation 报"未红"。**提到一个名字 ≠ 给了出口。**
     */
    const bad: string[] = [];
    for (const n of staleDocs()) {
      const text = fs.readFileSync(path.join(DOCS, n), "utf8");
      if (!text.includes(BANNER_MARK)) continue; // DOCS-2 已经在报
      // 只看第一屏（横幅本身）
      const head = text.split(/\r?\n/).slice(0, 20).join("\n");
      if (!/\]\((?:\.\/)?GAP-LIST\.md\)/.test(head)) bad.push(n);
    }
    expect(bad, `横幅里必须给出可点的出口（链接到 GAP-LIST.md）：${bad.join("，")}`).toEqual([]);
  });

  it("DOCS-4: `PROJECT-GUIDE.md` 的文档索引必须指向当前清单、不再把 TODO.md 当当前待办", () => {
    const guide = fs.readFileSync(path.join(DOCS, "PROJECT-GUIDE.md"), "utf8");
    expect(guide, "文档索引必须指向唯一清单").toContain("GAP-LIST.md");
    // 具体的两处旧话术（当时把历史文档当成了当前）
    expect(guide, "`TODO.md` 不许再被描述成『✅ 最新』").not.toMatch(/\*\*TODO\.md\*\*[^\n]*✅ 最新/);
    expect(guide, "推荐阅读里不许再说『TODO.md — 了解当前待办』").not.toContain("了解当前待办");
  });

  it("DOCS-6: 两份关键文档必须**真的在仓库里**（不许被 .gitignore 吞掉）", () => {
    /*
     * 第 81 轮实查出来的坑：`.gitignore` 里有一条 `docs/*.md`（只放行少数几份），
     * 于是新建的 `docs/GAP-LIST.md` 与 `docs/ui-walk-round72.md` **根本没进仓库** ——
     * 本机跑得好好的（文件在磁盘上），而别人 clone 下来：
     *   · DOCS-1 会因为"当前清单不存在"直接失败；
     *   · CHANGELOG / GAP-LIST 里"报告见 docs/ui-walk-round72.md"这句话指向一个不存在的文件。
     * 所以这里用 `git check-ignore` 直接问 git：这两份是不是被忽略了。
     */
    const files = ["docs/GAP-LIST.md", "docs/ui-walk-round72.md"];
    for (const f of files) {
      expect(fs.existsSync(path.join(ROOT, f)), `${f} 必须存在于工作区`).toBe(true);
      /*
       * `git check-ignore -q <path>`：**退出码 0 = 被忽略**，1 = 没被忽略。
       * ⚠️ 不要用 stdout 判断：带 `-v` 时 git 会把"最后匹配到的规则"也打出来，
       * 包括 `!` 取反规则（第一版就是这么写的，于是把"已放行"误判成"被忽略"）。
       */
      const probe = spawnSync("git", ["check-ignore", "-q", f], { cwd: ROOT, encoding: "utf8" });
      expect(
        probe.status,
        `${f} 被 .gitignore 忽略了（要加 \`!docs/…\` 白名单，否则门禁在别人机器上直接失败）`,
      ).toBe(1);
    }
    // 反向对照：确认这个判据真的在判（`.preview-shot/` 是刻意忽略的目录，必须被判为忽略 ⇒ 退出码 0）
    const control = spawnSync("git", ["check-ignore", "-q", ".preview-shot/"], { cwd: ROOT, encoding: "utf8" });
    expect(control.status, "对照项：.preview-shot/ 是刻意忽略的，必须被判为忽略（退出码 0）").toBe(0);
  });

  it("DOCS-5: 加横幅的工具与本文件的规则不许漂（两边正则一致）", () => {
    const tool = fs.readFileSync(path.join(ROOT, ".preview-shot", "banner-historical-docs.mjs"), "utf8");
    expect(tool, "工具必须存在").toContain("banner-historical-docs");
    const m = /export const STALE_NAME_RE = (\/.*\/i);/.exec(tool);
    expect(m, "工具里必须有一条同名的正则（便于核对）").toBeTruthy();
    expect(m![1], "两边的名字规则必须逐字一致，否则工具会漏加/多加横幅").toBe(String(STALE_NAME_RE));
    expect(tool, "工具必须幂等（已有横幅就跳过）").toContain(BANNER_MARK);
  });
});
