/**
 * 事件类型集合的**一致性契约**（第 60 轮）
 *
 * ## 这条缺口是怎么被发现的
 *
 * 第 60 轮查 `session_events` 的 seq 空间时顺手核了一遍事件类型，发现两处**类型在说谎**：
 *
 * 1. `event-projection.ts::validateReplay` 的"已知类型"判据是一串**硬编码 `case`**，
 *    而那份清单**没有 `session_snapshot`** —— 那是引擎把它**字面写死**在
 *    `src-tauri/codem-db/src/repo.rs::events_compact` 的 INSERT 里的类型
 *    （`event_type = 'session_snapshot'`），投影 `applySnapshot` 也真的消费它。
 *    于是这份校验一旦被调用，就会把**合法快照**报成 `Unknown event type`。
 *    （更巧的是：它此前**全仓零调用**，所以这个假报警一直没被人看见 —— 第 60 轮才接进维护。）
 * 2. `event-types.ts` 的 `SessionEventType` 联合类型与 `BUILTIN_EVENT_TYPES` 集合
 *    也是两份清单，同样缺 `session_snapshot`，于是 `isValidEventType("session_snapshot")`
 *    返回 `false`。
 *
 * 修法是**消灭第二份清单**（判据改走 `isValidEventType`）。但"联合类型"与"内建集合"
 * 本身仍然是两份手写清单（一个给编译器看、一个给运行时看），所以这里用一条**源码解析**
 * 的判据把它们钉在一起：谁少写一个，这条用例就红。
 *
 * ## 为什么是解析源码，而不是"导出集合再比对"
 *
 * 导出 `BUILTIN_EVENT_TYPES` 只能证明"运行时集合里有这些"——而漂移恰恰发生在
 * **联合类型那边**（编译器看不到运行时集合，`SessionEventType` 少一个成员时
 * `tsc` 一声不吭）。要抓这种漂移，唯一能读到的"权威文本"就是源码本身。
 * 代价是不走类型系统（源码改写形状就会失效），所以下面配了三条带齿的用例：
 * 两条证明解析器真的会报差异，一条证明它没解析成空集。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { isValidEventType } from "../core/storage/event-types";

const ROOT = path.join(__dirname, "..", "..");
const EVENT_TYPES_SRC = path.join(ROOT, "src", "core", "storage", "event-types.ts");
const REPO_SRC = path.join(ROOT, "src-tauri", "codem-db", "src", "repo.rs");

/** 去掉块注释与行注释 —— 注释里出现的类型名不是成员（否则注释示例会被当成类型） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** `export type SessionEventType = | "a" | "b" ;` → ["a","b"] */
function parseUnionMembers(src: string): string[] {
  const m = /export type SessionEventType\s*=([\s\S]*?);/.exec(stripComments(src));
  if (!m) throw new Error("解析失败：没找到 `export type SessionEventType = …;`（源码形状变了？）");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** `const BUILTIN_EVENT_TYPES = new Set<SessionEventType>([ "a", "b" ]);` → ["a","b"] */
function parseBuiltinMembers(src: string): string[] {
  const m = /const BUILTIN_EVENT_TYPES\s*=\s*new Set<SessionEventType>\(\[([\s\S]*?)\]\)/.exec(
    stripComments(src),
  );
  if (!m) throw new Error("解析失败：没找到 `new Set<SessionEventType>([…])`（源码形状变了？）");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** 两份清单的差集（返回"只在联合里"与"只在内建集合里"） */
function diff(union: string[], builtin: string[]) {
  const u = new Set(union);
  const b = new Set(builtin);
  return {
    onlyInUnion: [...u].filter((x) => !b.has(x)).sort(),
    onlyInBuiltin: [...b].filter((x) => !u.has(x)).sort(),
  };
}

const SRC = fs.readFileSync(EVENT_TYPES_SRC, "utf8");

describe("事件类型：联合类型 ↔ 内建集合（不许再漂）", () => {
  it("TYPE-1: 真实文件里两份清单**逐字相等**（缺一个就红）", () => {
    const union = parseUnionMembers(SRC);
    const builtin = parseBuiltinMembers(SRC);

    // 先证明解析没落空（不是"两边都解析成空集 → 相等"）
    expect(union.length, "联合类型成员数不可能这么少").toBeGreaterThanOrEqual(15);
    expect(builtin.length, "内建集合成员数不可能这么少").toBeGreaterThanOrEqual(15);

    const d = diff(union, builtin);
    expect(d.onlyInUnion, "联合类型里有、内建集合里没有 → isValidEventType 会说它不合法").toEqual([]);
    expect(d.onlyInBuiltin, "内建集合里有、联合类型里没有 → tsc 看不见这个成员").toEqual([]);
  });

  it("TYPE-2: `session_snapshot` 必须同时出现在两份清单里，且运行时认它（这一轮修的就是它）", () => {
    const union = parseUnionMembers(SRC);
    const builtin = parseBuiltinMembers(SRC);

    expect(union, "联合类型缺 session_snapshot").toContain("session_snapshot");
    expect(builtin, "内建集合缺 session_snapshot → isValidEventType 返回 false").toContain(
      "session_snapshot",
    );
    expect(isValidEventType("session_snapshot"), "运行时判据必须认它").toBe(true);
  });

  it("TYPE-3: 引擎侧那个类型名是**字面写死**的（渲染侧不能单方面改名）", () => {
    /*
     * 这条是跨源码的钉子：`events_compact` 的 INSERT 里写的是 `'session_snapshot'`。
     * 引擎一旦改名，渲染侧的联合类型/内建集合/投影分支必须同步 —— 否则真机上
     * 快照事件的类型名会与渲染侧认知不一致。断言用**单引号形式**（SQL 字面量），
     * 避免被别处的注释/字符串碰巧命中。
     */
    const repo = fs.readFileSync(REPO_SRC, "utf8");
    expect(repo.includes("'session_snapshot'"), "引擎不再写这个字面量了？两侧要同步改").toBe(true);
    expect(isValidEventType("session_snapshot")).toBe(true);
  });

  it("TYPE-4: 判据是**真判据**（未注册的名字不许通过；注册后必须通过）", () => {
    const bogus = "not_a_real_event_type_zz";
    expect(isValidEventType(bogus), "未注册的名字必须是 false").toBe(false);
    // 自定义注册路径（插件用）仍然有效 —— 别把"权威集合"做成硬编码封闭集
    // 注意：这里**不改全局注册表**（会污染其它用例），只断言内建集合之外仍另有通路：
    // `registerCustomEventType` 的行为由既有用例守着；这条只钉"bogus 不通过"。
  });
});

describe("事件类型：解析器自身带齿（防止这条契约退化成恒真）", () => {
  it("TYPE-5: 齿① —— 联合类型少一个成员时，差异必须被报出来", () => {
    const builtin = parseBuiltinMembers(SRC);
    const unionMissingOne = parseUnionMembers(SRC).filter((t) => t !== "session_snapshot");

    const d = diff(unionMissingOne, builtin);
    expect(d.onlyInBuiltin, "少了成员却没报差异 = 这条契约不会咬").toEqual(["session_snapshot"]);
  });

  it("TYPE-6: 齿② —— 内建集合多写一个成员时，差异同样必须被报出来", () => {
    const union = parseUnionMembers(SRC);
    const builtinExtra = [...parseBuiltinMembers(SRC), "engine_only_type_zz"];

    const d = diff(union, builtinExtra);
    expect(d.onlyInUnion).toEqual([]);
    expect(d.onlyInBuiltin, "集合里多出来的成员必须被发现").toEqual(["engine_only_type_zz"]);
  });

  it("TYPE-7: 齿③ —— 注释里的类型名不算成员（解析先剥注释）", () => {
    /*
     * 这条守的是"解析器会不会被注释里的示例骗过去"：`event-types.ts` 的注释里
     * 大量出现 `session_snapshot`、`case "session_snapshot"` 这类文本。
     * 若解析器不剥注释，把某个类型**真的删掉**之后它仍会从注释里"读回来"，
     * 于是 TYPE-1 永远绿 —— 一条不会咬的假契约。
     */
    const synthetic = `
export type SessionEventType =
  | "alpha"
  // 注释里提到 "beta" 与 "gamma"
  /* 块注释里也提到 "delta" */
  | "epsilon"
  ;
const BUILTIN_EVENT_TYPES = new Set<SessionEventType>([
  "alpha", // "beta" 只是注释
  "epsilon",
]);
`;
    expect(parseUnionMembers(synthetic)).toEqual(["alpha", "epsilon"]);
    expect(parseBuiltinMembers(synthetic)).toEqual(["alpha", "epsilon"]);
    expect(diff(parseUnionMembers(synthetic), parseBuiltinMembers(synthetic))).toEqual({
      onlyInUnion: [],
      onlyInBuiltin: [],
    });
  });
});
