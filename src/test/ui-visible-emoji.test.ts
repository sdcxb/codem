/**
 * 可见 UI emoji 清零（第 18 轮）。
 *
 * 与 `ui-no-emoji` 的区别：那个是「全语料棘轮」，会把 console.log 里的 ✅ 也算进去，
 * 所以存量 233 行合法化后永远清不完。这里只审**真正渲染到界面**的字符串：
 * JSX 文本、JSX 表达式/属性里的字符串；console/log/diag 调用参数不算。
 *
 * 例外：身份头像 / 宠物内容允许 emoji（产品内容，不是 chrome）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { REPO_ROOT, surfaceFiles } from "./helpers/ui-text-scan";

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
/** 纯文本符号（不是 emoji）：状态用 ✓/✗/○ 由 StatusIcons 统一输出，门禁不把它们当 emoji。 */
const TEXT_GLYPHS = new Set(["✓", "✗", "○", "●", "→", "←"]);
function hasEmoji(text: string): boolean {
  return [...text].some((ch) => EMOJI_RE.test(ch) && !TEXT_GLYPHS.has(ch));
}
const ALLOW = new Set([
  "src/components/BootstrapWizard.tsx",
  "src/components/SettingsPanel.tsx",
  "src/components/ConfigEditor.tsx",
  "src/components/PetMarketDialog.tsx",
  "src/components/PetSprite.tsx",
  "src/components/PetErrorBoundary.tsx",
]);
const LOG_CALL = /^(console|log|warn|error|debug|diag|diagTrail|report)/;

function isLogCall(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && LOG_CALL.test(p.expression.text)) return true;
    p = p.parent;
  }
  return false;
}

function isInsideJsx(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if (ts.isJsxExpression(p) || ts.isJsxAttribute(p)) return true;
    if (ts.isCallExpression(p)) return false;
    p = p.parent;
  }
  return false;
}

function isDataOrClassAttr(node: ts.Node): boolean {
  const p = node.parent;
  if (!ts.isJsxAttribute(p)) return false;
  const name = p.name.getText();
  return name.startsWith("data-") || name === "className" || name === "style";
}

describe("可见 UI emoji 清零", () => {
  it("JSX 文本/属性/表达式里没有 chrome emoji（身份/宠物除外）", () => {
    const hits: string[] = [];
    const roots = [...surfaceFiles(), "src/App.tsx"];
    for (const rel of roots) {
      if (ALLOW.has(rel)) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !ts.isJsxText(node)) {
          if (isInsideJsx(node) && !isDataOrClassAttr(node) && !isLogCall(node) && hasEmoji(node.text)) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            hits.push(`${rel}:${line}  ${node.text.slice(0, 80)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      /**
       * App.tsx 的系统消息/宠物气泡不是 JSX 文本，而是字符串字面量；
       * 只扫 JSX 会漏掉它们。这里对 App 的字面量再扫一遍（console/log 参数除外）。
       */
      if (rel === "src/App.tsx") {
        const scanLiteral = (node: ts.Node): void => {
          if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && hasEmoji(node.text) && !isLogCall(node)) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            hits.push(`${rel}:${line}  ${node.text.slice(0, 80)}`);
          }
          if (ts.isTemplateExpression(node)) {
            for (const span of node.templateSpans) {
              if (hasEmoji(span.literal.text) && !isLogCall(node)) {
                const line = sf.getLineAndCharacterOfPosition(span.literal.getStart(sf)).line + 1;
                hits.push(`${rel}:${line}  ${span.literal.text.slice(0, 80)}`);
              }
            }
          }
          ts.forEachChild(node, scanLiteral);
        };
        scanLiteral(sf);
      }
    }
    expect(hits, `可见 chrome 里仍有 emoji（换成 lucide 或删掉）:\n  ${hits.join("\n  ")}`).toEqual([]);
  });
});
