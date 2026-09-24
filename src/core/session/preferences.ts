/**
 * 会话级 UI 偏好 + 「上次打开」恢复（第 47 轮）
 *
 * ## 这个文件为什么存在
 *
 * 两条审计条目（SETTINGS-LOOP 的 D-19/D-20/D-22）都卡在同一件事上：
 * **"界面偏好"有两套介质**，而写入/读回的责任分散在各组件里，于是
 * ① 有的键只在 localStorage（换 profile / 清缓存就丢，与同类 DB 偏好不同步）；
 * ② "上次打开的会话/项目"这个能力**根本不存在**（`lastSession|lastOpened|codem-last` 全仓 0 命中）。
 *
 * 这里把这三件事收成一份**可被用例直接驱动**的实现：
 *
 * | 导出 | 守什么 | 报告条目 |
 * | --- | --- | --- |
 * | `loadDisabledPlugins` | 插件开关以 **DB 为准**，并把 localStorage 的旧值迁移进 DB | D-22 |
 * | `readLastSessionId` / `readLastProjectId` / `writeLastSessionId` / `writeLastProjectId` | 记下/读回"上次打开的会话与项目" | D-20 |
 * | `restoreLastOpenedSession` | **校验目标仍存在**才恢复；不存在/已删除 → 安静回落并清键 | D-20 |
 *
 * ## 两条纪律（用例守着）
 *
 * 1. **不许静默丢**：迁移 localStorage → DB 时，DB 只是"还没有值"才接受迁移值；
 *    DB 里已经有值（哪怕是空数组 —— 用户显式把插件全启用回来了）时，
 *    localStorage 的旧值**一律不覆盖** DB。反过来，DB 的值每一次读都会回写 localStorage
 *    （旧的三处读取方 —— `PanelSidebar` / `ui-plugins/gating` / 插件管理器自身 ——
 *    仍然只认 localStorage，不回写就等于"迁移完旧读方看到的是别的真相"）。
 * 2. **不许报错刷屏**：读不到 / 解析失败 / 会话已被删除 → 走信息级 `console.log`
 *    或**什么都不写**，绝不 `console.error`、绝不 `reportPersistFailure`
 *    （"上次打开的会话被删了"是完全正常的用户操作）。
 */

import * as ProjectStorage from "../storage/project";
import * as SessionStorage from "../storage/session";
import type { SessionReadState } from "../storage/session";
import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { reportPersistFailure } from "../storage/persist-failure";
import type { Project, Session } from "../types";

// ========== 设置键（DB） ==========

/**
 * 「上次打开的会话」。
 *
 * 原来这个能力**完全不存在**（D-20）：启动路径只有 `loadFromDB()`
 * （只写 `projects` 与 `dbReady`，从不设置 `currentProject/currentSession`），
 * 于是每次启动都停在"无会话"状态。这两个键就是那次修复的数据面。
 */
export const LAST_SESSION_KEY = "codem-last-session";
/** 「上次打开的项目」。与 `codem-last-session` 分开存：全局会话（`projectId === ""`）也要能记住"上次没有项目"。 */
export const LAST_PROJECT_KEY = "codem-last-project";
/** 插件禁用列表（DB 权威；localStorage 同名键 `codem:disabled-plugins` 是兼容镜像） */
export const DISABLED_PLUGINS_KEY = "codem-disabled-plugins";
/** 插件禁用列表的 localStorage 镜像键（旧读方仍在用，不要改） */
export const DISABLED_PLUGINS_LS_KEY = "codem:disabled-plugins";
/**
 * 插件禁用列表的**写入时刻**（DB 侧，毫秒）。
 *
 * 第 48 轮新增。为什么"两份介质都写"还不够：两份写入不是原子的 ——
 * `setSettingJSON` 是"内存即时生效 + 异步落库"，进程在落库前被杀掉，
 * 盘上 DB 就是旧值而镜像已是新值。下一次启动时若按"DB 一律为准"，
 * 用户刚关掉的插件会**静默地被重新打开**（这正是 D-22 想消灭的那类缺陷，
 * 只是换了个触发条件）。有了这个戳，"哪一份更新"是**事实**而不是猜测。
 *
 * 旧数据没有这个键 → 读回 `null` → 判定按"DB 为准"（保守，与 47 轮行为一致）。
 */
