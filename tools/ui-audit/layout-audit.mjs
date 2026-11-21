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
 *   `line-height < 1.15 × font-size` 的多行文本（中文行距过紧）。 * - **R9 子元素溢出父容器**：父容器有边框/底色、`overflow:visible`、静态子元素超出 >1.5px
 *   （第 11 轮：搜索框底色越出胶囊、卡片被压扁都是这一类）。
 * - **R10 hover 改变布局**：悬停后元素自身 offset 尺寸或同父兄弟位置变化（只许改颜色/阴影）。
 * - **R11 焦点环被裁**：`:focus-visible` 的外扩环超出最近的 `overflow:hidden` 祖先。
 * - **R12 浮层超出视口**：绝对/固定定位的菜单/气泡/弹窗越过窗口边缘 >2px。
 * - **R13 键盘焦点不可见**：可聚焦元素既无 outline、也无 box-shadow、祖先也没有环（第 13 轮）。
 *
 * ## 状态覆盖（第 12 轮）
 *
 * 每个场景除了静态页，还会：① 逐个点开二级页签；② 悬停主内容区控件（R10）；
 * ③ 连按 Tab 走键盘焦点（R11）；④ 管理器/任务中心点开第一张卡（详情态）；
 * ⑤ 三个浮层场景（模型菜单 / 斜杠命令 / 会话右键）。
 * 开关：`--no-substates` / `--no-hover` / `--no-focus` / `--no-detail`，限量：`--hover-max` / `--focus-max`。 *
 * **第 13 轮：hover/focus 改为「按类名穷举」**（每类取一个代表，默认 hover 80 / focus 120），
 *
 * **第 14 轮：同类多实例模式 `--multi`** —— 同一个类不再只测一个代表，按「disabled / 文本长度档 / 宽度档」
 * 再分变体（例如 .market-skill-card 的短标题卡与长标题卡各测一次）。实测 dialog-plugins：
 * hover 23→28、focus 26→30。默认关闭（单实例模式更快）。
 *
 * 真实模型场景新增（都要 `--real-model`）：
 * - `dialog-tool-error`：read 一个沙箱外路径 → 量工具失败态；
 * - `dialog-abort`：长任务流式中量一次，点 `.cancel-btn` 取消，再量停止态；
 * - `dialog-tool-confirm`：请求批准 + 危险命令 → 等 `.permission-overlay`。**当前 dev 工作区触发不到**
 *   （ask 模式下 rm -rf 被直接执行），场景会记录失败证据并跳过，不伪装成通过。
 * 并新增真实模型场景 `dialog-approval`（仅 `--real-model` 时运行，会消耗一次模型回合）：
 * 切到「请求批准」→ 覆盖写入已有文件 → 等内嵌 diff 审批面板 → 量面板布局 → 点批准 → 恢复模式。
 * 浮层/计时器这类「内容自己会动」的元素已从 hover 探针里排除（否则会把活内容重渲染误报成 hover 位移）。
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
/* 状态覆盖（第 11 轮补齐）：--no-<x> 可关掉某一类，默认全开 */
const SUBSTATES = args.get("no-substates") !== "true";
const HOVER = args.get("no-hover") !== "true";
const FOCUS = args.get("no-focus") !== "true";
const DETAIL = args.get("no-detail") !== "true";
/* 真实模型场景（审批弹窗）默认关：只在显式 --real-model 时跑，避免例行审计消耗 token */
const REAL_MODEL = args.get("real-model") === "true";
/* 同类多实例：按 文本长度/有无文字 再分变体（默认每类只测一个代表） */
const MULTI = args.get("multi") === "true";
const APPROVAL_FILE = args.get("approval-file") ?? "lo-approval-probe.txt";
const HOVER_MAX = Number(args.get("hover-max") ?? 80);
const FOCUS_MAX = Number(args.get("focus-max") ?? 120);
const MAX_SCENES = Number(args.get("max-scenes") ?? 0);
const VERBOSE = args.get("verbose") === "true";
/* 是否给每个场景存一张截图（人工复核用；默认关，产物在 layout-audit/shots/） */
const SHOTS = args.get("shots") === "true";
/* 视口宽度：窄窗口是"挤压/换行"最容易暴露的地方（默认 1600×900） */
const VIEW_W = Number(args.get("width") ?? 1600);
const VIEW_H = Number(args.get("height") ?? 900);
const OUT_DIR = path.resolve(args.get("out") ?? ".preview-shot/unslop/layout-audit");/* dev 实例的工作区（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 那套 data-home） */
const APPROVAL_WORKSPACE = path.resolve(".preview-shot/unslop/data-home/workspace");
const APPROVAL_PATH = path.join(APPROVAL_WORKSPACE, args.get("approval-file") ?? "lo-approval-probe.txt");

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

    /*
     * R1 网格碎片化：很多空轨道，子元素只占少数几格。
     *
     * ⚠️ 只看「轨道数 ≥5 且子元素 ≤4」会误报 auto-fit 的 minmax(110px, 1fr)：
     * auto-fit 会把**空轨道折叠成 0 宽**，computed 里仍列出 7 条，但子元素是铺满的。
     * 真问题（本次的 auto-fill）特征是「尾部留出大片空白」，所以再加一条：
     * 子元素右边界与容器右边界的距离 > 容器宽度 25%。
     */
    if (cs.display.indexOf("grid") === 0) {
      var tracks = (cs.gridTemplateColumns || "").split(" ").filter(function (s) { return s && s !== "none"; });
      var kids = Array.prototype.slice.call(el.children).filter(visible);
      if (tracks.length >= 5 && kids.length >= 1 && kids.length <= 4) {
        var er = el.getBoundingClientRect();
        var maxRight = 0;
        for (var ki = 0; ki < kids.length; ki++) {
          var kr = kids[ki].getBoundingClientRect();
          if (kr.right > maxRight) maxRight = kr.right;
        }
        var trailing = er.right - maxRight;
        /* 卡片网格（子元素自带边框/底色且轨道够宽）是「稀疏但正确」，不算碎片化：
           真 bug 的子元素是裸文本（无边框），轨道只有 40~50px。 */
        var cardLike = kids.every(function (k) {
          var kcs = getComputedStyle(k);
          return (parseFloat(kcs.borderTopWidth) || 0) > 0 || (kcs.backgroundColor && kcs.backgroundColor !== "rgba(0, 0, 0, 0)");
        });
        var trackPx = tracks.map(function (t) { return parseFloat(t) || 0; });
        var avgTrack = trackPx.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, trackPx.length);
        if (cardLike && avgTrack >= 100) return;
        if (trailing > er.width * 0.25) {
          push("R1", el, "grid " + tracks.length + " tracks / " + kids.length + " children, trailing " + Math.round(trailing) + "px", { tracks: tracks.length, kids: kids.length, trailing: Math.round(trailing) });
        }
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
    var clamped = (cs.webkitLineClamp && cs.webkitLineClamp !== "none") || (cs.lineClamp && cs.lineClamp !== "none");
    if (!clamped && cs.display !== "inline" && !hasElementKid && leafText.length > 0 && leafText.length <= 20 && cs.whiteSpace === "normal") {
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
    /* 屏读专用类（视觉上就该藏起来，不是“文本被切”） */
    var isSrOnly = (el.className && String(el.className).indexOf("sr-only") >= 0) || !!(el.closest && el.closest(".sr-only"));
    /* 「已折叠」的长消息/卡片是**有意截断**（有展开控件），不算静默裁切 */
    if (el.closest && el.closest('[class*="collapsed"]')) return;
    if (isSrOnly) return;
    if (!innerScroller && !intentionalClamp && !scrollable && (cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.overflowY === "hidden" || cs.overflowY === "clip") && t.length > 0) {
      /* 画布/缩放内容：transform: scale() 不改变 scrollHeight，但视觉上没有溢出 —— 跳过 */
      var scaledInside = false;
      for (var ci4 = 0; ci4 < el.children.length && !scaledInside; ci4++) {
        var ccs4 = getComputedStyle(el.children[ci4]);
        /* 绝对定位 + transform 的子层 = 画布/平移视口（如场景图），容器裁切是**设计**，不是文本被切 */
        if (ccs4.transform && ccs4.transform !== "none" && (ccs4.position === "absolute" || ccs4.position === "fixed")) {
          scaledInside = true;
        }
      }
      if (scaledInside) return;
      /* 差值 ≤6px 多半是滚动条/小数取整，不算裁切 */
      if (el.scrollWidth > el.clientWidth + 6 || el.scrollHeight > el.clientHeight + 6) {
        push("R4", el, "clipped (" + el.scrollWidth + ">" + el.clientWidth + ")", { sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight });
      }
    }

    /* R5 过窄/过矮 */
    if (leafText.length >= 3 && !hasElementKid) {
      if (el.className && String(el.className).indexOf("sr-only") >= 0) return;
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
    /* R12：浮层/菜单/气泡超出视口（贴边弹层最容易踩：气泡被窗口裁掉一半） */
    (function () {
      var pos12 = cs.position;
      if (pos12 !== "absolute" && pos12 !== "fixed") return;
      if (cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) return;
      var hint12 = String(el.className || "") + " " + String(el.getAttribute("role") || "");
      if (!/menu|popover|dropdown|tooltip|dialog|popup|overlay|panel/i.test(hint12)) return;
      var r12 = el.getBoundingClientRect();
      if (r12.width < 8 || r12.height < 8) return;
      var overX = Math.max(0 - r12.left, r12.right - window.innerWidth);
      var overY = Math.max(0 - r12.top, r12.bottom - window.innerHeight);
      if (overX > 2 || overY > 2) push("R12", el, "popover escapes viewport by " + Math.round(Math.max(overX, overY)) + "px", { x: Math.round(r12.left), y: Math.round(r12.top), w: Math.round(r12.width), h: Math.round(r12.height) });
    })();
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
  { name: "dialog-approval", special: "approval", steps: [], after: 0 },
  { name: "dialog-tool-error", special: "tool-error", steps: [], after: 0 },
  { name: "dialog-abort", special: "abort", steps: [], after: 0 },
  { name: "dialog-tool-confirm", special: "tool-confirm", steps: [], after: 0 },
  { name: "menu-model", special: "model-menu", steps: [], after: 300 },
  { name: "menu-slash", special: "slash-menu", steps: [], after: 300 },
  { name: "menu-session", special: "session-menu", steps: [], after: 300 },
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

async function evalJs(ctx, src) { return ctx.evalJs(src); }

async function measure(ctx) {
  return ctx.evalJs("window.__layoutAudit()");
}

/* ------------------------------------------------------------------ *
 * 状态探测（第 11 轮补齐「hover / focus / 二级页签」三种未覆盖状态）
 * ------------------------------------------------------------------ */

/** 收集当前页面上可见的「二级页签」候选，并打上稳定的探针 id。 */
async function collectSubstates(ctx) {
  return ctx.evalJs('(function () {' +
    'var sel = \'[role="tab"], .settings-subnav-pill, .sp-tab, .usage-tab, .manager-tab, .task-center-tab, .skill-manager-tabs button, [class*="subnav"] > button, [class*="tabs"] > button\';' +
    'var roots = [document.querySelector("main"), document.querySelector(".settings-content"), document.querySelector(".modal-editor"), document.querySelector(".task-center-panel"), document.querySelector(".app-content")].filter(Boolean);' +
    'if (!roots.length) roots = [document];' +
    'var nodes = [];' +
    'for (var ri = 0; ri < roots.length; ri++) nodes = nodes.concat(Array.prototype.slice.call(roots[ri].querySelectorAll(sel)));' +
    'nodes = nodes.filter(function (n) { return !n.closest(".sidebar") && !n.closest(".titlebar") && !n.closest(".right-sidebar"); });' +
    'var seen = {}; var out = [];' +
    'for (var i = 0; i < nodes.length; i++) {' +
    '  var el = nodes[i];' +
    '  var r = el.getBoundingClientRect();' +
    '  if (r.width < 8 || r.height < 8) continue;' +
    '  var cs = getComputedStyle(el);' +
    '  if (cs.visibility === "hidden" || cs.display === "none") continue;' +
    '  var label = (el.innerText || el.getAttribute("aria-label") || el.title || "").replace(/\\s+/g, " ").trim();' +
    '  if (!label || seen[label]) continue;' +
    '  seen[label] = 1;' +
    '  el.setAttribute("data-lo-sub", String(out.length));' +
    '  out.push({ id: out.length, label: label.slice(0, 24) });' +
    '  if (out.length >= 14) break;' +
    '}' +
    'return out;' +
  '})()');
}

/** 点击某个二级页签（按探针 id，避免重名/滚动定位问题）。 */
async function clickSubstate(ctx, id) {
  return ctx.evalJs('(function () {' +
    'var el = document.querySelector(\'[data-lo-sub="' + id + '"]\');' +
    'if (!el) return false; el.click(); return true;' +
  '})()');
}

/** 记录元素与其兄弟的「布局尺寸」，用于 hover 前后对比（transform 不改变 offset，故不会误报）。 */
async function hoverSnapshot(ctx, id) {
  return ctx.evalJs('(function () {' +
    'var el = document.querySelector(\'[data-lo-hover="' + id + '"]\');' +
    'if (!el) return null;' +
    'var r = el.getBoundingClientRect(); var p = el.parentElement;' +
    'var sibs = p ? Array.prototype.slice.call(p.children).map(function (k, idx) {' +
    '  var b = k.getBoundingClientRect(); var kcs = getComputedStyle(k);' +
    '  var key = k.getAttribute("data-lo-sib");' +
    '  if (!key) { key = "s" + idx; k.setAttribute("data-lo-sib", key); }' +
    '  return { k: key, abs: kcs.position === "absolute" || kcs.position === "fixed", x: Math.round(b.x), y: Math.round(b.y) };' +
    '}) : [];' +
    'return { w: Math.round(r.width), h: Math.round(r.height), ow: el.offsetWidth, oh: el.offsetHeight, parentH: p ? p.offsetHeight : 0, sibs: sibs };' +
  '})()');
}

/** hover 后复量，返回布局是否变化（R10：hover 不许改变布局，只许改颜色/阴影）。 */
async function hoverDelta(ctx, id, before) {
  const after = await hoverSnapshot(ctx, id);
  if (!after || !before) return null;
  const issues = [];
  if (Math.abs(after.ow - before.ow) > 1 || Math.abs(after.oh - before.oh) > 1) {
    issues.push('element ' + before.ow + 'x' + before.oh + ' -> ' + after.ow + 'x' + after.oh);
  }
  /* 按稳定 key 比较（hover 时可能挂出 tooltip/浮层，按 HTMLCollection 下标会整体后移 => 假位移） */
  const afterByKey = new Map(after.sibs.map((x) => [x.k, x]));
  for (const a of before.sibs) {
    const b = afterByKey.get(a.k);
    if (!b || a.abs || b.abs) continue;
    if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) { issues.push('sibling ' + a.k + ' moved (' + a.x + ',' + a.y + ')->(' + b.x + ',' + b.y + ')'); break; }
  }
  if (issues.length) return issues.join('; ');
  return null;
}

/** 键盘 Tab 之后读当前焦点元素：焦点环是否被 overflow:hidden 的祖先裁掉。 */
/** 收集可聚焦元素（按类名去重，取每类第一个），用于穷举焦点环。 */
async function collectFocusables(ctx, limit) {
  return ctx.evalJs('(function (limit, multi) {' +
    'var sel = \'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"]\';' +
    'var roots = [document.querySelector(".settings-content"), document.querySelector("main"), document.querySelector(".modal-editor"), document.querySelector(".task-center-panel"), document.querySelector(".app-content")].filter(Boolean);' +
    'if (!roots.length) roots = [document];' +
    'var nodes = [];' +
    'for (var ri = 0; ri < roots.length; ri++) nodes = nodes.concat(Array.prototype.slice.call(roots[ri].querySelectorAll(sel)));' +
    'var seen = {}; var out = [];' +
    'for (var i = 0; i < nodes.length; i++) {' +
    '  var el = nodes[i];' +
    '  if (el.disabled) continue;' +
    '  var r = el.getBoundingClientRect();' +
    '  if (r.width < 8 || r.height < 8) continue;' +
    '  if (el.closest(".sidebar") || el.closest(".titlebar")) continue;' +
    '  /* 活内容（计时器/状态条每秒重渲染）会自己挪位置，不是 hover 引起的 */' +
    '  if (el.closest(".run-status-bar") || el.closest(".thinking-indicator") || el.closest("[class*=elapsed]") || el.closest("[class*=timer]") || el.closest(".lo-task__clock")) continue;' +
    '  var cls = (el.className || "").toString().trim().split(/\\s+/).slice(0, 2).join(".");' +
'  var txt = (el.innerText || el.getAttribute("aria-label") || "").trim();' +
'  var tb = txt ? (txt.length >= 14 ? "L" : txt.length >= 6 ? "M" : "S") : "0";' +
'  var multiVariants = multi ? "|" + (el.disabled ? "d" : "e") + tb + "|" + (r.width >= 220 ? "w3" : r.width >= 120 ? "w2" : "w1") : "";' +
    'var key = (cls || (el.tagName + "|" + (el.getAttribute("role") || ""))) + multiVariants;' +
    '  if (seen[key]) continue; seen[key] = 1;' +
    '  el.setAttribute("data-lo-focus", String(out.length));' +
    '  out.push({ id: out.length, ident: (el.tagName || "").toLowerCase() + "." + cls, label: (el.innerText || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 18) });' +
    '  if (out.length >= limit) break;' +
    '}' +
    'return out;' +
  '})(' + JSON.stringify(limit) + ', ' + JSON.stringify(MULTI) + ')');
}

/** 聚焦某个探针元素（返回是否成功）。 */
async function focusTarget(ctx, id) {
  return ctx.evalJs('(function () {' +
    'var el = document.querySelector(\'[data-lo-focus="' + id + '"]\');' +
    'if (!el) return false; el.focus(); return document.activeElement === el;' +
  '})()');
}

async function focusRingInfo(ctx) {
  return ctx.evalJs('(function () {' +
    'var el = document.activeElement;' +
    'if (!el || el === document.body || el === document.documentElement) return null;' +
    'var cs = getComputedStyle(el);' +
    'var ow = parseFloat(cs.outlineWidth) || 0;' +
    'var oo = parseFloat(cs.outlineOffset) || 0;' +
    'var ancShadow = false; var pa0 = el.parentElement;' +
    'for (var d0 = 0; d0 < 3 && pa0; d0++, pa0 = pa0.parentElement) { if (getComputedStyle(pa0).boxShadow !== "none") { ancShadow = true; break; } }' +
    'if ((ow === 0 || cs.outlineStyle === "none") && cs.boxShadow === "none") return { hasRing: false, ancestorShadow: ancShadow };' +
    'if (cs.outlineStyle === "none") return { hasRing: false, inset: cs.boxShadow !== "none", ancestorShadow: ancShadow };' +
    'var r = el.getBoundingClientRect();' +
    '/* 视口外（滚动容器里被 focus() 带到的元素）不判“环被裁”：看不到的元素谈不上可见性 */' +
    'if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return { hasRing: true, clipped: false, offscreen: true };' +
    'var ring = { l: r.left - ow - oo, t: r.top - ow - oo, r: r.right + ow + oo, b: r.bottom + ow + oo };' +
    'var a = el.parentElement;' +
    'while (a && a !== document.body) {' +
    '  var acs = getComputedStyle(a);' +
    '  var hidden = acs.overflow === "hidden" || acs.overflowX === "hidden" || acs.overflowY === "hidden";' +
    '  if (hidden) {' +
    '    var ar = a.getBoundingClientRect();' +
    '    if (ring.l < ar.left - 1.5 || ring.t < ar.top - 1.5 || ring.r > ar.right + 1.5 || ring.b > ar.bottom + 1.5) {' +
    '      return { hasRing: true, clipped: true, by: String(a.className).slice(0, 40), ring: ring, box: { l: Math.round(ar.left), t: Math.round(ar.top), r: Math.round(ar.right), b: Math.round(ar.bottom) } };' +
    '    }' +
    '  }' +
    '  a = a.parentElement;' +
    '}' +
    'return { hasRing: true, clipped: false, outline: cs.outline, text: (el.innerText || el.getAttribute("aria-label") || "").slice(0, 24) };' +
  '})()');
}

/** 收集 hover 探针候选（按钮/卡片/链接，去重、限量）。 */
async function collectHoverTargets(ctx, limit) {
  return ctx.evalJs('(function (limit, multi) {' +
    'var sel = \'button, [role="button"], a, .settings-sidebar-item, .skin-card, .sp-mode-btn, .lo-session-card, .lo-scene-option, .market-skill-card, .setting-group\';' +
    'var roots = [document.querySelector(".settings-content"), document.querySelector("main"), document.querySelector(".modal-editor"), document.querySelector(".task-center-panel"), document.querySelector(".app-content")].filter(Boolean);' +
    'if (!roots.length) roots = [document];' +
    'var nodes = [];' +
    'for (var ri = 0; ri < roots.length; ri++) nodes = nodes.concat(Array.prototype.slice.call(roots[ri].querySelectorAll(sel)));' +
    'nodes = nodes.filter(function (n) { return !n.closest(".sidebar") && !n.closest(".titlebar") && !n.closest(".right-sidebar"); });' +
    'var seen = {}; var out = [];' +
    'for (var i = 0; i < nodes.length; i++) {' +
    '  var el = nodes[i];' +
    '  var r = el.getBoundingClientRect();' +
    '  if (r.width < 12 || r.height < 12 || r.top < 0 || r.top > window.innerHeight - 8) continue;' +
    '  var cs = getComputedStyle(el);' +
    '  if (cs.visibility === "hidden" || cs.pointerEvents === "none") continue;' +
'  var txt = (el.innerText || el.getAttribute("aria-label") || "").trim();' +
'  var tb = txt ? (txt.length >= 14 ? "L" : txt.length >= 6 ? "M" : "S") : "0";' +
'  var multiVariants = multi ? "|" + (el.disabled ? "d" : "e") + tb + "|" + (r.width >= 220 ? "w3" : r.width >= 120 ? "w2" : "w1") : "";' +
    'var key = ((el.className || "").toString().trim().split(/\\s+/).slice(0, 2).join(".") || (el.tagName + "|" + (el.getAttribute("role") || ""))) + multiVariants;' +
    '  if (seen[key]) continue;' +
    '  seen[key] = 1;' +
    '  el.setAttribute("data-lo-hover", String(out.length));' +
    '  out.push({ id: out.length, label: (el.innerText || el.getAttribute("aria-label") || el.tagName || "").replace(/\\s+/g, " ").trim().slice(0, 20), ident: (el.tagName || "").toLowerCase() + "." + String(el.className || "").split(" ")[0], x: r.left + r.width / 2, y: r.top + r.height / 2 });' +
    '  if (out.length >= limit) break;' +
    '}' +
    'return out;' +
  '})(' + JSON.stringify(limit) + ', ' + JSON.stringify(MULTI) + ')');
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

/** 等审批面板出现（真实模型回合，最长 150s）。 */
async function waitApproval(ctx, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const open = await ctx.evalJs('(function () { var panels = Array.prototype.slice.call(document.querySelectorAll(".inline-diff-review, .permission-overlay")); return panels.some(function (el) { return el.getBoundingClientRect().height > 0; }); })()');
    if (open) return true;
    await sleep(600);
  }
  return false;
}

/**
 * 切换安全模式并**验证生效**（按钮文案就是当前模式）。
 * 为什么需要重试：菜单是异步渲染的，流式回合期间还会被重渲染；一次点击不保证成功。
 */
/** 用真实键盘事件按 Enter（页面内合成 KeyboardEvent 在部分状态下不触发提交）。 */
async function pressEnter(ctx) {
  await ctx.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await ctx.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** 往 composer 写文字并回车；返回用户气泡是否真的多了一条。 */
async function sendPrompt(ctx, text) {
  const before = await ctx.evalJs('document.querySelectorAll(".message-bubble.user").length');
  /* 注意：这里必须用 **Node 侧字符串拼接** 注入 prompt。把 " + JSON.stringify(text) + " 写进
     evalJs 的单引号串里，页面会把这段当字面量（实测提示词里出现了 "JSON.stringify(text) +"）。 */
  const set = await ctx.evalJs(
    "(function (text) { var el = document.querySelector('.message-input'); if (!el) return false; " +
    "var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; " +
    "setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); return true; })(" +
    JSON.stringify(text) + ")",
  );
  if (!set) return false;
  await sleep(300);
  const clicked = await ctx.evalJs('(function () { var b = document.querySelector(".send-btn:not(.cancel-btn)"); if (!b || b.disabled) return false; b.click(); return true; })()');
  if (!clicked) await pressEnter(ctx);
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const now = await ctx.evalJs('document.querySelectorAll(".message-bubble.user").length');
    if (now > before) return true;
  }
  return false;
}

/** 等回合结束（运行状态条/思考指示消失）。 */
async function waitTurnIdle(ctx, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const busy = await ctx.evalJs('!!document.querySelector(".run-status-bar") || !!document.querySelector(".thinking-indicator")');
    if (!busy) return true;
    await sleep(700);
  }
  return false;
}

/** 等某个面板出现（可见高度 > 0）。 */
async function waitPanel(ctx, selectors, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const open = await ctx.evalJs("(function () { var ps = Array.prototype.slice.call(document.querySelectorAll(" + JSON.stringify(selectors) + ")); return ps.some(function (el) { return el.getBoundingClientRect().height > 0; }); })()");
    if (open) return true;
    await sleep(500);
  }
  return false;
}

