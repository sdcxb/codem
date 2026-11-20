/**
 * layout-audit —— **运行时布局审计**（第 8 轮新增，CDP 驱动、量真实排版）。
 *
 * ## 为什么需要它（之前的「深度排查」为什么漏）
 *
 * `tools/ui-audit/scan-ui.mjs` 是**源码级**扫描：它查 token 用法、颜色角色、样式字面量；
 * `_crawl.mjs` 查的是 console 错误、死点击、空白浮层。两者都**不量排版** ——
 * 于是像「`grid-template-columns: repeat(auto-fill, …)` 把一行状态条拆成 40 个窄列、
 * 计数竖排成 1/0/6/0/0」这种问题，源码扫描看不到，爬取也不会报错（没有溢出、没有异常）。
 *
 * 这个工具把「看起来挤/断行/裁切」变成**可数的判据**：导航到每个页面，用
 * `getBoundingClientRect` + `getComputedStyle` 量真实几何与字体间距，输出违规清单。
 *
 * ## 判据（R1..R6）
 *
 * - **R1 网格碎片化**：`display:grid` 且有 ≥5 条轨道、子元素 ≤4 个 ⇒ 几乎一定是
 *   `auto-fill` 把一行拆成了很多空列（真机那次的形态）。
 * - **R2 行内组被竖排**：`flex-direction: row` 的容器里，≥3 个子项**同 x、不同 y**
 *   ⇒ 本该横排的东西被挤成了竖排。
 * - **R3 短标签断行**：文本 ≤ 20 字、`white-space: normal`、但 Range 量出 ≥2 行。
 * - **R4 裁切**：`overflow: hidden/clip` 且 `scrollWidth > clientWidth + 1` 且有文字。
 * - **R5 过窄/过矮**：`clientWidth < 14` 或 `clientHeight < 12` 但有可见文字。
 * - **R6 文字间距离群**：`letter-spacing` 非 `normal` 且 |px| 与字号比例异常；
 *   `line-height < 1.15 × font-size` 的多行文本（中文行距过紧）。
 *
 * ## 用法（需要一个已开 CDP 的开发实例 + 已在 1420 上服务的 dist）
 *
 * ```powershell
 * node tools/ui-audit/layout-audit.mjs                 # 默认 9224 / http://localhost:1420/
 * node tools/ui-audit/layout-audit.mjs --only=taskcenter
 * node tools/ui-audit/layout-audit.mjs --max-scenes=8 --verbose
 * ```
 *
 * 产物：`.preview-shot/unslop/layout-audit/<时间戳>.json`（被 .gitignore 忽略）。
 * 退出码：有 R1/R2/R4 违规时为 1（那三类是「排版坏了」）；只有 R3/R5/R6 时为 0 并打印提醒。
 */

import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}
const PORT = Number(args.get("port") ?? 9224);
const URL_BASE = args.get("url") ?? "http://localhost:1420/";
const ONLY = args.get("only") ?? "";
const MAX_SCENES = Number(args.get("max-scenes") ?? 0);
const VERBOSE = args.get("verbose") === "true";
/* 是否给每个场景存一张截图（人工复核用；默认关，产物在 layout-audit/shots/） */
const SHOTS = args.get("shots") === "true";
/* 视口宽度：窄窗口是"挤压/换行"最容易暴露的地方（默认 1600×900） */
const VIEW_W = Number(args.get("width") ?? 1600);
const VIEW_H = Number(args.get("height") ?? 900);
const OUT_DIR = path.resolve(args.get("out") ?? ".preview-shot/unslop/layout-audit");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 页面内测量函数（作为源码注入，避免每次 eval 都重复一份长字符串）
 * ------------------------------------------------------------------ */
