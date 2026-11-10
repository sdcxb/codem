/**
 * P1-1 / 25 P0-3：**Thread Notes（会话级笔记）**判据。
 *
 * ## 守什么（每条都能变红）
 *
 * | id | 场景 | 通过条件 | 变异（改坏即红） |
 * |---|---|---|---|
 * | NOTE-1a | 80% 水位 | 同一水位段只提醒一次；回落到线下后可再次提醒 | 去掉 `reminded` 状态 ⇒ 每次调用都返回文案 |
 * | NOTE-1b | `notes_append` 后换段 | switch handoff 含笔记摘要（untrusted 标注） | 去掉 `buildThreadNotesDigest` 传参 ⇒ handoff 里没有笔记 |
 * | NOTE-1c | `notes_append` 后压缩 | 压缩 marker 尾部含笔记摘要；无笔记时与旧版一致 | 去掉 `notesDigest` 入参 ⇒ marker 里没有笔记 |
 * | NOTE-2a | 跨回合 / 重启 | 落盘后清空进程内缓存（模拟新实例）仍可读回 | 读侧永远返回内存空表 ⇒ 重启后读不到 |
 * | NOTE-2b | 坏 JSON / 版本不符 | 空笔记 + warn，不部分恢复 | 坏数据也 `JSON.parse` 后强转 ⇒ 抛错或幽灵条目 |
 * | NOTE-3a | 条数上限 | 裁最旧、保留最新（200 条） | 裁最新 / 不裁 ⇒ 最新一条丢失或超出上限 |
 * | NOTE-3b | 字节上限 | 裁最旧、保留最新（64KB） | 只按条数裁 ⇒ 总字节超限 |
 * | NOTE-3c | 会话隔离 | A 读不到 B 的笔记（含按 id 读） | 去掉信封 sessionId 校验 / 共用键 ⇒ 串会话 |
 * | NOTE-4 | 稳定前缀 | notes 只出现在 handoff marker / 尾部提醒，不进 `buildSystemPrompt` | 把提醒拼进 `extraSystemPrompt` / prompt.ts ⇒ 源码判据红 |
 * | NOTE-TOOL | 工具契约 | append 写（readOnly=false/session）、read/list 只读；全部 defer + outputSchema | 把 append 标只读 ⇒ 契约不变量红 |
 * | NOTE-5a | 编辑落库 | `updateThreadNote` 改正文/标签、`updatedAt` 单调、`rev`+1；清缓存（模拟重启）后仍读到新值 | 编辑只改内存不落库 / 不更新 updatedAt ⇒ 本行红 |
 * | NOTE-5b | 编辑上限 | 超长正文按 4,000 字符截断并标记；标签截断到 40；编辑后总字节超 64KB ⇒ **整次失败**、别条笔记不动 | 超上限也硬写 ⇒ 总字节/条数判据红；编辑失败却改了内存 ⇒ 本行红 |
 * | NOTE-5c | 编辑失败可见 | 空正文 / 未给字段 / 不存在的 id / 别的会话的 id / 坏数据 ⇒ `ok:false` 且带原因（不抛） | 静默成功 / 抛错 ⇒ 本行红 |
 * | NOTE-6 | 删除 | 删除后不可读（含清缓存后）；只删指定 id；不存在/跨会话 ⇒ 可见失败 | 删除只改内存不落库 / 按摘要模糊删 ⇒ 本行红 |
 * | NOTE-5d/NOTE-6b | 坏数据回退 | 坏 JSON 下编辑/删除返回 `not_found` + `corrupt:true`，不抛、不覆盖原值 | 坏数据下抛错或返回成功 ⇒ 本行红 |
 * | NOTE-TOOL-2 | 新增工具契约 | update/delete 均 `readOnly:false`、defer、outputSchema；delete `destructive`；输出脱敏 | 标成只读 / 不 defer / 输出不脱敏 ⇒ 本行红 |
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { setSetting } from "../core/storage/settings";
import { createMessage, listTimelineMessages } from "../core/storage/message";
import {
  appendThreadNote,
  buildThreadNotesDigest,
  deleteThreadNote,
  flushThreadNotes,
  forgetThreadNotes,
  listThreadNotes,
  maybeBuildWaterNotesReminder,
  readThreadNote,
  threadNotesStorageKey,
  updateThreadNote,
  THREAD_NOTES_MAX_COUNT,
  THREAD_NOTES_MAX_NOTE_CHARS,
  THREAD_NOTES_MAX_TOTAL_BYTES,
  __resetThreadNotesCache,
} from "../core/context/thread-notes";
import { buildSwitchHandoff } from "../core/context/segment-switch";
import { performSegmentSwitch } from "../core/storage/context-switch";
import { composeCompactionMarkerText } from "../core/llm/compaction-budget";
import { createNotesTools } from "../core/llm/tools/notes-tools";
import { createDefaultToolRegistry } from "../core/llm/tools";
import type { ToolContext } from "../core/llm/tools";

const ROOT = join(__dirname, "..", "..");
const SESSION_A = "sess-notes-a";
const SESSION_B = "sess-notes-b";

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function ctxOf(sessionId: string): ToolContext {
  return {
    sessionId,
    messageId: "m-test",
    cwd: "C:\\repo",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  };
}

function toolByName(id: string) {
  const tool = createNotesTools().find((t) => t.id === id);
  if (!tool) throw new Error(`missing tool ${id}`);
  return tool;
}

function seedSession(sessionId: string, count = 4): void {
  for (let i = 1; i <= count; i += 1) {
    createMessage(
      {
        id: `${sessionId}-m${i}`,
        role: i % 2 === 1 ? "user" : "assistant",
        content: `第 ${i} 条消息`,
        timestamp: i,
        status: "done",
      },
      sessionId,
    );
  }
}

function minimalMarkerInput(notesDigest?: string) {
  return {
    summary: "检查点摘要",
    removedCount: 10,
    keptCount: 5,
    summarizedCount: 10,
    middleCount: 0,
    overflowCount: 0,
    ...(notesDigest !== undefined ? { notesDigest } : {}),
  };
}

beforeEach(() => {
  setStoragePort(
    createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION_A, project_id: "", title: "A", created_at: 0, last_message_at: 0, message_count: 0 },
          { id: SESSION_B, project_id: "", title: "B", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    }),
  );
  __resetThreadNotesCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  __resetThreadNotesCache();
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("NOTE-1：80% 水位提醒只注入一次，且笔记进入压缩/换段标记", () => {
  it("NOTE-1a：同一水位段只提醒一次；回落到线下后再次跨线可再提醒", () => {
    expect(maybeBuildWaterNotesReminder(SESSION_A, 0.5), "低于 80% 不提醒").toBeNull();

    const first = maybeBuildWaterNotesReminder(SESSION_A, 0.81);
    expect(first).toBeTruthy();
    expect(first).toContain("notes_append");
    expect(first).toContain("untrusted");

    expect(maybeBuildWaterNotesReminder(SESSION_A, 0.85), "同一水位段不许重复提醒").toBeNull();
    expect(maybeBuildWaterNotesReminder(SESSION_A, 0.99), "同一水位段不许重复提醒").toBeNull();

    /* 分隔水位段：回落到线下（例如压缩/换段把压力降下来）后，再跨线才允许再提醒一次 */
    expect(maybeBuildWaterNotesReminder(SESSION_A, 0.4)).toBeNull();
    expect(maybeBuildWaterNotesReminder(SESSION_A, 0.8), "新水位段应再次提醒").toBeTruthy();

    /* 会话隔离：A 的提醒状态不影响 B */
    expect(maybeBuildWaterNotesReminder(SESSION_B, 0.9)).toBeTruthy();
  });

  it("NOTE-1b：notes_append 之后换段，handoff 尾部带笔记摘要（untrusted）", async () => {
    seedSession(SESSION_A, 6);
    const append = toolByName("notes_append");
    const saved = await append.execute(
      { text: "目标：修好 write 假成功；进度：已定位 classifyToolResult；卡点：等判据复现", tag: "goal" },
      ctxOf(SESSION_A),
    );
    expect(saved.isError).toBe(false);

    const result = performSegmentSwitch(SESSION_A, { keepCount: 2, now: 1_000 });
    expect(result.switched).toBe(true);

    const timeline = listTimelineMessages(SESSION_A);
    const marker = timeline.find((m) => m.id === result.epochId);
    expect(marker, "switch marker 必须落库").toBeTruthy();
    const content = String(marker!.content);
    expect(content).toContain("[段切换 handoff]");
    expect(content, "handoff 必须含会话笔记摘要").toContain("会话笔记");
    expect(content).toContain("目标：修好 write 假成功");
    expect(content, "笔记必须标成 untrusted").toContain("untrusted");
  });

  it("NOTE-1c：压缩 marker 尾部含笔记摘要；没有笔记时与旧版逐字一致", async () => {
    const append = toolByName("notes_append");
    await append.execute({ text: "卡点：provider 超时未复现" }, ctxOf(SESSION_A));

    const digest = buildThreadNotesDigest(SESSION_A);
    expect(digest).toContain("卡点：provider 超时未复现");

    const withNotes = composeCompactionMarkerText({ ...minimalMarkerInput(digest), charBudget: 20_000 });
    expect(withNotes.startsWith("[上下文已自动压缩]"), "marker 协议前缀不许变").toBe(true);
    expect(withNotes).toContain("会话笔记");
    expect(withNotes).toContain("卡点：provider 超时未复现");
    expect(withNotes, "笔记必须标 untrusted").toContain("untrusted");
    /* 尾部：会话笔记之后只剩回读提示 */
    expect(withNotes.indexOf("会话笔记")).toBeGreaterThan(withNotes.indexOf("已折叠进本段摘要"));

    const withoutNotes = composeCompactionMarkerText(minimalMarkerInput());
    const emptyDigest = composeCompactionMarkerText(minimalMarkerInput(""));
    expect(emptyDigest, "空摘要不许改变 marker 一个字").toBe(withoutNotes);
    expect(withoutNotes).not.toContain("会话笔记");
  });

  it("NOTE-1c-budget：笔记摘要受 marker 字符预算约束（压缩不许让上下文变大）", async () => {
    await toolByName("notes_append").execute({ text: "长".repeat(3_900) }, ctxOf(SESSION_A));
    const digest = buildThreadNotesDigest(SESSION_A);
    for (const budget of [800, 1_500, 5_000]) {
      const marker = composeCompactionMarkerText({ ...minimalMarkerInput(digest), charBudget: budget });
      expect(marker.length, `charBudget=${budget} 时 marker 不许超预算`).toBeLessThanOrEqual(budget);
    }
  });

  it("NOTE-1d：notes 不可用（坏数据）⇒ 换段仍成功，handoff 回退为旧版内容（不阻断）", () => {
    seedSession(SESSION_A, 6);
    setSetting(threadNotesStorageKey(SESSION_A), "{坏数据");
    __resetThreadNotesCache();

    const result = performSegmentSwitch(SESSION_A, { keepCount: 2, now: 1_000 });
    expect(result.switched, "笔记不可用不许阻断换段").toBe(true);
    const marker = listTimelineMessages(SESSION_A).find((m) => m.id === result.epochId)!;
    expect(String(marker.content)).toContain("[段切换 handoff]");
    expect(String(marker.content), "没有可用笔记就不许编造笔记段").not.toContain("会话笔记");
  });

  it("NOTE-1e：摘要 4–8KB 上限生效，且从最旧开始省略（最新状态保留）", () => {
    for (let i = 1; i <= 40; i += 1) {
      appendThreadNote(SESSION_A, { text: `n${i} ` + "细节".repeat(100) });
    }
    const digest = buildThreadNotesDigest(SESSION_A, 2_000);
    expect(digest.length).toBeLessThanOrEqual(2_000);
    expect(digest, "最新一条必须在摘要里").toContain("n40 ");
    expect(digest, "被省略的条数要如实写出").toContain("未摘录");
    expect(digest, "必须标 untrusted").toContain("untrusted");
  });

  it("NOTE-1-wiring：80% 提醒走尾部易变上下文；压缩 marker 读取 notes 摘要", () => {
    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop, "loop 必须调用唯一的会话笔记提醒入口").toContain(
      "maybeBuildWaterNotesReminder(sessionId, water.ratio)",
    );
    /* 提醒只能进 trailingTurnContext（易变尾部），不许进 extraSystemPrompt（system 尾部也会改变 system 块） */
    const reminderBlock = loop.slice(loop.indexOf("maybeBuildWaterNotesReminder(sessionId, water.ratio)"));
    expect(reminderBlock.slice(0, 800)).toContain("trailingTurnContext +=");
    expect(reminderBlock.slice(0, 800)).not.toContain("extraSystemPrompt");

    expect(loop, "压缩 marker 必须把会话笔记摘要传进去").toContain(
      "notesDigest = buildThreadNotesDigest(sessionId)",
    );
    expect(loop).toContain("notesDigest,");
  });
});

