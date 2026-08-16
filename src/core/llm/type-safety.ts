/**
 * Type Safety Enhancements — 类型安全增强
 *
 * 设计对标 DSH 的 assertNever + Branded<B> 类型模式。
 *
 * R3-4.4: 提供两个类型安全工具：
 *
 * 1. assertNever(value: never): never
 *    — 用于 exhaustive switch 检查
 *    — 当枚举新增值时，编译器会在所有 switch 处报错
 *
 * 2. Branded<B> — opaque 类型别名
 *    — 防止基本类型混淆（如 SessionId 和 ToolCallId 都是 string）
 *    — 只能通过 brand 函数创建，不能直接赋值
 */

// ========== assertNever ==========

/**
 * 用于 exhaustive switch 检查。
 *
 * 在 switch 的 default 分支调用，如果枚举新增了值，
 * TypeScript 编译器会在所有调用处报错。
 *
 * @example
 * switch (event.type) {
 *   case "user_message": ...
 *   case "tool_call": ...
 *   default: assertNever(event.type) // 编译时检查
 * }
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

// ========== Branded Types ==========

/**
 * Branded 类型 — 在运行时是普通字符串，但在类型层面是唯一的。
 *
 * 防止基本类型混淆：
 * - SessionId 和 ToolCallId 都是 string
 * - 没有品牌时可以互相赋值 — 危险
 * - 用品牌后只能通过专门的构造函数创建
 *
 * @example
 * type SessionId = Branded<'SessionId'>
 * type ToolCallId = Branded<'ToolCallId'>
 * const sid: SessionId = brand('SessionId', 'sess-123')
 * const tid: ToolCallId = brand('ToolCallId', 'call-456')
 * // sid = tid // 编译错误！
 */
export type Branded<Brand extends string> = string & { readonly __brand: Brand };

/**
 * 品牌一个字符串 — 创建 Branded 类型的唯一入口。
 */
export function brand<Brand extends string>(
  brand: Brand,
  value: string,
): Branded<Brand> {
  return value as Branded<Brand>;
}

/**
 * 从 Branded 类型提取原始字符串。
 */
export function unbrand<B extends Branded<string>>(branded: B): string {
  return branded as string;
}

// ========== Common Branded Types ==========

export type SessionId = Branded<"SessionId">;
export type ToolCallId = Branded<"ToolCallId">;
export type MessageId = Branded<"MessageId">;

export const SessionId = (value: string): SessionId => brand("SessionId", value);
export const ToolCallId = (value: string): ToolCallId => brand("ToolCallId", value);
export const MessageId = (value: string): MessageId => brand("MessageId", value);
