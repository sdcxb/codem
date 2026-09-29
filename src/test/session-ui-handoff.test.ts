/**
 * UI 触发的会话交接 —— 第 122 轮（「开启新对话」= 交接，不是从零开始）。
 *
 * ## 为什么这个模块必须由**代码**生成交接正文
 *
 * 第 62 波事故的根因：模型自由生成的交接是几千字的**意图复述**
 * （「梳理背景 / 确认版本 / 统一归档位置」），没有任何**状态**（文件在哪、做到哪、
 * 什么算做完），接收方只能从零重扫目录，几十次枚举后卡死。
 * 第 63/65 波因此加了**机械校验**（`handover.ts`：绝对路径 + 可判定的完成判据 + 禁止重扫）。
 *
 * 让模型去满足一个机械校验是绕远路 —— 这里要用的事实（用户请求、AI 结论、工具调用与结果、
 * 涉及文件、错误、待办）在消息库里**已经全都有了**，`renderStructuredHistorySummary`
 * 本来就是按这些段渲染的。于是本轮把它接成"UI 一键交接"。
 *
 * ## 这个文件守什么
 *
 * | 判据 | 为什么单独立一条 |
 * |---|---|
 * | UH-1 | 机械生成的正文**必须自己通过**协议校验 —— 否则按钮一点就失败 |
 * | UH-2 | **没有产出文件**的会话也必须能交接（退到工作目录）—— 这是探针抓出来的真缺陷 |
 * | UH-3 | 磁盘上**不存在**的路径不进「已完成产物」（写一个不存在的路径比不写更坏） |
 * | UH-4 | 没核实过的路径**不许**在正文里被说成"已核实"（交接里的假话最贵） |
 * | UH-5 | 长度在硬上限内；引用的是最近 N 条消息（与压缩保留集同量级） |
 * | UH-6 | 摘要里的工具调用三段（名字/参数/结果）确实进了正文 —— 这才是"状态" |
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHandover, type ExistsChecker } from "../core/session/ui-handoff";
import { checkHandover, HANDOVER_HARD_LIMIT } from "../core/session/handover";

/**
 * 存在性检查器：测试里**显式**走 Node 的真 `fs`。
 *
 * 为什么不给 `buildHandover` 留默认值（第一版留了，然后栽了）：默认值只能是
 * `node:fs`，而它在**浏览器里**被 `vite.config.ts` 的 alias 换成
 * `src/stubs/node-fs-stub.ts`（`existsSync` 恒返回 false）⇒ 装机版上交接正文永远
 * 找不到任何存在的路径 ⇒ 协议校验永远拒绝 ⇒ 功能完全不可用，而单元测试全绿。
 * 详见 `ui-handoff.ts` 的 `ExistsChecker` 与 `renderer-standin-guards.test.ts`。
 *
 * 让检查器**必填**，等于逼每个调用点回答"你是在问谁" —— 这正是它该有的形态。
 */
const nodeExists: ExistsChecker = (p) => existsSync(p);

/** 一次真跑：用真盘上的文件，避免"测试里全是假路径"导致判据测不到东西 */
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uh-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 造一条 assistant 消息：带一次工具调用 */
function assistantWith(tool: string, args: Record<string, unknown>, status = "done") {
  return {
    id: `a-${tool}-${Math.random().toString(36).slice(2, 7)}`,
    role: "assistant",
    content: "已处理",
    timestamp: 2,
    status: "done",
    toolCalls: [{ id: "tc1", tool, args, result: "ok", status }],
  };
}

