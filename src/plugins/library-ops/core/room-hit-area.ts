/**
 * 同一块 bounds 上承载多个岗位时的**热区切分** —— 让两个岗位都能点到。
 *
 * 根因（真机 1.16.113）：`data/pixel-art.ts` 里 `gateway`(前台·调度台) 与 `task_queues`(借还台·交付)
 * 的 `bounds` **完全相同**（都是 `[700,320,470,300]`，源码注释写的就是"同房间不同锚点"），
 * 于是两个 `.lo-pixel-room` 热区在场景里**逐像素重合**：
 *   · 命中测试按 DOM 顺序取最上面的那个 ⇒ 靠后的 `task_queues` 永远赢；
 *   · `gateway` 在自己那块区域里 **82 点采样「命中自己」= 0**（改前实测；上轮修好 pointer-events 后仍是 0）。
 *
 * 做法（不挪视觉）：把重合的矩形**按各岗位的标签锚点切成互不重叠的条带**：
 *   · 切分轴 = 锚点差异更大的那根轴（本数据是 y：gateway 锚点 y=400 / task_queues y=434；x 都是 845）；
 *   · 分界线 = 相邻两个锚点坐标的中点（(400+434)/2 = 417），并夹进盒内、保证每块不小于 `minBand`；
 *   · 每块**必然包含自己的锚点** ⇒ "点谁的名字附近就选谁"，锚点也正好是场景里该岗位文字的落点。
 *   视觉（房间框位置/大小、标签）**一个像素都不动** —— 命中与视觉解耦：
 *   模型层给出每间的命中矩形，组件把命中矩形渲染成房间内的 `.lo-pixel-room__hit` 子层。
 *
 * 为什么不用另外两种做法：
 *   · 「给后一个热区内缩一圈」—— 边缘条带只有十几像素，且"中心选谁"与标签位置无关，用户猜不到；
 *   · 「点击两岗之间循环/切换」—— "点一下到底选中谁"不再确定，需要额外的选中态提示才能用，交互成本最高。
 */

/** 热区切分需要的房间信息（= `PixelRoom` 的最小子集） */
export interface HitAreaRoom {
  id: string;
  /** [x, y, w, h]（逻辑坐标，已应用对位覆盖） */
  bounds: readonly [number, number, number, number];
  labelAnchor: { x: number; y: number };
}

/** 单个房间的命中结论 */
export interface RoomHitArea {
  id: string;
  /** 命中矩形 [x, y, w, h]（逻辑坐标；未切分时等于 bounds） */
  hit: [number, number, number, number];
  /** 是否与其他岗位共用同一块 bounds（被切分过） */
  split: boolean;
}

/** 两块 bounds 的交集面积 / 较小者面积 ≥ 该比例 → 视为"同一块 bounds" */
const SAME_BOX_RATIO = 0.9;
/** 每块条带的最小边长（逻辑坐标；画布 1920×1072，24 ≈ 房间短边的 8%） */
export const MIN_BAND = 24;

function area(b: readonly [number, number, number, number]): number {
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

function overlapRatio(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const l = Math.max(a[0], b[0]);
  const t = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, r - l) * Math.max(0, btm - t);
  const min = Math.min(area(a), area(b));
  return min > 0 ? inter / min : 0;
}

/**
 * 按"重合"把房间分组（并查集）。
 * 返回若干组**互不相交**的 id 集合；只用严格的重合判据，避免把相邻房间误并。
 */
function groupOverlapping(rooms: readonly HitAreaRoom[]): string[][] {
  const parent = rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (overlapRatio(rooms[i].bounds, rooms[j].bounds) >= SAME_BOX_RATIO) union(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < rooms.length; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(rooms[i].id);
    else groups.set(root, [rooms[i].id]);
  }
  return [...groups.values()];
}

/**
 * 计算全部房间的命中矩形。
 * @param rooms 房间列表（**顺序 = DOM 渲染顺序**；只在切分轴的分界线计算中作为稳定性兜底）
 * @param minBand 每条条带的最小边长（逻辑坐标）
 */
