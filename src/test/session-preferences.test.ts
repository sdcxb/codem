/**
 * 会话级 UI 偏好 + 「上次打开」恢复的回归契约（第 47 轮：D-20 / D-22 收口）
 *
 * ## 这个用例文件守的是什么
 *
 * 被测实现是 `src/core/session/preferences.ts`。它存在的直接原因是两条审计条目
 * （`.preview-shot/_audit/SETTINGS-LOOP.md` 的 D-20 / D-22）卡在同一件事上：
 * **界面偏好有两套介质，而且「上次打开哪个会话」这个能力根本不存在。**
 *
 * 审计报告里那两条当时的处置是「守门」（只把现状钉成断言，因为修它们要动 `src/App.tsx`）。
 * 现在实现补上了，那些守门用例被**反转成真实契约**（`settings-tail-fixes.test.ts` 的
 * `SKEY-D20-*` / `SKEY-D22-*`），本文件负责行为面。
 *
 * ## 每条断言对应的**用户可见后果**
 *
 * | 组 | 用户可见后果 |
 * | --- | --- |
 * | `PREF-D22-*` | 换 profile / 清缓存 / 换机器后，插件开关不该凭空回到默认 |
 * | `PREF-D20-*` | 重启应用后应回到昨天那个会话；而**不该**因为键里有值就指向一个已删除的会话 |
 * | `PREF-WIRE-*` | 实现存在 ≠ 生效：模块写好了但没人调用，等于没修（第 47 轮最贵的那一课） |
 *
 * ## 为什么这些用例必须在**真端口契约**层面驱动
 *
 * 第 46 轮的教训（见 `SESSION-STATE.md`）：测试双比实现宽松会把缺陷藏起来。
 * 所以这里一律走 `setStoragePort(createFakeStoragePort(...))`，**不 mock
 * `getSettingJSON`** —— 断言的是「真的写进了 settings 表」，而不是「函数被调用了」。
 *
 * ## 读这个文件时的注意
 *
 * 中文里的引号一律用「」（全角），**不用 ASCII 双引号** —— 后者在 TS 字符串里
 * 会提前终止字面量（本文件第一版就是这么写坏的，`settings-key-scan` 的注释里也提过同类坑）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { stripComments } from "./helpers/settings-key-scan";

/** 假端口的行形状（`fake-storage-port.ts` 里的 `Row` 没有导出，这里用同一种形状） */
type Row = Record<string, unknown>;

const ROOT = join(__dirname, "..", "..");
/** 读源码并剥注释：本仓库注释里大量逐字引用被修掉的坏写法，不剥注释会把自己绊倒 */
const readCode = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

/** DB 里的 `settings` 行 → 供 `getSettingJSON` 读的字符串值（settings.ts 存的是 JSON 文本） */
const settingRow = (key: string, value: unknown): Row => ({ key, value: JSON.stringify(value) });

/** 会话行（列名走线协议：`session.ts::wireToSession`） */
const sessionRow = (over: Partial<Record<string, unknown>> & { id: string }): Row => ({
  project_id: "",
  title: "会话",
  model: null,
  created_at: 100,
  last_message_at: 200,
  message_count: 0,
  pinned: 0,
  ...over,
});

/** 项目行（列名走线协议：`project.ts` 的读行映射） */
const projectRow = (over: Partial<Record<string, unknown>> & { id: string }): Row => ({
  name: "项目",
  path: "C:\\proj",
  description: null,
  pinned: 0,
  created_at: 1,
  last_accessed_at: 2,
  ...over,
});

let port: FakeStoragePort;

/**
 * 注册一个**已预热**的假端口。
 *
 * 真实启动顺序是 `RustStoragePort.start()` 先 `await config.warmup()` 再
 * `setStoragePort(port)` —— 不 warmup 就注册的话 `getSetting` 一律返回 null
 * （配置面未预热），那是「端口没就绪」的形态，不是本文件要验的东西。
 */
