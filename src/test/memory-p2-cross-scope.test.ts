/**
 * P2-A / P2-C：**跨会话 / 跨项目检索**（显式 opt-in）与独立表 FTS 镜像的读路径。
 *
 * ## 被守的缺陷（24 §P2）
 *
 * 记忆的默认检索只能看"当前位置"（platform + 当前项目 + 当前对话）—— 这是对的，
 * 但"上周在另一个项目里定过的那条约定"因此永远取不回来。跨作用域检索必须**显式 opt-in**，
 * 而一旦放宽就多出一条泄漏面：只要过滤条件漏掉一个维度，项目 A 的查询就会带出项目 B 的正文。
 *
 * 这一组判据钉住：
 * 1. **默认不跨**（`scopeMode` 缺省 = current，行为与改前逐字一致）；
 * 2. `all` + `projectId` 只返回 platform + 该项目，**绝不泄漏**别的项目；
 * 3. `all` + `sessionId` 只返回 platform + 该对话（project 作用域整体不参与 —— 否则就是没过滤）；
 * 4. `all` **没有过滤条件 ⇒ 拒绝**（不是返回空数组；"被拒绝"与"范围内没有"必须分得开）；
 * 5. `all` 的结果行**自带 scope 与归属键**（否则跨项目命中无法判断"这是谁家的约定"）；
 * 6. 审计日志只记范围与条数，**不含查询词与正文**；
 * 7. 取数优先走引擎 `memories.search`（FTS 镜像），镜像缺失/失败时**回退 settings 扫描**；
 * 8. 镜像写入发生在记忆保存成功路径，且**失败不阻断**（记忆已保存；只走 advisory 上报）。
 *
 * 变异自证（本文件对应的一半）：
 * - 把 `searchAcrossScopes` 的 `projectId` 过滤去掉 ⇒ 第 2 条红（项目 B 的条目出现）；
 * - 把"没有过滤条件 ⇒ 抛错"改成返回空数组 ⇒ 第 4 条红；
 * - 把 FTS 失败时的回退删掉 ⇒ 第 7 条红（镜像失败 ⇒ 检索直接报错/空）；
 * - 把镜像失败改成抛给调用方 ⇒ 第 8 条红（`flushPendingPersist`/`add` 返回 false）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getMemoryService, MemoryService } from "../core/memory/memory";
import { createMemorySearchTool } from "../core/llm/tools/memory-tools";

const PROJ_A = "c:\\work\\alpha";
const PROJ_B = "c:\\work\\beta";
const SESSION = "s-p2-cross";
const OTHER_SESSION = "s-p2-cross-other";

function toolCtx(cwd: string = PROJ_A, sessionId: string = SESSION) {
  return {
    sessionId,
    messageId: "m1",
    cwd,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

/** 造一份"已经落库的记忆 payload"（`MemoryService` 从 settings 的 `memory` 字段读它） */
function memoryPayload(entries: Array<Record<string, unknown>>): string {
  const byId: Record<string, unknown> = {};
  for (const entry of entries) byId[String(entry.id)] = entry;
  return JSON.stringify({ version: 2, entries: byId });
}

function baseEntry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    scope: "platform",
    key: "k",
    content: "c",
    source: "manual",
    status: "active",
    timestamp: 1,
    ...overrides,
  };
}

let port: FakeStoragePort;

