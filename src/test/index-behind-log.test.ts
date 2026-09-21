/**
 * 「索引落后于权威日志」必须被**主动发现并修回**（第 52 轮）
 *
 * ## 守的缺陷
 *
 * 架构约定是"JSONL 是权威副本、SQLite 索引可重建"，但**修复的触发器**此前只有两个：
 * 完整性检查失败、引擎恢复时写的标记。于是有个静默缺口：
 * **索引真的少了行、但库没坏、也没人写标记** → 什么都不会发生。
 *
 * 真机实证（第 52 轮钻取）：某会话的权威日志有 **657** 个唯一 id，索引里只有 **545** 行 ——
 * 差 **112 行**，没有任何信号。跑一次"从日志重建"后索引变成 657（与日志逐条一致），
 * 说明这 112 行确实是**索引丢了**，不是日志多了。
 *
 * ## 为什么"索引行数 < 日志 id 数"只能是丢行
 *
 * - 裁剪（`trimIndexedMessages`）是**软删除 + 裁剪标记**，行**留在库里**
 *   （否则 `message_feedback` 的外键目标消失），所以 `messages.count.total` 不会因此变小；
 * - 正常方向的落后是"索引**多**、日志少"（老会话日志还没回填），那个方向**不该告警**；
 * - 反向只可能来自"索引写入丢了 / 被外力删了"。
 *
 * ## 判据
 *
 * | 情形 | 期望 |
 * | --- | --- |
 * | 日志 3 条、索引 1 行（日志已 hydrate） | 检测到 → 逐会话重建 → 上报（含具体数字） |
 * | 日志 0 条 | 不告警（新会话的正常形态） |
 * | 日志**没 hydrate** | **不告警**（"不知道"不许当成"日志是空的"，否则会漏掉真正的落后） |
 * | 索引比日志多（老会话日志未回填） | 不告警（正常方向） |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const SESSION = "sess-behind";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();
/** 重建调用记录（判据：检测到落后之后**真的**调了逐会话重建） */
const rebuildCalls: string[] = [];

const jsonlLine = (id: string, content: string, ts: number) =>
  JSON.stringify({ v: 1, id, sessionId: SESSION, role: "user", content, timestamp: ts });

function installFakeFs(seed: string | null) {
  files.clear();
  if (seed !== null) files.set(`${APP_DIR}sessions/${SESSION}.jsonl`, seed);
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          const p = String(args?.path);
          if (!files.has(p)) throw new Error(`not found: ${p}`);
          return files.get(p);
        }
        if (cmd === "path_exists") return files.has(String(args?.path));
        if (cmd === "write_file") {
          files.set(String(args?.path), String(args?.content ?? ""));
          return null;
        }
        if (cmd === "delete_file") {
          files.delete(String(args?.path));
          return null;
        }
        if (cmd === "list_directory") {
          /*
           * ⚠️ 这一条是 BEHIND-1 第一版失败的原因：检测器先从 `listSessionLogs()`
           * 拿会话清单，而那个函数走 `list_directory`。假 fs 返回空数组 →
           * **一个会话都不会被检查** → 检测"没触发"，用例红。
           * 假端口/假 fs 比实现宽松会把缺陷藏住；这里正好相反（比实现严格），
           * 所以它红得对：提醒我把"日志目录"这个前提也造出来。
           */
          const p = String(args?.path);
          const prefix = p.endsWith("/") || p.endsWith("\\") ? p : `${p}/`;
          return [...files.keys()]
            .filter((f) => f.startsWith(prefix))
            .map((f) => ({ name: f.slice(prefix.length), path: f, isDirectory: false }));
        }
        return null;
      },
    },
  };
}

let port: FakeStoragePort;

