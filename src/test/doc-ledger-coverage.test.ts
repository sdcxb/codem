/**
 * C06：Document Ledger —— 章节覆盖 / claim→citation / 跨段保留 / 版本同步检查。
 *
 * 验收口径（docs/marketing/context-os.claims.json C06）：
 * 「Ledger 能在压缩/换段后保留覆盖状态；每个 claim 可回溯 citation；
 *   未读/未验章节可见；代码任务完成后检查相关文档版本是否同步。」
 *
 * 四条判据各自会因为实现坏掉而红：
 * 1. 段号变化时重置账本 ⇒ 覆盖丢失（判据 1 红）；
 * 2. 允许无引用的 claim / 引用渲染丢字段 ⇒ claim 不可回溯（判据 2 红）；
 * 3. 不记录大纲或降级覆盖状态 ⇒ 未读/未验不可见（判据 3 红）；
 * 4. 版本比较被写坏（恒等）⇒ 文档变过却报「同步」（判据 4 红）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../core/llm/tools";
import { createDocLedgerTool, withDocOutputValue } from "../core/llm/tools/document-tools";
import {
  documentLedgerSnapshot,
  documentSyncCheck,
  flushDocumentLedgerPersistence,
  hasDocumentLedger,
  noteDocumentLedgerSegment,
  recordDocumentClaim,
  recordDocumentFact,
  recordDocumentOutline,
  recordDocumentRead,
  recordDocumentSearch,
  recordDocumentSection,
  renderDocumentLedger,
  verifyDocumentClaim,
} from "../core/document/ledger";
import { buildDocumentSyncNudge, judgeDocumentSyncGate, shouldNudgeDocumentSync } from "../core/llm/completion-guards";
import { ContextManager, getContextManager } from "../core/context/context";
import { resetWarnOnce } from "../core/debug";
import {
  __resetDocumentBackendForTests,
  __resetDocumentLedgerForTests,
  setDocumentBackend,
} from "../core/document/test-seams";
import { createFakeDocumentBackend, makeDoc } from "./helpers/documents-fake";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

const C = "session:s1";

function hit(chunkNo = 9, heading = "第二章 迁移", page = 12) {
  return {
    document_id: "doc_1",
    chunk_no: chunkNo,
    name: "报告.docx",
    status: "ready",
    page_from: page,
    page_to: page,
    heading_path: heading,
    text_offset: 0,
    text_len: 100,
    preview: "迁移分三步。",
    score: 1,
  };
}

function ctx(sessionId = "s1"): ToolContext {
  return {
    sessionId,
    messageId: "m1",
    cwd: "C:\\project",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as unknown as ToolContext;
}

afterEach(() => {
  __resetDocumentBackendForTests();
  __resetDocumentLedgerForTests();
});

describe("C06-1 压缩/换段后覆盖保留", () => {
  it("段号翻篇不重置账本，且渲染显式写出「覆盖保留」", () => {
    noteDocumentLedgerSegment(C, 1);
    recordDocumentSearch(C, [hit()]);
    recordDocumentRead({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      chunkNo: 7,
      pageFrom: 20,
      pageTo: 20,
      headingPath: "第四章 结论",
    });

    // 模拟两次换段（压缩/切换都会推进段号）
    noteDocumentLedgerSegment(C, 2);
    noteDocumentLedgerSegment(C, 3);

    const text = renderDocumentLedger(C);
    expect(text).toContain("覆盖: 第 1 段 → 第 3 段（覆盖保留，未丢失）");
    // 段号变化前的覆盖仍然在（文件 / 已读 / 章节）
    expect(text).toContain("报告.docx");
    expect(text).toContain("§第二章 迁移");
    expect(text).toContain("p.20 §第四章 结论 (chunk 7)");
    const snapshot = documentLedgerSnapshot(C);
    expect(snapshot.segment).toEqual({ first: 1, current: 3 });
    expect(snapshot.counts.reads).toBeGreaterThanOrEqual(2);
    expect(snapshot.counts.sections).toBeGreaterThanOrEqual(2);
  });

  it("没有段号信息时不写「覆盖保留」这一行（不编造）", () => {
    recordDocumentSearch(C, [hit()]);
    expect(renderDocumentLedger(C)).not.toContain("覆盖:");
  });
});

describe("C06-2 claim 必须可回溯到 citation", () => {
  it("带 citation 的 claim 渲染成 file/page/section/chunk 四段", () => {
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第二章 迁移", "第四章 结论"],
      pages: 320,
    });
    const claim = recordDocumentClaim({
      collectionId: C,
      claim: "迁移分三步",
      citation: { documentId: "doc_1", chunkNo: 9, pageFrom: 12, pageTo: 13, headingPath: "第二章 迁移" },
    });
    expect(claim.id).toBe("claim_1");
    expect(claim.verified).toBe(false);

    const text = renderDocumentLedger(C);
    expect(text).toContain("待验证的结论:");
    expect(text).toContain(
      "迁移分三步 ← [file: 报告.docx | page: 12-13 | §第二章 迁移 | chunk: doc_1#9]",
    );
    // 章节状态由 claim 的引用推出「已读」
    const snapshot = documentLedgerSnapshot(C);
    expect(snapshot.sections.find((s) => s.headingPath === "第二章 迁移")?.status).toBe("read");
  });

  it("没有 citation（或只有 documentId）的 claim 被拒绝，不存无法回溯的字符串", () => {
    expect(() =>
      recordDocumentClaim({ collectionId: C, claim: "无引用结论", citation: { documentId: "" } }),
    ).toThrow(/citation/);
    expect(() =>
      recordDocumentClaim({ collectionId: C, claim: "只有文档 id", citation: { documentId: "doc_1" } }),
    ).toThrow(/chunk\/页\/章节/);
    expect(documentLedgerSnapshot(C).counts.claims).toBe(0);
  });

  it("验证 claim 后进入「已验证」并把章节升到 verified", () => {
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第二章 迁移"],
    });
    const claim = recordDocumentClaim({
      collectionId: C,
      claim: "迁移分三步",
      citation: { documentId: "doc_1", chunkNo: 9, headingPath: "第二章 迁移" },
    });
    expect(verifyDocumentClaim(C, claim.id)).toBe(true);
    expect(verifyDocumentClaim(C, claim.id)).toBe(false); // 幂等：第二次没有改动
    const text = renderDocumentLedger(C);
    expect(text).toContain("已验证的结论:");
    expect(text).not.toContain("待验证的结论:");
    const snapshot = documentLedgerSnapshot(C);
    expect(snapshot.sections.find((s) => s.headingPath === "第二章 迁移")?.status).toBe("verified");
    expect(snapshot.counts.unverified).toBe(0);
  });
});

describe("C06-3 未读 / 未验章节可见（且状态只升不降）", () => {
  it("大纲里没碰过的章节列成「未读」，读过的章节列成「未验」直到验证", () => {
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第一章 总则", "第二章 迁移", "第三章 结论"],
    });
    recordDocumentRead({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      chunkNo: 3,
      pageFrom: 1,
      pageTo: 2,
      headingPath: "第一章 总则",
    });

    const snapshot = documentLedgerSnapshot(C);
    expect(snapshot.counts.unread).toBe(2);
    expect(snapshot.unread.map((u) => u.headingPath)).toEqual(["第二章 迁移", "第三章 结论"]);
    expect(snapshot.counts.unverified).toBe(1);

    const text = renderDocumentLedger(C);
    expect(text).toContain("章节: 已读 1 / 已改 0 / 已验 0 / 未读 2");
    expect(text).toContain("未读章节:");
    expect(text).toContain("- 报告.docx §第二章 迁移");
    expect(text).toContain("未验章节:");
    expect(text).toContain("- 报告.docx §第一章 总则");

    // 升到 verified 后：未验列表少一条，未读不受影响
    recordDocumentSection({
      collectionId: C,
      documentId: "doc_1",
      headingPath: "第一章 总则",
      status: "verified",
    });
    const after = documentLedgerSnapshot(C);
    expect(after.counts.unverified).toBe(0);
    expect(after.counts.unread).toBe(2);
  });

  it("降级被拒绝：一次检索命中不会把「已验」冲回「已读」", () => {
    recordDocumentSection({
      collectionId: C,
      documentId: "doc_1",
      headingPath: "第二章 迁移",
      status: "verified",
    });
    expect(
      recordDocumentSection({
        collectionId: C,
        documentId: "doc_1",
        headingPath: "第二章 迁移",
        status: "read",
      }),
    ).toBe(false);
    expect(documentLedgerSnapshot(C).sections[0].status).toBe("verified");
  });
});

describe("C06-4 代码任务完成后检查文档版本是否同步", () => {
  it("读过之后文档版本变了 ⇒ changed 报出来，收尾守卫触发", async () => {
    // 第一次读：文档 updated_at=100
    setDocumentBackend(
      createFakeDocumentBackend({ documents: [makeDoc({ updated_at: 100 })] }).backend,
    );
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第二章 迁移"],
      pages: 320,
      status: "ready",
      updatedAt: 100,
    });
    // 第二次读：同一份文档 updated_at=200（读过之后被改过）
    setDocumentBackend(
      createFakeDocumentBackend({ documents: [makeDoc({ updated_at: 200 })] }).backend,
    );
    const sync = await documentSyncCheck(C);
    expect(sync.ok).toBe(false);
    expect(sync.changed).toEqual([
      { documentId: "doc_1", name: "报告.docx", recordedUpdatedAt: 100, currentUpdatedAt: 200 },
    ]);

    const nudge = shouldNudgeDocumentSync({
      codeEdited: true,
      hasDocumentCoverage: true,
      changedDocuments: sync.changed.length,
      unverifiedSections: sync.unverifiedSections,
      unverifiedClaims: sync.unverifiedClaims,
      alreadyNudged: false,
    });
    expect(nudge).toBe(true);
    // 反向对照：同样的「文档变过 + 未验」事实，在**没改代码**或**已经提醒过**时都不该再催
    expect(
      shouldNudgeDocumentSync({
        codeEdited: false,
        hasDocumentCoverage: true,
        changedDocuments: 2,
        unverifiedSections: 3,
        unverifiedClaims: 1,
        alreadyNudged: false,
      }),
    ).toBe(false);
    expect(
      shouldNudgeDocumentSync({
        codeEdited: true,
        hasDocumentCoverage: true,
        changedDocuments: 2,
        unverifiedSections: 3,
        unverifiedClaims: 1,
        alreadyNudged: true,
      }),
    ).toBe(false);
    expect(buildDocumentSyncNudge({ changedDocuments: ["报告.docx"], unverifiedSections: 0, unverifiedClaims: 0, unreadSections: 0 })).toContain(
      "你读过这些文档之后它们**变了**：报告.docx",
    );
  });

  it("版本没变且没有未验项 ⇒ 同步检查通过；只读任务不触发守卫（低误报）", async () => {
    setDocumentBackend(
      createFakeDocumentBackend({ documents: [makeDoc({ updated_at: 100 })] }).backend,
    );
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第二章 迁移"],
      updatedAt: 100,
    });
    recordDocumentSection({
      collectionId: C,
      documentId: "doc_1",
      headingPath: "第二章 迁移",
      status: "verified",
    });
    const sync = await documentSyncCheck(C);
    expect(sync.ok).toBe(true);
    expect(sync.changed).toEqual([]);
    expect(
      shouldNudgeDocumentSync({
        codeEdited: false,
        hasDocumentCoverage: true,
        changedDocuments: 0,
        unverifiedSections: 0,
        unverifiedClaims: 0,
        alreadyNudged: false,
      }),
    ).toBe(false);
  });
});

describe("C06-6 账本跨重启持久化（C06 边界①）", () => {
  /**
   * 这一组判据钉的是「账本只在进程内」这个边界：
   * 写进存储后**清内存**（或换一个模块实例）再读，状态与 claims 必须还在；
   * 坏数据必须回到空账本并 warn（不抛）；上限必须真的裁剪且可观测。
   */

  it("写入状态/claims 后清内存再读 ⇒ 状态与 claims 都在（重启模拟）", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    try {
      const collection = "session:persist-1";
      recordDocumentOutline({
        collectionId: collection,
        documentId: "doc_1",
        documentName: "报告.docx",
        headings: ["第一章 总则", "第二章 迁移"],
        pages: 320,
        updatedAt: 100,
      });
      recordDocumentSection({
        collectionId: collection,
        documentId: "doc_1",
        headingPath: "第二章 迁移",
        status: "edited",
      });
      const claim = recordDocumentClaim({
        collectionId: collection,
        claim: "迁移分三步",
        citation: { documentId: "doc_1", chunkNo: 9, headingPath: "第二章 迁移" },
      });
      verifyDocumentClaim(collection, claim.id);
      flushDocumentLedgerPersistence();

      // 落盘键必须是约定形状（一个集合一个键）
      const rows = port.__table("settings").filter((r) => r.key === `codem-document-ledger:${collection}`);
      expect(rows.length, "账本必须写进 codem-document-ledger:<collectionId>").toBe(1);
      const envelope = JSON.parse(String(rows[0].value)) as { v: number; claims: unknown[]; sections: unknown[] };
      expect(envelope.v, "信封必须带版本号（否则将来改形状无法识别）").toBe(1);
      expect(envelope.claims.length).toBe(1);
      expect(envelope.sections.length).toBe(1);

      // 清内存 = 模拟重启（磁盘上的账本仍在）
      __resetDocumentLedgerForTests();
      const restored = documentLedgerSnapshot(collection);
      expect(restored.hasContent).toBe(true);
      expect(restored.sections.find((s) => s.headingPath === "第二章 迁移")?.status).toBe("verified");
      expect(restored.claims.map((c) => c.text)).toEqual(["迁移分三步"]);
      expect(restored.claims[0].verified).toBe(true);
      expect(restored.claims[0].citation).toContain("chunk: doc_1#9");
      expect(restored.files[0].updatedAt).toBe(100);
      expect(restored.counts.claims).toBe(1);
    } finally {
      __resetDocumentLedgerForTests();
      setStoragePort(null);
    }
  });

  it("换一个模块实例再读 ⇒ 仍在（证明不是靠进程内 Map 记着的）", async () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    const collection = "session:persist-fresh-module";
    try {
      recordDocumentOutline({
        collectionId: collection,
        documentId: "doc_1",
        documentName: "报告.docx",
        headings: ["第二章 迁移"],
        updatedAt: 100,
      });
      recordDocumentClaim({
        collectionId: collection,
        claim: "迁移分三步",
        citation: { documentId: "doc_1", chunkNo: 9, headingPath: "第二章 迁移" },
      });
      flushDocumentLedgerPersistence();
      __resetDocumentLedgerForTests();

      // 新模块实例：它自己的内存 Map 是空的，只能从存储里读
      vi.resetModules();
      const [{ setStoragePort: setPortAgain }, fresh] = await Promise.all([
        import("../core/storage/port"),
        import("../core/document/ledger"),
      ]);
      // `vi.resetModules()` 之后 port.ts 也是新实例 ⇒ 把同一个假端口重新注册上去
      setPortAgain(port);
      try {
        const snapshot = fresh.documentLedgerSnapshot(collection);
        expect(snapshot.hasContent, "新实例必须从持久化里懒加载出账本").toBe(true);
        expect(snapshot.claims.map((c: { text: string }) => c.text)).toEqual(["迁移分三步"]);
        expect(snapshot.sections.some((s: { headingPath: string }) => s.headingPath === "第二章 迁移")).toBe(true);
      } finally {
        fresh.__resetDocumentLedgerForTests();
        setPortAgain(null);
      }
    } finally {
      __resetDocumentLedgerForTests();
      setStoragePort(null);
    }
  });

  it("坏 JSON / 版本不符 ⇒ 空账本 + warn，不抛", () => {
    const badJson = "session:bad-json";
    const badVersion = "session:bad-version";
    const port = createFakeStoragePort({
      seed: {
        settings: [
          { key: `codem-document-ledger:${badJson}`, value: "{ 这不是合法 JSON" },
          {
            key: `codem-document-ledger:${badVersion}`,
            value: JSON.stringify({ v: 99, collectionId: badVersion, files: [], claims: "不是数组" }),
          },
        ],
      },
    });
    setStoragePort(port);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => documentLedgerSnapshot(badJson), "坏 JSON 不许抛").not.toThrow();
      expect(documentLedgerSnapshot(badJson).hasContent).toBe(false);
      expect(documentLedgerSnapshot(badJson).claims).toEqual([]);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("空账本")),
        "坏数据必须 warn（否则用户只看到「账本空了」却不知道为什么）",
      ).toBe(true);

      expect(() => documentLedgerSnapshot(badVersion), "版本不符不许抛").not.toThrow();
      expect(documentLedgerSnapshot(badVersion).hasContent).toBe(false);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("版本不符") || String(c[0]).includes("不可用")),
        "版本不符必须 warn 出原因",
      ).toBe(true);
    } finally {
      warn.mockRestore();
      __resetDocumentLedgerForTests();
      setStoragePort(null);
    }
  });

  it("上限裁剪生效：claims 200 / 章节 100，裁最旧且统计可观测", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    const collection = "session:persist-cap";
    try {
      for (let i = 1; i <= 201; i++) {
        recordDocumentClaim({
          collectionId: collection,
          claim: `结论 ${i}`,
          citation: { documentId: "doc_1", chunkNo: i },
        });
      }
      for (let i = 1; i <= 101; i++) {
        recordDocumentSection({
          collectionId: collection,
          documentId: "doc_1",
          headingPath: `第 ${i} 章`,
          status: "read",
        });
      }
      const capped = documentLedgerSnapshot(collection);
      expect(capped.counts.claims, "claim 上限 200").toBe(200);
      expect(capped.counts.sections, "章节上限 100").toBe(100);
      expect(capped.trimmed.claims, "裁掉的条数必须可观测").toBe(1);
      expect(capped.trimmed.sections).toBe(1);
      expect(new Set(capped.claims.map((c) => c.id)).size, "裁剪后 id 不许撞车").toBe(200);
      expect(capped.claims.some((c) => c.text === "结论 1"), "裁掉的是最旧的一条").toBe(false);
      expect(capped.claims.some((c) => c.text === "结论 201")).toBe(true);

      flushDocumentLedgerPersistence();
      __resetDocumentLedgerForTests();

      // 重启后：上限仍然生效、统计仍在、新 claim 的序号接着走（不与被裁掉的 id 撞车）
      const restored = documentLedgerSnapshot(collection);
      expect(restored.counts.claims).toBe(200);
      expect(restored.counts.sections).toBe(100);
      expect(restored.trimmed.claims).toBe(1);
      expect(restored.trimmed.sections).toBe(1);
      const next = recordDocumentClaim({
        collectionId: collection,
        claim: "重启后的新结论",
        citation: { documentId: "doc_1", chunkNo: 999 },
      });
      expect(next.id).toBe("claim_202");
      const after = documentLedgerSnapshot(collection);
      expect(after.counts.claims, "超过上限仍保持 200").toBe(200);
      expect(new Set(after.claims.map((c) => c.id)).size, "新 claim 必须与既有 id 唯一").toBe(200);
      expect(after.trimmed.claims).toBe(2);
    } finally {
      __resetDocumentLedgerForTests();
      setStoragePort(null);
    }
  });

  it("读路径不写盘；多次写入在去抖窗口内合并成一次落盘", () => {
    const port = createFakeStoragePort();
    setStoragePort(port);
    const collection = "session:persist-debounce";
    try {
      recordDocumentFact(collection, "事实一");
      recordDocumentFact(collection, "事实二");
      recordDocumentFact(collection, "事实三");
      expect(port.__writes().length, "同步时刻还不该落盘（去抖窗口未到）").toBe(0);

      // 读路径（快照 / 渲染 / 有无内容 / 同步检查）一次都不许写
      documentLedgerSnapshot(collection);
      renderDocumentLedger(collection);
      hasDocumentLedger(collection);
      expect(port.__writes().length, "读不许触发写").toBe(0);

      flushDocumentLedgerPersistence();
      expect(port.__writes().length, "三次写合并成一次落盘").toBe(1);
      const rows = (port.__writes()[0].params as { rows?: Array<{ key?: string }> } | undefined)?.rows ?? [];
      expect(rows[0]?.key).toBe(`codem-document-ledger:${collection}`);
    } finally {
      __resetDocumentLedgerForTests();
      setStoragePort(null);
    }
  });

  it("没有存储端口时行为与旧版一致：读写都不抛，也不假装落盘", () => {
    const collection = "session:no-port";
    expect(() => {
      recordDocumentOutline({
        collectionId: collection,
        documentId: "doc_1",
        documentName: "报告.docx",
        headings: ["第一章"],
      });
      recordDocumentSection({ collectionId: collection, documentId: "doc_1", headingPath: "第一章", status: "read" });
      flushDocumentLedgerPersistence();
    }).not.toThrow();
    const snapshot = documentLedgerSnapshot(collection);
    expect(snapshot.counts.sections, "未落盘的旧账本照常可读").toBe(1);
    __resetDocumentLedgerForTests();
  });
});

