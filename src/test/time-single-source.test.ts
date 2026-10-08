/**
 * `TIME-SINGLE-SOURCE`：**给人看的时间只有一个口径**（第 189 波 R7 + 同类全仓扫尾）。
 *
 * ## 这一簇已经出了三次（同一根因）
 *
 * | # | 位置 | 形态 | 后果 |
 * | --- | --- | --- | --- |
 * | 1 | `prompt.ts` 的 `# Current Date` | 取**本地**年月日时分，却硬编码 `Z` 后缀 | 本地时间被谎称成 UTC（差 8 小时） |
 * | 2 | `llm/time-context.ts` 的时间戳 | 取 `toISOString()`（**UTC 数字**）再拼**本机偏移** | 标注瞬时比真实早 8 小时，与同请求 date 矛盾 |
 * | 3 | `memory.ts` 的 `safeDate()`（记忆行 `[日期]`） | `toISOString().split("T")[0]` = **UTC 日** | `Asia/Shanghai` 本地 00:00–08:00 创建的条目显示**前一天** |
 *
 * 所以判据不是"某一处对不对"，而是**结构性的**：自造时间格式（取本地/UTC 字段、拼偏移、切日期）
 * 只允许出现在**唯一口径** `src/core/time/local-time.ts` 里；例外必须登记在下面的 allowlist
 * 并写明理由。**机器用的瞬时**（日志/导出元数据/协议字段）保持 `toISOString()`（那是瞬时，
 * 不是"给人看的本地时间"），但**不许**再出现"UTC 数字 + 本地偏移"这种混搭。
 *
 * ## 两条判据
 *
 * | # | 判据 | 变异（必须红） |
 * | --- | --- | --- |
 * | 1 | **解析式对账**：全仓（除唯一口径 / 登记的例外）不许出现自造时间格式；且已知的"给人看的时间"位置必须真的引用共享口径 | 任一处退回自写（如 `safeDate` 改回 `toISOString().split("T")[0]`） |
 * | 2 | `[日期]` 在固定时区 + **跨日边界**（本地 00:30）下必须显示**当天** —— 这就是 R7 的正身 | `safeDate` 退回 UTC 日 |
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import { MemoryService } from "../core/memory/memory";
import {
  localClockString,
  localDateTimeString,
  localDateString,
  localTimeParts,
  offsetLabel,
} from "../core/time/local-time";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
/** 唯一口径的定义处（下面每条规则都豁免它） */
const SHARED = path.join("src", "core", "time", "local-time.ts");

// ===================== 判据 ①：解析式对账 =====================

/**
 * 自造时间格式的**可解析形态**。
 *
 * ⚠️ 只认"取字段/拼串"这一类**语法**特征（不是"文件里含某字符串"的伪判据）：
 * 命中 = 那一处在自己算时间字段或自己拼时区后缀；要放行必须登记理由。
 */
