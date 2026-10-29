/**
 * 冷启动主包：**不许**为了高亮一个代码块把 Prism 的**全部语言**打进主包
 * （第 233 轮审计 · P2 冷启动）。
 *
 * ## 缺陷形态
 *
 * `CodeBlockView` 原来这样引入：
 *
 * ```ts
 * import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
 * ```
 *
 * `Prism`（非 Light 版）在模块加载时就 `require` 了 **Prism 全语言包**
 * （200+ 语言，压缩前 ~1 MB），而它们被静态 import 进主 chunk ⇒ 首帧必须下载/解析。
 * 真机上主包 5.5 MB，这一条是其中最大的一块；而产品只用到二十来种语言。
 *
 * ## 修法
 *
 * 换 `PrismLight` + **显式注册**（`prism-languages.ts`）：注册几种就带几种。
 * 没注册的语言照旧渲染成纯文本（不报错、不空白）。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | COLD-1 | `CodeBlockView` 引的是 `PrismLight`（源码级：不许再出现裸 `Prism as`） |
 * | COLD-2 | 注册表覆盖产品实际会遇到的常见语言（ts/tsx/js/json/css/html/bash/py/rust/go/sql/yaml/md…） |
 * | COLD-3 | 已知语言仍能被高亮（反向对照：不许为了瘦身把高亮弄没） |
 * | COLD-4 | 未注册的语言只降级成纯文本、不抛（代码块永远要能显示） |
 *
 * 变异自证：把 import 改回 `Prism as SyntaxHighlighter` ⇒ COLD-1 红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { CodeBlockView } from "../components/rich-content/CodeBlockView";
import { PRISM_REGISTERED_LANGUAGES } from "../components/rich-content/prism-languages";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "src/components/rich-content/CodeBlockView.tsx"), "utf8");

describe("冷启动：代码高亮不许带全语言包", () => {
  it("COLD-1: 必须用 PrismLight（不许裸 Prism）", () => {
    expect(src, "CodeBlockView 必须引 PrismLight").toMatch(/PrismLight\s+as\s+SyntaxHighlighter/);
    expect(src, "不许再引全量 Prism（它会把 200+ 语言打进主包）").not.toMatch(/\{\s*Prism\s+as\s+SyntaxHighlighter\s*\}/);
  });

  it("COLD-2: 注册表覆盖常见语言", () => {
    for (const lang of [
      "typescript",
      "tsx",
      "javascript",
      "jsx",
      "json",
      "css",
      "markup",
      "bash",
      "powershell",
      "python",
      "rust",
      "go",
      "java",
      "c",
      "cpp",
      "sql",
      "yaml",
      "markdown",
    ]) {
      expect(PRISM_REGISTERED_LANGUAGES, `少了 ${lang}（真机代码块会退化成纯文本）`).toContain(lang);
    }
  });

  it("COLD-3（反向对照）: 已知语言仍然被高亮", () => {
    const { container } = render(<CodeBlockView code={"const a: number = 1;"} language="typescript" />);
    expect(container.querySelector("pre"), "代码块必须渲染出来").toBeTruthy();
    // Prism 的行内 token（关键字/数字）至少命中一个
    expect(container.querySelectorAll("span.token").length, "已知语言必须仍有 token 高亮").toBeGreaterThan(0);
  });

  it("COLD-4: 未注册语言降级成纯文本、不抛", () => {
    const { container } = render(<CodeBlockView code={"whatever"} language="brainfuck" />);
    expect(container.querySelector("pre")?.textContent ?? "").toContain("whatever");
  });
});

/**
 * 冷启动（续）：**点开才用的模态面板不许静态进主包**。
 *
 * 实测：`SettingsPanel` 单独一个 chunk = **298 KB**，把它（连同另外三个模态面板）
 * 改成 `lazy()` 之后主包从 **4.76 MB → 4.35 MB**（`vite build` 实测）。
 *
 * 判据只能钉**源码接线**（构建产物不在 vitest 里）：静态 import 一旦回来,
 * 主包立刻涨回去，而这条判据会当场红。
 */
describe("冷启动：模态面板按需加载", () => {
  const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");

  it("COLD-5: 四个模态面板必须是 lazy()，不许静态 import", () => {
    for (const name of ["SettingsPanel", "ProjectManager", "ConfigEditor", "McpManager"]) {
      expect(app, `${name} 不许再静态 import（会把整个面板塞进主包）`).not.toMatch(
        new RegExp(`import \\{ ${name} \\} from "\\./components/${name}"`),
      );
      expect(app, `${name} 必须走 lazy(() => import(...))`).toMatch(
        new RegExp(`lazy\\(\\(\\) =>\\s*\\n?\\s*import\\("\\./components/${name}"\\)`),
      );
    }
  });

  it("COLD-6: lazy 组件外面必须有 Suspense 边界（否则整棵树被挂起）", () => {
    expect(app, "缺 Suspense 边界 ⇒ 打开设置会白屏").toContain("<Suspense fallback={null}>");
    // 用到了 lazy 组件的那一段必须在 Suspense 之内（粗粒度但能挡住"忘了包"）
    const suspenseStart = app.indexOf("<Suspense fallback={null}>");
    const settingsUsage = app.indexOf("fallback={SettingsPanelLazy}");
    const suspenseEnd = app.indexOf("</Suspense>", suspenseStart);
    expect(suspenseStart, "找不到 Suspense 边界").toBeGreaterThan(-1);
    expect(settingsUsage, "找不到 SettingsPanelLazy 的用法").toBeGreaterThan(suspenseStart);
    expect(suspenseEnd, "Suspense 没闭合").toBeGreaterThan(settingsUsage);
  });
});
