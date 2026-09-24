/**
 * 凭据封存的水合与迁移（第 62 轮；方案 `docs/CREDENTIALS-PLAN.md` 阶段 1 的 ②③）。
 *
 * ## 分工（与 `secret-cache.ts` 的文件头一致）
 *
 * - `secret-cache.ts`：纯内存查表/写表；
 * - **本文件**：启动解封（读原始 settings → 逐个 `secret_unseal` → 写缓存）与**迁移**
 *   （明文 → 密文，顺序写死：**封存成功 → 一次原子写回 → 才清明文**）；
 * - `settings.ts`：唯一水合点（读 `codem-settings` 时用缓存里的明文替换密文）。
 *
 * ## 三条硬规则（= 方案第 5 节的验收判据）
 *
 * 1. **不可用不降级**：系统加密后端不可用 ⇒ **不改动任何东西**，继续明文，并把
 *    "这台机器没有可用的系统加密"变成可查事实（`backendAvailability()`）；
 * 2. **迁移要么全成要么不动**：任何一个 provider 封存失败 ⇒ **整体不改动**
 *    （避免出现"一半明文一半密文"的中间态）；
 * 3. **解封失败保留密文**：只记失败、**绝不删除**（换机器/换账户解不开是预期行为）。
 *
 * 另外两条（第 62 轮补，方案第 4 节的"回退"）：
 *
 * 4. **回退要用户显式开开关**：`revertSealedKeysToPlaintext()` 只在
 *    `codem-secrets-plaintext` 已打开时才动手（写入方在「设置 → 安全」里），
 *    且同样"一个解不开就整体不动"；
 * 5. **界面的说法必须有实况支撑**：`secretStorageStatus()` 是唯一给界面看的形态快照
 *    （明文几个 / 密文几个 / 解不开几个 / 后端可不可用），界面不许自己猜。
 */

import { getSetting, getSettingJSON, setSetting, setSettingJSON } from "./settings";
import { getStoragePort, hasStoragePort } from "./port";
import { installCredentialWriteGuard } from "./secret-write-guard";
import {
  backendAvailability,
  cacheSealedBlob,
  cacheSealedKey,
  cachedSealedKey,
  clearSealedKeyUnreadable,
  forgetSealedBlob,
  isHydrationDone,
  isSealedKeyUnreadable,
  markHydrationDone,
  markSealedKeyUnreadable,
  setBackendAvailability,
  __resetSecretCacheForTests,
} from "./secret-cache";

export { isSealedKeyUnreadable, backendAvailability } from "./secret-cache";
export const PLAINTEXT_FALLBACK_KEY = "codem-secrets-plaintext";
export const SEALED_FIELD = "apiKeySealed";
const SETTINGS_KEY = "codem-settings";

interface ProviderLike {
  id?: string;
  apiKey?: string;
  apiKeySealed?: string;
  [k: string]: unknown;
}

export interface HydrateOutcome {
  /** 解封成功的 provider 数 */
  unsealed: number;
  /** 解封失败（**密文已保留**）的 provider 数 */
  failed: number;
  /** 系统加密是否可用（false 时上两个数字都应为 0） */
  backend: boolean;
  /**
   * 设置面是否**真的读出来了**。
   *
   * `false` = 这次**没有读**（端口不在 / 未预热）：两个计数都是 0，但语义是"不知道"，
   * **不是**"没有密文"。这种情况下水合标记不会被打开，`ensureSecretsHydrated()` 会在
   * 设置面就绪后重来一次（否则密文永远不会被解封）。
   */
  settingsReady: boolean;
}

