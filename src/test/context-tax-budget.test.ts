/**
 * P0-2「上下文税」账本 —— 把**每一轮固定成本**变成可复跑的读数与棘轮。
 *
 * ## 为什么要有这个判据
 *
 * 上下文治理最容易退化成"感觉变短了"：改完没人量，过两个版本又长回来。
 * mcode-stack 的 `context-tax-audit` / `tool-budget-audit` 给的做法是同一件事：
 * **先量，再改，改完用同一个读数确认**。这里把它落成判据，量三样东西：
 *
 * | 项 | 量什么 | 为什么 |
 * | --- | --- | --- |
 * | 工具定义 | 常驻工具（`getCoreDefinitions`）序列化后的字符数 | 每轮都随请求发出去，是按"定义"收的税 |
 * | 延迟工具 | deferred 的**完整 schema 不在**常驻集里 | 延迟加载若失效，等于没延迟（每轮又付一遍） |
 * | 技能清单 | 注册表里所有 description 的总字符 + 单条最大值 | 技能清单每轮注入；正文按需 `load_skill` |
 *
 * ## 读数口径（写清楚，别拿它当 token）
 *
 * 这里数的是**字符**，不是 token：仓库里没有稳定的分词器，编一个"约等于 token"的
 * 系数只会制造假精度。字符数的作用是**相对棘轮**（这次比上次长还是短），
 * 真实 token 以 provider 的 `usage` 为准（`cacheHitTokens` / `promptTokens` 都在库里）。
 *
 * 棘轮只许收紧：预算上调必须在交付说明里写理由（与 `SKEY`/`GAIN` 那些棘轮同一纪律）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { createDefaultToolRegistry } from "../core/llm/tools";
import {
  createSubagentTool,
  createSendMessageTool,
  createInterruptAgentTool,
  createListAgentsTool,
} from "../core/llm/tools/subagent-tools";
import {
  createDelegateToSessionTool,
  createHandoffToNewSessionTool,
  createWaitForDelegationTool,
  createQuerySessionResultTool,
  createListSessionsTool,
  createCancelDelegationTool,
  createSetSessionInternalTool,
} from "../core/session";
import {
  createSquadListTool,
  createSquadDispatchTool,
  createSquadStatusTool,
} from "../core/squad/squad-tools";
import { registerAgentTeamsTools } from "../core/agent-teams/tools";
import {
  createIssueCreateTool,
  createIssueUpdateTool,
  createIssueCommentTool,
  createIssueListTool,
} from "../core/issue/issue-tools";
import { registerComputerUseTools } from "../core/computer-use/computer-use";
import {
  clampSkillDescription,
  getSkillRegistry,
  SKILL_DESCRIPTION_PROMPT_LIMIT,
} from "../core/skill/skill";

/**
 * 常驻工具定义的字符预算（2026-10-29 实测 25,547，约 12% 余量）。
 *
 * 超了先问三件事：新工具是不是低频（→ `shouldDefer`）？描述有没有把
 * 使用说明写成小作文（→ 下沉到 guidance/文档）？schema 是不是能合并（按用户意图合并工具）？
 *
 * 2026-11-06：C06 的 `doc_ledger` 从常驻改为 defer（871 字符；它只在读写文档的
 * 任务里有动作可做，覆盖摘要已由尾部注入免费给出），常驻读数 30,939 → 30,067。
 */
const TOOL_SCHEMA_CHAR_BUDGET = 31_000;

/** 技能描述总字符预算（2026-10-29 实测 2,068，留出再加两三个技能的余量） */
const SKILL_CATALOG_CHAR_BUDGET = 3_000;

/**
 * 延迟工具的 searchHint 预算。
 *
 * defer **不是免费**的：每个 defer 工具的 `name + searchHint` 每轮都随
 * systemPrompt 的「Deferred Tools」段落发出去，只省掉完整 schema。所以这里
 * 单独给 hint 记账，防止「把所有工具都标 defer、再写一段小作文当 hint」。
 *
 * 2026-11-06 实测：静态 19 个 2,722 + 动态 23 个 3,050 = 5,772（预算 6,500，约 11% 余量）。
 */
const DEFERRED_HINT_CHAR_BUDGET = 6_500;