describe("P2-A：跨会话 / 跨项目检索（显式 opt-in）", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    port = createFakeStoragePort();
    setStoragePort(port);
    const svc = getMemoryService();
    await svc.reload();
    // 两个项目各一条 + 一条平台级 + 两个会话各一条对话级
    svc.add({ scope: "project", projectId: PROJ_A, key: "alpha 的构建约定", content: "alpha 项目跑 build-a", source: "manual" });
    svc.add({ scope: "project", projectId: PROJ_B, key: "beta 的构建约定", content: "beta 项目跑 build-b（不许泄漏）", source: "manual" });
    svc.add({ scope: "platform", key: "全局偏好", content: "回答一律用中文（这是全局约定）", source: "manual" });
    svc.add({ scope: "conversation", sessionId: SESSION, key: "本会话约定", content: "本会话用 build-current", source: "manual" });
    svc.add({ scope: "conversation", sessionId: OTHER_SESSION, key: "另一个会话约定", content: "另一个会话用 build-other", source: "manual" });
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("P2-A-1: 默认（不传 scopeMode）只查当前位置 —— 别的项目/别的对话搜不到", async () => {
    const res = (await createMemorySearchTool().execute({ query: "构建约定" }, toolCtx())) as never as {
      output: string;
      isError: boolean;
      value: { scopeMode: string; backend: string };
    };
    expect(res.isError).toBe(false);
    expect(res.output, "本项目的条目必须命中").toContain("alpha 的构建约定");
    expect(res.output, "别的项目的条目不许出现").not.toContain("beta 的构建约定");
    expect(res.value.scopeMode, "默认必须是 current（不传参数不许变成 all）").toBe("current");
    expect(res.value.backend).toBe("current");
  });

  it("P2-A-2: scopeMode=all + projectId 只返回 platform + 该项目（跨项目不泄漏）", async () => {
    const res = (await createMemorySearchTool().execute(
      { query: "约定", scopeMode: "all", projectId: PROJ_A },
      toolCtx(),
    )) as never as { output: string; isError: boolean; value: { ids: string[]; backend: string; scopeMode: string; projectId: string } };
    expect(res.isError).toBe(false);
    expect(res.output).toContain("alpha 的构建约定");
    expect(res.output, "projectId=alpha 时 beta 的条目绝不许出现").not.toContain("beta 的构建约定");
    expect(res.output, "platform 条目恒在（与指定项目取并集）").toContain("全局偏好");
    expect(res.value.scopeMode).toBe("all");
    expect(res.value.projectId, "结果要回显请求的过滤键").toBe(PROJ_A);
    expect(["fts", "settings"], "后端只可能是镜像或设置扫描").toContain(res.value.backend);
  });

  it("P2-A-3: scopeMode=all 缺过滤条件 ⇒ 拒绝（不是返回空结果）", async () => {
    const res = (await createMemorySearchTool().execute(
      { query: "构建约定", scopeMode: "all" },
      toolCtx(),
    )) as never as { output: string; isError: boolean };
    expect(res.isError, "缺过滤必须报错").toBe(true);
    expect(res.output).toContain("projectId");
    expect(res.output).toContain("sessionId");
    expect(res.output, "不许把拒绝伪装成「没有结果」").not.toContain("No memories matched");
  });

  it("P2-A-4: 非法 scopeMode / current 下传过滤键 ⇒ 都拒绝（不静默降级）", async () => {
    const bad = (await createMemorySearchTool().execute(
      { query: "构建约定", scopeMode: "everything" },
      toolCtx(),
    )) as never as { isError: boolean; output: string };
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("scopeMode");

    const mixed = (await createMemorySearchTool().execute(
      { query: "构建约定", projectId: PROJ_B },
      toolCtx(),
    )) as never as { isError: boolean; output: string };
    expect(mixed.isError, "current 下传 projectId 会让调用方误以为过滤生效").toBe(true);
    expect(mixed.output).toContain("scopeMode");
    expect(mixed.output).toContain("all");
  });

  it("P2-A-5: scopeMode=all + sessionId 只返回 platform + 该对话（project 作用域整体不参与）", async () => {
    const other = (await createMemorySearchTool().execute(
      { query: "会话用 build", scopeMode: "all", sessionId: OTHER_SESSION },
      toolCtx(),
    )) as never as { output: string; isError: boolean };
    expect(other.isError).toBe(false);
    expect(other.output, "指定会话的条目必须可见").toContain("另一个会话约定");
    expect(other.output, "没有项目过滤 ⇒ 项目作用域的行不许出现").not.toContain("alpha 的构建约定");
    expect(other.output, "也不许出现本项目会话的条目（scope 过滤只认指定会话）").not.toContain("本会话约定");

    const both = (await createMemorySearchTool().execute(
      { query: "build", scopeMode: "all", projectId: PROJ_A, sessionId: SESSION },
      toolCtx(),
    )) as never as { output: string };
    expect(both.output).toContain("alpha 的构建约定");
    expect(both.output).toContain("本会话约定");
    expect(both.output, "两个过滤都给了也不许带出 beta").not.toContain("beta 的构建约定");
  });

  it("P2-A-6: 结果行自带 scope 与归属键（跨项目命中必须能看出是谁家的约定）", async () => {
    const res = (await createMemorySearchTool().execute(
      { query: "约定", scopeMode: "all", projectId: PROJ_A },
      toolCtx(),
    )) as never as { output: string };
    expect(res.output, "项目级命中必须写明 projectId").toContain(`(project · project=${PROJ_A})`);
    const platformLine = res.output.split("\n").find((line) => line.includes("全局偏好"));
    expect(platformLine, "前提：platform 条目也在结果里").toBeTruthy();
    expect(platformLine, "平台级条目没有归属键，不许编造一个").not.toContain("project=");
  });

  it("P2-A-7: 审计日志记录跨作用域查询，但不含查询词与正文", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await createMemorySearchTool().execute({ query: "构建约定", scopeMode: "all", projectId: PROJ_A }, toolCtx());

    const logged = info.mock.calls.map((c) => c.map((x) => String(x)).join(" ")).join("\n");
    expect(logged, "必须有跨作用域检索的审计行").toContain("cross-scope search");
    expect(logged, "必须记下作用域（可审计）").toContain("projectId");
    expect(logged, "必须记下命中数（可审计）").toContain('"hits":1');
    expect(logged, "查询词不许进日志").not.toContain("构建约定");
    expect(logged, "正文不许进日志").not.toContain("build-a");
    expect(logged, "别的项目的正文更不许进日志").not.toContain("build-b");
  });
});