export const DISABLED_PLUGINS_STAMP_KEY = "codem-disabled-plugins-at";
/** 写入时刻的 localStorage 镜像键（旧读方不认识它，加了不影响兼容） */
const DISABLED_PLUGINS_LS_STAMP_KEY = "codem:disabled-plugins-at";
/**
 * 首次运行默认禁用的插件。
 *
 * 与 `App.tsx` 原来的初值一致：游戏插件默认关（它是"彩蛋"级功能，不该在首次启动就占资源）。
 * 这份常量放在这里，是为了让"DB 里没有这个键"时的判定只有一处。
 */
export const DEFAULT_DISABLED_PLUGINS: readonly string[] = ["@codem/ui-game"];

// ========== D-22：插件开关的介质统一 ==========

/** 读 localStorage 镜像；键不存在返回 `null`（**不是**空数组 —— "没设置过"与"显式清空"必须分得开） */
function readDisabledPluginsMirror(): string[] | null {
  try {
    const raw = localStorage.getItem(DISABLED_PLUGINS_LS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return null;
  }
}

/** 写 localStorage 镜像（旧读方：`PanelSidebar` / `ui-plugins/gating` / 插件管理器自身） */
function writeDisabledPluginsMirror(list: readonly string[], at: number | null = null): void {
  try {
    localStorage.setItem(DISABLED_PLUGINS_LS_KEY, JSON.stringify(list));
    // 戳只在明确知道"这份值是什么时刻写下的"时才更新（见 DISABLED_PLUGINS_STAMP_KEY 的说明）
    if (typeof at === "number" && Number.isFinite(at)) {
      localStorage.setItem(DISABLED_PLUGINS_LS_STAMP_KEY, String(at));
    }
  } catch {
    // localStorage 不可用（隐私模式/配额满）不影响 DB 那一份 —— 但要说出来
    console.warn("[preferences] 插件禁用列表的 localStorage 镜像未写入（DB 那一份不受影响）");
  }
}

/** 读 DB 侧的写入时刻；没有/形状不对 → `null`（"不知道"与"0"必须分得开） */
function readDisabledPluginsStamp(): number | null {
  try {
    const v = getSettingJSON<unknown>(DISABLED_PLUGINS_STAMP_KEY, null);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 读镜像侧的写入时刻；没有/坏掉 → `null` */
function readDisabledPluginsMirrorStamp(): number | null {
  try {
    const raw = localStorage.getItem(DISABLED_PLUGINS_LS_STAMP_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface DisabledPluginsState {
  /** 权威列表（DB 值，或首次运行时迁移/默认得到的值） */
  list: string[];
  /** 这次读是不是**从 localStorage 迁移**过来的（调用方据此决定要不要提示/记录） */
  migrated: boolean;
  /** 这个列表是不是"首次运行默认值"（DB 与 localStorage 都没有，于是用默认） */
  seeded: boolean;
}

/**
 * 读插件禁用列表 —— **DB 权威 + localStorage 迁移兜底 + 双写镜像**。
 *
 * 判定顺序（每一步都有对应用例）：
 *
 * 1. DB（`codem-disabled-plugins`）**有值** → 用它；并把值回写 localStorage 镜像
 *    （旧读方只认镜像）。**即使 DB 值是空数组也算"有值"**：那是用户
 *    "把所有插件都启用回来"的真实选择，绝不能被镜像里的旧值覆盖（"不许静默丢"）。
 * 2. DB 没有值、localStorage 有值 → **迁移**：写进 DB（`migrated: true`）并保持镜像一致。
 * 3. 两边都没有 → 首次运行：用 `DEFAULT_DISABLED_PLUGINS`，同时写 DB 与镜像
 *    （`seeded: true`）—— 这样第二次启动起就以 DB 为准，不再依赖镜像。
 */
export function loadDisabledPlugins(): DisabledPluginsState {
  const fromDbRaw = getSettingJSON<unknown>(DISABLED_PLUGINS_KEY, null);
  if (Array.isArray(fromDbRaw)) {
    const list = fromDbRaw.map((v) => String(v));
    // 回写镜像时把 **DB 的写入时刻**一并带过去：镜像从此是"DB 在某时刻的副本"，
    // 而不是一个没有出处的第二真相源（第 48 轮）。
    writeDisabledPluginsMirror(list, readDisabledPluginsStamp());
    return { list, migrated: false, seeded: false };
  }

  const mirror = readDisabledPluginsMirror();
  if (mirror !== null) {
    setSettingJSON(DISABLED_PLUGINS_KEY, mirror);
    console.log(`[preferences] 插件禁用列表已从 localStorage 迁移到 DB（${mirror.length} 项）`);
    return { list: mirror, migrated: true, seeded: false };
  }

  const seeded = [...DEFAULT_DISABLED_PLUGINS];
  setSettingJSON(DISABLED_PLUGINS_KEY, seeded);
  writeDisabledPluginsMirror(seeded);
  return { list: seeded, migrated: false, seeded: true };
}

/**
 * 写插件禁用列表：**DB（权威）+ localStorage 镜像**一起写。
 *
 * 为什么不能只写 DB：三处旧读方（`ui-plugins/gating.ts:24`、`PanelSidebar.tsx:19`、
 * `plugin-manager-service.ts:410`）读的都是镜像 —— 只写 DB 的话界面会立刻与真相不一致。
 * 为什么不能只写 localStorage（改前就是）：那是 D-22 的缺陷本身 ——
 * 换 profile / 清缓存就丢，而同类偏好（`codem-sidebar-width`）已经在 DB 里。
 *
 * ⚠️ 第 48 轮的更新：这条"写入方"注释原来写的是"真实写入方目前仍主要是
 * `PluginManagerService`（它直接写镜像）—— 那个文件不在本次改动的责任范围内"。
 * 那个缺口已经补上：`PluginManagerService` 的两个写入点（`saveDisabledList` /
 * `saveDisabledListExplicit`）现在都走 `saveDisabledPlugins`，即"DB + 时间戳 + 镜像"一次写完。
 * 生产代码里**不再有任何**直接写 `codem:disabled-plugins` 镜像的地方
 * （用例 `PLUGIN-MEDIUM-*` 守着这一条）。`adoptDisabledPluginsMirror()` 保留为兜底：
 * 万一将来又出现一个只写镜像的写入方，启动/状态变化时仍会把它收编进 DB。
 */
export function saveDisabledPlugins(list: readonly string[]): void {
  const at = Date.now();
  /**
   * 顺序是有意的：**先 DB 后镜像**。
   *
   * 两份写入不可能原子，所以必须让"先落地的那份"是权威那份 ——
   * 万一在两次写入之间进程没了，盘上状态是"DB 新、镜像旧"，
   * 而下一次启动的判定（`reconcileDisabledPluginsAtBoot`：无戳/DB 更新 → DB 胜）会正确地取 DB。
   * 反过来的顺序会留下"镜像新、DB 旧"，那要靠戳来救（也能救，但少一条依赖总是更好）。
   */
  setSettingJSON(DISABLED_PLUGINS_KEY, [...list]);
  setSettingJSON(DISABLED_PLUGINS_STAMP_KEY, at);
  writeDisabledPluginsMirror(list, at);
}

/**
 * 启动时的介质对账（第 48 轮）—— **应用侧启动路径应该调这个，而不是直接调 `loadDisabledPlugins`**。
 *
 * ## 它解决的缺陷（"刚关掉的插件重启后自己又开了"）
 *
 * `loadDisabledPlugins` 的契约是"DB 有值就以 DB 为准，并回写镜像"。这在
 * "镜像只是旧格式残留"时是对的，但在**写入没落地**时是错的：
 * 用户点了插件开关 → 新值进了 DB 的内存缓存（`setSettingJSON` 是内存即时生效 + 异步落库）
 * 与 localStorage 镜像 → 进程在落库前被杀 → 盘上 DB 还是旧值。
 * 下次启动按旧契约走：DB 旧值胜出，**镜像被旧值覆盖**，用户的开关静默消失。
 *
 * ## 判定规则（每一档都有用例）
 *
 * | DB 列表 | 镜像列表 | 判定 |
 * | --- | --- | --- |
 * | 无 | 无 | 首次运行 → `loadDisabledPlugins`（默认值，两边都写） |
 * | 无 | 有 | 迁移镜像进 DB（与旧行为一致） |
 * | 有 | 无 | DB 胜出，补写镜像 |
 * | 有 | 有，且**内容相同** | 无需选择，顺手把镜像的戳对齐 DB |
 * | 有 | 有，内容不同，**镜像戳 > DB 戳** | 镜像胜出 → 写回 DB（写入没落地，镜像才是最新事实） |
 * | 有 | 有，内容不同，其余情况 | **DB 胜出** → 回写镜像（无戳的旧数据、镜像写入失败、戳相等） |
 *
 * 最后一档刻意保守：没有戳就按旧的"DB 为准"，绝不因为"镜像看起来不一样"就改写 DB。
 *
 * ## 分歧必须可见
 *
 * 前五档里"两边都有值且内容不同"意味着**有一次写入没有落地**。按项目纪律
 * （"失败必须可见"）这里不走静默路径：除了 `console.warn`，还经
 * `reportPersistFailure` 上报一次（界面上的保存失败横幅会显示）。
 * 其余档位（首次运行 / 迁移 / 补齐镜像）是正常路径，静默。
 */
export interface DisabledPluginsReconcileResult extends DisabledPluginsState {
  /** DB 与镜像内容不同、且以镜像为准（= 有一次 DB 写入没落地，用户的开关被镜像救回来了） */
  adoptedFromMirror: boolean;
  /** 发现过介质分歧（无论哪边胜出） */
  diverged: boolean;
}

export function reconcileDisabledPluginsAtBoot(): DisabledPluginsReconcileResult {
  const fromDbRaw = getSettingJSON<unknown>(DISABLED_PLUGINS_KEY, null);
  const dbList = Array.isArray(fromDbRaw) ? fromDbRaw.map((v) => String(v)) : null;
  const mirror = readDisabledPluginsMirror();

  // 有一边"没有值" → 交给 loadDisabledPlugins 的三档判定（迁移 / 播种 / DB 为准）
  if (dbList === null || mirror === null) {
    return { ...loadDisabledPlugins(), adoptedFromMirror: false, diverged: false };
  }

  const identical =
    dbList.length === mirror.length && dbList.every((v, i) => v === mirror[i]);
  if (identical) {
    // 无分歧：把镜像的戳对齐到 DB 的戳（老数据没戳时这就是补齐的时机）
    writeDisabledPluginsMirror(dbList, readDisabledPluginsStamp());
    return { list: dbList, migrated: false, seeded: false, adoptedFromMirror: false, diverged: false };
  }

  const dbStamp = readDisabledPluginsStamp();
  const mirrorStamp = readDisabledPluginsMirrorStamp();
  const mirrorIsNewer = mirrorStamp !== null && (dbStamp === null || mirrorStamp > dbStamp);

  if (mirrorIsNewer) {
    setSettingJSON(DISABLED_PLUGINS_KEY, mirror);
    setSettingJSON(DISABLED_PLUGINS_STAMP_KEY, mirrorStamp);
    /**
     * 消息分两层：`message` 是**界面上给用户看的那一句**（`PersistFailureBanner` 只渲染
     * `message`），`extra` 是给日志/取证看的原始两份值。两者不能互相顶替 ——
     * 把 JSON 塞进 `message` 的话用户看到的是两串机器字符串，
     * 而只写一句人话的话事后没法取证到底是哪两份值不一致。
     */
    /**
     * 两句分工必须清楚，否则横幅会**自己重复一遍**（第二版真机核验就是这个样子：
     * "已按较新的一份恢复，请确认插件开关状态" + "已按较新的一份恢复并写回数据库…"）。
     * 现在 `message` 只说**发生了什么**，`consequence` 只说**结果与下一步**。
     */
    const userMessage = "插件开关的上一次改动没有写进数据库（两种介质的记录不一致）";
    const detail =
      `插件禁用列表的两种介质不一致：DB=${JSON.stringify(dbList)}（戳 ${dbStamp ?? "无"}），` +
      `镜像=${JSON.stringify(mirror)}（戳 ${mirrorStamp}）。镜像更新，已按镜像恢复并回写 DB`;
    console.warn(`[preferences] ${detail}`);
    try {
      /**
       * `consequence` 覆盖了通道的通用后果那句。**必须覆盖**：
       * 通用句说的是"改动只在内存里、重启会丢、去查磁盘空间"，而这一刻
       * 值**已经恢复进 DB 了** —— 两句话同时出现在一条横幅上会自相矛盾
       * （真机核验就是这么抓到的：横幅上"已按较新的一份恢复"与
       * "重启应用后会丢失"并排印着）。这里改说真实情况：已经恢复好了，请核对一下开关。
       */
      reportPersistFailure(
        "preferences.disabledPlugins.diverged",
        new Error(userMessage),
        detail,
        { consequence: "已按较新的一份恢复并写回数据库，本次没有丢失；请核对插件开关是否符合预期。" },
      );
    } catch {
      // 上报通道自身失败不影响对账结果
    }
    return { list: mirror, migrated: false, seeded: false, adoptedFromMirror: true, diverged: true };
  }

  // DB 胜出：把 DB 的值（与它的戳）写回镜像，让镜像重新成为"DB 的副本"
  //
  // 这一档只 warn、**不**上报到界面横幅。区别在哪：镜像胜出那一档意味着
  // "用户刚做的选择只存在于一份介质里"，所以必须让用户看见；
  // 而这一档 DB 是权威且内容完好 —— 用户没有任何东西被丢，
  // 分歧只可能来自①升级前的旧数据（镜像里的历史残留）②镜像那次
  // `localStorage` 写入失败（`writeDisabledPluginsMirror` 已经自己 warn 过）。
  // 为一个"什么都没丢"的情况弹常驻错误横幅，会把真正需要用户注意的告警淹掉。
  writeDisabledPluginsMirror(dbList, dbStamp);
  console.warn(
    `[preferences] 插件禁用列表的两种介质不一致：DB=${JSON.stringify(dbList)}（戳 ${dbStamp ?? "无"}），` +
    `镜像=${JSON.stringify(mirror)}（戳 ${mirrorStamp ?? "无"}）。按 DB 为准（DB 权威），已回写镜像`,
  );
  return { list: dbList, migrated: false, seeded: false, adoptedFromMirror: false, diverged: true };
}

/**
 * 把 localStorage 镜像里的**新值**收编进 DB（供 App 监听 `codem:plugin-state-changed` 时调用）。
 *
 * 判定：镜像与 DB 不同 → 以镜像为准写 DB（因为在 `PluginManagerService` 仍直接写镜像的
 * 现状下，**镜像才是最晚的事实**）；相同 → 什么都不做（不做无谓写）。
 *
 * @returns 是否发生了收编（`true` 表示 DB 被更新）
 */
export function adoptDisabledPluginsMirror(): boolean {
  const mirror = readDisabledPluginsMirror();
  if (mirror === null) return false;
  const fromDb = getSettingJSON<unknown>(DISABLED_PLUGINS_KEY, null);
  const dbList = Array.isArray(fromDb) ? fromDb.map((v) => String(v)) : null;
  if (dbList && dbList.length === mirror.length && dbList.every((v, i) => v === mirror[i])) {
    return false;
  }
  setSettingJSON(DISABLED_PLUGINS_KEY, mirror);
  return true;
}

// ========== D-20：上次打开的会话 / 项目 ==========

/** 读上次打开的会话 id；没有就返回 `null`（不猜、不造） */
export function readLastSessionId(): string | null {
  const v = getSettingJSON<string | null>(LAST_SESSION_KEY, null);
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 读上次打开的项目 id。**空串是合法值**（全局会话：上次就没有项目），所以读的是 `undefined` 判定 */
export function readLastProjectId(): string | null {
  const v = getSettingJSON<unknown>(LAST_PROJECT_KEY, null);
  return typeof v === "string" ? v : null;
}

/** 记下"当前打开的会话"。传 `null` = 显式清掉（会话被删除时用） */
export function writeLastSessionId(sessionId: string | null): void {
  if (sessionId) setSettingJSON(LAST_SESSION_KEY, sessionId);
  else setSettingJSON(LAST_SESSION_KEY, null);
}

/** 记下"当前打开的项目"。`null`/`""` 都表示"全局（没有项目）" */
export function writeLastProjectId(projectId: string | null): void {
  setSettingJSON(LAST_PROJECT_KEY, projectId ?? "");
}

/**
 * 读会话并保留三态。`unavailable` = 端口/镜像还没接手 —— **不是**"已删除"。
 *
 * 三态的实现放在 `session.ts`（`getSessionState`），因为它需要 `wireToSession`
 * 这个私有转换器；这里只是包一层 try/catch（启动路径上的恢复动作绝不允许抛出）。
 */
function readSessionState(sessionId: string): SessionReadState {
  try {
    return SessionStorage.getSessionState(sessionId);
  } catch (e) {
    // 读库抛错也归到"读不到"：**不是**"已删除"，所以同样不许清键
    console.warn("[preferences] 校验上次会话时读库失败（按读不到处理，不清键）:", e);
    return { kind: "unavailable" };
  }
}

/**
 * 「启动恢复还没定论」的窗口标记（第 47 轮补）。
 *
 * ## 它修的是什么（真机抓到的形态）
 *
 * 记录端（`App.tsx` 里随 `currentSession` 变化的 effect）与恢复端**在同一次 commit 里**
 * 跑，而恢复端的第一次读是**异步**的。于是：
 *
 * ```text
 * 恢复端: 发起 async（尚未读到键）
 * 记录端: currentSession === null → writeLastSessionId(null)   ← 键被清掉
 * 恢复端: 真正读键 → null → 安静返回 no-key（什么都不做）
 * ```
 *
 * 用户可见后果：**"上次打开的会话"随机失效**（差的就是两个 async 谁先跑完），
 * 而键一旦被清就是永久的（除非用户再手动点一次会话）。
 * 这与"镜像未就绪被当成已删除"是同一类缺陷 —— 把"还没有值"当成"用户没有上次会话"。
 *
 * ## 判据放在这里而不是 App 里
 *
 * 因为它是**这条链路的契约**：`restoreLastOpenedSession` 会把它置为"已定论"，
 * 记录端只负责问。放两处就会分叉。
 */
let restoreSettled = false;

/**
 * 记录端问：现在能不能把"上次会话"键写成 `null`？
 *
 * @returns `true` = **别写**，恢复还没拿到结论（写 null 会抹掉用户的上次会话）
 */
export function shouldPreserveLastSessionKey(): boolean {
  return !restoreSettled;
}

/** 仅供测试：把"已定论"标记复位（模拟一次新的启动） */
export function __resetRestoreSettledForTests(): void {
  restoreSettled = false;
}

/**
 * 恢复"上次打开"的目标 —— **只返回校验过的目标**，由调用方决定怎么落到 store。
 *
 * ## 为什么要"校验目标仍存在"（这是 D-20 的核心，而不是附属条件）
 *
 * 上次的会话可能已经被删除、它所属的项目可能已经被删除（级联删会话），
 * 也可能库被清空/换库。直接 `setState({currentSession: 上次那个})` 会把界面
 * 指向一个**不存在的会话**：消息区空白、发送落进一个没有会话行的 id（引擎外键拒绝）、
 * 侧边栏高亮一个不存在的条目。所以这里的判据是"**从库里读得回来**"，
 * 而不是"键里有值"。
 *
 * 三条回落规则：
 * - 会话读不回来 → 不恢复会话（**并清掉这个键**，避免每次启动都白查一次）；
 * - 会话在、项目不在了 → 会话那一行是权威（`session.projectId`），按它恢复；
 *   存的项目 id 与它会话的真实归属不一致时，以**会话的真实归属**为准
 *   （键可能落后于"会话被移动过"这种少见事实）；
 * - 什么都没有 → 返回 `null`，调用方保持"无会话"状态（**安静回落**，不打错误）。
 * - ⚠️ **读不到 ≠ 已删除**（第 47 轮补）：镜像未就绪时**既不清键也不恢复**，
 *   让调用方下次再试 —— 详见 `readSessionState` 的长注释。
 *
 * 读取与校验全部 try/catch 且**信息级**：这个函数在每次启动都会跑，
 * 任何"报错刷屏"都会变成用户每次开应用都看到一条红字。
 */
export function resolveRestoreTarget(): {
  project: Project | null;
  session: Session | null;
  /** 诊断用：为什么没恢复（英文标识，便于在日志里搜索） */
  reason?: "no-key" | "session-missing" | "project-missing" | "storage-unavailable";
} {
  const sessionId = (() => {
    try {
      return readLastSessionId();
    } catch (e) {
      console.warn("[preferences] 读 codem-last-session 失败（按没有上次会话处理）:", e);
      return null;
    }
  })();
  if (!sessionId) {
    // 没有键 = **明确的结论**（不是"还没读到"）→ 记录端从此可以照常写
    restoreSettled = true;
    return { project: null, session: null, reason: "no-key" };
  }

  const read = readSessionState(sessionId);

  /**
   * ⚠️ **这一支是第 47 轮补的关键**：镜像/端口还没接手时，`getSession` 同样返回 null，
   * 但那是"读不到"，**绝不能**当成"已删除"去清键 —— 清了就再也回不来了
   * （调用点是一次性闸门）。这里什么都不写，安静返回，等下一次启动/下一次尝试。
   */
  if (read.kind === "unavailable") {
    console.log(
      "[preferences] 会话镜像尚未就绪 → 本次不恢复也不清键（下次启动会再试一次；" +
        "把「读不到」当成「已删除」会永久抹掉用户的「上次打开的会话」）",
    );
    /*
     * ⚠️ `unavailable` 是**可重试**的，但记录端**仍然可以开始工作**：
     * 键保住了（上面什么都没写），而"没有会话"这个瞬时状态不该阻止记录端
     * 在用户真的打开一个会话时把它记下来（那条路走的是 `currentSession?.id` 有值那一支）。
     * 真正要防的是"恢复还没读到键就把键写成 null"——那一步已经过去（`readSessionState` 跑完了）。
     */
    restoreSettled = true;
    return { project: null, session: null, reason: "storage-unavailable" };
  }

  if (read.kind === "missing") {
    // 会话已被删除：清键 + 信息级记录（**不是**错误，这是正常操作）
    console.log(`[preferences] 上次打开的会话 ${sessionId.slice(0, 12)}… 已不存在 → 从"无会话"状态启动`);
    try {
      writeLastSessionId(null);
    } catch (e) {
      console.warn("[preferences] 清理 codem-last-session 失败:", e);
    }
    restoreSettled = true;
    return { project: null, session: null, reason: "session-missing" };
  }

  const session = read.session;

  const projectId = session.projectId ?? "";
  if (!projectId) {
    // 全局会话（没有项目）：合法形态，照常恢复会话
    restoreSettled = true;
    return { project: null, session };
  }
  let project: Project | null = null;
  try {
    project = ProjectStorage.getProject(projectId);
  } catch (e) {
    console.warn("[preferences] 校验上次项目时读库失败:", e);
    project = null;
  }
  if (!project) {
    /**
     * 项目读不到。**注意：这里同样分不开"项目已删除"与"projects 镜像还没就绪"**
     * （`ProjectStorage.getProject` 也是二态）。但这一支**不会毁数据** ——
     * 它只决定"要不要带项目上下文"，会话本身照常恢复，键也不动。
     * 所以这里不去为此再造一个三态读（那是另一个接口的面积），
     * 只把日志写成**不撒谎**的措辞：不断言"已不存在"，只说"读不到，按不带项目恢复"。
     */
    console.log(
      `[preferences] 上次会话所属项目 ${projectId.slice(0, 12)}… 读不到（已删除或镜像未就绪）→ 只恢复会话（不带项目）`,
    );
    restoreSettled = true;
    return { project: null, session, reason: "project-missing" };
  }
  /**
   * ⚠️ 原来这里有一句 `if (readLastProjectId() !== projectId)` 就打印
   * "codem-last-project 与上次会话的归属不一致 → 以会话的归属为准"。
   *
   * 它是一个**永远会误报的日志**：`readLastProjectId()` 只在建库/记录会话时才被写，
   * 而**升级上来的用户**根本没有这个键 → 读到 `null !== projectId` → 每次启动都打一行
   * "不一致"。而实际上什么都没不一致（`codem-last-project` 从来不参与恢复决策，
   * 唯一"权威"就是会话那一行）。一行永远出现的假告警会训练人不看日志 ——
   * 这与第 46/47 轮修掉的那两个假警报是同一类问题。
   *
   * 现在只在**键确实存在且确实不同**时才记（那才是真的"落后了"）。
   */
  const storedProjectId = readLastProjectId();
  if (storedProjectId !== null && storedProjectId !== projectId) {
    console.log(
      `[preferences] codem-last-project（${storedProjectId.slice(0, 12)}…）与上次会话的归属` +
        `（${projectId.slice(0, 12)}…）不一致 → 以会话的归属为准`,
    );
  }
  restoreSettled = true;
  return { project, session };
}

/**
 * 把"上次打开"落到 store（App 在 `dbReady` **之后**调用一次）。
 *
 * 为什么必须 `dbReady` 之后：`SessionStorage.getSession` / `ProjectStorage.listProjects`
 * 走引擎端口；首帧调用拿到的是空镜像，于是"目标不存在"这个结论会是**假**的
 * （把用户真实的会话当成已删除清掉键 —— 那就从"能力缺失"变成了"数据丢失"）。
 *
 * @returns 是否真的恢复了会话
 */
export function restoreLastOpenedSession(
  store: {
    setProjects: (projects: Project[]) => void;
    setSessions: (sessions: Session[]) => void;
    setState: (partial: { currentProject: Project | null; currentSession: Session | null }) => void;
  },
  reasonLabel = "启动恢复",
): boolean {
  const target = resolveRestoreTarget();
  if (!target.session) return false;

  const project = target.project;
  /**
   * `projects` / `sessions` 两个列表先补齐：`switchSession` 与侧边栏都从**内存列表**里找，
   * 只写 `currentSession` 而不填列表，会出现"当前会话渲染出来了、侧边栏里没有这一条"。
   */
  try {
    const projects = ProjectStorage.listProjects();
    store.setProjects(projects);
    if (project) {
      store.setSessions(SessionStorage.listSessions(project.id));
    }
  } catch (e) {
    console.warn("[preferences] 恢复时读取项目/会话列表失败（继续恢复当前会话）:", e);
  }

  store.setState({ currentProject: project, currentSession: target.session });
  console.log(
    `[${reasonLabel}] 已恢复上次打开的会话 ${target.session.id}（标题：${target.session.title}）` +
      (project ? `，项目：${project.name}` : "，未挂项目"),
  );
  return true;
}

/**
 * 会话被删除时清掉"上次打开的会话"键（避免下次启动为一条不存在的会话白查一次 + 打一行日志）。
 *
 * 刻意**不**碰 `codem-last-project`：项目还在，用户下次打开应用仍然该落在那个项目上。
 */
export function forgetLastSessionIfDeleted(sessionId: string): void {
  try {
    if (readLastSessionId() === sessionId) writeLastSessionId(null);
  } catch (e) {
    reportPersistFailure("preferences.forgetLastSession", e, "上次会话键未清理（不影响删除本身）");
  }
}
