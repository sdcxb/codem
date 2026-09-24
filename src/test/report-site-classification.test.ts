/**
 * 上报点**分诊**闸门（第 90 轮）。
 *
 * ## 背景
 *
 * 三种上报语气各有用处：`persist`（写盘失败）、`action`（动作没生效）、`advisory`（发现/提醒）。
 * 第 88/89 轮修的两类假话（"发现"被印成"失败"、"该功能本次不可用，请重试"）都出在**选错语气**上。
 * 当时只把维护那一个文件逐处看过；全仓还有 200 处没分诊。
 *
 * 这一轮把它变成可机检的三条判据（`tools/audit/scan-report-sites.mjs --check`）：
 *  ① 代码里新出现的上报点**必须登记**（逼人先判语气）；
 *  ② 登记的 kind 必须与实际一致（**通道漂移**要红）；
 *  ③ 登记表里不许有代码里已不存在的站点（防止登记表变成没人管的忽略名单）。
 *
 * 另外还差一件工具做不到的事：**逐处判语义**。所以登记表分两档
 * （`triaged` = 逐处看过并写了理由；`pending` = 还没看），并对 pending 做**棘轮**：
 * 只许降不许升 —— 每轮把一批 pending 变成 triaged，数字必须变小。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCANNER = join(ROOT, "tools", "audit", "scan-report-sites.mjs");
const REGISTRY = join(ROOT, "tools", "audit", "report-site-classification.json");

/**
 * pending 棘轮（只许降不许升）。
 *
 * 第 90 轮基线 **123**（从 217 起步：先登记全部现状，再把读过的 94 处落成 triaged）。
 * **第 100 轮 → 86**：分诊了 37 处（inbox 8 / squad 8 / flashcard 6 / issue 5 /
 * knowledge storage 6 / show-todo 2 / file-change-tracker 2 / 以及它们同族的其余站点），
 * 其中 **8 处改了通道** —— 都是"**读侧事件被塞进 persist 通道**"那类：
 * 提示条会印「写盘失败……本次改动只存在于内存，重启后可能丢失」，而实际上什么都没写、也没有改动被丢。
 * 逐处理由写在 `tools/audit/report-site-classification.json` 的 `reason` 里
 * （工具：`.preview-shot/_triage-report-sites-r100.mjs`，干跑/`--apply`）。
 * 每轮分诊一批就把这个数字改小；**改大必须有理由**（例如新增了一块功能带来的新站点）。
 */
const PENDING_BASELINE = 86;

interface Site {
  site: string;
  kind: "persist" | "action" | "advisory";
  status: "triaged" | "pending";
  reason: string;
  family?: string;
}
interface Registry {
  _counts: { total: number; triaged: number; pending: number };
  sites: Site[];
}

const registry = (): Registry => JSON.parse(readFileSync(REGISTRY, "utf8")) as Registry;

function runCheck(): { status: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCANNER, "--check"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("上报点分诊闸门（第 90 轮）", () => {
  it("RPT-1 真实仓库：闸门通过（新站点必登记 / 无漂移 / 无过期）", () => {
    const { status, out } = runCheck();
    expect(status, `闸门应通过，实际输出：\n${out}`).toBe(0);
    expect(out).toContain("分诊闸门通过");
  });

  it("RPT-2 登记表与扫描结果**逐个对齐**（不多不少，且 kind 一致）", () => {
    const reg = registry();
    const out = execFileSync(process.execPath, [SCANNER, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const { findings } = JSON.parse(out.replace(/^\uFEFF/, "")) as {
      findings: { file: string; area: string; kind: string; occurrence?: number }[];
    };
    const real = findings.map((f) => `${f.file}::${f.area}::#${f.occurrence ?? 1}`).sort();
    const declared = reg.sites.map((s) => s.site).sort();
    expect(declared, "登记表与真实上报点必须逐个对齐").toEqual(real);
    // kind 必须与真实通道一致 —— "_counts" 也不能与实际不符
    for (const f of findings) {
      const key = `${f.file}::${f.area}::#${f.occurrence ?? 1}`;
      const s = reg.sites.find((x) => x.site === key);
      expect(s?.kind, `${key} 的登记 kind 与真实通道不一致`).toBe(f.kind);
    }
    expect(reg._counts.total).toBe(real.length);
    expect(reg._counts.triaged + reg._counts.pending).toBe(real.length);
  });

  it("RPT-3 triaged 必须写明理由（登记表不是忽略名单）", () => {
    const reg = registry();
    // 理由可以很短（"建项目写盘失败" 就够），但**不许空、不许只是占位**
    const noReason = reg.sites.filter((s) => s.status === "triaged" && (!s.reason || s.reason.trim().length < 6));
    expect(noReason.map((s) => s.site), "已分诊的站点必须写清「为什么是这种语气」").toEqual([]);
    const placeholder = reg.sites.filter((s) => s.status === "triaged" && /待分诊|TODO|待补/.test(s.reason));
    expect(placeholder.map((s) => s.site), "triaged 不许留占位理由").toEqual([]);
    // pending 的也必须有「待分诊」标记（不许空白条目混进来）
    const emptyPending = reg.sites.filter((s) => s.status === "pending" && !s.reason.includes("待"));
    expect(emptyPending.map((s) => s.site)).toEqual([]);
  });

  it("RPT-4 pending 棘轮：只许降不许升", () => {
    const reg = registry();
    /**
     * ⚠️ 从 `sites` **现算** pending，不信 `_counts` 缓存 —— 否则"往 sites 里塞一条 pending
     * 但不更新计数"就能绕过棘轮（第 90 轮的变异演练正是这么把它试出来的）。
     */
    const pendingNow = reg.sites.filter((s) => s.status === "pending").length;
    expect(pendingNow, "登记表的 _counts.pending 与 sites 实际不符").toBe(reg._counts.pending);
    expect(
      pendingNow,
      `待分诊数量涨了：${PENDING_BASELINE} → ${pendingNow}。` +
        "要么把新站点分诊掉，要么在测试里写明为什么允许涨（新增功能带来的新站点要单独说明）。",
    ).toBeLessThanOrEqual(PENDING_BASELINE);
  });

  it("RPT-5 已搬去 advisory 的「发现」站点不许回退（锁住第 88/89/90 轮的修复）", () => {
    const reg = registry();
    const mustBeAdvisory = [
      "src/core/storage/maintenance.ts::maintenance.credentialCensus::#1",
      "src/core/storage/maintenance.ts::maintenance.invariantAudit.new::#1",
      "src/core/storage/maintenance.ts::maintenance.indexBehindLog::#1",
      "src/core/storage/event-log.ts::<动态>::#1",
      "src/core/storage/bootstrap.ts::<动态>::#6",
    ];
    for (const key of mustBeAdvisory) {
      const s = reg.sites.find((x) => x.site === key);
      expect(s, `${key} 不在登记表里（判据过期了？）`).toBeTruthy();
      expect(s?.kind, `${key} 必须走 advisory（它是"发现"，不是"失败"）`).toBe("advisory");
    }
  });
});