describe("P2-C：FTS 镜像读路径（优先镜像 / 缺失与失败回退 settings）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("P2-C-1: 记忆保存成功路径会后台镜像（memories.replace_all 带全部条目）", async () => {
    port = createFakeStoragePort();
    setStoragePort(port);
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: "镜像约定", content: "镜像里要有这条", source: "manual" });
    expect(added.ok).toBe(true);
    await svc.flushPendingPersist();

    const mirror = port.__writes().find((w) => w.command === "memories.replace_all");
    expect(mirror, "保存成功后必须发一次 memories.replace_all").toBeTruthy();
    const rows = (mirror!.params as { memories?: Array<{ id?: string }> } | undefined)?.memories ?? [];
    expect(rows.map((r) => r.id)).toContain(added.entry!.id);
  });

  it("P2-C-2: 镜像命中 ⇒ 走镜像（backend=fts），并回到权威条目上核对（陈旧行丢弃）", async () => {
    const payload = memoryPayload([
      baseEntry({ id: "auth-1", scope: "project", projectId: PROJ_A, key: "镜像命中约定", content: "权威里还在" }),
    ]);
    /*
     * 造"镜像比权威新"的形态：`ghost-1` 只存在于镜像表（settings 里没有）——
     * 检索命中它时必须丢弃（否则会显示一条已经不存在的记忆）。
     */
    port = createFakeStoragePort({
      seed: {
        memory: [{ id: "default", content: payload }],
        memories: [
          { id: "auth-1", scope: "project", project_id: PROJ_A, key: "镜像命中约定", content: "权威里还在", archived: 0, status: "active", updated_at: 1 },
          { id: "ghost-1", scope: "project", project_id: PROJ_A, key: "镜像命中约定", content: "幽灵行", archived: 0, status: "active", updated_at: 1 },
        ],
      },
    });
    setStoragePort(port);
    const svc = new MemoryService();

    const out = await svc.searchAcrossScopes("镜像命中约定", { projectId: PROJ_A }, { limit: 10 });
    expect(out.backend, "镜像里真有候选 ⇒ 必须走 fts").toBe("fts");
    expect(out.results.map((r) => r.entry.id)).toEqual(["auth-1"]);
    expect(out.results.map((r) => r.entry.id), "权威里没有的 id 必须丢弃").not.toContain("ghost-1");
  });

  it("P2-C-3: 镜像缺失（升级后还没镜像过）⇒ 回退 settings 扫描，结果照旧可用", async () => {
    const payload = memoryPayload([
      baseEntry({ id: "mirrorless-1", scope: "project", projectId: PROJ_B, key: "beta 的历史约定", content: "升级前写入的，镜像里没有" }),
    ]);
    port = createFakeStoragePort({ seed: { memory: [{ id: "default", content: payload }] } });
    setStoragePort(port);
    const svc = new MemoryService();
    // `listAll()` 不带归属 ⇒ 项目级条目不可见（fail-closed 的既有口径）；这里给上 projectId
    expect(svc.listAll({ projectId: PROJ_B }).length, "前提：条目从 settings 读进来了").toBe(1);

    const out = await svc.searchAcrossScopes("历史约定", { projectId: PROJ_B }, { limit: 10 });
    expect(out.backend, "镜像为空 ⇒ 必须回退设置扫描").toBe("settings");
    expect(out.results.map((r) => r.entry.id)).toEqual(["mirrorless-1"]);
  });

  it("P2-C-4: 镜像检索失败（引擎报错）⇒ 同样回退 settings 扫描，不把检索判死", async () => {
    const payload = memoryPayload([
      baseEntry({ id: "fallback-1", scope: "platform", key: "平台偏好", content: "镜像挂了也要能搜到" }),
    ]);
    port = createFakeStoragePort({
      seed: { memory: [{ id: "default", content: payload }] },
      failCommands: ["memories.search"],
    });
    setStoragePort(port);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new MemoryService();

    const out = await svc.searchAcrossScopes("平台偏好", { projectId: PROJ_A }, { limit: 10 });
    expect(out.backend).toBe("settings");
    expect(out.results.map((r) => r.entry.id)).toEqual(["fallback-1"]);
    expect(
      warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n"),
      "回退必须有日志（否则「镜像坏了」这件事没人知道）",
    ).toContain("回退");
  });

  it("P2-C-5: 镜像写入失败**不阻断**记忆保存，并走 advisory 如实上报", async () => {
    port = createFakeStoragePort({ failCommands: ["memories.replace_all"] });
    setStoragePort(port);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = new MemoryService();

    const added = svc.add({ scope: "platform", key: "镜像失败也保存", content: "记忆本身必须落库", source: "manual" });
    expect(added.ok, "镜像失败不许让 add 失败").toBe(true);
    const flushed = await svc.flushPendingPersist();
    expect(flushed, "镜像失败不许污染记忆的落库结果").toBe(true);
    expect(svc.getLastPersistError(), "镜像失败不是记忆保存失败").toBeNull();
    // 记忆本身确实写进 settings 了（这才是"不阻断"的正面证据）
    expect(port.__writes().some((w) => w.command === "memory.set")).toBe(true);

    const logged = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged, "镜像失败必须上报（advisory）").toContain("[Advisory] memory.mirror");
    expect(logged, "上报文案要说明记忆本身已保存").toContain("记忆本身已保存");
  });
});