describe("第 122 轮 · UI 会话交接正文", () => {
  it("UH-1: 机械生成的交接**自己就能通过**协议校验（否则按钮一点就失败）", async () => {
    const file = join(dir, "报告.md");
    writeFileSync(file, "# 报告\n", "utf8");
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: `把 ${file} 的第 3 节补完`, timestamp: 1, status: "done" },
        assistantWith("write", { path: file, content: "x" }),
      ] as never[],
      { cwd: dir, goal: `补完 ${file}`, exists: nodeExists },
    );
    expect(h.check.ok, `校验失败原因：${h.check.error ?? ""}`).toBe(true);
    expect(h.check.stats.hasAbsolutePath).toBe(true);
    expect(h.check.stats.hasDoneCriteria).toBe(true);
    expect(h.check.stats.hasCheckableCriterion).toBe(true);
    expect(h.check.stats.hasNoRescan).toBe(true);
    // 直接拿它再校一次（不依赖内部那一次调用）
    expect(checkHandover(h.body).ok).toBe(true);
  });

  it("UH-2: **没有产出任何文件**的会话也必须能交接（退到工作目录）", async () => {
    /**
     * 这是探针抓出来的真缺陷：第一版只按"产出的文件"挑主要交付物，于是纯问答 /
     * 纯阅读 / 分析型会话会落进"没有可核实路径"分支，而那条分支的完成判据
     * **不含任何可检查对象** ⇒ `checkHandover` 判 `hasCheckableCriterion: false`
     * ⇒ 整份交接被拒 ⇒「开启新对话」在所有没有产出文件的会话里都失败。
     */
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: "帮我看看这个方案有什么风险", timestamp: 1, status: "done" },
        { id: "a1", role: "assistant", content: "主要有三点风险……", timestamp: 2, status: "done" },
      ] as never[],
      { cwd: dir, goal: "评估方案风险", exists: nodeExists },
    );
    expect(h.check.ok, `校验失败原因：${h.check.error ?? ""}`).toBe(true);
    // 完成判据必须落在"已核实存在的工作目录"上
    expect(h.primaryPath).toBe(dir);
    expect(h.body).toContain(dir);
  });

  it("UH-2b: **全局对话**（cwd 为空 / 不存在）也必须能交接 —— 这是装机版上抓到的第二个洞", async () => {
    /**
     * ## 为什么这条必须单独有（真机打出来的，不是推理出来的）
     *
     * UH-2 修完之后单元测试全绿，但在**装机版**上点「开启新对话（交接当前工作）」
     * 仍然被拒，原因（advisory 原文）：
     *
     * > 交接正文缺少必需内容： - 「已完成产物 / 具体目标」的**绝对路径** …
     *
     * 复现出来是这两行：
     * ```
     * cwd=""                     check.ok=false primaryPath=null
     * cwd="D:\\不存在的目录xyz"    check.ok=false primaryPath=null
     * ```
     * `cwd = ""` 正是**全局对话**（`currentProject` 为 null）的常态 ——
     * 也就是说**最常见的场景里交接必然失败**，而 UH-2 用的是 `mkdtempSync` 出来的
     * 真实临时目录，**永远看不到这个洞**。
     *
     * 这条用例把两种"没有可用工作目录"的形态都钉住：合法退路是**用户主目录**
     * （它几乎总存在、且是绝对路径）。
     */
    const msgs = [{ id: "u1", role: "user", content: "随便一句", timestamp: 1, status: "done" }];
    for (const cwd of ["", join(dir, "不存在的子目录")]) {
      const h = await buildHandover(msgs as never[], { cwd, goal: "测试", exists: nodeExists });
      expect(h.check.ok, `cwd=${JSON.stringify(cwd)} 时校验失败：${h.check.error ?? ""}`).toBe(true);
      expect(h.primaryPath, `cwd=${JSON.stringify(cwd)} 时没有可指的绝对路径`).toBeTruthy();
      expect(h.check.stats.hasAbsolutePath).toBe(true);
      expect(h.check.stats.hasCheckableCriterion).toBe(true);
    }
  });

  it("UH-3: 磁盘上**不存在**的路径不进「已完成产物」（写不存在的路径比不写更坏）", async () => {
    const real = join(dir, "真实.md");
    writeFileSync(real, "x", "utf8");
    const ghost = join(dir, "不存在.md");
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: "干活", timestamp: 1, status: "done" },
        assistantWith("write", { path: real, content: "x" }),
        assistantWith("write", { path: ghost, content: "x" }),
      ] as never[],
      { cwd: dir, exists: nodeExists },
    );
    expect(h.verifiedPaths).toContain(real);
    expect(h.verifiedPaths).not.toContain(ghost);
    expect(h.body).toContain(real);
    expect(h.body).not.toContain(ghost);
  });

  it("UH-4: 失败的工具调用不算「已完成产物」（写失败留下的是残骸，不是交付物）", async () => {
    const f = join(dir, "半成品.md");
    writeFileSync(f, "x", "utf8");
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: "干活", timestamp: 1, status: "done" },
        assistantWith("write", { path: f, content: "x" }, "error"),
      ] as never[],
      { cwd: dir, exists: nodeExists },
    );
    /**
     * ⚠️ 断言必须落在 `producedPaths` 上，**不能**落在 `verifiedPaths` 上。
     *
     * 这两个字段原本是一个：`verifiedPaths` 既当"产出"又当"涉及"，于是写失败的残骸
     * 会被渲染进第 2 条「**已完成产物**」—— 那是交接里最贵的一种假话，接收方会以为
     * 那个文件已经改好了。本条用例最初写成 `expect(h.verifiedPaths).not.toContain(f)`，
     * 真跑就红，红得对：文件**存在**（写操作失败不代表没写出东西），所以它当然在
     * "已核实存在"的集合里；错的是它被当成了"产物"。
     */
    expect(h.producedPaths).not.toContain(f);
    expect(h.verifiedPaths).toContain(f);
    // 正文里它是"涉及"档：必须明说"未被本会话修改"，而不是"已完成产物"
    expect(h.body).toContain("未被本会话修改");
    expect(h.body).toContain(f);
  });

  it("UH-5: 没有核实过任何路径时，正文**不许**声称「已核实」", async () => {
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: "看看 D:\\不存在\\幽灵.md 有什么问题", timestamp: 1, status: "done" },
      ] as never[],
      { cwd: join(dir, "也没有这个目录"), exists: nodeExists },
    );
    expect(h.verifiedPaths).toEqual([]);
    // 正文里出现了"未核实"的如实声明，而不是"所有路径都经磁盘存在性核实"
    expect(h.body).toContain("未经核实");
    expect(h.body).not.toContain("所有路径都经磁盘存在性核实");
  });

  it("UH-6: 长度在硬上限内，且工具调用三段（名字/参数/结果）确实进了正文", async () => {
    const f = join(dir, "大.md");
    writeFileSync(f, "x", "utf8");
    const h = await buildHandover(
      [
        { id: "u1", role: "user", content: "跑一下测试", timestamp: 1, status: "done" },
        {
          id: "a1",
          role: "assistant",
          content: "跑完了",
          timestamp: 2,
          status: "done",
          toolCalls: [
            { id: "t1", tool: "bash", args: { command: "npx vitest run" }, result: "3 passed", status: "done" },
            { id: "t2", tool: "write", args: { path: f, content: "x" }, result: "ok", status: "done" },
          ],
        },
      ] as never[],
      { cwd: dir, exists: nodeExists },
    );
    expect(h.body.length).toBeLessThan(HANDOVER_HARD_LIMIT);
    // "状态"三要素：改过哪个文件、跑过什么命令、结果是什么
    expect(h.body).toContain("bash");
    expect(h.body).toContain("npx vitest run");
    expect(h.body).toContain("3 passed");
    expect(h.body).toContain(f);
    expect(h.body).toContain("不要重新扫描");
  });

  it("UH-7: 引用的是**最近 N 条**而不是整个会话（交接不做全量转储）", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `u${i}`,
      role: "user",
      content: `第 ${i} 条请求`,
      timestamp: i,
      status: "done",
    }));
    const h = await buildHandover(many as never[], { cwd: dir, exists: nodeExists });
    expect(h.body).toContain("最近");
    // 最早的内容不该出现（它是被裁掉的那一档）
    expect(h.body).not.toContain("第 0 条请求");
    expect(h.body).toContain("第 199 条请求");
  });
});
