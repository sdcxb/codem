/**
 * `O-57` 的第三件事：侧栏会话的**显示排序**（两种键 × 两种方向 + 持久化 + 反向对照）。
 *
 * ## 这一族判据各自在挡什么
 *
 * - `SORT-1`：四个组合（最近/名称 × 正序/倒序）的顺序**逐条**断言 ——
 *   它挡的是"只有键生效、方向被忽略"或"只有方向生效"的半成品；
 * - `SORT-2`（反向对照）：**置顶恒在最前**，且置顶内部仍按所选键排 ——
 *   挡"选了名称就把置顶淹掉"（那是把用户的显式分组意图吃掉）；
 * - `SORT-3`（反向对照）：**同名/同时间戳的顺序必须确定**（用 id 兜底）——
 *   排序不稳定时 React 复用节点会看着像"闪"，而且这条也能反证比较器没有漏比较；
 * - `SORT-4`：中文 + 数字标题按 `numeric` 排（"对话 2" 在 "对话 10" 之前）——
 *   挡"用码点比较"（那样 10 会排在 2 前面，中文则按 Unicode 乱序）；
 * - `SORT-5`（反向对照）：它是**纯函数** —— 不改入参、返回新数组；
 * - `SORT-6`：**"选了名称不许再被时间覆盖"** —— 这条是判据要求里点名的反向对照：
 *   两个会话的时间顺序与名称顺序**刻意相反**，选 `name` 时结果必须按名称；
 * - `SORT-7`：偏好落库 + 读回；坏值一律回默认（宽容，不抛）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_SESSION_SORT,
  SESSION_SORT_SETTING_KEY,
  describeSessionSort,
  parseSessionSort,
  readSessionSortPreference,
  sortSessionsForDisplay,
  writeSessionSortPreference,
} from "../core/session/session-sort";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { getSetting } from "../core/storage/settings";

type Row = { id: string; title: string; lastMessageAt: number; pinned?: boolean };

/** 三个会话：时间顺序（t3 > t2 > t1）与名称顺序（甲 < 乙 < 丙）刻意**不同** */
const ROWS: Row[] = [
  { id: "s-b", title: "乙", lastMessageAt: 300 },
  { id: "s-a", title: "甲", lastMessageAt: 100 },
  { id: "s-c", title: "丙", lastMessageAt: 200 },
];

const ids = (rows: Row[]) => rows.map((r) => r.id);

