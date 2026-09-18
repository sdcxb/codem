/**
 * 插件开关的介质契约（第 48 轮：D-22 的最后一处收口）
 *
 * ## 这个文件守的用户可见后果
 *
 * 「我在插件管理器里关掉了一个插件，重启以后它自己又开了，而且没有任何提示。」
 *
 * 这条后果的成因不是"没写 DB"，而是**两份介质不是原子写入的**：
 * `setSettingJSON` 的契约是"内存即时生效 + 异步落库"（`settings.ts` 文件头），
 * 第 47 轮的写法是"插件管理器只写 localStorage 镜像 → App 收到
 * `codem:plugin-state-changed` 事件 → 异步把镜像收编进 DB"。
 * 于是"用户点了开关"到"权威介质落地"之间隔着：一次事件派发 + 一次动态 `import()`
 * + 一次异步落库。进程在这个窗口里被杀掉（或崩溃、或被任务管理器结束），
 * 盘上 DB 还是旧值，而下次启动的 `loadDisabledPlugins` 契约是"DB 有值就以 DB 为准
 * **并回写镜像**" —— 用户的开关就这样被静默改回去，且镜像里的新值也被抹掉，
 * 事后连取证都取不到。
 *
 * 第 48 轮的做法：
 * 1. **写入方唯一**：`PluginManagerService` 的开关写入走 `saveDisabledPlugins`
 *    （DB 列表 + DB 时间戳 + 镜像 + 镜像时间戳，一次写完），
 *    不再有任何"只写镜像、等别人来收编"的路径；
 * 2. **对账有判据**：`reconcileDisabledPluginsAtBoot` 用写入时间戳判断
 *    "哪一份更新"，而不是无条件"DB 为准"；
 * 3. **分歧必须可见**：两份内容不一致 = 有一次写入没落地，
 *    按项目纪律不下沉成静默路径（`console.warn` + `reportPersistFailure`）。
 *
 * ## 为什么在**真端口契约**层面驱动
 *
 * 断言的是"真的写进了 settings 表 / 真的按戳选对了那一份"，
 * 而不是"某个函数被调用了"。mock 掉 `getSettingJSON` 的话，
 * 上面那整条推理链就全在测试的假设里，不在被测代码里了。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { stripComments } from "./helpers/settings-key-scan";

type Row = Record<string, unknown>;

const ROOT = join(__dirname, "..", "..");
/** 读源码并剥注释：注释里大量逐字引用被修掉的坏写法，不剥会把自己绊倒 */
const readCode = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

const settingRow = (key: string, value: unknown): Row => ({ key, value: JSON.stringify(value) });

const LIST_KEY = "codem-disabled-plugins";
const LS_KEY = "codem:disabled-plugins";
const STAMP_KEY = "codem-disabled-plugins-at";
const LS_STAMP_KEY = "codem:disabled-plugins-at";

let port: FakeStoragePort;

