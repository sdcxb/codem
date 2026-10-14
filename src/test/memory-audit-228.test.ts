/**
 * 第 228 波·**审计轮**判据（记忆侧）：四个审计挖出的真缺陷。
 *
 * - `MA-1`：`explicit: true` 必须有**用户原话**才采信（否则仓库文件里的一句话就能绕过审批注入）—— 
 *   已在 `memory-rejection.test.ts::REJ-3b` 钉住（那里有现成的提取夹具）。
 * - `MA-2`：压缩完成触发的提取**必须能强制跑**（水位按可见消息数走，压缩会让它变负）。
 * - `MA-3`：每次提取有**总写入上限**（conversation 级默认免审批 ⇒ 光有"待批准上限"是没有上限的）。
 * - `MA-4`：系统自己顶替掉的 pending 条目**不许留下伪造的"用户拒绝记录"**。
 * - `MA-5`：查重**双向**（项目级候选要能比到本会话的对话级条目，否则用户被问第二次）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const SESSION = "s-228";

function engineFor(svc: MemoryService, payloads: string[], messageCount = 12, userText = "帮我看看这个仓库") {
  setSettingJSON(`memory-enabled-${SESSION}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = svc;
  const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: "[]" }) };
  (engine as unknown as { providers: unknown }).providers = { get: () => provider };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockImplementation(
    () =>
      Array.from({ length: messageCount }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: i % 2 ? "x" : userText,
      })) as never,
  );
  let call = 0;
  const spawn = vi.spyOn(engine, "spawnForked").mockImplementation((async () => {
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return payload;
  }) as never);
  return { engine, spawn };
}

beforeEach(() => {
  saveMemory("");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("MA：记忆审计修复（第 228 波）", () => {
  it("MA-2：压缩完成触发的提取必须能强制跑（限频水位会因压缩变负）", async () => {
    const svc = new MemoryService();
    const { engine, spawn } = engineFor(svc, [JSON.stringify([]), JSON.stringify([])], 12);

    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    expect(spawn.mock.calls.length, "前提：同样条数下第二次被限频挡住").toBe(1);

    /* 压缩钩子走的就是 force 这条路（`onCompactionComplete` → `{ force: true }`） */
    await engine.extractMemoriesFromSession(SESSION, PROJ_A, { force: true });
    expect(
      spawn.mock.calls.length,
      "压缩之后必须能提炼一次（老口径：压缩让可见条数变小 ⇒ 差值变负 ⇒ 这个会话再也不沉淀记忆）",
    ).toBe(2);
  });

  it("MA-3：每次提取有**总写入上限** —— conversation 级与 explicit 都算在内", async () => {
    /*
     * 被守的缺陷：`MEMORY_MAX_PER_EXTRACTION` 只对 `status === "pending"` 计数（那是用户的决策量），
     * 而 conversation 级默认**免审批、直接生效** ⇒ 那条上限对它完全不生效（用户实报过的
     * "一轮写几十条"只被治了一半）。
     */
    const svc = new MemoryService();
    /* 8 条**语义互不相干**的对话级事实（不能靠措辞相似 —— 那样会被查重挡下，测不到上限） */
    const many = [
      { key: "本次先给方案", content: "这次先给方案再改代码，不要直接动文件。", scope: "conversation", explicit: false },
      { key: "不要动测试文件", content: "这次不要修改 test 目录下的任何文件。", scope: "conversation", explicit: false },
      { key: "回答用中文", content: "这次的所有解释都用中文写。", scope: "conversation", explicit: false },
      { key: "别装新依赖", content: "这次不许往 package.json 里添加新的依赖。", scope: "conversation", explicit: false },
      { key: "先跑类型检查", content: "每次改完先跑一次类型检查再继续。", scope: "conversation", explicit: false },
      { key: "提交信息简短", content: "这次的提交信息只要一行，不要写长段落。", scope: "conversation", explicit: false },
      { key: "别动样式文件", content: "这次不要碰 styles.css 里的颜色变量。", scope: "conversation", explicit: false },
      { key: "日志要详实", content: "这次排查问题时把每次命令的完整输出都贴出来。", scope: "conversation", explicit: false },
    ];
    const { engine } = engineFor(svc, [JSON.stringify(many)], 12);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const written = svc.listByScope("conversation", { projectId: PROJ_A, sessionId: SESSION, includePending: true });
    expect(written.length, "总量上限是 4（老口径下这里会写 8 条）").toBe(4);
  });

  it("MA-4：系统自己顶替掉的 pending 条目**不留**伪造的拒绝记录", async () => {
    /*
     * 被守的缺陷：用户说了"记住 X"（explicit 放行）而库里已有一条改写版的 pending X 时，
     * 提取流程会 `removeMany([old])` 顶替它 —— 而 `removeMany` 把"删一条 pending"记成
     * **用户拒绝了它** ⇒ 此后同类候选被"你拒绝过同类"静默挡下，而用户从没拒绝过任何东西。
     */
    const svc = new MemoryService();
    svc.add({
      scope: "project",
      projectId: PROJ_A,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
      status: "pending",
    });
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "前提：库里有一条待批准的同类").toHaveLength(1);

    const { engine } = engineFor(
      svc,
      [
        JSON.stringify([
          {
            key: "vitest 路径参数按子串匹配",
            content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
            scope: "project",
            explicit: true,
          },
        ]),
      ],
      12,
      "记住：vitest 的位置参数是按路径子串匹配的，以后都按这个来。",
    );
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.listRejections(), "系统自删 ≠ 用户拒绝 ⇒ 不许留下拒绝记录").toHaveLength(0);
    expect(
      svc.listByScope("project", { projectId: PROJ_A, includePending: false }).map((e) => e.key),
      "用户明确要求的那条要生效",
    ).toContain("vitest 路径参数按子串匹配");
  });

  it("MA-5：查重**双向** —— 项目级候选要能比到本会话的对话级条目（否则用户被问第二次）", () => {
    const svc = new MemoryService();
    svc.add({
      scope: "conversation",
      sessionId: SESSION,
      key: "Vitest 位置参数匹配语义",
      content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
      source: "auto",
    });

    const dup = svc.findDuplicateOf(
      {
        scope: "project",
        projectId: PROJ_A,
        key: "vitest 路径参数按子串匹配、多参数为 OR",
        content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
      },
      { projectId: PROJ_A, sessionId: SESSION },
    );
    expect(dup, "同一条事实先以对话级生效 ⇒ 项目级候选必须被查重挡下（否则又多一条待批准）").toBeDefined();

    /* 反向对照：**别的**会话的对话级条目不该挡住这个项目的记忆 */
    const other = svc.findDuplicateOf(
      {
        scope: "project",
        projectId: PROJ_A,
        key: "vitest 路径参数按子串匹配、多参数为 OR",
        content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
      },
      { projectId: PROJ_A, sessionId: "另一个会话" },
    );
    expect(other, "跨会话不该连坐").toBeUndefined();
  });

  it("MA-6：压缩钩子确实传了 force（源码级，防止接线被改回去）", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../core/llm/index.ts"),
      "utf8",
    ) as string;
    expect(src, "onCompactionComplete 必须走强制路径").toMatch(
      /onCompactionComplete:[\s\S]{0,400}extractMemoriesFromSession\(sessionId, memoryProjectId, \{ force: true \}\)/,
    );
  });
});