describe("NOTE-2：跨回合 / 重启可读；坏数据空 + warn", () => {
  it("NOTE-2a：落盘后模拟新实例（清空进程内缓存）仍可读回", async () => {
    await toolByName("notes_append").execute(
      { text: "目标：跨重启仍可读", tag: "goal" },
      ctxOf(SESSION_A),
    );
    flushThreadNotes(SESSION_A);

    __resetThreadNotesCache(); // 新实例：内存缓存/去抖状态全清，只剩 settings 键
    const notes = listThreadNotes(SESSION_A);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("跨重启仍可读");
    expect(notes[0].tag).toBe("goal");
  });

  it("NOTE-2b：坏 JSON ⇒ 空笔记 + warn（不抛、不部分恢复）", () => {
    setSetting(threadNotesStorageKey(SESSION_A), "{这不是 JSON");
    __resetThreadNotesCache();

    const notes = listThreadNotes(SESSION_A);
    expect(notes).toEqual([]);
    const warned = vi.mocked(console.warn).mock.calls.some((args) =>
      String(args[0]).includes("格式不符"),
    );
    expect(warned, "坏数据必须 warn（不能静默当成没有笔记）").toBe(true);
  });

  it("NOTE-2b-version：版本不符 ⇒ 空 + warn；其它会话的信封也不会被误读", () => {
    setSetting(
      threadNotesStorageKey(SESSION_A),
      JSON.stringify({
        version: 999,
        sessionId: SESSION_A,
        updatedAt: 1,
        notes: [{ id: "x", text: "旧版本数据", createdAt: 1, updatedAt: 1 }],
      }),
    );
    __resetThreadNotesCache();
    expect(listThreadNotes(SESSION_A)).toEqual([]);

    /* 信封 sessionId 与键不一致：整批拒绝（防止串会话的数据被当成当前会话） */
    setSetting(
      threadNotesStorageKey(SESSION_A),
      JSON.stringify({
        version: 1,
        sessionId: SESSION_B,
        updatedAt: 1,
        notes: [{ id: "x", text: "别人的笔记", createdAt: 1, updatedAt: 1 }],
      }),
    );
    __resetThreadNotesCache();
    expect(listThreadNotes(SESSION_A)).toEqual([]);
  });
});