async function installPort(seed: Record<string, Row[]> = {}) {
  port = createFakeStoragePort({ seed });
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

/** 端口里某张表的原始行 */
const rowsOf = (table: string): Row[] => port.__table(table);
/** 端口里 settings 表某个键的**原始**（JSON 文本）值 */
const rawSetting = (key: string): string | undefined => {
  const row = rowsOf("settings").find((r) => r.key === key);
  return row === undefined ? undefined : String(row.value);
};

beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  // 测试环境固有噪音：没有 __TAURI__，JSONL 那条腿必然告警（与既有用法一致）
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

// ==========================================================================
// D-22：插件禁用列表的介质统一（DB 权威 + localStorage 镜像）
// ==========================================================================

describe("PREF-D22：插件禁用列表的介质（DB 权威，localStorage 只是镜像）", () => {
  it("PREF-D22-1: DB 有值 → 用它，并把值回写镜像（旧读方只认镜像）", async () => {
    const { loadDisabledPlugins } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow("codem-disabled-plugins", ["@codem/ui-game", "@codem/ui-misc"])],
    });
    // 镜像里是一条**过期**的旧值：它绝不能被当权威
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-stale"]));

    const state = loadDisabledPlugins();

    expect(state.list, "DB 是权威介质").toEqual(["@codem/ui-game", "@codem/ui-misc"]);
    expect(state.migrated).toBe(false);
    expect(state.seeded).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("codem:disabled-plugins")!),
      "旧读方（PanelSidebar / gating / 插件管理器）只认镜像，必须回写成 DB 的值",
    ).toEqual(["@codem/ui-game", "@codem/ui-misc"]);
  });

  it("PREF-D22-2: DB 里是空数组也算「有值」—— 用户全启用的选择不能被镜像覆盖", async () => {
    const { loadDisabledPlugins } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow("codem-disabled-plugins", [])] });
    // 镜像里还留着关插件时的旧值
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-game"]));

    const state = loadDisabledPlugins();

    expect(
      state.list,
      "空数组与「没设置过」必须分得开：把空数组当「没值」就会复活镜像里的旧值（静默丢用户选择）",
    ).toEqual([]);
    expect(state.migrated).toBe(false);
    expect(rawSetting("codem-disabled-plugins"), "DB 不能被镜像覆写").toBe("[]");
  });

  it("PREF-D22-3: DB 没有、镜像有 → 迁移进 DB（值不变，且不是默认值）", async () => {
    const { loadDisabledPlugins } = await import("../core/session/preferences");
    await installPort();
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-theme", "@codem/ui-game"]));

    const state = loadDisabledPlugins();

    expect(state.list).toEqual(["@codem/ui-theme", "@codem/ui-game"]);
    expect(state.migrated, "必须如实报告这次是迁移来的").toBe(true);
    expect(state.seeded).toBe(false);
    expect(
      rawSetting("codem-disabled-plugins"),
      "迁移必须真的落进 DB（否则「换 profile 就丢」这条缺陷只是换了个说法）",
    ).toBe(JSON.stringify(["@codem/ui-theme", "@codem/ui-game"]));
  });

  it("PREF-D22-4: 两边都没有 → 首次运行默认值（游戏插件关），并同时写 DB 与镜像", async () => {
    const { loadDisabledPlugins, DEFAULT_DISABLED_PLUGINS } = await import("../core/session/preferences");
    await installPort();
    expect(localStorage.getItem("codem:disabled-plugins"), "前提：镜像也没有").toBeNull();

    const state = loadDisabledPlugins();

    expect(state.list).toEqual([...DEFAULT_DISABLED_PLUGINS]);
    expect(state.seeded).toBe(true);
    expect(state.migrated).toBe(false);
    expect(rawSetting("codem-disabled-plugins")).toBe(JSON.stringify([...DEFAULT_DISABLED_PLUGINS]));
    expect(JSON.parse(localStorage.getItem("codem:disabled-plugins")!)).toEqual([...DEFAULT_DISABLED_PLUGINS]);
  });

  it("PREF-D22-5: 镜像 JSON 坏掉 → 按「没有值」处理（走默认），不抛、不把脏值当权威", async () => {
    const { loadDisabledPlugins } = await import("../core/session/preferences");
    await installPort();
    localStorage.setItem("codem:disabled-plugins", "{不是合法 JSON");

    const state = loadDisabledPlugins();

    expect(state.seeded, "解析失败是「没设置过」，不是「设置成空」（否则用户开关会被清空）").toBe(true);
    expect(state.list.length).toBeGreaterThan(0);
  });

  it("PREF-D22-6: DB 里存了非数组脏值 → 不能被当成权威（回落镜像/默认）", async () => {
    const { loadDisabledPlugins } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow("codem-disabled-plugins", { oops: true })] });
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-goal"]));

    const state = loadDisabledPlugins();

    expect(state.list, "形状不对的 DB 值必须被拒绝，否则 includes 会拿到一个对象").toEqual(["@codem/ui-goal"]);
  });

  it("PREF-D22-7: adoptDisabledPluginsMirror —— 镜像变了才收编，一样就什么都不写", async () => {
    const { adoptDisabledPluginsMirror } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow("codem-disabled-plugins", ["@codem/ui-game"])] });

    // ① 镜像与 DB 相同 → 不做无谓写
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-game"]));
    expect(adoptDisabledPluginsMirror(), "相同就不该报发生了收编").toBe(false);
    expect(rawSetting("codem-disabled-plugins")).toBe(JSON.stringify(["@codem/ui-game"]));

    // ② 镜像与 DB 不同（PluginManagerService 仍直接写镜像 → 镜像才是最晚的事实）→ 收编
    localStorage.setItem("codem:disabled-plugins", JSON.stringify(["@codem/ui-misc"]));
    expect(adoptDisabledPluginsMirror()).toBe(true);
    expect(rawSetting("codem-disabled-plugins"), "镜像的新值必须进 DB").toBe(JSON.stringify(["@codem/ui-misc"]));
  });

  it("PREF-D22-8: 镜像不存在时收编不写（不能把「镜像没值」当成「用户清空了」）", async () => {
    const { adoptDisabledPluginsMirror } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow("codem-disabled-plugins", ["@codem/ui-game"])] });
    expect(localStorage.getItem("codem:disabled-plugins")).toBeNull();

    expect(adoptDisabledPluginsMirror()).toBe(false);
    expect(rawSetting("codem-disabled-plugins"), "DB 必须原样保留").toBe(JSON.stringify(["@codem/ui-game"]));
  });

  it("PREF-D22-9: saveDisabledPlugins 双写（DB + 镜像）", async () => {
    const { saveDisabledPlugins, DISABLED_PLUGINS_KEY, DISABLED_PLUGINS_LS_KEY } = await import(
      "../core/session/preferences"
    );
    await installPort();

    saveDisabledPlugins(["@codem/ui-cordis"]);

    expect(rawSetting(DISABLED_PLUGINS_KEY)).toBe(JSON.stringify(["@codem/ui-cordis"]));
    expect(JSON.parse(localStorage.getItem(DISABLED_PLUGINS_LS_KEY)!)).toEqual(["@codem/ui-cordis"]);
  });
});

