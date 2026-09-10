/**
 * UI 一致性审计（开发工具 + 可重复门禁）。
 *
 * 目的：把「样式风格是否统一」变成可测量、可回归的数字 ——
 * 支持「优化 → 审计 → 再优化」的闭环，直到违规清零。
 *
 * 用法：
 *   node tools/ui-audit/scan-ui.mjs                 # 汇总（默认）
 *   node tools/ui-audit/scan-ui.mjs --verbose       # 汇总 + 每规则前若干示例
 *   node tools/ui-audit/scan-ui.mjs --rule=fs-hardcoded
 *   node tools/ui-audit/scan-ui.mjs --json          # 机器可读
 *   node tools/ui-audit/scan-ui.mjs --file=src/components/AgentPanel.tsx
 *   node tools/ui-audit/scan-ui.mjs --write-baseline  # 记录当前计数（门禁用）
 *
 * 规则分层：
 *   error（门禁要求清零）：字体硬编码、颜色硬编码、圆角离格、弹窗外壳未用统一类
 *   warn（工作量指标）：间距离格、内联样式过密、遗留 shell 类名
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BASELINE_PATH = join(HERE, "baseline.json");

// ========== 扫描范围 ==========
const SCAN_DIRS = ["src"];
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "target", "test", "__snapshots__", ".git"]);
const EXCLUDE_FILE_RE = [
  /\.test\.(ts|tsx)$/,
  /\.d\.ts$/,
];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full));
    else if ([".tsx", ".ts", ".css"].includes(extname(entry))) out.push(full);
  }
  return out;
}

function shouldSkip(rel) {
  return EXCLUDE_FILE_RE.some((re) => re.test(rel)) || !!allowedReason(rel);
}

/**
 * 合法例外：这些文件里的原始颜色是**数据/内容**而不是 UI 样式 ——
 * 皮肤令牌定义、PPT 生成内容配色、游戏美术（大富翁棋盘/角色自带一套美术语言）。
 * 例外必须写明理由，避免例外表退化成"绕过审计"的后门。
 * rules 可选：只对指定规则豁免（不给就是整份文件豁免）。
 */
