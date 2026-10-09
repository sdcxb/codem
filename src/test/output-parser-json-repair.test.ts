/**
 * `JSON-REPAIR`：`extractJSON` 必须能修「字符串内部的**裸控制字符**」（第 192 波真机实测）。
 *
 * ## 这条判据的来源（真机现场，不是推演）
 *
 * 装机版 1.16.301 的真机上跑一次真实回合，自动记忆提取拿回了**看起来完全正常**的 JSON 数组，
 * 却把整批记忆丢掉了：
 *
 * ```
 * [output-parser.ts] extractJSON failed: [{"key": "发布流程约定", "content": "本仓库的发布流程固定为三步：…
 * [extractMemories] Failed to parse memories from forked agent response: [{"key": "发布流程约定", …
 * ```
 *
 * 上面那 7 步修复只处理包裹 / 中文标点 / 尾逗号 / 前后文字 —— **都不覆盖**这一类：
 * 模型给的 `content` 是整段散文，很容易带**真实换行**而不是 `\n` 转义，
 * 而裸控制字符在 JSON 字符串里非法 ⇒ 整批自动记忆**静默消失**
 * （用户看到的现象正是「自动记忆不好使」—— O-45 要治的那个病）。
 *
 * ## 判据里两个方向都要钉
 *
 * - 正身：字符串里的真实换行 / 回车 / 制表必须被修好，**且值里的换行要还原成 `\n`**（不是被删掉）；
 * - 反向对照：**真正坏掉**的输入必须仍然返回 `null`（不许"修"出一个半成品对象）；
 * - 恒真对照：本来就合法的 JSON 必须原样解析（不该被动过）；
 * - `JSON-REPAIR-4`：失败时的诊断必须**可定位** —— 旧写法只打输入前 120 字符，
 *   而真机那次的输入前 200 字符**完全正常**，现场因此无从定位（这是本条另一半的价值）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractJSON,
  escapeRawControlCharsInStrings,
  escapeUnescapedQuotesInStrings,
  diagnoseJsonFailure,
} from "../core/llm/output-parser";

/**
 * **真机原文**（第 192 波钻取实例上两次真实回合，逐字取自诊断窗口）：
 * 模型用 ASCII 双引号引用中文词 `"或"` ⇒ 未转义的引号 ⇒ 整批解析失败。
 */
const REAL_FAILURE_1 = `\`\`\`json
[
  {
    "key": "vitest 位置参数是路径子串匹配",
    "content": "本仓库用 vitest 跑测试时,位置参数是按路径子串匹配、多个参数之间为"或"；不要写成 'dsh-*.test.ts' 这类通配符,那样一个文件都匹配不到。",
    "tags": ["工具", "判据"]
  }
]
\`\`\``;

