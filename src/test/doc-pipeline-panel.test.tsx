/**
 * C07 边界②：**产品可见入口**（`ContextMonitor` 的「文档编译」只读区）。
 *
 * ## 被修的形态
 *
 * `doc_compile` 的阶段机、产物 digest、diff 摘要都实现了，但全仓只有工具和判据在读 ——
 * 用户界面上**没有任何地方**能回答「这份长文档编译到哪一步、产出了几份、最近改了多少」。
 * 判据再绿，这条能力对用户也不存在。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | DP-UI-1 | 有持久化状态（这里刻意先清内存，只留设置键）⇒ 渲染阶段 ✓/…、产物数、最近 diff 摘要 |
 * | DP-UI-2 | 没有状态 ⇒ 明确空态，不渲染假行、不抛错 |
 *
 * 变红方式（变异）：把组件里的阶段列表写死（例如恒渲染 7 个 ✓）⇒ DP-UI-1 的
 * 「merge …」「产物 2 个」两条断言红；删掉空态分支 ⇒ DP-UI-2 红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ContextMonitor } from "../components/ContextMonitor";
import {
  runDocumentPipelineStage,
  startDocumentPipeline,
  submitDocumentSection,
} from "../core/document/pipeline";
import {
  __resetDocumentPipelinesForTests,
  flushDocumentPipelinePersistence,
} from "../core/document/test-seams";

const SESSION = "c07-panel";
const CITATION = "[file: 报告.docx | page: 1 | §1 总则 | chunk: doc_1#1]";

function plan(documentId: string, title: string) {
  return startDocumentPipeline({
    sessionId: SESSION,
    documentId,
    title,
    outline: [
      { heading: "1 总则", page: 1 },
      { heading: "2 步骤", page: 2 },
    ],
  });
}

function deliver(documentId: string) {
  submitDocumentSection({
    sessionId: SESSION,
    documentId,
    sectionId: "s1",
    content: "总则正文。",
    citations: [CITATION],
  });
  submitDocumentSection({
    sessionId: SESSION,
    documentId,
    sectionId: "s2",
    content: "步骤正文。",
    citations: [CITATION],
  });
}

/** 只交了大纲 + 分节（2 份产物，卡在 merge）——用来区分「状态来自查询」与「阶段列表写死」 */
function seedPartial(documentId: string) {
  plan(documentId, "迁移说明（分节已交）");
  deliver(documentId);
  const res = runDocumentPipelineStage({ sessionId: SESSION, documentId, stage: "sections" });
  if (!res.ok) throw new Error(res.error);
}

/** 全阶段跑完（7 份产物，带 diff 摘要） */
function seedComplete(documentId: string) {
  plan(documentId, "迁移说明（已完成）");
  deliver(documentId);
  for (const stage of ["sections", "merge", "consistency", "citations", "coverage", "diff"] as const) {
    const res = runDocumentPipelineStage({ sessionId: SESSION, documentId, stage });
    if (!res.ok) throw new Error(`${stage}: ${res.error}`);
  }
}

function rowOf(documentId: string): HTMLElement {
  const rows = screen.getAllByTestId("doc-pipeline-row");
  const found = rows.find((row) => row.getAttribute("data-document-id") === documentId);
  if (!found) throw new Error(`没有找到 ${documentId} 的文档编译行`);
  return found;
}

afterEach(() => {
  cleanup();
  __resetDocumentPipelinesForTests();
  vi.restoreAllMocks();
});

describe("C07-UI：ContextMonitor 的「文档编译」只读区", () => {
  it("DP-UI-1：有持久化状态（先清内存）⇒ 渲染阶段标记、产物数、最近 diff 摘要", async () => {
    seedPartial("doc_partial");
    seedComplete("doc_done");
    // 只留设置键、清掉进程内镜像 ⇒ 面板必须从导出查询读回（模拟重启后的界面）
    flushDocumentPipelinePersistence();
    __resetDocumentPipelinesForTests();

    render(<ContextMonitor sessionId={SESSION} visible={true} />);
    await waitFor(() => expect(screen.getAllByTestId("doc-pipeline-row")).toHaveLength(2));

    const partial = rowOf("doc_partial");
    expect(partial.textContent).toContain("迁移说明（分节已交）");
    expect(partial.textContent).toContain("未完成");
    // 阶段标记必须来自真实状态：outline/sections 完成、merge 还没跑
    expect(partial.textContent, "已完成阶段要显示 ✓").toContain("outline ✓");
    expect(partial.textContent).toContain("sections ✓");
    expect(partial.textContent, "未执行阶段要显示 …（写死阶段列表会在这里红）").toContain("merge …");
    expect(partial.textContent, "产物数必须来自真实证据（outline+sections = 2）").toContain("产物 2 个");
    expect(partial.textContent, "没跑完 diff 的行不该凭空显示 diff 摘要").not.toContain("最近 diff：");

    const done = rowOf("doc_done");
    expect(done.textContent).toContain("已完成");
    expect(done.textContent).toContain("diff ✓");
    expect(done.textContent).toContain("产物 7 个");
    expect(done.textContent, "最近 diff 摘要要能看见 +/− 与基线状态").toContain("最近 diff：+");
    expect(done.textContent).toContain("基线无");
  });

  it("DP-UI-2：没有状态 ⇒ 空态文案，不渲染假行、不抛错", async () => {
    render(<ContextMonitor sessionId="c07-panel-empty" visible={true} />);
    await waitFor(() => expect(screen.getByTestId("doc-pipeline-empty")).toBeTruthy());
    expect(screen.getByTestId("doc-pipeline-empty").textContent).toContain("本会话还没有文档编译");
    expect(screen.queryAllByTestId("doc-pipeline-row")).toHaveLength(0);
  });

  it("DP-UI-3：未选择会话时也只给空态（不读别的会话）", async () => {
    seedPartial("doc_partial");
    render(<ContextMonitor sessionId="" visible={true} />);
    await waitFor(() => expect(screen.getByTestId("doc-pipeline-empty")).toBeTruthy());
    expect(screen.queryAllByTestId("doc-pipeline-row")).toHaveLength(0);
  });
});
