/**
 * 25 号文 P2：**评测/回放判据**（REPLAY-1..REPLAY-5）。
 *
 * ## 为什么不是「再写一遍期望」
 *
 * 回放脚本（`tools/eval/context-os-replay.mjs`）用 esbuild 把三个产品纯函数当场打包后 import，
 * 所以它跑的是**产品同一份实现**。本文件做两件事：
 * 1. **同一批 JSONL** 再用 TypeScript 产品函数跑一遍 ⇒ 场景期望与产品行为对账
 *    （脚本跑绿不等于产品对：两边都要绿才算）；
 * 2. **真的执行 CI 命令**（`node tools/eval/context-os-replay.mjs --check`）⇒
 *    「命令可用」是判据，不是 README 里的一句话。
 *
 * ## 覆盖（REPLAY-2）
 *
 * 场景文件必须包含：200 轮/3 段、未完成 compact、完成 switch、文档硬闸、
 * 工作集移出 + marker 保护 —— 少了任何一类，回放就退化成"只测了几条边界"。
 *
 * ## 变异自证（REPLAY-5）
 *
 * - 把任一条期望的 action / evictedIds 改错 ⇒ `replayCase` 必须失败（本文件显式构造）；
 * - 改坏产品决策（例如把 `consider` 恒设成 0）⇒ 脚本与产品对账都会红；
 * - 删掉一个场景文件 ⇒ REPLAY-2 红（覆盖清单缺项）。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { decideEpochAction } from "../core/context/segment-switch";
import { judgeDocumentSyncGate } from "../core/llm/document-sync-gate";
import { planWorkingSet } from "../core/context/working-set";
import {
  defaultScenarioFiles,
  loadProductCore,
  readScenarioCases,
  replayCase,
} from "../../tools/eval/context-os-replay.mjs";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "tools", "eval", "context-os-replay.mjs");

/** 与剧本同样形状的 core（产品 TS 实现） */
const core = { decideEpochAction, judgeDocumentSyncGate, planWorkingSet };

interface ScenarioCase {
  id: string;
  kind: string;
  [key: string]: unknown;
}

function allCases(): Array<{ file: string; testCase: ScenarioCase }> {
  const out: Array<{ file: string; testCase: ScenarioCase }> = [];
  for (const file of defaultScenarioFiles()) {
    for (const testCase of readScenarioCases(file) as ScenarioCase[]) {
      out.push({ file: path.basename(file), testCase });
    }
  }
  return out;
}

describe("REPLAY-1/2：场景文件存在且覆盖要求的事实", () => {
  it("三个场景文件、每条都有 id/kind；覆盖 200 轮/3 段/compact/switch/文档硬闸/工作集 marker", () => {
    const cases = allCases();
    expect(defaultScenarioFiles().length, "至少要有 2–3 个场景文件").toBeGreaterThanOrEqual(3);
    expect(cases.length, "场景用例不能为空").toBeGreaterThanOrEqual(10);
    for (const { testCase } of cases) {
      expect(typeof testCase.id, "每条场景必须有 id").toBe("string");
      expect(["epoch", "epoch-sequence", "doc-gate", "working-set"]).toContain(testCase.kind);
    }
    const ids = new Set(cases.map(({ testCase }) => testCase.id));
    for (const required of [
      "epochs-200-turns-3-segments",
      "epoch-mid-turn-consider-compact",
      "epoch-completed-consider-switch",
      "doc-gate-block-changed",
      "working-set-evicts-oldest-keeps-marker",
    ]) {
      expect(ids, `场景必须覆盖 ${required}`).toContain(required);
    }
    const sequence = cases.find(({ testCase }) => testCase.id === "epochs-200-turns-3-segments")!.testCase;
    expect((sequence as { turns: unknown[] }).turns.length, "200 轮场景必须真有 200 轮").toBe(200);
    expect((sequence as { expect: { switches: number } }).expect.switches, "200 轮/3 段").toBe(3);
  });
});

