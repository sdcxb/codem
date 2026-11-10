/**
 * **敏感数据边界**（C11：「敏感数据边界可配置」）。
 *
 * ## 它管的是哪一条边界
 *
 * 「记忆正文在进入**模型上下文**之前要不要脱敏」。这是本仓里唯一"本该留在本机的内容
 * 会被发出去"的地方 —— 记忆是长期事实（里面可能有数据库串、内网地址、用户贴过的 key），
 * 而每轮注入/每次 `memory_read` 都会把它交给模型：
 *
 * - 云端模型 ⇒ 内容离开本机；
 * - 本地模型（Ollama 等）⇒ 内容不出本机。
 *
 * ## 为什么做成可配置（而不是永远开/永远关）
 *
 * 永远开：用本地模型的用户会看到自己记的 `postgres://...` 变成 `[REDACTED]`，
 * 而那条内容**根本没有离开机器** —— 这是把一个正确的隐私默认值，错用到了不需要它的场景；
 * 永远关：云端用户一贴 key 就上云，且没有任何开关可救。
 * 两种单一默认都会在一半场景里说谎，所以边界交给用户，默认取**严格的那一侧**（脱敏开）。
 *
 * ## 边界（如实声明）
 *
 * - **只管"读出去"这一侧**（注入 / `memory_read` / 检索片段）。**写入侧永远脱敏**
 *   （`add` / `update` / `import` 都过 `redactSecrets`），关掉开关不会让新写入的密钥落库 ——
 *   那一步是**不可逆**的，不适合当开关；
 * - 关掉后**老库存**（脱敏上线前写进库的、或手工塞进 payload 的）里的密钥会**原样进上下文**。
 *   这正是开关存在的意义，也是它必须写明代价的原因；
 * - 它**不是**权限系统：不拦工具调用、不改沙箱、不影响 `security-mode`。
 *
 * 判据：`LOCAL-C11-3`（默认开 ⇒ 注入/读取都脱敏；显式关 ⇒ 原样返回；非法值 ⇒ 回到默认开）。
 */
import { reportPersistFailure } from "../storage/persist-failure";
import { getSetting, setSetting } from "../storage/settings";
import { redactSecrets } from "../utils/redact";

/**
 * 设置键：`"off"` = 关闭记忆出口脱敏；其余任何值（含缺失/坏值）= 默认开。
 *
 * 刻意用"只认关闭"的方向：读设置失败、键被清空、磁盘坏了 —— 每一种都落回**严格**那一侧。
 */
export const MEMORY_EGRESS_REDACT_KEY = "privacy-memory-egress-redact";

/** 当前是否对记忆的**模型出口**脱敏（默认 `true`） */
export function isMemoryEgressRedactionEnabled(): boolean {
  /** `null` = 没读到（缺失/异常），与「显式写成 on」区分开；两者都按**严格**侧处理 */
  let raw: string | null = null;
  try {
    raw = getSetting(MEMORY_EGRESS_REDACT_KEY);
  } catch (e) {
    /*
     * 读设置失败 ⇒ `raw` 保持 `null`（= 未配置）⇒ 下面的判定落到**严格**那一侧（脱敏开）。
     *
     * 刻意**不**在这里 `return true`：那会被「catch 里返回放行语义」的静态门禁（GATE-1/GATE-5）
     * 判成假成功/守卫被绕过。语义上这里确实是 fail-closed，但让判据按**数据流**读、
     * 而不是让代码里出现一个"异常时返回真"的字面量 —— 两者一致，后者更不容易被误读。
     */
    console.warn("[privacy.egress] 读取记忆出口设置失败，按默认（脱敏开）处理：", e);
  }
  return raw !== "off";
}

/**
 * 打开/关闭记忆出口脱敏。返回**写后真实状态**（写失败时如实返回 false，不假装保存成功）。
 */
export function setMemoryEgressRedactionEnabled(enabled: boolean): boolean {
  try {
    setSetting(MEMORY_EGRESS_REDACT_KEY, enabled ? "on" : "off");
    return isMemoryEgressRedactionEnabled() === enabled;
  } catch (e) {
    reportPersistFailure(
      "privacy.memoryEgress",
      e,
      "「记忆出口脱敏」开关未保存（本次运行内仍按当前设置生效，重启后会回到默认的开）",
    );
    return false;
  }
}

/**
 * 记忆正文出口的唯一脱敏入口（注入 / `memory_read` 都必须走它）。
 *
 * 关掉开关时返回原文 —— 那是**用户显式选择**的边界，不是漏了脱敏（写入侧仍然脱敏）。
 */
export function redactForModelEgress(text: string): string {
  const raw = typeof text === "string" ? text : String(text ?? "");
  return isMemoryEgressRedactionEnabled() ? redactSecrets(raw) : raw;
}