async function installPort(seed: Record<string, Row[]> = {}) {
  port = createFakeStoragePort({ seed });
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

const rawSetting = (key: string): string | undefined => {
  const row = port.__table("settings").find((r) => r.key === key);
  return row === undefined ? undefined : String(row.value);
};
const dbList = (): unknown => {
  const raw = rawSetting(LIST_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
};
const mirrorList = (): unknown => {
  const raw = localStorage.getItem(LS_KEY);
  return raw === null ? undefined : JSON.parse(raw);
};
const mirrorStamp = (): string | null => localStorage.getItem(LS_STAMP_KEY);

/** 把镜像写成"某个时刻的副本"（模拟一次真实的镜像写入） */
function writeMirror(list: string[], stamp: number | null): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
  if (stamp === null) localStorage.removeItem(LS_STAMP_KEY);
  else localStorage.setItem(LS_STAMP_KEY, String(stamp));
}

/**
 * 收集 `codem:persist-failed` 事件（界面上那条常驻告警横幅的数据源）。
 *
 * 断言"上报了/没上报"必须打在**事件**上，而不是打在 `console.warn` 上：
 * 前者才是用户能看见的那条通道（`store.addPersistAlert` ← `PersistFailureBanner`），
 * 后者只是日志。
 */
function collectPersistAlerts(): {
  events: Array<{ area: string; message: string; kind: string; consequence?: string }>;
  stop: () => void;
} {
  const events: Array<{ area: string; message: string; kind: string; consequence?: string }> = [];
  const on = (e: Event) => {
    const d = (e as CustomEvent).detail as {
      area: string;
      message: string;
      kind: string;
      consequence?: string;
    };
    events.push(d);
  };
  window.addEventListener("codem:persist-failed", on);
  return { events, stop: () => window.removeEventListener("codem:persist-failed", on) };
}

beforeEach(() => {
  setStoragePort(null);
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

// ==========================================================================
// 写入：一次写完 DB + 戳 + 镜像 + 戳
// ==========================================================================

describe("PLUGIN-MEDIUM：插件开关的写入与对账", () => {
  it("PLUGIN-MEDIUM-1: saveDisabledPlugins 写 DB 列表 + DB 戳 + 镜像 + 镜像戳（四份，时戳一致）", async () => {
    const { saveDisabledPlugins } = await import("../core/session/preferences");
    await installPort();

    saveDisabledPlugins(["@codem/ui-game"]);

    expect(dbList(), "DB 是权威介质").toEqual(["@codem/ui-game"]);
    expect(mirrorList(), "旧读方只认镜像，必须同步写").toEqual(["@codem/ui-game"]);
    const dbStamp = rawSetting(STAMP_KEY);
    expect(dbStamp, "DB 必须留下写入时刻（否则启动时无法判定哪一份更新）").toBeDefined();
    expect(mirrorStamp(), "镜像也要有同一时刻").toBe(String(JSON.parse(dbStamp!)));
    expect(
      Number(mirrorStamp()),
      "两侧时戳必须是同一个数字——两次 Date.now() 会让「相等」这个判据失效",
    ).toBe(JSON.parse(dbStamp!));
  });

  it("PLUGIN-MEDIUM-2: 崩溃窗口（DB 旧、镜像新且戳更新）→ 对账取镜像，绝不静默改回用户的选择", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({
      settings: [
        settingRow(LIST_KEY, ["@codem/ui-game"]),
        settingRow(STAMP_KEY, 1000),
      ],
    });
    // 用户刚才在插件管理器里关掉了 ui-misc：镜像已更新，但异步落库没走完进程就没了
    writeMirror(["@codem/ui-game", "@codem/ui-misc"], 2000);
    const alerts = collectPersistAlerts();

    let state: ReturnType<typeof reconcileDisabledPluginsAtBoot>;
    try {
      state = reconcileDisabledPluginsAtBoot();
    } finally {
      alerts.stop();
    }

    expect(state.list, "镜像才是最新的事实，取它").toEqual(["@codem/ui-game", "@codem/ui-misc"]);
    expect(state.adoptedFromMirror).toBe(true);
    expect(state.diverged, "这是一次「写入没落地」，必须如实报告为分歧").toBe(true);
    expect(dbList(), "镜像的新值必须回写进 DB（否则下次启动还会退回旧值）").toEqual([
      "@codem/ui-game",
      "@codem/ui-misc",
    ]);
    expect(Number(rawSetting(STAMP_KEY)), "DB 的戳要跟着更新到镜像那一份").toBe(2000);
    expect(console.warn, "分歧不许静默：至少要有一行 warn").toHaveBeenCalled();
    /**
     * "失败必须可见"：用户的选择被救回来了，但**发生了一次没落地的写入** ——
     * 这件事必须走界面通道（`PersistFailureBanner`），不能只躺在控制台里。
     */
    const mine = alerts.events.filter((e) => e.area === "preferences.disabledPlugins.diverged");
    expect(mine.length, "必须上报到界面通道").toBe(1);
    expect(mine[0].kind).toBe("persist");
    expect(mine[0].message, "给用户看的那一句必须是人话（不是两份 JSON）").not.toContain("[");
    expect(mine[0].message).toContain("插件开关");
  });

  it("PLUGIN-MEDIUM-13: 横幅上的「后果」必须是真实情况（不许印出互相矛盾的两句）", async () => {
    const { reconcileDisabledPluginsAtBoot, DISABLED_PLUGINS_STAMP_KEY } = await import(
      "../core/session/preferences"
    );
    const { composePersistAlertText } = await import("../core/storage/persist-failure");
    await installPort({
      settings: [settingRow(LIST_KEY, ["@codem/ui-game"]), settingRow(DISABLED_PLUGINS_STAMP_KEY, 1000)],
    });
    writeMirror(["@codem/ui-game", "@codem/ui-misc"], 2000);
    const alerts = collectPersistAlerts();

    let state: ReturnType<typeof reconcileDisabledPluginsAtBoot>;
    try {
      state = reconcileDisabledPluginsAtBoot();
    } finally {
      alerts.stop();
    }
    expect(state.adoptedFromMirror).toBe(true);

    const evt = alerts.events.find((e) => e.area === "preferences.disabledPlugins.diverged")!;
    const text = composePersistAlertText({
      area: evt.area,
      message: evt.message,
      count: 1,
      kind: "persist",
      ...(evt.consequence ? { consequence: evt.consequence } : {}),
    });

    /**
     * 真机核验（打包版）当时印出来的是：
     *   "…已按较新的一份恢复，请确认插件开关状态。这次改动目前只在内存里，
     *     重启应用后会丢失；请检查磁盘空间与数据库文件占用。"
     * 前半句说恢复好了、后半句说会丢、还让人去查磁盘 —— 三句话里两句是错的。
     * 这一档的真实后果是"已经恢复好、没有丢"。
     */
    expect(
      text,
      "值已经恢复进 DB 了，横幅就不能说「重启应用后会丢失」",
    ).not.toContain("重启应用后会丢失");
    expect(text, "原因也不是磁盘空间/占用").not.toContain("磁盘空间");
    expect(text, "必须如实说出真实的后果").toContain("已按较新的一份恢复");
    expect(text, "并且要给出用户可以做的下一步").toContain("核对插件开关");
    /**
     * 真机核验的第二版又抓到一处：`message` 与 `consequence` 都在说"已恢复"，
     * 横幅把同一件事印了两遍。分工必须是：`message` = 发生了什么，
     * `consequence` = 结果与下一步 —— 所以"恢复"这个结论只能在 consequence 里出现一次。
     */
    expect(
      text.match(/已按较新的一份恢复/g)?.length ?? 0,
      "同一句结论只许出现一次（横幅自己重复一遍也是文案缺陷）",
    ).toBe(1);

    // 反向对照：**没有**给 consequence 的普通写失败，仍然要有那句通用后果
    // （不许为了修这一处把整条通道的默认行为改掉）
    const generic = composePersistAlertText({
      area: "settings.setSetting",
      message: "磁盘满",
      count: 1,
      kind: "persist",
    });
    expect(generic, "默认路径不受影响").toContain("重启应用后会丢失");
  });

  it("PLUGIN-MEDIUM-3: 镜像写入失败（镜像旧、DB 新且戳更新）→ DB 胜出并回写镜像", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({
      settings: [
        settingRow(LIST_KEY, ["@codem/ui-misc"]),
        settingRow(STAMP_KEY, 5000),
      ],
    });
    // 镜像那次写入失败（隐私模式/配额满）→ 镜像还是更早的旧值，且没有戳
    writeMirror(["@codem/ui-game"], null);
    const alerts = collectPersistAlerts();

    let state: ReturnType<typeof reconcileDisabledPluginsAtBoot>;
    try {
      state = reconcileDisabledPluginsAtBoot();
    } finally {
      alerts.stop();
    }

    expect(state.list, "DB 更新 → DB 胜出（不能把镜像的旧值当最新事实）").toEqual(["@codem/ui-misc"]);
    expect(state.adoptedFromMirror).toBe(false);
    expect(state.diverged).toBe(true);
    expect(mirrorList(), "镜像必须被回写成 DB 的值（旧读方看到同一份真相）").toEqual([
      "@codem/ui-misc",
    ]);
    expect(dbList(), "DB 侧一个字都不该动").toEqual(["@codem/ui-misc"]);
    /**
     * 这一档**不**弹横幅：DB 权威且完好，用户没有任何东西被丢
     * （分歧只可能来自升级前的旧数据，或镜像那次 localStorage 写入失败 ——
     * 后者 `writeDisabledPluginsMirror` 自己已经 warn 过）。
     * 为一个"什么都没丢"的情况弹常驻错误横幅，会把真正要紧的告警淹掉。
     */
    expect(
      alerts.events.filter((e) => e.area === "preferences.disabledPlugins.diverged").length,
      "没丢东西的分歧不该占用界面告警位",
    ).toBe(0);
  });

  it("PLUGIN-MEDIUM-4: 两边都没有 → 首次运行默认值，DB 与镜像都写，seed 如实上报", async () => {
    const { reconcileDisabledPluginsAtBoot, DEFAULT_DISABLED_PLUGINS } = await import(
      "../core/session/preferences"
    );
    await installPort();

    const state = reconcileDisabledPluginsAtBoot();

    expect(state.list).toEqual([...DEFAULT_DISABLED_PLUGINS]);
    expect(state.seeded).toBe(true);
    expect(state.diverged, "首次运行不是分歧").toBe(false);
    expect(dbList()).toEqual([...DEFAULT_DISABLED_PLUGINS]);
    expect(mirrorList()).toEqual([...DEFAULT_DISABLED_PLUGINS]);
  });

  it("PLUGIN-MEDIUM-5: 旧数据没有时间戳 + 两边不一致 → 保守按 DB，绝不因「看起来不一样」改写 DB", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({ settings: [settingRow(LIST_KEY, ["@codem/ui-game"])] });
    writeMirror(["@codem/ui-stale"], null);

    const state = reconcileDisabledPluginsAtBoot();

    expect(state.list, "没有戳就没有「谁更新」的判据 → 回到第 47 轮的保守判定").toEqual([
      "@codem/ui-game",
    ]);
    expect(state.adoptedFromMirror).toBe(false);
    expect(dbList()).toEqual(["@codem/ui-game"]);
    expect(mirrorList()).toEqual(["@codem/ui-game"]);
  });

  it("PLUGIN-MEDIUM-6: 两边内容相同 → 不做无谓写、不报分歧", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LIST_KEY, ["@codem/ui-game"]), settingRow(STAMP_KEY, 7000)],
    });
    writeMirror(["@codem/ui-game"], 7000);

    const state = reconcileDisabledPluginsAtBoot();

    expect(state.diverged).toBe(false);
    expect(state.adoptedFromMirror).toBe(false);
    expect(state.migrated).toBe(false);
    expect(state.seeded).toBe(false);
    expect(dbList()).toEqual(["@codem/ui-game"]);
  });

  it("PLUGIN-MEDIUM-7: 顺序敏感——镜像里出现「同长度不同内容」也必须能判出来（不是比长度）", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LIST_KEY, ["@codem/ui-game"]), settingRow(STAMP_KEY, 10)],
    });
    writeMirror(["@codem/ui-misc"], 20);

    const state = reconcileDisabledPluginsAtBoot();

    expect(state.diverged, "长度相同、内容不同同样是分歧").toBe(true);
    expect(state.list).toEqual(["@codem/ui-misc"]);
  });

  it("PLUGIN-MEDIUM-8: 空数组是合法选择——镜像「显式清空」不许被当成「没有值」", async () => {
    const { reconcileDisabledPluginsAtBoot } = await import("../core/session/preferences");
    await installPort({
      settings: [settingRow(LIST_KEY, ["@codem/ui-game"]), settingRow(STAMP_KEY, 100)],
    });
    // 用户把所有插件都启用回来了，且这次写入落了地
    writeMirror([], 200);

    const state = reconcileDisabledPluginsAtBoot();

    expect(state.list, "空数组是「用户全启用」的真实选择").toEqual([]);
    expect(state.seeded, "不许被当成首次运行去播种默认值").toBe(false);
    expect(dbList()).toEqual([]);
  });
});

