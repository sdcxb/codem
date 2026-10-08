/**
 * `core/storage/settings` 的**共享 mock 基座**（本轮记忆系统重构后新增）。
 *
 * ## 为什么要有这个文件（真实缺陷，不是"为了体系完整"）
 *
 * 记忆系统重构给 `settings.ts` 加了四个导出（`loadMemoryChecked` / `saveMemoryConfirmed` /
 * `isMemoryDomainReady` / 两个原因常量），而 `MemoryService` 的**构造函数**就会调用
 * `loadMemoryChecked()` —— 于是任何"整体 mock 掉 settings、只补老几个导出"的用例文件，
 * 在 `new LLMEngine()`（内部 `getMemoryService()`）时当场抛：
 *
 * ```
 * Error: [vitest] No "loadMemoryChecked" export is defined on the "../core/storage/settings" mock.
 * ```
 *
 * 现场就是 `forked-agent.test.ts`（5 条全红：第一条实例化失败，后面 4 条"原型方法存在性"
 * 连带红）与 `engine-catalog-injection.test.ts`（ENG-1..4 全红）。
 *
 * ## 修法：一处基座，而不是每个文件各补一份
 *
 * 本仓忌讳"同一规则多份实现"（`AGENTS.md` §5）—— 所以补的不是"某个文件里再加一个函数"，
 * 而是这一份**按真实签名与语义**实现的基座：调用方
 *
 * ```ts
 * vi.mock("../core/storage/settings", () => createSettingsMock());
 * ```
 *
 * 需要自己那套读写行为的用例，仍然可以传 `overrides` 覆盖**任意**导出
 * （`{ getSettingJSON: vi.fn(...) }`），基座只负责"把真实导出面补齐且语义自洽"。
 *
 * ## 「语义自洽」是什么意思（不许 `() => undefined` 敷衍）
 *
 * 这组导出**互相耦合**：`loadMemoryChecked()` 说"读到空"，那 `isMemoryDomainReady()` 就必须说
 * "记忆域是热的"，`isSettingsMirrorReady()` 也必须说"设置面已预热" —— 否则被测的
 * `MemoryService.load()` 会走 fail-closed（读失败 ⇒ 不迁移、不写标记、`save()` 拒绝写），
 * 用例就在测一条**根本不可能同时成立**的组合。所以基座按"一个**已预热且记忆为空**的库"
 * 这一条真实形态实现：
 *
 * - 未预热（可选 `{ mirrorReady: false }`）⇒ `loadMemoryChecked()` 返回
 *   `{ ok: false, reason: MEMORY_DOMAIN_NO_PORT }`，与 `isMemoryDomainReady() === false`
 *   完全一致（这正是真机上"端口没起来"的形态）；
 * - 已预热 ⇒ 读到的就是 store 里那份（默认空串 = **真的没有记忆**），写回会真的进 store，
 *   下一次读得到它 —— 于是"存完立刻读"这类断言在 mock 上同样成立。
 *
 * ## 被门禁守着
 *
 * `src/test/settings-mock-parity.test.ts`（SMP-1..3）用**解析式对账**保证：
 * 这个基座（以及所有 `vi.mock("../core/storage/settings")` 的用例文件）所覆盖的导出，
 * 必须涵盖被被测代码**实际用到**的 settings 导出 —— 再也不会出现"真实导出面涨了、
 * mock 面没跟上"这种只在运行时才炸的漂移。
 */
import { vi } from "vitest";
import type {
  MemoryReadResult,
  QuickPhrase,
  SettingsWriteProbe,
  SettingsWriteReport,
} from "../core/storage/settings";

/** 背在基座里的"内存版设置库"（与真实 `settings` 表的语义一致：键 → 字符串） */
export interface SettingsMockStore {
  /** 键 → 字符串（`getSetting` / `setSetting` 那一层） */
  raw: Map<string, string>;
}

/** `getSetting` 的返回：真实实现**没这个键就是 null**（不是空串 —— 调用方用 null 判"没设过"） */
const readRaw = (store: SettingsMockStore, key: string): string | null =>
  store.raw.has(key) ? store.raw.get(key)! : null;

