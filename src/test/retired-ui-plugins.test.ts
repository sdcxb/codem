/**
 * 下架的 4 个「假 UI 插件」不许回潮；四项能力的**真实实现**必须点得出名字（2026-10-17）。
 *
 * ## 背景（为什么需要这条判据）
 *
 * 2026-10-16 下架了 4 个「注册了但服务是假的」插件：`@codem/ui-primitives` /
 * `@codem/ui-input-trigger` / `@codem/ui-agent-preset` / `@codem/ui-skill-panel`。
 * 它们的共同形状是：注册表里有名字、市场目录里对用户宣称「关闭后基础 UI 组件 / 输入触发器 /
 * Agent 预设面板 / 技能面板不可用」，而实现侧只是**没有任何消费者的 Map / 占位组件**，
 * 且**没有任何装配路径**（既不在 `config/*.yml`，也不在 `loadUIPlugins`）——
 * 也就是说：删掉它们**一个字节的用户可见行为都不会变**。
 *
 * 上一轮只有静态证据（零消费者 + 全量测试绿）。本轮补了真机走查（构建 release exe +
 * CDP 逐项操作并截图）；这条判据把走查结论钉住，防止「下一次又把名字加回去」，
 * 同时把「能力由谁提供」从口头说法变成**可执行的断言**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | RUP-1 | 注册表不许再出现这 4 个名字：不许 `registerBuiltinPlugin(...)`、不许再 import 那 4 个 provider 文件 |
 * | RUP-2 | 插件市场目录（`plugin-registry-provider.ts` 的 `KNOWN_PLUGINS`）不许再出现这 4 个名字 |
 * | RUP-3 | 装配清单（`config/codem.base.yml` + `codem.desktop.yml`）不许再**启用**这 4 个 id（注释里写名字可以） |
 * | RUP-4 | 四项能力的真实实现必须在位且被接线（逐条点名文件/符号，见下面 `REAL_IMPLEMENTATIONS`） |
 * | RUP-5 | 那 4 个假服务（`uiPrimitives` / `uiInputTrigger` / `uiAgentPreset` / `uiSkillPanel`）不许出现任何读取方 |
 *
 * 每条都带**反向对照**：把一段合成的「回潮样本」喂给同一个检查函数，必须被判红
 * ——否则「检查通过」可能只是因为检查器恒返回空（本仓库吃过这个亏）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

/** 已下架的 4 个插件（名字 = 注册表/目录里的键；服务 = 它们当年 provide 的假服务） */
const RETIRED: ReadonlyArray<{ name: string; service: string; providerFile: string }> = [
  { name: "@codem/ui-primitives", service: "uiPrimitives", providerFile: "ui-primitives-provider.ts" },
  { name: "@codem/ui-input-trigger", service: "uiInputTrigger", providerFile: "ui-input-trigger-provider.ts" },
  { name: "@codem/ui-agent-preset", service: "uiAgentPreset", providerFile: "ui-agent-preset-provider.ts" },
  { name: "@codem/ui-skill-panel", service: "uiSkillPanel", providerFile: "ui-skill-panel-provider.ts" },
];

const RETIRED_NAMES = RETIRED.map((r) => r.name);
const RETIRED_SERVICES = RETIRED.map((r) => r.service);

const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const exists = (...p: string[]) => fs.existsSync(path.join(ROOT, ...p));

/** RUP-1 的检查器：注册表文本里有没有「重新登记」的痕迹（纯函数，便于反向对照） */
function findRegistryReintroductions(src: string): string[] {
  const hits: string[] = [];
  for (const { name, providerFile } of RETIRED) {
    // 只看真正的代码行（`//` 注释行不算：交接记录/说明里允许写名字）
    const activeLines = src
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    const body = activeLines.join("\n");
    if (body.includes(`registerBuiltinPlugin('${name}'`) || body.includes(`registerBuiltinPlugin("${name}"`)) {
      hits.push(`registerBuiltinPlugin：${name}`);
    }
    if (new RegExp(`from\\s+['"][^'"]*${providerFile.replace(/\.ts$/, "")}`).test(body)) {
      hits.push(`import：${providerFile}`);
    }
  }
  return hits;
}