// ==========================================================================
// 写入方唯一性（源码级）
// ==========================================================================

describe("PLUGIN-MEDIUM：写入方唯一（源码级，防回归）", () => {
  it("PLUGIN-MEDIUM-9: PluginManagerService 不再直接写 localStorage 镜像", () => {
    const code = readCode("src/core/plugin-loader/plugin-manager-service.ts");
    expect(
      code.includes("localStorage.setItem"),
      "开关写入必须走 saveDisabledPlugins（DB 权威 + 镜像 + 时戳）；" +
        "直接写镜像就是第 47 轮那个「等 App 来收编」的窗口",
    ).toBe(false);
    expect(code, "两个写入点都要走共享写入器").toContain("persistDisabledPlugins(");
    expect(code, "initialize 必须读对账后的值，而不是自己读镜像").toContain(
      "reconcileDisabledPluginsAtBoot",
    );
  });

  it("PLUGIN-MEDIUM-10: 插件管理器的开关写入真的落进 DB（行为面：disable 之后 DB 里有这个插件）", async () => {
    await installPort();
    const { PluginManagerService } = await import("../core/plugin-loader/plugin-manager-service");
    const { PluginDependencyGraph } = await import("../core/plugin-loader/dependency-graph");

    const graph = new PluginDependencyGraph();
    graph.register({ name: "@codem/a", provides: ["x"], inject: [], core: true });
    graph.register({ name: "@codem/b", provides: [], inject: ["x"] });
    const mgr = new PluginManagerService({ plugin: () => ({ dispose: async () => {} }) } as never, graph);
    mgr.registerPluginLoader("@codem/a", () => () => {});
    mgr.registerPluginLoader("@codem/b", () => () => {});
    await mgr.initialize();

    const res = await mgr.disable("@codem/b");
    expect(res.success, "前提：这次禁用本身要成功").toBe(true);

    expect(
      dbList(),
      "用户点一次开关，权威介质当次就要有值（不能留在「等 App 收编」的状态）",
    ).toContain("@codem/b");
    expect(mirrorList(), "镜像同步一致").toEqual(dbList());
    expect(rawSetting(STAMP_KEY), "时戳也要落").toBeDefined();
  });

  it("PLUGIN-MEDIUM-11: App 启动路径走对账（不是直接读 DB）", () => {
    const code = readCode("src/App.tsx");
    expect(code, "启动必须调对账函数").toContain("reconcileDisabledPluginsAtBoot");
    expect(
      /loadDisabledPlugins\s*\(/.test(code),
      "App 里不该再直接调 loadDisabledPlugins（那是「DB 一律为准」的旧契约，会在崩溃窗口里静默改回用户的开关）",
    ).toBe(false);
  });
});
