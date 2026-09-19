/**
 * 解封后的密钥**内存缓存**（第 62 轮）。
 *
 * ## 为什么单独一个文件（而不是塞进 secret-store.ts）
 *
 * `settings.ts::getSettingJSON` 需要对 `codem-settings` 这一个键做**水合**（把磁盘上的密文
 * 换成内存里的明文），于是它必须能读到缓存 —— 而缓存又需要 `settings.ts` 来读原始 settings。
 * 若把两者写在一个模块里就是**循环依赖**。所以这里只放"缓存 + 查表"这两件不依赖任何东西的事：
 *
 * ```text
 * secret-cache.ts  ←  settings.ts（水合时查表）
 *        ↑
 *   secret-store.ts（启动解封 / 迁移，读原始 settings 走 settings.ts）
 * ```
 *
 * ## 为什么水合放在 `getSettingJSON` 里，而不是改 18 个读点
 *
 * 真机全仓清点：生产代码里直接读 `codem-settings` 的地方有 **18 处**（`App.tsx` 8、
 * `model-config.ts` 3、`fact-check.ts` 2、`web-search.ts`、`ContextMonitor`、`ModelProfilePanel`、
 * `MultimodalPanel`、`SettingsPanel`），而且**全是同步读**。
 *
 * 逐个改的风险是**漏一处**：漏掉的那个 provider 会"界面显示已配置、请求却没有 key" ——
 * 这是本仓库最怕的那类静默失真。所以选择在**唯一的水合点**做：读到的 `providers[].apiKey`
 * 一律是"内存里的明文"，所有读点一行都不用改。取舍如实写在这里：
 * **代价**是 `getSettingJSON("codem-settings")` 这一个键有了"会水合"的额外语义 ——
 * 因此它被写成显式规则（`settings.ts` 里就地注释）+ 由 `credential-seal.test.ts` 守着：
 * 水合**只**对这一个键生效，其它键一个字都不许动。
 */

const cache = new Map<string, string>();
/**
 * providerId → 该明文**当初的那份密文**（第 62 轮补，见 `secret-write-guard.ts`）。
 *
 * 为什么必须把两者配成一对：设置面板与启动流程里有 **14 处**「读整份 `codem-settings`
 * → 改一个字段 → 整份写回」的读改写（`App.tsx` 3 处、`SettingsPanel.tsx` 11 处），
 * 而读出来的那份是**水合过的**（`apiKey` 是内存里的明文）。
 * 于是每一次"改模型 / 改模式"都会把明文**重新写回磁盘** —— 真机实测：封存成功后
 * 库里同时存在 `apiKey`（明文 35 字符）和 `apiKeySealed`。
 * 有了这一对，写回路径就能**同步**地把"还是原来那把密钥"的明文换回它自己的密文
 * （不需要再跑一次加密）。
 */
const sealedBlobs = new Map<string, string>();
const failed = new Set<string>();

let hydrated = false;
let backend: boolean | null = null;

export function cacheSealedKey(providerId: string, plaintext: string): void {
  if (!providerId || !plaintext) return;
  cache.set(providerId, plaintext);
}

/** 记下"这把明文对应的密文"（水合/迁移/回退时调用） */
export function cacheSealedBlob(providerId: string, sealed: string): void {
  if (!providerId || !sealed) return;
  sealedBlobs.set(providerId, sealed);
}

export function cachedSealedBlob(providerId: string): string | undefined {
  return sealedBlobs.get(providerId);
}

/** 忘掉某个 provider 的密文（用户把密钥退回明文 / 密文已从磁盘移除时调用） */
export function forgetSealedBlob(providerId: string): void {
  if (providerId) sealedBlobs.delete(providerId);
}

export function cachedSealedKey(providerId: string): string | undefined {
  return cache.get(providerId);
}

export function markSealedKeyUnreadable(providerId: string): void {
  if (providerId) failed.add(providerId);
}

export function isSealedKeyUnreadable(providerId: string): boolean {
  return failed.has(providerId);
}

/**
 * 撤销"解不开"的标记。**只有一种情况该调用**：密文已经被成功解回明文
 * （`revertSealedKeysToPlaintext`）—— 此时磁盘上不再有密文，
 * 留着旧标记会让界面继续显示"这个 provider 的密钥解不开"，属于过期结论。
 */
export function clearSealedKeyUnreadable(providerId: string): void {
  if (providerId) failed.delete(providerId);
}

export function isHydrationDone(): boolean {
  return hydrated;
}

export function markHydrationDone(): void {
  hydrated = true;
}

export function setBackendAvailability(v: boolean): void {
  backend = v;
}

export function backendAvailability(): boolean | null {
  return backend;
}

/** 测试用：清空全部内存状态 */
export function __resetSecretCacheForTests(): void {
  cache.clear();
  sealedBlobs.clear();
  failed.clear();
  hydrated = false;
  backend = null;
}
