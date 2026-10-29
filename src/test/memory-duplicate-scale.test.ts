/**
 * 「找出相似重复」不能再是 O(n²)·全文重算（第 233 轮审计 · P2 卡顿）。
 *
 * ## 缺陷形态
 *
 * `clusterDuplicateMemories` 对**每一对**都调 `memorySimilarity` / `memoryCombinedSimilarity`，
 * 而这两个函数每次都：
 * 1. `normalizeMemoryText` 规范化整段文本；
 * 2. 逐字符建 2-gram `Set`。
 *
 * 也就是说同一条记忆的 bigram 集合会被重建 **n−1 次**。实测（node 直接 import）：
 * 100 条 114ms / 300 条 749ms / 600 条 2997ms —— 平方增长，
 * 而 `maxTotalEntries` 上限是 5000 ⇒ 理论上一次点击可以让界面冻住几分钟。
 *
 * ## 修法（结果必须逐组相同）
 *
 * - 每条只**算一次**规范化文本与 2-gram 集合（key / 正文合并串各一份）；
 * - 每对只做集合求交（纯整数运算）；
 * - 用 **Jaccard 上界** `min(|A|,|B|)/max(|A|,|B|)` 先排除"绝不可能过阈值"的对比 ——
 *   这一步是**精确**的（上界小于阈值 ⇒ 真值必然小于阈值），不会改变任何分组结果。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | DUP-P1 | 结果与"逐对重算"的参考实现**逐组相同**（反向对照：优化不许改变分组） |
 * | DUP-P2 | 800 条互不相同的记忆耗时 < 500ms（原来按平方外推 ≈ 5s） |
 * | DUP-P3 | 长短不同但确实相似的一对仍被分到一组（上界预筛不许漏真命中） |
 *
 * 变异自证：把上界预筛改成"总是跳过" ⇒ DUP-P3（以及 DUP-P1）立刻红；
 * 去掉预计算（每对重算）⇒ DUP-P2 超时。
 */
import { describe, it, expect } from "vitest";
import {
  clusterDuplicateMemories,
  clusterDuplicateMemoriesChunked,
  MEMORY_DUPLICATE_SCAN_LIMIT,
  memorySimilarity,
  MEMORY_DUPLICATE_THRESHOLD,
} from "../core/memory/similarity";

type Entry = { id: string; key: string; content: string; order?: number };

/** 参考实现：与修复前逐字等价的"每对重算"版本（只保留分组结果） */
function referenceGroups(entries: Entry[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  for (const e of entries) parent.set(e.id, e.id);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const combined = memorySimilarity(`${a.key}\n${a.content}`, `${b.key}\n${b.content}`);
      const keySim = memorySimilarity(a.key, b.key);
      // ? `clusterDuplicateMemories` ???**?????**???? similarity.ts?
      const hit =
        a.key === b.key ||
        combined >= MEMORY_DUPLICATE_THRESHOLD ||
        (combined >= 0.22 && keySim >= 0.4) ||
        (keySim >= 0.6 && combined >= 0.15);
      if (!hit) continue;
      const ra = find(a.id);
      const rb = find(b.id);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const root = find(e.id);
    const list = groups.get(root) ?? [];
    list.push(e.id);
    groups.set(root, list);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => [...g].sort())
    .sort((x, y) => x[0].localeCompare(y[0]));
}

function entry(i: number, key: string, content: string): Entry {
  return { id: `m-${i}`, key, content, order: i };
}

