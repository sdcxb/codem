/**
 * HIST-1b / HIST-2b / HIST-4：thread history 对**工具结果与 spill** 的真实存储形态。
 *
 * ## 被守的缺陷（独立复核的高优先级缺口）
 *
 * 旧实现只扫 `message.content`、只渲染 `content`。而真实形态里：
 * - 旧命令 / 报错 / diff **在 `message.toolCalls[].result`**（请求侧在 `toolCalls[].args`），
 *   工具轮的 assistant 消息 `content` 常常是空的；
 * - 超大结果被 spill 成「预览 + locator」，全文在 `spill/` 目录里。
 *
 * 于是「上一段跑过什么、为什么失败」这类**编程场景最需要的历史**对模型等于不存在
 * （25 号文 §8.2「旧工具结果不可检索」）。这组判据钉住：
 *
 * | ID | 场景 | 通过 | 变异 |
 * | --- | --- | --- | --- |
 * | HIST-1b | 旧命令/错误只在 `toolCalls[].result`（content 为空） | search 命中并标 `tool_result`/工具名；read 取回原文与参数 | 删工具结果检索 ⇒ 红 |
 * | HIST-1b-args | 关键词只在参数里 | search 命中并标 `tool_args` | 同上 |
 * | HIST-2b | 结果走 spill | read 读回**全文**；伪造 locator 被拒（不读、也不假装读到了） | 直接读 locator 不做根目录校验 ⇒ 红 |
 * | HIST-4 | 请求 1 条 | 只返回 1 条（不把整段展开） | 段读无视 before/after ⇒ 红 |
 * | HIST-SEG | 按 segmentSeq 读/搜 | 只返回该段；段号越界如实报错 | 忽略 segment 过滤 ⇒ 红 |
 * | HIST-COUNT | 段清单 | 每段工具结果条数可见 | 恒 0 ⇒ 红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { createMessage } from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import {
  readThreadHistory,
  readThreadSegment,
  searchThreadHistory,
  segmentsOf,
} from "../core/context/thread-history";
import {
  createThreadHistoryReadTool,
  createThreadHistorySearchTool,
  createThreadSegmentListTool,
} from "../core/llm/tools/thread-history";

/**
 * spill 全文的读回走 `readFile`（Tauri IPC）。这里只替换两个函数：
 * - `getAppDataDir` → 固定的数据根（`resolveDataRoot` 的兜底来源）；
 * - `readFile` → 只认本判据登记过的 spill 路径（其它一律「读不到」，与没有文件层传输时同形）。
 *
 * 刻意**不**替换 `writeFile`：写盘在测试里本来就失败（没有 Tauri），
 * 而本组判据要验的是**读回**一条既有的 spill 提示，不是重跑写盘。
 */
const spillBodies = vi.hoisted(() => new Map<string, string>());
vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/file-api")>();
  return {
    ...actual,
    getAppDataDir: async () => "C:\\appdata\\",
    readFile: async (path: string) => {
      const body = spillBodies.get(path);
      if (body === undefined) throw new Error("E_FILE_NOT_FOUND");
      return body;
    },
  };
});

const SESSIONS = ["sess-hist-1b", "sess-hist-2b", "sess-hist-4", "sess-hist-seg"];

type M = {
  id: string;
  role?: "user" | "assistant" | "system";
  content?: unknown;
  timestamp?: number;
  metadata?: Record<string, unknown> | null;
  toolCalls?: unknown;
};

const readEpoch = (m: M) => {
  const epoch = (m.metadata as { contextEpoch?: unknown } | null | undefined)?.contextEpoch;
  if (!epoch || typeof epoch !== "object") return null;
  return epoch as {
    epochId: string;
    kind: "compact" | "switch";
    segmentSeq: number;
    cutoffMessageId: string;
    createdAt: number;
    removedCount: number;
    keptCount: number;
  };
};

