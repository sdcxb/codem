/**
 * LO-HITSPLIT —— 同一块 bounds 上两个岗位的热区切分（回归）。
 *
 * 真机背景（安装版 1.16.113，任务中心两处场景）：`data/pixel-art.ts` 里
 * `gateway`(前台 · 调度台) 与 `task_queues`(借还台 · 交付) 的 `bounds` **完全相同**
 * （`[700,320,470,300]`，源码注释写的就是"同房间不同锚点"）⇒ 两个 `.lo-pixel-room` 热区逐像素重合，
 * 命中测试取 DOM 靠后的那个 ⇒ `task_queues` 永远赢，`gateway` 在**自己的区域里**
 * 82 点采样「命中自己」= **0**（上轮修好 pointer-events 之后仍是 0）。
 *
 * 判据分层：
 *   · **强判据（真机命中归属）**：`.preview-shot/audit-loroom2-0{1,2}-*.mjs` 的 `elementFromPoint`
 *     + 82 点网格 + 有效可见矩形 —— happy-dom 不做布局、没有真实命中测试，单测测不了这一层。
 *   · **本文件（纯几何判据）**：切分后两块条带①互不重叠②都在原框内③各自含自己的标签锚点
 *     ④按 82 点网格采样各自 ≥20 点（真机脚本同款网格）⑤其余房间完全不受影响。
 *     这能证明"几何上两块都点得到"，**不能**证明真机上没有被别的层吃掉。
 */
import { describe, it, expect } from "vitest";
import { MIN_BAND, gridBandCounts, gridPoints, resolveRoomHitAreas } from "../plugins/library-ops/core/room-hit-area";
import { PIXEL_ROOMS } from "../plugins/library-ops/data/pixel-art";

const input = PIXEL_ROOMS.map((r) => ({ id: r.id, bounds: r.bounds, labelAnchor: r.labelAnchor }));
const areas = resolveRoomHitAreas(input);
const box = PIXEL_ROOMS.find((r) => r.id === "gateway")!.bounds;
const gw = areas.get("gateway")!;
const tq = areas.get("task_queues")!;

const contains = (outer: readonly number[], inner: readonly number[]) =>
  inner[0] >= outer[0] - 1e-9 &&
  inner[1] >= outer[1] - 1e-9 &&
  inner[0] + inner[2] <= outer[0] + outer[2] + 1e-9 &&
  inner[1] + inner[3] <= outer[1] + outer[3] + 1e-9;
const overlapArea = (a: readonly number[], b: readonly number[]) =>
  Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));

