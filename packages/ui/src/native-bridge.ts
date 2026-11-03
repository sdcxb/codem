/**
 * 原生桥（**只有 Android 外壳会注入**）—— 让共享 UI 能打开"本机模型设置"。
 *
 * ## 为什么只有一个入口、没有任何 getter
 *
 * 表单在**原生对话框**里（`LlmSettingsDialog`）：Key 只经过 Java 内存 → AndroidKeyStore，
 * 不进 JS 字符串、不进 React state、不进 DOM。共享 UI 这边能做的只有两件事：
 * 1. `openLlmSettings()`：打开原生设置框（无参数、无返回值）；
 * 2. `getLlmSettingsSummary()`：读一份**永远不含 Key / 密文 / 哈希**的摘要。
 *
 * 明确**没有**：`save()` / `getKey()` / `openUrl()` / 任何通用能力。
 * 一个能写、能读秘密、能跳转的桥等于把原生权限交给页面（页面里跑着模型输出）。
 *
 * ## 桌面为什么天然没有
 *
 * `window.CodemNative` 由 `WebView.addJavascriptInterface` 注入，只存在于 Android 外壳的
 * WebView 里。桌面渲染进程没有这个对象 ⇒ `getNativeBridge()` 返回 null ⇒ 入口不渲染。
 * 判据（`ui-native-settings`）同时钉住"`src/` 里不出现 `CodemNative`"这条源码不变量。
 *
 * ## 边界
 *
 * 桥只在 loopback 页面注入，且原生侧每个方法内部再复核当前页面 origin
 * （`removeJavascriptInterface` 对已加载的 frame 不保证立刻生效）。这里的 TS 侧
 * 也再判一次 origin：多一道总比少一道强。
 */
export const NATIVE_BRIDGE_NAME = "CodemNative";

/** 原生设置框读到的摘要（非秘密）。字段缺失/畸形时当作"不可用"，不猜。 */
export interface LlmSettingsSummary {
  /** base URL + model 都非空 */
  configured: boolean;
  /** 当前保存的服务地址（非秘密） */
  baseUrl: string;
  /** 当前保存的模型名（非秘密） */
  model: string;
  /** 是否已保存 Key（**只给布尔**，永远不给值、长度、哈希） */
  hasKey: boolean;
  /** Key 的存储状态：keystore=已加密；legacy=仍是旧明文；unreadable=本机解不开；none=没有 */
  keyState: "keystore" | "legacy" | "unreadable" | "none";
  /** 明文 http 端点（仅提示用；https 为 false） */
  insecureHttp: boolean;
}

export interface CodemNativeBridge {
  readonly version: number;
  /** 打开原生设置框：无参数、无返回值、无回调 */
  openLlmSettings(): void;
  /** 返回上面 `LlmSettingsSummary` 的 JSON 字符串（畸形时抛错，调用方按"读不到"处理） */
  getLlmSettingsSummary(): string;
}

/**
 * 只有 Android 外壳托管的 loopback 页面才允许出现桥（远程 PC 页面一律不认）。
 *
 * **端口不固定**：Android 外壳每次启动随机选端口（凭据与端口都轮换），所以这里
 * 只判"是不是 loopback + http"，不能把某个具体端口写死（写死会让本机页面再也
 * 打不开"本机模型设置"，而且是静默失效）。
 */
export function isNativeHostOrigin(origin?: string): boolean {
  const value = origin ?? (typeof location === "undefined" ? "" : location.origin);
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 取原生桥；不存在 / 形状不对 / 不在 loopback 页面 ⇒ null。
 *
 * 形状检查是"能力探测"而不是"信任"：真正的权限边界在原生侧（每个方法复核 origin）。
 * `origin` 参数只给判据用（happy-dom 的 location 不是手机壳的地址）。
 */
export function getNativeBridge(origin?: string): CodemNativeBridge | null {
  if (!isNativeHostOrigin(origin)) return null;
  const candidate = (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_NAME];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const bridge = candidate as Partial<CodemNativeBridge>;
  if (typeof bridge.openLlmSettings !== "function") return null;
  if (typeof bridge.getLlmSettingsSummary !== "function") return null;
  return bridge as CodemNativeBridge;
}

const KEY_STATES = new Set(["keystore", "legacy", "unreadable", "none"]);

/**
 * 解析原生摘要。
 *
 * 字段一律**按白名单**取：原生侧将来多返回一个字段（哪怕是秘密）也不会自动流进 DOM。
 */
export function parseLlmSettingsSummary(raw: unknown): LlmSettingsSummary | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keyState = typeof record.keyState === "string" ? record.keyState : "";
  if (!KEY_STATES.has(keyState)) return null;
  return {
    configured: record.configured === true,
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl : "",
    model: typeof record.model === "string" ? record.model : "",
    hasKey: record.hasKey === true,
    keyState: keyState as LlmSettingsSummary["keyState"],
    insecureHttp: record.insecureHttp === true,
  };
}

/** 读摘要；桥抛错/返回畸形都收敛成 null（面板显示"读取不到"，不是白屏） */
export function readLlmSettingsSummary(bridge: CodemNativeBridge): LlmSettingsSummary | null {
  try {
    return parseLlmSettingsSummary(bridge.getLlmSettingsSummary());
  } catch {
    return null;
  }
}

/** 给面板显示用的短文案（不含任何秘密） */
export function keyStateLabel(summary: LlmSettingsSummary): string {
  if (summary.keyState === "keystore") return "已加密保存";
  if (summary.keyState === "legacy") return "明文（建议重新保存）";
  if (summary.keyState === "unreadable") return "无法解密，请重新输入";
  return "未保存";
}