export interface SettingsMockOptions {
  /**
   * 设置面镜像是否已预热（默认 `true`）。
   *
   * 传 `false` 会**连带**让 `isMemoryDomainReady()` 为假、`loadMemoryChecked()` 返回
   * 未预热失败 —— 三者是同一条判据链（见文件头），不接受单独拧一个。
   */
  mirrorReady?: boolean;
  /** 起始内容（键 → 字符串）。默认空库。 */
  initial?: Record<string, string>;
  /**
   * 用**调用方自己的那份库**（而不是基座内部新建的）。
   *
   * 给"用例文件里已经有一份模块级 store、并且断言/清空都对着它"的现场用
   * （如 `sync-engine.test.ts` 的 `mockStore.clear()`）—— 否则基座另建一份，
   * 那些 `clear()` 会变成对着空气操作，用例之间互相污染。
   */
  store?: SettingsMockStore;
}

/**
 * 造一份**与真实导出面同形**的 settings 模块。
 *
 * 返回对象里每个键都必须与 `src/core/storage/settings.ts` 的真实导出同名同形
 * （函数是函数、常量是常量），由 `settings-mock-parity.test.ts` 的 SMP-2 守着。
 */
export function createSettingsMock(opts: SettingsMockOptions = {}): Record<string, unknown> {
  const ready = opts.mirrorReady !== false;
  const store: SettingsMockStore = opts.store ?? { raw: new Map(Object.entries(opts.initial ?? {})) };

  /** 未预热时的统一口径：**读不到**，而不是"读到空"（这正是这一批改动的核心区分） */
  const notWarmed = (): MemoryReadResult => ({
    ok: false,
    reason: "配置面记忆域尚未预热（mock：设置面镜像未预热）",
  });

  const mock = {
    // ---- 配置面基础读写（真实签名见 settings.ts） ----
    getSetting: vi.fn((key: string): string | null => readRaw(store, key)),
    setSetting: vi.fn((key: string, value: string): void => {
      store.raw.set(key, value);
    }),
    removeSetting: vi.fn((key: string): void => {
      store.raw.delete(key);
    }),
    getSettingJSON: vi.fn(<T,>(key: string, defaultValue: T): T => {
      const raw = readRaw(store, key);
      if (raw === null) return defaultValue;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return defaultValue;
      }
    }),
    setSettingJSON: vi.fn((key: string, value: unknown): void => {
      store.raw.set(key, JSON.stringify(value));
    }),
    mergeDefaults: <T extends object>(defaults: T, partial?: Partial<T> | null): T => {
      if (!partial || typeof partial !== "object") return { ...defaults };
      const merged: T = { ...defaults };
      const target = merged as Record<string, unknown>;
      for (const key of Object.keys(partial)) {
        const value = (partial as Record<string, unknown>)[key];
        if (value !== undefined) target[key] = value;
      }
      return merged;
    },
    isSettingsMirrorReady: vi.fn((): boolean => ready),
    setSettingConfirmed: vi.fn(async (key: string, value: string): Promise<boolean> => {
      if (!ready) return false;
      store.raw.set(key, value);
      return true;
    }),

    // ---- 落库确认（第 45 轮 D-21）：mock 里"写是同步落库的" ⇒ 立刻 settled ----
    beginSettingsWriteProbe: vi.fn(
      (): SettingsWriteProbe => ({ accepted: ready, portFailures: 0, areas: [] }),
    ),
    flushSettingsWrites: vi.fn(
      async (probe: SettingsWriteProbe): Promise<SettingsWriteReport> => ({
        ...probe,
        pending: ready ? 0 : -1,
        newFailures: 0,
        newAreas: [],
        settled: ready,
      }),
    ),

    // ---- 记忆域（本批新增的那一层：读/写/就绪判据必须自洽） ----
    isMemoryDomainReady: vi.fn((): boolean => ready),
    loadMemory: vi.fn((): string => (ready ? (readRaw(store, "memory") ?? "") : "")),
    loadMemoryChecked: vi.fn((): MemoryReadResult => {
      if (!ready) return notWarmed();
      return { ok: true, data: readRaw(store, "memory") ?? "", bytes: (readRaw(store, "memory") ?? "").length };
    }),
    saveMemory: vi.fn((content: string): void => {
      if (!ready) return; // 真实实现：未预热 ⇒ 拒绝写并如实上报（不把兜底值写回库）
      store.raw.set("memory", content);
    }),
    saveMemoryConfirmed: vi.fn(async (content: string): Promise<{ ok: boolean; reason?: string }> => {
      if (!ready) return { ok: false, reason: "配置面记忆域尚未预热（mock）" };
      store.raw.set("memory", content);
      return { ok: true };
    }),
    /**
     * 第 187 波 R1 把记忆写入拆成两半（`MemoryService.save()` / `saveConfirmed()` 两处都调）：
     * - `patchMemoryMirror()` 只管**同步改镜像**（不落库、不等确认）；
     * - `writeMemoryConfirmed()` 只管**写穿并等确认**（不碰镜像）。
     * 两份都要在基座里，否则被测代码调到哪一半就抛 `No "…" export … on the mock`
     * —— 这正是本文件存在的理由（`settings-mock-parity.test.ts` 的 SMP-1 会守住）。
     */
    patchMemoryMirror: vi.fn((content: string): void => {
      if (!ready) return; // 真实实现：未预热 ⇒ 拒绝（绝不把 fallback 派生值写回镜像）
      store.raw.set("memory", content);
    }),
    writeMemoryConfirmed: vi.fn(async (content: string): Promise<{ ok: boolean; reason?: string }> => {
      if (!ready) return { ok: false, reason: "配置面记忆域尚未预热（mock）" };
      store.raw.set("memory", content);
      return { ok: true };
    }),
    MEMORY_DOMAIN_NOT_WARMED: "配置面记忆域尚未预热（读到/写回的都会是兜底值，不是真实数据）",
    MEMORY_DOMAIN_NO_PORT: "没有可用的存储端口（本次既读不到也写不了记忆）",

    // ---- 快捷短语 / MCP（沿用真实语义：走扩展域，本基座用同一份 store 近似） ----
    saveQuickPhrase: vi.fn((phrase: QuickPhrase): void => {
      store.raw.set(`quick-phrase:${phrase.id}`, JSON.stringify(phrase));
    }),
    loadQuickPhrases: vi.fn((): QuickPhrase[] => []),
    deleteQuickPhrase: vi.fn((phraseId: string): void => {
      store.raw.delete(`quick-phrase:${phraseId}`);
    }),
    incrementQuickPhraseUsage: vi.fn((): void => {}),

    loadMcpServers: vi.fn(() => []),
    saveMcpServer: vi.fn((): void => {}),
    removeMcpServer: vi.fn((): void => {}),

    // ---- 崩溃恢复数据（真实实现在 settings 表外的 recovery_data 表） ----
    loadRecoveryData: vi.fn((sessionId: string): string | null => readRaw(store, `recovery:${sessionId}`)),
    saveRecoveryData: vi.fn((sessionId: string, data: string): void => {
      store.raw.set(`recovery:${sessionId}`, data);
    }),
  };

  // 暴露 store 便于用例断言"到底写进去了什么"（`?` 之外不加别的 API，避免变成第二套实现）
  Object.defineProperty(mock, "__store", { value: store, enumerable: false });
  return mock;
}

/**
 * 从 `createSettingsMock()` 的返回值（或**被测代码看到的那个 mock 模块**）里取那份内存库。
 *
 * ⚠️ 传进来的必须**真的是**基座的返回值：`settingsMockStore(settingsModule)` 里
 * `settingsModule` 是 `import * as` 拿到的 mock 模块命名空间，属性透传后能拿到 `__store`；
 * 若传的是 `createSettingsMock` 的**调用结果本身**（如 `settingsMockStore(mock)`）也可以。
 * 传一个别的对象会抛（比静默返回 `undefined` 好 —— 那会变成"断言对着空气"）。
 */
export function settingsMockStore(mock: Record<string, unknown>): SettingsMockStore {
  const store = (mock as unknown as { __store?: SettingsMockStore }).__store;
  if (!store || !(store.raw instanceof Map)) {
    throw new Error(
      "settingsMockStore() 拿到的东西里没有 __store —— 传入的必须是用 createSettingsMock() 造出来的那份 mock",
    );
  }
  return store;
}
