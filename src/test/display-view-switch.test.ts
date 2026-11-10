/**
 * P0-0 读法 guard：DisplayView（E5 / D11）。
 *
 * ## 守什么
 *
 * 1. **默认读法不变**：没有 switch epoch 的会话，`listDisplayMessages` 与
 *    `listMessages` **逐条相同** —— 这是 E5「默认读法不变」的可执行定义；
 * 2. **有 switch epoch 必须读完整时间线**：否则换段之后手机 / 分叉只看到
 *    最后一段，旧段静默消失（D11 说的正是这个形态）；
 * 3. **接线**：`session.get` 与 `fork` 必须真的走这个 guard。
 *    `no-sync-mirror-reads` 只能证明它们**不再**调 `listMessages(`，
 *    不能证明它们调了正确的新入口 —— 所以这里补一条正向断言。
 * 4. **fork 行为**：有 switch epoch 时，子会话必须复制到换段之前的消息。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import {
  createMessage,
  listDisplayMessages,
  listMessages,
  listTimelineMessages,
} from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";
import { ContextManager } from "../core/context/context";
import { resolveForkIndexForSession } from "../core/session/fork-index";
import { useProjectStore } from "../core/store";
import { __awaitPendingWrites, domainEnsureLoaded } from "../core/storage/domain-store";
import * as SessionStorage from "../core/storage/session";

const S = "sess-display-switch";
const PROJECT = "proj-display-switch";

/** 假端口实例（DV-7 要按 `crud.upsert` 种会话行，见 `feature-context-fixes.test.ts:130` 的说明） */
let port: ReturnType<typeof createFakeStoragePort>;

/**
 * 种一个可分叉的源会话：表里的行 + 域镜像 + store 里的那一份。
 *
 * 三处都要，少一处就是"源会话不存在"的假失败（`getSession` 读镜像，
 * `store.forkSession` 读内存列表，切片读消息表）。
 */
async function seedForkableSession(messageCount: number) {
  const proj = { id: PROJECT, name: "P", path: "C:\\repo", createdAt: 1, lastAccessedAt: 1 };
  await port.data.execute("crud.upsert", {
    table: "sessions",
    mode: "replace",
    rows: [{
      id: S, project_id: PROJECT, title: "源", model: null,
      created_at: 1, last_message_at: messageCount, message_count: messageCount, pinned: 0,
    }],
  });
  await new Promise<void>((resolve) => { domainEnsureLoaded("sessions", () => resolve()); });
  expect(SessionStorage.getSession(S), "源会话必须真的在域镜像里（否则 fork 会以「源会话不存在」失败）").toBeTruthy();
  useProjectStore.setState({
    projects: [proj] as never,
    currentProject: proj as never,
    sessions: [{
      id: S, projectId: PROJECT, title: "源", createdAt: 1, lastMessageAt: messageCount, messageCount, pinned: false,
    }] as never,
  });
}

function readSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function switchMarker(cutoffMessageId: string, seq = 2) {
  return buildContextEpochMetadata({
    epochId: `compact-switch-${seq}`,
    cutoffMessageId,
    createdAt: 100 * seq,
    removedCount: 1,
    keptCount: 1,
    trigger: "switch",
    kind: "switch",
    segmentSeq: seq,
  }) ?? undefined;
}

