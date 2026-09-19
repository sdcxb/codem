/**
 * 凭据的**写回闸门**（第 62 轮；真机复量抓出来的缺陷的修法）。
 *
 * ## 缺陷本体（不是推演出来的，是真机上量到的）
 *
 * 封存（阶段 1）之后，真机复量的结论是：
 *
 * ```text
 * [secrets] 已把 1 个 provider 的密钥改为系统加密保存
 * [secrets] 已回收旧明文的字节残留（WAL 折叠 + 整库重写）
 * CLI 直读库文件：has apiKey: True（sk- 前缀，长 35）  has apiKeySealed: True（长 529）
 * ```
 *
 * 也就是说：**封存被自己写的另一段代码撤销了**。原因是本仓库里有一类非常常见的写法
 * ——「读整份 `codem-settings` → 改一个字段 → 整份写回」——全项目 **14 处**
 * （`App.tsx` 3 处：同步模型/模式；`SettingsPanel.tsx` 11 处：各设置项保存），
 * 而**读出来的那份是水合过的**（`providers[].apiKey` 是内存里的明文）。
 * 于是"改一下模型名"就等于"把明文密钥重新写回磁盘"。
 *
 * 这不是"某个调用点写错了"，而是**读语义与写语义不对称**：
 * 读到的是明文（为了兼容 18 个同步读点），写回时却没人把密文换回去。
 * 只改 14 个调用点里的某一个，下一个新增的设置项又会踩进来。
 *
 * ## 修法：把不变量放在**写路径**上（唯一收口）
 *
 * 写 `codem-settings` 时**同步**做一次"回封"：
 *
 * 1. 若某个 provider 的 `apiKey` 与缓存里记的明文**一模一样**（= 就是原来那把密钥，
 *    只是被水合成了明文），就把 `apiKey` 换回**它自己那份密文**（缓存里有，**不需要再加密**）；
 * 2. 若 `apiKey` 是**新填的/改过的**（缓存里没有对应的密文），先按原样写下去
 *    （**绝不能让用户刚输入的密钥丢失**），然后**异步补封存**并再写一次；
 * 3. 用户显式选择了明文路径（`codem-secrets-plaintext`）时**一步都不做**；
 * 4. 系统加密不可用时**不做**（保持明文 + 由启动流程如实上报）。
 *
 * ## 为什么不是"在 settings.ts 里直接调 secret-store"
 *
 * `secret-store.ts` 依赖 `settings.ts`（要读原始 settings），反向 import 就是**循环依赖**。
 * 所以这里只做"纯函数 + 注入"：本模块**不认识** settings，也不做 IPC；
 * 真正的封存动作由 `secret-store.ts` 在模块初始化时注册进来（`installCredentialWriteGuard`）。
 * 没有注册（例如只跑单元测试、或某个入口没引到 secret-store）时，闸门**什么都不改**
 * —— 默认行为与改动前完全一致，不会凭空改变别人的写入。
 */

import { cachedSealedBlob, cachedSealedKey } from "./secret-cache";

export const SETTINGS_KEY = "codem-settings";
export const PLAINTEXT_FIELD = "apiKey";
export const SEALED_FIELD = "apiKeySealed";

/** 闸门必须知道的两件事，由 `secret-store.ts` 注册（避免循环依赖） */
export interface CredentialWriteGuardHooks {
  /** 现在允许回封吗（后端可用 && 用户没选明文路径） */
  allowed: () => boolean;
  /** 异步补封存：入参是"还是明文的 provider id" */
  sealPending: (providerIds: string[]) => Promise<void>;
}

let hooks: CredentialWriteGuardHooks | null = null;

export function installCredentialWriteGuard(h: CredentialWriteGuardHooks): void {
  hooks = h;
}

/** 测试用 */
export function __resetCredentialWriteGuardForTests(): void {
  hooks = null;
  pending.clear();
  sealing = null;
}

/**
 * 测试用：等到"补封存"这一轮跑完。
 *
 * 为什么要暴露它：补封存是**异步**的（要发 IPC），而写回是同步的 ——
 * 用例要能验证"写下去之后就自动补上了"，而不是靠 sleep 猜时间。
 */
export async function __awaitCredentialResealForTests(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const current = sealing;
    if (!current) return;
    await current.catch(() => {});
  }
}

const pending = new Set<string>();
let sealing: Promise<void> | null = null;

export interface PreparedSettingsWrite<T> {
  /** 真正要落盘的值 */
  value: T;
  /** 被换回密文的 provider 数（>0 = 这次写回本来会泄露明文） */
  resealed: number;
  /** 仍是明文、需要异步补封存的 provider id */
  pendingSeal: string[];
}