describe("NOTE-3：上限裁最旧、会话隔离", () => {
  it("NOTE-3a：200 条上限 —— 裁掉最旧，最新一条一定在", async () => {
    const tool = toolByName("notes_append");
    for (let i = 1; i <= THREAD_NOTES_MAX_COUNT + 5; i += 1) {
      await tool.execute({ text: `n${i}` }, ctxOf(SESSION_A));
    }
    const notes = listThreadNotes(SESSION_A);
    expect(notes).toHaveLength(THREAD_NOTES_MAX_COUNT);
    expect(notes[0].text, "裁掉的必须是最旧的 5 条").toBe("n6");
    expect(notes[notes.length - 1].text, "最新一条不许丢").toBe(`n${THREAD_NOTES_MAX_COUNT + 5}`);
  });

  it("NOTE-3b：64KB 字节上限 —— 裁最旧、不丢最新；超长单条截断要如实标记", async () => {
    /* 4000 个 ASCII 字符 = 4000 字节；17 条 = 68000 > 65536 ⇒ 必须裁到 16 条 */
    const notes = Array.from({ length: 17 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(4_000 - 4) + `#${String(i + 1).padStart(3, "0")}`);
    for (const text of notes) appendThreadNote(SESSION_A, { text });

    const kept = listThreadNotes(SESSION_A);
    expect(kept.length, "64KB 上限必须生效").toBe(16);
    expect(kept[kept.length - 1].text.endsWith("#017"), "最新一条必须在").toBe(true);
    expect(kept[0].text.endsWith("#002"), "最旧那条应被裁掉").toBe(true);
    expect(kept.reduce((sum, n) => sum + n.text.length, 0)).toBeLessThanOrEqual(THREAD_NOTES_MAX_TOTAL_BYTES);

    /* 单条超过 4000 字符 ⇒ 截断保存，并在返回值里标记 */
    const long = appendThreadNote(SESSION_B, { text: "x".repeat(THREAD_NOTES_MAX_NOTE_CHARS + 100) });
    expect(long.truncated).toBe(true);
    expect(long.note.text).toHaveLength(THREAD_NOTES_MAX_NOTE_CHARS);
  });

  it("NOTE-3c：会话隔离 —— A 读不到 B 的笔记（列表与按 id 都读不到；落盘+重启后也不串）", async () => {
    const tool = toolByName("notes_append");
    await tool.execute({ text: "B 的目标" }, ctxOf(SESSION_B));
    appendThreadNote(SESSION_A, { text: "A 的目标" });

    /* 先在内存里隔离 */
    expect(listThreadNotes(SESSION_A).map((n) => n.text)).toEqual(["A 的目标"]);
    expect(listThreadNotes(SESSION_B).map((n) => n.text)).toEqual(["B 的目标"]);

    /* 再走**持久化**路径：两个会话各自落盘，模拟重启后仍不许串 */
    flushThreadNotes(SESSION_A);
    flushThreadNotes(SESSION_B);
    __resetThreadNotesCache();
    expect(listThreadNotes(SESSION_A).map((n) => n.text), "重启后 A 只能看到 A").toEqual(["A 的目标"]);
    expect(listThreadNotes(SESSION_B).map((n) => n.text), "重启后 B 只能看到 B").toEqual(["B 的目标"]);

    const bId = listThreadNotes(SESSION_B)[0].id;
    expect(readThreadNote(SESSION_A, bId), "跨会话按 id 读必须失败").toBeNull();

    const readTool = toolByName("notes_read");
    const denied = await readTool.execute({ id: bId }, ctxOf(SESSION_A));
    expect(denied.isError, "notes_read 跨会话必须报错，而不是假装没有").toBe(true);
    expect(denied.output).toContain("别的会话");
  });

  it("NOTE-3d：删除会话时清掉笔记（settings 键不是外键级联）", async () => {
    appendThreadNote(SESSION_A, { text: "会被清理" });
    flushThreadNotes(SESSION_A);
    forgetThreadNotes(SESSION_A);
    __resetThreadNotesCache();
    expect(listThreadNotes(SESSION_A)).toEqual([]);
  });
});

describe("NOTE-5：用户编辑（落库 / 上限 / 失败可见 / 坏数据回退）", () => {
  it("NOTE-5a：改正文与标签，updatedAt 单调递增、rev+1、createdAt 不变；清缓存后仍读到新值", () => {
    const first = appendThreadNote(SESSION_A, { text: "目标：旧目标", tag: "goal", now: 1_000 });
    const id = first.note.id;
    const before = readThreadNote(SESSION_A, id)!;

    const result = updateThreadNote(SESSION_A, id, {
      text: "目标：新目标（已修正）",
      tag: "progress",
      now: 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.persisted, "用户编辑必须确认落库（不是只改内存）").toBe(true);
    expect(result.note.text).toBe("目标：新目标（已修正）");
    expect(result.note.tag, "标签跟着改").toBe("progress");
    expect(result.note.createdAt, "创建时间不许被编辑改掉").toBe(before.createdAt);
    expect(result.note.updatedAt, "同一毫秒内编辑也必须让 updatedAt 变").toBeGreaterThan(before.updatedAt);
    expect(result.note.rev).toBe(before.rev + 1);

    /* 模拟重启：清掉进程内缓存，只留 settings 键 */
    __resetThreadNotesCache();
    const reread = readThreadNote(SESSION_A, id);
    expect(reread, "编辑后重启仍可读").toBeTruthy();
    expect(reread!.text).toBe("目标：新目标（已修正）");
    expect(reread!.tag).toBe("progress");
    expect(reread!.rev).toBe(result.note.rev);
  });

  it("NOTE-5a-keep：只给 text ⇒ 标签保留；tag=\"\" ⇒ 显式清空；不给字段 ⇒ 可见失败", () => {
    const a = appendThreadNote(SESSION_A, { text: "A 正文", tag: "goal", now: 2_000 });
    const keep = updateThreadNote(SESSION_A, a.note.id, { text: "A 正文（改）", now: 2_001 });
    expect(keep.ok).toBe(true);
    if (keep.ok) expect(keep.note.tag, "没给 tag 不等于清空标签").toBe("goal");

    const cleared = updateThreadNote(SESSION_A, a.note.id, { tag: "", now: 2_002 });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.note.tag, "空串是显式清空").toBeUndefined();

    const none = updateThreadNote(SESSION_A, a.note.id, { now: 2_003 });
    expect(none.ok, "text/tag 都不给等于没有编辑，不能假装成功").toBe(false);
    if (!none.ok) expect(none.error).toBe("invalid");
  });

  it("NOTE-5b：正文超 4,000 字符截断并标记；标签截断到 40", () => {
    const note = appendThreadNote(SESSION_A, { text: "短" }).note;
    const long = "长".repeat(THREAD_NOTES_MAX_NOTE_CHARS + 50);
    const updated = updateThreadNote(SESSION_A, note.id, { text: long, tag: "标".repeat(80) });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.truncated).toBe(true);
    expect(updated.note.text).toHaveLength(THREAD_NOTES_MAX_NOTE_CHARS);
    expect(updated.note.tag).toHaveLength(40);

    __resetThreadNotesCache();
    const persisted = readThreadNote(SESSION_A, note.id)!;
    expect(persisted.text).toHaveLength(THREAD_NOTES_MAX_NOTE_CHARS);
    expect(persisted.tag).toHaveLength(40);
  });

  it("NOTE-5b-limit：编辑后总字节超上限 ⇒ 整次失败、原内容与其它笔记一个字都不动", () => {
    /* 中文按 UTF-8 3 字节：5×4000 字 = 60,000 字节；第 6 条 1,000 字 = 3,000 字节 ⇒ 63,000 */
    for (let i = 0; i < 5; i += 1) {
      appendThreadNote(SESSION_A, { text: `${i}` + "长".repeat(THREAD_NOTES_MAX_NOTE_CHARS - 1) });
    }
    const small = appendThreadNote(SESSION_A, { text: "小".repeat(1_000) }).note;
    /* append 走去抖；这里要断言「失败后磁盘也是旧内容」，先把前面的写入落库 */
    flushThreadNotes(SESSION_A);
    const before = listThreadNotes(SESSION_A).map((n) => ({ id: n.id, text: n.text, updatedAt: n.updatedAt }));

    const result = updateThreadNote(SESSION_A, small.id, {
      text: "改".repeat(THREAD_NOTES_MAX_NOTE_CHARS),
    });
    expect(result.ok, "超总字节上限的编辑必须失败，而不是静默裁掉别的笔记").toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("limit");
      expect(result.message).toContain(String(THREAD_NOTES_MAX_TOTAL_BYTES));
    }

    const after = listThreadNotes(SESSION_A).map((n) => ({ id: n.id, text: n.text, updatedAt: n.updatedAt }));
    expect(after, "失败后内存状态必须与失败前逐字一致").toEqual(before);

    __resetThreadNotesCache();
    const persisted = readThreadNote(SESSION_A, small.id)!;
    expect(persisted.text, "失败后磁盘也只能是旧内容").toBe(small.text);
  });

  it("NOTE-5c：空正文 / 未知 id / 别的会话 id 都如实失败（不抛、不静默成功）", () => {
    const a = appendThreadNote(SESSION_A, { text: "A 的笔记" }).note;
    expect(updateThreadNote(SESSION_A, a.id, { text: "   " }).ok, "空正文不许保存").toBe(false);

    const missing = updateThreadNote(SESSION_A, "tn-does-not-exist", { text: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBe("not_found");
      expect(missing.message, "要说明也可能属于别的会话").toContain("会话隔离");
    }

    const crossSession = updateThreadNote(SESSION_B, a.id, { text: "越权改 A 的笔记" });
    expect(crossSession.ok, "别的会话的 id 必须改不到").toBe(false);
    if (!crossSession.ok) expect(crossSession.error).toBe("not_found");
    expect(readThreadNote(SESSION_A, a.id)!.text, "A 的笔记一个字都不许动").toBe("A 的笔记");
  });

  it("NOTE-5d：坏数据（坏 JSON）下编辑返回 not_found + corrupt，不抛、不覆盖原值", () => {
    setSetting(threadNotesStorageKey(SESSION_A), "{坏数据");
    __resetThreadNotesCache();

    let result!: ReturnType<typeof updateThreadNote>;
    expect(() => {
      result = updateThreadNote(SESSION_A, "tn-any", { text: "想写" });
    }, "坏数据不许把编辑路径抛崩").not.toThrow();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
      expect(result.corrupt, "要能区分「数据不可读」与「id 打错」").toBe(true);
      expect(result.message).toContain("格式不符");
    }
    expect(listThreadNotes(SESSION_A), "坏数据仍按空处理").toEqual([]);
  });
});