function ctx(sessionId: string) {
  return {
    sessionId,
    messageId: "m",
    cwd: "C:\\repo",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

function marker(id: string, kind: "compact" | "switch", cutoff: string, seq: number, ts: number): M {
  return {
    id,
    role: "user",
    content: kind === "switch" ? "[已切换到新段] handoff" : "[上下文已自动压缩]",
    timestamp: ts,
    metadata: buildContextEpochMetadata({
      epochId: id,
      cutoffMessageId: cutoff,
      createdAt: 100 * seq,
      removedCount: 1,
      keptCount: 1,
      trigger: kind === "switch" ? "switch" : "auto",
      kind,
      segmentSeq: seq,
    }) ?? undefined,
  };
}

/** 旧的构建命令与报错：只存在于工具结果里（assistant 正文为空 —— 真实形态） */
const OLD_CMD = "pnpm build --filter core";
const OLD_ERR = "ENOENT: missing.config.json";
const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234";

function seedToolCallMessage(sessionId: string): void {
  createMessage(
    {
      id: "assistant-tool-turn",
      role: "assistant",
      /* 真实形态：工具轮的 assistant 正文是空的，事实全在工具调用里 */
      content: "",
      timestamp: 10,
      status: "done",
      toolCalls: [
        {
          id: "call-bash",
          tool: "bash",
          args: { command: OLD_CMD, cwd: "C:\\repo" },
          result: `Error: ${OLD_ERR}\n    at build.js:12:3\napi key ${SECRET}`,
          status: "error",
        },
        { id: "call-read", tool: "read", args: { path: "src/a.ts" }, result: "const a = 1;", status: "done" },
      ],
    } as never,
    sessionId,
  );
}

describe("HIST-1b：旧命令/错误只在 toolCalls[].result 里", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: SESSIONS.map((id) => ({
            id,
            project_id: "",
            title: "t",
            created_at: 0,
            last_message_at: 0,
            message_count: 0,
          })),
        },
      }),
    );
    spillBodies.clear();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("HIST-1b：search 命中工具结果并标出 matchField/工具名；read 取回结果原文与参数", async () => {
    const session = "sess-hist-1b";
    seedToolCallMessage(session);

    const search = createThreadHistorySearchTool();
    const hit = await search.execute({ query: "missing.config.json" }, ctx(session));
    expect(hit.isError, hit.output).toBe(false);
    expect(hit.output, "命中必须给出消息 id").toContain("assistant-tool-turn");
    expect(hit.output, "必须标出命中在工具结果里").toContain("tool_result:bash");
    expect(hit.value).toMatchObject({ count: 1, ids: ["assistant-tool-turn"], matchFields: ["tool_result"] });
    expect(hit.output, "片段必须含命中词").toContain("ENOENT");

    const read = await createThreadHistoryReadTool().execute(
      { id: "assistant-tool-turn", before: 0, after: 0 },
      ctx(session),
    );
    expect(read.isError, read.output).toBe(false);
    expect(read.output, "工具名必须可见").toContain("bash");
    expect(read.output, "参数摘要必须可见（否则模型不知道这是哪次调用）").toContain(OLD_CMD);
    expect(read.output, "结果正文必须取回").toContain(OLD_ERR);
    expect(read.value, "两个工具结果都要渲染").toMatchObject({ toolResultCount: 2 });
    expect(read.output, "抹密：工具结果里的密钥不许原样出现").not.toContain(SECRET);
    expect(read.output, "抹密后仍有占位符").toContain("[REDACTED_API_KEY]");
  });

  it("HIST-1b-args：关键词只在参数里也能命中（matchField=tool_args）", async () => {
    const session = "sess-hist-1b";
    seedToolCallMessage(session);

    const hit = await createThreadHistorySearchTool().execute({ query: "pnpm build" }, ctx(session));
    expect(hit.isError, hit.output).toBe(false);
    expect(hit.value).toMatchObject({ matchFields: ["tool_args"] });
    expect(hit.output).toContain("tool_args:bash");
  });

  it("HIST-1b-machine：机器注入正文放在 metadata 里时同样在检索范围（兜住别处的注入形态）", () => {
    const timeline: M[] = [
      { id: "m-built", content: "", timestamp: 1, metadata: { injectedText: "INJECTED-BODY：已切换到新段" } },
    ];
    const hits = searchThreadHistory(timeline as never, "INJECTED-BODY", 5, readEpoch);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: "m-built", matchField: "content" });
  });

  it("HIST-1b-epoch：按 epoch id 也能读回（生产里两者同值，这里钉住兜底查找）", () => {
    const timeline: M[] = [{ id: "msg-x", role: "user", content: "EPOCH-BODY", timestamp: 1 }];
    const readEpochStub = (m: M) => (m.id === "msg-x" ? { kind: "compact" as const, epochId: "epoch-77" } : null);
    const win = readThreadHistory(timeline as never, "epoch-77", 0, 0, readEpochStub as never);
    expect(win).not.toBeNull();
    expect(win!.messages.map((m) => m.id)).toEqual(["msg-x"]);
    expect(readThreadHistory(timeline as never, "epoch-nope", 0, 0, readEpochStub as never)).toBeNull();
  });

  it("HIST-1b-snippet：片段从**命中处**截取，不是正文开头", () => {
    const prefix = "开头无关内容。".repeat(40);
    const timeline: M[] = [
      {
        id: "m-deep",
        content: "",
        timestamp: 1,
        toolCalls: [
          { id: "c1", tool: "bash", args: { command: "run" }, result: `${prefix}DEEP_NEEDLE 出现在很后面` },
        ],
      },
    ];
    const hits = searchThreadHistory(timeline as never, "DEEP_NEEDLE", 5, readEpoch);
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet, "片段必须含命中处").toContain("DEEP_NEEDLE");
    expect(hits[0].snippet.startsWith("…"), "命中不在开头时片段以省略号开头").toBe(true);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(240);
  });
});

