/**
 * HANDOFF-NEW：「移交给新对话」必须是**新建会话**，不能投给标题相似的老会话。
 *
 * ## 真机缺陷（2026-10-18 用户直报）
 *
 * 用户在一个很长的对话里说「把这个任务移交给新对话」，结果任务被投进了标题相似的
 * **已有老会话**（「名词解释」还给了「名词解释啊」）。根因有两层：
 * 1. agent 只有 `delegate_to_session(target_session_id)`，**没有新建会话的工具** ⇒ 只能从
 *    `list_sessions` 里挑一条；而标题并不唯一 ⇒ 一挑就错。
 * 2. 横幅交接每次 `createSession("交接会话")` 同名（只靠 `createSession` 的 `· 2` 兜底）⇒
 *    侧栏里一堆近似名字，用户与 agent 都无法区分。
 *
 * 判据：标题唯一化（纯函数）、创建+委派流程（依赖注入，能断言"委派目标就是新会话"）、
 * 工具/提示词/列表的同名告警接线（源码级）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  handoverStamp,
  nextHandoverTitle,
  openHandoverSession,
  HANDOVER_TITLE_ZH,
  HANDOVER_TITLE_EN,
} from "../core/session/handoff-session";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("HANDOFF-NEW 标题唯一化", () => {
  it("HANDOFF-NEW-1: 无冲突时是「基础名 · MM-DD HH:mm」", () => {
    const now = new Date(2026, 9, 18, 10, 30, 0); // 2026-10-18 10:30
    expect(handoverStamp(now)).toBe("10-18 10:30");
    expect(nextHandoverTitle([], true, now)).toBe(`${HANDOVER_TITLE_ZH} · 10-18 10:30`);
    expect(nextHandoverTitle([], false, now)).toBe(`${HANDOVER_TITLE_EN} · 10-18 10:30`);
  });

  it("HANDOFF-NEW-2: 同名时追加 (2)/(3)；连续 50 次交接标题互不相同", () => {
    const now = new Date(2026, 9, 18, 10, 30, 0);
    const base = `${HANDOVER_TITLE_ZH} · 10-18 10:30`;
    expect(nextHandoverTitle([base], true, now)).toBe(`${base} (2)`);
    expect(nextHandoverTitle([base, `${base} (2)`], true, now)).toBe(`${base} (3)`);

    const existing: string[] = [];
    for (let i = 0; i < 50; i++) {
      const title = nextHandoverTitle(existing, true, now);
      expect(existing, `第 ${i + 1} 次生成了重复标题：${title}`).not.toContain(title);
      existing.push(title);
    }
    expect(new Set(existing).size).toBe(50);
  });
});

describe("HANDOFF-NEW 创建新会话并委派", () => {
  it("HANDOFF-NEW-3: 委派目标必须是刚创建的新会话（不是任何已有会话）", async () => {
    const oldIds = ["sess-noun-explain", "sess-noun-explain-2"];
    const created: { id: string; title: string }[] = [];
    const delegated: any[] = [];
    const result = await openHandoverSession({
      zh: true,
      task: "交接正文",
      sourceSessionId: "sess-source",
      projectId: "proj-1",
      existingTitles: ["名词解释", "名词解释啊"],
      createSession: (title) => {
        const s = { id: `sess-new-${created.length + 1}`, title };
        created.push(s);
        return s;
      },
      delegate: async (args) => {
        delegated.push(args);
        return { id: "del-1" };
      },
      now: new Date(2026, 9, 18, 10, 30, 0),
    });

    expect(result.sessionId).toBe("sess-new-1");
    expect(result.title).toContain("交接会话 · 10-18 10:30");
    expect(delegated).toHaveLength(1);
    expect(delegated[0].targetSessionId).toBe("sess-new-1");
    expect(oldIds).not.toContain(delegated[0].targetSessionId);
  });

  it("HANDOFF-NEW-8: 建会话失败会**换名字重试**，成功后委派到新会话", async () => {
    const tried: string[] = [];
    const delegateTargets: string[] = [];
    let calls = 0;
    const result = await openHandoverSession({
      zh: true,
      task: "交接正文",
      sourceSessionId: "sess-source",
      projectId: "",
      existingTitles: ["名词解释"],
      // 前两次失败（模拟同名冲突/存储抖动），第三次成功
      createSession: (title) => {
        calls += 1;
        tried.push(title);
        if (calls < 3) throw new Error("UNIQUE constraint failed: sessions.title");
        return { id: "sess-retry-ok" };
      },
      delegate: async (args) => {
        delegateTargets.push(args.targetSessionId);
        return { id: "del-retry" };
      },
      attempts: 3,
      now: new Date(2026, 9, 18, 10, 30, 0),
    });
    expect(result.sessionId).toBe("sess-retry-ok");
    expect(calls, "必须真的重试").toBe(3);
    expect(new Set(tried).size, `每次重试都要换标题（实际：${tried.join(" / ")}）`).toBe(3);
    expect(delegateTargets).toEqual(["sess-retry-ok"]);
  });

  it("HANDOFF-NEW-9: 同名冲突导致失败时，换标题重试能成功（不占用已有会话）", async () => {
    const taken = new Set<string>(["交接会话 · 10-18 10:30"]);
    const created: string[] = [];
    const result = await openHandoverSession({
      zh: true,
      task: "交接正文",
      sourceSessionId: "s",
      projectId: "",
      existingTitles: [],
      createSession: (title) => {
        if (taken.has(title)) throw new Error("UNIQUE constraint failed: sessions.title");
        taken.add(title);
        created.push(title);
        return { id: `sess-${created.length}` };
      },
      delegate: async () => ({ id: "del-dup" }),
      attempts: 3,
      now: new Date(2026, 9, 18, 10, 30, 0),
    });
    expect(result.title.endsWith("(2)"), `第二次应生成 (2) 标题（实际 ${result.title}）`).toBe(true);
    expect(created, "只应真正建成一个会话").toHaveLength(1);
  });

  it("HANDOFF-NEW-10: 重试次数用尽才报错，且错误写明重试过几个标题", async () => {
    const tried: string[] = [];
    let delegated = false;
    await expect(
      openHandoverSession({
        zh: true,
        task: "交接正文",
        sourceSessionId: "s",
        projectId: "",
        existingTitles: [],
        createSession: (title) => {
          tried.push(title);
          return null;
        },
        delegate: async () => {
          delegated = true;
          return { id: "del-x" };
        },
        attempts: 3,
        now: new Date(2026, 9, 18, 10, 30, 0),
      }),
    ).rejects.toThrow(/重试 3 次/);
    expect(tried, "应当尝试 3 个不同标题").toHaveLength(3);
    expect(new Set(tried).size).toBe(3);
    expect(delegated, "建会话失败时绝不允许退化委派").toBe(false);
  });

  it("HANDOFF-NEW-4: 新建失败时抛错，且绝不退化成委派到已有会话", async () => {
    const delegate = async () => ({ id: "del-should-not-happen" });
    let called = false;
    await expect(
      openHandoverSession({
        zh: true,
        task: "交接正文",
        sourceSessionId: "s",
        projectId: "",
        existingTitles: ["名词解释"],
        createSession: () => null,
        delegate: async (args) => {
          called = true;
          return delegate(args);
        },
      }),
    ).rejects.toThrow(/新建会话失败/);
    expect(called, "新建失败后不许再委派（否则就是投给老会话的旧缺陷）").toBe(false);
  });
});

describe("HANDOFF-NEW 接线", () => {
  it("HANDOFF-NEW-5: 工具存在、注册了、说明里写明「新会话 / 不要挑已有会话」", () => {
    const tools = read("src/core/session/tools.ts");
    expect(tools).toContain("export function createHandoffToNewSessionTool");
    expect(tools).toContain('id: "handoff_to_new_session"');
    expect(tools).toContain("Never pick an existing session by title similarity");
    const engine = read("src/core/llm/index.ts");
    expect(engine, "引擎必须注册这个工具").toContain("createHandoffToNewSessionTool()");
  });

  it("HANDOFF-NEW-6: 提示词有「新会话 vs 已有会话」的路由规则，且点名标题不是身份", () => {
    const prompt = read("src/core/prompt/prompt.ts");
    expect(prompt).toContain("handoff_to_new_session");
    expect(prompt).toContain("Routing: new session vs existing session");
    expect(prompt).toContain("A title is **not** an identity");
    expect(prompt).toContain("Never");
  });

  it("HANDOFF-NEW-7: list_sessions 标出同名会话；横幅交接用唯一标题", () => {
    expect(read("src/core/session/tools.ts")).toContain("⚠同名");
    const banner = read("src/components/WaterLevelBanner.tsx");
    expect(banner).toContain("nextHandoverTitle(existingTitles, zh)");
    expect(banner).not.toContain('createSession(zh ? "交接会话" : "Handover session")');
  });
});
