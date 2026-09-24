/**
 * 设计体系文档的**波次新鲜度**闸门（第 87 轮）。
 *
 * ## 它防的是什么（现场）
 *
 * `docs/UI-DESIGN-SYSTEM.md` 的「已完成的波次」清单里，**7 条**同时写着「（本轮）」
 * ——第 28 / 34 / 39 / 40 / 41 / 42 / 46 波。每一波写「本轮」时都是对的，
 * 但降级靠的是"下一波的收尾脚本顺手改一下"，漏一次就永久留下一个假「本轮」，
 * 读者于是无法判断当前波次。这是**纯机械**的陈旧，机器判得出来，所以做成闸门。
 *
 * 同一节还有第二处同类问题：§7 交接快照的标题写着「第 45 波后」，
 * 而它自己的表里已经引到第 52 波 —— **自相矛盾的波次声明**。
 *
 * ## 判据
 *
 * - DOCW-1：文档里**没有**「（本轮）」，且「已完成的波次」小节带了那条约定（历史记录不标本轮）；
 * - DOCW-2：§7 标题若声明了「第 N 波后」，则 N 必须 ≥ 全文提到的最大波次号（否则就是陈旧声明）；
 * - DOCW-3：变异自证 —— 把判据函数喂进"典型坏样本"（多一个本轮 / 标题挂小波次号 / 缺约定），必须判红。
 *
 * 为什么把判据写成**纯函数 + 对真文件断言**：这样坏样本可以直接喂进来，
 * 不必去改真文档来"证明闸门会红"（改真文档证明完还得还原，容易留痕）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOC = join(ROOT, "docs", "UI-DESIGN-SYSTEM.md");
const NOTE_MARK = "本清单是**历史记录**";

export interface WaveProblem {
  rule: "DOCW-1a" | "DOCW-1b" | "DOCW-2";
  detail: string;
}

/** 全文里出现过的最大波次号（「第 N 波」） */
export function maxWave(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/第\s*(\d+)\s*波/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** §7 标题里声明的波次号（「第 N 波后」）；没有声明则返回 null */
export function snapshotClaim(text: string): number | null {
  const head = text.match(/^##\s*7\.[^\n]*$/m);
  if (!head) return null;
  const m = head[0].match(/第\s*(\d+)\s*波后/);
  return m ? Number(m[1]) : null;
}

export function checkWaveFreshness(text: string): WaveProblem[] {
  const problems: WaveProblem[] = [];
  const stale = [...text.matchAll(/（本轮）/g)].length;
  if (stale > 0) {
    problems.push({
      rule: "DOCW-1a",
      detail: `还有 ${stale} 处「（本轮）」——历史清单里出现多个「本轮」，读者无法判断当前波次`,
    });
  }
  if (!text.includes(NOTE_MARK)) {
    problems.push({ rule: "DOCW-1b", detail: "「已完成的波次」小节缺少那条约定（历史记录一律不标「本轮」）" });
  }
  const claim = snapshotClaim(text);
  const max = maxWave(text);
  if (claim !== null && max > 0 && claim < max) {
    problems.push({
      rule: "DOCW-2",
      detail: `§7 标题声明「第 ${claim} 波后」，而全文已提到第 ${max} 波 —— 自相矛盾的陈旧声明`,
    });
  }
  return problems;
}

describe("设计体系文档的波次新鲜度（第 87 轮）", () => {
  it("DOCW-1/2 真实文档：无「（本轮）」残留、有约定、§7 标题不自相矛盾", () => {
    const text = readFileSync(DOC, "utf8");
    expect(checkWaveFreshness(text).map((p) => `${p.rule} ${p.detail}`)).toEqual([]);
  });

  it("DOCW-3 变异：典型坏样本必须被判红（证明闸门不是恒绿）", () => {
    const good = readFileSync(DOC, "utf8");

    // 坏样本①：把一处波次重新标成「本轮」
    const withCurrent = good.replace("28. **第 28 波**", "28. **第 28 波（本轮）**");
    expect(withCurrent).not.toBe(good); // 前提：文档里确实有这一条，否则这个坏样本是假的
    expect(checkWaveFreshness(withCurrent).map((p) => p.rule)).toContain("DOCW-1a");

    // 坏样本②：把 §7 标题挂回一个小波次号（第 45 波后，而全文有更大的波次）
    const staleHead = good.replace(/^##\s*7\.[^\n]*$/m, "## 7. 交接快照（2026-09-10 · 第 45 波后）");
    expect(checkWaveFreshness(staleHead).map((p) => p.rule)).toContain("DOCW-2");

    // 坏样本③：把那句约定删掉
    const noNote = good.replace(NOTE_MARK, "（约定被删掉了）");
    expect(checkWaveFreshness(noNote).map((p) => p.rule)).toContain("DOCW-1b");

    // 好样本（改回真文档）必须是绿的 —— 否则说明判据本身恒红
    expect(checkWaveFreshness(good)).toEqual([]);
  });

  it("DOCW-3b 判据函数本身：边界样本", () => {
    // 「第 N 波后」的声明等于最大波次是允许的（那就是当前波次）
    expect(checkWaveFreshness(`## 7. 交接快照（第 60 波后）\n\n${NOTE_MARK}\n\n第 60 波：x\n`)).toEqual([]);
    // 声明比最大更大也无所谓（写法保守，但没有自相矛盾）
    expect(checkWaveFreshness(`## 7. 交接快照（第 61 波后）\n\n${NOTE_MARK}\n\n第 60 波：x\n`)).toEqual([]);
    // 声明更小 ⇒ 红
    expect(
      checkWaveFreshness(`## 7. 交接快照（第 45 波后）\n\n${NOTE_MARK}\n\n第 46 波：x\n`).map((p) => p.rule),
    ).toEqual(["DOCW-2"]);
    // 没有 §7 标题 ⇒ DOCW-2 不适用（不去惩罚无关文档）
    expect(checkWaveFreshness(`${NOTE_MARK}\n\n第 9 波：x\n`)).toEqual([]);
  });
});