describe("HIST-2b：spill 全文可读、伪造 locator 被拒", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: SESSIONS.map((id) => ({
            id,
            project_id: "",
            title: "t",
            created_at: 0,
            last_message_at: 0,
            message_count: 0,
          })),
        },
      }),
    );
    spillBodies.clear();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("HIST-2b：结果走 spill ⇒ read 读回全文；locator 缺失/伪造都如实报错且不读越界文件", async () => {
    const session = "sess-hist-2b";
    const spillDir = "C:\\appdata\\spill\\sess-hist-2b";
    const realLocator = `${spillDir}\\bash-call-spill-1750000000000.txt`;
    const forgedLocator = "C:\\Windows\\win.ini.txt";
    const missingLocator = `${spillDir}\\bash-call-missing-1750000000001.txt`;
    spillBodies.set(realLocator, `BUILD FAILED\n${OLD_ERR}\nFULL_SPILL_TAIL_END`);
    spillBodies.set(forgedLocator, "TOP_SECRET_FORGED_CONTENT");

    const notice = (locator: string) => `前半段预览\n\n（已省略 900 字节；完整结果保存在：${locator}）`;
    createMessage(
      {
        id: "m-spill",
        role: "assistant",
        content: "",
        timestamp: 20,
        status: "done",
        toolCalls: [
          { id: "call-spill", tool: "bash", args: { command: OLD_CMD }, result: notice(realLocator), status: "done" },
        ],
      } as never,
      session,
    );
    createMessage(
      {
        id: "m-forged",
        role: "assistant",
        content: "",
        timestamp: 21,
        status: "done",
        toolCalls: [
          { id: "call-forged", tool: "bash", args: { command: "cat" }, result: notice(forgedLocator), status: "done" },
        ],
      } as never,
      session,
    );
    createMessage(
      {
        id: "m-missing",
        role: "assistant",
        content: "",
        timestamp: 22,
        status: "done",
        toolCalls: [
          { id: "call-missing", tool: "bash", args: { command: "cat" }, result: notice(missingLocator), status: "done" },
        ],
      } as never,
      session,
    );

    const read = createThreadHistoryReadTool();
    const real = await read.execute({ id: "m-spill", before: 0, after: 0 }, ctx(session));
    expect(real.isError, real.output).toBe(false);
    expect(real.output, "spill 全文必须读回（预览里没有的尾部）").toContain("FULL_SPILL_TAIL_END");
    expect(real.output).toContain(OLD_ERR);

    const forged = await read.execute({ id: "m-forged", before: 0, after: 0 }, ctx(session));
    expect(forged.isError, "消息本身读得到；spill 那一段的失败要如实写在正文里").toBe(false);
    expect(forged.output, "根目录校验必须拒绝越界 locator").toContain("拒绝读取非 spill 目录文件");
    expect(forged.output, "越界文件的内容一个字节都不许带出来").not.toContain("TOP_SECRET_FORGED_CONTENT");

    const missing = await read.execute({ id: "m-missing", before: 0, after: 0 }, ctx(session));
    expect(missing.isError).toBe(false);
    expect(missing.output, "文件缺失要如实报错（不假装没有内容）").toContain("E_FILE_NOT_FOUND");
    expect(missing.output, "仍要给出原来的提示，便于定位").toContain(missingLocator);
  });
});

