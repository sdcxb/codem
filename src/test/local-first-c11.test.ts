/**
 * C11「本地优先、多模型」判据（营销 P1）。
 *
 * ## 被守的承诺（`docs/marketing/CONTEXT-OS-ACCEPTANCE.md` C11）
 *
 * 「会话/文档/记忆默认留在本机；模型可替换。本地存储是权威；切换 provider/model 不破坏 thread；
 *  敏感数据边界可配置；无强制云端依赖。」
 *
 * ## 四条判据（每条都能因实现坏而变红）
 *
 * - **C11-1 本地存储是权威**：消息与记忆**真的写进了本机存储端口**（不是只活在内存/缓存里），
 *   且**缓存被清空后仍然读得回来**；这两个方向缺一，所谓"本地权威"就只是"本地缓存"；
 * - **C11-2 切换 provider/model 不破坏 thread**：`LLMEngine.updateConfig`（真机切换路径的唯一
 *   落点）改了 provider/model 之后，`listTimelineMessages` 逐条不变，并且能继续往**同一个
 *   session** 追加消息；换一个引擎实例（≈重启/重连）也一样；
 * - **C11-3 敏感数据边界可配置**：记忆的模型出口默认脱敏；显式关掉后按原样返回；设置值是
 *   坏值时回到**严格**那一侧（不是静默放宽）；
 * - **C11-4 无强制云端依赖**：会话/记忆/设置在**完全没有任何 provider** 的情况下全链路可用，
 *   且这些模块里**没有**网络调用（模型 API 是唯一允许的外部调用，它在 `core/llm/provider.ts`）。
 *
 * ⚠️ 本文件的注释里中文引号一律「」，与仓库纪律一致。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getSetting, loadMemory, saveMemory, setSetting } from "../core/storage/settings";
import {
  clearSessionLogCache,
  createMessage,
  getMessage,
  listTimelineMessages,
} from "../core/storage/message";
import { getMemoryService } from "../core/memory/memory";
import { createMemoryReadTool } from "../core/llm/tools/memory-tools";
import { LLMEngine } from "../core/llm/index";
import {
  MEMORY_EGRESS_REDACT_KEY,
  isMemoryEgressRedactionEnabled,
  setMemoryEgressRedactionEnabled,
} from "../core/privacy/egress";

const PROJ = "c:\\work\\gamma";
const SESSION = "s-c11-thread";
const SECRET = "sk-abcdefghijklmnopqrstuvwx";

const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

function seedPort() {
  const port = createFakeStoragePort({
    seed: {
      sessions: [{ id: SESSION, project_id: PROJ, title: "线程", created_at: 0, last_message_at: 0, message_count: 0 }],
    },
  });
  setStoragePort(port);
  return port;
}

function appendMessages(ids: string[]): void {
  ids.forEach((id, i) => {
    createMessage(
      { id, role: i % 2 === 0 ? "user" : "assistant", content: `第 ${i + 1} 轮内容`, timestamp: i + 1, status: "done" } as never,
      SESSION,
    );
  });
}

function toolCtx() {
  return {
    sessionId: SESSION,
    messageId: "m1",
    cwd: PROJ,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

describe("C11 本地优先、多模型", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    /*
     * 单测里没有 Tauri 文件层 ⇒ 会话 JSONL 权威日志写不进去（真机才有）。
     * 这里把那条 PersistFailure 也静音：判据断言的是**本机存储端口**上的副本，
     * 不是"文件层可用"（那件事只能真机验证，见报告里的边界说明）。
     */
    vi.spyOn(console, "error").mockImplementation(() => {});
    saveMemory("");
    seedPort();
    // 记忆服务是单例：换端口后必须重读，否则拿到的是上一个用例的库
    const svc = getMemoryService();
    await svc.reload();
    clearSessionLogCache(SESSION);
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("C11-1：会话与记忆的权威副本在本机存储端口里（清掉缓存仍读得回来）", async () => {
    const port = seedPort();
    const svc = getMemoryService();
    await svc.reload();
    appendMessages(["c11-m1", "c11-m2"]);

    // ① 消息真的落到了本机存储（不是只在 message.ts 的内存镜像里）
    const rows = port.__table("messages").filter((r) => r.session_id === SESSION);
    expect(rows.map((r) => r.id).sort(), "消息必须写进本机表").toEqual(["c11-m1", "c11-m2"]);

    // ② 缓存清空后仍然读得回来 ⇒ 权威在存储，不在缓存
    clearSessionLogCache(SESSION);
    const timeline = listTimelineMessages(SESSION).map((m) => m.id);
    expect(timeline, "清缓存后时间线仍完整").toEqual(["c11-m1", "c11-m2"]);

    // ③ 记忆同样以本机 payload 为权威：写入 → 内存清空（reload）→ 仍在
    const added = svc.add({ scope: "project", projectId: PROJ, source: "manual", key: "本地权威", content: "这条必须留在本机" });
    expect(added.ok).toBe(true);
    const id = added.entry?.id as string;
    expect(await svc.saveConfirmed(), "确认式写入必须落库").toBe(true);
    expect(loadMemory(), "记忆 payload 必须落在本机记忆域").toContain("这条必须留在本机");
    await svc.reload();
    expect(svc.get(id)?.content, "重读后仍在 = 本机存储是权威").toBe("这条必须留在本机");
  });

  it("C11-2：切换 provider/model 不破坏 thread（时间线完整且能继续同一会话）", () => {
    appendMessages(["t1", "t2", "t3"]);
    expect(listTimelineMessages(SESSION).map((m) => m.id)).toEqual(["t1", "t2", "t3"]);

    const engine = new LLMEngine();
    engine.updateConfig({ defaultProvider: "provider-b", defaultModel: "model-b" });
    // 先证明"切换真的发生了"——否则下面的断言会因为 updateConfig 是空操作而假绿
    expect(engine.getDefaultProvider()).toBe("provider-b");
    expect(engine.getDefaultModel()).toBe("model-b");

    expect(listTimelineMessages(SESSION).map((m) => m.id), "切 provider 不许动时间线").toEqual(["t1", "t2", "t3"]);

    // 换引擎实例（≈ 重启 / 换 provider 后重建管线）：thread 仍在
    const restarted = new LLMEngine();
    restarted.updateConfig({ defaultProvider: "provider-c", defaultModel: "model-c" });
    expect(listTimelineMessages(SESSION).map((m) => m.id), "重启后时间线仍完整").toEqual(["t1", "t2", "t3"]);

    // 能继续同一会话（不是"新开一个 session"）
    createMessage({ id: "t4", role: "user", content: "切换后继续", timestamp: 99, status: "done" } as never, SESSION);
    const after = listTimelineMessages(SESSION).map((m) => m.id);
    expect(after, "同一 session 可以继续追加").toEqual(["t1", "t2", "t3", "t4"]);
    expect(getMessage("t4")?.content).toBe("切换后继续");
  });

  it("C11-3：敏感边界可配置（记忆出口默认脱敏；显式关闭后原样返回；坏值回到严格侧）", async () => {
    // 直接写 payload：绕开写入侧脱敏，模拟"脱敏上线前的老库存"（这正是开关要处理的形态）
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "mem-secret": {
            id: "mem-secret",
            scope: "project",
            projectId: PROJ,
            key: "数据库连接",
            content: `连接串令牌 ${SECRET} 只在本机`,
            timestamp: 1,
            source: "manual",
          },
        },
      }),
    );
    const svc = getMemoryService();
    await svc.reload();

    // 默认：脱敏开（严格侧）
    expect(isMemoryEgressRedactionEnabled(), "默认必须是开").toBe(true);
    const prompt = svc.buildMemoryPrompt("project", PROJ, SESSION);
    expect(prompt, "默认注入不许出现明文令牌").not.toContain(SECRET);
    expect(prompt, "必须给脱敏占位符（不是悄悄删掉）").toContain("[REDACTED_API_KEY]");

    const read = createMemoryReadTool();
    const masked = await read.execute({ id: "mem-secret" }, toolCtx());
    expect(masked.output, "memory_read 默认也不许出现明文令牌").not.toContain(SECRET);

    // 显式关闭：按用户选择的边界原样返回（开关真的接了线，不只是写了个设置）
    expect(setMemoryEgressRedactionEnabled(false), "开关必须真的写成").toBe(true);
    expect(isMemoryEgressRedactionEnabled()).toBe(false);
    const rawPrompt = svc.buildMemoryPrompt("project", PROJ, SESSION);
    expect(rawPrompt, "关闭后必须原样返回（否则这个开关是假的）").toContain(SECRET);
    const rawRead = await read.execute({ id: "mem-secret" }, toolCtx());
    expect(rawRead.output, "读取路径同一条边界").toContain(SECRET);

    // 坏值（不是 on/off）⇒ 回到严格侧，不许静默放宽
    setSetting(MEMORY_EGRESS_REDACT_KEY, "maybe");
    expect(isMemoryEgressRedactionEnabled(), "坏值必须回到默认（开）").toBe(true);
    expect(svc.buildMemoryPrompt("project", PROJ, SESSION)).not.toContain(SECRET);
  });

  it("C11-4：无强制云端依赖（没有任何 provider 也能读写本机数据；本地模块里没有网络调用）", async () => {
    // ① 完全未配置 provider 的形态：会话 / 记忆 / 设置全链路可用
    expect(getSetting("codem-settings"), "初始就是空的（没有任何 provider）").toBeNull();
    appendMessages(["offline-1"]);
    expect(listTimelineMessages(SESSION).map((m) => m.id)).toEqual(["offline-1"]);

    const svc = getMemoryService();
    await svc.reload();
    const added = svc.add({ scope: "project", projectId: PROJ, source: "manual", key: "离线记忆", content: "不联网也能记" });
    expect(added.ok).toBe(true);
    expect(svc.search("离线", undefined, 10, { projectId: PROJ, sessionId: SESSION }, { onlyInjected: true }).length).toBe(1);

    setSetting("local-only-probe", "ok");
    expect(getSetting("local-only-probe")).toBe("ok");

    // ② 静态：这些模块里**不许**有网络调用（模型 API 是唯一允许的外部调用，且它不在这些文件里）
    const localModules = [
      "../core/storage/session.ts",
      "../core/storage/message.ts",
      "../core/storage/settings.ts",
      "../core/settings/settings.ts",
      "../core/memory/memory.ts",
    ];
    for (const rel of localModules) {
      const text = src(rel);
      expect(text, `${rel} 不许发起网络请求（本地优先）`).not.toMatch(/\bfetch\s*\(/);
      expect(text, `${rel} 不许用 XMLHttpRequest`).not.toContain("XMLHttpRequest");
      expect(text, `${rel} 不许用 sendBeacon`).not.toContain("sendBeacon");
    }

    // ③ 文档目录同样本地（不修改它，只做静态断言）
    const documentDir = path.resolve(__dirname, "../core/document");
    const documentModules = ["ocr.ts", "library.ts", "store.ts"];
    for (const name of documentModules) {
      let text: string;
      try {
        text = readFileSync(path.join(documentDir, name), "utf8");
      } catch {
        continue; // 文件不存在 = 没有这条证据，跳过（不假装验证过）
      }
      expect(text, `${name} 不许发起网络请求（文档默认留在本机）`).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
