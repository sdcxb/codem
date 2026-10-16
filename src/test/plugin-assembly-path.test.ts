/**
 * **插件装配路径**判据（`config/codem.base.yml` → `loadFromEntries` → `ctx.plugin`）。
 *
 * ## 守的缺陷（2026-10-16 真机，两条独立缺陷）
 *
 * ### ① 插件"注册了"但从来没被装配（`@codem/shell-ops` 那次）
 *
 * `registerBuiltinPlugins()` 只把插件写进**注册表**（插件管理器与可达性门禁因此都看得到），
 * 而桌面应用真正的装配入口是 `App.tsx` → `mergeYamlEntries(base, desktop)` →
 * `loadFromEntries()` → `ctx.plugin()`。只写注册表 ⇒ `apply` 从不执行 ⇒ 服务从不被提供
 * ⇒ 消费方 `getToolContext()?.get("shellOps")` 拿不到 ⇒ **静默回退 PowerShell**。
 *
 * 更贵的一课：上一轮的判据钉在 `src/core/provider/index.ts::loadDefaultProviders()` 上 ——
 * 那是**死代码**（全仓没有调用者、可达性扫描判它不可达，2026-10-16 已删除），
 * 于是"单测全绿、功能全死"。所以本文件的判据只认**真实装配面**。
 *
 * ### ② 平台条件（`when`）全部失效
 *
 * `parseCodemYaml` 会把值里的引号去掉（`value.trim().replace(/['"]/g, '')`），
 * 而 `evaluateWhen` 的两个正则**都要求引号存在** ⇒ 一个都匹配不上 ⇒ `return true`：
 * 标了"非 Windows"的 `bash-sandbox` / `tmux-context` 在 Windows 上照样装配，
 * 标了"Windows"的 shell-ops 的作用域也只是摆设。
 *
 * ## 判据
 * | # | 行为 |
 * |---|---|
 * | YW-1/YW-2 | `when` 的真实解析形态（不带引号）+ 正/负两个方向的装配决定 |
 * | SO-6 | `@codem/shell-ops` 必须在真实装配清单里声明（含 Windows 作用域） |
 * | SO-8 | **全量对账**：注册表里每一个插件都必须有真实装配路径（YAML 或 `loadUIPlugins`），**零例外** |
 * | SO-9 | YAML 里声明的每个名字都必须真的在注册表里（反向对账，防拼写漂移） |
 * | WHEN-1 | 清单里每个 `when` 都必须是受支持的形式（认不出来的 ⇒ 红，不许静默放行） |
 * | WHEN-2 | 每个 `when` 条目的装配/跳过决定都必须与**独立**期望一致（全覆盖，不是抽样） |
 * | CAT-1 | 插件市场目录宣称提供的服务，必须有**已装配**的提供者（唯一允许的例外逐条写明） |
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { Context } from "../core/cordis/src/index.ts";
import { builtinPlugins } from "../core/plugin-loader/index";
import { loadFromEntries, mergeYamlEntries, type YamlPluginEntry } from "../core/plugin-loader/yaml-loader";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const REGISTRY_SRC = path.join(ROOT, "src/core/plugin-loader/builtin-registry.ts");
const UI_LOADER_SRC = path.join(ROOT, "src/core/ui-plugins/index.ts");
const CATALOG_SRC = path.join(ROOT, "src/core/provider/plugin-registry-provider.ts");

/** 桌面应用的真实装配清单（App.tsx: mergeYamlEntries(baseYml, desktopYml) → loadFromEntries）。 */
function readAssemblyEntries(): YamlPluginEntry[] {
  const baseYml = fs.readFileSync(path.join(ROOT, "config/codem.base.yml"), "utf8");
  const desktopYml = fs.readFileSync(path.join(ROOT, "config/codem.desktop.yml"), "utf8");
  return mergeYamlEntries(baseYml, desktopYml);
}