function invokeFn(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const tauri = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = tauri?.core?.invoke;
  return typeof invoke === "function"
    ? (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
    : null;
}

/** **原始** settings（不经水合）—— 迁移与解封必须看磁盘上真实的那份 */
function rawSettings(): { providers?: ProviderLike[] } & Record<string, unknown> {
  const raw = getSetting(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as { providers?: ProviderLike[] } & Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 设置面**读得出来吗**（第 62 轮补；这是"读失败不许塌成没有数据"那道闸）。
 *
 * ## 为什么必须有它
 *
 * 解封一进门就打水合标记（幂等）。若在设置面还没预热时跑，`getSetting` 返回的是
 * **兜底值**（`rust-port.ts` 的 `UNAVAILABLE: 配置面尚未预热`），于是：
 * "读到空 providers" → "没有密文" → **打上水合标记** → 密文**这一辈子都不会被解封**，
 * 界面上表现为"provider 显示已配置、请求却没有 key"。
 * 这正是本仓库反复踩的那类塌陷（读失败 ≠ 没有数据），所以判据取"读路径可用不可用"，
 * **不取结果是不是空**。
 *
 * 判据用 `hasStoragePort()`：真端口的不变量是"注册那一刻设置面已经预热完毕"
 * （`port.ts:280-284`：`RustStoragePort.start()` 先 `await config.warmup()` 再 `setStoragePort`），
 * 所以"端口在"就是"设置读得到"；没有端口是**唯一**会返回兜底值的形态。
 */
function settingsFaceReady(): boolean {
  if (!hasStoragePort()) return false;
  try {
    const stats = (getStoragePort() as { config?: { stats?: () => { warmed?: boolean } } }).config?.stats?.();
    // 明确报"未预热"就不许当读到了；拿不到 stats 不构成拒绝工作的理由（仪器缺失 ≠ 不可用）
    return stats?.warmed !== false;
  } catch {
    return false;
  }
}

/** 这台机器能不能封存（问一次，记住答案；问不到就是不能，**不猜**） */
export async function isSealAvailable(): Promise<boolean> {
  const cached = backendAvailability();
  if (cached !== null) return cached;
  const invoke = invokeFn();
  if (!invoke) {
    setBackendAvailability(false);
    return false;
  }
  try {
    const ok = (await invoke("secret_backend_available")) === true;
    setBackendAvailability(ok);
    return ok;
  } catch {
    setBackendAvailability(false);
    return false;
  }
}

/** 用户是否显式要求走明文（回退开关；渲染侧读不到环境变量，所以用设置项） */
function plaintextFallbackEnabled(): boolean {
  try {
    return getSettingJSON<boolean>(PLAINTEXT_FALLBACK_KEY, false) === true;
  } catch {
    return false;
  }
}

/** 启动解封：把磁盘上的密文解进内存缓存（幂等；每个 provider 只试一次） */
export async function hydrateSealedProviderKeys(): Promise<HydrateOutcome> {
  const out: HydrateOutcome = { unsealed: 0, failed: 0, backend: false, settingsReady: false };
  if (isHydrationDone()) return { ...out, settingsReady: true };
  // ⚠️ 读不出来就**什么都不做**（尤其**不许**打水合标记）——见 `settingsFaceReady()`。
  if (!settingsFaceReady()) return out;
  markHydrationDone();
  out.settingsReady = true;

  const providers = Array.isArray(rawSettings().providers) ? rawSettings().providers! : [];
  const sealed = providers.filter((p) => typeof p?.apiKeySealed === "string" && p.apiKeySealed);
  // 后端结论**每次启动都要问一次**（而不是"有密文才问"）：界面要用它解释
  // "为什么这台机器上的密钥是明文"，问不到就不猜（见 `isSealAvailable` 的注释）。
  const backend = await isSealAvailable();
  out.backend = backend;
  if (sealed.length === 0) return out;

  const invoke = invokeFn();
  if (!invoke) {
    for (const p of sealed) {
      const id = String(p.id ?? "");
      if (id) markSealedKeyUnreadable(id);
      out.failed += 1;
    }
    return out;
  }
  for (const p of sealed) {
    const id = String(p.id ?? "");
    try {
      const reply = (await invoke("secret_unseal", { sealed: p.apiKeySealed })) as { plaintext?: string } | null;
      const plain = typeof reply?.plaintext === "string" ? reply.plaintext : "";
      if (!plain) throw new Error("解封返回空");
      cacheSealedKey(id, plain);
      // 明文与"它自己那份密文"配成一对：写回闸门据此把读改写里的明文换回密文（见 secret-write-guard.ts）
      cacheSealedBlob(id, String(p.apiKeySealed));
      out.unsealed += 1;
    } catch {
      // 规则 3：保留密文，只记失败
      if (id) markSealedKeyUnreadable(id);
      out.failed += 1;
    }
  }
  return out;
}

/**
 * **单飞**解封：全进程只跑一次，谁先来谁触发，后来者等同一个 promise。
 *
 * 为什么必须有这个入口（而不是各处直接 `hydrateSealedProviderKeys()`）：
 * 读点是**同步**的（18 处 `getSettingJSON("codem-settings")`），没法 `await`；
 * 而"要用 key 去配置引擎"的地方是**异步**的（`App.tsx::configureEngine`）。
 * 那个异步点必须能等到解封结束 —— 否则它读到的 `providers[].apiKey` 是空的
 * （磁盘上只有 `apiKeySealed`），于是变成"界面显示已配置、请求却没有 key"。
 *
 * ⚠️ **只能在"settings 读得出来"之后调用**：`hydrateSealedProviderKeys()` 一进来就
 * 打水合标记（幂等），若在 DB 就绪前跑，它会读到空 settings 却把标记打上，
 * 于是密文**永远不会**被解封。调用点（`configureEngine`）已经用
 * "`getSettingJSON("codem-settings")` 是否为 null"做了这道判断。
 */
export function ensureSecretsHydrated(): Promise<HydrateOutcome> {
  if (!hydrationPromise) {
    hydrationPromise = hydrateSealedProviderKeys().then((out) => {
      /**
       * 设置面还没就绪 ⇒ 这次等于**没读**：把单飞记忆清掉，
       * 等下一次调用（设置面就绪之后）真的解封一次。
       * 不清的话，一个"太早问出来的不知道"会被永久记住 —— 那就是静默失真。
       */
      if (!out.settingsReady) hydrationPromise = null;
      return out;
    });
    // 真抛了也要清掉记忆，否则一次异常会被永久缓存（后续调用拿到同一个失败）
    hydrationPromise = hydrationPromise.catch((e) => {
      hydrationPromise = null;
      throw e;
    });
  }
  return hydrationPromise;
}

let hydrationPromise: Promise<HydrateOutcome> | null = null;

export interface MigrateOutcome {
  sealed: number;
  skippedUnavailable: number;
  skippedByChoice: number;
  failed: number;
  /**
   * 「明文与密文**并存**」的脏行被清掉的数量（第 62 轮补；真机复量抓到的状态）。
   *
   * 这种行是**封存被随后的读改写撤销**留下的（`apiKey` 明文 + `apiKeySealed` 密文同时在）：
   * 两者指的是**同一把密钥**时不需要再加密，只是把多余的那份明文删掉 ⇒ 记在这里，
   * 与"新封存了几个"分开计数（否则上报的数字会骗人）。
   */
  cleanedDuplicate: number;
}

/**
 * 迁移：明文 `apiKey` → 密文 `apiKeySealed`（**顺序写死**，见文件头规则 2）。
 *
 * 返回的计数用于如实上报；`skippedUnavailable > 0` 时界面应当能说出原因。
 */
export async function migrateProviderKeysToSealed(): Promise<MigrateOutcome> {
  const out: MigrateOutcome = { sealed: 0, skippedUnavailable: 0, skippedByChoice: 0, failed: 0, cleanedDuplicate: 0 };
  const settings = rawSettings();
  const providers = Array.isArray(settings.providers) ? settings.providers! : [];

  /**
   * ## 两类待处理的行（第 62 轮补：第二类是真机复量抓出来的）
   *
   * ① `apiKey` 有、`apiKeySealed` 没有 ⇒ 正常迁移（要加密）；
   * ② **两者都有** ⇒ 脏行。它只可能来自"封存之后又被读改写撤销"（见 `secret-write-guard.ts`），
   *    本版起写路径有闸门不会再产生，但**真机上已经存在的那份必须收拾**：
   *    若缓存里那把明文就是磁盘上这把（= 密文与明文指同一把密钥）⇒ 直接删掉多余的明文，**零 IPC**；
   *    若明文与缓存的不是同一把（用户后来换了密钥）⇒ 旧密文已作废，按"新明文"重新封存。
   */
  const plaintextOnes = providers.filter((p) => typeof p?.apiKey === "string" && p.apiKey && !p.apiKeySealed);
  const duplicates = providers.filter(
    (p) => typeof p?.apiKey === "string" && p.apiKey && typeof p?.apiKeySealed === "string" && !!p.apiKeySealed,
  );
  const dropPlaintext = new Set<string>();
  const resealTargets: typeof plaintextOnes = [];
  for (const p of duplicates) {
    const id = String(p.id ?? "");
    if (!id) continue;
    if (cachedSealedKey(id) === p.apiKey) dropPlaintext.add(id); // 同一把密钥 ⇒ 只需删明文
    else if (!isSealedKeyUnreadable(id)) resealTargets.push(p); // 密钥换过 ⇒ 重新封存
  }
  const targets = [...plaintextOnes, ...resealTargets];
  if (targets.length === 0 && dropPlaintext.size === 0) return out;

  // 用户显式要明文：连"删掉多余明文"都不做（他要的就是明文，动它等于反向改用户的存储决策）
  if (plaintextFallbackEnabled()) {
    out.skippedByChoice = targets.length;
    return out;
  }

  // ① 只删明文的那些（同一把密钥的重复）不需要后端 —— 先做，且不受后端可用性影响
  const applyDropPlaintext = (map: (p: ProviderLike) => ProviderLike) =>
    providers.map((p) => (dropPlaintext.has(String(p.id ?? "")) ? map(p) : p));

  if (targets.length === 0) {
    const next: Record<string, unknown> = {
      ...settings,
      providers: applyDropPlaintext((p) => {
        const { apiKey: _drop, ...rest } = p;
        return rest;
      }),
    };
    setSetting(SETTINGS_KEY, JSON.stringify(next));
    out.cleanedDuplicate = dropPlaintext.size;
    return out;
  }

  if (!(await isSealAvailable())) {
    out.skippedUnavailable = targets.length;
    return out;
  }
  const invoke = invokeFn();
  if (!invoke) {
    out.skippedUnavailable = targets.length;
    return out;
  }

  // ② 逐个封存（只在内存里攒结果，磁盘还没动）
  const sealedById = new Map<string, { sealed: string; plain: string }>();
  for (const p of targets) {
    const id = String(p.id ?? "");
    try {
      const reply = (await invoke("secret_seal", { plaintext: p.apiKey })) as { sealed?: string } | null;
      const sealed = typeof reply?.sealed === "string" ? reply.sealed : "";
      if (!sealed) throw new Error("封存返回空");
      sealedById.set(id, { sealed, plain: String(p.apiKey) });
    } catch {
      out.failed += 1;
    }
  }
  if (out.failed > 0 || sealedById.size !== targets.length) {
    // 规则 2：一个失败就整体不动（连"删多余明文"也不做 —— 一次写入只表达一个状态）
    return {
      sealed: 0,
      skippedUnavailable: out.skippedUnavailable,
      skippedByChoice: out.skippedByChoice,
      failed: targets.length,
      cleanedDuplicate: 0,
    };
  }

  // ③ 一次性原子写回：密文进、明文出（含第 ① 类"只删明文"的行）
  const next: Record<string, unknown> = {
    ...settings,
    providers: providers.map((p) => {
      const id = String(p.id ?? "");
      // 同一把密钥的重复明文：只删明文（密文已经在上面）
      if (dropPlaintext.has(id)) {
        const { apiKey: _drop, ...rest } = p;
        return rest;
      }
      const entry = sealedById.get(id);
      if (!entry) return p; // 与本次无关的 provider 一个字都不动
      const { apiKey: _drop, ...rest } = p;
      return { ...rest, [SEALED_FIELD]: entry.sealed };
    }),
  };
  /**
   * **刻意走裸写**（`setSetting` 而非 `setSettingJSON`）：这一份 `next` 是"加密状态的权威表达"，
   * 它已经由本函数自己算好了明文/密文该是什么样。若走 `setSettingJSON`，写回闸门会按缓存里的
   * 旧密文/旧明文再"纠正"一次 —— 于是回退（明文）会被立刻改回密文、迁移也会多绕一圈。
   * 闸门是给**别处那 14 处读改写**用的，不是给这里用的。
   */
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  out.cleanedDuplicate = dropPlaintext.size;

  // ③ 写回之后才更新缓存（此后读点仍拿得到明文）
  for (const [id, entry] of sealedById) {
    cacheSealedKey(id, entry.plain);
    cacheSealedBlob(id, entry.sealed);
  }
  out.sealed = sealedById.size;
  return out;
}

/**
 * **补封存**：把 settings 里"还是明文"的 provider 封存掉（写回闸门的异步那一半）。
 *
 * 触发场景只有一个：用户在设置面板里**新填/改了** API key —— 那一刻密钥只存在于明文，
 * 必须先落盘（绝不能丢用户刚输入的东西），再回来加密。所以这里的顺序与迁移一致：
 * **全部封存成功 → 一次性原子写回 → 才清明文**；任一失败就整体不动（保留明文，下次重试）。
 */
async function sealPendingProviders(providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  if (!settingsFaceReady()) return; // 读不出来就不动（与解封同一条闸）
  if (plaintextFallbackEnabled()) return; // 用户显式要明文
  if (!(await isSealAvailable())) return; // 没有后端：保持明文（启动流程会如实上报）

  const invoke = invokeFn();
  if (!invoke) return;

  const settings = rawSettings();
  const providers = Array.isArray(settings.providers) ? settings.providers! : [];
  const wanted = new Set(providerIds);
  /**
   * 目标 = 这些 provider 里"明文与缓存里的那把**不是同一把**"的行。
   *
   * 不写成 `!p.apiKeySealed`：用户换了密钥时，磁盘上可能还留着**上一把**的密文
   * （陈旧密文 + 新明文并存的脏行）—— 那种行同样要重新封存，否则旧密文会被当成本次的结果。
   */
  const targets = providers.filter((p) => {
    const id = String(p.id ?? "");
    if (!wanted.has(id)) return false;
    if (typeof p.apiKey !== "string" || !p.apiKey) return false;
    return cachedSealedKey(id) !== p.apiKey;
  });
  if (targets.length === 0) return;

  const sealedById = new Map<string, { sealed: string; plain: string }>();
  for (const p of targets) {
    const id = String(p.id ?? "");
    try {
      const reply = (await invoke("secret_seal", { plaintext: p.apiKey })) as { sealed?: string } | null;
      const sealed = typeof reply?.sealed === "string" ? reply.sealed : "";
      if (!sealed) throw new Error("封存返回空");
      sealedById.set(id, { sealed, plain: String(p.apiKey) });
    } catch {
      /* 循环外统一判定：一个失败就整体不动 */
    }
  }
  if (sealedById.size !== targets.length) {
    console.warn(
      `[secrets] 补封存未完成：${targets.length - sealedById.size} 个 provider 封存失败，` +
        "本次未改动任何密钥（明文仍在盘上，下次写入或下次启动会重试）",
    );
    return;
  }

  // 先更新缓存（这样紧接着的写回闸门能把明文换回密文），再一次原子写回
  for (const [id, entry] of sealedById) {
    cacheSealedKey(id, entry.plain);
    cacheSealedBlob(id, entry.sealed);
  }
  const next: Record<string, unknown> = {
    ...settings,
    providers: providers.map((p) => {
      const entry = sealedById.get(String(p.id ?? ""));
      if (!entry) return p;
      const { apiKey: _drop, ...rest } = p;
      return { ...rest, [SEALED_FIELD]: entry.sealed };
    }),
  };
  // 与迁移同理：这是加密状态的权威写，走裸写绕过写回闸门（见迁移里那段说明）
  setSetting(SETTINGS_KEY, JSON.stringify(next));
  console.log(`[secrets] 已补封存 ${sealedById.size} 个 provider 的新密钥（明文已从 settings 移除）`);
}

/** 测试用：清空内存状态（缓存 + 水合标记 + 后端结论 + 单飞 promise） */
export function __resetSecretStoreForTests(): void {
  __resetSecretCacheForTests();
  hydrationPromise = null;
}

/**
 * 把**旧明文的字节残留**从库文件里回收掉（第 62 轮；真机字节级测量发现的问题）。
 *
 * ## 为什么"行级封存成功"还不等于"磁盘上没有明文"
 *
 * 真机字节级计数（`.preview-shot/survey-credential-paths.mjs`，改造前的 1.16.101）：
 *
 * ```text
 * codem-db-rust.bin（19.51 MB）：gho_×3 sk-×1
 * codem-db-rust.bin-wal（3.96 MB）：sk-×27      ← 运行期的 WAL 里全是刚写过的明文
 * codem-db.bin（旧库，10.62 MB）：gho_×3 sk-×4
 * ```
 *
 * 也就是说：迁移把**行**换成密文之后，被替换掉的那份明文仍然可能躺在
 * ①WAL 的旧帧里、②主库文件的**空闲页**里（SQLite 不擦除被释放的页）。
 * 只做行级封存而声称"磁盘上不再有明文"，就是**印出来不是真的**。
 *
 * ## 做法（两步，都是有界且一次性的）
 *
 * 1. `checkpoint`（引擎侧是 `PRAGMA wal_checkpoint(TRUNCATE)`）——把 WAL 折叠回主库并**截断 WAL**，
 *    于是 WAL 里的明文帧随之消失；
 * 2. `storage.compact { force: true }`（引擎侧是整库 `VACUUM`）——整库重写，
 *    空闲页里的旧字节被新镜像覆盖；
 * 3. 再 `checkpoint` 一次：VACUUM 的新镜像也要经 WAL 落盘，折一次才算真的写进主库。
 *
 * ## 代价与边界（如实写）
 *
 * - 整库重写需要与库等量的临时空间，期间占住单写者锁；**只在"这一次启动真的封存过东西"时才跑**
 *   （一台机器一辈子一次），不做成常态（`maintenance.ts::compactStorageViaPort` 刻意用默认阈值、
 *   不传 `force`，那是对的：启动期常态整库重写比不回收更糟）；
 * - 引擎**没有** `secure_delete=ON`（`authorizer.rs` 把它的写一律拒绝），所以这里靠"覆盖 + 截断"
 *   而不是"逐页擦除"：在 SSD 的磨损均衡/文件系统快照层面仍可能留下物理残留 —— 这一条**不声称**已解决。
 */
export interface ResidueOutcome {
  /** 真的尝试了吗（false = 没有端口 / 端口没有命令能力，原因见 `reason`） */
  attempted: boolean;
  /** WAL 折叠（含截断）是否成功 */
  checkpointed: boolean;
  /** 整库重写是否**真的发生**（false = 引擎判定没做 / 失败） */
  vacuumed: boolean;
  /** 没做成的原因（人可读；成功时为 undefined） */
  reason?: string;
}

type CommandPort = { data?: { command?: <R>(cmd: string, params?: Record<string, unknown>) => Promise<R> } };

export async function reclaimSealedPlaintextResidue(): Promise<ResidueOutcome> {
  const out: ResidueOutcome = { attempted: false, checkpointed: false, vacuumed: false };
  if (!hasStoragePort()) {
    out.reason = "存储端口未注册";
    return out;
  }
  const port = getStoragePort() as unknown as CommandPort;
  const command = port?.data?.command;
  if (typeof command !== "function") {
    out.reason = "端口没有 command 能力（结构化命令读不到结果）";
    return out;
  }
  const run = <R>(cmd: string, params: Record<string, unknown> = {}) =>
    command.call(port.data, cmd, params) as Promise<R>;

  out.attempted = true;
  try {
    await run("checkpoint");
    out.checkpointed = true;
  } catch (e) {
    out.reason = `WAL 折叠失败：${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const res = await run<{ performed?: boolean; reason?: string }>("storage.compact", { force: true });
    out.vacuumed = res?.performed === true;
    if (!out.vacuumed) out.reason = res?.reason ?? "引擎没有执行整库重写（未说明原因）";
  } catch (e) {
    out.reason = `整库重写失败：${e instanceof Error ? e.message : String(e)}`;
  }

  if (out.vacuumed) {
    try {
      // VACUUM 的新镜像也要经 WAL 才能落到主库；不折这一次，主库里仍是旧字节
      await run("checkpoint");
    } catch (e) {
      out.reason = `收尾 WAL 折叠失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return out;
}

/**
 * 磁盘上密钥形态的**实况**（界面用；只读，不改任何东西）。
 *
 * 第 62 轮补：做设置界面时发现 `codem-secrets-plaintext` 这个回退开关
 * **只有读点、没有写入方**（`settings-keys-symmetry.test.ts` SKEY-2 直接报红）——
 * 也就是说"用户可以显式选择明文"这句话当时是**假的**：那个键永远是默认值，
 * `migrateProviderKeysToSealed()` 里的 `skippedByChoice` 分支**永远不可达**。
 * 关法是把这个键接上一个真写入方（设置 → 安全里的开关）+ 一条真正的回退动作
 * （把已封存的密文解回明文，见下面 `revertSealedKeysToPlaintext`），而不是把键删掉了事
 * ——"回退可用"是 `docs/CREDENTIALS-PLAN.md` 第 4 节写明的验收判据。
 */
export interface SecretStorageStatus {
  /** 系统加密后端结论；`null` = 还没问过（本进程还没跑过解封/迁移） */
  backend: boolean | null;
  /**
   * 设置面读得出来吗。
   *
   * `false` 时下面三个计数**没有意义**（都是 0，但那是"没读到"而不是"没有"）——
   * 界面必须显示"还没读出来"，不许显示"当前没有已保存的密钥"。
   */
  settingsReady: boolean;
  /** 磁盘上仍是明文的 provider 数 */
  plaintext: number;
  /** 磁盘上已封存的 provider 数 */
  sealed: number;
  /** 用户已显式选择明文回退（`codem-secrets-plaintext`） */
  plaintextByChoice: boolean;
  /** 密文存在但**本账户解不开**的 provider 数（换机器/换账户是预期行为） */
  unreadable: number;
}

export function secretStorageStatus(): SecretStorageStatus {
  const settingsReady = settingsFaceReady();
  const providers = Array.isArray(rawSettings().providers) ? rawSettings().providers! : [];
  let plaintext = 0;
  let sealed = 0;
  let unreadable = 0;
  for (const p of providers) {
    const id = String(p?.id ?? "");
    if (typeof p?.apiKeySealed === "string" && p.apiKeySealed) {
      sealed += 1;
      if (id && isSealedKeyUnreadable(id)) unreadable += 1;
    } else if (typeof p?.apiKey === "string" && p.apiKey) {
      plaintext += 1;
    }
  }
  return {
    backend: backendAvailability(),
    settingsReady,
    plaintext,
    sealed,
    unreadable,
    plaintextByChoice: plaintextFallbackEnabled(),
  };
}

type RevertReason = "nothing" | "disabled" | "backend-missing" | "unreadable";

export interface RevertOutcome {
  /** 成功解回明文的 provider 数（失败时恒为 0 —— 要么全成要么不动） */
  reverted: number;
  /** 失败的 provider 数 */
  failed: number;
  /** 没做事的原因；`reverted > 0` 时为 `undefined` */
  reason?: RevertReason;
}

/**
 * 回退动作：把已封存的密钥**解回明文**写进 settings（`docs/CREDENTIALS-PLAN.md` 第 4 节的
 * "回退（用户/staff 可执行）"）。
 *
 * 三条纪律，与迁移对称：
 * 1. **先有开关**：`codem-secrets-plaintext` 没打开就直接拒绝（`reason: "disabled"`）。
 *    调用点必须先写入开关、再调本函数 —— 否则一次误点就会让明文重新落盘。
 * 2. **要么全成要么不动**：任何一个 provider 解不开 ⇒ **整体不改动**（保持密文），
 *    调用方必须如实把这句报出来，而不是假装回退成功了。
 * 3. **解不开不等于密钥坏了**：DPAPI 密文绑当前 Windows 账户，换账户解不开是**预期**行为，
 *    此时唯一正确的出路是让用户重新填一次 key。
 */
export async function revertSealedKeysToPlaintext(): Promise<RevertOutcome> {
  const settings = rawSettings();
  const providers = Array.isArray(settings.providers) ? settings.providers! : [];
  const sealedOnes = providers.filter((p) => typeof p?.apiKeySealed === "string" && p.apiKeySealed);
  if (sealedOnes.length === 0) return { reverted: 0, failed: 0, reason: "nothing" };
  if (!plaintextFallbackEnabled()) return { reverted: 0, failed: 0, reason: "disabled" };

  const invoke = invokeFn();
  if (!invoke) {
    return { reverted: 0, failed: sealedOnes.length, reason: "backend-missing" };
  }

  // ① 先只解封，磁盘不动
  const plainById = new Map<string, string>();
  for (const p of sealedOnes) {
    const id = String(p.id ?? "");
    try {
      const reply = (await invoke("secret_unseal", { sealed: p.apiKeySealed })) as { plaintext?: string } | null;
      const plain = typeof reply?.plaintext === "string" ? reply.plaintext : "";
      if (!plain) throw new Error("解封返回空");
      plainById.set(id, plain);
    } catch {
      // 规则 2：留到循环外统一判定，这里不写回任何东西
    }
  }
  if (plainById.size !== sealedOnes.length) {
    return { reverted: 0, failed: sealedOnes.length - plainById.size, reason: "unreadable" };
  }

  // ② 一次原子写回：明文进、密文出
  const next: Record<string, unknown> = {
    ...settings,
    providers: providers.map((p) => {
      const plain = plainById.get(String(p.id ?? ""));
      if (!plain) return p;
      const { apiKeySealed: _drop, ...rest } = p;
      return { ...rest, apiKey: plain };
    }),
  };
  // ⚠️ 必须裸写：走闸门的话，"回退成明文"会被闸门用缓存里的旧密文立刻改回去（用户的回退被撤销）
  setSetting(SETTINGS_KEY, JSON.stringify(next));

  // ③ 写回之后才更新内存：明文进缓存 + 撤掉过期的"解不开"标记
  for (const [id, plain] of plainById) {
    cacheSealedKey(id, plain);
    clearSealedKeyUnreadable(id);
    /**
     * 用户显式退回明文 ⇒ 这份密文**不能再拿去回封**：
     * 否则下一次"改个模型名"的读改写会立刻把明文又换成密文，用户的回退选择等于被撤销。
     */
    forgetSealedBlob(id);
  }
  return { reverted: plainById.size, failed: 0 };
}

/**
 * 装上写回闸门的两个钩子（**模块加载时**即生效）。
 *
 * 为什么放在模块作用域：闸门装在 `settings.ts` 的唯一写收口上，而"能不能回封"这件事
 * 需要读设置（`settings.ts`）与问后端（IPC）—— 那两样都在本模块里，
 * 反向 import 会成环。钩子注册是纯内存操作，没有副作用，也不依赖启动顺序；
 * 没被注册时闸门**什么都不改**（见 `secret-write-guard.ts` 文件头）。
 */
installCredentialWriteGuard({
  allowed: () => !plaintextFallbackEnabled() && backendAvailability() !== false,
  sealPending: sealPendingProviders,
});
