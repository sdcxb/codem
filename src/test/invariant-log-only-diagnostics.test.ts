/**
 * **发现类自检只进日志、不打扰用户**（第 50 波 ✓）—— 用户实报 + 明确要求 ✓。
 *
 * ## 用户原话（这是本文件所有判据的依据 ✓）
 *
 * 「用户不是专业运维人员，这类提示让它不提示了，**因为即使提示了用户也没有操作介入的办法**」✓
 *
 * ## 规则（一条，适用于所有自检发现 ✓）
 *
 * | 发现的类型 | 去处 | 例子 |
 * |---|---|---|
 * | 用户**能**做一个动作 ✓ | 用户可见（advisory ✓） | 凭据普查：可以轮换密钥 ✓ |
 * | 用户**无事可做**（已修好 / 要我们自己看 ✓） | **只进日志** ✓ | 重复事件已收敛 ✓、索引已补回 ✓、结构异常待人工看 ✓、新缺口对账 ✓ |
 *
 * ## 为什么这条规则本身值得用判据钉住 ✗→✓
 *
 * 真机已经出现过两次"弹了也没用"的横幅 ✓（重复事件收敛 ✓、不变量新缺口 ✓），
 * 而每次都要用户来回一轮才知道 ✗ ⇒ 把规则写成判据 ✓，下次谁想加回横幅就得先解释为什么用户能介入 ✓。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { formatInvariantFreshLog } from "../core/storage/maintenance";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MAINT = "src/core/storage/maintenance.ts";

describe("发现类自检只进日志（第 50 波 ✓）", () => {
  it("LOG-1 新缺口日志要含**按类型**分解 ✓（不同类是不同的病因 ✓）", () => {
    const line = formatInvariantFreshLog(
      ["s1|VISIBLE_BUT_NOT_RECORDED|m1", "s1|VISIBLE_BUT_NOT_RECORDED|m2", "s2|ORPHAN_EVENT|e1"],
      1724 + 3,
      1724,
    );
    expect(line).toContain("本次新产生 3 条缺口");
    expect(line).toContain("VISIBLE_BUT_NOT_RECORDED×2");
    expect(line).toContain("ORPHAN_EVENT×1");
  });

  it("LOG-2 ★ 日志要含**按会话的集中度** ✓（这一刀才分得清两种病因 ✓）", () => {
    // 形态 A：一个会话里一大堆 ⇒ 某条具体写路断了
    const concentrated = formatInvariantFreshLog(
      Array.from({ length: 20 }, (_, i) => `sessA|VISIBLE_BUT_NOT_RECORDED|m${i}`),
      100,
      50,
    );
    expect(concentrated).toContain("sessA(20)");

    // 形态 B：很多会话各一条 ⇒ 系统性口径差（历史迁移/镜像未就绪那一类）
    const spread = formatInvariantFreshLog(
      ["a|VISIBLE_BUT_NOT_RECORDED|m1", "b|VISIBLE_BUT_NOT_RECORDED|m1", "c|VISIBLE_BUT_NOT_RECORDED|m1"],
      100,
      50,
    );
    expect(spread).toContain("按会话（前 3）：");
    expect(spread, "每个会话都只出现 1 条时，集中度要用括号里的 1 说明").toMatch(/\(1\)/);
  });

  it("LOG-3 样例最多 5 条、多余的用「等 N 条」收口 ✓（日志不许被一条发现刷爆 ✗）", () => {
    const many = Array.from({ length: 12 }, (_, i) => `s|K|m${i}`);
    const line = formatInvariantFreshLog(many, 12, 0);
    expect(line).toContain("等 12 条");
    expect(line.split("样例：")[1], "样例里最多 5 个指纹").not.toContain("m5、m6");
  });

  it("LOG-4 空集合不许崩、也不许印出 undefined ✓（判据型边界 ✓）", () => {
    const line = formatInvariantFreshLog([], 0, 0);
    expect(line).toContain("本次新产生 0 条缺口");
    expect(line).toContain("（无）");
    expect(line).not.toContain("undefined");
  });

  it("LOG-5 ★ 四条「用户无事可做」的发现**不再**走 advisory ✓；凭据普查**保留** ✓", () => {
    const src = read(MAINT);
    for (const id of [
      "maintenance.eventsDedupText",
      "maintenance.invariantAudit.new",
      "maintenance.eventStructure",
      "maintenance.indexBehindLog",
    ]) {
      expect(src, `★ ${id} 必须只进日志（用户没有可介入的动作 ✗）`).not.toContain(`reportAdvisory("${id}"`);
    }
    expect(src, "凭据普查要**保留**：用户可以轮换密钥 ✓（这是唯一有动作可做的一条）").toContain(
      'reportAdvisory("maintenance.credentialCensus"',
    );
  });

  it("LOG-6 每条改过的日志都自报「只进日志」✓（免得下一个人以为是漏了弹窗 ✗）", () => {
    const src = read(MAINT);
    expect(src).toContain("这条只进日志");
    expect(src, "索引那一条也要说明").toContain("（只进日志 ✓）");
  });
});