/**
 * 运行时动态注册的工具（`LLMEngine.setupDelegationTools` 那六批 + `whenToolsReady`）。
 *
 * 为什么必须单独量：它们**不在** `createDefaultToolRegistry()` 里，却和静态工具一样
 * 每轮都随请求发出去。只量静态那 48 个会把总成本低估三分之一。
 *
 * ## 口径（2026-11-06 修正）
 *
 * 这里量的是**每轮固定成本**，所以 defer 工具按 `name + searchHint` 计，
 * 完整 schema 只在 `tool_search` 按需拉取时出现，不能算进固定成本。
 * 修正前一律按完整 schema 累加，把 agent-teams（12 个）与 computer-use（11 个）
 * 两批**已经 defer** 的工具又算了一遍（多算 4,775 字符）—— 这既让读数偏高，
 * 也让「把低频工具标 defer」这个正确动作对读数**完全没有效果**。
 */
const DYNAMIC_TOOL_CHAR_BUDGET = 19_000;

/**
 * 三项合计预算：常驻完整 schema + 静态 deferred hints + 动态每轮实际成本。
 *
 * 2026-10-29 实测 44,167；2026-11-06 修正口径后实测 45,841（预算仍为 48,000，
 * 没有上调 —— 先按 defer / 文案 / hint 压缩消化新增成本）。
 */
const TOTAL_TOOL_CHAR_BUDGET = 48_000;

const REPO_SKILLS_DIR = path.join(__dirname, "..", "core", "skills");