describe("SORT：侧栏会话显示排序（O-57）", () => {
  beforeEach(() => {
    setStoragePort(createFakeStoragePort());
  });

  it("SORT-1：两种键 × 两种方向 —— 四个组合的顺序逐个钉住", () => {
    expect(
      ids(sortSessionsForDisplay(ROWS, { key: "recent", dir: "desc" })),
      "最近对话 · 倒序 = 新的在前（也是默认档）",
    ).toEqual(["s-b", "s-c", "s-a"]);
    expect(
      ids(sortSessionsForDisplay(ROWS, { key: "recent", dir: "asc" })),
      "最近对话 · 正序 = 旧的在前（方向必须真的生效，不是只有键生效）",
    ).toEqual(["s-a", "s-c", "s-b"]);
    expect(
      ids(sortSessionsForDisplay(ROWS, { key: "name", dir: "asc" })),
      "名称 · 正序 = A→Z（这里按拼音：甲/乙/丙 的实际顺序由 localeCompare 给）",
    ).toEqual(ids([...ROWS].sort((a, b) => a.title.localeCompare(b.title))));
    expect(
      ids(sortSessionsForDisplay(ROWS, { key: "name", dir: "desc" })),
      "名称 · 倒序 = Z→A（必须正好是正序的反向）",
    ).toEqual(ids([...ROWS].sort((a, b) => a.title.localeCompare(b.title))).reverse());
  });

  it("SORT-2：置顶恒在最前（不论键与方向），置顶内部仍按所选键排", () => {
    const rows: Row[] = [
      { id: "p-old", title: "置顶-旧", lastMessageAt: 1, pinned: true },
      { id: "p-new", title: "置顶-新", lastMessageAt: 900, pinned: true },
      { id: "n-1", title: "普通一", lastMessageAt: 500 },
      { id: "n-2", title: "普通二", lastMessageAt: 600 },
    ];
    /** 名称键下的期望顺序按同一条 `localeCompare` 现算（这里测的是"置顶优先"，不是中文排序） */
    const byName = (list: Row[], dir: "asc" | "desc") =>
      ids([...list].sort((a, b) => (dir === "asc" ? 1 : -1) * a.title.localeCompare(b.title)));
    const cases: Array<{ pref: { key: "recent" | "name"; dir: "asc" | "desc" }; pinned: string[]; rest: string[] }> = [
      { pref: { key: "recent", dir: "desc" }, pinned: ["p-new", "p-old"], rest: ["n-2", "n-1"] },
      { pref: { key: "recent", dir: "asc" }, pinned: ["p-old", "p-new"], rest: ["n-1", "n-2"] },
      {
        pref: { key: "name", dir: "asc" },
        pinned: byName(rows.filter((r) => r.pinned), "asc"),
        rest: byName(rows.filter((r) => !r.pinned), "asc"),
      },
      {
        pref: { key: "name", dir: "desc" },
        pinned: byName(rows.filter((r) => r.pinned), "desc"),
        rest: byName(rows.filter((r) => !r.pinned), "desc"),
      },
    ];
    for (const c of cases) {
      const order = ids(sortSessionsForDisplay(rows, c.pref));
      expect(
        order.slice(0, 2),
        `置顶会话必须占前两位（${c.pref.key}/${c.pref.dir}）—— 选了名称也不许把置顶淹掉`,
      ).toEqual(c.pinned);
      expect(order.slice(2), `非置顶的两位按所选键排（${c.pref.key}/${c.pref.dir}）`).toEqual(c.rest);
    }
  });

  it("SORT-3：同键值的顺序**确定**（id 兜底；两次调用完全一致）", () => {
    const rows: Row[] = [
      { id: "z", title: "同名", lastMessageAt: 100 },
      { id: "a", title: "同名", lastMessageAt: 100 },
      { id: "m", title: "同名", lastMessageAt: 100 },
    ];
    const first = ids(sortSessionsForDisplay(rows, { key: "recent", dir: "desc" }));
    const second = ids(sortSessionsForDisplay(rows, { key: "recent", dir: "desc" }));
    expect(first, "比较器必须有确定的兜底（否则 Node 的排序实现一变就换位置）").toEqual(["a", "m", "z"]);
    expect(second, "两次调用必须给出同一个顺序（渲染稳定性）").toEqual(first);
  });

  it("SORT-4：标题里的数字按**数值**排（对话 2 在 对话 10 之前）", () => {
    const rows: Row[] = [
      { id: "s10", title: "对话 10", lastMessageAt: 1 },
      { id: "s2", title: "对话 2", lastMessageAt: 2 },
    ];
    expect(
      ids(sortSessionsForDisplay(rows, { key: "name", dir: "asc" })),
      "按码点比较会把 10 排在 2 前面 —— 必须是 localeCompare 的 numeric 语义",
    ).toEqual(["s2", "s10"]);
  });

  it("SORT-5：纯函数 —— 不改入参、返回新数组", () => {
    const input: Row[] = [...ROWS];
    const before = ids(input);
    const out = sortSessionsForDisplay(input, { key: "name", dir: "asc" });
    expect(ids(input), "入参数组的顺序不许被改动（调用方还要用它做别的）").toEqual(before);
    expect(out, "返回的必须是新数组（不是同一个引用）").not.toBe(input);
  });

  it("SORT-6：选了「名称」不许再被时间覆盖（时间顺序与名称顺序刻意相反）", () => {
    const rows: Row[] = [
      { id: "named-first", title: "AAA", lastMessageAt: 1 }, // 最旧
      { id: "named-last", title: "ZZZ", lastMessageAt: 9999 }, // 最新
    ];
    expect(
      ids(sortSessionsForDisplay(rows, { key: "name", dir: "asc" })),
      "按名称正序时必须 AAA 在前 —— 若结果按时间，说明排序键没生效（「选了名称又被时间覆盖」）",
    ).toEqual(["named-first", "named-last"]);
    expect(
      ids(sortSessionsForDisplay(rows, { key: "recent", dir: "desc" })),
      "反向对照：同一批数据按时间倒序时顺序**正好相反** —— 两个键确实在各自生效",
    ).toEqual(["named-last", "named-first"]);
  });

  it("SORT-7：偏好落库 → 读回相等；坏值/缺键一律回默认（宽容，不抛）", () => {
    expect(readSessionSortPreference(), "没有这个键时 = 默认（时间倒序，与升级前逐字一致）").toEqual(
      DEFAULT_SESSION_SORT,
    );

    writeSessionSortPreference({ key: "name", dir: "asc" });
    expect(
      JSON.parse(getSetting(SESSION_SORT_SETTING_KEY) ?? "null"),
      "选择必须真的落进 settings 面（重启后要读得回来）",
    ).toEqual({ key: "name", dir: "asc" });
    expect(readSessionSortPreference(), "读回来的必须与写进去的相等").toEqual({ key: "name", dir: "asc" });

    for (const bad of ["", "{", `{"key":"nope","dir":"desc"}`, `{"key":"recent"}`, "null", "[]", `"recent"`]) {
      expect(parseSessionSort(bad), `坏值必须回默认而不是抛/乱排：${JSON.stringify(bad)}`).toEqual(
        DEFAULT_SESSION_SORT,
      );
    }
    expect(parseSessionSort(`{"key":"recent","dir":"asc"}`), "合法值不许被当成坏值").toEqual({
      key: "recent",
      dir: "asc",
    });
    expect(describeSessionSort({ key: "name", dir: "asc" }).zh).toContain("名称");
  });
});
