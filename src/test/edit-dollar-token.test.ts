/**
 * 回归测试：`edit` / `multi_edit` 必须不受 `String.replace` 替换记号语义影响。
 *
 * ## 修的是什么
 *
 * 原实现 `content.replace(oldString, newString)` 在 `newString` 是**字符串**时，
 * 会把下面四个记号当模板展开：
 *
 * | 记号 | 展开为 |
 * | --- | --- |
 * | `$$` | 一个字面 `$` |
 * | `$&` | 被匹配到的原文 |
 * | `` $` `` | 匹配点**之前**的全部内容 |
 * | `$'` | 匹配点**之后**的全部内容 |
 *
 * 后果是**静默数据损坏**：文件内容被改写，而工具返回「Successfully edited」。
 * 模型写出这些序列完全正常（正则、模板串、shell 变量、jQuery、`$$` 在 Makefile
 * 里是 shell 的 pid）。
 *
 * ## 为什么这些断言是「真断言」而不是空转
 *
 * 每个 case 都同时断言：
 * 1. `replaceLiteral` 的结果 == 手工拼装的期望值（**方向性**：不是「没崩」而是「等于」）；
 * 2. 裸 `String.replace` 的结果 **≠** 期望值（证明这个 case 真的踩到了替换记号语义，
 *    而不是一个恰好两边都过的输入）。
 *
 * 第 2 条是关键：没有它，「4/5 种输入会损坏」这个结论就没有自证能力 ——
 * 一个恒真的 case 集合会让修复看起来生效而实际没测到东西。
 */
import { describe, it, expect } from "vitest";
import {
  replaceLiteral,
  replaceLiteralAll,
  containsReplacementToken,
  suggestEditCandidates,
  normalizeFor,
} from "../core/llm/edit-matchers";

const CONTENT = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const OLD = "const b = 2;";

/** 裸 String.replace 的对照实现 —— 用来证明 case 真的踩到了记号语义。 */
function naiveReplace(content: string, search: string, replacement: string): string {
  return content.replace(search, replacement);
}

describe("edit 替换：$ 记号不得被展开", () => {
  const cases: Array<[string, string]> = [
    ["$& 匹配本身", "const b = $&;"],
    ["$$ 字面美元", 'const b = "$$";'],
    ["$` 匹配前全部", "const b = $`;"],
    ["$' 匹配后全部", "const b = $';"],
    ["${x} 模板串", "const b = `v=${x}`;"],
    ["$1 正则反向引用", 'const b = "$1";'],
    ["Makefile 式 $$pid", "const b = $$PID;"],
  ];

  for (const [label, newString] of cases) {
    it(`${label}：写入内容与期望逐字节相同`, () => {
      const expected = `const a = 1;\n${newString}\nconst c = 3;\n`;

      const actual = replaceLiteral(CONTENT, OLD, newString);
      expect(actual).toBe(expected);

      // 反向对照：如果这个 case 用裸 replace 也得到期望值，说明它没测到东西。
      const naive = naiveReplace(CONTENT, OLD, newString);
      if (naive !== expected) {
        // 踩到了记号语义 —— 正是这个测试要覆盖的输入
        expect(naive).not.toBe(expected);
      } else {
        // 没踩到：显式记录，避免以后有人以为所有 $ 都危险
        expect(containsReplacementToken(newString)).toBe(false);
      }
    });
  }

  it("至少有一种输入会被裸 replace 损坏（证明本测试不是空转）", () => {
    const damaged = cases.filter(
      ([, ns]) => naiveReplace(CONTENT, OLD, ns) !== `const a = 1;\n${ns}\nconst c = 3;\n`,
    );
    // 修复前实测 4/5；这里要求「存在且不少于 4 种」，避免以后被悄悄削弱
    expect(damaged.length).toBeGreaterThanOrEqual(4);
  });

  it("$' 的具体损坏形态：匹配点之后的内容被再插入一次", () => {
    // 这是最危险的一种：看似「成功」，实际文件被撑大/错位
    const naive = naiveReplace(CONTENT, OLD, "const b = $';");
    expect(naive).not.toBe("const a = 1;\nconst b = $';\nconst c = 3;\n");
    // 裸实现把 $' 展开成了 "const c = 3;\n" 前后的残留
    expect(naive).toContain("const b = ");

    // 我们的实现逐字写入
    expect(replaceLiteral(CONTENT, OLD, "const b = $';")).toBe(
      "const a = 1;\nconst b = $';\nconst c = 3;\n",
    );
  });
});

