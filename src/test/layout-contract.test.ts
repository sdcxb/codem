/**
 * 弹窗外壳的**真实布局契约**（第 54 波）。
 *
 * 为什么需要它（真实事故）：第 51 波的跨文件去重脚本在 `codem-ui.css` 里留下了一个悬空的
 * `.settings-panel,`（后面空一行接 `.settings-sidebar {`），于是选择器列表变成
 * `.settings-panel, .settings-sidebar` —— **设置弹窗继承了侧栏的 `width: 160px`**，
 * 整个设置窗口塌成 160px 的窄条、内容区只剩 40px（用户报的「设置窗口很狭长的一条」）。
 *
 * 这类损坏为什么一路绿灯：
 *   - 是**合法 CSS**（选择器列表本来就允许跨行、允许任意组合），打包不报错；
 *   - `tsc` 看不见样式；`css-class-duplicate` / `css-class-cross-file` 只比对「单类选择器」，
 *     选择器列表整条被跳过；`css-integrity` 查的是括号/逗号/空块这类**语法**问题；
 *   - 目录里的 CSS 契约测试都是"某个属性是否等于某个值"，没人测**渲染出来的几何**。
 *
 * 所以这里直接测几何：用无头 Edge 真渲染（jsdom 没有布局引擎，测不出这类问题），
 * 断言「弹窗在各种可用区域下都够宽、内容区不会塌、窄屏走整宽」。
 * 机器上没有 Edge 时**跳过**（并打印原因），不阻塞其它环境。
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const FIXTURE = join(ROOT, "src", "test", "fixtures", "settings-modal-probe.html");

/** 找一个 Chromium 系浏览器（Edge 在 Windows 上默认存在；Chrome 作为兜底） */
function findBrowser(): string | null {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const BROWSER = findBrowser();

interface Box {
  w: number;
  h: number;
  display: string;
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
  [k: string]: unknown;
}
interface Row {
  w: number;
  h: number;
  panel: Box;
  body: Box;
  sidebar: Box;
  content: Box;
  media: { max768: boolean };
}

function measure(windowSize: [number, number]): { viewport: { w: number; h: number; dpr: number }; results: Row[] } {
  const out = execFileSync(
    BROWSER as string,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--dump-dom",
      `--window-size=${windowSize[0]},${windowSize[1]}`,
      `file:///${FIXTURE.replace(/\\/g, "/")}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
  const m = /PROBE_JSON=(\{.*?\})<\/pre>/s.exec(out);
  if (!m) throw new Error("布局探针没有输出：请检查 fixture 是否被改动（PROBE_JSON 标记缺失）");
  return JSON.parse(m[1].replace(/&quot;/g, '"'));
}

describe.skipIf(!BROWSER)("弹窗外壳真实布局契约（第 54 波）", () => {
  // 舞台扫描：一次浏览器启动测完所有可用区域
  const sweep = measure([2600, 1500]);
  // 窄屏另有媒体查询分支，单独跑一次
  const narrow = measure([740, 900]);

  it("LAYOUT-0: 探针确实拿到了测量结果（防止 fixture 坏掉导致「空集也通过」）", () => {
    expect(sweep.results.length).toBeGreaterThanOrEqual(10);
    expect(sweep.viewport.h).toBeGreaterThan(500);
  });

  it("LAYOUT-1: 设置弹窗在各分辨率下都够宽（不是塌成一条窄条）", () => {
    const bad = sweep.results
      .filter((r) => r.panel.w < 480)
      .map((r) => `${r.w}x${r.h} → 面板宽 ${r.panel.w}px`);
    expect(bad, `设置弹窗在这些可用区域下塌掉了：\n${bad.join("\n")}`).toEqual([]);
  });

  it("LAYOUT-2: 设置弹窗的内容区不会被挤成一条（≥320px），且宽度随可用区域自适应", () => {
    const bad = sweep.results
      .filter((r) => r.content.w < 320)
      .map((r) => `${r.w}x${r.h} → 内容区宽 ${r.content.w}px`);
    expect(bad, `内容区被挤没了：\n${bad.join("\n")}`).toEqual([]);
    // 自适应：可用区域 ≥1090px 时是设计宽度 760，且弹窗不超过可用区域
    const wide = sweep.results.filter((r) => r.w >= 1090);
    for (const r of wide) {
      expect(r.panel.w, `${r.w}x${r.h} 弹窗应为设计宽度 760px`).toBe(760);
    }
    const narrowStage = sweep.results.filter((r) => r.w < 760);
    for (const r of narrowStage) {
      expect(r.panel.w, `${r.w}x${r.h} 弹窗不得超过可用区域`).toBeLessThanOrEqual(r.w);
    }
  });

  it("LAYOUT-3: 窄屏媒体查询下弹窗走整宽（可用区域小于 768px 时不能被固定宽度撑破）", () => {
    const rows = narrow.results.filter((r) => r.media.max768);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.panel.w, `${r.w} 宽下应铺满可用区域`).toBe(r.w);
    }
  });
});

describe("弹窗外壳的静态契约（第 54 波，不依赖浏览器）", () => {
  const BASE = ["src/styles.css", "src/styles/codem-ui.css", "src/styles/notebook-workspace.css", "src/styles/task-center.css"];

  /** 外壳类：整屏级浮层的容器（尺寸由自己决定，绝不该继承内部部件的几何） */
  const SHELLS = new Set([
    "settings-overlay", "settings-panel", "modal-overlay", "modal-panel", "modal", "modal-editor",
    "config-editor", "project-manager", "confirm-dialog", "permission-dialog", "search-dialog",
    "context-menu", "dropdown-menu", "popover",
  ]);

  it("LAYOUT-4: 外壳类不得与非外壳的「同前缀兄弟类」写进同一条规则（第 54 波事故签名）", () => {
    // 事故：`.settings-panel,` 悬空 → `.settings-panel, .settings-sidebar { width: 160px }`
    // 判定：同一规则里既有外壳类，又有与它共享「组件前缀」的非外壳类（如 .settings-*）
    const offenders: string[] = [];
    for (const rel of BASE) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const css = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      for (const m of css.matchAll(/(?:^|\n)([^{}@;]+)\{([^{}]*)\}/g)) {
        const parts = m[1].split(",").map((s) => s.trim()).filter((s) => /^\.[a-zA-Z][\w-]*$/.test(s));
        if (parts.length < 2) continue;
        const classes = parts.map((s) => s.slice(1));
        for (const a of classes) {
          if (!SHELLS.has(a)) continue;
          const prefix = a.split("-")[0];
          for (const b of classes) {
            if (b === a || SHELLS.has(b)) continue;
            if (b.startsWith(prefix + "-")) {
              const line = css.slice(0, m.index).split("\n").length;
              offenders.push(`${rel}:${line}  .${a} 与 .${b} 写在同一规则里`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `外壳类被并进了兄弟部件的规则（会让外壳继承部件的宽高，第 54 波的真实 bug）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("LAYOUT-5: 设置弹窗的设计宽度仍然来自它自己那条规则（760px + 95vw 上限）", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    const m = /(?:^|\n)\.settings-panel,\s*\.project-manager,\s*\.config-editor\s*\{([^}]*)\}/.exec(css);
    expect(m, "应能定位 .settings-panel 的外壳规则").toBeTruthy();
    expect(m![1]).toMatch(/width:\s*760px;/);
    expect(m![1]).toMatch(/max-width:\s*95vw;/);
  });

  it("LAYOUT-7: 文字标签墙不得使用「小轨道 + max-content」的 auto-fill 网格（会压成竖排）", () => {
    // 事故（第 42 波引入、第 55 波修复）：把 flex-wrap 的标签墙改成
    //   grid-template-columns: repeat(auto-fill, minmax(var(--space-13), max-content))
    // auto-fill 的**空轨道不会被折叠**，于是轨道数按最小轨道（40px）算满一整行，
    // 文字芯片被塞进 40px 宽的轨道 → 中文逐字换行，按钮看着是"竖着的"。
    // 判定：minmax 的最小值解析后 < 64px 的 auto-fill/auto-fit 网格一律不允许（除非豁免）。
    const EMOJI_GRID_ALLOW = new Set([
      // 内容是单个 emoji 的按钮网格：不存在"文字换行"，窄轨道是刻意的
      ".identity-emoji-grid",
      ".bootstrap-emoji-grid",
    ]);
    const SPACE: Record<string, number> = {};
    const stylesRaw = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    for (const m of stylesRaw.matchAll(/--space-(\d+):\s*(\d+)px/g)) SPACE[`--space-${m[1]}`] = Number(m[2]);
    const CONTROL: Record<string, number> = {};
    for (const m of stylesRaw.matchAll(/--control-([\w-]+):\s*(\d+)px/g)) CONTROL[`--control-${m[1]}`] = Number(m[2]);

    const offenders: string[] = [];
    for (const rel of BASE) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const css = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      for (const m of css.matchAll(/(?:^|\n)([^{}@;]+)\{([^{}]*)\}/g)) {
        const grid = /grid-template-columns:\s*repeat\(auto-(fill|fit),\s*minmax\(([^,]+),\s*max-content\)\)/.exec(m[2]);
        if (!grid) continue;
        const min = grid[2].trim();
        const px = SPACE[min] ?? CONTROL[min] ?? Number(/^(\d+)px$/.exec(min)?.[1] ?? NaN);
        const base = m[1].split(",").map((s) => s.trim()).filter((s) => /^\.[a-zA-Z][\w-]*$/.test(s));
        if (base.some((s) => EMOJI_GRID_ALLOW.has(s))) continue;
        const line = css.slice(0, m.index).split("\n").length;
        if (Number.isNaN(px)) { offenders.push(`${rel}:${line} ${base.join(", ")} —— 最小轨道 ${min} 无法解析成像素，请显式写清`); continue; }
        if (px < 64) offenders.push(`${rel}:${line} ${base.join(", ")} —— 最小轨道 ${min}=${px}px < 64px，文字会被压成竖排`);
      }
    }
    expect(
      offenders,
      `这些标签墙用了"小轨道 + max-content"的 auto-fill 网格（文字会被逐字换行）：\n${offenders.join("\n")}\n` +
        `改用 display: flex; flex-wrap: wrap;（芯片保持自然宽度，放不下就换行）。`,
    ).toEqual([]);
  });
});