const MEASURE_SRC = String.raw`
window.__layoutAudit = function () {
  var out = [];
  var seen = {};
  function cls(el) {
    var c = typeof el.className === "string" ? el.className : "";
    return c.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  }
  function sel(el) {
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur !== document.body && depth < 4) {
      var part = cur.tagName.toLowerCase();
      var c = cls(cur);
      if (c) part += "." + c;
      var parent = cur.parentElement;
      if (parent) {
        var same = 0;
        var idx = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i];
          if (sib.tagName === cur.tagName && cls(sib) === c) { same++; if (sib === cur) idx = same; }
        }
        if (same > 1) part += ":nth-of-type(" + idx + ")";
      }
      parts.unshift(part);
      cur = parent;
      depth++;
    }
    return parts.join(" > ");
  }
  function text(el) {
    var t = el.innerText || el.textContent || "";
    return t.replace(/\s+/g, " ").trim();
  }
  function visible(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    if (Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function push(rule, el, detail, extra) {
    var key = rule + "|" + sel(el);
    if (seen[key]) return;
    seen[key] = 1;
    out.push({
      rule: rule,
      selector: sel(el),
      text: text(el).slice(0, 60),
      detail: detail,
      rect: (function (r) { return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(el.getBoundingClientRect()),
      extra: extra || null,
    });
  }
  function lineCount(el) {
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var rects = range.getClientRects();
      var lines = 0;
      var lastY = null;
      for (var i = 0; i < rects.length; i++) {
        var y = Math.round(rects[i].top);
        if (lastY === null || Math.abs(y - lastY) > 2) { lines++; lastY = y; }
      }
      return lines;
    } catch (e) { return 0; }
  }

  var all = Array.prototype.slice.call(document.querySelectorAll("body *")).filter(visible);

  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var t = text(el);

    /* R1 网格碎片化：很多空轨道，子元素只占少数几格 */
    if (cs.display.indexOf("grid") === 0) {
      var tracks = (cs.gridTemplateColumns || "").split(" ").filter(function (s) { return s && s !== "none"; });
      var kids = Array.prototype.slice.call(el.children).filter(visible);
      if (tracks.length >= 5 && kids.length >= 1 && kids.length <= 4) {
        push("R1", el, "grid " + tracks.length + " tracks / " + kids.length + " children", { tracks: tracks.length, kids: kids.length });
      }
    }

    /* R2 行内组被竖排：row 容器里子项同 x 不同 y */
    if ((cs.display === "flex" || cs.display === "inline-flex") && cs.flexDirection === "row") {
      var kids2 = Array.prototype.slice.call(el.children).filter(visible);
      if (kids2.length >= 3) {
        var xs = {};
        var ys = {};
        for (var k = 0; k < kids2.length; k++) {
          var kr = kids2[k].getBoundingClientRect();
          xs[Math.round(kr.x)] = 1;
          ys[Math.round(kr.y)] = 1;
        }
        var nx = Object.keys(xs).length;
        var ny = Object.keys(ys).length;
        if (nx <= 2 && ny >= 3 && r.width < 320) {
          push("R2", el, "row-flex but " + ny + " rows / " + nx + " x", { rows: ny, cols: nx });
        }
      }
    }

    /* R3 短标签断行：直接文本 ≤20 字，却占 ≥2 行 */
    var leafText = "";
    var hasElementKid = false;
    for (var n = 0; n < el.childNodes.length; n++) {
      var node = el.childNodes[n];
      if (node.nodeType === 3) leafText += node.nodeValue || "";
      else if (node.nodeType === 1) hasElementKid = true;
    }
    leafText = leafText.replace(/\s+/g, " ").trim();
    /* 行内元素（inline-term / 行内代码）跨行是正常的排版，不算"短标签断行" */
    if (cs.display !== "inline" && !hasElementKid && leafText.length > 0 && leafText.length <= 20 && cs.whiteSpace === "normal") {
      var lines = lineCount(el);
      if (lines >= 2 && r.height > 20 && r.width < 260) {
        push("R3", el, "short text wrapped into " + lines + " lines", { lines: lines, chars: leafText.length });
      }
    }

    /* R4 裁切 */
    var innerScroller = (function (root) {
      var found = false;
      var walk = function (el, depth) {
        if (found || depth > 2) return;
        for (var ci = 0; ci < el.children.length; ci++) {
          var kid = el.children[ci];
          var kcs = getComputedStyle(kid);
          if (kcs.overflowY === "auto" || kcs.overflowY === "scroll" || kcs.overflowX === "auto" || kcs.overflowX === "scroll") { found = true; return; }
          walk(kid, depth + 1);
        }
      };
      walk(root, 0);
      return found;
    })(el);
    var intentionalClamp = cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none" || cs.getPropertyValue("-webkit-line-clamp") !== "none";
    var scrollable = cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflowY === "auto" || cs.overflowY === "scroll";
    if (!innerScroller && !intentionalClamp && !scrollable && (cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.overflowY === "hidden" || cs.overflowY === "clip") && t.length > 0) {
      /* 差值 ≤6px 多半是滚动条/小数取整，不算裁切 */
      if (el.scrollWidth > el.clientWidth + 6 || el.scrollHeight > el.clientHeight + 6) {
        push("R4", el, "clipped (" + el.scrollWidth + ">" + el.clientWidth + ")", { sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight });
      }
    }

    /* R5 过窄/过矮 */
    if (leafText.length >= 3 && !hasElementKid) {
      if ((el.clientWidth > 0 && el.clientWidth < 9) || (el.clientHeight > 0 && el.clientHeight < 9)) {
        push("R5", el, "undersized box " + el.clientWidth + "x" + el.clientHeight, { w: el.clientWidth, h: el.clientHeight });
      }
    }

    /* R6 文字间距离群 */
    /* 终端渲染器（xterm）自己控制字符网格与字距，不属于 UI 排版 */
    var inTerminal = !!(el.closest && el.closest(".xterm"));
    if (!hasElementKid && leafText.length > 0 && !inTerminal) {
      var fs2 = parseFloat(cs.fontSize) || 0;
      var ls = cs.letterSpacing;
      if (ls && ls !== "normal" && fs2 > 0) {
        var lsv = parseFloat(ls);
        if (!isNaN(lsv) && Math.abs(lsv) / fs2 > 0.045) {
          push("R6", el, "letter-spacing " + ls + " on " + cs.fontSize, { letterSpacing: ls, fontSize: cs.fontSize, ratio: +(Math.abs(lsv) / fs2).toFixed(3) });
        }
      }
      var lh = cs.lineHeight;
      if (lh && lh !== "normal" && fs2 > 0) {
        var lhv = parseFloat(lh);
        var lines3 = lineCount(el);
        if (!isNaN(lhv) && lines3 >= 2 && lhv / fs2 < 1.15) {
          push("R6", el, "tight line-height " + lh + " on " + cs.fontSize, { lineHeight: lh, fontSize: cs.fontSize, lines: lines3 });
        }
      }
    }
    /* R9：子元素从父容器里"溢出来"（父容器有边框/底色，子元素静态定位却比父容器大） */
    (function () {
      var hasChrome = (parseFloat(cs.borderTopWidth) || 0) > 0 || (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)");
      if (!hasChrome || cs.overflow !== "visible") return;
      if (el.children.length === 0) return;
      var pr = el.getBoundingClientRect();
      var escaped = 0;
      var worst = null;
      for (var ci2 = 0; ci2 < el.children.length; ci2++) {
        var kid2 = el.children[ci2];
        var kcs2 = getComputedStyle(kid2);
        if (kcs2.position === "absolute" || kcs2.position === "fixed") continue;
        var kr2 = kid2.getBoundingClientRect();
        if (kr2.width === 0 || kr2.height === 0) continue;
        var over = Math.max(pr.left - kr2.left, kr2.right - pr.right, pr.top - kr2.top, kr2.bottom - pr.bottom);
        if (over > 1.5) { escaped++; if (!worst || over > worst.over) worst = { over: Math.round(over), kid: (kid2.tagName || "").toLowerCase() + "." + (String(kid2.className || "").trim().split(/\s+/)[0] || "") }; }
      }
      if (escaped > 0) push("R9", el, escaped + " child overflow, max " + worst.over + "px (" + worst.kid + ")", worst);
    })();

    /* R8：两端对齐（中文两端对齐会造成字距忽大忽小） */
    if (!hasElementKid && cs.textAlign === "justify" && leafText.length >= 8) {
      push("R8", el, "text-align justify on CJK", { textAlign: cs.textAlign });
    }
  }
  return out;
};
window.__layoutProfile = function () {
  var prof = { fontSizes: {}, letterSpacings: {}, lineHeightRatios: {}, textElements: 0 };
  var all = Array.prototype.slice.call(document.querySelectorAll("body *")).filter(function (el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3 && (el.childNodes[i].nodeValue || "").trim()) return true;
    }
    return false;
  });
  for (var i = 0; i < all.length; i++) {
    var cs = getComputedStyle(all[i]);
    var fs2 = cs.fontSize;
    var ls = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
    var lh = cs.lineHeight;
    var fsv = parseFloat(fs2) || 0;
    prof.textElements++;
    prof.fontSizes[fs2] = (prof.fontSizes[fs2] || 0) + 1;
    prof.letterSpacings[fs2 + "|" + ls] = (prof.letterSpacings[fs2 + "|" + ls] || 0) + 1;
    if (lh && lh !== "normal" && fsv > 0) {
      var ratio = (parseFloat(lh) / fsv).toFixed(2);
      prof.lineHeightRatios[fs2 + "|" + ratio] = (prof.lineHeightRatios[fs2 + "|" + ratio] || 0) + 1;
    }
  }
  return prof;
};
true;
`;

