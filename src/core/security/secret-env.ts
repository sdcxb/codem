/**
 * 子进程密钥环境剥离的**前端策略面**（第 17 轮）。
 *
 * 真正的过滤在 Rust（`src-tauri/src/secret_env.rs`），规则唯一来源是同目录的
 * `secret-env-patterns.json`（Rust `include_str!` 编译期读取）。这里只做三件事：
 * 1. 设置键与默认值（默认 **不继承** = 剥离）；
 * 2. 启动时把开关推给 Rust（Rust 侧默认也是 strip，推不推都不会静默放行）；
 * 3. 给 TS 判据一个与 JSON 同源的分类函数（判据与实现不各写一套正则）。
 */
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "../storage/settings";
import patterns from "./secret-env-patterns.json";

/** 设置键：`"true"` = 允许子进程整份继承宿主环境（不推荐） */
export const INHERIT_SECRET_ENV_KEY = "codem-inherit-secret-env";

interface SecretEnvPatterns {
  keepExact: string[];
  keepProxyWithoutUserinfo: string[];
  keepPrefix: string[];
  dropExact: string[];
  dropSuffixes: string[];
}

export const SECRET_ENV_PATTERNS = patterns as SecretEnvPatterns;

/** 默认 false（剥离）；只有显式写 `"true"` 才继承 */
export function isSecretEnvInheritEnabled(): boolean {
  try {
    return getSetting(INHERIT_SECRET_ENV_KEY) === "true";
  } catch {
    return false;
  }
}

export function setSecretEnvInheritEnabled(inherit: boolean): void {
  setSetting(INHERIT_SECRET_ENV_KEY, inherit ? "true" : "false");
}

/**
 * 把当前开关推给 Rust。
 *
 * 失败只警告：Rust 的缺省是 strip，推送失败只会更严格，不会静默放行。
 */
export async function pushSecretEnvPolicy(): Promise<boolean> {
  const inherit = isSecretEnvInheritEnabled();
  try {
    if (typeof window !== "undefined" && (window as any).__TAURI__) {
      await invoke("set_secret_env_policy", { inherit });
    }
  } catch (e) {
    console.warn("[secret-env] 推送子进程环境策略失败（保持默认 strip）:", e);
  }
  return inherit;
}

/**
 * 名字级分类（仅供 TS 判据/诊断；最终执行在 Rust）。
 *
 * 语义与 `secret_env::keep_in_strip_env` 对齐：denylist 一票否决 → allowlist → 默认剥。
 */
export function classifySecretEnvName(name: string, value = ""): "keep" | "drop" {
  const upper = String(name ?? "").toUpperCase();
  const p = SECRET_ENV_PATTERNS;
  for (const exact of p.dropExact) if (upper === exact.toUpperCase()) return "drop";
  for (const suffix of p.dropSuffixes) if (upper.endsWith(suffix.toUpperCase())) return "drop";
  if (p.keepProxyWithoutUserinfo.some((x) => x.toUpperCase() === upper)) {
    return value.includes("@") ? "drop" : "keep";
  }
  if (p.keepExact.some((x) => x.toUpperCase() === upper)) return "keep";
  for (const prefix of p.keepPrefix) if (upper.startsWith(prefix.toUpperCase())) return "keep";
  return "drop";
}
