/**
 * 消息附件的读路径（第 72 轮审计后续）
 *
 * ## 为什么单开一个文件
 *
 * 审计发现 `attachments` 与 `message_feedback` 是**同一成因的两个实例**：
 * 数据来自**域镜像**，镜像没就绪时读返回 `undefined`，而上层要么当"空"、要么原样返回 ——
 * 而消息列表/消息渲染**只读一次**，于是"库里有、界面上没有"会一直持续。
 *
 * 真机现状：本机 `attachments` 表 **0 行**（没有真实附件数据），所以这一条**无法**用现有数据
 * 在装机版上量到"看不见"；这里用两件事守住：
 *   ① 结构面：`attachments` 必须在首屏预取清单里（与 message_feedback 同一条纪律）；
 *   ② 行为面：镜像就绪后必须能把附件**补进已加载的消息**（下面是真读真补的用例）。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | ATT-1 | 预取清单必须含 `attachments`（否则首屏那次读注定丢附件） |
 * | ATT-2 | 镜像里已有附件行 ⇒ 重新取一次必须把附件**补进**已加载消息 |
 * | ATT-3 | 镜像没接手（`neverReady`）⇒ 保持原样、**不抛**（不许把消息弄坏） |
 * | ATT-4 | 接线：ChatPanel 必须挂 `useDomainReady("attachments", …)` 调 `refreshMessageAttachments` |
 * | ATT-5 | 已经带附件的消息不被无意义地替换（引用相同 = 没触发整表重渲染） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetPersistFailures } from "../core/storage/persist-failure";

const SESSION = "s-att";

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  const port = createFakeStoragePort({ seed: {} });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  await new Promise((r) => setTimeout(r, 20));
});

afterEach(async () => {
  const { setStoragePort } = await import("../core/storage/port");
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

async function seedMessageWithAttachment() {
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort, getStoragePort } = await import("../core/storage/port");
  /*
   * ⚠️ 关键：用 `asyncLoad` —— 要复现的是"**消息读得到、附件镜像还没就绪**"那个窗口。
   * 第一版用同步就绪的假端口，于是 `loadMessages` 当场就带回附件，
   * 前置断言直接失败（"缺陷形态"根本没被造出来）。
   */
  const port = createFakeStoragePort({
    asyncLoad: true,
    seed: {
      messages: [
        {
          id: "m-att",
          session_id: SESSION,
          role: "user",
          content: "带附件的消息",
          reasoning: null,
          timestamp: 1,
          model: null,
          status: "done",
          parent_message_id: null,
          metadata: null,
          hidden: 0,
          trimmed: 0,
        },
      ],
      attachments: [
        {
          id: "att-1",
          message_id: "m-att",
          session_id: SESSION,
          name: "spec.md",
          type: "file",
          preview: null,
          path: null,
          sandbox_path: null,
          mime_type: "text/markdown",
          size: 1234,
          added_at: 1,
        },
      ],
    },
  });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  port.domains.ensureLoaded("messages");
  port.messages.ensureLoaded(SESSION);
  await flush(); // 只把 messages 拉到就绪；attachments 留到后面再就绪
  return { port, storage: getStoragePort() };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("消息附件的读路径（与 message_feedback 同类）", () => {
  it("ATT-1: 首屏预取清单必须含 attachments", async () => {
    const { HOT_DOMAIN_TABLES } = await import("../core/storage/bootstrap");
    expect(
      HOT_DOMAIN_TABLES,
      "消息列表里每条消息都可能带附件，而附件来自域镜像 —— 不预取 ⇒ 首屏那次读必然丢附件（与 message_feedback 同一条纪律）",
    ).toContain("attachments");
  });

  it("ATT-2: 镜像里有附件行 ⇒ 重新取一次必须把附件补进已加载消息", async () => {
    const { port } = await seedMessageWithAttachment();
    const { useAppStore } = await import("../store");
    // 先加载消息：此刻**附件镜像还没就绪**（asyncLoad）—— 这就是真机上"有附件却看不见"的窗口
    useAppStore.getState().loadMessages(SESSION);
    const before = useAppStore.getState().messages;
    expect(before.length, "前置：消息加载到了").toBeGreaterThan(0);
    expect(before[0].attachments ?? [], "前置：这一次读没有附件（就是缺陷形态）").toHaveLength(0);

    // 附件镜像就绪（真机上是"加载晚了几十~几百毫秒"）
    port.domains.ensureLoaded("attachments");
    await flush();

    const patched = useAppStore.getState().refreshMessageAttachments();

    const after = useAppStore.getState().messages;
    expect(patched, "必须补到 1 条").toBe(1);
    expect(after[0].attachments, "附件必须补进来（否则界面永远显示不出附件）").toHaveLength(1);
    expect(after[0].attachments![0].name).toBe("spec.md");
    expect(after[0].attachments![0].mimeType).toBe("text/markdown");
  });

  it("ATT-3: 镜像没接手 ⇒ 保持原样、不抛（不许把已经加载的消息弄坏）", async () => {
    const { createFakeStoragePort } = await import("./fake-storage-port");
    const { setStoragePort } = await import("../core/storage/port");
    const port = createFakeStoragePort({ seed: {}, neverReady: ["attachments"] });
    await port.config.warmup();
    setStoragePort(port);
    port.domains.ensureLoaded("messages");
    port.messages.ensureLoaded(SESSION);
    await new Promise((r) => setTimeout(r, 20));

    const { useAppStore } = await import("../store");
    useAppStore.getState().loadMessages(SESSION);
    const before = useAppStore.getState().messages;

    let patched: number | undefined;
    expect(() => {
      patched = useAppStore.getState().refreshMessageAttachments();
    }, "读不到附件时不许抛（消息本身与附件是两件事）").not.toThrow();
    expect(patched, "没有可补的就报 0，不编造").toBe(0);
    const after = useAppStore.getState().messages;
    expect(after.length, "消息条数不许变").toBe(before.length);
    expect(after.map((m) => m.id), "消息顺序/身份不许变").toEqual(before.map((m) => m.id));
  });

  it("ATT-4: 接线 —— ChatPanel 必须在 attachments 域就绪后补读一次", async () => {
    const src = await vi.importActual<typeof import("fs")>("fs");
    const raw = src.readFileSync("src/components/ChatPanel.tsx", "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    expect(code, "必须挂 attachments 的'就绪后重读'").toContain('useDomainReady("attachments"');
    expect(code, "重读时要真的调补读动作").toContain("refreshMessageAttachments()");
  });

  it("ATT-5: 已经带附件的消息不被无意义替换（同一引用 = 没触发整表重渲染）", async () => {
    await seedMessageWithAttachment();
    const { useAppStore } = await import("../store");
    useAppStore.getState().loadMessages(SESSION);
    useAppStore.getState().refreshMessageAttachments(); // 第一次补上
    const first = useAppStore.getState().messages;

    const patchedAgain = useAppStore.getState().refreshMessageAttachments();
    const second = useAppStore.getState().messages;
    expect(patchedAgain, "已经补过的这条不该被再算一次").toBe(0);
    expect(second[0], "对象引用应当保持不变（否则每补一次都整表重渲染）").toBe(first[0]);
  });
});
