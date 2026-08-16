/**
 * Output Contract — 规范化工具输出契约
 *
 * 设计对标 DSH `core/tools` output declaration.
 *
 * 每个工具可以声明其输出的 schema 和 render 函数：
 * ```typescript
 * output: {
 *   schema: { type: 'string' },
 *   render: (args, value) => [{ type: 'text', text: value }],
 * }
 * ```
 *
 * 这让工具的输出可以被：
 * 1. JSON 验证 — 确保工具返回的值符合声明
 * 2. 自定义渲染 — 工具控制自己的输出如何呈现给模型
 * 3. 类型安全 — 调用方知道输出的结构
 *
 * 无声明（undefined）时，输出原样传递（向后兼容）。
 */

// ========== Types ==========

/** 输出 schema — 简化的 JSON schema 子集 */
export interface OutputSchema {
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  description?: string;
  properties?: Record<string, OutputSchema>;
  items?: OutputSchema;
  required?: string[];
}

/** 输出渲染函数 — 将工具返回的值转换为 content blocks */
export type OutputRender = (
  args: Record<string, unknown>,
  value: unknown,
) => Array<{ type: "text"; text: string }>;

/** 工具输出契约声明 */
export interface OutputContract {
  /** 输出值的 schema */
  schema?: OutputSchema;
  /** 渲染函数 — 将值转换为 content blocks */
  render?: OutputRender;
}

// ========== Validation ==========

/**
 * 验证一个值是否符合 OutputSchema。
 *
 * 简化的 JSON schema 验证 — 只检查 type, properties, items, required。
 * 不支持 $ref, oneOf, allOf 等高级特性。
 */
export function validateOutput(value: unknown, schema: OutputSchema): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  function check(val: unknown, sch: OutputSchema, path: string): void {
    // Type check
    switch (sch.type) {
      case "string":
        if (typeof val !== "string") {
          errors.push(`${path}: expected string, got ${typeof val}`);
        }
        break;
      case "number":
        if (typeof val !== "number") {
          errors.push(`${path}: expected number, got ${typeof val}`);
        }
        break;
      case "boolean":
        if (typeof val !== "boolean") {
          errors.push(`${path}: expected boolean, got ${typeof val}`);
        }
        break;
      case "null":
        if (val !== null) {
          errors.push(`${path}: expected null, got ${typeof val}`);
        }
        break;
      case "object":
        if (typeof val !== "object" || val === null || Array.isArray(val)) {
          errors.push(`${path}: expected object, got ${typeof val}`);
          return; // Can't check properties of non-object
        }
        // Check properties
        if (sch.properties) {
          const obj = val as Record<string, unknown>;
          for (const [key, subSchema] of Object.entries(sch.properties)) {
            if (key in obj) {
              check(obj[key], subSchema, `${path}.${key}`);
            } else if (sch.required?.includes(key)) {
              errors.push(`${path}.${key}: required but missing`);
            }
          }
        }
        break;
      case "array":
        if (!Array.isArray(val)) {
          errors.push(`${path}: expected array, got ${typeof val}`);
          return;
        }
        // Check items
        if (sch.items) {
          for (let i = 0; i < val.length; i++) {
            check(val[i], sch.items, `${path}[${i}]`);
          }
        }
        break;
    }
  }

  check(value, schema, "$");
  return { valid: errors.length === 0, errors };
}

// ========== Registry ==========

/** 工具输出契约注册表 */
const outputContracts = new Map<string, OutputContract>();

/**
 * 注册工具的输出契约。
 * 工具在注册时调用此方法声明其输出 schema 和渲染函数。
 */
export function registerOutputContract(toolName: string, contract: OutputContract): void {
  outputContracts.set(toolName, contract);
}

/**
 * 获取工具的输出契约。
 */
export function getOutputContract(toolName: string): OutputContract | undefined {
  return outputContracts.get(toolName);
}

/**
 * 验证工具输出是否符合声明。
 * 无声明时返回 valid（向后兼容）。
 */
export function validateToolOutput(toolName: string, value: unknown): { valid: boolean; errors: string[] } {
  const contract = outputContracts.get(toolName);
  if (!contract?.schema) {
    return { valid: true, errors: [] };
  }
  return validateOutput(value, contract.schema);
}

/**
 * 渲染工具输出为 content blocks。
 * 无 render 函数时回退为默认文本渲染。
 */
export function renderToolOutput(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): Array<{ type: "text"; text: string }> {
  const contract = outputContracts.get(toolName);
  if (contract?.render) {
    try {
      return contract.render(args, value);
    } catch (e: any) {
      console.warn(`[output-contract] render failed for ${toolName}: ${e.message}`);
    }
  }
  // 默认渲染 — 将值转为字符串
  const text = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  return [{ type: "text", text }];
}

/**
 * 清除所有注册的输出契约。
 */
export function clearOutputContracts(): void {
  outputContracts.clear();
}