/** 场景过程中的截图（snap 在场景闭包内，prepare 阶段还不能用）。 */
async function saveShot(ctx, name) {
  if (!SHOTS) return;
  try {
    const r = await ctx.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(path.dirname(OUT_DIR), "shots", name + ".png");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  } catch { /* 截不到不影响审计 */ }
}

async function setSecurityMode(ctx, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ctx.evalJs('(function () { var b = document.querySelector(".security-mode-btn"); return b ? (b.innerText || "").trim() : ""; })()');
    if (current === label) return true;
    await ctx.evalJs('(function () { var b = document.querySelector(".security-mode-btn"); if (b) b.click(); return !!b; })()');
    await sleep(500);
    const clicked = await ctx.evalJs('(function (label) { var items = Array.prototype.slice.call(document.querySelectorAll(".bottom-bar-dropdown-item")); var it = items.find(function (x) { var t = (x.textContent || "").trim(); return t === label; }); if (it) { it.click(); return true; } return false; })(' + JSON.stringify(label) + ')');
    await sleep(500);
    if (clicked) return true;
  }
  return false;
}

/**
 * 审批场景收尾：点批准（若还开着）→ 恢复「完全访问」→ 删探针文件。
 * 失败路径也必须调用：安全模式是**持久化设置**，留在「请求批准」会改变后续所有回合的行为。
 */
