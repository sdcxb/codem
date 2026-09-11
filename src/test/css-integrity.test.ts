/**
 * CSS 结构完整性契约（第 52 波，补第 51 波合并事故的兜底）。
 *
 * 背景：第 51 波用脚本批量合并「同一类在两个基础样式表里各写一遍」的重复定义，
 * 脚本按字节偏移删除整块，结果**吃掉了相邻代码**，留下三类静默损坏：
 *   ① `codem-ui.css` 的 `.titlebar-action-btn` 选择器行被吃掉，只剩裸声明（
 *      而且侥幸通过了我当时手写的 `String.includes` 自检 —— 自检脚本查的是"注释里出现过"）；
 *   ② `styles.css` 的 `@media (prefers-reduced-motion: reduce)` 块**声明体整块消失**，
 *      只剩一串以逗号结尾的选择器 —— 于是「减少动效」这条无障碍承诺对 15 个浮层全部失效；
 *   ③ `ppt-editor.css` 的 `.ppt-present-mode` 同样只剩裸声明。
 *   三处都是 `vite build` 的 postcss 才报错（`Unexpected }` / `Unknown word`），
 *   而 `tsc`、`vitest`、UI 审计全是绿的 —— 类型检查和类名审计都看不见 CSS 语法。
 *
 * 因此这里用**不依赖 postcss** 的极简校验（花括号深度 + 选择器/声明形态）把三类损坏锁死，
 * 从此任何批量 CSS 改写只要留下残骸，单测立刻红。
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");

/** 注释替换为等长空白（保留换行），保证剥离后**偏移量与原文一一对应**（空规则体判定要用原文切片） */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  let inComment = false;
  let str: string | null = null;
  while (i < css.length) {
    const ch = css[i];
    const nx = css[i + 1];
    if (inComment) {
      if (ch === "*" && nx === "/") {
        inComment = false;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (str) {
      out += ch;
      if (ch === "\\") {
        out += nx ?? "";
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      inComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      str = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function checkStructure(rel: string, css: string): string[] {
  const problems: string[] = [];
  const lines = stripComments(css).split("\n");
  let depth = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const before = depth;
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth < 0) {
      problems.push(`${rel}:${n + 1} 多出一个 }（括号不平衡，通常意味着某条规则的声明体被删）`);
      depth = 0;
    }
    // 选择器列表以逗号结尾 —— 声明体被整块删掉的典型残骸
    if (/,\s*$/.test(line)) {
      for (let k = n + 1; k < lines.length; k++) {
        if (!lines[k].trim()) continue;
        if (/^\s*\}/.test(lines[k])) problems.push(`${rel}:${n + 1} 选择器列表以逗号结尾（声明体被删？）`);
        break;
      }
    }
    // 顶层（depth 0）出现裸声明 —— 选择器行被吃掉的残骸，如 "-index: var(--z-present);"
    if (before === 0 && /^\s*[-a-zA-Z][-\w]*\s*:\s*[^;{}]*;\s*$/.test(line)) {
      problems.push(`${rel}:${n + 1} 顶层出现裸声明：${line.trim().slice(0, 60)}`);
    }
  }
  if (depth !== 0) problems.push(`${rel} 结尾括号不平衡（depth=${depth}）`);
  return problems;
}

/** 有意留空的占位规则（唯一一个，`.lo-card--memo` 在插件里就是"没有额外样式"的语义占位） */
const EMPTY_BODY_ALLOWLIST = new Set([".lo-card--memo"]);

function checkEmptyBodies(rel: string, css: string): string[] {
  const problems: string[] = [];
  const stripped = stripComments(css);
  const re = /([^{}]*)\{\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const selector = m[1].split(/[\n}]/).pop()?.trim() ?? "";
    if (!selector || selector.startsWith("@")) continue;
    if (EMPTY_BODY_ALLOWLIST.has(selector)) continue;
    // 括号里原本只有注释的（文档化占位，如 skin-hub 的「颜色由 .icon-* 控制」）不算问题
    if (css.slice(m.index, m.index + m[0].length).includes("/*")) continue;
    const line = stripped.slice(0, m.index).split("\n").length;
    problems.push(`${rel}:${line} 空规则体：${selector.slice(0, 60)}`);
  }
  return problems;
}

function cssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "target", ".git"].includes(entry.name)) walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".css")) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

const FILES = cssFiles().map((abs) => ({ rel: relative(ROOT, abs).replace(/\\/g, "/"), css: readFileSync(abs, "utf8") }));