describe("LO-HITSPLIT 同 bounds 多岗位热区切分", () => {
  it("LO-HITSPLIT-0（回归前提）：两个岗位的 bounds 与锚点就是真机那组数字", () => {
    expect(tq.bounds).toEqual(gw.bounds);
    expect([...box]).toEqual([700, 320, 470, 300]);
    const g = PIXEL_ROOMS.find((r) => r.id === "gateway")!;
    const t = PIXEL_ROOMS.find((r) => r.id === "task_queues")!;
    expect(g.labelAnchor).toEqual({ x: 845, y: 400 });
    expect(t.labelAnchor).toEqual({ x: 845, y: 434 });
  });

  it("LO-HITSPLIT-1：两块条带互不重叠、都在原框内、每块不小于最小边长", () => {
    expect(gw.split).toBe(true);
    expect(tq.split).toBe(true);
    expect(overlapArea(gw.hit, tq.hit)).toBe(0);
    expect(contains(box, gw.hit)).toBe(true);
    expect(contains(box, tq.hit)).toBe(true);
    expect(Math.min(gw.hit[2], gw.hit[3])).toBeGreaterThanOrEqual(MIN_BAND);
    expect(Math.min(tq.hit[2], tq.hit[3])).toBeGreaterThanOrEqual(MIN_BAND);
    // 两块拼起来正好覆盖原框（没有"谁都点不到"的缝隙，也没有被切掉的部分）
    const union = gw.hit[3] + tq.hit[3];
    expect(union).toBeCloseTo(box[3], 9);
    expect(gw.hit[2]).toBeCloseTo(box[2], 9);
    expect(tq.hit[2]).toBeCloseTo(box[2], 9);
  });

  it("LO-HITSPLIT-2（几何主判据）：两块各自的「命中自己」采样点数 → gateway 0 → 27/82、task_queues → 55/82", () => {
    const cg = gridBandCounts(box, gw.hit);
    const ct = gridBandCounts(box, tq.hit);
    expect(cg.total).toBe(82);
    expect(cg.self).toBe(27); // 改前：0（整块被 task_queues 吃掉）
    expect(ct.self).toBe(55); // 改前：≈74/82（那 8 点是角色精灵/HUD 抢走的，真机脚本量）
    expect(cg.self).toBeGreaterThanOrEqual(20); // 判据：两块各自都要有"能点得到"的余量
    expect(ct.self).toBeGreaterThanOrEqual(20);
    expect(cg.self + ct.self).toBe(82); // 82 个采样点无遗漏、无重复归属
  });

  it("LO-HITSPLIT-3：每块条带都包含自己的标签锚点（点谁的名字附近就选谁）", () => {
    const g = PIXEL_ROOMS.find((r) => r.id === "gateway")!;
    const t = PIXEL_ROOMS.find((r) => r.id === "task_queues")!;
    const inBand = (b: readonly number[], anchor: { x: number; y: number }) =>
      anchor.x >= b[0] && anchor.x <= b[0] + b[2] && anchor.y >= b[1] && anchor.y <= b[1] + b[3];
    expect(inBand(gw.hit, g.labelAnchor)).toBe(true);
    expect(inBand(tq.hit, t.labelAnchor)).toBe(true);
    // 分界线落在两个锚点之间（400 / 434 的中点 417）
    expect(tq.hit[1]).toBeCloseTo(417, 9);
    expect(tq.hit[1]).toBeGreaterThan(g.labelAnchor.y);
    expect(tq.hit[1]).toBeLessThan(t.labelAnchor.y);
  });

  it("LO-HITSPLIT-4：其余 10 个房间完全不受影响（未切分、命中矩形 = bounds）", () => {
    const others = PIXEL_ROOMS.filter((r) => r.id !== "gateway" && r.id !== "task_queues");
    expect(others.length).toBe(10);
    for (const r of others) {
      const a = areas.get(r.id)!;
      expect(a.split).toBe(false);
      expect(a.hit).toEqual([...r.bounds]);
      expect(gridBandCounts(r.bounds, a.hit).self).toBe(82);
    }
    expect(areas.size).toBe(PIXEL_ROOMS.length);
  });

  it("LO-HITSPLIT-5（通用性）：三个岗位同一块框 → 按锚点轴切三条带、逐块非空", () => {
    const box3 = [0, 0, 300, 300] as const;
    const anchors = [40, 150, 260];
    const three = resolveRoomHitAreas([
      { id: "a", bounds: box3, labelAnchor: { x: 60, y: anchors[0] } },
      { id: "b", bounds: box3, labelAnchor: { x: 60, y: anchors[1] } },
      { id: "c", bounds: box3, labelAnchor: { x: 60, y: anchors[2] } },
    ]);
    const hits = ["a", "b", "c"].map((id) => three.get(id)!);
    expect(hits.length).toBe(3);
    expect(hits.every((h) => h.split)).toBe(true);
    // 两两不重叠 + 都含自己的锚点 + 采样点数非空
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) expect(overlapArea(hits[i].hit, hits[j].hit)).toBe(0);
      const h = hits[i].hit;
      expect(anchors[i]).toBeGreaterThanOrEqual(h[1]);
      expect(anchors[i]).toBeLessThanOrEqual(h[1] + h[3]);
      expect(gridBandCounts(box3, h).self).toBeGreaterThan(0);
    }
    // 锚点差异在 y 轴上（x 差 0、y 差 220）→ 沿 y 切：三条带宽度都是整框宽、高度拼回整框
    expect(hits.every((h) => h.hit[2] === 300)).toBe(true);
    expect(hits.map((h) => h.hit[3]).reduce((s, v) => s + v, 0)).toBeCloseTo(300, 9);
    expect(hits[0].hit[1]).toBeCloseTo(0, 9);
    expect(hits[2].hit[1] + hits[2].hit[3]).toBeCloseTo(300, 9);
  });

  it("LO-HITSPLIT-6（通用性）：锚点完全重合时仍切出互不重叠的两块（不退化成重合）", () => {
    const same = resolveRoomHitAreas([
      { id: "a", bounds: [0, 0, 300, 300], labelAnchor: { x: 150, y: 150 } },
      { id: "b", bounds: [0, 0, 300, 300], labelAnchor: { x: 150, y: 150 } },
    ]);
    const a = same.get("a")!;
    const b = same.get("b")!;
    expect(a.split && b.split).toBe(true);
    expect(overlapArea(a.hit, b.hit)).toBe(0);
    // 采样点仍然各自非空（切在正中间 → 底部那块含正中心点）
    expect(gridBandCounts([0, 0, 300, 300], a.hit).self).toBeGreaterThan(0);
    expect(gridBandCounts([0, 0, 300, 300], b.hit).self).toBeGreaterThan(0);
  });

  it("LO-HITSPLIT-7：网格采样工具本身与真机脚本同口径（9×9 + 正中心 = 82 点）", () => {
    const pts = gridPoints([700, 320, 470, 300]);
    expect(pts.length).toBe(82);
    expect(pts).toContainEqual([700 + 470 * 0.1, 320 + 300 * 0.1]);
    expect(pts[pts.length - 1]).toEqual([700 + 235, 320 + 150]); // 正中心在最后一格
  });
});
