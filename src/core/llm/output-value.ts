/**
 * 工具**结果值**的校验与渲染 —— 让 `outputSchema` 真正生效。
 *
 * ## 解决的病
 *
 * 本仓的 `output-contract.ts` 早就写好了框架、管线也真的在调它，但**零个工具注册过
 * 契约** ⇒ `validateToolOutput` 永远走 `if (!contract?.schema) return { valid: true }`
 * 这条短路，**恒真**；而且即使验失败也只 `console.warn`、不拦。
 *
 * 根因不是"忘了接线"，而是**没有可校验的对象**：工具结果此前只有不透明的字符串
 * `output`。DSH 的做法（`core/tools/src/index.ts:212-235`）是让 `execute` 返回
 * **结构化值**，由必填的 `output.schema` 界定、`render` 负责变成模型可见文本、
 * 违规直接 `throw new ToolOutputError`。
 *
 * 这个文件是那条路的第一段：**一个有意的、够用的 JSON Schema 子集**。
 *
 * ## 为什么只支持一小撮关键字
 *
 * 引一个完整 schema 引擎（ajv 之类）代价是依赖体积 + 行为面变大，而我们的目的是
 * **给工具结果上一道真实的保障**，不是做通用验证框架。所以只支持：
 * `type` / `properties` / `required` / `items` / `enum` / `additionalProperties`。
 * 需要更多时**显式加**，并补用例——而不是让它悄悄吞掉不认识的约束。
 *
 * ## 关键设计：不认识的约束怎么办
 *
 * **必须报错（fail-closed），不能静默放过。** 如果 `outputSchema` 里写了
 * 我们不认识的约束（比如 `oneOf`），而校验器默默忽略它，那么「已校验」这句话
 * 就是假的——那正是本仓反复栽过的形态（看起来在工作、其实没接线）。
 * 所以 `checkSchema` 遇到不认识的键会返回一条**未支持约束**的错误。
 */

/** 校验失败的一条具体原因（带路径，便于定位）。 */
export interface OutputViolation {
  /** JSON 路径，如 `value.files[2].path` */
  path: string;
  message: string;
}

const SUPPORTED_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "additionalProperties",
  "description", // 纯文档，不参与校验
  "title", // 同上
]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function typeMatches(expected: string, v: unknown): boolean {
  const actual = typeOf(v);
  if (expected === "integer") return actual === "number" && Number.isInteger(v as number);
  if (expected === "number") return actual === "number";
  return actual === expected;
}

/**
 * 递归校验 `value` 是否符合 `schema`。
 *
 * @param schema 声明式约束（只支持 `SUPPORTED_KEYS` 里的键）
 * @param value 待校验的值
 * @param path 出错时用于定位的路径前缀
 */
export function checkSchema(
  schema: unknown,
  value: unknown,
  path = "value",
): OutputViolation[] {
  if (schema === undefined) return [];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return [{ path, message: `outputSchema 必须是对象（收到 ${typeOf(schema)}）` }];
  }
  const s = schema as Record<string, unknown>;
  const out: OutputViolation[] = [];

  // 不认识的约束 ⇒ 明说，不静默忽略（否则「已校验」是假话）
  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYS.has(key)) {
      out.push({
        path,
        message: `outputSchema 用了未支持的约束 \`${key}\`；要么去掉它，要么在 output-value.ts 里实现并补用例`,
      });
    }
  }

  // enum
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      out.push({
        path,
        message: `期望是 ${JSON.stringify(s.enum)} 之一，收到 ${JSON.stringify(value)}`,
      });
    }
  }

  // type
  if (typeof s.type === "string") {
    if (!typeMatches(s.type, value)) {
      out.push({ path, message: `期望 ${s.type}，收到 ${typeOf(value)}` });
      return out; // 类型都不对，继续查字段没有意义
    }
  }

  // properties / required（仅对象）
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  if (isObject) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj)) out.push({ path, message: `缺少必填字段 \`${key}\`` });
      }
    }
    const props = s.properties as Record<string, unknown> | undefined;
    if (props && typeof props === "object") {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) out.push(...checkSchema(sub, obj[key], `${path}.${key}`));
      }
      // additionalProperties: false ⇒ 多出来的键要报（模型/工具写错字段名时很有用）
      if (s.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            out.push({ path, message: `出现了未声明的字段 \`${key}\`` });
          }
        }
      }
    }
  }

  // items（仅数组）
  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => {
      out.push(...checkSchema(s.items, item, `${path}[${i}]`));
    });
  }

  return out;
}

/**
 * 通用渲染：把结构化值渲染成给模型看的文本。
 *
 * 只在工具没提供 `renderOutput` 时使用。刻意保持朴素可预测：
 * - 字符串原样；数字/布尔/null 直接 `String()`
 * - 数组逐行（元素是对象则一行一个 JSON，避免多行对象打乱阅读）
 * - 对象按 `key: value` 逐行
 *
 * **不追求好看**——需要排版的工具自己提供 `renderOutput`（那才是它该负责的）。
 */
export function renderOutputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value
      .map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)))
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    return entries
      .map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
  }
  return String(value);
}

/**
 * 校验并渲染一次工具结果。**这是管线唯一该调用的入口**。
 *
 * @returns 渲染后的文本 + 违规列表（空 = 通过）。违规时**调用方必须处理**
 *          （拦下或至少按级别上报），不能像旧的 `output-contract` 那样只 warn 后放行。
 */
export function validateAndRenderOutput(
  contract: { outputSchema?: unknown; renderOutput?: (v: unknown) => string },
  value: unknown,
): { output: string; violations: OutputViolation[] } {
  const violations = checkSchema(contract.outputSchema, value);
  const render = contract.renderOutput ?? renderOutputValue;
  let output: string;
  try {
    output = render(value);
  } catch (e) {
    // 渲染抛错**不是**数据违规，而是工具实现的问题——照样报出来，不静默
    return {
      output: "",
      violations: [
        ...violations,
        { path: "value", message: `renderOutput 抛错: ${(e as Error)?.message ?? e}` },
      ],
    };
  }
  return { output, violations };
}