/** 从 SKILL.md 的 frontmatter 里取一个字段（只认单行 `key: value`，与仓库约定一致） */
function frontmatterField(text: string, key: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!m) return null;
  const line = m[1]
    .split(/\r?\n/u)
    .find((l) => new RegExp(`^${key}\\s*:`, "u").test(l.trim()));
  if (!line) return null;
  return line.replace(new RegExp(`^${key}\\s*:\\s*`, "u"), "").trim().replace(/^["']|["']$/g, "");
}

describe("P0-2 上下文税账本", () => {
  it("常驻工具定义不超过预算（每轮都付的钱）", () => {
    const registry = createDefaultToolRegistry();
    const core = registry.getCoreDefinitions();
    const total = JSON.stringify(core).length;
    const perTool = core
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars);

    // 读数是给人看的：交付说明里直接引用它
    console.log(
      `[context-tax] 常驻工具 ${core.length} 个，定义合计 ${total} 字符；最大的三个：` +
        perTool.slice(0, 3).map((t) => `${t.name}=${t.chars}`).join(", "),
    );

    expect(total, `常驻工具定义 ${total} 字符超过预算 ${TOOL_SCHEMA_CHAR_BUDGET}`).toBeLessThanOrEqual(
      TOOL_SCHEMA_CHAR_BUDGET,
    );
  });

  it("延迟加载真的省到了：deferred 工具的完整 schema 不在常驻集里", () => {
    const registry = createDefaultToolRegistry();
    const coreNames = new Set(registry.getCoreDefinitions().map((t) => t.name));
    const deferred = registry.getDeferredDefinitions();

    expect(deferred.length, "至少要有一批低频大 schema 工具走延迟加载").toBeGreaterThan(0);
    for (const d of deferred) {
      expect(coreNames.has(d.name), `deferred 工具 ${d.name} 的完整 schema 不该同时常驻`).toBe(false);
    }
    // 反向：tool_search 必须常驻，否则模型没法把延迟工具取回来
    expect(coreNames.has("tool_search"), "tool_search 必须常驻（否则延迟工具不可达）").toBe(true);
    // defer 的提示也每轮发：hint 写成长篇同样在收税
    expect(
      JSON.stringify(deferred).length,
      `静态 deferred 工具的 name+hint 合计 ${JSON.stringify(deferred).length} 字符超过预算 ${DEFERRED_HINT_CHAR_BUDGET}`,
    ).toBeLessThanOrEqual(DEFERRED_HINT_CHAR_BUDGET);
  });

  it("运行时动态工具（委派/团队/Bot/Issue/computer-use）也计入账本", () => {
    const groups: Array<[string, any[]]> = [
      ["subagent", [createSubagentTool(), createSendMessageTool(), createInterruptAgentTool(), createListAgentsTool()]],
      [
        "delegation",
        [
          createDelegateToSessionTool(),
          createHandoffToNewSessionTool(),
          createWaitForDelegationTool(),
          createQuerySessionResultTool(),
          createListSessionsTool(),
          createCancelDelegationTool(),
          createSetSessionInternalTool(),
        ],
      ],
      ["squad", [createSquadListTool(), createSquadDispatchTool(), createSquadStatusTool()]],
      ["agent-teams", [] as any[]],
      ["bots", [] as any[]],
      ["issue", [createIssueCreateTool(), createIssueUpdateTool(), createIssueCommentTool(), createIssueListTool()]],
      ["computer-use", [] as any[]],
    ];
    registerAgentTeamsTools((t: any) => groups[3][1].push(t));
    /* 走真实注册函数，才能量到 `shouldDefer` + `searchHint` 实际每轮发出去的那一段 */
    registerComputerUseTools((t: any) => groups[5][1].push(t));

    /** 完整 schema（只用于对照：deferred 的这部分**不**进每轮请求） */
    const fullDefOf = (t: any) => ({ name: t.id, description: t.description, parameters: t.parameters });
    /**
     * 每轮实际发出去的定义（与 `agentic-loop.ts` 的两条读取路径一一对应）：
     * - 普通工具 ⇒ 完整 schema 进 `tools` 数组；
     * - `shouldDefer` 工具 ⇒ `name + searchHint` 进 systemPrompt 的 Deferred Tools 段落
     *   （完整 schema 只在模型 `tool_search` 时按需返回）。
     */
    const perTurnDefOf = (t: any) =>
      t.shouldDefer
        ? { name: t.id, searchHint: t.searchHint || String(t.description ?? "").substring(0, 120) }
        : fullDefOf(t);

    let dynamicChars = 0;
    let dynamicFullChars = 0;
    let dynamicHintChars = 0;
    let dynamicCount = 0;
    let deferredCount = 0;
    const rows: string[] = [];
    for (const [name, tools] of groups) {
      const fullChars = JSON.stringify(tools.map(fullDefOf)).length;
      const chars = JSON.stringify(tools.map(perTurnDefOf)).length;
      const hintChars = JSON.stringify(tools.filter((t: any) => t.shouldDefer).map(perTurnDefOf)).length;
      const deferred = tools.filter((t: any) => t.shouldDefer).length;
      dynamicChars += chars;
      dynamicFullChars += fullChars;
      dynamicHintChars += hintChars;
      dynamicCount += tools.length;
      deferredCount += deferred;
      rows.push(`${name}=${tools.length}/${chars}（完整 ${fullChars}${deferred ? `，defer ${deferred}` : ""}）`);
    }

    const registry = createDefaultToolRegistry();
    const coreChars = JSON.stringify(registry.getCoreDefinitions()).length;
    const staticHintsChars = JSON.stringify(registry.getDeferredDefinitions()).length;
    const total = coreChars + staticHintsChars + dynamicChars;

    console.log(
      `[context-tax] 动态工具 ${dynamicCount} 个（defer ${deferredCount} 个）/ 每轮 ${dynamicChars} 字符` +
        `（完整 schema 对照 ${dynamicFullChars}）；静态 deferred hints ${staticHintsChars}；` +
        `静态 ${coreChars}；合计 ${total} 字符`,
    );
    console.log(`[context-tax] 动态分组：${rows.join(" ")}`);

    expect(
      dynamicChars,
      `动态工具每轮实际 ${dynamicChars} 字符超过预算 ${DYNAMIC_TOOL_CHAR_BUDGET}`,
    ).toBeLessThanOrEqual(DYNAMIC_TOOL_CHAR_BUDGET);
    // 反向：漏测也要红 —— 否则"把测量循环删掉"会让预算永远通过
    expect(dynamicCount, "动态工具数量不该是 0（测量被漏掉了吗？）").toBeGreaterThanOrEqual(30);
    expect(
      dynamicChars,
      "动态工具每轮实际字符数不该小到像没量（defer 只去掉完整 schema，不会让工具消失）",
    ).toBeGreaterThan(10_000);
    expect(deferredCount, "动态工具里也必须有走延迟加载的低频批次（否则每轮都在付全量 schema）").toBeGreaterThan(0);
    expect(
      staticHintsChars + dynamicHintChars,
      `deferred 工具的 name+hint 合计 ${staticHintsChars + dynamicHintChars} 字符超过预算 ${DEFERRED_HINT_CHAR_BUDGET}`,
    ).toBeLessThanOrEqual(DEFERRED_HINT_CHAR_BUDGET);
    expect(
      total,
      `工具定义合计 ${total} 字符超过预算 ${TOTAL_TOOL_CHAR_BUDGET}`,
    ).toBeLessThanOrEqual(TOTAL_TOOL_CHAR_BUDGET);
  });

  it("技能清单：单条描述不超预算，总量不超预算", () => {
    const skills = getSkillRegistry().getAll();
    const over = skills.filter((s) => (s.description ?? "").length > SKILL_DESCRIPTION_PROMPT_LIMIT);
    const total = skills.reduce((n, s) => n + (s.description ?? "").length, 0);

    console.log(
      `[context-tax] 注册技能 ${skills.length} 个，description 合计 ${total} 字符，` +
        `最长 ${Math.max(...skills.map((s) => (s.description ?? "").length))} 字符`,
    );

    expect(
      over.map((s) => `${s.name}(${s.description.length})`),
      `这些技能的 description 超过 ${SKILL_DESCRIPTION_PROMPT_LIMIT} 字，请把细则移进 SKILL.md 正文`,
    ).toEqual([]);
    expect(total, `技能描述合计 ${total} 字符超过预算 ${SKILL_CATALOG_CHAR_BUDGET}`).toBeLessThanOrEqual(
      SKILL_CATALOG_CHAR_BUDGET,
    );
  });

  it("仓库自带的 SKILL.md 也守同一条预算（清单不只来自注册表）", () => {
    const dirs = fs
      .readdirSync(REPO_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.length, "src/core/skills 下应当有技能目录").toBeGreaterThan(0);

    for (const dir of dirs) {
      const file = path.join(REPO_SKILLS_DIR, dir, "SKILL.md");
      expect(fs.existsSync(file), `${dir} 缺少 SKILL.md`).toBe(true);
      const text = fs.readFileSync(file, "utf8");
      const name = frontmatterField(text, "name");
      const description = frontmatterField(text, "description") ?? "";
      expect(name, `${dir}/SKILL.md 的 frontmatter 缺 name`).toBeTruthy();
      expect(name, `${dir}/SKILL.md 的 name 必须与目录名一致`).toBe(dir);
      expect(
        description.length,
        `${dir}/SKILL.md 的 description 超过 ${SKILL_DESCRIPTION_PROMPT_LIMIT} 字`,
      ).toBeLessThanOrEqual(SKILL_DESCRIPTION_PROMPT_LIMIT);
      expect(description.trim(), `${dir}/SKILL.md 的 description 不能为空`).not.toBe("");
    }
  });

  it("clampSkillDescription：超限时截断并留下省略号，未超限原样返回", () => {
    expect(clampSkillDescription("short")).toBe("short");
    const long = "a".repeat(SKILL_DESCRIPTION_PROMPT_LIMIT + 500);
    const clamped = clampSkillDescription(long);
    expect(clamped.length).toBe(SKILL_DESCRIPTION_PROMPT_LIMIT);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("P1-6: 提示侧真的用上了预算（不是只有一个纯函数在自娱自乐）", () => {
    const registry = getSkillRegistry();
    const long = "z".repeat(SKILL_DESCRIPTION_PROMPT_LIMIT + 200);
    registry.register({
      name: "budget-probe",
      description: long,
      prompt: "probe",
      contextMode: "inline",
      source: "builtin",
    });
    try {
      const prompt = registry.buildSkillPrompt();
      const line = prompt.split("\n").find((l) => l.includes("budget-probe"));
      expect(line, "探测技能应当出现在技能清单里").toBeTruthy();
      expect(
        line!.length,
        "清单里那一行必须被裁到预算内（否则每轮都在为一段只用来触发的文字付钱）",
      ).toBeLessThan(SKILL_DESCRIPTION_PROMPT_LIMIT + 100);
      expect(line!.endsWith("…"), "截断要留下省略号，让模型知道它不完整").toBe(true);
    } finally {
      registry.remove("budget-probe");
    }
  });
});