describe("NOTE-6：用户删除（立即落库 / 只删指定 id / 可见失败）", () => {
  it("NOTE-6a：删除后不可读（清缓存后也不复活）；其它笔记保留", () => {
    const a = appendThreadNote(SESSION_A, { text: "要删的" }).note;
    const b = appendThreadNote(SESSION_A, { text: "要留的" }).note;

    const result = deleteThreadNote(SESSION_A, a.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.persisted, "删除必须确认落库（否则进程退出会复活它）").toBe(true);
    expect(result.count).toBe(1);
    expect(readThreadNote(SESSION_A, a.id)).toBeNull();
    expect(readThreadNote(SESSION_A, b.id)!.text).toBe("要留的");

    __resetThreadNotesCache();
    expect(readThreadNote(SESSION_A, a.id), "重启后删掉的笔记不许复活").toBeNull();
    expect(listThreadNotes(SESSION_A).map((n) => n.id)).toEqual([b.id]);
  });

  it("NOTE-6b：删除不存在 / 别的会话的 id、坏数据 ⇒ 可见失败且不误删", () => {
    const b = appendThreadNote(SESSION_B, { text: "B 的笔记" }).note;

    const missing = deleteThreadNote(SESSION_A, "tn-nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("not_found");

    const cross = deleteThreadNote(SESSION_A, b.id);
    expect(cross.ok, "不许跨会话删除").toBe(false);
    expect(readThreadNote(SESSION_B, b.id), "B 的笔记必须还在").toBeTruthy();

    setSetting(threadNotesStorageKey(SESSION_A), "{坏数据");
    __resetThreadNotesCache();
    let bad!: ReturnType<typeof deleteThreadNote>;
    expect(() => {
      bad = deleteThreadNote(SESSION_A, b.id);
    }, "坏数据不许把删除路径抛崩").not.toThrow();
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.corrupt).toBe(true);
  });
});