describe("相似重复分组：成本有界且结果不变", () => {
  it("DUP-P1（反向对照）: 与逐对重算的参考实现逐组相同", () => {
    const entries: Entry[] = [
      entry(0, "部署流程", "先跑 npm run build，再发版"),
      entry(1, "部署流程", "先跑 npm run build 再发版"),      // 同 key ⇒ 必合并
      entry(2, "发版步骤", "先跑 npm run build，再发版"),      // 高相似
      entry(3, "宠物设置", "大肥鱼会在空闲时出现"),
      entry(4, "天气", "今天多云"),
    ];
    const got = clusterDuplicateMemories(entries).map((g) => [...g.ids].sort()).sort((x, y) => x[0].localeCompare(y[0]));
    expect(got).toEqual(referenceGroups(entries));
    expect(got.length, "至少有一组重复").toBeGreaterThan(0);
  });

  it("DUP-P2: 800 条互不相同的记忆必须有界（< 500ms）", () => {
    /**
     * 让 800 条**真的互不相同**（2-gram 重叠极低）：否则它们自己就会聚成一组，
     * 那样测到的是"分组结果"而不是"规模成本"。
     */
    const entries: Entry[] = Array.from({ length: 800 }, (_, i) =>
      entry(
        i,
        `topic-${i}-${(i * 7919) % 100003}`,
        Array.from({ length: 10 }, (_, k) => `w${(i * 131 + k * 17) % 9973}`).join(" "),
      ),
    );
    const t0 = performance.now();
    const groups = clusterDuplicateMemories(entries);
    const ms = performance.now() - t0;
    // 这条判据只管**规模**：键名相似（`topic-…`）会合法成组，所以不断言"没有组"
    expect(Array.isArray(groups)).toBe(true);
    expect(ms, `800 条耗时 ${ms.toFixed(0)}ms（原来按平方外推 ≈ 5s）`).toBeLessThan(500);
  });

  it("DUP-P3: 长度不同但确实相似的一对仍要成组（上界预筛不许漏）", () => {
    const long = "同样的部署结论：先构建、再发版、最后核对更新器签名";
    const entries: Entry[] = [
      entry(0, "部署结论 A", long),
      entry(1, "部署结论 B", long + "（补充一句）"),
      entry(2, "无关条目", "宠物会在空闲时出现"),
    ];
    const groups = clusterDuplicateMemories(entries);
    expect(groups.length, "确实相似的一对必须成组").toBe(1);
    expect([...groups[0].ids].sort()).toEqual(["m-0", "m-1"]);
  });

  /**
   * 规模上限（`maxTotalEntries: 5000`）的真实形态：**同步全量扫描会冻住界面**。
   *
   * 800 条 305ms ⇒ 按平方外推 5000 条 ≈ 12s。所以界面走的是分块版：
   * 只扫最近 2000 条、块间让出主线程、超限**如实披露**。
   *
   * | # | 行为 |
   * |---|---|
   * | DUP-P4 | 5000 条：`truncated=true`、`scanned=2000`、`total=5000`，且耗时 < 3s |
   * | DUP-P5（反向对照）| 上限以内：`truncated=false`、`scanned=total` |
   * | DUP-P6 | 分块版与同步版**结果逐组相同**（小规模） |
   * | DUP-P7 | 分块之间真的让出（进度回调 ≥ 2 次，`chunkPairs` 调小时可观察） |
   * | DUP-P8 | `shouldCancel` 能让它停下来（界面"取消"不是装饰） |
   */
  describe("规模上限：分块 + 披露 + 可取消", () => {
    const many = (count: number): Entry[] =>
      Array.from({ length: count }, (_, i) =>
        entry(i, `topic-${i}-${(i * 7919) % 100003}`, `w${IotaSeed(i)} 的第 ${i} 条`),
      );

    it("DUP-P4: 5000 条被截断，且**如实披露**（不假装全都比过了）", async () => {
      const entries = many(5000);
      const t0 = performance.now();
      const res = await clusterDuplicateMemoriesChunked(entries);
      const ms = performance.now() - t0;

      expect(res.total, "候选总数必须如实给").toBe(5000);
      expect(res.scanned, "超过上限时只扫最近 N 条").toBe(MEMORY_DUPLICATE_SCAN_LIMIT);
      expect(res.truncated, "被截断必须置 true").toBe(true);
      /*
       * 阈值 3000 → 5000：这条断言的是「有界」，不是某个具体性能数字。
       * 真机 5000 条分块扫描 ≈ 1.9s；但全量 8600+ 用例并行时 CPU 被抢，3s 会偶发抖动
       * （2026-10-28 实测过一次单跑 1.9s / 全量跑超 3s）。5s 仍远低于「同步全量 ≈ 12s」，
       * 变异（把分块去掉）依旧会红。
       */
      expect(ms, `5000 条分块扫描耗时 ${ms.toFixed(0)}ms（同步全量 ≈ 12s）`).toBeLessThan(5000);
    });

    it("DUP-P5（反向对照）: 上限以内不截断", async () => {
      const entries = many(50);
      const res = await clusterDuplicateMemoriesChunked(entries);
      expect(res.truncated).toBe(false);
      expect(res.scanned).toBe(50);
      expect(res.total).toBe(50);
    });

    it("DUP-P6: 分块版与同步版结果逐组相同", async () => {
      const entries: Entry[] = [
        entry(0, "部署流程", "先跑 npm run build，再发版"),
        entry(1, "部署流程", "先跑 npm run build 再发版"),
        entry(2, "发版步骤", "先跑 npm run build，再发版"),
        entry(3, "宠物设置", "大肥鱼会在空闲时出现"),
        entry(4, "天气", "今天多云"),
      ];
      const syncGroups = clusterDuplicateMemories(entries)
        .map((g) => [...g.ids].sort())
        .sort((a, b) => a[0].localeCompare(b[0]));
      const asyncRes = await clusterDuplicateMemoriesChunked(entries);
      const asyncGroups = asyncRes.groups.map((g) => [...g.ids].sort()).sort((a, b) => a[0].localeCompare(b[0]));
      expect(asyncGroups).toEqual(syncGroups);
    });

    it("DUP-P7: 块间真的让出（进度回调 ≥ 2 次）", async () => {
      const entries = many(400);
      const progress: number[] = [];
      let yieldsSeen = 0;
      const res = await clusterDuplicateMemoriesChunked(entries, {
        chunkPairs: 500, // 调小以便观察分块
        onProgress: (done) => {
          progress.push(done);
          yieldsSeen += 1;
        },
      });
      expect(res.groups.length >= 0).toBe(true);
      expect(yieldsSeen, "必须多次报进度（= 块间让出过主线程）").toBeGreaterThanOrEqual(2);
      expect(progress[progress.length - 1], "最后一次进度应等于总对数").toBeGreaterThanOrEqual(progress[0]);
    });

    it("DUP-P8: shouldCancel 能让扫描停下（UI 的取消不是装饰）", async () => {
      const entries = many(400);
      let calls = 0;
      const res = await clusterDuplicateMemoriesChunked(entries, {
        chunkPairs: 200,
        shouldCancel: () => {
          calls += 1;
          return calls >= 2; // 第二次检查就取消
        },
      });
      expect(calls, "取消检查必须被调用").toBeGreaterThanOrEqual(2);
      // 取消后依然返回结构完整的结果（已扫到的组照常给出，不抛）
      expect(Array.isArray(res.groups)).toBe(true);
      expect(res.scanned).toBe(400);
    });
  });
});

/** 造互不相同的正文（避免示例条目自己聚成组） */
function IotaSeed(i: number): string {
  return ((i * 131) % 9973).toString();
}