// ==========================================================================
// D-20：上次打开的会话 / 项目
// ==========================================================================

describe("PREF-D20：上次打开的会话 / 项目", () => {
  it("PREF-D20-1: 没有键 → 不恢复（安静回落，不是错误）", async () => {
    const { resolveRestoreTarget } = await import("../core/session/preferences");
    await installPort({ sessions: [sessionRow({ id: "s1" })] });

    const target = resolveRestoreTarget();

    expect(target.session).toBeNull();
    expect(target.project).toBeNull();
    expect(target.reason).toBe("no-key");
  });

  it("PREF-D20-2: 键指向的会话已被删除 → 不恢复，并清掉键（避免每次启动白查）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "gone-session")],
      sessions: [sessionRow({ id: "s1" })],
    });

    const target = resolveRestoreTarget();

    expect(target.session, "读不回来的会话绝不能被 setState 成 currentSession（会渲染出一个空壳）").toBeNull();
    expect(target.reason).toBe("session-missing");
    expect(rawSetting(LAST_SESSION_KEY), "键必须被清掉").toBe(JSON.stringify(null));
  });

  it("PREF-D20-3: 会话与项目都在 → 两者一起恢复（项目从会话的归属反查）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY, LAST_PROJECT_KEY } = await import(
      "../core/session/preferences"
    );
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-proj"), settingRow(LAST_PROJECT_KEY, "p1")],
      sessions: [sessionRow({ id: "s-proj", project_id: "p1", title: "昨天那个会话" })],
      projects: [projectRow({ id: "p1", name: "我的项目" })],
    });

    const target = resolveRestoreTarget();

    expect(target.session?.id).toBe("s-proj");
    expect(target.project?.id).toBe("p1");
    expect(target.project?.name).toBe("我的项目");
  });

  it("PREF-D20-4: 全局会话（project_id 为空）→ 恢复会话但不带项目（合法形态，不是失败）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-global")],
      sessions: [sessionRow({ id: "s-global", project_id: "" })],
      projects: [projectRow({ id: "p1" })],
    });

    const target = resolveRestoreTarget();

    expect(target.session?.id).toBe("s-global");
    expect(target.project, "全局会话不该被硬塞一个项目").toBeNull();
  });

  it("PREF-D20-5: 项目没了但会话还在 → 只恢复会话（拿会话那一行当权威）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-orphan")],
      sessions: [sessionRow({ id: "s-orphan", project_id: "p-deleted" })],
      projects: [],
    });

    const target = resolveRestoreTarget();

    expect(target.session?.id, "会话仍然可用 —— 项目没了不该连带丢掉会话").toBe("s-orphan");
    expect(target.project).toBeNull();
    expect(target.reason).toBe("project-missing");
  });

  it("PREF-D20-6: 键里的会话 id 与项目 id 不一致 → 以会话的真实归属为准", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY, LAST_PROJECT_KEY } = await import(
      "../core/session/preferences"
    );
    await installPort({
      settings: [
        settingRow(LAST_SESSION_KEY, "s-moved"),
        // 存的键落后了：会话后来被移动到 p2
        settingRow(LAST_PROJECT_KEY, "p1"),
      ],
      sessions: [sessionRow({ id: "s-moved", project_id: "p2" })],
      projects: [projectRow({ id: "p1", name: "旧项目" }), projectRow({ id: "p2", name: "新项目" })],
    });

    const target = resolveRestoreTarget();

    expect(target.session?.id).toBe("s-moved");
    expect(target.project?.id, "必须按会话那一行恢复（否则界面高亮错项目）").toBe("p2");
  });

  it("PREF-D20-7: writeLastSessionId(null) 是显式清键；写 id 之后读得回来", async () => {
    const { writeLastSessionId, readLastSessionId, LAST_SESSION_KEY } = await import(
      "../core/session/preferences"
    );
    await installPort();

    writeLastSessionId("s-abc");
    expect(readLastSessionId()).toBe("s-abc");
    expect(rawSetting(LAST_SESSION_KEY)).toBe(JSON.stringify("s-abc"));

    writeLastSessionId(null);
    expect(readLastSessionId(), "清掉之后必须读回 null（不能让旧 id 复活）").toBeNull();
  });

  it("PREF-D20-8: 项目键的空串是合法值（上次就没有项目），不能读成没设置过", async () => {
    const { writeLastProjectId, readLastProjectId } = await import("../core/session/preferences");
    await installPort();

    writeLastProjectId("");
    expect(readLastProjectId(), "空串必须原样读回（null 与 空串 在业务上是两种状态）").toBe("");

    writeLastProjectId("p9");
    expect(readLastProjectId()).toBe("p9");
  });

  it("PREF-D20-9: forgetLastSessionIfDeleted —— 只清会话键，不碰项目键", async () => {
    const { forgetLastSessionIfDeleted, LAST_SESSION_KEY, LAST_PROJECT_KEY } = await import(
      "../core/session/preferences"
    );
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-del"), settingRow(LAST_PROJECT_KEY, "p1")],
    });

    forgetLastSessionIfDeleted("s-del");

    expect(rawSetting(LAST_SESSION_KEY)).toBe(JSON.stringify(null));
    expect(rawSetting(LAST_PROJECT_KEY), "项目还在 —— 下次打开仍该落在那个项目上").toBe(JSON.stringify("p1"));
  });

  it("PREF-D20-10: forgetLastSessionIfDeleted 对别的会话是 no-op（删 s2 不能清掉 s1 的记录）", async () => {
    const { forgetLastSessionIfDeleted, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow(LAST_SESSION_KEY, "s1")] });

    forgetLastSessionIfDeleted("s2");

    expect(rawSetting(LAST_SESSION_KEY)).toBe(JSON.stringify("s1"));
  });

  it("PREF-D20-11: restoreLastOpenedSession 落到 store：项目/会话列表要一起补齐", async () => {
    const { restoreLastOpenedSession, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-restore")],
      sessions: [
        sessionRow({ id: "s-restore", project_id: "p1" }),
        sessionRow({ id: "s-other", project_id: "p1" }),
      ],
      projects: [projectRow({ id: "p1" })],
    });

    const calls: Record<string, unknown> = {};
    const ok = restoreLastOpenedSession({
      setProjects: (p) => { calls.projects = p; },
      setSessions: (s) => { calls.sessions = s; },
      setState: (partial) => { calls.state = partial; },
    });

    expect(ok).toBe(true);
    expect((calls.projects as unknown[]).length, "项目列表必须补齐").toBe(1);
    expect(
      (calls.sessions as unknown[]).length,
      "会话列表必须补齐 —— 只写 currentSession 会出现会话渲染了、侧边栏里却没有这一条",
    ).toBe(2);
    expect((calls.state as any).currentSession?.id).toBe("s-restore");
    expect((calls.state as any).currentProject?.id).toBe("p1");
  });

  it("PREF-D20-12: restoreLastOpenedSession 目标不存在 → 返回 false 且不碰 store", async () => {
    const { restoreLastOpenedSession, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow(LAST_SESSION_KEY, "gone")], sessions: [] });

    let touched = false;
    const ok = restoreLastOpenedSession({
      setProjects: () => { touched = true; },
      setSessions: () => { touched = true; },
      setState: () => { touched = true; },
    });

    expect(ok).toBe(false);
    expect(touched, "目标不存在时必须安静回落，不能把 store 指向一个不存在的会话").toBe(false);
  });

  it("PREF-D20-13: 读库抛异常 → 按没有上次会话处理，不抛（不能因为恢复失败就白屏）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow(LAST_SESSION_KEY, "s-boom")] });
    // 端口撤掉 → 读库路径抛错（模拟引擎不可用）
    setStoragePort(null);

    let target: ReturnType<typeof resolveRestoreTarget> | null = null;
    expect(() => { target = resolveRestoreTarget(); }, "启动路径上的恢复动作绝不允许抛出").not.toThrow();
    expect(target!.session).toBeNull();
  });

  it("PREF-D20-14: 镜像未就绪 → **不清键**（'读不到'绝不能被当成'已删除'）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    /*
     * 这一条守的是第 47 轮补修掉的**会毁数据**的缺陷。
     *
     * 改前：`SessionStorage.getSession` 把 `domainReadOne` 的 `undefined`（端口/镜像没接手）
     * 与 `null`（确实没这行）都返回 `null`，而恢复逻辑把 `null` 一律当"已删除" →
     * **清掉用户的上次会话键**；调用点又用一次性闸门，一次误判定终身。
     *
     * 现场就是"sessions 镜像还没接手"这个窗口（仓库里
     * `loadFromDB: found 0 projects` → 就绪后 `found 1` 那个补丁是同一窗口的物证）。
     * 这里用假端口的 `neverReady: ["sessions"]` 精确造出该形态：
     * **settings 读得到**（所以能拿到键），而 **sessions 读不到**。
     */
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const p = createFakeStoragePort({
      seed: { settings: [settingRow(LAST_SESSION_KEY, "s-not-loaded")] },
      neverReady: ["sessions"],
    });
    await p.config.warmup();
    setStoragePort(p);

    const target = resolveRestoreTarget();

    expect(target.session, "读不到就不该恢复").toBeNull();
    expect(
      target.reason,
      "必须如实报 'storage-unavailable'（不是 'session-missing'）",
    ).toBe("storage-unavailable");
    /*
     * 关键断言：**键必须还在**。注意这里读的是**本用例装的那个端口**（`p`），
     * 不是模块级的 `port`（那个还指向上一个用例的端口 —— 断言会读到别人的数据）。
     */
    const row = p.__table("settings").find((r) => r.key === LAST_SESSION_KEY);
    expect(row, "键那一行必须还在").toBeTruthy();
    expect(
      String(row!.value),
      "清掉它就永久抹掉了用户的「上次打开的会话」（调用点是一次性闸门，清了不会自己回来）",
    ).toBe(JSON.stringify("s-not-loaded"));
    setStoragePort(null);
  });

  it("PREF-D20-15: 会话**确实**被删除 → 才清键（与上一条形成方向相反的对照）", async () => {
    const { resolveRestoreTarget, LAST_SESSION_KEY } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LAST_SESSION_KEY, "s-deleted")],
      sessions: [], // 表就绪、但确实没有这一行 → null（真·已删除）
    });

    const target = resolveRestoreTarget();

    expect(target.session).toBeNull();
    expect(target.reason, "这一支才是 'session-missing'").toBe("session-missing");
    expect(rawSetting(LAST_SESSION_KEY), "确实已删除才清键").toBe(JSON.stringify(null));
  });
});

