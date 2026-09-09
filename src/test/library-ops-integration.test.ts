/**
 * LO-INT — 插件集成与皮肤契约
 *
 * 覆盖：插件注册链路（builtin-registry / 插件元数据 / UI 插件装载与禁用门控）、
 * provider 的 slot 注册与释放、皮肤令牌契约（零硬编码色值）、设置持久化。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findHardcodedColors } from "../core/theme/skin-tokens";

const ROOT = join(__dirname, "..", "..");
const PLUGIN_DIR = join(ROOT, "src", "plugins", "library-ops");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** 递归收集插件目录下的源码文件 */
function pluginSources(dir = PLUGIN_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pluginSources(full));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

describe("LO-INT 插件注册链路", () => {
  it("LO-INT-1: builtin-registry 注册 @codem/ui-library-ops（provides uiLibraryOps / inject slots）", () => {
    const src = read("src/core/plugin-loader/builtin-registry.ts");
    expect(src).toContain("uiLibraryOpsProvider");
    expect(src).toContain("@codem/ui-library-ops");
    expect(src).toMatch(/registerBuiltinPlugin\(\s*'@codem\/ui-library-ops',\s*\{[^}]*provides:\s*\['uiLibraryOps'\][^}]*inject:\s*\['slots'\]/);
  });

  it("LO-INT-2: 插件元数据存在，riskLevel=safe 且声明 app.overlay 影响面", () => {
    const src = read("src/core/provider/plugin-registry-provider.ts");
    expect(src).toContain("@codem/ui-library-ops");
    const line = src.split("\n").find((l) => l.includes("@codem/ui-library-ops"))!;
    expect(line).toContain("riskLevel: 'safe'");
    expect(line).toContain("app.overlay");
    expect(line).toContain("library-ops-launcher");
  });

  it("LO-INT-3: UI 插件装载器导入该 provider 并在禁用时跳过装配（门控）", () => {
    const src = read("src/core/ui-plugins/index.ts");
    expect(src).toContain("uiLibraryOpsProvider");
    expect(src).toMatch(/name:\s*'ui-library-ops'/);
    // 门控逻辑收敛到独立模块，装载器消费它
    expect(src).toContain("isUiProviderGated");
    expect(src).toContain("readDisabledPlugins");
    const gating = read("src/core/ui-plugins/gating.ts");
    expect(gating).toMatch(/["']ui-library-ops["']\s*:\s*["']@codem\/ui-library-ops["']/);
    // ui-pet 的既有门控行为必须保留（回归保护）
    expect(gating).toMatch(/["']ui-pet["']\s*:\s*["']@codem\/ui-pet["']/);
  });

  it("LO-INT-4: provider 把入口组件注册到 app.overlay 并返回复合 dispose", async () => {
    const { uiLibraryOpsProvider } = await import("../core/provider/ui-library-ops-provider");
    const registered: Array<{ spec: any; comp: any }> = [];
    let disposed = 0;
    let provided: string | null = null;
    const ctx = {
      get: (name: string) => {
        if (name !== "slots") return null;
        return {
          register(spec: any, comp: any) {
            registered.push({ spec, comp });
            return () => {
              disposed++;
            };
          },
        };
      },
      provide(name: string, _svc: any) {
        provided = name;
        return () => {
          disposed++;
        };
      },
    };
    const dispose = (uiLibraryOpsProvider as any)(ctx);
    expect(registered.length).toBe(1);
    expect(registered[0].spec.name).toBe("app.overlay");
    expect(registered[0].spec.id).toBe("library-ops-launcher");
    expect(typeof registered[0].comp).toBe("function");
    expect(provided).toBe("uiLibraryOps");
    expect(typeof dispose).toBe("function");
    dispose();
    // provide + slot 各回收一次
    expect(disposed).toBe(2);
  });

  it("LO-INT-5: provider 声明 inject: ['slots']（框架保证 slots 就绪）", async () => {
    const { uiLibraryOpsProvider } = await import("../core/provider/ui-library-ops-provider");
    expect((uiLibraryOpsProvider as any).inject).toEqual(["slots"]);
  });

  it("LO-INT-6: 插件目录结构完整（入口 / 类型 / 数据 / 逻辑 / 组件 / 样式 / 文档）", () => {
    for (const rel of [
      "index.ts",
      "types.ts",
      "store.ts",
      "README.md",
      "data/library-map.ts",
      "data/characters.ts",
      "core/pathfinder.ts",
      "core/scene-engine.ts",
      "core/telemetry-adapter.ts",
      "core/format.ts",
      "components/LibraryOpsLauncher.tsx",
      "components/LibraryOpsPanel.tsx",
      "components/library/LibraryScene.tsx",
      "components/library/CharacterActor.tsx",
      "styles/library-ops.css",
    ]) {
      expect(existsSync(join(PLUGIN_DIR, rel)), `${rel} 应存在`).toBe(true);
    }
  });

  it("LO-INT-7: 插件不从宿主写接口导入（只读契约）", () => {
    const forbidden = [
      /\bsetSetting\b/,
      /\bsaveMessages\b/,
      /\bcreateMessage\b/,
      /\bdeleteMessage\b/,
      /\bupdateSquad\b/,
      /\bdeleteSquad\b/,
      /\baddMember\s*\(/,
      /\bdeleteTeam\b/,
      /\bcreateTask\b/,
    ];
    for (const file of pluginSources()) {
      const src = readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(re.test(src), `${file} 不应包含写宿主调用 ${re}`).toBe(false);
      }
    }
  });

  it("LO-INT-8: 插件禁用门控 —— 只有出现在禁用列表时才跳过装配", async () => {
    const { isUiProviderGated, GATED_PROVIDERS, readDisabledPlugins } = await import("../core/ui-plugins/gating.ts");
    expect(GATED_PROVIDERS["ui-library-ops"]).toBe("@codem/ui-library-ops");
    // ui-pet 的既有门控行为必须保留
    expect(GATED_PROVIDERS["ui-pet"]).toBe("@codem/ui-pet");

    expect(isUiProviderGated("ui-library-ops", [])).toBe(false);
    expect(isUiProviderGated("ui-library-ops", ["@codem/ui-game"])).toBe(false);
    expect(isUiProviderGated("ui-library-ops", ["@codem/ui-library-ops"])).toBe(true);
    // 未登记门控的插件永不被跳过
    expect(isUiProviderGated("ui-conversation", ["@codem/ui-library-ops"])).toBe(false);

    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-library-ops"]));
    expect(readDisabledPlugins()).toEqual(["@codem/ui-library-ops"]);
    localStorage.setItem("codem:disabled-plugins", "{坏数据");
    expect(readDisabledPlugins()).toEqual([]);
    localStorage.removeItem("codem:disabled-plugins");
    expect(readDisabledPlugins()).toEqual([]);
  });
});

describe("LO-SKIN 皮肤兼容契约", () => {
  it("LO-SKIN-1: 插件全部源码（含 CSS/TSX 内联样式）零硬编码色值", () => {
    const violations: string[] = [];
    for (const file of pluginSources()) {
      const src = readFileSync(file, "utf8");
      // 剥离 color-mix(...) 内的令牌引用后扫描（color-mix 本身不含色值）
      const hits = findHardcodedColors(src);
      for (const h of hits) violations.push(`${file.replace(ROOT, "")}:${h.line} → ${h.color}`);
    }
    expect(violations, `发现硬编码色值：\n${violations.join("\n")}`).toEqual([]);
  });

  it("LO-SKIN-2: 插件 CSS 只使用已登记的皮肤令牌前缀", () => {
    const raw = readFileSync(join(PLUGIN_DIR, "styles", "library-ops.css"), "utf8");
    // 注释里的示例 token 不计入（只扫描真实声明）
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const used = new Set<string>();
    for (const m of css.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);
    const allowedPrefixes = ["--bg-", "--text-", "--border-", "--accent", "--success", "--warning", "--error", "--info", "--security-", "--sidebar-bg", "--input-bg", "--code-bg", "--scrollbar-", "--tooltip-", "--dropdown-", "--user-bg", "--assistant-bg", "--system-bg", "--fs-", "--radius", "--shadow-", "--duration-", "--ease-", "--transition-", "--z-", "--lo-"];
    for (const token of used) {
      const ok = allowedPrefixes.some((p) => token.startsWith(p));
      expect(ok, `令牌 ${token} 不在契约允许的前缀集合内`).toBe(true);
    }
    expect(used.size).toBeGreaterThan(10);
  });

  it("LO-SKIN-3: 角色动画为 11 种状态全部定义了关键帧", () => {
    const css = readFileSync(join(PLUGIN_DIR, "styles", "library-ops.css"), "utf8");
    const activities = [
      "idle",
      "walking",
      "thinking",
      "reading",
      "writing",
      "working",
      "searching",
      "blocked",
      "done",
      "error",
      "sleeping",
    ];
    for (const a of activities) {
      expect(css, `${a} 缺少动画规则`).toContain(`.lo-actor[data-anim="${a}"]`);
    }
    // 关键帧数量应覆盖全部动作
    const keyframes = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    expect(keyframes.size).toBeGreaterThanOrEqual(10);
  });

  it("LO-SKIN-4: 尊重系统「减少动效」偏好（可访问性）", () => {
    const css = readFileSync(join(PLUGIN_DIR, "styles", "library-ops.css"), "utf8");
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("LO-STORE 设置持久化", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("LO-STORE-1: 无持久化时使用默认设置", async () => {
    const { loadSettings } = await import("../plugins/library-ops/store");
    const s = loadSettings();
    expect(s.refreshMs).toBe(1500);
    expect(s.speed).toBe(1);
    expect(s.maxActors).toBe(24);
    expect(s.showNameplates).toBe(true);
    expect(s.defaultTab).toBe("overview");
  });

  it("LO-STORE-2: 非法持久化值被收敛到安全区间（不抛错）", async () => {
    localStorage.setItem(
      "codem-library-ops",
      JSON.stringify({ refreshMs: 1, speed: 999, maxActors: -5, defaultTab: "overview" }),
    );
    const { loadSettings } = await import("../plugins/library-ops/store");
    const s = loadSettings();
    expect(s.refreshMs).toBe(500);
    expect(s.speed).toBe(4);
    expect(s.maxActors).toBe(4);
  });

  it("LO-STORE-3: 损坏的 JSON 回退默认值", async () => {
    localStorage.setItem("codem-library-ops", "{不是 JSON");
    const { loadSettings } = await import("../plugins/library-ops/store");
    expect(loadSettings().refreshMs).toBe(1500);
  });

  it("LO-STORE-4: updateSettings 写入 localStorage；_reset 复位内存状态", async () => {
    const { useLibraryOps, loadSettings } = await import("../plugins/library-ops/store");
    useLibraryOps.getState().updateSettings({ refreshMs: 3000, showBubbles: false });
    expect(loadSettings().refreshMs).toBe(3000);
    expect(loadSettings().showBubbles).toBe(false);
    useLibraryOps.getState()._reset();
    expect(useLibraryOps.getState().settings.refreshMs).toBe(1500);
    expect(useLibraryOps.getState().open).toBe(false);
  });

  it("LO-STORE-5: sortedActors 按严重度排序（错误 > 阻塞 > 活跃 > 完成 > 空闲）", async () => {
    const { sortedActors } = await import("../plugins/library-ops/store");
    const mk = (id: string, activity: any) => ({
      id,
      name: id,
      roleLabel: "x",
      kind: "member" as const,
      look: { paletteId: 0, body: 0, hair: 0, hat: 0, prop: 0, face: 0, scale: 1, hueShift: 0 },
      activity,
      statusLabel: "",
      lastEventAt: 0,
      metrics: { tasks: 0, done: 0, failed: 0, tools: 0, tokens: 0, cost: 0, errors: 0 },
      preferredZoneId: "reading-hall",
    });
    const snap = {
      at: 0,
      actors: [mk("idle", "idle"), mk("err", "error"), mk("work", "working"), mk("block", "blocked")],
      teams: [],
      metrics: {} as any,
      events: [],
      activity: { perDay: {}, perHour: [], kinds: {} },
      sources: {} as any,
      sampleMs: 0,
    };
    const order = sortedActors(snap as any).map((a) => a.id);
    expect(order).toEqual(["err", "block", "work", "idle"]);
    expect(sortedActors(null)).toEqual([]);
  });
});