async function cleanupApproval(ctx) {
  /* 先批准（若面板还开着），再等回合结束——流式期间菜单会被重渲染，切换容易失败 */
  await ctx.evalJs('(function () { var panels = Array.prototype.slice.call(document.querySelectorAll(".inline-diff-review, .permission-overlay")).filter(function (el) { return el.getBoundingClientRect().height > 0; }); var p = panels[panels.length - 1]; if (!p) return false; var b = Array.prototype.slice.call(p.querySelectorAll("button")).find(function (x) { return /批准/.test(x.textContent || ""); }); if (b) b.click(); return !!b; })()');
  /* 等回合真正结束：本轮实测「停止按钮」并不存在（控制按钮在别处），
     可靠信号是运行状态条 .run-status-bar；期间若又弹出审批（同一回合的第二次写入）就继续批准。 */
  for (let i = 0; i < 150; i++) {
    await ctx.evalJs('(function () { var panels = Array.prototype.slice.call(document.querySelectorAll(".inline-diff-review, .permission-overlay")).filter(function (el) { return el.getBoundingClientRect().height > 0; }); var p = panels[panels.length - 1]; if (!p) return false; var b = Array.prototype.slice.call(p.querySelectorAll("button")).find(function (x) { return /批准/.test(x.textContent || ""); }); if (b) b.click(); return !!b; })()');
    const busy = await ctx.evalJs('!!document.querySelector(".run-status-bar") || !!document.querySelector(".thinking-indicator")');
    if (!busy) break;
    await sleep(1000);
  }
  const restored = await setSecurityMode(ctx, "完全访问");
  if (!restored) console.log("   ⚠️ 安全模式未能恢复为「完全访问」，请手动检查");
  try { fs.unlinkSync(APPROVAL_PATH); } catch { /* ignore */ }
}