/** 注册表源码 → 注册名 + 它宣称提供的服务（注册表的**唯一**文本来源）。 */
function registeredPlugins(): Array<{ name: string; provides: string[] }> {
  const src = fs.readFileSync(REGISTRY_SRC, "utf8");
  const out: Array<{ name: string; provides: string[] }> = [];
  for (const m of src.matchAll(/registerBuiltinPlugin\(\s*'([^']+)',\s*\{([^}]*)\}/g)) {
    const p = /provides:\s*\[([^\]]*)\]/.exec(m[2]);
    out.push({
      name: m[1],
      provides: p ? p[1].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean) : [],
    });
  }
  return out;
}

/** UI 装配路径（`loadUIPlugins()`）里列出的插件名（`{ name: 'ui-x', … }`）。 */
function uiLoaderNames(): Set<string> {
  const src = fs.readFileSync(UI_LOADER_SRC, "utf8");
  return new Set([...src.matchAll(/\{\s*name:\s*'([^']+)'/g)].map((m) => "@codem/" + m[1]));
}

/**
 * 规则本体：哪些"注册了但没有装配路径"。
 *
 * ⚠️ 抽成函数是为了**反向对照** —— 真数据上必须返回空，合成数据上必须抓得到
 * （否则这条判据可能只是"看起来在判"）。
 */
function findUnassembled(
  registered: readonly string[],
  yamlDeclared: ReadonlySet<string>,
  uiLoaded: ReadonlySet<string>,
): string[] {
  return registered.filter((n) => !yamlDeclared.has(n) && !uiLoaded.has(n));
}

const WIN_ONLY = "@codem/yw-win-only";
const NON_WIN = "@codem/yw-non-win";
const SYNTHETIC = [WIN_ONLY, NON_WIN];

/** 与 config/codem.base.yml 同格式的两条合成条目（经由**真实解析器**）。 */
function syntheticEntries() {
  const text = [
    "- id: yw-win-only",
    `  name: '${WIN_ONLY}'`,
    "  when: platform == 'win32'",
    "- id: yw-non-win",
    `  name: '${NON_WIN}'`,
    "  when: platform != 'win32'",
  ].join("\n");
  return mergeYamlEntries(text, "");
}

function registerSynthetic(name: string) {
  builtinPlugins.set(name, {
    meta: { name, provides: [], inject: [], core: false } as never,
    apply: () => () => {},
  });
}

/** 测试侧的**独立**平台条件求值（故意不用实现里的正则，避免"两边一起错"）。 */
function whenShouldAssemble(when: string, platform: string): boolean {
  const parts = when.trim().split(/\s+/); // ["platform", "==", "win32"]
  const target = parts[2].replace(/['"]/g, "");
  return parts[1] === "==" ? platform === target : platform !== target;
}

afterEach(() => {
  for (const n of SYNTHETIC) builtinPlugins.delete(n);
  vi.restoreAllMocks();
});

describe("YAML 装配清单的平台条件（when）", () => {
  it("YW-1: 真实解析器会把 when 里的引号去掉（所以正则不能要求引号）", () => {
    const entries = syntheticEntries();
    const win = entries.find((e) => e.id === "yw-win-only");
    const non = entries.find((e) => e.id === "yw-non-win");
    expect(win?.when, "解析后的形态就是平台条件判定函数真正拿到的东西").toBe("platform == win32");
    expect(non?.when).toBe("platform != win32");
  });

  it("YW-2: platform == win32 在 win32 上装配、platform != win32 必须被跳过（反向对照）", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerSynthetic(WIN_ONLY);
    registerSynthetic(NON_WIN);

    const ctx = new Context();
    const res = loadFromEntries(ctx as any, syntheticEntries());

    const isWin = process.platform === "win32";
    // 期望值按当前平台算 ⇒ 这条判据在 Windows 与 Linux 上都有意义（不是只在 Windows 上绿）
    const expectLoaded = isWin ? ["yw-win-only"] : ["yw-non-win"];
    const expectSkipped = isWin ? ["yw-non-win"] : ["yw-win-only"];

    expect(res.loaded.slice().sort(), "该装配的必须装配").toEqual(expectLoaded);
    expect(
      res.skipped.filter((s) => s.includes("platform")),
      "不该装配的必须被平台条件跳掉（改坏前这里是空的：两个都会被装配）",
    ).toEqual(expectSkipped.map((id) => expect.stringContaining(id)));
  });

  it("WHEN-1: 清单里每个 when 都必须是受支持的形式（认不出来 ⇒ 红，不许静默放行）", () => {
    const withWhen = readAssemblyEntries().filter((e) => e.when);
    expect(withWhen.length, "清单里必须有 when 条目，否则这条判据没有对象").toBeGreaterThan(0);
    const unsupported = withWhen
      .filter((e) => !/^platform\s*(==|!=)\s*['"]?[A-Za-z0-9_-]+['"]?$/.test(e.when!.trim()))
      .map((e) => `${e.id}: ${e.when}`);
    expect(unsupported, "只支持 platform == X / platform != X（别的写法实现里会 warn 后按通过处理）").toEqual([]);
  });

  it("MS-1: 覆盖层只写 `disabled: true` 时，base 的 name/inject/when/core 必须原样保留", () => {
    /**
     * 缺陷（2026-10-16，由 SO-9 的反向对账挖出来）：`codem.desktop.yml` 里 9 条覆盖条目只写
     * `disabled: true`，没有 `name`；解析器对缺失字段给的是**空串**，
     * 而 `mergeYamlEntries` 用 `{...existing, ...entry}` 覆盖 ⇒ base 的 `name` 被抹成 `''`。
     *
     * 后果不是"少个名字"这么轻：`registerActiveFiber(entry.name, fiber)` 把它们**全登记在同一个空 key**
     * 下（只剩最后一条），插件管理器按真实名字永远找不到那些 fiber ⇒ 这 9 个插件的"真卸载"失效。
     * 装配本身侥幸还能成（`@codem/<id>` 回退救了它）—— 靠回退兜住的错不会报错。
     */
    // 合成对照：overlay 只给 disabled，base 的每个字段都要活下来
    const merged = mergeYamlEntries(
      ["- id: ms-probe", "  name: '@codem/ms-probe'", "  inject: [fs]", "  when: platform == 'win32'", "  core: true"].join("\n"),
      ["- id: ms-probe", "  disabled: true"].join("\n"),
    );
    const probe = merged.find((e) => e.id === "ms-probe");
    expect(probe, "合并后条目要还在").toBeTruthy();
    expect(probe!.name, "name 不许被覆盖层抹掉").toBe("@codem/ms-probe");
    expect(probe!.inject, "inject 不许被覆盖层抹掉").toEqual(["fs"]);
    expect(probe!.when, "when 不许被覆盖层抹掉").toBe("platform == win32");
    expect(probe!.core, "core 不许被覆盖层抹掉").toBe(true);
    expect(probe!.disabled, "disabled 是覆盖层**真的给了**的值，必须生效").toBe(true);

    // 真配置：桌面覆盖层关掉的那 9 条必须都有非空 name，且确实是 disabled
    const entries = readAssemblyEntries();
    const nameless = entries.filter((e) => !e.name).map((e) => e.id);
    expect(nameless, "合并后的清单里**不许有**没有 name 的条目（那会让 fiber 登记撞在同一个空 key 上）").toEqual([]);
    const desktopDisabled = [
      "host-webserver",
      "host-apiproxy",
      "host-frontend-static",
      "api-gateway",
      "remote-client",
      "cordis-client-runner",
      "cordis-host-runner",
      "cli",
      "host",
    ];
    for (const id of desktopDisabled) {
      const e = entries.find((x) => x.id === id);
      expect(e, `${id} 必须在合并后的清单里`).toBeTruthy();
      expect(e!.name, `${id} 的 name 必须来自 base（覆盖层没写）`).toMatch(/^@codem\//);
      expect(e!.disabled, `${id} 必须被桌面覆盖层禁用`).toBe(true);
    }
  });

  it("WHEN-2: 每个 when 条目的装配/跳过决定都必须与**独立**期望一致（全覆盖）", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const entries = readAssemblyEntries().filter((e) => e.when && !e.disabled);
    expect(entries.length, "必须有可判的 when 条目").toBeGreaterThan(0);

    const names = [...new Set(entries.map((e) => e.name))];
    for (const n of names) registerSynthetic(n);
    try {
      const ctx = new Context();
      const res = loadFromEntries(ctx as any, entries);
      const platform = process.platform;
      const wantAssembled = entries.filter((e) => whenShouldAssemble(e.when!, platform)).map((e) => e.id).sort();
      const wantSkipped = entries.filter((e) => !whenShouldAssemble(e.when!, platform)).map((e) => e.id).sort();
      const gotSkipped = res.skipped
        .filter((s) => s.includes("(platform:"))
        .map((s) => s.split(" ")[0])
        .sort();
      expect(res.loaded.slice().sort(), `平台=${platform}：该装配的必须装配（全覆盖 ${entries.length} 条）`).toEqual(
        wantAssembled,
      );
      expect(gotSkipped, "该跳过的必须跳过（全覆盖，不是抽样）").toEqual(wantSkipped);
    } finally {
      for (const n of names) builtinPlugins.delete(n);
    }
  });
});

describe("插件的装配路径（YAML 清单 / loadUIPlugins 才是会 apply 的入口）", () => {
  it("SO-6: 必须在**真实装配清单**（YAML）里声明 —— 只写注册表 / 只写死代码都没用", () => {
    /**
     * 真机抓到的缺陷：插件在注册表里、在（死代码）`loadDefaultProviders` 里都有，
     * 但**没有出现在任何 YAML 装配清单里** ⇒ `loadFromEntries` 从来不会 `ctx.plugin` 它
     * ⇒ 服务从没被提供 ⇒ 执行层 `get('shellOps')` 拿不到 ⇒ 静默回退 PowerShell。
     * 真机三处证据：设置键 `codem-shell-ops-enabled` 不存在、console 里没有 `[shell-ops]`、
     * Rust 日志里没有 `exec shell=bash`。
     */
    const entry = readAssemblyEntries().find((e) => e.name === "@codem/shell-ops" || e.id === "shell-ops");
    expect(entry, "必须出现在 config/codem.base.yml（或 desktop 覆盖层）里 —— YAML 清单才是会 apply 的入口").toBeTruthy();
    expect(entry!.name, "装配清单里的插件名必须与注册表 key 完全一致").toBe("@codem/shell-ops");
    expect(entry!.disabled, "默认开启：不许被 disabled").not.toBe(true);
    expect(
      entry!.when,
      "作用域必须是 Windows（注册表 meta 也是 platform:['win32']）—— 别在 Linux/macOS 上改掉 shell 行为。" +
        "注意引号是可选的：解析器会先把 when 值里的引号去掉（见本文件 YW-1）",
    ).toMatch(/platform\s*==\s*['"]?win32['"]?/);

    const registry = fs.readFileSync(REGISTRY_SRC, "utf8");
    expect(registry, "注册表里也要有（插件管理器按 name 启停 / 真卸载）").toContain("'@codem/shell-ops'");
  });

  it("SO-8: 全量对账 —— 注册表里**每一个**插件都必须有真实装配路径（零例外）", () => {
    const registered = registeredPlugins();
    expect(registered.length, "注册表必须真的被解析到（防止判据自己变成哑巴）").toBeGreaterThan(150);

    const yamlDeclared = new Set<string>();
    for (const e of readAssemblyEntries()) {
      yamlDeclared.add(e.name);
      yamlDeclared.add(`@codem/${e.id}`);
    }
    const uiLoaded = uiLoaderNames();

    const offenders = findUnassembled(registered.map((p) => p.name), yamlDeclared, uiLoaded);

    /**
     * 反向对照（**这条判据本身有效吗**）：同样一段规则，喂给它一个"注册了但没有装配路径"
     * 的合成条目，必须抓得到。否则"零例外"可能只是因为规则恒返回空。
     */
    const syntheticOffenders = findUnassembled(
      ["@codem/really-registered-but-never-assembled"],
      yamlDeclared,
      uiLoaded,
    );
    expect(syntheticOffenders, "反向对照：合成出来的'注册了但没装配'必须被这条规则抓到").toEqual([
      "@codem/really-registered-but-never-assembled",
    ]);

    const covered = registered.filter((p) => yamlDeclared.has(p.name) || uiLoaded.has(p.name)).length;
    expect(
      offenders,
      `注册 ${registered.length} 个，有装配路径 ${covered} 个。` +
        "这些插件注册了但没有任何装配路径（服务永远不会被提供、插件管理器也卸载不了它）：要么在 " +
        "config/codem.base.yml 里声明，要么像 UI 插件那样挂进 src/core/ui-plugins/index.ts 的 loadUIPlugins；" +
        "**不许再加例外表**（2026-10-16 起是零例外）。",
    ).toEqual([]);
    expect(covered, "装配覆盖必须等于注册表规模（这条数字就是要可核对）").toBe(registered.length);
  });

  it("SO-9: 反向对账 —— YAML 里声明的每个插件名都必须真的在注册表里（防拼写漂移）", () => {
    const registered = new Set(registeredPlugins().map((p) => p.name));
    const declared = readAssemblyEntries().map((e) => ({ id: e.id, name: e.name }));
    const ghosts = declared.filter((d) => !registered.has(d.name)).map((d) => `${d.id}: ${d.name}`);
    expect(
      ghosts,
      "YAML 里声明了、但注册表里没有的条目 —— 装配时会被 `not found in builtin registry` 静默跳过" +
        "（启动汇总会报未激活）。要么名字写错了，要么该插件没注册。",
    ).toEqual([]);
  });

  it("CAT-1: 插件市场目录宣称提供的服务，必须有**已装配**的提供者", () => {
    /**
     * 缺陷形态：目录（`plugin-registry-provider.ts` 的 `KNOWN_PLUGINS`，插件管理器直接展示）
     * 对着用户宣称"关闭后基础 UI 组件不可用 / 输入触发器不可用 / 技能面板不可用"，
     * 而那些服务**全仓没有任何消费者、也没有任何装配路径** —— 是纯粹的假承诺。
     *
     * 唯一允许的例外写在下面这张表里（逐条给理由，并要求"例外必须被真的用到"）。
     */
    const ALLOWED: Record<string, string> = {
      slots: "由 App.tsx 直接 `ctx.plugin(SlotsService)` 提供，不走 builtin 注册表（目录里那条是它的元数据）",
    };

    const catalogSrc = fs.readFileSync(CATALOG_SRC, "utf8");
    const entries: Array<{ name: string; provides: string[] }> = [];
    for (const m of catalogSrc.matchAll(/\{\s*name:\s*'(@codem\/[^']+)'[^\n]*?provides:\s*\[([^\]]*)\]/g)) {
      entries.push({
        name: m[1],
        provides: m[2].split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean),
      });
    }
    expect(entries.length, "目录必须真的被解析到").toBeGreaterThan(150);

    const yamlDeclared = new Set<string>();
    for (const e of readAssemblyEntries()) {
      yamlDeclared.add(e.name);
      yamlDeclared.add(`@codem/${e.id}`);
    }
    const uiLoaded = uiLoaderNames();
    const assembledProviders = new Map<string, string[]>();
    for (const p of registeredPlugins()) {
      const assembled = yamlDeclared.has(p.name) || uiLoaded.has(p.name);
      if (!assembled) continue;
      for (const s of p.provides) {
        if (!assembledProviders.has(s)) assembledProviders.set(s, []);
        assembledProviders.get(s).push(p.name);
      }
    }

    const broken: string[] = [];
    const allowedHits = new Set<string>();
    for (const e of entries) {
      for (const s of e.provides) {
        if (assembledProviders.has(s)) continue;
        if (ALLOWED[s]) {
          allowedHits.add(s);
          continue;
        }
        broken.push(`${e.name} 宣称提供 ${s}，但没有已装配的提供者`);
      }
    }
    expect(broken, "目录对用户的承诺必须与真实装配面一致（假承诺会被这条判据抓住）").toEqual([]);
    expect(
      [...allowedHits].sort(),
      "例外表必须被真的用到（否则它就是一句没人读的注释）；数量也只有这一个",
    ).toEqual(Object.keys(ALLOWED).sort());
  });
});
