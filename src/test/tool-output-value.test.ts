/**
 * 门禁：工具**结果值**的校验与渲染（`output-value.ts`）+ 入参校验（`input-args.ts`）。
 *
 * ## 这个文件要守住的核心性质
 *
 * 1. **输出侧 fail-closed**：`outputSchema` 里写了我们不认识的约束 ⇒ **报错**，
 *    不能静默忽略（否则「已校验」是假话 —— 这正是本仓反复栽过的形态）。
 * 2. **输入侧 fail-open（有边界）**：只报「缺必填」与「类型明显不符」，
 *    不认识的业务约束**忽略**，避免大面积误拦真实调用。
 *    两个方向**刻意相反**，理由见各模块文件头；搞反了要么假绿要么乱拦。
 * 3. **注册契约不改变模型可见输出**：`renderOutput` 必须能复现旧行为（逐字）。
 */
import { describe, it, expect } from "vitest";
import {
  checkSchema,
  renderOutputValue,
  validateAndRenderOutput,
} from "../core/llm/output-value";
import { validateToolArgs, describeArgProblems, str } from "../core/llm/input-args";
import { createDefaultToolRegistry } from "../core/llm/tools";

describe("output-value：校验通过的情形", () => {
  const schema = {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      count: { type: "number" },
    },
    required: ["files", "count"],
    additionalProperties: false,
  };

  it("形状正确 ⇒ 无违规", () => {
    expect(checkSchema(schema, { files: ["a", "b"], count: 2 })).toEqual([]);
  });

  it("空数组是合法的（`(empty)` 由渲染层表达，不是违规）", () => {
    expect(checkSchema(schema, { files: [], count: 0 })).toEqual([]);
  });

  it("integer 约束真的按整数判（不是所有 number 都过）", () => {
    const s = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
    expect(checkSchema(s, { n: 3 })).toEqual([]);
    expect(checkSchema(s, { n: 3.5 }).length).toBeGreaterThan(0);
  });

  it("enum 命中", () => {
    const s = { type: "object", properties: { k: { enum: ["a", "b"] } }, required: ["k"] };
    expect(checkSchema(s, { k: "a" })).toEqual([]);
  });
});

describe("output-value：校验失败的情形（每条都要带路径）", () => {
  it("缺必填 ⇒ 报出字段名", () => {
    const v = checkSchema(
      { type: "object", properties: { a: { type: "number" } }, required: ["a", "b"] },
      { a: 1 },
    );
    expect(v.some((x) => x.message.includes("`b`"))).toBe(true);
  });

  it("类型不符 ⇒ 报出期望与实际", () => {
    const v = checkSchema(
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { a: 42 },
    );
    expect(v[0].message).toMatch(/期望 string，收到 number/);
  });

  it("数组元素违规 ⇒ 路径带下标（便于定位第几个元素）", () => {
    const v = checkSchema(
      { type: "object", properties: { xs: { type: "array", items: { type: "number" } } }, required: ["xs"] },
      { xs: [1, "two", 3] },
    );
    expect(v[0].path).toBe("value.xs[1]");
  });

  it("additionalProperties: false ⇒ 多出的字段被报（挡住字段名写错）", () => {
    const v = checkSchema(
      {
        type: "object",
        properties: { a: { type: "number" } },
        required: ["a"],
        additionalProperties: false,
      },
      { a: 1, typo: 2 },
    );
    expect(v.some((x) => x.message.includes("`typo`"))).toBe(true);
  });

  it("enum 不命中 ⇒ 列出允许值", () => {
    const v = checkSchema(
      { type: "object", properties: { k: { enum: ["a", "b"] } }, required: ["k"] },
      { k: "c" },
    );
    expect(v[0].message).toContain("a");
    expect(v[0].message).toContain("b");
  });

  it("**不认识的约束必须报错**（输出侧 fail-closed，这是本门禁最重要的一条）", () => {
    const v = checkSchema({ type: "object", oneOf: [{ type: "object" }] }, {});
    expect(
      v.some((x) => x.message.includes("未支持的约束") && x.message.includes("oneOf")),
      "outputSchema 里写了未支持的约束却静默忽略了 —— 那样「已校验」就是假话",
    ).toBe(true);
  });

  it("schema 本身不是对象 ⇒ 报错而不是崩", () => {
    expect(checkSchema("nope", {}).length).toBeGreaterThan(0);
    expect(checkSchema(null, {}).length).toBeGreaterThan(0);
  });
});

describe("output-value：渲染", () => {
  it("字符串原样、数组逐行、对象逐字段", () => {
    expect(renderOutputValue("hi")).toBe("hi");
    expect(renderOutputValue(["a", "b"])).toBe("a\nb");
    expect(renderOutputValue({ a: 1, b: "x" })).toBe("a: 1\nb: x");
  });

  it("空值可预测（不产生 'undefined' 这种文本）", () => {
    expect(renderOutputValue(null)).toBe("");
    expect(renderOutputValue(undefined)).toBe("");
    expect(renderOutputValue([])).toBe("(empty)");
    expect(renderOutputValue({})).toBe("(empty)");
  });

  it("renderOutput 抛错被报成违规（而不是静默吞掉）", () => {
    const r = validateAndRenderOutput(
      { outputSchema: { type: "object" }, renderOutput: () => { throw new Error("boom"); } },
      {},
    );
    expect(r.violations.some((v) => v.message.includes("boom"))).toBe(true);
  });

  it("自定义 renderOutput 生效", () => {
    const r = validateAndRenderOutput(
      { outputSchema: { type: "object" }, renderOutput: (v) => `count=${(v as any).count}` },
      { count: 3 },
    );
    expect(r.output).toBe("count=3");
    expect(r.violations).toEqual([]);
  });
});

