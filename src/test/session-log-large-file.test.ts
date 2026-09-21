/**
 * SLF —— **超大会话日志**（> 50 MB）必须照样读得出来、压得下去（第 68 轮）。
 *
 * ## 真机取证（用户机器上的控制台）
 *
 * ```text
 * [SessionJSONL] 读取日志失败（回退到索引）: File is large (600416315 bytes)…
 * [SessionLog] 会话 1789542485753-zkal9zq3t 回填失败（跳过）: File is large (600486644 bytes)…
 * [Maintenance] 维护完成：… 日志压缩 0 个会话 …
 * ```
 *
 * 三个现象同一条根因：会话的**权威副本**是 `sessions/<id>.jsonl` 追加日志，它会随对话增长
 * （真机 600 MB），而读日志的三条路径都走整读 `read_file` —— 那个命令有一条 **50 MB 护栏**
 * （护栏本身是对的：600 MB 一次性进 JS 堆不该做）。于是超过 50 MB 之后：
 * hydrate 读不到、回填跳过、**而 `compactSessionLog` 的裸 catch 直接 return"没压"**。
 *
 * 最后一条是**自锁**：压缩是唯一能让日志变小、从而重新可读的机制，
 * 它却因为"读不出来"而永远不执行 ⇒ 维护每次都打印"日志压缩 0 个会话"，
 * 看起来像"没有需要压缩的"，实际是"根本读不出来"。
 *
 * ## 这些用例怎么做到"可证伪"
 *
 * SLF-1 用的是**同一个桩**上的对照：同一份 > 50 MB 的日志，
 *  - 老路径（整读 `readFileWithCap`）**当场抛** `E_FILE_TOO_LARGE:`（这就是真机那个错）；
 *  - 新路径（分窗 `readSessionMessages`）读得出来。
 * 也就是说：把产品代码改回整读，这些用例会红，而不是"照样绿"。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resetPersistFailures, getPersistFailures } from "../core/storage/persist-failure";
import { textWindowSlice, readFileWithCap, READ_FILE_FULL_MAX_BYTES } from "./helpers/tauri-fs-stub";

const SESSION = "sess-huge-log";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();
const invokeCalls: string[] = [];

/** 记录每次 IPC 命令：用来证明"真的分了很多窗"，而不是偷偷整读了一次 */
function installFakeFs(): string {
  files.clear();
  invokeCalls.length = 0;
  const logPath = `${APP_DIR}sessions/${SESSION}.jsonl`;
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        invokeCalls.push(cmd);
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") return readFileWithCap(files, args);
        if (cmd === "append_file") {
          // ⚠️ 真 Rust 侧 `append_file` 会补一个换行（JSONL 需要的行分隔）——
          // 桩必须一样，否则"追加有没有落盘"这件事测不出来（第一版漏了这个命令：
          // 追加静默变成 no-op，SLF-6 于是报出"那条追加不见了"的假失败）。
          const p = String(args?.path);
          files.set(p, (files.get(p) ?? "") + String(args?.content ?? "") + "\n");
          return null;
        }
        if (cmd === "write_file") {
          files.set(String(args?.path), String(args?.content ?? ""));
          return null;
        }
        if (cmd === "rename_file") {
          const c = files.get(String(args?.oldPath));
          files.delete(String(args?.oldPath));
          if (c !== undefined) files.set(String(args?.newPath), c);
          return null;
        }
        if (cmd === "list_directory") {
          const dir = String(args?.path ?? "");
          const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          for (const key of files.keys()) {
            if (!key.startsWith(dir)) continue;
            const rest = key.slice(dir.length);
            if (rest.includes("/")) continue;
            out.push({ name: rest, path: key, isDirectory: false });
          }
          return out;
        }
        if (cmd === "path_exists") return files.has(String(args?.path));
        return null;
      },
    },
  };
  return logPath;
}

const line = (id: string, content: string, ts: number) =>
  JSON.stringify({ id, role: "user", content, timestamp: ts });

/** 每条"热"消息的版本数：3 条消息 × 70 版 = 210 行，体积 ≈ 52 MB */
const HOT_VERSIONS = 70;
/** 一行的内容体量（≈250 KB）：贴近真实（一条带思考与工具调用的消息） */
const HOT_LINE_BYTES = 250 * 1024;

