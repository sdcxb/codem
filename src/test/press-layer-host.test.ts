/**
 * 「浮层宿主不参与几何按压反馈」契约（第 82 波，用户报的真 bug）
 *
 * 真实事故：主对话区域顶部的模型列表里，点「推理强度」闪烁、选不中。实测（打包版本 + CDP 真实鼠标事件）：
 *
 *   按下 → pointerdown/mousedown 命中 `new-chat-page`（浮层被盖住了）
 *   松手 → mouseup 命中 `chat-effort-row`（又回来了）
 *   期间 DOM 零变更
 *
 * 根因：全局按压反馈给通用可点元素加 `transform`，而 `transform` 会**创建层叠上下文**；
 * 聊天栏的模型下拉正是 `<div class="model-selector" role="button">` 内部渲染 `.model-picker` ——
 * 按住时浮层的 z-index 退化成局部的，被兄弟节点（`.chat-body`）盖住；mousedown 与 mouseup
 * 命中不同元素 → 浏览器把 click 派发到**共同祖先** → 选项的 onClick 不执行。
 *
 * 这份用例守两条：
 *   ① CSS 契约：通用按压反馈规则必须排除 `.press-layer-host`，且宿主有非几何的按压反馈；
 *   ② 结构契约：全项目扫一遍 TSX —— 只要可点元素内部渲染了浮层，就必须标 `.press-layer-host`。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 浮层（下拉/菜单）类名：token 精确匹配，避免把 `bottom-bar-dropdown-item` 这类**菜单项本身**误判 */
const LAYER_TOKENS = new Set([
  "popover-shell", "popover-shield", "model-picker", "chat-effort-menu", "bottom-bar-dropdown",
  "dropdown-menu", "dropdown-menu-content", "context-menu", "skill-picker-popup", "file-link-context-menu",
  "input-popover", "app-menu-surface", "kg-menu", "slash-command-menu", "slash-menu-portal",
  "chat-dropdown--sessions", "git-branch-dropdown", "nb-export-menu", "nb-move-menu", "nb-studio-dropdown",
  "right-rail-add-menu", "sidebar-project-more-menu", "sidebar-session-context-menu", "space-switcher-dropdown",
  "tj-filter-menu", "regenerate-popover", "prompt-draft-picker", "issue-detail-picker", "modal-overlay",
  "alert-dialog-content", "toolbar-menu", "menu-panel",
]);

function listTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "target", "__snapshots__", ".git", "test"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listTsx(full, out);
    else if (extname(entry) === ".tsx") out.push(full);
  }
  return out;
}

function classNameOf(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  const attr = opening.attributes?.properties?.find(
    (a) => ts.isJsxAttribute(a) && a.name.getText() === "className",
  );
  if (!attr?.initializer) return "";
  return attr.initializer.getText().replace(/[`"'{}]/g, " ");
}

interface HostFinding { file: string; line: number; host: string; layers: string[] }

/** 找出"内部渲染浮层但没标 .press-layer-host"的可点元素 */
function findUnmarkedLayerHosts(): HostFinding[] {
  const out: HostFinding[] = [];
  for (const file of listTsx(join(ROOT, "src"))) {
    const src = readFileSync(file, "utf8");
    if (!/role="button"|<button|clickable/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText();
        const isRoleButton = (opening.attributes?.properties || []).some(
          (a) => ts.isJsxAttribute(a) && a.name.getText() === "role" && a.initializer?.getText().includes("button"),
        );
        if (tag === "button" || isRoleButton || /\bclickable\b/.test(classNameOf(opening))) {
          const found = new Set<string>();
          const collect = (n: ts.Node) => {
            if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
              const op = ts.isJsxElement(n) ? n.openingElement : n;
              if (op !== opening) {
                for (const tok of classNameOf(op).split(/[\s`${}]+/).filter(Boolean)) {
                  if (LAYER_TOKENS.has(tok)) found.add(tok);
                }
              }
            }
            ts.forEachChild(n, collect);
          };
          ts.forEachChild(node, collect);
          if (found.size && !/\bpress-layer-host\b/.test(classNameOf(opening))) {
            out.push({
              file: relative(ROOT, file).replace(/\\/g, "/"),
              line: sf.getLineAndCharacterOfPosition(opening.getStart()).line + 1,
              host: tag,
              layers: [...found],
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe("浮层宿主与按压反馈的契约", () => {
  it("PLH-1: 通用按压反馈规则必须排除 .press-layer-host（否则浮层会被压进局部层叠上下文）", () => {
    const css = read("src/styles.css");
    // 抓所有「通用可点元素 + :active + 几何 transform」的规则，逐条要求带排除
    const offenders: string[] = [];
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, " ").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector, body] = m;
      if (!/:active/.test(selector)) continue;
      if (!/transform:\s*(scale|translate|matrix|rotate|skew)/.test(body)) continue;
      for (const part of selector.split(",")) {
        const sel = part.trim();
        if (!/\bbutton\b|\[role=["']?button["']?\]|\.clickable\b/.test(sel)) continue;
        if (!/press-layer-host/.test(sel)) offenders.push(sel);
      }
    }
    expect(offenders, `这些通用按压规则没排除浮层宿主：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("PLH-2: 宿主必须有非几何的按压反馈（退出 transform 不等于没有手感）", () => {
    const css = read("src/styles.css");
    const rule = /\.press-layer-host:active\s*\{([^}]*)\}/.exec(css);
    expect(rule, ".press-layer-host:active 反馈规则不见了").toBeTruthy();
    expect(rule![1]).not.toMatch(/transform\s*:/);
    expect(rule![1]).toMatch(/background\s*:/);
  });

  it("PLH-3: 全项目没有『内部有浮层却没标宿主类』的可点元素（本次事故的两处必须已标）", () => {
    const findings = findUnmarkedLayerHosts();
    const text = findings.map((f) => `${f.file}:${f.line} <${f.host}> → ${f.layers.join(",")}`).join("\n");
    expect(findings, `这些可点元素内部渲染了浮层却没标 .press-layer-host：\n${text}`).toEqual([]);

    // 反向确认扫描真的覆盖到了本次事故现场（不是"扫了个空集"的假绿）
    const chatPanel = read("src/components/ChatPanel.tsx");
    expect(chatPanel).toMatch(/className="model-selector press-layer-host"/);
    expect(chatPanel).toMatch(/className="chat-effort-row press-layer-host"/);
  });

  it("PLH-4: 审计脚本里确实有这两条规则（门禁不能被静默删掉）", () => {
    const audit = read("tools/ui-audit/scan-ui.mjs");
    expect(audit).toContain("press-feedback-layer-host");
    expect(audit).toContain("press-transform-hosts-layer");
    expect(audit).toMatch(/scanPressFeedbackLayerHost\(rel, src\)/);
    expect(audit).toMatch(/scanPressLayerHosts\(rel, src\)/);
  });

  it("PLH-5: 聊天栏模型下拉确实是『浮层渲染在 role=button 内部』这个结构（回归时提醒为什么需要宿主类）", () => {
    const chatPanel = read("src/components/ChatPanel.tsx");
    const selectorIdx = chatPanel.indexOf('className="model-selector press-layer-host"');
    const pickerIdx = chatPanel.indexOf('className="model-picker"');
    expect(selectorIdx).toBeGreaterThan(-1);
    expect(pickerIdx).toBeGreaterThan(selectorIdx);
  });
});