/* ------------------------------------------------------------------ *
 * CDP 最小客户端（Node 24 自带 WebSocket）
 * ------------------------------------------------------------------ */
async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function connect() {
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`端口 ${PORT} 上找不到 page target`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
    });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("evaluate 失败：" + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  return { ws, send, evalJs };
}

/* ------------------------------------------------------------------ *
 * 场景导航
 * ------------------------------------------------------------------ */
const TASK_CENTER_TABS = ["概览", "委派", "子智能体", "自动化", "Issues", "看板", "团队", "收件箱"];

/**
 * 每个场景 = 一串「点击标签」。标签先用 exact 匹配，再退回 contains 匹配。
 * `after` 是点击后额外等待（有些面板要采样一次才出内容）。
 */
const SCENES = [
  { name: "main", steps: [], after: 0 },
  { name: "taskcenter-overview", steps: [{ label: "任务管理", mode: "contains" }], after: 1200 },
  ...TASK_CENTER_TABS.filter((t) => t !== "概览").map((t) => ({
    name: `taskcenter-${t}`,
    steps: [{ label: "任务管理", mode: "contains" }, { label: t, mode: "exact" }],
    after: 1400,
  })),
  { name: "taskcenter-subagents-scene", steps: [{ label: "任务管理", mode: "contains" }, { label: "子智能体", mode: "exact" }], after: 1400 },
  { name: "taskcenter-subagents-settings", steps: [{ label: "任务管理", mode: "contains" }, { label: "子智能体", mode: "exact" }, { label: "设置", mode: "exact", container: ".lo-task" }], after: 1200 },
  { name: "dialog-plugins", steps: [{ label: "插件管理", mode: "contains" }], after: 1400 },
  { name: "dialog-search", steps: [{ label: "搜索", mode: "exact" }], after: 1000 },
  { name: "menu-file", steps: [{ label: "文件", mode: "exact" }], after: 800 },
  { name: "notebook-workspace", steps: [{ label: "知识笔记本", mode: "exact" }, { label: "打开", mode: "contains" }], after: 1600 },
  { name: "dialog-projects", steps: [{ label: "新对话", mode: "contains" }], after: 1000 },
  { name: "manager-mcp", steps: [{ label: "MCP", mode: "exact" }], after: 1200 },
  { name: "manager-skills", steps: [{ label: "技能", mode: "exact" }], after: 1200 },
  { name: "manager-memory", steps: [{ label: "记忆", mode: "exact" }], after: 1200 },
  { name: "manager-agents", steps: [{ label: "智能体", mode: "exact" }], after: 1200 },
  { name: "manager-notebooks", steps: [{ label: "知识笔记本", mode: "exact" }], after: 1200 },
  {
    name: "settings",
    steps: [{ label: "设置", mode: "contains" }],
    after: 900,
    /* 设置里 24 个页面逐个展开（只量根页会漏掉整片页面） */
    each: { container: ".settings-sidebar", item: ".settings-sidebar-item", label: "settings" },
  },
];