describe("标签墙/工具栏的真实渲染契约（第 55 波，需要浏览器）", () => {
  const CHIP_FIXTURE = join(ROOT, "src", "test", "fixtures", "chip-rows-probe.html");

  function measureChips(): Array<{
    w: number;
    case: string;
    overflow: boolean;
    display: string;
    flexWrap: string;
    children: Array<{ cls: string; lines: number; chars: number; w: number }>;
    squeezed: Array<{ cls: string; chars: number; lines: number; w: number }>;
  }> {
    const out = execFileSync(
      BROWSER as string,
      [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom",
        "--window-size=1400,2000", "--virtual-time-budget=6000",
        `file:///${CHIP_FIXTURE.replace(/\\/g, "/")}`,
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = /PROBE_JSON=(\{.*?\})<\/pre>/s.exec(out);
    if (!m) throw new Error("标签墙探针没有输出：检查 fixtures/chip-rows-probe.html 是否被改动");
    return JSON.parse(m[1].replace(/&quot;/g, '"')).results;
  }

  // 无头浏览器冷启动可能超过 vitest 默认的 5s，所以：测量只跑一次 + 显式放宽超时
  const chipRows = BROWSER ? measureChips() : [];

  it.skipIf(!BROWSER)("LAYOUT-8: 标签墙/工具栏在 320~1200px 下都不竖排、不溢出", () => {
    const rows = chipRows;
    expect(rows.length, "探针测量点太少，可能 fixture 坏了").toBeGreaterThanOrEqual(50);
    const squeezed = rows.filter((r) => r.squeezed.length);
    const overflow = rows.filter((r) => r.overflow);
    expect(
      squeezed.map((r) => `${r.case} @${r.w}px: ${r.squeezed.map((c) => `${c.cls}(${c.chars}字→${c.lines}行/宽${c.w})`).join(", ")}`),
      "这些标签被压成了竖排（短标签却排成 ≥3 行）",
    ).toEqual([]);
    expect(
      overflow.map((r) => `${r.case} @${r.w}px scrollWidth > clientWidth`),
      "这些容器内容溢出（放不下又看不到）",
    ).toEqual([]);
  }, 30_000);

  it.skipIf(!BROWSER)("LAYOUT-9: 设置「通用」的身份/风格标签、性能面板页签行确实是一行一个标签", () => {
    const rows = chipRows;
    for (const name of ["identity-options", "identity-style", "perf-tab-group"]) {
      const cases = rows.filter((r) => r.case === name);
      expect(cases.length, `探针里缺少 ${name} 的测量点`).toBeGreaterThan(0);
      for (const r of cases) {
        for (const child of r.children) {
          expect(child.lines, `${name} @${r.w}px 的「${child.cls}」被压成了竖排（${child.lines} 行）`).toBeLessThan(3);
        }
      }
    }
  }, 30_000);
});

describe("工具行/搜索行的「撑开与靠右」契约（第 57 波，需要浏览器）", () => {
  const TOOLBAR_FIXTURE = join(ROOT, "src", "test", "fixtures", "toolbar-rows-probe.html");

  interface ToolbarRow {
    case: string;
    innerWidth: number;
    display: string;
    gridColumns: string;
    overflow: boolean;
    wrapped: boolean;
    lastRightGap: number | null;
    growable: Array<{ cls: string; w: number; ratio: number }>;
  }

  function measureToolbars(): ToolbarRow[] {
    const out = execFileSync(
      BROWSER as string,
      [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom",
        "--window-size=1400,1200", "--virtual-time-budget=6000",
        `file:///${TOOLBAR_FIXTURE.replace(/\\/g, "/")}`,
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    const m = /PROBE_JSON=(\{.*?\})<\/pre>/s.exec(out);
    if (!m) throw new Error("工具行探针没有输出：检查 fixtures/toolbar-rows-probe.html 是否被改动");
    return JSON.parse(m[1].replace(/&quot;/g, '"')).results;
  }

  // 同上：测量只跑一次，并显式放宽超时（无头浏览器冷启动可能 >5s）
  const toolbarRows = BROWSER ? measureToolbars() : [];

  it.skipIf(!BROWSER)("LAYOUT-10: 可伸缩元素必须真的撑开、行尾控件必须贴右（不得靠左留一片空白）", () => {
    // 真实事故（用户报）：右侧栏「筛选文件」搜索行的刷新按钮没有居右，右边空了一片。
    // 根因：容器写的是 repeat(3, max-content) 的网格，而输入框上写着 flex: 1 —— 在 grid 里
    // **完全无效**，于是整行内容按内容宽度靠左排（实测 724px 宽的行里按钮距右边缘还差 527px）。
    const rows = toolbarRows;
    expect(rows.length, "探针测量点太少，可能 fixture 坏了").toBeGreaterThanOrEqual(30);

    const problems: string[] = [];
    for (const r of rows) {
      const where = `${r.case} @可用宽 ${r.innerWidth}px (display=${r.display}${r.gridColumns !== "none" ? `, columns=${r.gridColumns}` : ""})`;
      if (r.overflow) problems.push(`${where}: 内容溢出（放不下又看不到）`);
      for (const g of r.growable) {
        if (g.ratio < 0.25) problems.push(`${where}: 可伸缩元素「${g.cls}」只有 ${g.w}px（占 ${(g.ratio * 100).toFixed(0)}%），没有被撑开`);
      }
      // 未换行时，行内最后一个控件必须贴住行的右边缘（换行是可接受的降级：宁可变两行，也不要挤压变形）
      if (!r.wrapped && r.lastRightGap !== null && Math.abs(r.lastRightGap) > 2) {
        problems.push(`${where}: 行尾控件距右边缘还有 ${r.lastRightGap}px（应贴右）`);
      }
    }
    expect(problems, `工具行/搜索行没有撑开或没有靠右：\n${problems.join("\n")}`).toEqual([]);
  }, 30_000);
});
