/**
 * DSH 运行时的「选择标识」派生（阶段 R3）。
 *
 * ## 这是什么、为什么不能想当然
 *
 * 它们的**通用**方案是 `protocol_selection_id`（产出 `sel_model_xxx`），
 * 但 **`dsh` 这一个运行时不用它** —— DSH 那一支另有一套 `dsh:` 前缀方案：
 *
 *     dsh:model:<base64url( JSON.stringify([provider, model, effort|null]) )>
 *     dsh:permission:<base64url(preset)>
 *
 * 证据（它捆绑包里的两处实现，两处语义一致）：
 * - 插件侧 TS：`host/dsh-runtime/selections.ts`
 * - connector 侧 Python：`connector/runtimes/dsh/identity.py`
 *
 * 我一开始只实现了通用方案。那对 `dsh` 运行时是**错的**：服务端与它存下来的选择
 * 用的都是 `dsh:` 形式，而我们发 `sel_model_...` 会导致"用户选了模型但设备不认" ——
 * 而且这种错**不会报错**，只会表现为"选择不生效"，极难归因。
 *
 * ## 两处必须照抄的严格性
 *
 * 1. **编码规范性**：解码后重新编码必须与输入**逐字**相等（`selections.ts:14`）。
 *    这挡住"同一份内容有多种 base64 写法"（填充位、非规范位）导致
 *    **同一个选择被当成两个**。
 * 2. **权限档不比模型松**：`decodePermissionSelection` 额外拒绝
 *    空串、`custom`、首尾空白、含 `\r`/`\n`（`selections.ts:38`）。
 *    特别是 **`custom` 不可远端切换** —— 那是"用户自定义的一整套权限"，
 *    远端不该能把它当成一个可选项来套用。
 */

/** 模型选择的三个分量（`select/turns` 都传它）。 */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

const DSH_MODEL_PREFIX = "dsh:model:";
const DSH_PERMISSION_PREFIX = "dsh:permission:";

/** base64url（无填充、url-safe 字母表）。不用 `btoa`：它只吃 latin1，中文会炸。 */
export function base64url(bytes: Uint8Array): string {
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += T[(n >> 18) & 63] + T[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += T[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += T[n & 63];
  }
  return out;
}

/** base64url 解码。**严格**：非法字符、填充、非零填充位一律拒绝。 */
export function base64urlDecode(s: string): Uint8Array {
  const rev = new Map<string, number>();
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < T.length; i++) rev.set(T[i], i);
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = rev.get(c);
    if (v === undefined) throw new Error(`base64url 里出现非法字符: ${c}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // 剩下的位必须是 0（否则不是规范编码）
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error("base64url 有非零填充位（非规范编码）");
  }
  return new Uint8Array(out);
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * `dsh:model:<base64url(JSON.stringify([provider, model, effort ?? null]))>`
 * —— 与 `selections.ts:6-8` 逐字一致。
 *
 * 注意这里**没有** `sort_keys` 的概念：载荷是**数组**，键序无意义。
 */
export function modelSelectionId(selection: DshModelSelection): string {
  const payload = [selection.provider, selection.model, selection.reasoningEffort ?? null];
  return DSH_MODEL_PREFIX + base64url(enc(JSON.stringify(payload)));
}

/** `dsh:permission:<base64url(preset)>` —— 与 `selections.ts:10-12` 一致。 */
export function permissionSelectionId(preset: string): string {
  return DSH_PERMISSION_PREFIX + base64url(enc(preset));
}

/**
 * 解出 `dsh:` 前缀载荷，并做**规范性**复核（重编码必须逐字相等）。
 *
 * 长度上限 16384 也照抄（`selections.ts:16`）：这是防"拿一个超长串当选择 id"
 * 把后续处理拖垮的一道门槛。
 */
function decodePrefixed(value: string, prefix: string): string {
  const body = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!value.startsWith(prefix) || !body || !/^[\w-]+$/.test(body) || body.length > 16_384) {
    throw new Error("DSH 选择标识不合法");
  }
  const text = dec(base64urlDecode(body));
  // 规范性：重新编码必须与原文**逐字**相等
  if (base64url(enc(text)) !== body) throw new Error("DSH 选择标识的编码不是规范形式");
  return text;
}

export function decodeModelSelection(value: string): DshModelSelection {
  let parts: unknown;
  try {
    parts = JSON.parse(decodePrefixed(value, DSH_MODEL_PREFIX));
  } catch {
    throw new Error("DSH 模型选择不合法");
  }
  const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    !nonempty(parts[0]) ||
    !nonempty(parts[1]) ||
    (parts[2] !== null && !nonempty(parts[2]))
  ) {
    throw new Error("DSH 模型选择必须给出 provider、model 与 effort");
  }
  const selection: DshModelSelection = { provider: parts[0], model: parts[1] };
  if (parts[2] !== null) selection.reasoningEffort = parts[2] as string;
  // 规范性复核（第二条防线：编码对但内容不是规范三元组）
  if (modelSelectionId(selection) !== value) {
    throw new Error("DSH 模型选择必须是规范编码");
  }
  return selection;
}

/**
 * 解出权限预设名。
 *
 * ⚠️ 除了编码规范性，还**必须**拒绝这些（`selections.ts:38`）：
 * 空、`custom`、首尾空白、含 `\r`/`\n`。
 * 其中 **`custom` 不可远端切换** 最要紧 —— 它是"用户自定义的一整套权限"，
 * 远端把它当成一个可选项套用，等于绕过用户的定制。
 */
export function decodePermissionSelection(value: string): string {
  const preset = decodePrefixed(value, DSH_PERMISSION_PREFIX);
  if (!preset || preset === "custom" || preset.trim() !== preset || /[\r\n]/u.test(preset)) {
    throw new Error("请选择一个可在远端切换的 DSH 权限档");
  }
  return preset;
}

export interface DshSelections {
  model?: string | null;
  permission?: string | null;
}

/**
 * 解析远端传来的 `selections` 对象。
 *
 * 只认 `model` 与 `permission` 两个键，且每个值都必须能**解出来**才接受 ——
 * 不做"先存下、以后再校验"（那会让非法值进到会话状态里）。
 */
export function parseSelections(value: unknown): DshSelections {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("selections 必须是对象");
  }
  const out: DshSelections = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!["model", "permission"].includes(key)) {
      throw new Error(`不认识的 selection 作用域: ${key}`);
    }
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("配置变更需要一个具体的 selection id");
    }
    if (key === "model") {
      decodeModelSelection(item);
      out.model = item;
    } else {
      decodePermissionSelection(item);
      out.permission = item;
    }
  }
  return out;
}
