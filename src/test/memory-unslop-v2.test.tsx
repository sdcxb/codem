/**
 * design/unslop-v2 · 记忆面板「层级收敛」判据。
 *
 * 被守的形态（本轮之前）：
 * - 顶部一口气摆 8 个数字（总计/平台/项目/团队/对话/待批准/旧版/体积），
 *   用户要先读 8 个数才知道"现在该做什么"；
 * - 自动提取批次把 `batch-...` 这种 opaque id 放在**主文本**位置，
 *   时间与条数反而退到次级；
 * - 写入审批 / 旧批次 / 超预算三段长说明默认全展开，把操作按钮挤下去。
 *
 * 本轮约定（只改层级，不改数据口径/审批/撤销逻辑）：
 * - 主指标 3 个：待批准、已生效（= 总计 − 待批准）、体积；其余原值进「详情」一行 mono；
 * - 批次主文本 = `批次 · 时间 · N 条`，完整 id 留在 title（不再把 opaque id 印成正文）；
 * - 长说明收敛成 1–2 行摘要 +「如何写入 / 批次说明」折叠；关键规则与警告仍在 DOM 里。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";

const PROJ = "proj-unslop-v2";
const SESSION = "sess-unslop-v2";

let svc: MemoryService;
let port: FakeStoragePort;
let batchId = "";

function seed(): MemoryService {
  const service = new MemoryService();
  // 批次必须走真实的 `beginBatch / finalizeBatch` 路径（`add` 本身不登记批次）
  batchId = service.beginBatch(SESSION, "project");
  // 两条同批待批准 ⇒ 「本批」与批次列表各出现一次
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "待批约定一",
    content: "等待批准的第一条自动记忆内容（足够长以便入库）。",
    source: "auto",
    status: "pending",
    batchId,
  });
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "待批约定二",
    content: "等待批准的第二条自动记忆内容（足够长以便入库）。",
    source: "auto",
    status: "pending",
    batchId,
  });
  service.finalizeBatch(batchId, 2);
  // 一条已生效（手动）⇒ 已生效 = 总计 3 − 待批准 2 = 1
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "已生效约定",
    content: "已批准、参与上下文的手动记忆。",
    source: "manual",
  });
  return service;
}

async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(
    createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: true }));
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  svc = seed();
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("MEMORY-UNSLOP：3 个主指标 + 详情 + 批次主文本", () => {
  it("MU-1：顶部主指标只剩待批准/已生效/体积，数字都来自现有 stats（不造数）", async () => {
    const container = await renderPanel();
    const primary = container.querySelector(".memory-stats--primary");
    expect(primary, "顶部主指标容器应存在").toBeTruthy();

    const labels = Array.from(primary!.querySelectorAll(".memory-stat-label")).map((el) => el.textContent);
    expect(labels, "主指标必须收敛成 3 个，且顺序为 待批准 → 已生效 → 体积").toEqual(["待批准", "已生效", "体积"]);

    const valueOf = (label: string): string | null => {
      for (const stat of Array.from(primary!.querySelectorAll(".memory-stat"))) {
        if (stat.querySelector(".memory-stat-label")?.textContent === label) {
          return stat.querySelector(".memory-stat-value")?.textContent ?? null;
        }
      }
      return null;
    };
    expect(valueOf("待批准"), "待批准来自 stats.pendingEntries").toBe("2");
    expect(valueOf("已生效"), "已生效 = 总计 3 − 待批准 2").toBe("1");
    expect(valueOf("体积"), "体积来自 getByteStats()").toBeTruthy();
  });

  it("MU-2：其余计数（总计/平台/项目/团队/对话/归档/旧版/其它）仍在「详情」里，默认收起", async () => {
    const container = await renderPanel();
    const details = container.querySelector<HTMLDetailsElement>("details.memory-stat-details");
    expect(details, "其余计数不能删掉，只能收进「详情」").toBeTruthy();
    expect(details!.open, "详情默认收起（层级收敛的目标）").toBe(false);
    expect(details!.querySelector("summary")?.textContent).toBe("详情");

    const line = details!.querySelector(".memory-stat-detail-line");
    expect(line, "详情应是一行 mono 读数").toBeTruthy();
    for (const fact of [
      "总计 3",
      "平台 0",
      "项目 3",
      "团队 0",
      "对话 0",
      "已归档 0",
      "旧版 0",
      "其它 0",
    ]) {
      expect(line!.textContent, `详情应保留真实计数：${fact}`).toContain(fact);
    }
  });

  it("MU-3：批次主文本是「批次 · 时间 · N 条」，opaque id 只做 title（撤销仍在）", async () => {
    const container = await renderPanel();
    const item = container.querySelector(".memory-batch-item");
    expect(item, "有批次时应渲染批次条").toBeTruthy();

    const summary = item!.querySelector(".memory-batch-summary");
    expect(summary, "主文本应有独立语义 class").toBeTruthy();
    expect(summary!.textContent, "主文本以「批次」开头").toMatch(/^批次 · /);
    expect(summary!.textContent, "主文本保留条数").toContain("2 条");
    expect(summary!.textContent, "opaque id 不许再占主文本").not.toContain(batchId);

    expect(item!.getAttribute("title"), "整条批次用 title 给出完整 id，供核对").toBe(batchId);

    expect(item!.querySelector(".memory-undo-btn"), "撤销行为必须保留").toBeTruthy();
  });

  it("MU-4：长说明收敛为摘要 +「如何写入」折叠，规则事实仍在", async () => {
    const container = await renderPanel();
    const hint = Array.from(container.querySelectorAll<HTMLElement>(".memory-pending-hint")).find(
      (el) => (el.textContent ?? "").includes("自动记忆"),
    );
    expect(hint, "写入审批说明仍在").toBeTruthy();
    expect(hint!.textContent, "摘要要保留待批准条数与「不进上下文」").toContain("有 2 条自动记忆等待批准");
    expect(hint!.textContent, "摘要要保留手动条目不受影响").toContain("手动条目不受影响");

    const guide = hint!.querySelector<HTMLDetailsElement>("details.memory-write-guide");
    expect(guide, "长说明收进「如何写入」").toBeTruthy();
    expect(guide!.open, "默认收起").toBe(false);
    expect(guide!.querySelector("summary")?.textContent).toBe("如何写入");
    expect(guide!.textContent, "规则事实不能删").toContain("未批准的自动记忆不进上下文");
    expect(guide!.textContent, "规则事实不能删").toContain("对话级默认直接生效");
    expect(guide!.textContent, "规则事实不能删").toContain("手动条目永不被自动流程改写");
    expect(guide!.textContent, "批处理能力要保留说明").toContain("批量处置（含全选）");
  });
});