const SELF_FORMAT_RULES: Array<{ id: string; why: string; re: RegExp }> = [
  {
    id: "LOCAL-OR-UTC-OFFSET",
    why: "偏移只能由唯一口径算（旧 R1 缺陷就是这里各算一份 ⇒ 标注与实际不符）",
    re: /getTimezoneOffset\s*\(/,
  },
  {
    id: "PLATFORM-LOCAL-RENDER",
    why: "`toDateString()` / `toTimeString()` 是平台本地渲染，会与其它处形成第二套时间说法",
    re: /\.to(?:Date|Time)String\s*\(/,
  },
  {
    id: "UTC-FIELD-EXTRACTION",
    why: "`toISOString()` 切前 10 位/去 Z 再拼偏移 = 拿 UTC 数字冒充本地（R1/R7 的形态）",
    re: /toISOString\s*\(\s*\)\s*\.\s*(?:split|slice|replace|substring)/,
  },
  {
    id: "UTC-FIELDS",
    why: "UTC 字段只允许出现在唯一口径里（别处取它就是在自己拼时间）",
    re: /\.getUTC(?:FullYear|Month|Date|Hours|Minutes|Seconds)\s*\(/,
  },
  {
    id: "LOCAL-FIELDS",
    why: "本地字段只允许由唯一口径取（别处取它 = 又一份自造格式化）",
    re: /\.get(?:FullYear|Month|Hours|Minutes|Seconds)\s*\(/,
  },
];

/**
 * **登记的例外**（每条都必须写清"为什么它不是给人看的时间"）。
 * 注意：只按**路径**登记（文件级），因为这些都是"整个文件只有这一种语义"的形态。
 */
const ALLOWLIST: Record<string, string> = {
  [path.join("src", "core", "automation", "automation-manager.ts")]:
    "cron 调度匹配：本地墙上时间参与的是**语义**匹配（几点几分触发），不是给人看的格式化输出",
  [path.join("src", "core", "skills", "archify", "scripts", "update-contract.mjs")]:
    "构建脚本：把清单里的**机器瞬时**与文件内容逐字比对（`.mjs`，不进产品运行面）",
};
/** 整目录豁免：vendored 第三方（`cosmokit` 自带一套 date format，不改第三方代码） */
const ALLOWLIST_DIRS = [path.join("src", "core", "cordis")];

/** 去掉注释（否则注释里的示例会变成假阳性） */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1} `);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (ALLOWLIST_DIRS.some((d) => full.endsWith(d) || full.includes(`${d}${path.sep}`))) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  rel: string;
  line: number;
  ruleId: string;
  text: string;
}

/** 扫全仓：返回命中（已排除唯一口径与登记例外、已剥注释） */
function scanSelfFormats(): { hits: Hit[]; scanned: number } {
  const hits: Hit[] = [];
  let scanned = 0;
  for (const full of walk(SRC)) {
    const rel = path.relative(ROOT, full);
    // `src/test/**` 是判据自己（被测对象不是它）；唯一口径与登记例外放行
    if (rel.startsWith(path.join("src", "test"))) continue;
    scanned++;
    if (rel === SHARED || ALLOWLIST[rel]) continue;
    const raw = readFileSync(full, "utf8");
    const code = stripComments(raw);
    code.split("\n").forEach((line, i) => {
      for (const rule of SELF_FORMAT_RULES) {
        if (rule.re.test(line)) {
          hits.push({ rel: rel.split(path.sep).join("/"), line: i + 1, ruleId: rule.id, text: line.trim() });
        }
      }
    });
  }
  return { hits, scanned };
}

/**
 * 每条规则的**阴性/阳性对照样本**（判据不许只在"当前仓库恰好干净"上成立：
 * 规则本身必须被证明能命中它要挡的形态、且不误伤共享口径的写法）。
 */
const RULE_FIXTURES: Record<string, { hit: string; clean: string }> = {
  "LOCAL-OR-UTC-OFFSET": {
    hit: "const o = -d.getTimezoneOffset();",
    clean: "const o = localTimeParts(d).offsetMinutes;",
  },
  "PLATFORM-LOCAL-RENDER": {
    hit: "const s = d.toDateString();",
    clean: "const s = localDateTimeString(d);",
  },
  "UTC-FIELD-EXTRACTION": {
    hit: 'const day = new Date(t).toISOString().split("T")[0];',
    clean: "const day = localDateString(new Date(t));",
  },
  "UTC-FIELDS": {
    hit: "const y = d.getUTCFullYear();",
    clean: "const p = localTimeParts(d);",
  },
  "LOCAL-FIELDS": {
    hit: "const h = d.getHours();",
    clean: "const h = localTimeParts(d).hour;",
  },
};

/** 已知的"给人看的时间"位置（必须真的引用唯一口径 —— 判据①的**正向**那一半） */
const MUST_USE_SHARED = [
  "src/core/prompt/prompt.ts",
  "src/core/llm/time-context.ts",
  "src/core/memory/memory.ts",
  "src/core/llm/cost-tracker.ts",
  "src/core/llm/catalog-health.ts",
  "src/components/MemoryManager.tsx",
  "src/components/MemoryCheckupView.tsx",
  "src/components/UsageVisuals.tsx",
  "src/components/TrajectoryPanel.tsx",
  "src/components/task-center/DelegationTab.tsx",
  "src/core/provider/time-context-provider.ts",
  "src/plugins/library-ops/core/telemetry-adapter.ts",
];

describe("TIME-SINGLE-SOURCE①：自造时间格式只允许出现在唯一口径里（解析式对账）", () => {
  it("扫到的文件数不是 0（否则下面的对账是空转）", () => {
    const { scanned } = scanSelfFormats();
    expect(scanned, "扫到的产品源码文件太少 ⇒ 目录遍历写错了").toBeGreaterThan(200);
  });

  it("每条规则都有判别力（阳性样本命中 / 阴性样本不误伤；不靠'仓库恰好干净'）", () => {
    for (const rule of SELF_FORMAT_RULES) {
      const fx = RULE_FIXTURES[rule.id];
      expect(fx, `规则 ${rule.id} 没有对照样本`).toBeTruthy();
      expect(rule.re.test(fx.hit), `规则 ${rule.id} 连要挡的形态都命不中 ⇒ 正则失效`).toBe(true);
      expect(rule.re.test(fx.clean), `规则 ${rule.id} 误伤了共享口径的写法`).toBe(false);
    }
    /*
     * 唯一口径里确实在用"算偏移 + 取 UTC 字段"这两个原语（这正是它的算法：
     * 本地字段 = `UTC 毫秒 + 偏移` 的 UTC 字段）—— 也是"这些原语只该出现在这一处"的依据。
     * （`LOCAL-FIELDS` **不**要求在唯一口径里出现：它的算法刻意不用 `getHours()`，
     * 这样"固定时区"才是可注入的。）
     */
    const shared = stripComments(readFileSync(path.join(ROOT, SHARED), "utf8"));
    for (const id of ["LOCAL-OR-UTC-OFFSET", "UTC-FIELDS"]) {
      const rule = SELF_FORMAT_RULES.find((r) => r.id === id)!;
      expect(rule.re.test(shared), `唯一口径里应当有 ${id} 的原语（否则它自己也不是"那一处"）`).toBe(true);
    }
  });

  it("全仓（除唯一口径与登记例外）不许出现自造时间格式", () => {
    const { hits } = scanSelfFormats();
    const report = hits.map((h) => `  - ${h.rel}:${h.line} [${h.ruleId}] ${h.text}`).join("\n");
    expect(
      hits,
      `下列位置在自己算时间（应改走 src/core/time/local-time.ts；` +
        `确实不该改的，登记进本判据的 ALLOWLIST 并写明理由）：\n${report}`,
    ).toEqual([]);
  });

  it("正向：已知的『给人看的时间』位置都必须引用唯一口径", () => {
    const missing = MUST_USE_SHARED.filter((rel) => {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      return !/from\s+["'][^"']*time\/local-time(?:\.ts)?["']/.test(src);
    });
    expect(
      missing,
      `这些位置是给人看的时间，必须引用唯一口径（否则又会各算一份）：\n  - ${missing.join("\n  - ")}`,
    ).toEqual([]);
  });

  it("例外表本身不许过期（登记的文件必须仍然存在，且确实还命中规则）", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const full = path.join(ROOT, rel);
      expect(() => statSync(full), `ALLOWLIST 里的 ${rel} 不存在了 ⇒ 例外条目该删`).not.toThrow();
      const code = stripComments(readFileSync(full, "utf8"));
      const hit = SELF_FORMAT_RULES.some((r) => r.re.test(code));
      expect(hit, `ALLOWLIST 里的 ${rel} 已经不命中任何规则 ⇒ 例外条目该删（否则它只是掩盖）`).toBe(true);
    }
  });
});

// ===================== 判据 ②：跨日边界 =====================

/**
 * R7 的正身：**固定时区**（东八区）+ 条目时间戳落在 `UTC 16:30`（= 本地**次日** 00:30）。
 * 注入文本里的 `[日期]` 必须是**本地当天**。
 */
describe("TIME-SINGLE-SOURCE②：记忆行的 [日期] 必须按本地日（跨日边界）", () => {
  const TS = Date.UTC(2026, 9, 7, 16, 30, 0); // 本地(+08:00) = 2026-10-08 00:30；UTC 日 = 2026-10-07

  /** 固定"东八区"（`getTimezoneOffset()` = -480） */
  function withFixedEast8<T>(fn: () => T): T {
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
    try {
      return fn();
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(() => {
    setStoragePort(createFakeStoragePort());
    saveMemory("");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("唯一口径本身的契约（本地日/时分/偏移）", () => {
    withFixedEast8(() => {
      const at = new Date(TS);
      expect(localDateString(at), "本地 00:30 必须是**当天**（UTC 日比它早一天）").toBe("2026-10-08");
      expect(localDateTimeString(at), "紧凑本地时间").toBe("2026-10-08 00:30:00");
      expect(localClockString(at), "本地时分秒").toBe("00:30:00");
      expect(localClockString(at, { seconds: false }), "本地时分").toBe("00:30");
      expect(offsetLabel(localTimeParts(at).offsetMinutes), "偏移标注").toBe("+08:00");
    });
    // 另一侧（西五区）：同一瞬时是**前一天** 11:30 ⇒ 说明上面不是"恒等于 10-08"的假绿
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    try {
      const at = new Date(TS);
      expect(localDateString(at)).toBe("2026-10-07");
      expect(localClockString(at)).toBe("11:30:00");
    } finally {
      spy.mockRestore();
    }
  });

  it("注入文本里的 [日期] 必须是本地当天（旧实现取 UTC 日 ⇒ 显示 2026-10-07，红）", () => {
    withFixedEast8(() => {
      const svc = new MemoryService();
      const added = svc.add({ scope: "platform", key: "边界条目", content: "DAY_BOUNDARY_MARKER", source: "manual" });
      expect(added.ok).toBe(true);
      // `add` 用真实时钟写 timestamp ⇒ 判据显式把这条钉在边界时刻上
      (svc as unknown as { entries: Map<string, { timestamp: number }> }).entries.get(added.entry!.id)!.timestamp = TS;

      const text = svc.buildMemoryPrompt("platform");
      expect(text, "条目必须出现在注入文本里（否则判据空转）").toContain("DAY_BOUNDARY_MARKER");
      expect(
        text,
        `[日期] 必须是**本地当天**（+08:00 的 00:30）；UTC 日是 ${new Date(TS).toISOString().slice(0, 10)}`,
      ).toContain("[2026-10-08]");
      expect(text, "不许显示前一天（旧实现的 UTC 日形态）").not.toContain("[2026-10-07]");

      // 导出（Markdown）走同一处 `safeDate` ⇒ 必须同样按本地日
      expect(svc.exportAsMarkdown(), "导出的日期与注入文本同一口径").toContain("**Date**: 2026-10-08");
    });
  });
});
