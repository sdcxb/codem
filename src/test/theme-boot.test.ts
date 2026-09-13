/**
 * 启动主题契约（第 60 波）。
 *
 * 用户报的老问题（三个现象一个根因）：默认皮肤暗色时，启动加载先白后暗；浅色时先黑后亮；
 * 偶尔还黑→亮→黑。根因是「镜像（localStorage）与真相源（SQLite 的 codem-theme）从不校准」，
 * 而每次启动 TitleBar 挂载时都会用**默认档**去应用主题 —— 既把预渲染好的档位覆盖掉，
 * 又把镜像改错，于是下次启动继续闪：
 *   · 暗色用户：预渲染暗 → 挂载被改浅（白闪）→ DB 就绪后改回暗；若进程提前退出，镜像永久停在浅色；
 *   · 浅色用户：镜像停在暗色（更早的一次会话写坏）→ 每次启动先黑一帧。
 *
 * 契约：启动路径一律走 `resolveEffectiveTheme()`（**DB → 镜像 → 默认档**），
 * 且 `applyThemeAttribute()` 幂等 —— 档位没变就不碰 DOM、不改镜像。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THEME,
  THEME_CACHE_KEY,
  resolveEffectiveTheme,
  applyThemeAttribute,
  readCachedTheme,
  cacheTheme,
} from "../core/theme/theme-default";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("启动主题契约（第 60 波）", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    vi.restoreAllMocks();
  });

  it("THEME-BOOT-1: 启动期取值 = DB（就绪后）→ 镜像 → 默认档", () => {
    // ① DB 未就绪（读返回 null）：用镜像 —— 这正是 index.html 预渲染时用的值
    localStorage.setItem(THEME_CACHE_KEY, "dark");
    expect(resolveEffectiveTheme(() => null), "DB 未就绪时必须沿用镜像，不能落回默认档").toBe("dark");
    localStorage.setItem(THEME_CACHE_KEY, "light");
    expect(resolveEffectiveTheme(() => null)).toBe("light");

    // ② DB 就绪且有效：DB 优先（真相源）
    localStorage.setItem(THEME_CACHE_KEY, "light");
    expect(resolveEffectiveTheme((k) => (k === "codem-theme" ? "dark" : null))).toBe("dark");

    // ③ DB 里是垃圾值 / 没设置：仍回落到镜像，最后才是默认档
    expect(resolveEffectiveTheme(() => "purple")).toBe("light");
    localStorage.removeItem(THEME_CACHE_KEY);
    expect(readCachedTheme()).toBe(DEFAULT_THEME);
    expect(resolveEffectiveTheme(() => null)).toBe(DEFAULT_THEME);
  });

  it("THEME-BOOT-2: 应用主题是幂等的（同档位不碰 DOM、不改镜像）", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const setAttribute = vi.spyOn(document.documentElement, "setAttribute");

    applyThemeAttribute("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("dark");
    const writesAfterFirst = setItem.mock.calls.length;
    const attrsAfterFirst = setAttribute.mock.calls.filter((c) => c[0] === "data-theme").length;

    // 再应用同一个值 3 次：不应有任何新的属性写入，也不应重写镜像
    applyThemeAttribute("dark");
    applyThemeAttribute("dark");
    applyThemeAttribute("dark");
    expect(setAttribute.mock.calls.filter((c) => c[0] === "data-theme").length, "同档位不得重复写 data-theme").toBe(attrsAfterFirst);
    expect(setItem.mock.calls.length, "同档位不得重复写镜像").toBe(writesAfterFirst);

    // 换档位才写
    applyThemeAttribute("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("light");
  });

  it("THEME-BOOT-3: 复现用户场景——预渲染暗色后，启动路径不得把它改成浅色", () => {
    // 场景：暗色用户，上次会话正确写入了镜像；index.html 内联脚本已把 data-theme 设成 dark
    localStorage.setItem(THEME_CACHE_KEY, "dark");
    document.documentElement.setAttribute("data-theme", "dark");

    // 启动早期（DB 还没就绪）：TitleBar / SkinSelector / ThemeManager 都用这个解析器取初值
    const bootTheme = resolveEffectiveTheme(() => null);
    expect(bootTheme, "启动初值必须是镜像里的暗色（而不是默认档浅色）").toBe("dark");
    applyThemeAttribute(bootTheme);
    expect(document.documentElement.getAttribute("data-theme"), "不得出现黑→亮→黑里的那个中间浅色").toBe("dark");

    // DB 就绪后读到真相源 = 暗色 → 依然不产生任何切换
    const dbTheme = resolveEffectiveTheme((k) => (k === "codem-theme" ? "dark" : null));
    expect(dbTheme).toBe("dark");
    applyThemeAttribute(dbTheme);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // 反向：用户其实是浅色（镜像曾写坏成暗色）→ DB 就绪后纠正一次，且镜像随之校准
    localStorage.setItem(THEME_CACHE_KEY, "dark");
    document.documentElement.setAttribute("data-theme", "dark");
    const corrected = resolveEffectiveTheme((k) => (k === "codem-theme" ? "light" : null));
    expect(corrected).toBe("light");
    applyThemeAttribute(corrected);
    expect(localStorage.getItem(THEME_CACHE_KEY), "镜像必须跟着真相源校准，否则下次启动还会闪").toBe("light");
  });

  it("THEME-BOOT-4: index.html 的内联脚本仍然在首屏前按镜像设好 data-theme", () => {
    const html = read("index.html");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script, "index.html 应有首屏主题镜像脚本").toContain(THEME_CACHE_KEY);
    expect(script).toContain("data-theme");

    // 真执行一遍这段脚本（模拟首屏）：镜像为 dark 时必须设置 data-theme=dark
    localStorage.setItem(THEME_CACHE_KEY, "dark");
    document.documentElement.removeAttribute("data-theme");
    new Function(script)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // 镜像缺失时不设属性（由 CSS :root 兜默认档）
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    new Function(script)();
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
  });

  it("THEME-BOOT-5: 源码契约——启动路径不得再各自 `|| 默认档`", () => {
    const titleBar = read("src/components/TitleBar.tsx");
    expect(titleBar, "TitleBar 主题初值应走统一解析器").toMatch(/useState<"dark" \| "light">\(\(\) => resolveEffectiveTheme\(getSetting\)\)/);
    expect(titleBar, "不应再自己拼 DB→默认档").not.toMatch(/isThemeMode\(saved\)\s*\?\s*saved\s*:\s*DEFAULT_THEME/);

    const skinSelector = read("src/components/SkinSelector.tsx");
    expect(skinSelector).toMatch(/resolveEffectiveTheme\(getSetting\)/);
    expect(skinSelector).not.toMatch(/isThemeMode\(saved\)\s*\?\s*saved\s*:\s*DEFAULT_THEME/);

    const manager = read("src/core/theme/theme-manager.ts");
    expect(manager).toMatch(/resolveEffectiveTheme\(getSetting\)/);
    expect(manager, "ThemeManager 不应再自己拼 DB→默认档").not.toMatch(/isThemeMode\(userTheme\)/);
  });

  it("THEME-BOOT-6: 首屏画布必须有跟随主题的不透明底色（且不误伤宠物窗口）", () => {
    const css = read("src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const m = /html:not\(\.pet-window-mode\)\s*\{([^}]*)\}/.exec(css);
    expect(m, "应有 html:not(.pet-window-mode) 的画布底色规则").toBeTruthy();
    expect(m![1], "画布底色必须跟随主题令牌").toMatch(/background-color:\s*var\(--bg-primary\)/);
  });
});

describe("首屏底色真实渲染契约（第 60 波，需要浏览器）", () => {
  const FIXTURE = join(ROOT, "src", "test", "fixtures", "theme-firstpaint-probe.html");

  function findBrowser(): string | null {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "/usr/bin/microsoft-edge",
      "/usr/bin/google-chrome",
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
  }
  const BROWSER = findBrowser();

  interface FirstPaint {
    cache: string | null;
    dataTheme: string | null;
    colorScheme: string;
    htmlBackground: string;
    splashBackground: string | null;
    bgPrimaryToken: string;
  }

  function firstPaint(cache: "dark" | "light" | "none"): FirstPaint {
    const out = execFileSync(
      BROWSER as string,
      [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom",
        "--window-size=1200,800", "--virtual-time-budget=4000",
        `file:///${FIXTURE.replace(/\\/g, "/")}?cache=${cache}`,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = /PROBE_JSON=(\{.*?\})<\/pre>/s.exec(out);
    if (!m) throw new Error("首屏主题探针没有输出：检查 fixtures/theme-firstpaint-probe.html 是否被改动");
    return JSON.parse(m[1].replace(/&quot;/g, '"'));
  }

  const dark = BROWSER ? firstPaint("dark") : null;
  const light = BROWSER ? firstPaint("light") : null;
  const none = BROWSER ? firstPaint("none") : null;

  it.skipIf(!BROWSER)("THEME-BOOT-7: 镜像为暗色时，首帧就是暗色（画布与启动页都不白）", () => {
    expect(dark!.dataTheme, "内联脚本应按镜像设好 data-theme").toBe("dark");
    expect(dark!.colorScheme).toBe("dark");
    expect(dark!.htmlBackground, "画布必须是暗底（而不是浏览器默认白）").toBe("rgb(14, 15, 15)");
    expect(dark!.htmlBackground).not.toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)/);
    expect(dark!.splashBackground, "启动页底色必须与画布一致（加载期间不闪相反色）").toBe("rgb(14, 15, 15)");
  }, 30_000);

  it.skipIf(!BROWSER)("THEME-BOOT-8: 镜像为浅色 / 缺失时，首帧是浅色（默认档）", () => {
    expect(light!.dataTheme).toBe("light");
    expect(light!.htmlBackground).toBe("rgb(252, 252, 251)");
    expect(light!.splashBackground).toBe("rgb(252, 252, 251)");
    // 没有镜像时不设属性，由 CSS :root 兜默认档 —— 底色同样是浅色
    expect(none!.dataTheme).toBeNull();
    expect(none!.htmlBackground).toBe("rgb(252, 252, 251)");
  }, 30_000);
});
