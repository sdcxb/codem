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
 * 那是**死代码**（全仓没有调用者、可达性扫描判它不可达），于是"单测全绿、功能全死"。
 * 所以本文件的判据只认**真实装配清单**。
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
 * | YW-1 | 走真实解析器后 `when` 值**不带引号**（把这件事钉住，免得有人又把"必须有引号"写回正则） |
 * | YW-2 | `platform == 'win32'` 在 win32 上装配、`platform != 'win32'` 必须**被跳过**（反向对照） |
 * | SO-6 | `@codem/shell-ops` 必须在真实装配清单里声明（含 Windows 作用域） |
 * | SO-8 | 通用棘轮：注册表里的**非 UI 插件**必须在 YAML 清单里，否则永远不 apply |
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { Context } from "../core/cordis/src/index.ts";
import { builtinPlugins } from "../core/plugin-loader/index";
import { loadFromEntries, mergeYamlEntries, type YamlPluginEntry } from "../core/plugin-loader/yaml-loader";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

/** 桌面应用的真实装配清单（App.tsx: mergeYamlEntries(baseYml, desktopYml) → loadFromEntries）。 */
function readAssemblyEntries(): YamlPluginEntry[] {
  const baseYml = fs.readFileSync(path.join(ROOT, "config/codem.base.yml"), "utf8");
  const desktopYml = fs.readFileSync(path.join(ROOT, "config/codem.desktop.yml"), "utf8");
  return mergeYamlEntries(baseYml, desktopYml);
}

/**
 * 允许「只在注册表里、不在 YAML 清单里」的遗留项（**逐条给理由**，不许无声扩张）。
 *
 * 判据 SO-8 的形状就是：除了 UI 插件（由 `loadUIPlugins(ctx)` 另一条路径装配）与这张表，
 * 其余注册表条目都必须在 YAML 清单里。这张表里每一条都是**已知的同类遗留**
 * （注册了但没有任何装配路径 ⇒ 服务永远不会被提供），登记在案、不在本次修复范围。
 */
const KNOWN_REGISTRY_ONLY: Record<string, string> = {
  "@codem/ui-game": "默认禁用的游戏面板；仓库内已有取证（plugin-manager-service.ts:419 起）说明它「本次进程里根本没有被装载」，属已知形态（同类遗留，已登记）",
  "@codem/ui-primitives": "UI 原语，注册表遗留：只在注册表与死代码 provider/index.ts 里出现，无装配路径（同类遗留，已登记）",
  "@codem/ui-input-trigger": "同上（同类遗留，已登记）",
  "@codem/ui-agent-preset": "同上（同类遗留，已登记）",
  "@codem/ui-skill-panel": "同上（同类遗留，已登记）",
};

const WIN_ONLY = "@codem/yw-win-only";
const NON_WIN = "@codem/yw-non-win";

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

afterEach(() => {
  builtinPlugins.delete(WIN_ONLY);
  builtinPlugins.delete(NON_WIN);
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
});

describe("插件的装配路径（YAML 清单才是会 apply 的入口）", () => {
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

    const registry = fs.readFileSync(path.join(ROOT, "src/core/plugin-loader/builtin-registry.ts"), "utf8");
    expect(registry, "注册表里也要有（插件管理器按 name 启停 / 真卸载）").toContain("'@codem/shell-ops'");
  });

  it("SO-8: 通用棘轮 —— 注册表里的非 UI 插件必须在 YAML 清单里，否则永远不 apply", () => {
    const registrySrc = fs.readFileSync(path.join(ROOT, "src/core/plugin-loader/builtin-registry.ts"), "utf8");
    const registered = [...registrySrc.matchAll(/registerBuiltinPlugin\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(registered.length, "注册表必须真的被解析到（防止判据本身变成哑巴）").toBeGreaterThan(100);

    const declared = new Set<string>();
    for (const e of readAssemblyEntries()) {
      declared.add(e.name);
      declared.add(`@codem/${e.id}`);
    }

    // UI 插件走另一条装配路径：src/core/ui-plugins/index.ts 的 loadUIPlugins(ctx)
    const uiLoaderSrc = fs.readFileSync(path.join(ROOT, "src/core/ui-plugins/index.ts"), "utf8");
    const known = new Set(Object.keys(KNOWN_REGISTRY_ONLY));

    const offenders = registered.filter((name) => {
      if (declared.has(name)) return false;
      if (known.has(name)) return false;
      const short = name.replace(/^@codem\//, "");
      if (name.startsWith("@codem/ui-") && uiLoaderSrc.includes(short)) return false;
      return true;
    });

    expect(
      offenders,
      "这些插件注册了但没有任何装配路径（服务永远不会被提供、插件管理器也卸载不了它）。" +
        "要么在 config/codem.base.yml 里声明，要么像 UI 插件那样给出真实装配入口；" +
        "确实是遗留的，请带着理由登记进 KNOWN_REGISTRY_ONLY。",
    ).toEqual([]);
  });
});