let CURRENT_SPECIAL = null;
let SKIP_SCENE = false;
const results = [];
let scenes = SCENES;
if (!REAL_MODEL) scenes = scenes.filter((s) => !["approval", "tool-error", "abort", "tool-confirm"].includes(s.special));
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

  if (scene.special === "tool-error") {
    await sendPrompt(ctx, "请用 read 工具读取 /tmp/lo-missing-" + Date.now() + ".txt，把内容原样告诉我。只做这一步，不要调用别的工具。");
    await waitTurnIdle(ctx, 120000);
  } else if (scene.special === "abort") {
    const started = await sendPrompt(ctx, "请从 1 数到 5000，每个数字单独占一行，只输出数字，不要调用任何工具。");
    const running = started && (await waitPanel(ctx, ".run-status-bar", 20000));
    if (running) {
      const v1 = (await measure(ctx)) ?? [];
      results.push({ scene: 'dialog-abort::streaming', navOk: true, steps: stepResults, violations: v1, profile: null });
      const c1 = v1.reduce((a, v) => ((a[v.rule] = (a[v.rule] ?? 0) + 1), a), {});
      console.log('dialog-abort::streaming'.padEnd(34), JSON.stringify(c1));
      await saveShot(ctx, 'dialog-abort-streaming');
      await evalJs(ctx, `(function () { var b = document.querySelector(".cancel-btn"); if (b) b.click(); return !!b; })()`);
      await waitTurnIdle(ctx, 60000);
    } else {
      results.push({ scene: 'dialog-abort:not-running', navOk: false, steps: stepResults, violations: [], note: 'turn did not start' });
    }
  } else if (scene.special === "tool-confirm") {
    await setSecurityMode(ctx, "请求批准");
    const sent = await sendPrompt(ctx, "请运行命令 rm -rf /tmp/lo-nonexistent-probe-" + Date.now() + "，只做这一步。");
    const seen = sent && (await waitPanel(ctx, ".permission-overlay, .inline-diff-review", 90000));
    if (!seen) {
      await waitTurnIdle(ctx, 60000);
      await setSecurityMode(ctx, "完全访问");
      results.push({ scene: 'dialog-tool-confirm', navOk: false, steps: stepResults, violations: [], note: 'no confirmation panel for dangerous command' });
      SKIP_SCENE = true;
    }
  } else if (scene.special === "approval") {
    /* 顺序很重要：必须先把安全模式切到「请求批准」，否则消息发出去时是「完全访问」，
       写入会被直接执行、永远看不到审批面板（第一次跑 NO-PANEL 就是这个原因）。 */
    const askOk = await setSecurityMode(ctx, "请求批准");
    if (!askOk) {
      results.push({ scene: "dialog-approval", navOk: false, steps: stepResults, violations: [], note: "security mode switch failed" });
      console.log("dialog-approval".padEnd(34), "MODE-SWITCH-FAILED");
      await cleanupApproval(ctx);
      continue;
    }
    fs.mkdirSync(APPROVAL_WORKSPACE, { recursive: true });
    const oldValue = "old-" + Date.now();
    const newValue = "new-layout-probe-" + Date.now();
    fs.writeFileSync(APPROVAL_PATH, oldValue + "\n", "utf8");
    const prompt = "请用 write 工具把工作区根目录 " + APPROVAL_FILE + " 的内容改成 " + newValue + "（覆盖原文件，原内容 " + oldValue + "）。只做这一步。";
    await ctx.evalJs('(function (text) {' +
      'var el = document.querySelector(".message-input"); if (!el) return false;' +
      'var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;' +
      'setter.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); el.focus(); return true;' +
    '})(' + JSON.stringify(prompt) + ')');
    await sleep(250);
    await pressEnter(ctx);
  }
  /* 浮层场景：需要“打开某个菜单”的动作（不是按文字点按钮） */
  if (scene.special === "approval") {
    /* 只等面板：模式切换与发消息都在 prepare 里（见那里的顺序注释） */
    if (!(await waitApproval(ctx, 150000))) {
      results.push({ scene: 'dialog-approval', navOk: false, steps: stepResults, violations: [], note: 'approval panel not shown (check API key / prompt)' });
      console.log('dialog-approval'.padEnd(34), 'NO-PANEL');
      await cleanupApproval(ctx);
      continue;
    }
  } else if (scene.special === "model-menu") {
    await evalJs(ctx, `(function () { var b = document.querySelector(".model-selector-inline"); if (b) b.click(); return !!b; })()`);
    await sleep(700);
  } else if (scene.special === "slash-menu") {
    await evalJs(ctx, `(function () { var t = document.querySelector(".message-input"); if (t) { t.focus(); return true; } return false; })()`);
    await sleep(200);
    await ctx.send("Input.insertText", { text: "/" });
    await sleep(700);
  } else if (scene.special === "session-menu") {
    const pt = await evalJs(ctx, `(function () { var el = document.querySelector(".sidebar-session"); if (!el) return null; var r = el.getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`);
    if (pt) {
      await ctx.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "right", buttons: 2, clickCount: 1 });
      await ctx.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "right", buttons: 0, clickCount: 1 });
      await sleep(700);
    }
  }

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
    CURRENT_SPECIAL = scene.special ?? null;
    /* 页面可能刚被外部重建/导航打断（dist 换了 hash）——先确保测量函数在，再量 */
    await ensureMeasure();
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