// ==========================================================================
// App / store 侧接线：实现存在 ≠ 生效（第 47 轮最贵的那一课）
// ==========================================================================

describe("PREF-WIRE：App / store 侧的真实接线（否则实现只是死代码）", () => {
  it("PREF-WIRE-1: App.tsx 真的调用了恢复与插件介质统一（不是只写了模块）", () => {
    const app = readCode("src/App.tsx");
    expect(app, "启动恢复必须被调用").toContain("restoreLastOpenedSession");
    expect(app, "插件禁用列表必须读 DB 权威值").toContain("loadDisabledPlugins");
    expect(app, "插件开关变化必须收编进 DB").toContain("adoptDisabledPluginsMirror");
  });

  it("PREF-WIRE-2: 恢复动作的闸门**只在拿到明确结论后才关上**（'读不到'必须可重试）", () => {
    const app = readCode("src/App.tsx");
    expect(app, "必须有收工的 ref").toContain("restoredLastSessionRef");
    expect(app, "还必须有串联保护（恢复未落地时 effect 会因 currentProject 变化再跑）").toContain(
      "restoreInFlightRef",
    );
    // 判断侧同时看两个 ref
    expect(app).toMatch(/if\s*\(!restoredLastSessionRef\.current\s*&&\s*!restoreInFlightRef\.current\)/);
    expect(app).toMatch(/restoredLastSessionRef\.current\s*=\s*true/);
    /**
     * ⚠️ 这一条是本轮修掉的那个**会毁数据**的形状，必须钉住：
     * 闸门**不许**写在尝试之前（那样一次误判定终身），而必须写在
     * "拿到明确结论（reason !== 'storage-unavailable'）"之后。
     */
    expect(
      app,
      "必须先判断结论是否明确，再置位闸门（改前是尝试之前就置位，于是镜像未就绪会把键永久清掉）",
    ).toMatch(/if\s*\(target\.reason\s*!==\s*"storage-unavailable"\)\s*\{[\s\S]{0,120}?restoredLastSessionRef\.current\s*=\s*true/);
    // 必须是**有界**重试，不是无限轮询
    expect(app, "重试必须有上限").toMatch(/STORAGE_UNAVAILABLE_RETRIES\s*=\s*\d+/);
    // 恢复动作自己会改 currentProject —— 而 effect 依赖含它，所以闸门是必需的
    expect(app, "effect 依赖里必须真的有 currentProject?.path").toMatch(/\}, \[dbReady, currentProject\?\.path\]\);/);
  });

  it("PREF-WIRE-3: 记录端存在 —— 每次 currentSession 变化都记一次（只补恢复端等于永远 no-key）", () => {
    const app = readCode("src/App.tsx");
    expect(app, "必须有写上次会话的地方").toContain("writeLastSessionId");
    expect(app).toContain("writeLastProjectId");
  });

  it("PREF-WIRE-4: 会话被删除时清掉上次打开的会话键（store 侧）", () => {
    const store = readCode("src/core/store.ts");
    expect(store, "删除路径必须清理这个键").toContain("forgetLastSessionIfDeleted");
  });

  it("PREF-WIRE-5: 恢复发生在 dbReady 之后（首帧读不到库，目标不存在会是假结论）", () => {
    const app = readCode("src/App.tsx");
    // 恢复调用必须落在 `if (dbReady) {` 那一段里：取 dbReady 判断之后、effect 结束之前的片段
    const start = app.indexOf("if (dbReady) {");
    expect(start, "App.tsx 里必须有 dbReady 守卫").toBeGreaterThan(-1);
    expect(app.indexOf("restoreLastOpenedSession"), "恢复必须在 dbReady 守卫内").toBeGreaterThan(start);
  });

  it("PREF-WIRE-6: D-19 的 App 级死快捷访问区块已删除（showQuickAccess 从来没被设成 true）", () => {
    const app = readCode("src/App.tsx");
    expect(
      /setShowQuickAccess\(\s*true\s*\)/.test(app),
      "这块 UI 的显示条件依赖 showQuickAccess，而它只有 setShowQuickAccess(false) —— 永不可达",
    ).toBe(false);
    expect(app.includes("showQuickAccess"), "死 UI 已删除（连同它的状态）").toBe(false);
    // 活着的同类能力在 ChatPanel（初值 true，槽位真接入）
    const chat = readCode("src/components/ChatPanel.tsx");
    expect(chat).toContain("QuickAccessCards");
  });
});
