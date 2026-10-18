/**
 * 「添加自定义 OpenAI 兼容 Provider」的**纯逻辑**：把表单输入变成新的 provider 列表。
 *
 * 为什么抽出来：`SettingsPanel` 很大且依赖 Tauri，控制流（保存确认）只能做源码级判据；
 * 但"输入 → provider 对象"这件事可以纯函数化，直接断言 id 规则、`custom` 标记、去空格、
 * 空输入拒绝。判据 `CUSTPROV-1..4`。
 */

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderLike {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  custom?: boolean;
}

export interface CustomProviderResult<T extends ProviderLike> {
  /** 追加后的完整列表（原列表不被修改） */
  providers: T[];
  /** 新生成的 provider（空输入时为 null） */
  provider: T | null;
}

/**
 * 构建新的 provider 列表。
 *
 * - `name` / `baseUrl` 去空格后任一为空 ⇒ 返回 `{ providers: 原列表副本, provider: null }`；
 * - id 形如 `custom-<时间戳>`（与既有约定一致，`custom` 标记供引擎注册时识别）；
 * - `apiKey` 只去首尾空格（中间空白可能是密钥的一部分，不能动）。
 */
export function appendCustomProvider<T extends ProviderLike>(
  providers: readonly T[],
  input: CustomProviderInput,
  now: number = Date.now(),
): CustomProviderResult<T> {
  const name = (input.name ?? "").trim();
  const baseUrl = (input.baseUrl ?? "").trim();
  const apiKey = (input.apiKey ?? "").trim();
  if (!name || !baseUrl) {
    return { providers: [...providers], provider: null };
  }
  const provider = {
    id: `custom-${now}`,
    name,
    baseUrl,
    apiKey,
    custom: true,
  } as T;
  return { providers: [...providers, provider], provider };
}
