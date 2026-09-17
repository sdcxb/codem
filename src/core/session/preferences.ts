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
function writeDisabledPluginsMirror(list: readonly string[]): void {
  try {
    localStorage.setItem(DISABLED_PLUGINS_LS_KEY, JSON.stringify(list));
  } catch {
    // localStorage 不可用（隐私模式/配额满）不影响 DB 那一份 —— 但要说出来
    console.warn("[preferences] 插件禁用列表的 localStorage 镜像未写入（DB 那一份不受影响）");
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
    writeDisabledPluginsMirror(list);
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
 * ⚠️ 真实写入方目前仍主要是 `PluginManagerService`（它直接写镜像）——
 * 那个文件不在本次改动的责任范围内（见报告"需要他人配合"）。所以这里除了"DB 侧写入"，
 * 还提供 `adoptDisabledPluginsMirror()` 让 App 在启动/状态变化时把镜像**收编**进 DB：
 * 镜像变成"DB 的副本"，而不是第二个真相源。
 */
export function saveDisabledPlugins(list: readonly string[]): void {
  setSettingJSON(DISABLED_PLUGINS_KEY, [...list]);
  writeDisabledPluginsMirror(list);
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
 *
 * 读取与校验全部 try/catch 且**信息级**：这个函数在每次启动都会跑，
 * 任何"报错刷屏"都会变成用户每次开应用都看到一条红字。
 */
export function resolveRestoreTarget(): {
  project: Project | null;
  session: Session | null;
  /** 诊断用：为什么没恢复（英文标识，便于在日志里搜索） */
  reason?: "no-key" | "session-missing" | "project-missing";
} {
  const sessionId = (() => {
    try {
      return readLastSessionId();
    } catch (e) {
      console.warn("[preferences] 读 codem-last-session 失败（按没有上次会话处理）:", e);
      return null;
    }
  })();
  if (!sessionId) return { project: null, session: null, reason: "no-key" };

  let session: Session | null = null;
  try {
    session = SessionStorage.getSession(sessionId);
  } catch (e) {
    console.warn("[preferences] 校验上次会话时读库失败（按不存在处理）:", e);
    session = null;
  }
  if (!session) {
    // 会话已被删除：清键 + 信息级记录（**不是**错误，这是正常操作）
    console.log(`[preferences] 上次打开的会话 ${sessionId.slice(0, 12)}… 已不存在 → 从"无会话"状态启动`);
    try {
      writeLastSessionId(null);
    } catch (e) {
      console.warn("[preferences] 清理 codem-last-session 失败:", e);
    }
    return { project: null, session: null, reason: "session-missing" };
  }

  const projectId = session.projectId ?? "";
  if (!projectId) {
    // 全局会话（没有项目）：合法形态，照常恢复会话
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
     * 项目没了但会话还在（少见：会话行被单独搬过库）。会话仍然可用 ——
     * 恢复它，只是不带项目上下文（与"全局会话"同一种形态）。
     */
    console.log(
      `[preferences] 上次会话所属项目 ${projectId.slice(0, 12)}… 已不存在 → 只恢复会话（不带项目）`,
    );
    return { project: null, session, reason: "project-missing" };
  }
  // 存的项目键与会话真实归属不一致时，以会话为准（不覆盖用户看到的那个会话）
  if (readLastProjectId() !== projectId) {
    console.log("[preferences] codem-last-project 与上次会话的归属不一致 → 以会话的归属为准");
  }
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
