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
});