describe("CSS 结构完整性（第 52 波）", () => {
  it("CSS-INTEGRITY-0: 至少扫到了全部基础样式表（防止 glob 写错导致「空集也通过」）", () => {
    const rels = FILES.map((f) => f.rel);
    for (const expected of [
      "src/styles.css",
      "src/styles/codem-ui.css",
      "src/styles/notebook-workspace.css",
      "src/styles/task-center.css",
      "src/styles/pet-window.css",
      "src/components/ppt/ppt-editor.css",
    ]) {
      expect(rels, `应扫到 ${expected}`).toContain(expected);
    }
    expect(FILES.length).toBeGreaterThanOrEqual(8);
  });

  it("CSS-INTEGRITY-1: 每个 CSS 文件括号平衡、无悬挂逗号、无顶层裸声明", () => {
    const problems = FILES.flatMap((f) => checkStructure(f.rel, f.css));
    expect(problems, `结构性损坏：\n${problems.join("\n")}`).toEqual([]);
  });

  it("CSS-INTEGRITY-2: 没有空的规则体（声明体被删但括号还在）", () => {
    const problems = FILES.flatMap((f) => checkEmptyBodies(f.rel, f.css));
    expect(problems, `空规则体：\n${problems.join("\n")}`).toEqual([]);
  });

  it("CSS-INTEGRITY-3: 减动效块的声明体必须还在（第 51 波这里被删空过）", () => {
    const styles = FILES.find((f) => f.rel === "src/styles.css");
    expect(styles, "应能读到 src/styles.css").toBeTruthy();
    const stripped = stripComments(styles!.css);
    // 浮层减动效：选择器列表里必须跟随真实的 animation/transition 关停声明
    const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\.modal-overlay,[\s\S]*?\n\}/.exec(stripped);
    expect(block, "应能定位浮层减动效块").toBeTruthy();
    expect(block![0]).toMatch(/animation:\s*none\s*!important;/);
    expect(block![0]).toMatch(/transition:\s*none\s*!important;/);
    expect(block![0]).toMatch(/\.tool-call-pill\s*\{/);
    // 反例：选择器列表不能直接撞上右括号
    expect(block![0]).not.toMatch(/,\s*\n\s*\}/);
  });

  it("CSS-INTEGRITY-4: 跨文件冲突规则必须忽略条件覆盖块（避免把减动效误判成静默覆盖）", () => {
    const scanner = readFileSync(join(ROOT, "tools", "ui-audit", "scan-ui.mjs"), "utf8");
    expect(scanner, "scan-ui.mjs 应有条件块范围识别").toContain("conditionalAtRuleRanges");
    expect(scanner, "应跳过条件块内的规则").toMatch(/if \(inConditional\(m\.index\)\) continue;/);
  });

  it("CSS-INTEGRITY-5: 固定数量页签的行不得「nowrap + overflow:hidden」把放不下的页签裁掉", () => {
    // 背景（第 53 波）：配置弹窗只有 560px 宽，却有 7 个页签。第 51 波把 .config-tabs 改成
    // nowrap + overflow: hidden，结果后几个页签**直接消失、点不到**（和用户在左右侧栏
    // 报的问题是同一类）。判定方式：所有「flex 行容器 + overflow: hidden」的规则，
    // 若同时写了 flex-wrap: nowrap，就会裁切 —— 必须逐个有理由地豁免。
    const ALLOWLIST: Record<string, string> = {
      ".sr-only": "视觉隐藏工具类，内容本来就不显示",
      ".input-tools-left": "编辑器工具行的 chip 自带 min-width:0 + 省略号，整行就是为单行设计",
      ".right-sidebar-tabs": "只有 2 个页签（文件 / 浏览器），页签文字可压缩成省略号",
      ".panel-sidebar-tabs": "5 个页签，标签走 .panel-sidebar-tab-label（overflow:hidden + 省略号）可压缩",
      ".nb-panel-tabs": "只有 2 个页签（来源 / 图谱），且是窄边栏里的固定两项",
      ".kg-toolbar": "工具栏是整幅工作区宽度（不是窄边栏），6 个控件都是 32px 图标按钮，不需要省略号",
    };
    const offenders: string[] = [];
    for (const rel of ["src/styles.css", "src/styles/codem-ui.css", "src/styles/notebook-workspace.css", "src/styles/task-center.css"]) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      const css = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
      for (const m of css.matchAll(/(^|\n)([^\n{}]+)\{([^{}]*)\}/g)) {
        const body = m[3];
        if (!/overflow:\s*hidden/.test(body) || !/flex-wrap:\s*nowrap/.test(body)) continue;
        for (const sel of m[2].split(",")) {
          const s = sel.trim();
          if (!s.startsWith(".")) continue;
          const base = s.split(/[\s:>]/)[0];
          if (ALLOWLIST[base]) continue;
          const line = css.slice(0, m.index).split("\n").length;
          offenders.push(`${rel}:${line} ${base}`);
        }
      }
    }
    expect(
      offenders,
      `这些行容器会把放不下的内容裁掉（要么允许换行，要么写进豁免清单并说明理由）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("CSS-INTEGRITY-6: 配置弹窗的 7 个页签可换行、且标签文字能压缩成省略号", () => {
    const styles = FILES.find((f) => f.rel === "src/styles.css")!;
    const stripped = stripComments(styles.css);
    const rule = (selector: string) => {
      const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([\\s\\S]*?)\\n\\}`);
      return re.exec(stripped)?.[1] ?? "";
    };
    const tabs = rule(".config-tabs");
    expect(tabs, "应能定位 .config-tabs").toBeTruthy();
    expect(tabs, "必须允许换行（否则 560px 弹窗里放不下的页签会消失）").toMatch(/flex-wrap:\s*wrap/);
    expect(tabs, "不得再裁切").not.toMatch(/overflow:\s*hidden/);
    expect(tabs).not.toMatch(/flex-wrap:\s*nowrap/);
    expect(rule(".config-tab"), "页签要能压缩").toMatch(/min-width:\s*0/);
    expect(rule(".config-tab-label"), "标签文字要能变省略号").toMatch(/text-overflow:\s*ellipsis/);
  });

  it("CSS-INTEGRITY-7: 每个类的「生效取值」必须与快照一致（拦住静默改动）", () => {
    // 第 51 波的批量合并连续造成三次事故：设置弹窗宽 760→160px、浅色主题悬停发黑、
    // 区块标题字重 620→560。三次都是「类名没错、取值被悄悄改了」，没有任何门禁在看生效取值。
    // 现在把「每个类 → 生效后的声明集合」存成快照（tools/ui-audit/css-contract.json），
    // 取值一变测试就红，必须显式跑 --write 更新快照（于是 diff 里会写清改了什么）。
    const script = join(ROOT, "tools", "ui-audit", "css-contract.mjs");
    expect(existsSync(script), "缺少 tools/ui-audit/css-contract.mjs").toBe(true);
    let output = "";
    let failed = false;
    try {
      output = execFileSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(
      failed,
      `以下类的生效取值变了（类名没错、取值被改）——确认是有意改动后跑 \`node tools/ui-audit/css-contract.mjs --write\`：\n${output}`,
    ).toBe(false);
  });

  it("CSS-INTEGRITY-8: 输入光标颜色必须跟随正文文字色（不得用品牌色，且对比度 ≥7:1）", () => {
    // 事故（用户报）：默认皮肤暗色主题下，对话编辑区打字时的光标是紫的（--accent #7c6cf0），
    // 落在近黑背景上只有 4.33:1，而同一处的文字是 11.67:1 —— 一根 1px 闪烁竖线的可见度
    // 只有文字的三分之一，等于"看不清光标在哪"。
    const styles = FILES.find((f) => f.rel === "src/styles.css")!;
    const stripped = stripComments(styles.css);

    // ① 令牌：--caret-color 必须引用正文色（两档主题各自解析，皮肤也可覆盖）
    expect(stripped, "应定义 --caret-color").toMatch(/--caret-color:\s*var\(--text-primary\)/);

    // ② 使用处：编辑区光标必须用该令牌，且不得再用 --accent
    //    注意排除「令牌定义」本身（`--caret-color: …` 也含 caret-color 子串）
    const caretRules = [...stripped.matchAll(/(?:^|\n)([^\n{}]+)\{([^{}]*)\}/g)].filter((m) => /(?<!-)caret-color\s*:/.test(m[2]));
    expect(caretRules.length, "应能找到使用 caret-color 的规则").toBeGreaterThan(0);
    for (const m of caretRules) {
      const sel = m[1].trim();
      const body = m[2];
      expect(body, `${sel} 的光标颜色应走 --caret-color`).toMatch(/(?<!-)caret-color:\s*var\(--caret-color\)/);
      expect(body, `${sel} 不应把品牌色用作光标颜色`).not.toMatch(/(?<!-)caret-color:\s*var\(--accent/);
    }
    expect(stripped, ".message-input 是对话编辑区，必须有光标色").toMatch(/\.message-input[\s\S]{0,600}?caret-color:\s*var\(--caret-color\)/);

    // ③ 对比度：按令牌实算，两档主题都要 ≥7:1（与正文色一致）
    const token = (block: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
    const dark = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(stripped)?.[1] ?? "";
    const light = /:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(stripped)?.[1] ?? "";
    const parse = (v?: string | null): [number, number, number] | null => {
      if (!v) return null;
      const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
      if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(v);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a: [number, number, number], b: [number, number, number]) => {
      const la = lum(a), lb = lum(b);
      const [hi, lo] = la > lb ? [la, lb] : [lb, la];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const [name, block] of [["暗色", dark], ["浅色", light]] as const) {
      const caret = parse(token(block, "--text-primary") ?? token(light, "--text-primary"));
      const bg = parse(token(block, "--bg-primary"));
      expect(caret && bg, `${name}主题应能解析 --text-primary 与 --bg-primary`).toBeTruthy();
      const ratio = contrast(caret!, bg!);
      expect(ratio, `${name}主题下光标与编辑区背景的对比度过低（${ratio.toFixed(2)}:1）`).toBeGreaterThanOrEqual(7);
    }
  });
});