const ALLOWLIST = [
  { re: /^src\/core\/theme\//, why: "主题/令牌定义源（原始色值是唯一真相源）" },
  {
    re: /^src\/core\/knowledge\/ppt/,
    why: "PPT 生成/导入内容的配色（导出文件的内容样式，不跟随宿主皮肤；pptx-importer 产出的也是内容调色板）",
  },
  {
    re: /^src\/components\/TerminalPanel\.tsx$/,
    why: "xterm.js 的主题对象要的是真实色值（它画在 canvas 上，读不到 CSS 变量）；令牌里的 --terminal-bg/-fg 就是为这块暗色表面准备的对照值",
    rules: ["color-hardcoded-ts"],
  },
  { re: /^src\/plugins\/monopoly-game\//, why: "大富翁游戏插件（自带美术语言：棋盘/卡牌/角色是一套独立视觉，改令牌会破坏美术）" },
  { re: /^src\/styles\/skin-[^/]+\.css$/, why: "皮肤定义源（每个皮肤的调色板与覆盖层：原始色值就是该皮肤的真相源）" },
  { re: /^src\/plugins\/library-ops\/data\/characters\.ts$/, why: "图书馆角色调色板（注释性常量，实际渲染已用 var() 令牌）" },
  {
    re: /^src\/components\/AppErrorBoundary\.tsx$/,
    why: "崩溃兜底页必须能在样式表整体失效时仍然可读，所以刻意全部走内联样式（不依赖任何 CSS 外壳）",
    rules: ["modal-shell-bespoke"],
  },
  {
    re: /^src\/components\/ppt\/(PPTAdapter|PresentationMode)\.tsx$/,
    why: "PPT 工作区全屏视图与演示舞台（投影输出）：是整屏「工作台/舞台」而不是应用内浮层，套 modal-overlay 的遮罩与 Esc 行为会与演示交互冲突",
    rules: ["modal-shell-bespoke"],
  },
];
function allowedReason(rel, rule) {
  // 不带 rule 调用（shouldSkip）时只认「整份文件豁免」的条目；
  // 带 rule 调用时，按条目声明的 rules 精确匹配。
  const hit = ALLOWLIST.find(
    (a) => a.re.test(rel) && (rule ? !a.rules || a.rules.includes(rule) : !a.rules),
  );
  return hit?.why ?? null;
}

// ========== 允许的刻度 ==========
/** 圆角刻度（来自 --radius-sm/md/lg/full + 设计规范里的 4/6/8/10/14） */
const RADIUS_OK = new Set(["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "24", "999", "9999", "50%"]);
/** 间距按 2px 网格；1px 用于边框/细线 */
const SPACING_OK = (n) => n % 2 === 0 || n === 1;
/** 内联样式密度阈值（可用 --dense-threshold=N 临时调整，便于压测/查看队列） */
let DENSE_THRESHOLD = 120;

const RULES = {
  "fs-hardcoded": { level: "error", desc: "字体大小硬编码（应使用 var(--fs-*)）" },
  "color-hardcoded-tsx": { level: "error", desc: "TSX 内联样式里的硬编码颜色（应使用语义令牌）" },
  "color-hardcoded-css": { level: "error", desc: "CSS 里的硬编码颜色（应使用语义令牌）" },
  "radius-offscale": { level: "error", desc: "圆角不在刻度上" },
  "modal-shell-bespoke": { level: "error", desc: "弹窗/浮层外壳未使用统一 modal-overlay/modal-editor 类" },
  "spacing-offgrid": { level: "warn", desc: "间距不在 2px 网格上" },
  "inline-style-dense": { level: "warn", desc: "单文件内联样式过密（考虑抽成 CSS 类）" },
  "legacy-popup-shell": { level: "warn", desc: "历史遗留的自建浮层类名" },
  "css-class-undefined": { level: "warn", desc: "tsx 里用了但没有任何 CSS 定义的类名（等于没样式）" },
  "css-var-undefined": { level: "error", desc: "var(--x) 引用了从未定义的令牌（无兜底时整条声明失效）" },
  "color-hardcoded-ts": { level: "error", desc: "style={{}} 之外的 TS 里写死颜色（状态色表/主题常量/JS 改样式）" },
  "svg-attr-var": { level: "error", desc: "把 var() 写在原生 SVG 表现属性里（属性不吃 var()，整条属性失效）" },
  "zindex-raw": { level: "error", desc: "全局层级的 z-index 写了裸数字（>=100 应用 --z-* 令牌；<100 属组件内局部层叠，允许）" },
  "css-class-duplicate": { level: "error", desc: "同一个类在顶层被定义多次且属性取值冲突（后一份会静默覆盖前一份）" },
  "spacing-raw": { level: "error", desc: "CSS 间距属性写了裸数字（应使用 var(--space-*)；0/1px 细线/负值/百分比/calc 例外）" },
};

// ========== 扫描器 ==========
const findings = [];
/** 每个文件的「内联样式属性数」（供 --inline-counts 看收口进度：门禁只看 >120 的，
 *  但排队时要知道每个文件离阈值多远、以及收口后还剩多少） */
const inlineCounts = [];
function add(rule, file, line, text, detail) {
  // 例外按「文件 + 规则」判定：豁免一份文件不再等于豁免它的所有规则
  if (allowedReason(file, rule)) return;
  findings.push({ rule, file, line, text: text.trim().slice(0, 140), detail });
}

/** 去掉行内注释，避免把注释里的示例算成违规 */
function stripComments(line) {
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

/**
 * 一行里所有 `var(...)` 的区间（含 fallback）。
 * `var(--token, #fallback)` 里的原始色值是「令牌缺失时的兜底」，不是写死的样式，
 * 判定违规时要排除它们 —— 但必须**按字面量位置**排除：一行里出现过 var(-- 不代表整行都干净
 * （`box-shadow: 0 0 0 1px var(--border-primary), 0 1px 2px rgba(0,0,0,.04)` 曾因此长期漏检）。
 */
function varRanges(line) {
  const ranges = [];
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf("var(", i);
    if (at < 0) break;
    let j = at + 3;
    let depth = 0;
    do {
      const c = line[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    } while (j < line.length && depth > 0);
    ranges.push([at, j]);
    i = j;
  }
  return ranges;
}

/**
 * 精确算出每个 `style={{ … }}` 对象字面量的内部区间 [start, end)。
 *
 * 为什么不能按行数花括号：`style={{ color: '#fff' }}` 写在一行时，
 * 「本行 { 数 - } 数」是 0，但样式对象已经闭合 —— 用行级平衡推算深度会**越算越漏**，
 * 于是从第一个内联样式之后的整份文件都被当成"样式上下文"，
 * 把 `const DOT = { done: "#22c55e" }`、cytoscape 图表入参这类**不是 CSS 样式**的色值
 * 也算成违规（假阳性），反过来掩盖真实问题。这里按字符扫，跳过字符串与注释。
 */
function computeStyleRanges(src) {
  const ranges = [];
  const re = /style=\{\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length; // 「{」之后
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        // 跳过字符串字面量
        const quote = c;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    ranges.push([start, i]);
    re.lastIndex = i;
  }
  return ranges;
}

function scanTsx(rel, src) {
  const lines = src.split("\n");
  let styleProps = 0;
  let modalish = 0; // position:fixed + inset 的浮层样式块计数
  let hasUnifiedShell = false;

  // 统一外壳类名（出现任意一个即认为该文件用了共享外壳）
  if (/modal-overlay|modal-panel|modal-editor|drawer-|popover-|popover-shell|floating-overlay-panel|task-center-panel/.test(src)) hasUnifiedShell = true;

  /**
   * 只在 `style={{ … }}` 里判定颜色/字号/圆角：
   * - SVG/Canvas 属性（`stroke="#888"`、`fill="…"`）与图表库入参不能吃 CSS 变量，属正当用法；
   * - 非样式上下文里的色值字符串（如传给 canvas 的主题常量）同理。
   * 这样门禁只盯「本该用令牌的地方」，避免假阳性把例外表撑爆。
   */
  const styleRanges = computeStyleRanges(src);
  /** 行区间与样式对象区间是否相交（只看行首/行尾两点会漏掉"样式在行中间"的行） */
  const lineInStyle = (lineStart, lineEnd) =>
    styleRanges.some(([s, e]) => s < lineEnd && e > lineStart);
  // 每行起始偏移，供逐行判断
  const lineStarts = [];
  {
    let acc = 0;
    for (const l of lines) {
      lineStarts.push(acc);
      acc += l.length + 1;
    }
  }

  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    const no = i + 1;
    // 该行任意位置落在样式对象内 → 视作样式上下文
    const wasInStyle = lineInStyle(lineStarts[i], lineStarts[i] + raw.length);

    if (!wasInStyle) {
      if (/position:\s*(?:'|")fixed/.test(line)) modalish++;
      return;
    }

    // 1) 字体硬编码：fontSize: 13 / fontSize: "13px" / fontSize: '0.8rem'
    //    （em/% 是刻意的相对层级，见 scanCss 处的说明）
    //    无单位的纯数字也要拦：React 的内联 `fontSize: 13` 就是 13px。
    //    三元分支里的数字同样是像素（`fontSize: compact ? 11 : 13`），以前整条看不见 ——
    //    这一类已全部清零，门禁留着防回归。
    const fs = /fontSize:\s*(?:'|")?([0-9.]+)\s*(px|rem|pt)?\s*(?:'|")?\s*[,}\n]/.exec(line);
    if (fs && !line.includes("var(--fs")) {
      add("fs-hardcoded", rel, no, raw, `fontSize: ${fs[1]}${fs[2] ?? "px(无单位)"}`);
    }
    const fsTernary = /fontSize:\s*[^,}\n]*?\?\s*([0-9.]+)\s*:\s*([0-9.]+)/.exec(line);
    if (fsTernary) {
      add("fs-hardcoded", rel, no, raw, `fontSize 三元分支: ${fsTernary[1]}px / ${fsTernary[2]}px`);
    }

    // 2) 颜色硬编码（属性级：color/background/border*Color/fill/stroke）
    //    与 CSS 侧同款精度：按**字面量位置**排除 `var(--token, #fallback)` 的兜底值，
    //    而不是"这行有 var(-- 就整行放过"（后者会让 `cond ? "#22c55e" : "var(--x)"` 这类漏检）。
    const vRanges = varRanges(line);
    const notInVar = (offset) => offset < 0 || !vRanges.some(([s, e]) => offset >= s && offset < e);
    const colorProp =
      /(?:^|[\s,{])(color|background|backgroundColor|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|outlineColor|fill|stroke)\s*:\s*(?:'|")(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|(?:red|blue|green|white|black|gray|grey|orange|purple|pink|yellow|cyan|magenta|transparent))(?:'|")/;
    const colorM = colorProp.exec(line);
    const colorOffset = colorM ? line.indexOf(colorM[2], colorM.index) : -1;
    // 注意：这里用「本行是否已经报过」而不是「colorM 是否存在」来决定要不要走兜底。
    // 曾经的写法是 `if (!colorM)` —— 于是一行里只要出现一个**无害的**属性级匹配
    // （典型是 `background: "transparent"`），后面所有兜底全部跳过：
    //   border: "1px solid #e74c3c", background: "transparent",
    // 这行里的硬编码红就这么一直没被看见。匹配到 ≠ 报警过，两者必须分开。
    let flagged = false;
    if (colorM && colorM[2] !== "transparent" && notInVar(colorOffset)) {
      add("color-hardcoded-tsx", rel, no, raw, `${colorM[1]}: ${colorM[2]}`);
      flagged = true;
    }
    // 属性级不够时兜底：样式对象里直接出现 hex（排除 boxShadow 字符串）
    if (!flagged) {
      const hex = /(?:'|")(#[0-9a-fA-F]{3,8})(?:'|")/.exec(line);
      if (hex && notInVar(hex.index) && !/boxShadow|textShadow|filter/.test(line)) {
        add("color-hardcoded-tsx", rel, no, raw, `hex ${hex[1]}`);
        flagged = true;
      }
    }
    // 兜底之二：hex 藏在**复合值字符串**里，例如
    //   border: '1px solid #ef444455'
    //   background: 'linear-gradient(180deg, #fff, #000)'
    // 上面那条只认「整个字符串就是一个 hex」，这类混写长期漏检（知识图谱的删除按钮边框
    // 就这么一直写着硬编码红）。这里按字面量位置逐个找 hex，并跳过 var() 的兜底值。
    if (!flagged && !/url\(/.test(line)) {
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const abs = lineStarts[i] + m.index;
        if (!styleRanges.some(([s, e]) => abs >= s && abs < e)) continue;
        if (!notInVar(m.index)) continue;
        add("color-hardcoded-tsx", rel, no, raw, `hex ${m[0]}`);
        flagged = true;
        break;
      }
    }
    // 兜底之三：**条件表达式里的命名色**。`color: disabled ? "var(--text-muted)" : "white"`
    // 既躲过属性级判定（冒号后面不是引号），也不是 hex，于是 `: "white"` 长期不可见。
    // 这里在样式对象区间内找「引号包起来的命名色」，跳过 var() 兜底值。
    if (!flagged && !/url\(/.test(line)) {
      const namedVal = /(['"])(white|black|red|green|blue|gray|grey|orange|purple|pink|yellow|cyan|magenta|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\1/gi;
      for (const m of line.matchAll(namedVal)) {
        const abs = lineStarts[i] + m.index;
        if (!styleRanges.some(([s, e]) => abs >= s && abs < e)) continue;
        if (!notInVar(m.index)) continue;
        add("color-hardcoded-tsx", rel, no, raw, `命名色: ${m[2]}`);
        flagged = true;
        break;
      }
    }
    // 兜底之四：复合值里的 rgb()/rgba()，典型是投影 ——
    //   boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
    // 投影里的黑在 CSS 侧早就要求走 --shadow-color（见 §2.3），TSX 侧却一直看不见。
    if (!flagged && !/url\(/.test(line)) {
      const rgbM = /\b(?:rgba?|hsla?)\(/.exec(line);
      if (rgbM) {
        const abs = lineStarts[i] + rgbM.index;
        if (styleRanges.some(([s, e]) => abs >= s && abs < e) && notInVar(rgbM.index)) {
          add("color-hardcoded-tsx", rel, no, raw, "rgb()/hsl()");
        }
      }
    }

    // 3) 圆角离格
    const br = /borderRadius:\s*(?:'|")?([0-9.]+)(px|rem|%)?(?:'|")?/.exec(line);
    if (br && !line.includes("var(--")) {
      const v = br[1];
      const unit = br[2] ?? "";
      let ok = false;
      if (unit === "%") ok = true;
      else if (unit === "rem") ok = SPACING_OK(parseFloat(v) * 16);
      else ok = RADIUS_OK.has(v);
      if (!ok) add("radius-offscale", rel, no, raw, `borderRadius: ${v}${unit}`);
    }

    // 4) 间距离格（padding/margin/gap 的纯数字）
    const sp = /(?:^|[\s,{])(padding|paddingTop|paddingBottom|paddingLeft|paddingRight|margin|marginTop|marginBottom|marginLeft|marginRight|gap|rowGap|columnGap)\s*:\s*([0-9]+)(?:\s*[,}])/.exec(line);
    if (sp && !SPACING_OK(parseInt(sp[2], 10)) && !line.includes("var(--")) {
      add("spacing-offgrid", rel, no, raw, `${sp[1]}: ${sp[2]}`);
    }

    if (/position:\s*(?:'|")fixed/.test(line)) modalish++;
  });

  // 内联样式密度：**只数样式对象内部**的属性。
  // 此前按行统计 `xxx: value` 形态，会把普通 TS 对象字面量、函数入参也数进去 ——
  // 那不是"内联样式过密"，是"这个文件代码多"。现在按 computeStyleRanges 的真实区间统计。
  for (const [s, e] of styleRanges) {
    styleProps += (src.slice(s, e).match(/[a-zA-Z-]+:\s*(?:'|"|\{|[0-9]|var\()/g) ?? []).length;
  }

  if (modalish > 0 && !hasUnifiedShell) {
    add("modal-shell-bespoke", rel, 1, "(file-level)", `${modalish} 处 position:fixed 浮层，未见统一外壳类`);
  }
  if (styleProps > DENSE_THRESHOLD) {
    add("inline-style-dense", rel, 1, "(file-level)", `${styleProps} 个内联样式属性`);
  }
  inlineCounts.push({ file: rel, props: styleProps, modalish });
  if (/className="(?:popup|overlay|modal-box|dialog-box|sheet)-/.test(src)) {
    add("legacy-popup-shell", rel, 1, "(file-level)", "自建浮层类名");
  }
}

function scanCss(rel, src) {
  const lines = src.split("\n");
  let inRoot = false;
  lines.forEach((raw, i) => {
    const no = i + 1;
    const line = stripComments(raw);
    if (/^\s*:root|^\s*\[data-theme|^\s*\[data-skin/.test(line)) inRoot = true;
    if (inRoot && /^\s*\}/.test(line)) inRoot = false;
    if (inRoot) return; // 令牌定义块允许原始值

    // 字号硬编码（CSS 侧，§2.1：禁止在 style 或 CSS 里写数字字号）
    // 写成 px/rem 的字号既不在刻度上，也**不吃 --ui-font-scale**（设置里调字号没反应）。
    // 相对单位 em/% 除外：它们是刻意的相对层级（如 markdown 内容里 h1>h2>正文），
    // 父级字号本身就是令牌，缩放链没有断。
    const fsz = /font-size:\s*([0-9.]+)(px|rem|pt)\b/.exec(line);
    if (fsz && !line.includes("var(--")) {
      add("fs-hardcoded", rel, no, raw, `font-size: ${fsz[1]}${fsz[2]}`);
    }

    // 色值：**逐个字面量**判定，而不是"这行有 var(-- 就整行放过" ——
    // 后者是真实盲区：`box-shadow: 0 0 0 1px var(--border-primary), 0 1px 2px rgba(0,0,0,.04)`
    // 里的黑投影就这样一直没被看见（styles.css 里曾有 12 行是这种混写）。
    const ranges = varRanges(line);
    const outsideVar = (offset) => offset >= 0 && !ranges.some(([s, e]) => offset >= s && offset < e);

    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(line);
    const rgb = /\b(?:rgba?|hsla?)\(/.exec(line);
    if ((hex && outsideVar(hex.index)) || (rgb && outsideVar(rgb.index))) {
      add("color-hardcoded-css", rel, no, raw, hex && outsideVar(hex.index) ? hex[0] : "rgb()/hsl()");
    }
    const br = /border-radius:\s*([0-9.]+)(px|rem|%)?/.exec(line);
    if (br && br[2] !== "%") {
      const v = br[2] === "rem" ? parseFloat(br[1]) * 16 : parseFloat(br[1]);
      if (!RADIUS_OK.has(String(v))) add("radius-offscale", rel, no, raw, `border-radius: ${br[0]}`);
    }

    // 命名色（white/black/…）：此前完全不被看见，`color: white` 可以一路写下去。
    // 只在「值」的位置判定：前面是空格/,/(/:，后面是空格/,/;/)，因此 `white-space` 不误报；
    // 含 url() 的行跳过（data URI 里的颜色是内容，不是 UI 样式）。
    if (!line.includes("url(")) {
      const named = /(?:^|[\s,:(])(white|black|red|green|blue|gray|grey|orange|purple|pink|yellow|cyan|magenta|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)(?=[\s,;)]|$)/gi;
      for (const m of line.matchAll(named)) {
        if (!outsideVar(m.index)) continue;
        add("color-hardcoded-css", rel, no, raw, `命名色: ${m[1]}`);
        break;
      }
    }
  });
}

/**
 * 跨文件规则：`var(--x)` 引用了全项目从未定义的令牌。
 *
 * 为什么单列一条规则：这类写法的**失败方式是静默的** —— 无兜底时整条声明被丢弃
 * （`font-family: var(--font-mono)` 让等宽字体从来没生效过、`border: 1px solid var(--border)`
 * 让边框整条消失），有兜底时则永远吃那个写死的深色（浅色/皮肤切换不跟随）。
 * 第 18 波在 WechatSettings 里发现过单个实例、第 23 波清掉了 `--border-color` 一族，
 * 但两次都是"人工发现的批次"；系统性反查（引用 vs 定义）一次就报出 96 处、10 个令牌。
 * 现在把它做成规则，避免再靠"碰巧发现"。
 */
function normalizeDefName(name) {
  return name;
}
function scanVarRefs(rel, src) {
  // 注释里的 `var(--token)` 是文档占位符，不是引用
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const lines = code.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*--([a-zA-Z0-9-]+)\s*([,)])/g)) {
      const name = normalizeDefName(m[1]);
      if (definedVars.has(name)) continue;
      if (DYNAMIC_OR_VENDOR_VAR.test(name)) continue;
      // 紧跟 `$`/`{` 的是动态拼接的名字（`var(--${x})`），无法静态判定
      const after = line.slice(m.index + m[0].length - 1, m.index + m[0].length + 2);
      if (/^\s*[${]/.test(after)) continue;
      add("css-var-undefined", rel, i + 1, line, `未定义令牌: --${name}${m[2] === "," ? "（有兜底，但不会跟随主题）" : "（无兜底，整条声明失效）"}`);
    }
  });
}

/**
 * 跨文件规则之二：**`style={{}}` 之外**写死的颜色。
 *
 * 审计器的色值规则只看内联样式对象区间，于是同一份"状态色表"只要写成 TS 常量
 * （`const STATUS_COLORS = { failed: "#ef4444" }`）或用 JS 直接改样式
 * （`el.style.background = "#ffeb3b"`）就完全看不见 —— 第 19 波把 CicdPanel 的状态色表
 * 改成语义令牌时，是靠人眼发现的，不是规则报的。
 * 这里补上：只认「像 CSS 颜色属性」的键（color / background / border 各向 / fill / stroke / boxShadow / outline…）
 * 且值以引号开头，尽量不误伤普通业务对象。
 */
function scanColorOutsideStyle(rel, src, styleRanges) {
  const lines = src.split("\n");
  let off = 0;
  lines.forEach((raw, i) => {
    const lineStart = off;
    off += raw.length + 1;
    const line = stripComments(raw);
    if (/url\(/.test(line)) return;
    // 原生 SVG 元素的表现属性不吃 CSS var()：`stroke="var(--accent)"` 会被判非法、
    // 整条属性失效（stroke 默认 none → 图形根本不画）。颜色要走 CSS 类。
    // 只认小写原生标签；大写开头的组件（<StatCard color="var(--info)">）走 props，不在其列。
    if (/<(circle|path|rect|line|polyline|polygon|ellipse|g|svg|text|stop)\b/i.test(line)) {
      const attrVar = /\b(stroke|fill|stop-color|stopColor|flood-color|floodColor)\s*=\s*["'](?:var\(|color-mix\()/.exec(line);
      if (attrVar) add("svg-attr-var", rel, i + 1, line, `${attrVar[1]} 属性里用了 var()/color-mix()（属性不生效）`);
    }
    // 落在 style={{}} 区间内的交给 color-hardcoded-tsx，避免重复计数
    const inStyle = styleRanges.some(([s, e]) => s < lineStart + raw.length && e > lineStart);
    if (inStyle) return;
    const ranges = varRanges(line);
    const outsideVar = (o) => !ranges.some(([s, e]) => o >= s && o < e);
    const m = /(['"`])(#[0-9a-fA-F]{3,8}|white|black|red|green|blue|gray|grey|orange|purple|pink|yellow|cyan|magenta|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\1/i.exec(line);
    if (!m || !outsideVar(m.index)) return;
    // 颜色值前面必须紧跟一个「像 CSS 属性」的键，才认定是样式（避免误伤普通业务对象）。
    // 前缀类里带 `.`：JS 直接改样式的写法是 `el.style.background = '#...'`，
    // 键前面是点而不是空格 —— 漏掉这个点，DocxViewer 里的高亮黄就永远查不到。
    const key = /(?:^|[\s,{[(.])(color|background|backgroundColor|border|borderColor|borderTop|borderBottom|borderLeft|borderRight|fill|stroke|boxShadow|outline|caretColor|accentColor)\s*[:=]\s*$/i.exec(line.slice(0, m.index));
    if (!key) return;
    add("color-hardcoded-ts", rel, i + 1, line, `${key[1]}: ${m[2]}`);
  });
}

/**
 * 跨文件规则之三：全局层级的 z-index 必须是令牌。
 *
 * 为什么：z-index 是**全局耦合**的属性 —— 任何一处随手写个 9999，都可能把别人的浮层盖住，
 * 而单看那一行完全看不出问题（第 27 波实测：205 处写死值散在 40 多个文件里，
 * 同一个"模态层"有两套矛盾的值 .modal-overlay=200 / --z-modal=1300，
 * toast 1400 盖不住 9999 的 portal 菜单）。
 * 判据：**>= 100 视为全局层级，必须用 var(--z-*)**；< 100 是组件内部的局部层叠
 * （幻灯片元素、棋盘格子、图标叠层），允许裸数字。
 * TSX 只在 `style={{…}}` 区间内判定 —— `createTextElement({ zIndex: 100 })` 这类是数据字段，
 * 不是 CSS，必须保持数字。
 */
const Z_LOCAL_MAX = 99;
function scanZIndex(rel, src, isCss, styleRanges) {
  const lines = src.split("\n");
  let off = 0;
  lines.forEach((raw, i) => {
    const lineStart = off;
    off += raw.length + 1;
    const line = stripComments(raw);
    if (/var\(--z-/.test(line)) return; // 已走令牌
    const m = /z-index:\s*(\d+)/.exec(line);
    const t = /zIndex:\s*(\d+)/.exec(line);
    const v = m ? Number(m[1]) : t ? Number(t[1]) : null;
    if (v === null || v <= Z_LOCAL_MAX) return;
    if (!isCss) {
      const inStyle = styleRanges.some(([s, e]) => s < lineStart + raw.length && e > lineStart);
      if (!inStyle) return; // JS 数据字段（图层序、棋盘位置）不是 CSS 层叠
    }
    add("zindex-raw", rel, i + 1, line, `z-index: ${v}（>=100 的全局层级应使用 var(--z-*) 令牌）`);
  });
}

/**
 * 跨文件规则之四：同一个类在顶层被定义多次，且同一属性给出了不同取值。
 * 后一份会**静默覆盖**前一份（同特异度、后者胜），于是"改了没生效"或"某处样式与设计不符"
 * 都极难排查。第 27 波实测 18 个类中招（最典型是 .badge 的圆角 10px vs 4px）。
 * 只认纯顶层选择器（`.foo`）：伪类、后代选择器、[data-skin]/[data-theme] 都是**有意的分层覆盖**，不算。
 */
function scanCssDuplicates(rel, src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules = [];
  let i = 0;
  let depth = 0;
  let selStart = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "{") {
      depth++;
      if (depth === 1) {
        const sel = clean.slice(selStart, i).trim().replace(/\s+/g, " ");
        let j = i + 1;
        let d = 1;
        while (j < clean.length && d > 0) {
          if (clean[j] === "{") d++;
          else if (clean[j] === "}") d--;
          j++;
        }
        if (!sel.includes("@")) {
          rules.push({ sel, body: clean.slice(i + 1, j - 1), line: clean.slice(0, selStart).split("\n").length });
        }
        i = j;
        depth = 0;
        selStart = j;
        continue;
      }
    } else if (c === "}" && depth === 0) {
      selStart = i + 1;
    }
    i++;
  }
  const bySel = new Map();
  for (const r of rules) {
    if (!/^[.a-zA-Z][\w-]*$/.test(r.sel)) continue; // 只要纯顶层选择器
    if (!bySel.has(r.sel)) bySel.set(r.sel, []);
    bySel.get(r.sel).push(r);
  }
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const seen = new Map();
    for (const r of list) {
      for (const part of r.body.split(";")) {
        const idx = part.indexOf(":");
        if (idx < 0) continue;
        const prop = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!prop || !val) continue;
        const prev = seen.get(prop);
        if (!prev) {
          seen.set(prop, { val, line: r.line });
        } else if (prev.val !== val) {
          add("css-class-duplicate", rel, r.line, `${sel} { ${prop}: ${val} }`, `${sel} 已被定义过：${prop} ${prev.val}（L${prev.line}） vs ${val}（L${r.line}）`);
        }
      }
    }
  }
}

/**
 * 间距令牌化（第 28 波）：CSS 的间距属性必须用 var(--space-*)。
 *
 * 为什么单独一条：间距是**排版节奏**的载体，写死像素意味着"改全局密度要翻 2900 处"
 * （第 28 波实测 2906 处数值间距，其中 2414 处正好落在刻度上/可以并到刻度）。
 * 例外（都有明确理由，规则直接放行）：
 *   · 0 / auto：不是间距
 *   · 1px / 0.5px：细线（§2.4 明确允许）
 *   · 负值：光学微调（图标对齐之类）
 *   · %/calc()/clamp()/var()：动态值
 */
const SPACING_PROPS =
  /(?:^|[\s;{])(padding|margin|gap|row-gap|column-gap|padding-top|padding-right|padding-bottom|padding-left|margin-top|margin-right|margin-bottom|margin-left)\s*:\s*([^;{}]+)/g;
const SPACE_SCALE = new Set(["2", "4", "6", "8", "10", "12", "14", "16", "20", "24", "28", "32", "40", "48", "64"]);
function scanCssSpacing(rel, src) {
  const lines = src.split("\n");
  let inRoot = false;
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    if (/^\s*:root|^\s*\[data-theme|^\s*\[data-skin/.test(line)) inRoot = true;
    if (inRoot && /^\s*\}/.test(line)) inRoot = false;
    if (inRoot) return; // 令牌定义块里当然是字面量
    if (!/var\(--space-/.test(line)) {
      // 本行可能是"跨行声明"的一半，用整份源码里的间距声明另判；这里只处理本行能看全的
    }
    for (const m of line.matchAll(SPACING_PROPS)) {
      for (const part of m[2].trim().split(/\s+/)) {
        const px = /^(-?[0-9.]+)px$/.exec(part);
        if (!px) continue; // var()/calc()/%/auto
        const v = px[1];
        if (v === "0" || v === "1" || v === "0.5" || v.startsWith("-")) continue;
        if (SPACE_SCALE.has(v)) {
          add("spacing-raw", rel, i + 1, line, `${m[1]}: ${part}（刻度值应用 var(--space-*)）`);
        } else {
          add("spacing-raw", rel, i + 1, line, `${m[1]}: ${part}（不在 2px 网格/刻度上）`);
        }
      }
    }
  });
}

// ========== 主流程 ==========
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const a = args.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : null;
};

const files = SCAN_DIRS.flatMap((d) => (existsSync(join(ROOT, d)) ? listFiles(join(ROOT, d)) : []));

// 内联样式密度阈值可按命令行调整：`--dense-threshold=60` 能看到"还没超标但已经很密"的文件
// （排队时用），`--inline-counts` 直接列出全部文件的属性数。
{
  const t = value("--dense-threshold");
  if (t) DENSE_THRESHOLD = Number(t);
}
const inlineCountsOnly = flag("--inline-counts");

// ---- 先建「CSS 里定义过的类名」索引（跨文件，供 css-class-undefined 规则用） ----
const definedClasses = new Set();
for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  // 注意：令牌源 styles.css 虽然不参与"违规扫描"，但它是类名的主要定义处，
  // 建索引时必须包含（否则所有类名都会被误判成"未定义"）。
  if (!rel.endsWith(".css") || /\.test\./.test(rel)) continue;
  const css = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) definedClasses.add(m[1]);
}
// ---- 再建「全项目定义过的令牌」索引（跨文件，供 css-var-undefined 规则用） ----
// 定义来源三类：① CSS 里的 `--x: …` 声明；② JS `setProperty('--x', …)`；
// ③ 内联样式里就地定义的变量（`["--kg-node-font" as string]: …`）。
const definedVars = new Set();
for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  if (/\.test\./.test(rel)) continue;
  const src = readFileSync(full, "utf8");
  if (rel.endsWith(".css")) {
    for (const m of src.matchAll(/(^|[\s;{])--([a-zA-Z0-9-]+)\s*:/g)) definedVars.add(m[2]);
  } else {
    for (const m of src.matchAll(/setProperty\(\s*['"]--([a-zA-Z0-9-]+)/g)) definedVars.add(m[1]);
    for (const m of src.matchAll(/['"]--([a-zA-Z0-9-]+)['"](\s+as\s+string)?\s*\]?\s*:/g)) definedVars.add(m[1]);
  }
}
/** 第三方库自带令牌 / 窗口自有前缀：不归本项目维护（各自带 CSS 或由 JS 注入） */
const DYNAMIC_OR_VENDOR_VAR = /^(xy-|cm-|cm6-|monaco|hljs|katex|prose|token|tippy|rt-|recharts|swiper|leaflet|ace-|fa-|tt-|radix)/;

/** 运行时状态类 / 工具类：由 JS 动态加，或本就是约定俗成的状态修饰，不算缺失 */const RUNTIME_CLASS_RE = /^(is-|has-|js-|no-|with-)|^(active|open|selected|hover|focus|visible|hidden|disabled|dragging|loading|dark|light|compact|wide|narrow)$/;
/** 第三方库自带的类名（样式由库自己的 CSS/内联注入，不归本项目管） */
const THIRD_PARTY_CLASS_RE = /^(xterm|react-flow|monaco|katex|mermaid|shiki|hljs|cm-|cm_|prose|token|language-|ace_|pdf|docx|sheet|ph-|leaflet|recharts|swiper|tippy|radix|rt-|fl-|fa-|fas|far|fab)/;

/** 去掉模板字面量里的 ${…} 表达式（含嵌套花括号），只留静态片段 */
function stripTemplateExprs(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 0;
      i += 1;
      do {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      } while (i < s.length && depth > 0);
      out += " ";
    } else {
      out += s[i++];
    }
  }
  return out;
}

/**
 * 收集一个元素上的「静态类名 token」。
 * 覆盖三种写法：`className="a b"`、`className={'a b'}`、`` className={`a ${c ? 'active' : ''}`} ``。
 * 第三种此前被整段跳过 —— 于是 ConfigEditor / NotebookManager 这类大量使用条件类名的组件，
 * 一半以上的「有类名没样式」根本不会被审计出来（工具漏检，不是没问题）。
 */
function staticClassTokens(src) {
  const hits = [];
  for (const m of src.matchAll(/className=(?:"([^"{}]+)"|\{(["'`])([\s\S]*?)\2\})/g)) {
    const raw = m[1] ?? m[3] ?? "";
    if (!raw) continue;
    hits.push({ raw: m[3] != null ? stripTemplateExprs(raw) : raw, index: m.index });
  }
  return hits;
}

for (const full of files) {
  const rel = relative(ROOT, full).replace(/\\/g, "/");
  if (shouldSkip(rel)) continue;
  const src = readFileSync(full, "utf8");
  scanVarRefs(rel, src);
  if (rel.endsWith(".css")) {
    scanCss(rel, src);
    scanCssDuplicates(rel, src);
    scanCssSpacing(rel, src);
    scanZIndex(rel, src, true, []);
    continue;
  }
  const ranges = computeStyleRanges(src);
  scanColorOutsideStyle(rel, src, ranges);
  scanZIndex(rel, src, false, ranges);
  scanTsx(rel, src);

  for (const { raw, index } of staticClassTokens(src)) {
    // 这里**刻意不再豁免「元素自己有内联样式」的情况**。
    // 旧写法是"同行有 style={{}} 就跳过"（本意：有内联样式就不算没样式），代价是
    // 一整批"类名根本没定义、外观全靠内联撑着"的空壳长期不可见 —— 第 21、24、26 波
    // 每次收口内联样式，就会冒出一批（`.trajectory-panel` / `.tool-card` / `.settings-search-box` …）。
    // 现在内联样式已经收口完毕，这条豁免的负面作用大于它挡掉的假阳性，直接去掉。
    for (const cls of raw.split(/\s+/).filter(Boolean)) {
      // 模板片段：`status-${s}` 会留下残片 "status-"，无法判定真实类名，跳过
      if (/^[-_]|[-_]$/.test(cls)) continue;
      if (RUNTIME_CLASS_RE.test(cls) || THIRD_PARTY_CLASS_RE.test(cls) || definedClasses.has(cls)) continue;
      const line = src.slice(0, index).split("\n").length;
      add("css-class-undefined", rel, line, cls, `未定义类名: ${cls}`);
    }
  }
}

const onlyRule = value("--rule");
const onlyFile = value("--file");
const filtered = findings.filter(
  (f) => (!onlyRule || f.rule === onlyRule) && (!onlyFile || f.file.includes(onlyFile)),
);

const byRule = {};
for (const f of filtered) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
const byFile = {};
for (const f of filtered) byFile[f.file] = (byFile[f.file] ?? 0) + 1;

const errorCount = filtered.filter((f) => RULES[f.rule]?.level === "error").length;
const warnCount = filtered.filter((f) => RULES[f.rule]?.level === "warn").length;

if (flag("--write-baseline")) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ at: new Date().toISOString(), errorCount, warnCount, byRule }, null, 2) + "\n",
  );
  console.log(`baseline written → ${relative(ROOT, BASELINE_PATH)}  errors=${errorCount} warns=${warnCount}`);
  process.exit(0);
}

if (flag("--inline-counts")) {
  console.log(`${"属性数".padStart(6)}  ${"浮层".padStart(4)}  文件`);
  for (const r of [...inlineCounts].sort((a, b) => b.props - a.props).slice(0, Number(value("--top") ?? 30))) {
    console.log(`${String(r.props).padStart(6)}  ${String(r.modalish).padStart(4)}  ${r.file}`);
  }
  process.exit(0);
}

if (flag("--census")) {
  const census = (kind) => {
    const counts = new Map();
    for (const f of filtered) {
      if (kind === "fs" && f.rule !== "fs-hardcoded") continue;
      if (kind === "color" && !f.rule.startsWith("color-hardcoded")) continue;
      if (kind === "radius" && f.rule !== "radius-offscale") continue;
      const key = f.detail ?? "(file)";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  for (const kind of ["fs", "color", "radius"]) {
    console.log(`\n=== ${kind} 字面量分布 ===`);
    for (const [k, n] of census(kind)) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  process.exit(0);
}

if (flag("--json")) {
  console.log(JSON.stringify({ errorCount, warnCount, byRule, byFile, findings: filtered }, null, 2));
  process.exit(0);
}

console.log(`UI 一致性审计 —— 扫描 ${files.length} 个文件`);
console.log(`\n按规则（error ${errorCount} / warn ${warnCount}）`);
for (const [rule, meta] of Object.entries(RULES)) {
  const n = byRule[rule] ?? 0;
  const mark = meta.level === "error" ? "✗" : "·";
  console.log(`  ${mark} ${rule.padEnd(22)} ${String(n).padStart(5)}   ${meta.desc}`);
}

const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 15);
if (top.length) {
  console.log(`\n问题最多的文件（前 15）`);
  for (const [file, n] of top) console.log(`  ${String(n).padStart(5)}  ${file}`);
}

if (flag("--verbose")) {
  console.log(`\n示例（每规则最多 8 条）`);
  const seen = {};
  for (const f of filtered) {
    seen[f.rule] = (seen[f.rule] ?? 0) + 1;
    if (seen[f.rule] > 8) continue;
    console.log(`  [${f.rule}] ${f.file}:${f.line}  ${f.detail ?? ""}`);
  }
}

process.exit(errorCount > 0 && flag("--strict") ? 1 : 0);
