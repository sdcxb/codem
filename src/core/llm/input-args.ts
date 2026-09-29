/**
 * 工具**入参**的校验与安全取值。
 *
 * ## 解决的病（第 121 轮）
 *
 * 我们此前**完全没有入参校验**：全仓搜 `validateToolInput` / `validateArgs` 零命中，
 * `ToolDef.parameters` 只用于**构造**给模型的请求 schema，调用时**不校验**。
 * 于是模型少给一个参数就一路走到工具实现里，变成内部崩溃信息：
 *
 * ```
 * tools.ts:847    let command = args.command as string;   // undefined
 * tools.ts:855    command.match(...)                      // TypeError
 *                 → 被 catch 包成 "Error: Cannot read properties of undefined (reading 'match')"
 * ```
 *
 * 模型看不懂这句话，也不知道该怎么改 —— 与之前 `edit` 的
 * `oldString` 那类问题同源（我们已为 `edit` 单独写了 `validateEditParams`，
 * 但那是逐工具的手工补丁，其他 50 个工具仍无保护）。
 *
 * zcode 在管线里显式做这一步（`validateInitialModelToolInput`），
 * DSH 由 `defineTool` 在调用处理器前校验。这里补上我们的那一层。
 *
 * ## 与 `output-value.ts` 的分工
 *
 * | 文件 | 校验对象 | 关键字不识别时 |
 * | --- | --- | --- |
 * | `output-value.ts` | **我们声明**的 `outputSchema` | **报错**（fail-closed：声明里写了就必须生效） |
 * | `input-args.ts` | **模型传入**的实参 vs 已有 `parameters` | **忽略**（只为防崩溃，不替模型判对错） |
 *
 * 两者对「不认识的约束」处理**刻意相反**，理由见上表 —— 这个方向性差异很重要，
 * 搞反了要么假绿（输出侧）、要么大面积误拦真实调用（输入侧）。
 */

/** 一条入参问题（带字段名，便于给出可行动提示）。 */
export interface ArgProblem {
  param: string;
  message: string;
}

const SUPPORTED_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function scalarMatches(expected: string, v: unknown): boolean {
  const actual = typeOf(v);
  if (expected === "integer") return actual === "number" && Number.isInteger(v as number);
  if (expected === "number") return actual === "number";
  return actual === expected;
}

/**
 * 校验模型入参 vs 工具的 `parameters` schema。
 *
 * ## 只报「确定是问题」的两类
 *
 * 1. **缺必填**（`required` 里的字段不存在）
 * 2. **类型明显不符**（声明 `string` 却给了数字/对象；声明 `array` 却给了字符串……）
 *
 * ## 刻意**不**报的
 *
 * - `type` 之外的约束（`enum` / `minimum` / `pattern` / `format` / `default` …）
 *   —— 那些是"业务规则"，很多工具自己在实现里判得更准并给出更好的提示；
 *   在这里拦会**误拦**真实调用（例如某工具声明了 `enum` 但实现接受更宽的取值）。
 * - `type` 是**联合**（数组，如 `["string","number"]`）时不判 —— 只支持单类型声明。
 * - 不认识的 `type` 值不判（`SUPPORTED_SCALAR_TYPES` 之外的，交给工具自己）。
 *
 * 换句话说：**这一层只负责挡住「会让工具实现崩掉或明显走错分支」的调用**，
 * 不负责业务语义。这个边界必须清楚，否则它会变成一个到处误拦的拦路虎。
 */
export function validateToolArgs(
  toolName: string,
  parameters: unknown,
  args: unknown,
): ArgProblem[] {
  if (!parameters || typeof parameters !== "object") return [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [{ param: "(root)", message: `${toolName} 的入参必须是对象，收到 ${typeOf(args)}` }];
  }
  const schema = parameters as Record<string, unknown>;
  const obj = args as Record<string, unknown>;
  const problems: ArgProblem[] = [];

  // 缺必填
  if (Array.isArray(schema.required)) {
    for (const key of schema.required as string[]) {
      if (typeof key !== "string") continue;
      const v = obj[key];
      if (v === undefined || v === null) {
        problems.push({ param: key, message: `缺少必填参数 \`${key}\`` });
      }
    }
  }

  // 类型不符（只对单类型声明判）
  const props = schema.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    for (const [key, raw] of Object.entries(props)) {
      if (!(key in obj)) continue;
      const v = obj[key];
      if (v === undefined || v === null) continue; // 必填已在上一步判过
      const propSchema = raw as Record<string, unknown> | null;
      if (!propSchema || typeof propSchema !== "object") continue;
      const t = propSchema.type;
      if (typeof t !== "string") continue; // 联合类型/未声明 ⇒ 不判
      if (!SUPPORTED_SCALAR_TYPES.has(t)) continue; // 不认识的类型 ⇒ 交给工具
      if (!scalarMatches(t, v)) {
        problems.push({
          param: key,
          message: `参数 \`${key}\` 期望 ${t}，实际是 ${typeOf(v)}`,
        });
      }
    }
  }

  return problems;
}

/**
 * 把入参问题渲染成**给模型看的**可行动文本。
 *
 * 要求：说清哪个参数、期望什么、以及**正确的调用形态**（列出全部参数名）。
 * 只骂不教等于没写（见 `edit` 的 `validateEditParams` 同一个取向）。
 */
export function describeArgProblems(
  toolName: string,
  problems: ArgProblem[],
  parameters: unknown,
): string {
  const schema = (parameters ?? {}) as Record<string, unknown>;
  const propNames = schema.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties as Record<string, unknown>)
    : [];
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  const lines = [
    `${toolName} was called with invalid arguments:`,
    ...problems.map((p) => `  - ${p.param}: ${p.message}`),
    "",
    `Expected parameters: ${propNames.map((n) => `\`${n}\``).join(", ") || "(none)"}`,
  ];
  if (required.length > 0) {
    lines.push(`Required: ${required.map((n) => `\`${n}\``).join(", ")}`);
  }
  lines.push("Fix the arguments and call again.");
  return lines.join("\n");
}

/**
 * 安全取字符串参数：**非字符串一律当"没给"**。
 *
 * 用途是消灭 `args.x as string` 之后直接 `.match()` / `.replace()` 这类崩溃点。
 * 注意语义是「宽容」而不是「报错」—— 报错由 `validateToolArgs` 负责；
 * 这里只保证**取不到时不会炸**。两者配合：先校验给模型可行动提示，
 * 实现里再用它兜住漏网的（比如 `validateToolArgs` 刻意不判的联合类型）。
 *
 * ## 为什么只有 `str`（第 121 轮审计）
 *
 * 一开始还写了 `num()` / `bool()`，但**没有任何调用点** —— 那就成了我自己
 * 刚刚批判过的「空壳导出」。按同一条标准处理：删掉，需要时再加。
 * （`output-value.ts` 与 `input-args.ts` 的导出一律遵守这条。）
 */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