describe("REPLAY-3：同一批场景用产品 TS 函数跑，0 失败", () => {
  it("逐条回放（epoch / epoch-sequence / doc-gate / working-set）", () => {
    const failures: string[] = [];
    for (const { file, testCase } of allCases()) {
      const result = replayCase(core, testCase);
      if (!result.ok) failures.push(`${file} / ${testCase.id}: ${result.diffs.join("；")}`);
    }
    expect(failures, `回放失败：\n${failures.join("\n")}`).toEqual([]);
  });
});

describe("REPLAY-4：CI 命令可用（node tools/eval/context-os-replay.mjs --check）", () => {
  it("退出码 0 且打印全部通过", () => {
    const output = execFileSync(process.execPath, [SCRIPT, "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output, "CI 模式只打印摘要").toContain("回放摘要");
    expect(output).toContain("✅ 全部场景与产品实现一致");
    expect(output, "必须真的跑了 22 条（少于它说明某文件没被读到）").toMatch(/回放摘要：\d+ 通过 \/ 0 失败/);
  }, 60_000);
});

describe("REPLAY-5：回放不是恒真（改错期望必须失败）", () => {
  it("epoch 期望 action 改错 ⇒ FAIL 且差异里同时出现期望/实际", () => {
    const original = allCases().find(({ testCase }) => testCase.id === "epoch-mid-turn-consider-compact")!.testCase;
    const tampered = { ...original, expect: { ...(original as any).expect, action: "switch" } };
    const result = replayCase(core, tampered);
    expect(result.ok, "改错期望必须变红").toBe(false);
    expect(result.diffs.join("\n")).toContain("action");
    expect(result.diffs.join("\n")).toContain("switch");
  });

  it("working-set 期望 evictedIds 改错 ⇒ FAIL（移出集合是判据不是装饰）", () => {
    const original = allCases().find(({ testCase }) => testCase.id === "working-set-evicts-oldest-keeps-marker")!.testCase;
    const tampered = { ...original, expect: { ...(original as any).expect, evictedIds: ["m2", "m4"] } };
    const result = replayCase(core, tampered);
    expect(result.ok).toBe(false);
    expect(result.diffs.join("\n")).toContain("evictedIds");
  });
});

describe("REPLAY-6：脚本打包的是产品实现（与 TS 函数逐点一致）", () => {
  it("esbuild 打包结果与产品 TS 函数对同一输入的输出相同", async () => {
    const bundled = await loadProductCore(ROOT);
    const epochInputs = [
      { pressure: 0.5, turnCompleted: true },
      { pressure: 0.75, turnCompleted: false },
      { pressure: 0.89, turnCompleted: true, consecutiveCompactions: 2 },
      { pressure: 0.61, turnCompleted: true, modelContextWindow: 128_000, observedAvgTurnTokens: 40_000 },
      { pressure: 0.65, turnCompleted: false, modelContextWindow: 24_000 },
    ];
    for (const input of epochInputs) {
      expect(bundled.decideEpochAction(input), JSON.stringify(input)).toEqual(decideEpochAction(input as never));
    }
    const gateInput = {
      codeEdited: true,
      versionedDocuments: 1,
      changedDocuments: [{ documentId: "d1", name: "A.md", updatedAt: 1, sha256: "aa" }],
      unreadableDocuments: [],
      blockedKeys: [],
      blocksIssued: 0,
      maxBlocks: 3,
    };
    expect(bundled.judgeDocumentSyncGate(gateInput)).toEqual(judgeDocumentSyncGate(gateInput as never));

    const messages = [
      { id: "m1", role: "user", content: "a", tokens: 10 },
      { id: "m2", role: "assistant", content: "b", tokens: 10 },
      { id: "compact-1", role: "user", content: "摘要", tokens: 10 },
      { id: "m4", role: "user", content: "c", tokens: 10 },
    ];
    const wsInput = { messages, budgetTokens: 25, estimate: (message: { tokens: number }) => message.tokens, keepRecent: 1, protectedIds: new Set(["compact-1"]) };
    expect(bundled.planWorkingSet(wsInput)).toEqual(planWorkingSet(wsInput as never));
  });
});