/** 假端口：`messages.count` 报一个**比日志少**的行数；记录 rebuild 调用 */
async function installPort(opts: { indexRows: number }) {
  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION, project_id: "p1", title: "落后会话", created_at: 1, last_message_at: 2, message_count: 0 },
      ],
      messages: [],
    },
  });
  const data = port.data as unknown as {
    command?: (cmd: string, params?: Record<string, unknown>) => Promise<unknown>;
    execute?: (cmd: string, params?: Record<string, unknown>) => Promise<unknown>;
  };
  data.command = async (cmd: string, params?: Record<string, unknown>) => {
    if (cmd === "messages.count") return { count: opts.indexRows, hidden: 0, total: opts.indexRows, visible: opts.indexRows };
    if (cmd === "messages.rebuild_index") {
      rebuildCalls.push(String((params as { sessions?: Array<{ id?: string }> })?.sessions?.[0]?.id ?? "?"));
      return { index_message_count: 3, messages: 3, sessions: 1, tool_calls: 0 };
    }
    if (cmd === "integrity_check") return { ok: true, detail: "ok" };
    if (cmd === "crud.list") return { items: [], has_more: false };
    return {};
  };
  data.execute = async (cmd: string, params?: Record<string, unknown>) => {
    if (cmd === "messages.rebuild_index") {
      rebuildCalls.push(String((params as { sessions?: Array<{ id?: string }> })?.sessions?.[0]?.id ?? "?"));
    }
    return { written: 1 };
  };
  await port.config.warmup();
  setStoragePort(port);
  return port;
}