describe("NOTE-TOOL-4/5：notes_update / notes_delete 的契约与行为", () => {
  it("NOTE-TOOL-4：update/delete 都不是只读、都 defer、都有 outputSchema；delete 是破坏性", () => {
    const registry = createDefaultToolRegistry();
    for (const id of ["notes_update", "notes_delete"]) {
      const c = registry.getContract(id);
      expect(c.readOnly, `${id} 会写会话状态，不能标只读`).toBe(false);
      expect(c.sideEffectScope).toBe("session");
      expect(registry.getRawContract(id)?.outputSchema, `${id} 必须声明结果契约`).toBeTruthy();
      expect(
        registry.getCoreDefinitions().map((t) => t.name),
        `${id} 不许进常驻 schema（预算不增）`,
      ).not.toContain(id);
      const hint = registry.getDeferredDefinitions().find((d) => d.name === id);
      expect(hint, `${id} 必须在 deferred 提示里（否则模型不可达）`).toBeTruthy();
      expect(hint!.searchHint.length).toBeGreaterThan(10);
    }
    expect(registry.getContract("notes_delete").destructive, "删除不可撤销，契约要如实").toBe(true);
  });

  it("NOTE-TOOL-4b：append → update → read 全链路（含标签清空与输出脱敏）", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const appended = await toolByName("notes_append").execute(
      { text: "目标：旧", tag: `goal-${secret}` },
      ctxOf(SESSION_A),
    );
    const id = listTimelineNotesId(SESSION_A);
    expect(appended.isError).toBe(false);

    const updated = await toolByName("notes_update").execute(
      { id, text: "目标：新", tag: "progress" },
      ctxOf(SESSION_A),
    );
    expect(updated.isError).toBe(false);
    expect(updated.output).toContain("Updated note");
    expect(updated.output).toContain("rev 2");
    expect(updated.value).toMatchObject({ id, rev: 2, untrusted: true });

    const read = await toolByName("notes_read").execute({ id }, ctxOf(SESSION_A));
    expect(read.output).toContain("目标：新");
    expect(read.output, "改完不许残留旧正文").not.toContain("目标：旧");

    const cleared = await toolByName("notes_update").execute({ id, tag: "" }, ctxOf(SESSION_A));
    expect(cleared.isError).toBe(false);
    const after = readThreadNote(SESSION_A, id)!;
    expect(after.tag).toBeUndefined();
  });

  it("NOTE-TOOL-4c：update 的失败都报错（缺 id / 没字段 / 空正文 / 未知 id / 无会话）", async () => {
    const append = await toolByName("notes_append").execute({ text: "存在的笔记" }, ctxOf(SESSION_A));
    expect(append.isError).toBe(false);
    const id = listTimelineNotesId(SESSION_A);
    const update = toolByName("notes_update");

    expect((await update.execute({}, ctxOf(SESSION_A))).isError).toBe(true);
    expect((await update.execute({ id }, ctxOf(SESSION_A))).isError).toBe(true);
    expect((await update.execute({ id, text: "  " }, ctxOf(SESSION_A))).isError).toBe(true);
    expect((await update.execute({ id: "tn-nope", text: "x" }, ctxOf(SESSION_A))).isError).toBe(true);
    const noSession = await update.execute({ id, text: "x" }, { ...ctxOf(""), sessionId: "" });
    expect(noSession.isError).toBe(true);
    expect(noSession.output).toContain("需要当前会话");
  });

  it("NOTE-TOOL-5：append → delete；删除后 read 按「不存在」报错，再删也报错（不静默成功）", async () => {
    await toolByName("notes_append").execute({ text: "删我" }, ctxOf(SESSION_A));
    const id = listTimelineNotesId(SESSION_A);

    const deleted = await toolByName("notes_delete").execute({ id }, ctxOf(SESSION_A));
    expect(deleted.isError).toBe(false);
    expect(deleted.output).toContain("Deleted note");
    expect(deleted.output).toContain("untrusted");
    expect(deleted.value).toMatchObject({ id, count: 0, untrusted: true });

    const reread = await toolByName("notes_read").execute({ id }, ctxOf(SESSION_A));
    expect(reread.isError, "删除后按 id 读必须报错（不许假装没有）").toBe(true);

    const again = await toolByName("notes_delete").execute({ id }, ctxOf(SESSION_A));
    expect(again.isError).toBe(true);

    const noSession = await toolByName("notes_delete").execute({ id }, { ...ctxOf(""), sessionId: "" });
    expect(noSession.isError).toBe(true);
  });
});