describe("listDisplayMessages — switch epoch 的 DisplayView", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    port = createFakeStoragePort({
      seed: {
        sessions: [
          { id: S, project_id: PROJECT, title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    });
    setStoragePort(port);
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("DV-1: 没有 switch epoch ⇒ 与 listMessages 逐条相同（默认读法不变）", () => {
    createMessage({ id: "m1", role: "user", content: "第一轮", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "回答", timestamp: 2, status: "done" }, S);

    const display = listDisplayMessages(S);
    const model = listMessages(S);
    /* 全对象比较（不是只比 id）：字段顺序/缺省字段的差异也要能被抓到 */
    expect(display).toEqual(model);
  });

  it("DV-2: 只有 compact epoch ⇒ 仍与 listMessages 逐条相同（压缩不等于换段）", () => {
    createMessage({ id: "m1", role: "user", content: "第一轮", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "回答", timestamp: 2, status: "done" }, S);
    createMessage({
      id: "compact-100-1",
      role: "user",
      content: "[上下文已自动压缩]\n摘要",
      timestamp: 3,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-100-1",
        cutoffMessageId: "m2",
        createdAt: 100,
        kind: "compact",
        segmentSeq: 1,
      }) ?? undefined,
    }, S);

    const display = listDisplayMessages(S).map((m) => m.id);
    const model = listMessages(S).map((m) => m.id);
    expect(display).toEqual(model);
    expect(display, "compact 仍然裁掉旧段").toEqual(["compact-100-1", "m2"]);
  });

  it("DV-2b: 旧 marker（没有 kind 字段）也不会被当成 switch", () => {
    /* 旧版本写下的 compact marker：metadata 里没有 kind / segmentSeq */
    createMessage({ id: "m1", role: "user", content: "旧段", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-legacy-1",
      role: "user",
      content: "[摘要]",
      timestamp: 2,
      status: "done",
      metadata: {
        contextEpoch: {
          epochId: "compact-legacy-1",
          seq: 1,
          cutoffMessageId: "m2",
          createdAt: 100,
          removedCount: 1,
          keptCount: 1,
          trigger: "auto",
        },
      },
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "新段", timestamp: 3, status: "done" }, S);

    const display = listDisplayMessages(S).map((m) => m.id);
    expect(display, "旧 marker 默认 compact ⇒ 读法与今天一致").toEqual(["compact-legacy-1", "m2"]);
  });

  it("DV-3: 有 switch epoch ⇒ 返回完整时间线（旧段不丢）", () => {
    createMessage({ id: "m1", role: "user", content: "换段之前的重要事实", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "换段之前的回答", timestamp: 2, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]\nhandoff",
      timestamp: 3,
      status: "done",
      metadata: switchMarker("m4"),
    }, S);
    createMessage({ id: "m4", role: "user", content: "换段之后", timestamp: 4, status: "done" }, S);

    expect(listMessages(S).map((m) => m.id), "模型视图只看最新段").toEqual(["compact-switch-2", "m4"]);
    expect(listTimelineMessages(S).map((m) => m.id), "时间线本来就完整").toEqual([
      "m1", "m2", "compact-switch-2", "m4",
    ]);
    expect(listDisplayMessages(S).map((m) => m.id), "DisplayView 必须完整").toEqual([
      "m1", "m2", "compact-switch-2", "m4",
    ]);
  });

  it("DV-4: limit 语义与 listMessages 一致（取最后 N 条）", () => {
    createMessage({ id: "m1", role: "user", content: "旧", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "旧答", timestamp: 2, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 3,
      status: "done",
      metadata: switchMarker("m4"),
    }, S);
    createMessage({ id: "m4", role: "user", content: "新", timestamp: 4, status: "done" }, S);

    expect(listDisplayMessages(S, 2).map((m) => m.id)).toEqual(["compact-switch-2", "m4"]);
  });

  it("DV-8: 显式关闭时读侧仍按数据判断（D11 管的是「产不产生」，不是「读不读得到」）", () => {
    /**
     * 为什么必须有这条：`segmentEpochs` 的**写侧**开关控制「产不产生 switch」，
     * 但如果有人把它误接成"读侧开关"，那么一旦库里有 switch epoch（比如上一版打开过、
     * 或将来灰度回滚成 false），手机/分叉就会立刻退回投影视图 —— 静默丢段，且没有任何报错。
     * 读法必须**数据驱动**：库里有什么，就按什么读。
     *
     * 默认值已于 2026-11-06 改为 true（D11 兼容矩阵全绿后用户授权）；这条判据因此
     * 用**显式 false**（灰度回滚形态）作为前提 —— 那才是读侧最容易被误接的配置。
     */
    const cm = new ContextManager({ segmentEpochs: false });
    expect(cm.getConfig().segmentEpochs, "前提：显式关闭（灰度回滚形态）").toBe(false);

    createMessage({ id: "m1", role: "user", content: "换段之前", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: switchMarker("m3"),
    }, S);
    createMessage({ id: "m3", role: "user", content: "换段之后", timestamp: 3, status: "done" }, S);

    expect(listDisplayMessages(S).map((m) => m.id), "开关关着也要读完整时间线").toContain("m1");
  });

  it("DV-8b: 手机读入口的行为（换段会话不丢旧段）", async () => {
    /**
     * 只断言源码里有某个函数名，抓不到「函数被换掉/参数写错」。
     * 这里直接调 `session.get` 的真实数据入口（`readRemoteMessages`），
     * 用假端口验证消息确实完整。
     */
    const { readRemoteMessages } = await import("../core/remote/desktop-engine");
    createMessage({ id: "m1", role: "user", content: "换段之前的事实", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: switchMarker("m3"),
    }, S);
    createMessage({ id: "m3", role: "assistant", content: "换段之后", timestamp: 3, status: "done" }, S);

    const rows = readRemoteMessages(S, 50);
    expect(rows.map((r) => r.content)).toContain("换段之前的事实");
    expect(rows.map((r) => r.content)).toContain("换段之后");
  });
});