beforeEach(async () => {
  resetPersistFailures();
  rebuildCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache?.();
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("BEHIND：索引落后于权威日志必须被发现并修回", () => {
  it("BEHIND-1: 日志 3 条 + 索引 1 行（日志已 hydrate）→ 检测到、逐会话重建、如实上报", async () => {
    installFakeFs([jsonlLine("m1", "一", 1), jsonlLine("m2", "二", 2), jsonlLine("m3", "三", 3)].join("\n"));
    await installPort({ indexRows: 1 });

    const msgMod = await import("../core/storage/message");
    await msgMod.hydrateSessionLog(SESSION);
    expect(msgMod.sessionLogReadState(SESSION), "前置：日志已读过").toBe("hydrated");
    expect(msgMod.logLiveMessageCount(SESSION), "前置：日志里有 3 条").toBe(3);

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    const result = await runDatabaseMaintenance();

    expect(
      getPersistFailures().map((f) => f.area),
      "发现了静默丢行必须上报（这是'系统自己发现过一次'的唯一信号）",
    ).toContain("maintenance.indexBehindLog");
    const entry = getPersistFailures().find((f) => f.area === "maintenance.indexBehindLog")!;
    expect(entry.lastMessage, "上报里要写清数字，便于排查").toMatch(/索引 1 < 日志 3/);
    expect(rebuildCalls, "必须真的按会话重建过").toContain(SESSION);
    expect(typeof result.repairedBehindMessages, "汇总里要有这一项").toBe("number");
  });

  it("BEHIND-2: 日志为空 → 不告警（新会话的正常形态）", async () => {
    installFakeFs(null); // 目录里没有这个会话的日志
    await installPort({ indexRows: 0 });

    const msgMod = await import("../core/storage/message");
    await msgMod.hydrateSessionLog(SESSION); // 读到 0 条 = 定论
    expect(msgMod.logLiveMessageCount(SESSION)).toBe(0);

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    await runDatabaseMaintenance();

    expect(getPersistFailures().map((f) => f.area)).not.toContain("maintenance.indexBehindLog");
  });

  it("BEHIND-3: 日志**没 hydrate** → 检测器要**自己读**它，不许瞎掉", async () => {
    installFakeFs([jsonlLine("m1", "一", 1), jsonlLine("m2", "二", 2), jsonlLine("m3", "三", 3)].join("\n"));
    await installPort({ indexRows: 1 });
    // 故意不 hydrate —— 这正是"索引丢了 112 行"那种形态在启动早期的样子

    const msgMod = await import("../core/storage/message");
    msgMod.clearSessionLogCache();
    expect(msgMod.sessionLogReadState(SESSION), "前置：确实还没读过").toBe("pending");

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    await runDatabaseMaintenance();

    /**
     * ⚠️ 这条断言在第 52 轮**被我自己推翻过一次**，值得留档：
     *
     * 第一版检测器的判据是"只比已 hydrate 的会话"，对应这条用例原本的断言
     * "没 hydrate → 不告警"。看着保守，实际是**最该发现问题的形态上瞎掉**：
     * 索引为空的会话在回填里走 `if (messages.length === 0) continue` ——
     * 回填跳过它、也就不会 hydrate 它，于是永远比不到、永远不告警。
     * （真机夹具"日志 3 条 / 索引 0 行"当初就是因此检测不到。）
     *
     * 现在检测器会主动 `ensureSessionLogHydrated`（幂等去重），所以这条用例守的是
     * **相反**的性质：没读过也要能发现。
     */
    expect(
      getPersistFailures().map((f) => f.area),
      "索引落后不能因为'日志还没读'就被漏掉 —— 检测器要自己去读",
    ).toContain("maintenance.indexBehindLog");
  });

  it("BEHIND-3b: 日志**读失败** → 不告警（拿不到可信集合时不许瞎猜）", async () => {
    installFakeFs([jsonlLine("m1", "一", 1)].join("\n"));
    // 让**分窗读取**抛一个"不是文件不存在"的错误 → 日志状态变 failed
    // （⚠️ 第 68 轮：读日志已不走整读 `read_file`；注入到那边这条用例就测不到东西了）
    const origInvoke = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_text_window" && String(args?.path).includes(SESSION)) throw new Error("IPC 读文件失败");
      return origInvoke(cmd, args);
    };
    await installPort({ indexRows: 0 });

    const msgMod = await import("../core/storage/message");
    msgMod.clearSessionLogCache();
    msgMod.__resetSessionLogReadFailuresForTests();

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    await runDatabaseMaintenance();

    expect(
      msgMod.sessionLogReadState(SESSION),
      "读失败必须是**定论**（failed），不是永远 pending",
    ).toBe("failed");
    expect(
      getPersistFailures().map((f) => f.area),
      "读不到日志就不该猜'索引落后'（那会把读失败伪造成数据结论）",
    ).not.toContain("maintenance.indexBehindLog");
  });

  it("BEHIND-4: 索引比日志**多**（老会话日志未回填）→ 不告警（正常方向）", async () => {
    installFakeFs(jsonlLine("m1", "一", 1));
    await installPort({ indexRows: 500 });

    const msgMod = await import("../core/storage/message");
    await msgMod.hydrateSessionLog(SESSION); // 日志只有 1 条

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    await runDatabaseMaintenance();

    expect(
      getPersistFailures().map((f) => f.area),
      "索引比日志多是正常的（日志还没回填）—— 告警会造成持续误报",
    ).not.toContain("maintenance.indexBehindLog");
  });

  /**
   * BEHIND-5：横幅**开头那句必须是真的**（第 52 轮真机抓到）。
   *
   * 真机上这条告警当时印的是：
   *   「**操作没有生效**（maintenance.indexBehindLog）：索引落后于权威日志：…」
   * 而它其实是一件**已经修好**的事（"已逐会话重建，补回 3 行"）。
   * 通道当时只有两种前缀（"数据保存失败" / "操作没有生效"），**两者都不成立** ——
   * 所以第 52 轮给通道加了 `title` 覆盖：开头假 = 整条不可信。
   */
  it("BEHIND-5: 这条告警的文案不许说「操作没有生效」（它是自检发现并已修好）", async () => {
    installFakeFs([jsonlLine("m1", "一", 1), jsonlLine("m2", "二", 2), jsonlLine("m3", "三", 3)].join("\n"));
    await installPort({ indexRows: 1 });
    const msgMod = await import("../core/storage/message");
    await msgMod.ensureSessionLogHydrated(SESSION);
    await new Promise((r) => setTimeout(r, 20));

    const { runDatabaseMaintenance } = await import("../core/storage/maintenance");
    const { composePersistAlertText } = await import("../core/storage/persist-failure");
    const events: Array<Record<string, unknown>> = [];
    const on = (e: Event) => events.push((e as CustomEvent).detail as Record<string, unknown>);
    window.addEventListener("codem:persist-failed", on);
    try {
      await runDatabaseMaintenance();
    } finally {
      window.removeEventListener("codem:persist-failed", on);
    }

    const evt = events.find((e) => e.area === "maintenance.indexBehindLog");
    expect(evt, "必须上报到界面通道").toBeTruthy();
    const text = composePersistAlertText(evt as never);
    expect(
      text,
      "开头那句必须是真的：这不是用户的操作没生效，而是自检发现并修好了不一致",
    ).not.toContain("操作没有生效");
    expect(text, "也不该说成'数据保存失败'（什么都没丢）").not.toContain("数据保存失败");
    expect(text).toContain("存储自检");
    expect(text, "句子不许重复同一件事（横幅自己说两遍也是文案缺陷）").not.toMatch(
      /索引落后于权威日志.*索引落后于权威日志/,
    );
    expect(text, "结尾不该出现两个句号（真机上印过 '。。'）").not.toContain("。。");
  });
});
