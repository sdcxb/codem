/**
 * 第 183 波：工具结果的**结构化诊断**（对标 Pi 的 `ToolDiagnostic` + `<harness>` 渲染）。
 *
 * ## 为什么要有这组判据
 *
 * 改前截断/分页是一条**看起来像正文**的括号文本
 * （`... (showing lines 1-2, more lines available; use offset to continue reading)`），
 * 而 `read` 的输出外面还裹着"这是待分析数据"的边界框 ⇒ 模型很难分辨
 * "这是文件里的字"与"这是系统在说『你只看到了一部分』"。
 *
 * 现在做成结构化诊断再渲染成带标记的块。这组判据守四件事：
 *  1. 形态固定（`<harness>` + `[severity] message`）；
 *  2. 数字**精确**（来自 Rust 侧同一次扫描）；
 *  3. **真的截断才渲染** —— 没截断却报截断，与截断却不说一样是失真；
 *  4. 拿不到精确数字时（legacy 路径）**只说知道的**，不许编。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendDiagnostics,
  pagedDiagnostic,
  renderDiagnostics,
  truncatedDiagnostic,
  type ToolDiagnostic,
} from "../core/llm/tool-diagnostics";

describe("第 183 波 · 结构化诊断（DIAG）", () => {
  it("DIAG-1: 截断诊断带精确数字，且形态与上游一致（`N lines / M chars dropped`）", () => {
    const d = truncatedDiagnostic(3, 18, 100);
    expect(d.severity).toBe("warn");
    expect(d.code).toBe("truncated");
    // 逐字断言整句 —— 数字口径与措辞都是契约的一部分
    expect(d.message).toBe(
      "Output truncated: 3 lines / 18 chars dropped (file has 100 lines). Use offset to continue reading.",
    );
    // 保留尾部（丢了开头）时，措辞与上游 `truncated to its end` 对齐
    expect(truncatedDiagnostic(1, 2, 3, "end").message).toContain("Output truncated to its end:");
  });

  it("DIAG-2: 渲染成 `<harness>` 块（每条一行，带 severity 前缀）", () => {
    expect(renderDiagnostics([truncatedDiagnostic(1, 2, 3)])).toBe(
      "<harness>\n[warn] Output truncated: 1 lines / 2 chars dropped (file has 3 lines). Use offset to continue reading.\n</harness>",
    );
    expect(renderDiagnostics([{ severity: "info", code: "x", message: "hi" }])).toBe("<harness>\n[info] hi\n</harness>");
  });

  it("DIAG-3: **没截断就不许渲染**（空诊断 ⇒ 空串，正文一个字符都不动）", () => {
    const body = "1: hello\n2: world";
    expect(renderDiagnostics([])).toBe("");
    expect(renderDiagnostics(undefined)).toBe("");
    expect(appendDiagnostics(body, [])).toBe(body);
    expect(appendDiagnostics(body, undefined)).toBe(body);
    // 有诊断时才追加，且接在正文之后（换行分隔）
    expect(appendDiagnostics(body, [pagedDiagnostic(1, 2)])).toBe(`${body}\n<harness>\n[warn] ${pagedDiagnostic(1, 2).message}\n</harness>`);
  });

  it("DIAG-4: 分页诊断**只说知道的**（legacy 路径拿不到总行数与丢弃量 ⇒ 不编数字）", () => {
    const d = pagedDiagnostic(10, 20);
    expect(d.code).toBe("paged");
    expect(d.message).toBe("Only part of the file was returned (lines 10-20). Use offset to continue reading.");
    // 关键：**不许**出现确切的"丢了多少"（那会是个编出来的数）
    expect(d.message).not.toMatch(/dropped/);
  });

  describe("接进 read 工具之后（真机链路）", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("DIAG-5: Rust 分页路径把精确丢弃量做成 `truncated` 诊断，且模型可见文本里是 `<harness>` 块", async () => {
      const readFileLines = vi.fn(async () => ({
        text: "1: a\n2: b",
        totalLines: 5,
        hasMore: true,
        droppedLines: 3,
        droppedChars: 9,
      }));
      vi.doMock("../core/file-api", () => ({ readFileLines }));
      const mod: any = await import("../core/llm/tool-output-shapes");
      const rendered = mod.renderReadOutput({
        path: "big.log",
        content: "1: a\n2: b",
        diagnostics: [truncatedDiagnostic(3, 9, 5)],
      });
      expect(rendered).toContain("<harness>");
      expect(rendered).toContain("[warn] Output truncated: 3 lines / 9 chars dropped (file has 5 lines).");
      // 旧的括号文本不再出现（本次就是要换掉它）
      expect(rendered).not.toContain("... (showing lines");
      // 诊断在正文之后、结束框之前
      expect(rendered.indexOf("2: b")).toBeLessThan(rendered.indexOf("<harness>"));
      expect(rendered.indexOf("<harness>")).toBeLessThan(rendered.indexOf("数据结束"));
    });
  });
});