/** RUP-2 的检查器：市场目录（KNOWN_PLUGINS 字面量）里有没有重新登记 */
function findCatalogReintroductions(src: string): string[] {
  const hits: string[] = [];
  const activeLines = src
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const { name } of RETIRED) {
    if (new RegExp(`name:\\s*['"]${name.replace(/[/@]/g, "\\$&")}['"]`).test(activeLines)) {
      hits.push(`KNOWN_PLUGINS：${name}`);
    }
  }
  return hits;
}

/** RUP-3 的检查器：YAML 里有没有**未注释**的装配条目 */
function findYamlReintroductions(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue; // 注释里写「已下架」是允许的
    for (const { name } of RETIRED) {
      if (trimmed.includes(`name: '@codem/${name.replace("@codem/", "")}'`) || trimmed.includes(`name: "${name}"`)) {
        hits.push(`yml：${trimmed.slice(0, 80)}`);
      }
      const id = name.replace("@codem/", "");
      if (new RegExp(`^\\s*-\\s*id:\\s*['"]?${id.replace(/-/g, "\\-")}['"]?\\s*$`).test(line)) {
        hits.push(`yml id：${id}`);
      }
    }
  }
  return hits;
}

/** RUP-4：四项能力的真实实现（文件 + 必须出现的符号），每一条都对应真机走查里看到的那块界面 */
const REAL_IMPLEMENTATIONS: ReadonlyArray<{
  capability: string;
  landing: string;
  checks: ReadonlyArray<{ file: string; must: RegExp[]; why: string }>;
}> = [
  {
    capability: "基础 UI 组件（Button/Input/Card/Badge/Switch/Dialog…）",
    landing: "src/components/ui/*（Radix + 语义类名），由具体面板直接 import",
    checks: [
      { file: "src/components/ui/badge.tsx", must: [/export \{ Badge/, /className=\{cn\("badge"/], why: "Badge 原语" },
      { file: "src/components/ui/switch.tsx", must: [/@radix-ui\/react-switch/, /switch-root/], why: "Switch 原语" },
      { file: "src/components/ui/card.tsx", must: [/export \{ Card/, /card-header/], why: "Card 原语" },
      { file: "src/components/ui/dialog.tsx", must: [/@radix-ui\/react-dialog/, /DialogContent/], why: "Dialog 原语" },
      {
        file: "src/components/SkillManager.tsx",
        must: [/from "\.\/ui\/badge"/, /from "\.\/ui\/switch"/, /from "\.\/ui\/dialog"/],
        why: "技能面板是这些原语的真实消费者（真机截图里 31 个 badge / 11 个 switch 就是它们渲染的）",
      },
    ],
  },
  {
    capability: "输入触发器（/ 技能命令、@ 提及）",
    landing: "src/components/InputArea.tsx 的 onChange 正则 + SlashCommandMenu / MentionAutocomplete",
    checks: [
      {
        file: "src/components/InputArea.tsx",
        must: [
          /\(?:\^\|\\s\)\\\/\(\[\^\\s\]\*\)\$/,
          /\(?:\^\|\\s\)@\(\[\^\\s\]\*\)\$/,
          /from "\.\/SlashCommandMenu"/,
          /from "\.\/MentionAutocomplete"/,
          /listFilesForMention/,
        ],
        why: "两个触发字符在同一处解析；候选分别来自技能注册表与真实文件系统列举",
      },
      { file: "src/components/SlashCommandMenu.tsx", must: [/getSkillRegistry\(\)\.getAll\(\)/, /codem-disabled-skills/], why: "/ 候选的真实数据源" },
      { file: "src/components/MentionAutocomplete.tsx", must: [/mention-autocomplete/, /filtered\.slice\(0, 20\)/], why: "@ 候选的渲染者" },
    ],
  },
  {
    capability: "Agent 预设（内置 build/plan/explore/general/title/summary/verify + 用户自定义）",
    landing: "src/core/agent/agent.ts 的 AgentRegistry + src/components/AgentManager.tsx 渲染",
    checks: [
      { file: "src/core/agent/agent.ts", must: [/BUILTIN_AGENT_IDS/, /id: "build"/], why: "内置预设的定义处" },
      { file: "src/components/AgentManager.tsx", must: [/getAgentRegistry\(\)/, /isBuiltin\(/], why: "预设列表/详情的渲染者" },
      { file: "src/App.tsx", must: [/import \{ AgentManager \} from "\.\/components\/AgentManager"/, /fallback=\{AgentManager\}/], why: "侧边栏「智能体」入口的真实接线" },
      {
        file: "src/components/PermissionPresetSelector.tsx",
        must: [/SECURITY_MODES/, /setGlobalSecurityMode/, /setProjectSecurityMode/],
        why: "预设的快速切换 UI（真机里切到「替我审批」后派发 codem-security-mode-changed）",
      },
    ],
  },
  {
    capability: "技能面板（列表 / 启停 / 安装 / 删除 / 市场）",
    landing: "src/components/SkillManager.tsx + src/core/skill/*（registry / installer / market client）",
    checks: [
      { file: "src/components/SkillManager.tsx", must: [/getSkillRegistry\(\)/, /installSkillFromZip/, /listMarketSkills/, /uninstallSkill/], why: "列表/安装/市场/删除四处数据源" },
      { file: "src/App.tsx", must: [/import \{ SkillManager \} from "\.\/components\/SkillManager"/, /fallback=\{SkillManager\}/], why: "侧边栏「技能」入口的真实接线" },
    ],
  },
];

function missingImplementationChecks(sources: Map<string, string>): string[] {
  const missing: string[] = [];
  for (const cap of REAL_IMPLEMENTATIONS) {
    for (const check of cap.checks) {
      const src = sources.get(check.file);
      if (src === undefined) {
        missing.push(`${cap.capability} → 缺文件 ${check.file}（${check.why}）`);
        continue;
      }
      for (const re of check.must) {
        if (!re.test(src)) missing.push(`${cap.capability} → ${check.file} 缺 ${re}（${check.why}）`);
      }
    }
  }
  return missing;
}

/** 递归收集 src 下的 .ts/.tsx（跳过 node_modules，理论上没有） */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("下架的 4 个假 UI 插件：不许回潮，真实实现必须在位", () => {
  it("RUP-1: 注册表不许重新登记这 4 个插件（含 provider import）", () => {
    const registrySrc = read("src/core/plugin-loader/builtin-registry.ts");
    const hits = findRegistryReintroductions(registrySrc);
    expect(hits, `注册表出现了已下架插件的重新登记：${hits.join("；")}`).toEqual([]);

    // 文件本身也不该回来（它们的存在就是「有人又加了一遍」的最直接信号）
    for (const { providerFile } of RETIRED) {
      expect(exists("src/core/provider", providerFile), `provider 文件不该回来：${providerFile}`).toBe(false);
    }

    // 反向对照：同一段检查器喂「回潮样本」，必须抓得到（否则上面那条可能恒真）
    const sample = [
      "import { uiPrimitivesProvider } from '../provider/ui-primitives-provider'",
      "registerBuiltinPlugin('@codem/ui-skill-panel', { provides: ['uiSkillPanel'] }, () => uiSkillPanelProvider)",
    ].join("\n");
    const sampleHits = findRegistryReintroductions(sample);
    expect(sampleHits.length, "反向对照：检查器必须能抓到合成的回潮样本").toBeGreaterThanOrEqual(2);
  });

  it("RUP-2: 插件市场目录不许重新登记这 4 个插件", () => {
    const catalogSrc = read("src/core/provider/plugin-registry-provider.ts");
    const hits = findCatalogReintroductions(catalogSrc);
    expect(hits, `市场目录出现了已下架插件：${hits.join("；")}`).toEqual([]);

    // 反向对照
    const sample = `    { name: '@codem/ui-primitives', version: '1.0.0', provides: ['uiPrimitives'] },`;
    expect(findCatalogReintroductions(sample).length, "反向对照：目录检查器必须能抓到合成样本").toBe(1);

    // 目录必须还是「真的」的（否则本条可能只是在读一个空文件）
    expect(catalogSrc.length, "目录文件不该是空的").toBeGreaterThan(10000);
    expect(catalogSrc).toContain("@codem/ui-game");
  });

  it("RUP-3: 装配清单不许重新启用这 4 个 id（注释里写名字允许）", () => {
    const yml = read("config/codem.base.yml") + "\n" + read("config/codem.desktop.yml");
    const hits = findYamlReintroductions(yml);
    expect(hits, `装配清单重新启用了已下架插件：${hits.join("；")}`).toEqual([]);

    // 反向对照：未注释的条目必须被抓到；注释掉的同一条不许被抓到
    const active = "  - id: ui-primitives\n    name: '@codem/ui-primitives'";
    const commented = "# " + active.split("\n").join("\n# ");
    expect(findYamlReintroductions(active).length, "反向对照：未注释条目必须被抓到").toBeGreaterThan(0);
    expect(findYamlReintroductions(commented), "注释里的历史说明不该误报").toEqual([]);
  });

  it("RUP-4: 四项能力的真实实现必须在位且被接线（点名到文件/符号）", () => {
    const files = listSourceFiles(path.join(ROOT, "src"));
    const sources = new Map<string, string>();
    for (const f of files) {
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      sources.set(rel, fs.readFileSync(f, "utf8"));
    }
    const missing = missingImplementationChecks(sources);
    expect(missing, `真实实现断线：\n${missing.join("\n")}`).toEqual([]);

    // 四项能力必须有名字（判据本身就是「点名」的载体，防止表被悄悄清空）
    expect(REAL_IMPLEMENTATIONS.length).toBe(4);
    expect(REAL_IMPLEMENTATIONS.map((c) => c.capability).join("|")).toMatch(/基础 UI 组件/);

    // 反向对照：把真实源替换成「只有占位组件、没有触发正则、没有注册表」的假实现，必须全部判红
    const broken = new Map(sources);
    broken.set("src/components/InputArea.tsx", "export function InputArea() { return null }");
    broken.set("src/components/SkillManager.tsx", "// placeholder\n");
    broken.set("src/App.tsx", "// no wiring\n");
    const brokenMissing = missingImplementationChecks(broken);
    expect(brokenMissing.length, "反向对照：接线检查必须能抓到断线的实现").toBeGreaterThan(5);
  });

  it("RUP-5: 那 4 个假服务不许出现任何读取方（ctx.get / ctx.inject 都算）", () => {
    const files = listSourceFiles(path.join(ROOT, "src"));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      if (rel.startsWith("src/test/")) continue; // 判据自己会写这些词
      const src = fs.readFileSync(f, "utf8");
      for (const svc of RETIRED_SERVICES) {
        const re = new RegExp(`\\.get\\(\\s*['"]${svc}['"]|\\.inject\\(\\s*\\[\\s*['"]${svc}['"]`);
        if (re.test(src)) offenders.push(`${rel}：读取 ${svc}`);
      }
    }
    expect(offenders, `已下架服务出现了消费者：\n${offenders.join("\n")}`).toEqual([]);

    // 反向对照：合成一段读取方必须被抓到
    const sample = "const p = ctx.get('uiPrimitives')";
    const sampleTouched = RETIRED_SERVICES.some((svc) =>
      new RegExp(`\\.get\\(\\s*['"]${svc}['"]`).test(sample),
    );
    expect(sampleTouched, "反向对照：消费者检查器必须能抓到合成样本").toBe(true);
  });
});