describe("DisplayView 接线（D11 前置）", () => {
  it("DV-5: 手机 session.get 的同步读入口用 listDisplayMessages", () => {
    const src = readSource("src/core/remote/desktop-engine.ts");
    expect(src, "session.get 必须走 DisplayView guard").toContain("MessageStorage.listDisplayMessages(");
    expect(src, "不许退回投影视图（否则换段后手机少一段）").not.toContain("MessageStorage.listMessages(");
  });

  it("DV-6: fork 复制消息用 listDisplayMessages", () => {
    const src = readSource("src/core/store.ts");
    expect(src, "分叉必须复制完整 DisplayView").toContain("MessageStorage.listDisplayMessages(");
    expect(src).not.toContain("MessageStorage.listMessages(");
  });
});

describe("fork 在 switch epoch 下的行为（D11）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    port = createFakeStoragePort({});
    setStoragePort(port);
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
    useProjectStore.setState({ projects: [], currentProject: null, sessions: [], currentSession: null } as never);
  });

  it("DV-7: 有 switch epoch 时子会话复制到换段之前的消息", async () => {
    await seedForkableSession(4);

    createMessage({ id: "m1", role: "user", content: "换段之前的重要事实", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "换段之前的回答", timestamp: 2, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 3,
      status: "done",
      metadata: switchMarker("m4"),
    }, S);
    createMessage({ id: "m4", role: "user", content: "换段之后", timestamp: 4, status: "done" }, S);

    const child = useProjectStore.getState().forkSession(S, 3, "Fork: 段式会话");
    expect(child, "分叉必须落地").toBeTruthy();
    await __awaitPendingWrites();

    const copied = listMessages(child!.id).map((m) => String(m.content));
    expect(copied, "换段之前的消息必须在子会话里").toContain("换段之前的重要事实");
    expect(copied).toContain("换段之后");
  });

  it("DV-9: 换段后又压缩过（switch 不是最新 epoch）⇒ 检测仍要看时间线", () => {
    /**
     * 被守的退化：把 guard 写成 `readLatestContextEpoch(timeline).kind === "switch"`。
     * 换段之后段内还会继续 compact，此时**最新的 epoch 是 compact**；
     * 只看最新一条会在「换段后第一次压缩」时把 switch 事实弄丢，
     * 于是手机/分叉又退回投影视图 —— 静默丢段。
     */
    createMessage({ id: "m1", role: "user", content: "第一段的事实", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到第二段]",
      timestamp: 2,
      status: "done",
      metadata: switchMarker("m2", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "第二段开头", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "第二段中段", timestamp: 4, status: "done" }, S);
    createMessage({
      id: "compact-400-3",
      role: "user",
      content: "[第二段内压缩]",
      timestamp: 5,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-400-3",
        cutoffMessageId: "m3",
        createdAt: 400,
        removedCount: 1,
        keptCount: 1,
        trigger: "auto",
        kind: "compact",
        segmentSeq: 2,
      }) ?? undefined,
    }, S);
    createMessage({ id: "m4", role: "user", content: "第二段末", timestamp: 6, status: "done" }, S);

    expect(listMessages(S).map((m) => m.id), "模型视图 = 最新 compact + 其后的消息").toEqual([
      "compact-400-3", "m3", "m4",
    ]);
    expect(listDisplayMessages(S).map((m) => m.id), "DisplayView 必须含第一段").toEqual([
      "m1", "compact-switch-2", "m2", "m3", "compact-400-3", "m4",
    ]);
  });

  it("DV-10: 在中间位置分叉，子会话恰好到那一轮结束（不多不少）", async () => {
    await seedForkableSession(6);

    createMessage({ id: "m1", role: "user", content: "一", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      metadata: switchMarker("m2", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "二", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "三", timestamp: 4, status: "done" }, S);
    createMessage({ id: "m4", role: "assistant", content: "四", timestamp: 5, status: "done" }, S);
    createMessage({ id: "m5", role: "user", content: "五", timestamp: 6, status: "done" }, S);

    /* DisplayView 下标 3 = m3（user）；复制区间 = [0, 下一轮 user 之前)，即把当轮答完（含 m4） */
    const child = useProjectStore.getState().forkSession(S, 3, "Fork: 中间分叉");
    expect(child).toBeTruthy();
    await __awaitPendingWrites();

    const copied = listMessages(child!.id).map((m) => String(m.content));
    expect(copied, "到当轮答完为止（含换段前的 m1 与 marker），不多不少").toEqual([
      "一", "[已切换到新段]", "二", "三", "四",
    ]);
    expect(copied).not.toContain("五");
  });

  it("DV-11: 子会话不复制 epoch（悬空 cutoff 会让每次读都 fail-open）", async () => {
    /**
     * 被守的缺陷（复核 2 实测）：`copyMessageToSession` 原来原样复制 metadata，
     * 而 `cutoffMessageId` 指向**源会话**的消息 id；子会话的消息 id 全换了新值
     * ⇒ 子会话的 cutoff 永远找不到 ⇒ 每次读都 fail-open + 告警。
     *
     * 处置＝25-P0-0 允许的「显式全量」：分叉出的新会话从第 0 条开始，不搬"压缩过"的假投影。
     */
    await seedForkableSession(3);
    createMessage({ id: "m1", role: "user", content: "换段之前", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到新段]",
      timestamp: 2,
      status: "done",
      /* 带一条与 epoch 无关的 metadata：复制时只许剥 contextEpoch，其余必须保留 */
      metadata: { ...switchMarker("m3"), systemInjected: true },
    }, S);
    createMessage({ id: "m3", role: "user", content: "换段之后", timestamp: 3, status: "done" }, S);

    const child = useProjectStore.getState().forkSession(S, 2, "Fork: epoch");
    expect(child).toBeTruthy();
    await __awaitPendingWrites();

    const timeline = listTimelineMessages(child!.id);
    expect(timeline.map((m) => String(m.content))).toEqual(["换段之前", "[已切换到新段]", "换段之后"]);
    expect(
      timeline.some((m) => Boolean((m.metadata as Record<string, unknown> | undefined)?.contextEpoch)),
      "子会话不许带悬空的 epoch",
    ).toBe(false);
    const copiedMarker = timeline.find((m) => m.id.startsWith("compact-switch-2"));
    expect(
      (copiedMarker?.metadata as Record<string, unknown> | undefined)?.systemInjected,
      "与 epoch 无关的 metadata 必须保留（只剥 contextEpoch，不是清空整包）",
    ).toBe(true);
    expect(listMessages(child!.id), "模型视图不再被 cutoff 裁剪").toHaveLength(3);
  });

  it("DV-12: 端到端——投影窗口点 m3 → 换算 → 分叉内容恰好到 m3", async () => {
    /**
     * 这一条把两半连起来：`resolveForkIndexForSession`（按 id 定位）→ `forkSession`（按 DisplayView 切片）。
     * 只在 FI-1 里测换算、只在 DV-10 里测切片，都可能漏掉"两半各自对、拼起来错"。
     */
    await seedForkableSession(6);
    createMessage({ id: "m1", role: "user", content: "第一段", timestamp: 1, status: "done" }, S);
    createMessage({
      id: "compact-switch-2",
      role: "user",
      content: "[已切换到第二段]",
      timestamp: 2,
      status: "done",
      metadata: switchMarker("m2", 2),
    }, S);
    createMessage({ id: "m2", role: "assistant", content: "二", timestamp: 3, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "三", timestamp: 4, status: "done" }, S);
    createMessage({
      id: "compact-400-3",
      role: "user",
      content: "[段内压缩]",
      timestamp: 5,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-400-3",
        cutoffMessageId: "m3",
        createdAt: 400,
        removedCount: 1,
        keptCount: 1,
        trigger: "auto",
        kind: "compact",
        segmentSeq: 2,
      }) ?? undefined,
    }, S);
    createMessage({ id: "m4", role: "user", content: "四", timestamp: 6, status: "done" }, S);

    /* 生产形态：窗口 = 模型投影（marker 被挪到最前） */
    const window = listMessages(S).map((m) => ({ id: m.id, timestamp: m.timestamp }));
    const clicked = window.findIndex((m) => m.id === "m3");
    expect(clicked, "前提：m3 在投影窗口里").toBeGreaterThanOrEqual(0);

    const resolved = resolveForkIndexForSession(S, clicked, window);
    expect(resolved.absoluteIndex, "m3 在 DisplayView 的第 3 位").toBe(3);

    const child = useProjectStore.getState().forkSession(S, resolved.absoluteIndex, "Fork: e2e");
    expect(child).toBeTruthy();
    await __awaitPendingWrites();

    expect(listMessages(child!.id).map((m) => String(m.content))).toEqual([
      "第一段", "[已切换到第二段]", "二", "三",
    ]);
  });
});