describe("C06-5 只读查询入口（doc_ledger 工具）", () => {
  it("status 动作给出覆盖计数、未读章节与版本同步结论", async () => {
    setDocumentBackend(createFakeDocumentBackend({ documents: [makeDoc({ updated_at: 100 })] }).backend);
    recordDocumentOutline({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      headings: ["第一章 总则", "第二章 迁移"],
      updatedAt: 100,
    });
    recordDocumentRead({
      collectionId: C,
      documentId: "doc_1",
      documentName: "报告.docx",
      chunkNo: 0,
      pageFrom: 1,
      pageTo: 1,
      headingPath: "第一章 总则",
    });
    expect(hasDocumentLedger(C)).toBe(true);

    const tool = withDocOutputValue(createDocLedgerTool());
    const res = await tool.execute({ collection_id: C }, ctx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("文件 1 · 已读块 1");
    expect(res.output).toContain("未读章节:");
    expect(res.output).toContain("- 报告.docx §第二章 迁移");
    expect(res.output).toContain("版本同步: 已检查 1 份文档，版本未变化");
    expect((res.metadata as any).sync.ok).toBe(true);
  });
});

// ========== C06 边界②：硬闸额度按（文档 + 版本）而不是「每会话一次」 ==========

describe("C06-6 硬闸按（文档 + 版本）记账（不是会话级一次性）", () => {
  /**
   * 判据（先写判据，再改实现）：
   *
   * | 判据 | 钉什么 | 变异（改回会话级布尔 ⇒） |
   * |---|---|---|
   * | G-5a | 文档 A 拦一次后放行；**文档 B 新 stale 仍能拦** | 额度是布尔/只记次数 ⇒ B 被放行 ⇒ 红 |
   * | G-5b | 同一文档同一版本第二次 ⇒ `release-unverified`（不重复拦） | 每次 stale 都拦 ⇒ 红 |
   * | G-5c | 同一文档的**新版本**仍是新键 ⇒ 仍能拦 | 只按文档 id 记账 ⇒ 新版本被误放行 ⇒ 红 |
   * | G-6 | 每会话总上限 3：第 4 份文档放行且标未验（防死循环） | 不设总上限 ⇒ 第 4 次仍 block ⇒ 红 |
   * | G-7 | 无文档 / 无版本 / 没改过文件 ⇒ `none`（反向对照） | 无条件拦 ⇒ 红 |
   */
  type Fact = { documentId: string; name: string; updatedAt: number };
  const fact = (documentId: string, updatedAt: number): Fact => ({
    documentId,
    name: `${documentId}.md`,
    updatedAt,
  });

  function judge(overrides: Partial<Parameters<typeof judgeDocumentSyncGate>[0]> = {}) {
    return judgeDocumentSyncGate({
      codeEdited: true,
      versionedDocuments: 1,
      changedDocuments: [],
      unreadableDocuments: [],
      blockedKeys: [],
      blocksIssued: 0,
      ...overrides,
    });
  }

  it("G-5a: 文档 A 拦一次后放行；文档 B 新 stale ⇒ 仍能拦（不是会话级一次性）", () => {
    const first = judge({ changedDocuments: [fact("doc_a", 200)] });
    expect(first.verdict).toBe("block");
    expect(first.newlyBlocked, "A 被记入额度").toHaveLength(1);

    const again = judge({
      changedDocuments: [fact("doc_a", 200)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(again.verdict, "同一文档同一版本第二次 ⇒ 放行").toBe("release-unverified");
    expect(again.releaseReason).toBe("same-version");

    const another = judge({
      changedDocuments: [fact("doc_a", 200), fact("doc_b", 100)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(another.verdict, "另一份文档 stale ⇒ 仍能拦").toBe("block");
    expect(another.newlyBlocked, "只记 B 这个新键").toHaveLength(1);
  });

  it("G-5b: 同一文档同一版本第二次 ⇒ 不再拦（放行标未验）", () => {
    const first = judge({ changedDocuments: [fact("doc_a", 200)] });
    const second = judge({
      changedDocuments: [fact("doc_a", 200)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(second.verdict).toBe("release-unverified");
  });

  it("G-5c: 同一文档的新版本 ⇒ 是新键，仍能拦", () => {
    const first = judge({ changedDocuments: [fact("doc_a", 200)] });
    const newer = judge({
      changedDocuments: [fact("doc_a", 300)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(newer.verdict, "版本是键的一部分").toBe("block");
  });

  it("G-5d: 读不到（unreadable）也按（文档 + 版本）只拦一次", () => {
    const first = judge({ unreadableDocuments: [fact("doc_x", 100)] });
    expect(first.verdict).toBe("block");
    const second = judge({
      unreadableDocuments: [fact("doc_x", 100)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(second.verdict).toBe("release-unverified");
  });

  it("G-6: 每会话总上限 3 —— 第 4 份文档 stale 时放行并标未验（防死循环）", () => {
    let keys: string[] = [];
    for (let index = 0; index < 3; index++) {
      const decision = judge({
        changedDocuments: [fact(`doc_${index}`, 100 + index)],
        blockedKeys: keys,
        blocksIssued: index,
      });
      expect(decision.verdict, `第 ${index + 1} 份应该拦`).toBe("block");
      keys = [...keys, ...decision.newlyBlocked];
    }
    const fourth = judge({
      changedDocuments: [fact("doc_3", 400)],
      blockedKeys: keys,
      blocksIssued: 3,
    });
    expect(fourth.verdict, "达到总上限后只放行").toBe("release-unverified");
    expect(fourth.releaseReason).toBe("cap");
  });

  it("G-7: 无文档 / 无版本 / 没改过文件 ⇒ 一律 none（反向对照）", () => {
    expect(judge({ versionedDocuments: 0, changedDocuments: [fact("doc_a", 200)] }).verdict).toBe("none");
    expect(judge({ codeEdited: false, changedDocuments: [fact("doc_a", 200)] }).verdict).toBe("none");
    expect(judge({ changedDocuments: [] }).verdict).toBe("none");
  });

  it("G-7b: 只有检索命中（没记版本）⇒ 不拦（低误报的既有边界）", async () => {
    setDocumentBackend(createFakeDocumentBackend({ documents: [makeDoc({ updated_at: 200 })] }).backend);
    recordDocumentSearch(C, [hit()]); // 只记「搜到过」，不记版本
    const sync = await documentSyncCheck(C);
    expect(sync.versioned, "没有版本记录 ⇒ 没有可比对的版本事实").toBe(0);
    const decision = judge({
      versionedDocuments: sync.versioned,
      changedDocuments: sync.changed.map((item) => ({
        documentId: item.documentId,
        name: item.name,
        updatedAt: item.currentUpdatedAt ?? 0,
      })),
    });
    expect(decision.verdict, "只检索命中过 ⇒ 不拦").toBe("none");
  });
});

// ========== C06 边界② 的额度：可配置（codem-context-config.documentSyncMaxBlocks） ==========

describe("C06-7 硬闸额度可配置（1..10，0=不限，非法回默认 3）", () => {
  /**
   * 判据（先写判据，再改实现）：
   *
   * | 判据 | 钉什么 | 变异（忽略配置恒 3 ⇒） |
   * |---|---|---|
   * | B-1 | 配置 **1** ⇒ 第 1 份拦、第 2 份（新文档）即放行（额度用完） | 恒 3 ⇒ 第 2 份仍 block ⇒ 红 |
   * | B-2 | 配置 **0** ⇒ 多份文档都能拦（不限）；但同一（文档 + 版本）第二次仍放行 | 把 0 当默认 3 ⇒ 第 4 份放行 ⇒ 红 |
   * | B-3 | 非法值（11 / -1 / 2.5 / 字符串 / NaN）⇒ 回默认 3，并 `warnOnce` 一次 | 非法值按原样/钳制成 10 ⇒ 判定不同 ⇒ 红 |
   * | B-4 | 未配置 ⇒ 3（`CompactionConfig` 默认值回归） | 默认改成 0/10 ⇒ 红 |
   */
  type Fact = { documentId: string; name: string; updatedAt: number };
  const fact = (documentId: string, updatedAt: number): Fact => ({
    documentId,
    name: `${documentId}.md`,
    updatedAt,
  });

  function judge(overrides: Partial<Parameters<typeof judgeDocumentSyncGate>[0]> = {}) {
    return judgeDocumentSyncGate({
      codeEdited: true,
      versionedDocuments: 1,
      changedDocuments: [],
      unreadableDocuments: [],
      blockedKeys: [],
      blocksIssued: 0,
      ...overrides,
    });
  }

  afterEach(() => {
    /* 单例配置会被用例改：恢复默认（本文件其余用例不写 codem-context-config） */
    getContextManager().updateConfig({ documentSyncMaxBlocks: 3 });
    vi.restoreAllMocks();
    resetWarnOnce();
  });

  it("B-1: 配置 1 ⇒ 第 2 份文档即放行（第 2 份之后额度用完）", () => {
    getContextManager().updateConfig({ documentSyncMaxBlocks: 1 });

    const first = judge({ changedDocuments: [fact("doc_a", 200)] });
    expect(first.verdict, "第 1 份必须拦").toBe("block");

    const second = judge({
      changedDocuments: [fact("doc_b", 100)],
      blockedKeys: first.newlyBlocked,
      blocksIssued: 1,
    });
    expect(second.verdict, "配置 1 ⇒ 第 2 份即放行").toBe("release-unverified");
    expect(second.releaseReason).toBe("cap");
  });

  it("B-2: 配置 0 ⇒ 多份文档都能拦（不限）；同一文档同版本仍然只拦一次", () => {
    getContextManager().updateConfig({ documentSyncMaxBlocks: 0 });

    let keys: string[] = [];
    for (let index = 0; index < 5; index++) {
      const decision = judge({
        changedDocuments: [fact(`doc_${index}`, 100 + index)],
        blockedKeys: keys,
        blocksIssued: index,
      });
      expect(decision.verdict, `配置 0：第 ${index + 1} 份仍应拦`).toBe("block");
      keys = [...keys, ...decision.newlyBlocked];
    }

    const repeat = judge({
      changedDocuments: [fact("doc_0", 100)],
      blockedKeys: keys,
      blocksIssued: 5,
    });
    expect(repeat.verdict, "外层「同文档同版本只拦一次」仍生效（防死循环）").toBe("release-unverified");
    expect(repeat.releaseReason).toBe("same-version");
  });

  it("B-2b: 合法上界 10 生效（第 11 份才放行）", () => {
    getContextManager().updateConfig({ documentSyncMaxBlocks: 10 });
    expect(judge({ changedDocuments: [fact("doc_bound_9", 9)], blocksIssued: 9 }).verdict, "第 10 份仍拦").toBe("block");
    expect(
      judge({ changedDocuments: [fact("doc_bound_10", 10)], blocksIssued: 10 }).verdict,
      "第 11 份到配置上限",
    ).toBe("release-unverified");
  });

  it("B-3: 非法值 ⇒ 回默认 3，并 warn 一次（同一非法值不重复 warn）", () => {
    const invalidValues: unknown[] = [11, -1, 2.5, "3", Number.NaN];
    for (const raw of invalidValues) {
      resetWarnOnce();
      getContextManager().updateConfig({ documentSyncMaxBlocks: raw as number });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(
          judge({ changedDocuments: [fact(`inv_a_${String(raw)}`, 1)], blocksIssued: 2 }).verdict,
          `非法值 ${String(raw)} 必须回默认 3（第 3 份仍拦）`,
        ).toBe("block");
        expect(
          judge({ changedDocuments: [fact(`inv_b_${String(raw)}`, 2)], blocksIssued: 3 }).verdict,
          `非法值 ${String(raw)} 必须回默认 3（第 4 份到上限）`,
        ).toBe("release-unverified");
        expect(warn.mock.calls.length, "非法值必须 warn").toBe(1);
        expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("不合法");

        // 同一非法值再次读取 ⇒ warnOnce 不再重复输出（不能让日志被每轮刷屏）
        judge({ changedDocuments: [fact(`inv_c_${String(raw)}`, 3)], blocksIssued: 2 });
        expect(warn.mock.calls.length, "同一非法值只 warn 一次").toBe(1);
      } finally {
        warn.mockRestore();
      }
    }
  });

  it("B-4: 默认未配置 ⇒ 3（回归；CompactionConfig 默认值）", () => {
    expect(new ContextManager().getConfig().documentSyncMaxBlocks, "CompactionConfig 默认值必须是 3").toBe(3);
    expect(judge({ changedDocuments: [fact("doc_default_a", 2)], blocksIssued: 2 }).verdict, "第 3 份仍拦").toBe("block");
    expect(
      judge({ changedDocuments: [fact("doc_default_b", 3)], blocksIssued: 3 }).verdict,
      "第 4 份到默认上限",
    ).toBe("release-unverified");
  });
});
