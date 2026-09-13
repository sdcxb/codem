/**
 * 会话交接协议契约（第 63 波）—— 第 62 波事故的**根因**层。
 *
 * 事故复盘：用户做会话交接，父会话把一段**自由生成的、几千字的意图复述**交给新会话
 * （"梳理项目背景 / 确认最终版本 / 统一归档位置"），里面没有"文件在哪、已完成什么、
 * 什么算做完"。新会话只能从零重新遍历文件系统 → 几十次目录枚举 → 卡死 → 父会话无限期等待。
 *
 * 第 62 波加的重复调用守卫只是**安全网**（把它"停下来"），本文件守的是**不再产生这种交接**：
 * 交接必须是「状态 + 指针 + 完成判据」，且有长度上限。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkHandover,
  HANDOVER_SOFT_LIMIT,
  HANDOVER_HARD_LIMIT,
  HANDOVER_TEMPLATE,
} from "../core/session/handover";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 一个合格的交接（真实形态：产物写成文件 + 绝对路径 + 完成判据 + 禁止重扫） */
const GOOD = `【会话交接】
1. 目标：完成《课题二 研究目标-任务分解-成果指标（3000字版）》并归档到第二轮目录。
2. 已完成产物：
   - D:\\方案类项目\\制造运营管控agent标准\\对话交接总结.md：前序工作全量笔记（结论 + 依据）
   - D:\\方案类项目\\制造运营管控agent标准\\集中办公材料\\第二轮\\课题2\\研究任务一-技术路线图.docx：已成稿
3. 关键决定与约束：题目层级固定为「课题-任务-指标」；字数以正文计，不含图表。
4. 当前卡点：3000 字版尚未定稿，需与 1500 字版口径对齐。
5. 下一步动作：
   - 基于上面的绝对路径直接 read 两份稿子，产出 3000 字定稿到 D:\\...\\第二轮\\课题2\\3000字版.docx
   - 完成判据：正文 2900–3100 字、小标题与 1500 字版一一对应、用户确认归档路径
6. 禁止事项：不要重新扫描目录或重复枚举文件；需要内容时直接 read 上面的绝对路径。`;

describe("会话交接协议（第 63 波）", () => {
  it("HANDOVER-1: 合格的交接通过校验，并量出三项要素都在", () => {
    const r = checkHandover(GOOD);
    expect(r.ok, r.error).toBe(true);
    expect(r.stats.hasAbsolutePath).toBe(true);
    expect(r.stats.hasDoneCriteria).toBe(true);
    expect(r.stats.hasNoRescan).toBe(true);
  });

  it("HANDOVER-2: 缺「产物绝对路径」→ 拒绝，并说明该补什么", () => {
    const bad = GOOD.replace(/D:\\[^\s，。；)]+/g, "那个文件").replace(/[\w-]+\.(md|docx)/g, "某文件");
    const r = checkHandover(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/绝对路径/);
    expect(r.error).toMatch(/重新调用 delegate_to_session/);
  });

  it("HANDOVER-2b: 没有绝对路径但指向了具体文件（相对路径/文件名）→ 通过（少误拒）", () => {
    const rel = GOOD.replace(/D:\\[^\s，。；)]+/g, (m) => m.split("\\").pop() || m);
    const r = checkHandover(rel);
    expect(r.ok, r.error).toBe(true);
    expect(r.stats.hasAbsolutePath).toBe(false);
    expect(r.stats.hasPointer).toBe(true);
  });

  it("HANDOVER-2c: 只有意图、没有任何具体对象 → 仍然拒绝（这才是事故里的那种交接）", () => {
    const intentOnly = `【会话交接】
1. 目标：梳理项目背景，确认最终版本，统一归档位置。
2. 下一步：把该做的事做完。
3. 完成判据：全部完成。`;
    const r = checkHandover(intentOnly);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/绝对路径/);
  });

  it("HANDOVER-3: 缺「完成判据」→ 拒绝（没有判据接收方就没有终止条件）", () => {
    const bad = GOOD.replace(/完成判据/g, "继续推进");
    const r = checkHandover(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/完成判据|验收标准|交付物/);
  });

  it("HANDOVER-4: 超硬上限 → 拒绝，并指向「细节写文件、正文只留摘要 + 路径」", () => {
    const huge = GOOD + "\n" + "补充说明：".repeat(HANDOVER_HARD_LIMIT);
    expect(huge.length).toBeGreaterThan(HANDOVER_HARD_LIMIT);
    const r = checkHandover(huge);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/硬上限/);
    expect(r.error).toMatch(/写进文件/);
  });

  it("HANDOVER-5: 超过软上限但仍然合格 → 通过 + 提醒（不硬拦，避免挡住正常工作）", () => {
    const padded = GOOD + "\n7. 附注：" + "细节".repeat(Math.ceil((HANDOVER_SOFT_LIMIT - GOOD.length) / 2) + 50);
    expect(padded.length).toBeGreaterThan(HANDOVER_SOFT_LIMIT);
    expect(padded.length).toBeLessThan(HANDOVER_HARD_LIMIT);
    const r = checkHandover(padded);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/偏长/);
  });

  it("HANDOVER-6: 模板与本文件校验的要素一一对应（说要求就得给形状）", () => {
    for (const key of ["目标", "已完成产物", "关键决定与约束", "当前卡点", "下一步动作", "完成判据", "禁止事项"]) {
      expect(HANDOVER_TEMPLATE, `模板应包含「${key}」`).toContain(key);
    }
    expect(HANDOVER_TEMPLATE).toContain("不要重新扫描目录");
  });

  it("HANDOVER-7: delegate_to_session 真的接了校验（否则协议只是文档）", () => {
    const tools = read("src/core/session/tools.ts");
    const start = tools.indexOf("createDelegateToSessionTool");
    const block = tools.slice(start, start + 3200);
    expect(block).toContain("checkHandover(task)");
    expect(block, "不合规且未放宽时必须拒绝").toMatch(/if \(!check\.ok && !failOpen\)/);
    expect(block, "拒绝时不得创建委派任务").toMatch(/交接正文不合规/);
    // 校验必须会放手（第三次起放行），否则一个写不出合规交接的模型会把委派功能彻底锁死
    expect(block).toMatch(/failOpen/);
  });

  it("HANDOVER-8: 系统提示词里写了交接协议与「不要重新扫描」（提示词才是模型的形状来源）", () => {
    const prompt = read("src/core/prompt/prompt.ts");
    expect(prompt).toContain("HANDOVER_TEMPLATE");
    expect(prompt).toMatch(/Writing a Handover/);
    expect(prompt).toMatch(/Do not re-scan|不要重新扫描|absolute paths/i);
    expect(prompt).toMatch(/definition of done/i);
  });
});