async function clickLabel(ctx, label, mode, container) {
  const expr = `(function () {
    var label = ${JSON.stringify(label)};
    var mode = ${JSON.stringify(mode)};
    var root = ${JSON.stringify(container ?? null)} ? document.querySelector(${JSON.stringify(container ?? null)}) : document;
    if (!root) root = document;
    var nodes = Array.prototype.slice.call(root.querySelectorAll("button, [role=tab], [role=button], a, .sidebar-rail-btn, .settings-nav-item"));
    function norm(s) { return (s || "").replace(/\\s+/g, " ").trim(); }
    var hit = nodes.filter(function (el) {
      var t = norm(el.innerText || el.textContent || "");
      var aria = norm(el.getAttribute("aria-label") || "");
      var title = norm(el.getAttribute("title") || "");
      var hay = t + " | " + aria + " | " + title;
      if (mode === "exact") return t === label || aria === label || title === label;
      return hay.indexOf(label) >= 0;
    }).filter(function (el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!hit.length) return { ok: false, why: "no-match" };
    var el = hit[0];
    el.click();
    return { ok: true, text: norm(el.innerText || el.getAttribute("aria-label") || el.title).slice(0, 40) };
  })()`;
  return ctx.evalJs(expr);
}

async function measure(ctx) {
  return ctx.evalJs("window.__layoutAudit()");
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const ctx = await connect();
await ctx.send("Page.addScriptToEvaluateOnNewDocument", { source: MEASURE_SRC });
await ctx.send("Page.navigate", { url: URL_BASE });
await sleep(3500);
await ctx.evalJs(
  `new Promise(function (resolve) { var t0 = Date.now(); var tick = function () { var ok = document.querySelector(".app") && document.querySelector(".sidebar-session"); if (ok || Date.now() - t0 > 90000) resolve(!!ok); else setTimeout(tick, 250); }; tick(); })`,
);
await ctx.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
await sleep(800);
async function ensureMeasure() {
  const kind = await ctx.evalJs("typeof window.__layoutAudit");
  if (kind !== "function") {
    try {
      await ctx.evalJs(MEASURE_SRC);
    } catch (e) {
      throw new Error("测量函数注入失败（先检查 MEASURE_SRC 语法）：" + String(e).slice(0, 400));
    }
    const again = await ctx.evalJs("typeof window.__layoutAudit");
    if (again !== "function") throw new Error("测量函数注入后仍然不可用");
  }
}
await ensureMeasure();

const results = [];
let scenes = SCENES;
if (ONLY) scenes = scenes.filter((s) => s.name.includes(ONLY));
if (MAX_SCENES > 0) scenes = scenes.slice(0, MAX_SCENES);

for (const scene of scenes) {
  /* 每个场景从首页重新开始，避免上一个场景的弹层残留 */
  await ctx.send("Page.navigate", { url: URL_BASE });
  await sleep(2600);
  await ctx.evalJs(
    `new Promise(function (resolve) { var t0 = Date.now(); var tick = function () { var ok = document.querySelector(".app") && document.querySelector(".sidebar-session"); if (ok || Date.now() - t0 > 60000) resolve(!!ok); else setTimeout(tick, 250); }; tick(); })`,
  );
  await ctx.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await ensureMeasure();
  const stepResults = [];
  let navOk = true;
  for (const step of scene.steps) {
    const r = await clickLabel(ctx, step.label, step.mode, step.container);
    stepResults.push({ label: step.label, ...r });
    if (!r?.ok) {
      navOk = false;
      break;
    }
    await sleep(900);
  }
  if (!navOk) {
    results.push({ scene: scene.name, navOk: false, steps: stepResults, violations: [] });
    continue;
  }
  await sleep(scene.after ?? 800);

  /* 可选截图：便于人工复核"看起来挤"的页面 */
  async function snap(name) {
    if (!SHOTS) return;
    try {
      const r = await ctx.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(OUT_DIR, "shots", `${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    } catch {
      /* 截图失败不影响审计 */
    }
  }

  const record = async (name) => {
    const violations = (await measure(ctx)) ?? [];
    const profile = (await ctx.evalJs("window.__layoutProfile()")) ?? null;
    results.push({ scene: name, navOk: true, steps: stepResults, violations, profile });
    const counts = violations.reduce((acc, v) => {
      acc[v.rule] = (acc[v.rule] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`${name.padEnd(34)} ${JSON.stringify(counts)}`);
    if (VERBOSE) {
      for (const v of violations.slice(0, 40)) console.log(`   ${v.rule} ${v.selector} — ${v.detail} — 「${v.text}」`);
    }
    await snap(name.replace(/[^\p{L}\p{N}_-]+/gu, "_"));
  };

  if (scene.each) {
    const labels = await ctx.evalJs(`(function () {
      var box = document.querySelector(${JSON.stringify(scene.each.container)});
      if (!box) return [];
      return Array.prototype.slice.call(box.querySelectorAll(${JSON.stringify(scene.each.item)}))
        .map(function (el) { return (el.innerText || "").replace(/\\s+/g, " ").trim(); })
        .filter(Boolean);
    })()`);
    for (const label of labels ?? []) {
      const r = await clickLabel(ctx, label, "exact");
      if (!r?.ok) continue;
      await sleep(1100);
      await record(`${scene.name}:${label}`);
    }
  } else {
    await record(scene.name);
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const totals = {};
for (const r of results) for (const v of r.violations) totals[v.rule] = (totals[v.rule] ?? 0) + 1;
const hard = (totals.R1 ?? 0) + (totals.R2 ?? 0) + (totals.R4 ?? 0);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(OUT_DIR, `${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), url: URL_BASE, totals, results }, null, 2), "utf8");

console.log("\n=== 合计 ===");
for (const k of Object.keys(totals).sort()) console.log(`  ${k}: ${totals[k]}`);
console.log(`\nJSON: ${outFile}`);
console.log(hard > 0 ? `\n❌ 硬性排版问题 ${hard} 处（R1 网格碎片 / R2 竖排 / R4 裁切）` : "\n✅ 无 R1/R2/R4 硬性排版问题");
ctx.ws.close();
process.exit(hard > 0 ? 1 : 0);