const hotLine = (id: string, version: number, ts: number) =>
  line(id, `${id}-v${version}-` + "x".repeat(HOT_LINE_BYTES), ts);

/**
 * 造一份**贴近真实膨胀形态**的日志：**少数几条消息被反复更新**（每次更新追加一整行）。
 * 这正是权威日志变大的真实原因，也让"压缩"有可观的效果（52 MB → 不到 1 MB）。
 *
 * 同时把两件最容易在分窗实现里出错的事摆到窗口边界上：
 *  - `h1` 的**第 1 版在第 1 个窗口、最后一版在第 7 个窗口** ⇒ 后写者胜必须跨窗口成立；
 *  - `m2` 与它的墓碑都靠后，墓碑必须真的压住消息。
 *
 * 行数 213（≥ 200 的压缩阈值）、体积 > 50 MB（整读护栏）。
 */
function seedHugeLog(logPath: string): {
  size: number;
  linesBefore: number;
  /** 压缩后应当剩几行：**每个 id 的最后一行**，墓碑也算一行（丢了墓碑会让消息复活） */
  linesAfter: number;
  /** 读出来应当是几条消息：墓碑不算消息 */
  messageCount: number;
} {
  const parts: string[] = [];
  for (let v = 1; v <= HOT_VERSIONS; v++) {
    for (const id of ["h1", "h2", "h3"]) parts.push(hotLine(id, v, v));
  }
  parts.push(line("m2", "会被墓碑删掉", 900));
  parts.push(JSON.stringify({ id: "m2", role: "user", content: "", timestamp: 901, deleted: true }));
  parts.push(line("m3", "最后一条", 902));
  const body = parts.join("\n") + "\n";
  files.set(logPath, body);
  return {
    size: body.length,
    linesBefore: parts.length,
    linesAfter: 5, // h1 / h2 / h3 / m2(墓碑) / m3
    messageCount: 4, // h1 / h2 / h3 / m3
  };
}

beforeEach(() => {
  resetPersistFailures();
  installFakeFs();
});

