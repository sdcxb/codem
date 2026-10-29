/**
 * 记忆 `[[key]]` 链接**不许跨作用域展开**（第 233 轮审计 · P1 跨项目泄漏）。
 *
 * ## 缺陷形态
 *
 * `MemoryService.resolveLinks()` 在**全库**里按 key 找第一条目标，只看一条约束
 * （稳定条目只能展开稳定目标，`linkTargetAllowed`）——**完全没有 scope / 归属过滤**：
 *
 * ```ts
 * const target = Array.from(this.entries.values()).find(
 *   e => textOf(e.key).toLowerCase() === linkName.toLowerCase() && this.linkTargetAllowed(entry, e)
 * );
 * ```
 *
 * 于是一个**项目 A** 的条目里写 `[[部署密钥位置]]`（A 自己没有这个 key）时，
 * 只要**项目 B** 有一条同名条目，B 的正文前 100 字符就会被注入 A 的上下文 ——
 * 跨项目、跨会话的信息泄漏；而 `project`/`conversation` 作用域存在的全部意义就是隔离。
 *
 * 同一项目里的链接照旧要展开（反向对照），否则"隔离"就变成了"功能删除"。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MEM-LINK-1 | 项目 A 的条目链到**只在项目 B 存在的 key** ⇒ 不展开（`[[key]]` 原样留着，B 的正文不出现） |
 * | MEM-LINK-2 | 同一项目内的链接照旧展开（反向对照） |
 * | MEM-LINK-3 | `conversation` 作用域同理：别的会话的同名条目不许被展开 |
 *
 * 变异自证：把 `visibleIn(target, ctx)` 从目标筛选里去掉 ⇒ MEM-LINK-1/3 立刻红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import {
  MemoryService,
  MEMORY_VOLATILE_BLOCK_SELECTIONS,
  composeMemoryBlock,
  createMemoryInjectBudgetTracker,
} from "../core/memory/memory";

const PROJ_A = "proj-A";
const PROJ_B = "proj-B";
const SESS_1 = "sess-1";
const SESS_2 = "sess-2";

/** 走产品注入路径（易变块），只注入指定 projectId/sessionId 下可见的条目 */
function injectedFor(svc: MemoryService, projectId: string, sessionId: string): string {
  const budget = createMemoryInjectBudgetTracker();
  return composeMemoryBlock(
    svc,
    MEMORY_VOLATILE_BLOCK_SELECTIONS,
    "## 记忆",
    projectId,
    sessionId,
    budget,
  );
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort({}));
  saveMemory("");
});

describe("记忆链接：作用域隔离", () => {
  it("MEM-LINK-1: 项目 A 的条目链到「只在 B 存在」的 key ⇒ 不展开，B 的正文不出现", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "A 的说明", content: "见 [[部署密钥位置]] 这一条", source: "manual", timestamp: 1000 });
    svc.add({ scope: "project", projectId: PROJ_B, key: "部署密钥位置", content: "B_PROJECT_SECRET_PATH_XYZ", source: "manual", timestamp: 1001 });

    const forA = injectedFor(svc, PROJ_A, SESS_1);
    expect(forA, "A 自己那条要在").toContain("A 的说明");
    expect(forA, "跨项目目标不许被展开（B 的正文不准出现在 A 的上下文里）").not.toContain("B_PROJECT_SECRET_PATH_XYZ");
    expect(forA, "不展开时原样留着 [[key]]（与「目标不存在」同一降级形态）").toContain("[[部署密钥位置]]");

    // 反向对照：在 B 自己的上下文里，那条条目本身当然在（只是它不参与 A 的链接）
    const forB = injectedFor(svc, PROJ_B, SESS_1);
    expect(forB).toContain("B_PROJECT_SECRET_PATH_XYZ");
  });

  it("MEM-LINK-2（反向对照）: 同一项目内的链接照旧展开", () => {
    const svc = new MemoryService();
    svc.add({ scope: "project", projectId: PROJ_A, key: "A 的说明", content: "见 [[部署步骤]]", source: "manual", timestamp: 1000 });
    svc.add({ scope: "project", projectId: PROJ_A, key: "部署步骤", content: "先跑 npm run build 再发版", source: "manual", timestamp: 1001 });

    const forA = injectedFor(svc, PROJ_A, SESS_1);
    expect(forA, "同项目链接必须展开").toContain("先跑 npm run build 再发版");
    expect(forA).not.toContain("[[部署步骤]]");
  });

  it("MEM-LINK-3: 会话作用域同理 —— 别的会话的同名条目不许被展开", () => {
    const svc = new MemoryService();
    svc.add({ scope: "conversation", sessionId: SESS_1, key: "本会话说明", content: "参考 [[临时决定]]", source: "manual", timestamp: 1000 });
    svc.add({ scope: "conversation", sessionId: SESS_2, key: "临时决定", content: "SESS2_ONLY_MARKER", source: "manual", timestamp: 1001 });

    const forS1 = injectedFor(svc, PROJ_A, SESS_1);
    expect(forS1, "别的会话的内容不许被注入").not.toContain("SESS2_ONLY_MARKER");
    expect(forS1).toContain("[[临时决定]]");
  });
});