/**
 * 写 `codem-settings` 之前的**同步**处理（纯函数：不改缓存、不发 IPC）。
 *
 * 非对象 / 没有 providers 时原样返回（**不许**因为形状意外就把值改坏）。
 */
export function prepareSettingsWrite<T>(value: T): PreparedSettingsWrite<T> {
  if (!hooks || !hooks.allowed()) return { value, resealed: 0, pendingSeal: [] };
  if (!value || typeof value !== "object") return { value, resealed: 0, pendingSeal: [] };
  const providers = (value as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return { value, resealed: 0, pendingSeal: [] };

  let resealed = 0;
  const pendingSeal: string[] = [];
  const next = providers.map((p) => {
    if (!p || typeof p !== "object") return p;
    const rec = p as Record<string, unknown>;
    const id = String(rec.id ?? "");
    const plain = typeof rec[PLAINTEXT_FIELD] === "string" ? (rec[PLAINTEXT_FIELD] as string) : "";
    if (!id || !plain) return p;
    // ① 就是原来那把密钥 ⇒ 换回它自己的密文（同步、零 IPC）
    const blob = cachedSealedBlob(id);
    if (blob && cachedSealedKey(id) === plain) {
      const { [PLAINTEXT_FIELD]: _drop, ...rest } = rec;
      resealed += 1;
      return { ...rest, [SEALED_FIELD]: blob };
    }
    // ② 新填/改过的密钥 ⇒ 先照原样写下去（不许丢），随后异步补封存
    //    （能走到这里就说明它与缓存里的明文不同：要么是新密钥，要么磁盘上那份密文已经作废）
    pendingSeal.push(id);
    return p;
  });

  if (resealed === 0 && pendingSeal.length === 0) return { value, resealed: 0, pendingSeal: [] };
  return {
    value: { ...(value as Record<string, unknown>), providers: next } as T,
    resealed,
    pendingSeal,
  };
}

/**
 * 记下"这些 provider 还是明文"，并触发一次**单飞**的异步补封存。
 *
 * 单飞的理由：设置面板连续保存多个字段时会有多次写入，若每次都排一个补封存，
 * 就会出现"后一次读到的是前一次已封存的值"这种自相竞争的写。
 */
export function scheduleCredentialReseal(providerIds: string[]): void {
  if (!hooks || !hooks.allowed()) return;
  for (const id of providerIds) pending.add(id);
  if (sealing !== null) return;
  const ids = [...pending];
  sealing = hooks
    .sealPending(ids)
    .catch((e) => {
      // 不静默：补封存失败必须留痕（调用方/日志能看到"明文还在盘上"）
      console.warn("[secrets] 补封存失败（明文仍在盘上，下次写入或下次启动会重试）:", e);
    })
    .finally(() => {
      sealing = null;
      for (const id of ids) pending.delete(id);
      // 期间又来了新的（新填的密钥），再来一轮
      if (pending.size > 0) scheduleCredentialReseal([...pending]);
    });
}

/**
 * `setSettingJSON` 的入口：过闸门后返回**真正要落盘的 JSON 文本**。
 *
 * 单独一个函数是为了让"过闸门"这件事只有一个实现 —— 目前有两条写入路径需要它
 * （`settings.ts::setSettingJSON`，以及损坏库恢复时的裸写 `recovery-restore.ts`）。
 */
export function gateSettingsWrite(key: string, value: unknown): string {
  if (key !== SETTINGS_KEY) return JSON.stringify(value);
  const prepared = prepareSettingsWrite(value);
  if (prepared.resealed > 0 || prepared.pendingSeal.length > 0) {
    console.log(
      `[secrets] 写回 codem-settings 时：${prepared.resealed} 个 provider 的明文被换回密文、` +
        `${prepared.pendingSeal.length} 个新明文待补封存（不打印任何值）`,
    );
  }
  if (prepared.pendingSeal.length > 0) scheduleCredentialReseal(prepared.pendingSeal);
  return JSON.stringify(prepared.value);
}

/**
 * 给"手里已经是 JSON 文本"的裸写路径用（`recovery-restore.ts` 从损坏库恢复设置）。
 *
 * 为什么也要过一次：那条路径写 `codem-settings` 用的是 `setSetting(key, value)`（裸写），
 * 绕过了 `setSettingJSON`。被恢复的那份是**旧库里的原文**，很可能带着明文 `apiKey`
 * —— 不设防的话，"从损坏库恢复"就等于"把明文密钥又请回来"（而且是静默的）。
 * 解析不了就原样返回（**不猜**，也不因为形状意外就把用户的数据改坏）。
 */
export function gateSettingsRawWrite(key: string, raw: string): string {
  if (key !== SETTINGS_KEY) return raw;
  try {
    return gateSettingsWrite(key, JSON.parse(raw));
  } catch {
    return raw;
  }
}