describe("SLF —— 超大会话日志（> 50 MB）", () => {
  it("SLF-1: 同一份 >50 MB 的日志：老路径（整读）抛错，新路径（分窗）读得出来", async () => {
    const logPath = installFakeFs();
    const { size, messageCount } = seedHugeLog(logPath);
    expect(size, "样本必须真的超过整读护栏，否则测的不是这件事").toBeGreaterThan(READ_FILE_FULL_MAX_BYTES);

    // ① 对照：整读路径在同一份文件上**必然失败**（真机控制台里那个 File is large 就是它）
    expect(
      () => readFileWithCap(files, { path: logPath }),
      "整读 >50 MB 必须抛 E_FILE_TOO_LARGE —— 这是老实现的形态，也是这条用例的对照面",
    ).toThrow(/E_FILE_TOO_LARGE/);

    // ② 新路径：分窗读得出来，且语义与整读一致
    const { readSessionMessages } = await import("../core/storage/session-jsonl");
    const { messages, skippedLines } = await readSessionMessages(SESSION);

    const byId = new Map(messages.map((m) => [m.id, m]));
    expect(skippedLines, "坏行数必须是 0（我们不能把读取失败说成坏行）").toBe(0);
    expect(
      byId.get("h1")?.content.startsWith(`h1-v${HOT_VERSIONS}-`),
      "同一条消息被更新过 → 必须取**最后**一版（第 1 版在第 1 个窗口、最后一版在第 7 个窗口，" +
        "这里专治『后写者胜只在单窗口内成立』）",
    ).toBe(true);
    expect(byId.has("m2"), "墓碑必须生效（哪怕它与被删的消息隔着窗口边界）").toBe(false);
    expect(byId.get("m3")?.content).toBe("最后一条");
    expect(messages.length, `读出来应当是 ${messageCount} 条消息（墓碑不算消息）`).toBe(messageCount);

    // ③ 证据：确实是一窗一窗读的（>50 MB / 8 MB 上限 ⇒ 至少 7 次）
    const windowCalls = invokeCalls.filter((c) => c === "read_text_window").length;
    expect(windowCalls, `分窗次数 ${windowCalls} 太少，像是在整读`).toBeGreaterThanOrEqual(7);
    expect(invokeCalls.includes("read_file"), "读日志**不该**再走整读 read_file（那会撞 50 MB 护栏）").toBe(false);
  });

  it("SLF-2: 同一份 >50 MB 的日志**真的能压缩**（这是唯一能给它瘦身的机制）", async () => {
    const logPath = installFakeFs();
    const { size, linesBefore, linesAfter, messageCount } = seedHugeLog(logPath);

    const { compactSessionLog, flushSessionLogWrites, __resetJsonlCache } = await import(
      "../core/storage/session-jsonl"
    );
    __resetJsonlCache?.();
    await flushSessionLogWrites();

    const result = await compactSessionLog(SESSION);
    expect(result.compacted, ">50 MB 的日志必须能压（真机症状：永远报『日志压缩 0 个会话』）").toBe(true);
    expect(result.linesBefore, `压缩前的行数应当是 ${linesBefore}`).toBe(linesBefore);
    expect(
      result.linesAfter,
      "压缩后只剩每个 id 的最后一行；**墓碑也是一行**（丢了墓碑会让被删的消息复活）",
    ).toBe(linesAfter);
    const after = files.get(logPath)!;
    expect(after.length, `压缩后必须真的变小（${size} → ${after.length}）`).toBeLessThan(size);
    expect(
      after.length,
      "压缩后应当只剩每个 id 的最后一行（≈ 3 条 250 KB + 几条小行），而不是 52 MB",
    ).toBeLessThan(2 * 1024 * 1024);

    // 压缩后仍然读得出同样的内容（语义不变）
    const { readSessionMessages } = await import("../core/storage/session-jsonl");
    const { messages } = await readSessionMessages(SESSION);
    expect(messages.length).toBe(messageCount);
    expect(
      messages.find((m) => m.id === "h1")?.content.startsWith(`h1-v${HOT_VERSIONS}-`),
      "压缩只删『被取代的旧行』，绝不能把最新版压掉",
    ).toBe(true);
    expect(messages.some((m) => m.id === "m2"), "墓碑在压缩后仍然要压住 m2").toBe(false);
  });

  it("SLF-3: 读不出来时**如实上报**，不再静默返回『没压』", async () => {
    const logPath = installFakeFs();
    seedHugeLog(logPath);
    // 让分窗读取整体失败（模拟 IPC 断了/权限问题）
    (window as any).__TAURI__.core.invoke = async (cmd: string) => {
      if (cmd === "get_app_data_dir") return APP_DIR;
      if (cmd === "read_text_window") throw new Error("IPC 读文件失败");
      return null;
    };

    const { compactSessionLog } = await import("../core/storage/session-jsonl");
    const result = await compactSessionLog(SESSION);
    expect(result.compacted).toBe(false);
    const failures = getPersistFailures();
    expect(
      failures.map((f) => f.area),
      "读不出来**不是**『没什么可压』：必须留下一条上报（老实现是裸 catch → 静默）",
    ).toContain("sessionLog.compact");
    expect(failures.find((f) => f.area === "sessionLog.compact")?.lastMessage).toMatch(/读文件失败/);
  });

  it("SLF-4: 文件不存在时不算失败（新会话还没日志是正常形态）", async () => {
    installFakeFs();
    const { compactSessionLog, readSessionMessages } = await import("../core/storage/session-jsonl");
    const r = await compactSessionLog(SESSION);
    expect(r.compacted).toBe(false);
    expect(getPersistFailures(), "『还没有日志』不该上报成故障").toEqual([]);
    const { messages } = await readSessionMessages(SESSION);
    expect(messages).toEqual([]);
  });

  /**
   * SLF-5 / SLF-6 —— 压缩的"推迟"判据必须**按会话**。
   *
   * 真机取证（本机 1.16.117 冷启动，8 份会话日志）：每一份都在推迟、
   * 维护汇总永远是 `日志压缩 0 个会话` ⇒ 压缩事实上从未执行过，
   * 而它是权威日志**唯一**的体积控制手段（"会话日志能长到 600 MB"的上游原因）。
   *
   * 两个方向都要钉住：
   *  - **别的会话**有追加在途 → 压缩必须照常执行（否则等于永远不压）；
   *  - **本会话**有追加在途 → 必须推迟（否则 rename 会覆盖掉那条追加 = 丢消息）。
   */
  const OTHER_SESSION = "sess-other";

  it("SLF-5: **别的会话**有追加在途时，本会话照样压（判据只认本会话）", async () => {
    const logPath = installFakeFs();
    seedHugeLog(logPath);
    const { compactSessionLog, flushSessionLogWrites, appendSessionMessage } = await import(
      "../core/storage/session-jsonl"
    );
    await flushSessionLogWrites();

    /**
     * ⚠️ 这条用例必须让"别的会话的追加"**一直悬停在途**，否则测不出东西：
     * 第一版只是"读窗口期间起一次别的会话的追加"，而它很快就写完了 ——
     * 等到压缩做那个判定时，在途表已经空了，于是"全局口径"和"按会话口径"表现一样
     * （突变验证当场证明：把判据退回全局，用例照样绿）。
     * 现在用一个**闸门**把它卡住：写入必须等到我放行才开始。
     */
    let openGate: (() => void) | null = null;
    const gate = new Promise<void>((r) => { openGate = r; });
    let late: Promise<void> | null = null;
    const otherPath = `${APP_DIR}sessions/${OTHER_SESSION}.jsonl`;
    files.set(otherPath, JSON.stringify({ id: "o1", role: "user", content: "别的会话", timestamp: 1 }) + "\n");

    const realInvoke = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_text_window" && !late) {
        // 读窗口期间起一次**别的会话**的追加（模拟自动保存），它会卡在闸门上
        late = appendSessionMessage(OTHER_SESSION, {
          id: "o2",
          role: "user",
          content: "在途写入",
          timestamp: 2,
        } as never);
      }
      if (cmd === "append_file" && String(args?.path).includes(OTHER_SESSION)) {
        await gate; // 悬停：这条追加在压缩做判定时**仍在途**
      }
      return realInvoke(cmd, args);
    };

    try {
      const result = await compactSessionLog(SESSION);
      expect(late, "前提：读窗口期间确实起了一次别的会话的追加").toBeTruthy();
      expect(
        result.compacted,
        "别的会话有写在途**不该**挡住本会话压缩 —— 真机上这一条让压缩从未执行过",
      ).toBe(true);
    } finally {
      // 收尾：放行那条悬停的写入，别把测试挂住
      openGate?.();
      (window as any).__TAURI__.core.invoke = realInvoke;
    }
    await late!;
  });

  it("SLF-6: **本会话**有追加在途时必须推迟，且那条追加一个字都不能丢", async () => {
    const logPath = installFakeFs();
    seedHugeLog(logPath);
    const { compactSessionLog, flushSessionLogWrites, readSessionMessages, appendSessionMessage } = await import(
      "../core/storage/session-jsonl"
    );
    await flushSessionLogWrites();

    let late: Promise<void> | null = null;
    const realInvoke = (window as any).__TAURI__.core.invoke;
    (window as any).__TAURI__.core.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "read_text_window" && !late) {
        // 本会话的追加**在读窗口期间**到达 —— 这正是 rename 会覆盖掉它的那个窗口
        late = appendSessionMessage(SESSION, {
          id: "late-arrival",
          role: "user",
          content: "读窗口期间到达的一条",
          timestamp: 500,
        } as never);
      }
      return realInvoke(cmd, args);
    };

    const result = await compactSessionLog(SESSION);
    expect(late, "前提：读窗口期间确实发生了一次本会话的追加").toBeTruthy();
    expect(result.compacted, "本会话有写在途 ⇒ 必须推迟（宁可不压，也不丢消息）").toBe(false);

    // 关键断言：那条"迟到"的追加必须还在（推迟就是为了保护它）
    (window as any).__TAURI__.core.invoke = realInvoke;
    await late!;
    await flushSessionLogWrites();
    const after = files.get(logPath)!;
    expect(after, "推迟之后文件必须保持原样（没被 rename 覆盖）").toContain("late-arrival");
    const { messages } = await readSessionMessages(SESSION);
    expect(messages.some((m) => m.id === "late-arrival"), "那条追加必须是可读的").toBe(true);
  });
});