describe("HIST-4：read 只返回请求范围，不把整段塞进来", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: SESSIONS.map((id) => ({
            id,
            project_id: "",
            title: "t",
            created_at: 0,
            last_message_at: 0,
            message_count: 0,
          })),
        },
      }),
    );
    spillBodies.clear();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  function seedFive(session: string) {
    const bodies = ["MSG-ONE", "MSG-TWO", "MSG-THREE", "MSG-FOUR", "MSG-FIVE"];
    bodies.forEach((body, i) => {
      createMessage({ id: `r4-m${i + 1}`, role: "user", content: body, timestamp: 100 + i, status: "done" }, session);
    });
  }

  it("HIST-4：before=0/after=0 只返回 1 条；邻域不自动扩大", async () => {
    const session = "sess-hist-4";
    seedFive(session);
    const read = createThreadHistoryReadTool();

    const one = await read.execute({ id: "r4-m3", before: 0, after: 0 }, ctx(session));
    expect(one.isError, one.output).toBe(false);
    expect(one.value, "请求 1 条只返回 1 条").toMatchObject({ messageIds: ["r4-m3"], toolResultCount: 0 });
    expect(one.output).toContain("MSG-THREE");
    expect(one.output, "不许把整段历史顺手带出来").not.toContain("MSG-TWO");
    expect(one.output).not.toContain("MSG-FOUR");

    const neighbors = await read.execute({ id: "r4-m3", before: 1, after: 1 }, ctx(session));
    expect(neighbors.value).toMatchObject({ messageIds: ["r4-m2", "r4-m3", "r4-m4"] });
  });
});