/*
 * 状态探测：子页签 → hover 位移 → Tab 焦点环。
 * 每种状态都单独记一条结果，报告里能看出是「哪个页签 / 哪个控件」出的问题。
 */
/**
 * 详情/二级面板：点开列表里的第一张卡，量「详情态」。
 * 之前只量列表态，详情里的字段行/操作条从来没进过判据。
 */
async function probeDetail(sceneName, record, stepResults) {
  const clicked = await ctx.evalJs('(function () {' +
    'var sel = ".market-skill-card, .mcp-server-row, .memory-item, .notebook-card, .agent-card, .skill-card, .plugin-card, .lo-session-card";' +
    'var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));' +
    'for (var i = 0; i < nodes.length; i++) {' +
    '  var el = nodes[i]; var r = el.getBoundingClientRect();' +
    '  if (r.width < 60 || r.height < 24) continue;' +
    '  if (r.top < 0 || r.top > window.innerHeight) continue;' +
    '  el.click();' +
    '  return { cls: String(el.className).slice(0, 40), text: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 16) };' +
    '}' +
    'return null;' +
  '})()');
  if (!clicked) return;
  await sleep(900);
  await record(sceneName + '::detail');
}

async function probeStates(sceneName, record, stepResults) {
  if (SUBSTATES && CURRENT_SPECIAL !== "approval" && CURRENT_SPECIAL !== "tool-confirm" && CURRENT_SPECIAL !== "abort") {
    const tabs = (await collectSubstates(ctx)) ?? [];
    if (VERBOSE) console.log('   sub-tabs=' + tabs.length);
    for (const tab of tabs) {
      const ok = await clickSubstate(ctx, tab.id);
      if (!ok) continue;
      await sleep(800);
      await record(sceneName + '::tab:' + tab.label);
    }
  }
  if (HOVER) {
    await sleep(300); // 等页面稳定，避免把“刚挂载”的位移记成 hover 位移
    const targets = (await collectHoverTargets(ctx, HOVER_MAX)) ?? [];
    if (VERBOSE) console.log('   hover targets=' + targets.length);
    const bad = [];
    for (const t of targets) {
      let before = await hoverSnapshot(ctx, t.id);
      const again = await hoverSnapshot(ctx, t.id);
      if (JSON.stringify(before) !== JSON.stringify(again)) { await sleep(250); before = await hoverSnapshot(ctx, t.id); }
      await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(t.x), y: Math.round(t.y) });
      await sleep(120);
      const delta = await hoverDelta(ctx, t.id, before);
      await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
      if (delta) {
        /* 复现一次再记：hover 恰好撞上挂载/动画时会误报（实测：tooltip / 列表挂载） */
        await sleep(200);
        const before2 = await hoverSnapshot(ctx, t.id);
        await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(t.x), y: Math.round(t.y) });
        await sleep(150);
        const delta2 = await hoverDelta(ctx, t.id, before2);
        await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
        if (delta2) {
          bad.push({ rule: 'R10', selector: sceneName + ' :: ' + t.label + ' [' + t.ident + ']', detail: 'hover 改变布局：' + delta + ' / 复现：' + delta2, text: t.label });
        }
      }
    }
    if (bad.length) {
      results.push({ scene: sceneName + '::hover', navOk: true, steps: stepResults, violations: bad, profile: null });
      const counts = {};
      for (const v of bad) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
      console.log((sceneName + '::hover').padEnd(34), JSON.stringify(counts));
      if (VERBOSE) for (const v of bad) console.log('   ' + v.rule + ' ' + v.selector + ' — ' + v.detail);
    }
  }
  if (FOCUS) {
    const bad = [];
    let checked = 0;
    /* 先按一次 Tab 进入键盘焦点模态，之后 focus() 才会命中 :focus-visible */
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(80);
    const targets = (await collectFocusables(ctx, FOCUS_MAX)) ?? [];
    if (VERBOSE) console.log('   focus targets=' + targets.length);
    for (const t of targets) {
      const ok = await focusTarget(ctx, t.id);
      if (!ok) continue;
      await sleep(40);
      const info = await focusRingInfo(ctx);
      if (info) checked++;
      /* 这两类焦点反馈画在祖先上（composer 靠 .input-area:has() 的边框、搜索框靠胶囊 :has 环），
         自身没有 outline/shadow 是设计，不算缺口 */
      const ringOnAncestor = /(^|\s)(message-input|sp-search-input)(\s|$)/.test(t.ident.split(".").slice(1).join("."));
      if (info && info.hasRing === false && !info.inset && !info.ancestorShadow && !ringOnAncestor) {
        bad.push({ rule: 'R13', selector: sceneName + ' :: focus [' + t.ident + ']', detail: '可聚焦元素既无 outline 也无 box-shadow（键盘焦点不可见）', text: t.label || t.ident });
      }
      if (info && info.clipped) {
        bad.push({ rule: 'R11', selector: sceneName + ' :: focus [' + t.ident + ']', detail: '焦点环被 ' + info.by + ' 裁掉（ring ' + JSON.stringify(info.ring) + ' vs box ' + JSON.stringify(info.box) + '）', text: t.label || info.by });
      }
    }
    if (VERBOSE) console.log('   focus checked=' + checked);
    if (bad.length) {
      results.push({ scene: sceneName + '::focus', navOk: true, steps: stepResults, violations: bad, profile: null });
      const counts = {};
      for (const v of bad) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
      console.log((sceneName + '::focus').padEnd(34), JSON.stringify(counts));
      if (VERBOSE) for (const v of bad) console.log('   ' + v.rule + ' ' + v.selector + ' — ' + v.detail);
    }
  }
}
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
      await probeStates(`${scene.name}:${label}`, record, stepResults);
      if (DETAIL && /^(manager-|taskcenter-)/.test(scene.name)) await probeDetail(`${scene.name}:${label}`, record, stepResults);
    }
  } else {
    if (SKIP_SCENE) { SKIP_SCENE = false; continue; }
    await record(scene.name);
    try {
      await probeStates(scene.name, record, stepResults);
    } finally {
      if (scene.special === "approval") await cleanupApproval(ctx);
      if (scene.special === "tool-confirm") {
        await evalJs(ctx, `(function () { var ps = Array.prototype.slice.call(document.querySelectorAll(".permission-overlay, .inline-diff-review")).filter(function (el) { return el.getBoundingClientRect().height > 0; }); var p = ps[ps.length - 1]; if (!p) return false; var b = Array.prototype.slice.call(p.querySelectorAll("button")).find(function (x) { return /拒绝/.test(x.textContent || ""); }); if (b) b.click(); return !!b; })()`);
        await waitTurnIdle(ctx, 120000);
        await setSecurityMode(ctx, "完全访问");
      }
    }
    if (DETAIL && /^(manager-|taskcenter-)/.test(scene.name)) await probeDetail(scene.name, record, stepResults);
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