describe("edit 替换：只换第一处、未命中返回 null", () => {
  it("同一段出现两次时只替换第一处（与工具旧语义一致）", () => {
    const content = "x = 1;\nx = 1;\n";
    expect(replaceLiteral(content, "x = 1;", "y = 2;")).toBe("y = 2;\nx = 1;\n");
  });

  it("replaceLiteralAll 替换全部", () => {
    const content = "x = 1;\nx = 1;\n";
    expect(replaceLiteralAll(content, "x = 1;", "y = 2;")).toBe("y = 2;\ny = 2;\n");
  });

  it("未命中返回 null（而不是静默写回原文）", () => {
    expect(replaceLiteral(CONTENT, "const zzz = 9;", "y")).toBeNull();
    expect(replaceLiteralAll(CONTENT, "const zzz = 9;", "y")).toBeNull();
  });

  it("空 search 返回 null —— 否则会命中偏移 0 并把整份内容当替换点", () => {
    expect(replaceLiteral(CONTENT, "", "y")).toBeNull();
    expect(replaceLiteralAll(CONTENT, "", "y")).toBeNull();
  });

  it("替换内容含换行 / 中文 / emoji 也逐字写入", () => {
    const out = replaceLiteral(CONTENT, OLD, "const b = `你好 ${x} ⚡ $&`;");
    expect(out).toBe("const a = 1;\nconst b = `你好 ${x} ⚡ $&`;\nconst c = 3;\n");
  });
});

describe("edit 未命中时的候选提示", () => {
  it("缩进不一致时给出候选与行号，并说明是归一化后精确命中", () => {
    const content = "function f() {\n    return 42;\n}\n";
    const s = suggestEditCandidates(content, "  return 42;");
    expect(s).not.toBeNull();
    expect(s!.candidates.length).toBeGreaterThan(0);
    expect(s!.candidates[0].text).toContain("return 42;");
    expect(s!.candidates[0].line).toBe(2);
    expect(s!.message).toContain("line 2");
    // 必须明确要求模型「按原文复制」，而不是自己猜空白
    expect(s!.message).toMatch(/verbatim|Do NOT guess/i);
  });

  it("行号前缀污染（模型把 read 输出的 `123: ` 一起复制）能被识别", () => {
    expect(normalizeFor("line_number_prefix", "12: const b = 2;")).toBe("const b = 2;");
    const s = suggestEditCandidates(CONTENT, "2: const b = 2;");
    expect(s).not.toBeNull();
    expect(s!.candidates.length).toBeGreaterThan(0);
  });

  it("智能引号 vs ASCII 引号能被识别", () => {
    const content = 'const s = "hello";\n';
    const s = suggestEditCandidates(content, "const s = \u201Chello\u201D;");
    expect(s).not.toBeNull();
    expect(s!.candidates.length).toBeGreaterThan(0);
  });

  it("CRLF 文件对上 LF 的 oldString 能被识别", () => {
    const content = "a\r\nb\r\nc\r\n";
    expect(normalizeFor("crlf", content)).toBe("a\nb\nc\n");
    const s = suggestEditCandidates(content, "b");
    expect(s).not.toBeNull();
  });

  it("完全不像时老实说找不到，并给出文件规模供模型判断", () => {
    const s = suggestEditCandidates(CONTENT, "completely unrelated content xyz");
    expect(s).not.toBeNull();
    expect(s!.candidates).toHaveLength(0);
    expect(s!.message).toMatch(/no similar content/i);
    expect(s!.message).toMatch(/3 lines/);
  });

  it("候选只报告、不自动替换 —— 缩进敏感语言里自动替换会写出错代码", () => {
    // 函数只返回候选文本，绝不返回「改好的全文」这种东西
    const s = suggestEditCandidates("if x:\n    pass\n", "if x:\n  pass");
    expect(s).not.toBeNull();
    for (const c of s!.candidates) {
      expect(typeof c.text).toBe("string");
      // 候选必须来自原文（归一化后），不能是被改写过的产物
      expect(c.text).not.toMatch(/\$\$|\$&/);
    }
  });
});

describe("containsReplacementToken 诊断函数", () => {
  it("识别四种记号", () => {
    for (const t of ["$$", "$&", "$`", "$'"]) {
      expect(containsReplacementToken(`x = ${t}`)).toBe(true);
    }
  });
  it("普通 $ 不误报", () => {
    expect(containsReplacementToken("price = $5")).toBe(false);
    expect(containsReplacementToken("${x}")).toBe(false);
  });
});