describe("段读取与段过滤（25 号文 §4.5 的 segment? 参数）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: SESSIONS.map((id) => ({
            id,
            project_id: "",
            title: "t",
            created_at: 0,
            last_message_at: 0,
            message_count: 0,
          })),
        },
      }),
    );
    spillBodies.clear();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  function seedTwoSegments(session: string) {
    createMessage({ id: "seg-m1", role: "user", content: "SEG-ONE-BODY 命中", timestamp: 1, status: "done" }, session);
    const sw = marker("compact-switch-2", "switch", "seg-m2", 2, 2);
    createMessage(
      { id: sw.id, role: "user", content: sw.content, timestamp: sw.timestamp, status: "done", metadata: sw.metadata },
      session,
    );
    createMessage({ id: "seg-m2", role: "assistant", content: "SEG-TWO-BODY 命中", timestamp: 3, status: "done" }, session);
    createMessage({ id: "seg-m3", role: "user", content: "SEG-TWO-TAIL", timestamp: 4, status: "done" }, session);
  }

  it("HIST-SEG：search 的 segment 过滤只命中该段；read segment 只返回该段", async () => {
    const session = "sess-hist-seg";
    seedTwoSegments(session);

    const search = createThreadHistorySearchTool();
    const all = await search.execute({ query: "命中" }, ctx(session));
    expect(all.value).toMatchObject({ ids: ["seg-m1", "seg-m2"] });

    const onlyFirst = await search.execute({ query: "命中", segment: 1 }, ctx(session));
    expect(onlyFirst.value, "segment=1 只许返回第 1 段").toMatchObject({ ids: ["seg-m1"] });
    expect(onlyFirst.output).toContain("segment 1");
    expect(onlyFirst.output).not.toContain("seg-m2");

    const onlySecond = await search.execute({ query: "命中", segment: 2 }, ctx(session));
    expect(onlySecond.value).toMatchObject({ ids: ["seg-m2"] });

    const noSuch = await search.execute({ query: "命中", segment: 9 }, ctx(session));
    expect(noSuch.isError).toBe(false);
    expect(noSuch.value).toMatchObject({ count: 0 });
    expect(noSuch.output).toContain("segment 9");

    const read = createThreadHistoryReadTool();
    const seg2 = await read.execute({ segment: 2 }, ctx(session));
    expect(seg2.isError, seg2.output).toBe(false);
    expect(seg2.value).toMatchObject({ segmentSeq: 2, messageIds: ["compact-switch-2", "seg-m2", "seg-m3"] });
    expect(seg2.output, "第 2 段原文必须都在").toContain("SEG-TWO-TAIL");
    expect(seg2.output, "不许把第 1 段混进来").not.toContain("SEG-ONE-BODY");
    expect(seg2.value, "段读的 id 用 segment:N 表示范围").toMatchObject({ id: "segment:2" });

    const seg1 = await read.execute({ segment: 1 }, ctx(session));
    expect(seg1.value).toMatchObject({ messageIds: ["seg-m1"] });
    expect(seg1.output).not.toContain("SEG-TWO-BODY");

    const outOfRange = await read.execute({ segment: 9 }, ctx(session));
    expect(outOfRange.isError, "段号越界要如实报错").toBe(true);
    expect(outOfRange.output).toMatch(/Segment 9 does not exist/);
  });

  it("HIST-SEG-ARGS：id 与 segment 二选一；非法 segment 报错", async () => {
    const session = "sess-hist-seg";
    seedTwoSegments(session);
    const read = createThreadHistoryReadTool();

    const neither = await read.execute({}, ctx(session));
    expect(neither.isError).toBe(true);
    expect(neither.output).toContain("id");
    expect(neither.output).toContain("segment");

    const both = await read.execute({ id: "seg-m1", segment: 1 }, ctx(session));
    expect(both.isError).toBe(true);

    const bad = await read.execute({ segment: 0 }, ctx(session));
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("≥1");
  });

  it("HIST-SEG-BOUND：段读超过上限时如实标 truncatedAfter（不假装整段读完）", () => {
    const timeline: M[] = [
      { id: "b1", content: "x", timestamp: 1 },
      { id: "b2", content: "y", timestamp: 2 },
      { id: "b3", content: "z", timestamp: 3 },
    ];
    const win = readThreadSegment(timeline as never, 1, 2, readEpoch);
    expect(win).not.toBeNull();
    expect(win!.messages.map((m) => m.id)).toEqual(["b1", "b2"]);
    expect(win!.truncatedAfter, "还有第 3 条没返回 ⇒ 必须置位").toBe(true);
    expect(readThreadSegment(timeline as never, 2, 10, readEpoch)).toBeNull();
  });
});

describe("HIST-COUNT：段清单显示每段工具结果条数", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(
      createFakeStoragePort({
        seed: {
          sessions: SESSIONS.map((id) => ({
            id,
            project_id: "",
            title: "t",
            created_at: 0,
            last_message_at: 0,
            message_count: 0,
          })),
        },
      }),
    );
    spillBodies.clear();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("HIST-COUNT：segmentsOf 统计有正文的工具结果；segment_list 输出该读数", async () => {
    const session = "sess-hist-seg";
    seedToolCallMessage(session);
    const sw = marker("compact-switch-2", "switch", "after-tools", 2, 20);
    createMessage(
      { id: sw.id, role: "user", content: sw.content, timestamp: sw.timestamp, status: "done", metadata: sw.metadata },
      session,
    );

    const segments = segmentsOf(
      [
        {
          id: "assistant-tool-turn",
          content: "",
          timestamp: 10,
          toolCalls: [
            { id: "a", tool: "bash", args: {}, result: "out-1" },
            { id: "b", tool: "read", args: {}, result: "out-2" },
            { id: "c", tool: "grep", args: {}, result: "" },
          ],
        },
        { id: "compact-switch-2", content: "x", timestamp: 20, metadata: sw.metadata ?? undefined },
      ] as never,
      readEpoch,
    );
    expect(segments.map((s) => s.toolResultCount)).toEqual([2, 0]);

    const list = await createThreadSegmentListTool().execute({}, ctx(session));
    expect(list.isError, list.output).toBe(false);
    expect(list.output, "每段工具结果条数可见").toContain("工具结果 2 条");
    expect(list.value).toMatchObject({ segmentCount: 2, segments: [1, 2], toolResults: [2, 0] });
  });
});