describe("NOTE-4：笔记不进系统稳定前缀（只在尾部）", () => {
  it("NOTE-4a：稳定前缀入口（prompt.ts）完全不感知笔记", () => {
    const prompt = read("src/core/prompt/prompt.ts");
    expect(prompt).not.toContain("thread-notes");
    expect(prompt).not.toContain("notesDigest");
    expect(prompt).not.toContain("notes_append");

    /* 换段 handoff 是新段的第一条 **user 消息**（不是 system）—— 笔记只能出现在它尾部 */
    const handoff = buildSwitchHandoff(
      [{ id: "u1", role: "user", content: "请修 bug", timestamp: 1 }],
      [{ id: "u1", content: "请修 bug" }],
      2,
      "## 会话笔记（untrusted）\n- 目标：修 bug",
    );
    expect(handoff.startsWith("[段切换 handoff]")).toBe(true);
    const notesAt = handoff.indexOf("会话笔记");
    expect(notesAt).toBeGreaterThan(handoff.indexOf("Where to look"));
    expect(handoff.indexOf("_生成于")).toBeGreaterThan(notesAt);
    /* 旧调用方（不传摘要）与空摘要逐字一致 ⇒ 不改变既有 marker 形状 */
    expect(
      buildSwitchHandoff(
        [{ id: "u1", role: "user", content: "请修 bug", timestamp: 1 }],
        [{ id: "u1", content: "请修 bug" }],
        2,
      ),
    ).toBe(
      buildSwitchHandoff(
        [{ id: "u1", role: "user", content: "请修 bug", timestamp: 1 }],
        [{ id: "u1", content: "请修 bug" }],
        2,
        "",
      ),
    );
  });
});