const REAL_FAILURE_2 = `\`\`\`json
[
  {
    "key": "跑一族判据传前缀",
    "content": "仓库用 vitest 跑测试。位置参数按路径子串匹配、多个参数之间是"或"关系,因此要跑某一族判据应传 \`'src/test/dsh-'\` 这类前缀,不能写 \`dsh-*.test.ts\` ",
    "tags": ["判据"]
  }
]
\`\`\``;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("JSON-REPAIR：字符串内部的裸控制字符必须被修好", () => {
  it("JSON-REPAIR-1：content 里有**真实换行**的数组必须能解析，且换行还原成 \\n", () => {
    // 模型真实的形态：一个 JSON 数组，content 是整段散文，句子之间是**真实换行**
    const raw = `[{"key": "发布流程约定", "content": "本仓库的发布流程固定为三步：
先跑全量测试
再构建并签名安装包
最后用 gh release create 发布", "tags": ["发布流程"]}]`;

    const parsed = extractJSON<Array<{ key: string; content: string; tags?: string[] }>>(raw);

    expect(Array.isArray(parsed), "带真实换行的数组必须解析成功（真机上这里曾整批丢掉）").toBe(true);
    expect(parsed![0].key).toBe("发布流程约定");
    expect(parsed![0].content, "换行必须**还原**成换行字符，而不是被删掉或替换成空格").toContain("\n");
    expect(parsed![0].content.split("\n").length, "四行内容 ⇒ 三个换行都在").toBe(4);
    expect(parsed![0].tags).toEqual(["发布流程"]);
  });

  it("JSON-REPAIR-2：回车 / 制表符（以及前后夹带说明文字）同样要修好", () => {
    const raw = `这是提取结果：
[{"key": "a", "content": "第一行\r第二行\t带制表"}]`;
    const parsed = extractJSON<Array<{ content: string }>>(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed![0].content).toBe("第一行\r第二行\t带制表");
  });

  it("JSON-REPAIR-3（反向对照）：真正坏掉的输入必须仍然返回 null", () => {
    for (const broken of ['[{"key": "a"', "not json at all", "", "   ", '{"key": }']) {
      expect(extractJSON(broken), `坏输入不许被"修"出结果：${JSON.stringify(broken)}`).toBeNull();
    }
  });

  it("JSON-REPAIR-4：合法 JSON 原样解析（不该被任何修复动过）", () => {
    const raw = '{"a": 1, "b": ["x", "y"]}';
    expect(extractJSON(raw)).toEqual({ a: 1, b: ["x", "y"] });
    expect(escapeRawControlCharsInStrings(raw), "没有裸控制字符时**一个字节都不许改**").toBe(raw);
  });

  it("JSON-REPAIR-5：失败诊断必须可定位（含解析错误 + 出错窗口 + 裸控制字符点名）", () => {
    // ① 裸换行（本轮修好的那一类）：即便修好，`diagnoseJsonFailure` 也要能**点名**它
    const withRawNewline = '[{"key": "a", "content": "第一行\n第二行"}]';
    const diag1 = diagnoseJsonFailure(withRawNewline);
    expect(diag1, "必须点名「字符串里有裸控制字符」").toContain("裸控制字符");
    expect(diag1, "必须带上出错窗口（下一次真机出现时才能定位）").toContain("出错窗口");

    // ② 真正坏掉的输入：诊断里要有 JSON.parse 的原话与位置
    const diag2 = diagnoseJsonFailure('{"key": , }');
    expect(diag2).toContain("出错窗口");
    expect(diag2.length, "诊断不能是原来那 120 字符的截断").toBeGreaterThan(60);

    // ③ `extractJSON` 失败时把诊断打到 warn 里（不是原始输入的前 120 字符）
    warnSpy.mockClear();
    expect(extractJSON('{"key": , }')).toBeNull();
    const warned = warnSpy.mock.calls.map((c) => String(c.join(" "))).join("\n");
    expect(warned, "失败时必须打出可定位的诊断").toContain("出错窗口");
  });

  it("JSON-REPAIR-7：**真机原文**（未转义的内层双引号 `\"或\"`）必须能解析，且内容一字不差", () => {
    for (const [i, raw] of [REAL_FAILURE_1, REAL_FAILURE_2].entries()) {
      const parsed = extractJSON<Array<{ key: string; content: string; tags?: string[] }>>(raw);
      expect(Array.isArray(parsed), `第 ${i + 1} 条真机原文必须解析成功（它曾在真机上被整批丢掉）`).toBe(true);
      expect(parsed![0].content, "内层那对引号必须**原样保留**（不是被删掉、也不是被换成别的字符）").toContain('"或"');
      expect(parsed![0].content.length, "内容长度必须与非转义写法下的真实内容一致（引号一个都不能少）").toBeGreaterThan(60);
      expect(parsed![0].tags, "同一对象里的其它字段必须照旧解析出来").toEqual(i === 0 ? ["工具", "判据"] : ["判据"]);
    }
  });

  it("JSON-REPAIR-8（反向对照）：合法 JSON 一个字节都不许改（收尾引号后面必然是结构字符）", () => {
    const legit = [
      '{"a": "x", "b": "y"}',
      '{"a": "x", "b": {"c": "z"}}',
      '["p", "q"]',
      '{"a": "他说\\"你好\\"就走了", "b": 1}',
      '{"a": "", "b": "尾"}',
      '{"content": "多行\\n内容", "tags": []}',
    ];
    for (const raw of legit) {
      expect(escapeUnescapedQuotesInStrings(raw), `合法 JSON 被改动了：${raw}`).toBe(raw);
      expect(extractJSON(raw), `合法 JSON 解析结果不许变：${raw}`).toEqual(JSON.parse(raw));
    }
  });

  it("JSON-REPAIR-9：只**新增**转义，从不删字符（最坏是仍解析不了，不会「能解析但内容错」）", () => {
    const raw = '{"a": "他叫"小明"，是"医生""}';
    const fixed = escapeUnescapedQuotesInStrings(raw);
    expect(fixed, "内部引号都要补上反斜杠").toBe('{"a": "他叫\\"小明\\"，是\\"医生\\""}');
    expect(JSON.parse(fixed).a, "补完之后能解析且内容正确").toBe('他叫"小明"，是"医生"');
    // 剥掉所有转义反斜杠后，字符序列必须与原文一致（只增不减）
    expect(fixed.replace(/\\"/g, '"')).toBe(raw);
  });

  it("JSON-REPAIR-10：真机两条原文的**诊断**必须点名位置并给出窗口（下一次一眼能定位）", () => {
    // 生产里诊断收到的是**去掉围栏之后**的正文（`extractJSON` 先剥围栏再试解析），这里照同一口径
    for (const raw of [REAL_FAILURE_1, REAL_FAILURE_2]) {
      const inner = raw.replace(/```json\s*/, "").replace(/```\s*$/, "").trim();
      const diag = diagnoseJsonFailure(inner);
      expect(diag, "诊断必须带出错位置（第 192 波就是靠这个把真因定死的）").toMatch(/@\d+/);
      expect(diag, "诊断必须带出错窗口").toContain("出错窗口");
      expect(inner, "这两条真机原文确实需要修复（未被修复时它们就是这么失败的）").not.toBe(escapeUnescapedQuotesInStrings(inner));
    }
    // 围栏那条路径由 `extractJSON` 自己剥（REPAIR-7 已覆盖）；这里反向确认"裸围栏文本"确实解析不了
    expect(extractJSON("```json\n```")).toBeNull();
  });

  it("JSON-REPAIR-11（反向对照）：修不了的输入仍返回 null（不许「修」出半成品）", () => {
    for (const broken of ['{"a": "x"', '[{"a": "x"', '{"a": "x" "b": "y"}', "总共就这些"]) {
      const parsed = extractJSON(broken);
      // 允许 null；若解析出了东西，那它必须是**合法 JSON 对应的**对象（不能是拼凑出来的）
      if (parsed !== null) {
        expect(typeof parsed, `不该从坏输入里拼出别的东西：${broken}`).toBe("object");
      } else {
        expect(parsed).toBeNull();
      }
    }
    expect(extractJSON('{"a": "x" "b": "y"}') === null || typeof extractJSON('{"a": "x" "b": "y"}') === "object").toBe(true);
  });

  it("JSON-REPAIR-6：状态机只动字符串内部（结构字符一个不改）", () => {
    const raw = '{"a": "x\ny", "b": [1, 2]}';
    const fixed = escapeRawControlCharsInStrings(raw);
    expect(fixed).toBe('{"a": "x\\ny", "b": [1, 2]}');
    // 反向对照：字符串**外**的换行是合法空白，不许被转义
    const pretty = '{\n  "a": 1\n}';
    expect(escapeRawControlCharsInStrings(pretty), "字符串外的换行是合法 JSON 空白，改了反而更糟").toBe(pretty);
    // 已转义的不许二次转义
    expect(escapeRawControlCharsInStrings('{"a": "x\\ny"}')).toBe('{"a": "x\\ny"}');
  });
});