export function resolveRoomHitAreas(
  rooms: readonly HitAreaRoom[],
  minBand: number = MIN_BAND,
): Map<string, RoomHitArea> {
  const out = new Map<string, RoomHitArea>();
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const groups = groupOverlapping(rooms);

  for (const ids of groups) {
    if (ids.length === 1) {
      const r = byId.get(ids[0])!;
      out.set(r.id, { id: r.id, hit: [...r.bounds] as [number, number, number, number], split: false });
      continue;
    }
    const group = ids.map((id) => byId.get(id)!);
    const box = group[0].bounds;
    const [bx, by, bw, bh] = box;

    // 切分轴：锚点差异更大的那根轴；完全相同时按 y（同一张图里 y 差 = 房间内上下分层）
    const xs = group.map((r) => r.labelAnchor.x);
    const ys = group.map((r) => r.labelAnchor.y);
    const spreadX = Math.max(...xs) - Math.min(...xs);
    const spreadY = Math.max(...ys) - Math.min(...ys);
    const axis: "x" | "y" = spreadX > spreadY ? "x" : "y";

    // 按锚点在切分轴上的位置排序（稳定：相同坐标保持输入顺序）
    const ordered = group
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const av = axis === "x" ? a.r.labelAnchor.x : a.r.labelAnchor.y;
        const bv = axis === "x" ? b.r.labelAnchor.x : b.r.labelAnchor.y;
        return av === bv ? a.i - b.i : av - bv;
      })
      .map((e) => e.r);

    const lo = axis === "x" ? bx : by;
    const size = axis === "x" ? bw : bh;
    const hi = lo + size;
    const band = Math.max(1, Math.min(minBand, size / (ordered.length * 2)));

    // 分界线 = 相邻锚点中点，逐个夹进 [lo+band, hi-band] 并保持严格递增
    const edges: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      const prev = axis === "x" ? ordered[i - 1].labelAnchor.x : ordered[i - 1].labelAnchor.y;
      const cur = axis === "x" ? ordered[i].labelAnchor.x : ordered[i].labelAnchor.y;
      let edge = (prev + cur) / 2;
      edge = Math.min(Math.max(edge, lo + band), hi - band);
      const last = edges.length ? edges[edges.length - 1] : lo + band;
      edges.push(Math.max(edge, last + 1));
    }

    for (let i = 0; i < ordered.length; i++) {
      const start = i === 0 ? lo : edges[i - 1];
      const end = i === ordered.length - 1 ? hi : edges[i];
      const hit: [number, number, number, number] =
        axis === "x" ? [start, by, end - start, bh] : [bx, start, bw, end - start];
      out.set(ordered[i].id, { id: ordered[i].id, hit, split: true });
    }
  }
  return out;
}

/**
 * 把**房间整框**按 82 点网格采样（9×9 + 正中心），统计有多少个采样点落在给定热区内。
 *
 * 口径与真机脚本 `ROOM_PROBE` 逐点一致（都是按矩形 1/10…9/10 与 0.5 取样，点在框内才采）：
 * 真机脚本用**房间整框**的 82 个采样点做 `elementFromPoint`，看命中的是谁；
 * 这里用同一批点做**纯几何**归属判断，于是"切分后两块各自有多少点"可以在单测里钉住。
 * 注意：这只证明几何上两块都非空、量级相当；**真机命中归属**（谁在上面、有没有别的层吃掉）
 * 仍只能由 CDP 脚本承担 —— happy-dom 不做布局、也没有 `elementFromPoint`。
 */
export function gridBandCounts(
  box: readonly [number, number, number, number],
  band: readonly [number, number, number, number],
  gridN = 9,
): { self: number; total: number } {
  const fr: number[] = [];
  for (let i = 1; i <= gridN; i++) fr.push(i / (gridN + 1));
  const pts: Array<[number, number]> = [];
  for (const fx of fr) for (const fy of fr) pts.push([fx, fy]);
  pts.push([0.5, 0.5]);
  const [bx, by, bw, bh] = box;
  const [x, y, w, h] = band;
  const inBand = (px: number, py: number) => px >= x - 1e-9 && px <= x + w + 1e-9 && py >= y - 1e-9 && py <= y + h + 1e-9;
  const self = pts.filter(([fx, fy]) => inBand(bx + bw * fx, by + bh * fy)).length;
  return { self, total: pts.length };
}

/** 在框内取 82 个采样点（真机脚本同款网格），供脚本/测试复用 */
export function gridPoints(box: readonly [number, number, number, number], gridN = 9): Array<[number, number]> {
  const fr: number[] = [];
  for (let i = 1; i <= gridN; i++) fr.push(i / (gridN + 1));
  const pts: Array<[number, number]> = [];
  for (const fx of fr) for (const fy of fr) pts.push([box[0] + box[2] * fx, box[1] + box[3] * fy]);
  pts.push([box[0] + box[2] / 2, box[1] + box[3] / 2]);
  return pts;
}