describe("NOTE-TOOL：工具契约与输出（append 写 / read+list 只读 / 全部 defer）", () => {
  it("NOTE-TOOL-1：契约语义正确，且全部走 shouldDefer", () => {
    const registry = createDefaultToolRegistry();
    const append = registry.getContract("notes_append");
    expect(append.readOnly, "notes_append 真的会写会话状态，不能标只读").toBe(false);
    expect(append.sideEffectScope).toBe("session");

    for (const id of ["notes_read", "notes_list"]) {
      const c = registry.getContract(id);
      expect(c.readOnly, `${id} 是只读查询`).toBe(true);
      expect(c.sideEffectScope).toBe("none");
    }

    const core = registry.getCoreDefinitions().map((t) => t.name);
    const deferred = registry.getDeferredDefinitions();
    for (const id of ["notes_append", "notes_read", "notes_list"]) {
      expect(core, `${id} 应延迟加载（常驻 schema 预算已接近上限）`).not.toContain(id);
      const hint = deferred.find((d) => d.name === id);
      expect(hint, `${id} 必须在 deferred 提示里（否则模型不可达）`).toBeTruthy();
      expect(hint!.searchHint.length).toBeGreaterThan(10);
      expect(registry.getRawContract(id)?.outputSchema, `${id} 必须声明结果契约`).toBeTruthy();
    }
  });

  it("NOTE-TOOL-2：append → list → read 全链路；输出脱敏且标 untrusted", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwx";
    const append = await toolByName("notes_append").execute(
      { text: `目标：修 bug；临时 key=${secret}`, tag: "progress" },
      ctxOf(SESSION_A),
    );
    expect(append.isError).toBe(false);
    expect(append.output).toContain("Saved note");
    expect(append.output).toContain("untrusted");

    const list = await toolByName("notes_list").execute({}, ctxOf(SESSION_A));
    expect(list.isError).toBe(false);
    expect(list.output).toContain("progress");
    expect(list.output).toContain("目标：修 bug");
    expect(list.output, "笔记输出必须脱敏").not.toContain(secret);
    expect(list.output).toContain("[REDACTED_API_KEY]");

    const id = listTimelineNotesId(SESSION_A);
    const readOne = await toolByName("notes_read").execute({ id }, ctxOf(SESSION_A));
    expect(readOne.isError).toBe(false);
    expect(readOne.output).toContain("目标：修 bug");
    expect(readOne.output).not.toContain(secret);

    const recent = await toolByName("notes_read").execute({}, ctxOf(SESSION_A));
    expect(recent.isError).toBe(false);
    expect(recent.output).toContain("Most recent");
  });

  it("NOTE-TOOL-3：空会话给明确空态；跨会话 / 缺 id / 空 text 都报错而不是假装成功", async () => {
    const list = await toolByName("notes_list").execute({}, ctxOf(SESSION_A));
    expect(list.output).toContain("No session notes yet");

    const emptyText = await toolByName("notes_append").execute({ text: "   " }, ctxOf(SESSION_A));
    expect(emptyText.isError).toBe(true);

    const noSession = await toolByName("notes_append").execute({ text: "x" }, { ...ctxOf(""), sessionId: "" });
    expect(noSession.isError).toBe(true);

    const missing = await toolByName("notes_read").execute({ id: "nope" }, ctxOf(SESSION_A));
    expect(missing.isError).toBe(true);
  });
});

/** 取最近一条笔记 id（只用于工具判据，避免依赖 `notes_list` 的文本排版） */
function listTimelineNotesId(sessionId: string): string {
  const notes = listThreadNotes(sessionId);
  return notes[notes.length - 1].id;
}