describe("input-args：入参校验（只报「确定是问题」的两类）", () => {
  const params = {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["command"],
  };

  it("缺必填 ⇒ 报", () => {
    const p = validateToolArgs("bash", params, {});
    expect(p[0].param).toBe("command");
  });

  it("类型明显不符 ⇒ 报", () => {
    const p = validateToolArgs("bash", params, { command: 123 });
    expect(p.some((x) => x.param === "command" && x.message.includes("期望 string"))).toBe(true);
  });

  it("**不认识的约束一律忽略**（输入侧刻意 fail-open，避免误拦）", () => {
    // 声明了 minimum / maxLength / pattern，值也不满足它们 —— 但这一层不该管
    const strict = {
      type: "object",
      properties: { n: { type: "number", minimum: 100 }, s: { type: "string", maxLength: 1, pattern: "^z" } },
      required: ["n", "s"],
    };
    expect(validateToolArgs("t", strict, { n: 1, s: "hello" })).toEqual([]);
  });

  it("联合类型声明 ⇒ 不判（只支持单类型）", () => {
    const union = { type: "object", properties: { v: { type: ["string", "number"] } }, required: [] };
    expect(validateToolArgs("t", union, { v: { nested: true } })).toEqual([]);
  });

  it("可选参数缺失 ⇒ 不报（只有 required 才报）", () => {
    expect(validateToolArgs("t", params, { command: "ls" })).toEqual([]);
  });

  it("null 视为缺失（模型有时显式给 null）", () => {
    expect(validateToolArgs("t", params, { command: null }).length).toBeGreaterThan(0);
  });

  it("入参不是对象 ⇒ 报在最外层而不是崩", () => {
    expect(validateToolArgs("t", params, "nope").length).toBeGreaterThan(0);
    expect(validateToolArgs("t", params, [1]).length).toBeGreaterThan(0);
  });

  it("没有 schema（老工具/运行时工具）⇒ 不判，零变化", () => {
    expect(validateToolArgs("t", undefined, { anything: 1 })).toEqual([]);
  });

  it("提示文本可行动：列出全部参数名与必填项", () => {
    const msg = describeArgProblems("bash", [{ param: "command", message: "缺少必填参数 `command`" }], params);
    expect(msg).toContain("command");
    expect(msg).toContain("Expected parameters:");
    expect(msg).toContain("Required:");
    expect(msg).toMatch(/call again/i);
  });
});

describe("input-args：安全取值（消灭 as string 之后的崩溃点）", () => {
  it("str 对非字符串一律当「没给」", () => {
    expect(str("a")).toBe("a");
    expect(str("")).toBe(""); // 空串是"给了但为空"，是否算缺失由调用方判
    expect(str(1)).toBeUndefined();
    expect(str(null)).toBeUndefined();
    expect(str(undefined)).toBeUndefined();
    expect(str({})).toBeUndefined();
    expect(str(["a"])).toBeUndefined();
  });
});

describe("端到端：真实 registry 上的结果契约", () => {
  it("glob 注册了 outputSchema，且渲染复现旧行为（逐字）", () => {
    const registry = createDefaultToolRegistry();
    const raw = registry.getRawContract("glob");
    expect(raw?.outputSchema, "glob 应当注册结果契约").toBeTruthy();
    expect(typeof raw?.renderOutput).toBe("function");

    // 旧实现是 `files.join("\n") || "No files found"` —— 注册契约不该改变模型看到的东西
    expect(raw!.renderOutput!({ files: ["a", "b"], count: 2, pattern: "p" })).toBe("a\nb");
    expect(raw!.renderOutput!({ files: [], count: 0, pattern: "p" })).toBe("No files found");
  });

  it("glob 的结果契约能挡住形状错误的值", () => {
    const registry = createDefaultToolRegistry();
    const raw = registry.getRawContract("glob")!;
    // 少字段
    expect(checkSchema(raw.outputSchema, { files: ["a"] }).length).toBeGreaterThan(0);
    // 类型错
    expect(checkSchema(raw.outputSchema, { files: "a", count: 1, pattern: "p" }).length).toBeGreaterThan(0);
    // 多字段
    expect(
      checkSchema(raw.outputSchema, { files: [], count: 0, pattern: "p", extra: 1 }).length,
    ).toBeGreaterThan(0);
    // 正确
    expect(checkSchema(raw.outputSchema, { files: ["a"], count: 1, pattern: "p" })).toEqual([]);
  });

  it("未注册结果契约的工具零变化（渐进路径的关键性质）", () => {
    const registry = createDefaultToolRegistry();
    /**
     * ⚠️ 第 122 轮改掉了本用例的示例对象（原来拿 `read` 当"未注册"的例子）。
     * 现在 `read`/`bash` **已经注册**（它们是调用量第 1、第 2 的工具），
     * 所以改拿 `write` 举例 —— 它确实没有结果契约。
     * 这条判据本身（"未注册的必须不受校验影响"）没有变，变的是例子。
     */
    const write = registry.getRawContract("write");
    expect(write?.outputSchema).toBeUndefined();
    // 反向对照：read / bash 现在**必须**有（否则"高频面已覆盖"是句空话）
    expect(registry.getRawContract("read")?.outputSchema).toBeDefined();
    expect(registry.getRawContract("bash")?.outputSchema).toBeDefined();
  });
});
