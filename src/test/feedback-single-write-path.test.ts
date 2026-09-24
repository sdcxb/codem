/**
 * 反馈：**唯一写路径**（第 72 轮审计，关闭第 45 轮 P2-D9 的残余）
 *
 * ## 删除的是什么（以及为什么必须删而不是修）
 *
 * `message.ts` 里原来有一对东西：`feedbackCache`（写穿缓存）与 `saveFeedback`
 * （走引擎的 `feedback.set`，**5 列、且不写域镜像**）。审计确认：
 *
 * - `saveFeedback` 的**生产调用者为 0**（只有测试与注释提到它）；
 * - 它是一条"镜像看不见的写"：引擎里有、镜像里没有 ⇒ 读路径读镜像时**写了却读不到**；
 * - 那份缓存的唯一作用退化成"把旧值钉住"（取消点赞之后界面仍显示已赞）。
 *
 * 修法是**删掉重复实现**：写只剩 `core/llm/feedback.ts` 的
 * `putMessageFeedback` / `deleteMessageFeedback`（域写 `crud.upsert` / `crud.delete`），
 * 读只剩 `message.ts::loadFeedback`（域镜像）。"镜像里没有的那份写"从根上没有了。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | FB-1 | `message.ts` 不再导出 `saveFeedback` / `invalidateFeedbackCache`（第二条写路径不存在） |
 * | FB-2 | **整棵生产源码树**里不再出现 `feedback.set` / `feedbackCache` / `invalidateFeedbackCache` |
 * | FB-3 | 读路径只有域镜像（`loadFeedback` 走 `domainReadOne(FEEDBACK_TABLE, …)`） |
 * | FB-4 | 行为：写完立刻读得到 → 改评读到新值 → 取消读到"没有"（且端口那行真的没了） |
 * | FB-5 | 域写是 9 列超集：`note / version / created_at / updated_at` 必须落库（5 列轻量写会抹成 NULL） |
 * | FB-6 | **引擎侧**也不再提供 `feedback.set/get/delete`（命令清单 + 派发分支 + 实现三处都不留） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { resetPersistFailures } from "../core/storage/persist-failure";

const SESSION = "s-fb-single";

const ROOT = process.cwd();
const MESSAGE_REL = "src/core/storage/message.ts";
const FEEDBACK_REL = "src/core/llm/feedback.ts";
const STORE_REL = "src/store.ts";

/** 去注释后再搜（**本文件的判据必须能区分"代码里没有"和"注释里说过它没有"**） */
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 生产源码树（`src/**`，排除测试与夹具 —— 测试里合法地讲这些名字） */
function walkProdSources(): string[] {
  const out: string[] = [];
  const stack = ["src"];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (rel === "src/test" || entry.name === "node_modules") continue;
        stack.push(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(rel);
      }
    }
  }
  return out;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  resetPersistFailures();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { setStoragePort } = await import("../core/storage/port");
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
});

/** 一个 `message_feedback` 镜像已就绪的假端口（域写/域读都能走通） */
async function readyPort() {
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  const port = createFakeStoragePort({ seed: {} });
  await port.config.warmup();
  setStoragePort(port);
  port.domains.ensureLoaded("settings");
  port.domains.ensureLoaded("message_feedback");
  await flush();
  return port;
}

const fbRows = (port: { __table: (t: string) => Record<string, unknown>[] }) => port.__table("message_feedback");

describe("反馈的唯一写路径（第 72 轮审计）", () => {
  it("FB-1: `message.ts` 不再导出遗留的 `saveFeedback` / `invalidateFeedbackCache`", async () => {
    const MessageStorage = await import("../core/storage/message");
    const mod = MessageStorage as unknown as Record<string, unknown>;
    expect(
      mod.saveFeedback,
      "遗留写路径必须删掉而不是留着——留着就是'引擎里有、镜像里没有'的第二条真相",
    ).toBeUndefined();
    expect(
      mod.invalidateFeedbackCache,
      "缓存本体已删除，'让缓存失效'这个函数不该再存在（否则有人会以为还有缓存要维护）",
    ).toBeUndefined();
  });

  it("FB-2: 生产代码里不再出现 `feedback.set` / `feedbackCache` / `invalidateFeedbackCache`（全树扫描）", () => {
    /*
     * ⚠️ 扫描范围是**整棵生产源码树**（`src/**`，排除 `src/test/**`），不是白名单里那三个文件。
     * 理由：这三个符号代表的是"第二条写路径"与"把旧值钉住的缓存"，
     * 它们出现在**任何**一个生产文件里都意味着同一条缺陷在别处复活 ——
     * 白名单式的写法只能守住"我知道的那三个地方"。
     *
     * `src/test/**` 排除在外：测试里合法地提到这些名字（讲清"为什么删了它"），
     * 而假端口**不再**实现 `feedback.set`（引擎侧命令已删除）。
     */
    /*
     * 针脚写成**带引号的字符串字面量**：引擎命令只能以字符串形式出现，
     * 而 `this.feedback.set(...)`（`command-feedback-provider.ts` 里的 Map.set）
     * 这类同名方法会污染裸名字匹配 —— 假阳性会让门禁被"绕过"而不是被信任。
     *
     * ⚠️ 这里**不**扫 `"feedback.delete"`：它同时是上报通道的 area 名
     * （`domainDelete(..., { scope: "feedback.delete" })`），是**合法且必要**的。
     * 那条命令是否复活由 FB-6 在**引擎命令清单**上判（那才是它的真源）。
     */
    const needles = ['"feedback.set"', '"feedback.get"', "feedbackCache", "invalidateFeedbackCache"];
    const offenders: string[] = [];
    const files: string[] = [MESSAGE_REL, FEEDBACK_REL, STORE_REL];
    for (const f of walkProdSources()) files.push(f);
    for (const rel of new Set(files)) {
      const code = codeOf(rel);
      for (const n of needles) if (code.includes(n)) offenders.push(`${rel} → ${n}`);
    }
    expect(offenders, `这些位置又出现了被删除的遗留写路径/缓存：${offenders.join("，")}`).toEqual([]);

    // 正向：`store.ts` 的 setFeedback 只调域写（删掉的是"同时发两条写"的第一条）
    const store = codeOf(STORE_REL);
    expect(store, "setFeedback 必须调域写").toContain("putMessageFeedback(");
    expect(store, "不再有第二条写（MessageStorage.saveFeedback）").not.toContain("saveFeedback");
  });

  it("FB-6: 引擎侧也不再提供 `feedback.set/get/delete`（专用命令已删除，表只走 crud.*）", () => {
    /*
     * 渲染侧不调用 ≠ 缺口关闭：只要引擎**还在提供**那条 5 列窄写命令，
     * 下一个接手的人就可能把它请回来（当年的 store.ts 正是这么写的）。
     * 所以判据落在引擎的**命令清单**上 —— 它同时也是 `commands` 子命令的自省来源。
     */
    const lib = fs.readFileSync(path.join(ROOT, "src-tauri/codem-db/src/lib.rs"), "utf8");
    const block = /pub const COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/.exec(lib);
    expect(block, "必须能从 lib.rs 解析出 COMMANDS 清单").toBeTruthy();
    const commands = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(commands, "命令清单不该非空（否则这条用例是空转）").not.toHaveLength(0);
    for (const dead of ["feedback.set", "feedback.get", "feedback.delete"]) {
      expect(commands, `引擎不该再提供 ${dead}（零调用者 + 5 列窄写会抹掉 note/version）`).not.toContain(dead);
    }
    // 反向：通用仓储命令必须在（这张表的新家）
    for (const alive of ["crud.list", "crud.upsert", "crud.delete"]) {
      expect(commands, `message_feedback 现在只走通用仓储命令，${alive} 必须在`).toContain(alive);
    }
    // 派发分支也不能留（清单删了、分支还在 = 半删除）
    expect(lib, "派发分支里不该还有 feedback.set").not.toContain("config::feedback_set");
    const config = fs.readFileSync(path.join(ROOT, "src-tauri/codem-db/src/config.rs"), "utf8");
    expect(config, "config.rs 里不该还有 feedback_set 实现").not.toContain("pub fn feedback_set");
    expect(config, "config.rs 里不该还有 feedback_get 实现").not.toContain("pub fn feedback_get");
    expect(config, "config.rs 里不该还有 feedback_delete 实现").not.toContain("pub fn feedback_delete");
  });

  it("FB-3: 读路径只有域镜像（不是缓存、不是旧库）", () => {
    const code = codeOf(MESSAGE_REL);
    const start = code.indexOf("export function loadFeedback");
    expect(start, "loadFeedback 必须还在").toBeGreaterThan(-1);
    const body = code.slice(start, start + 900);
    expect(body, "读路径必须走域镜像").toContain("domainReadOne");
    expect(body, "读的是反馈表").toContain("FEEDBACK_TABLE");
    expect(body, "读到的值必须做合法值判定（不许把任意字符串当评级）").toContain('"dislike"');
  });

  it("FB-4: 写完立刻读得到 → 改评读到新值 → 取消读到'没有'", async () => {
    const port = await readyPort();
    const { putMessageFeedback } = await import("../core/llm/feedback");
    const { loadFeedback } = await import("../core/storage/message");

    // 镜像接手是异步的 → 重试本身也是判据（一直不接手就是失败）
    await vi.waitFor(() => {
      const res = putMessageFeedback(SESSION, "m-fb", "like");
      expect(res.ok, `写入未被镜像接手：${res.ok ? "" : res.error}`).toBe(true);
    });
    expect(loadFeedback("m-fb"), "域写先改镜像 ⇒ 写完必须立刻读得到（原来只有缓存能给出这个性质）").toBe(
      "like",
    );
    expect(fbRows(port as never).filter((r) => r.message_id === "m-fb")).toHaveLength(1);

    const changed = putMessageFeedback(SESSION, "m-fb", "dislike");
    expect(changed.ok, `改评失败：${changed.ok ? "" : changed.error}`).toBe(true);
    expect(loadFeedback("m-fb"), "改评必须读到新值（缓存版本会永远返回 like）").toBe("dislike");

    const cleared = putMessageFeedback(SESSION, "m-fb", "neutral");
    expect(cleared.ok, `取消失败：${cleared.ok ? "" : cleared.error}`).toBe(true);
    expect(loadFeedback("m-fb"), "取消 = 表里没有那一行").toBeNull();
    expect(
      fbRows(port as never).filter((r) => r.message_id === "m-fb"),
      "取消必须真的删掉那一行（不是写一个 neutral —— 表上的 CHECK 不允许）",
    ).toHaveLength(0);
  });

  it("FB-5: 域写是 9 列超集（note / version / created_at / updated_at 必须落库）", async () => {
    const port = await readyPort();
    const { putMessageFeedback } = await import("../core/llm/feedback");

    await vi.waitFor(() => {
      const res = putMessageFeedback(SESSION, "m-fb9", "like", "这条回复有用");
      expect(res.ok, `写入未被镜像接手：${res.ok ? "" : res.error}`).toBe(true);
    });

    const row = fbRows(port as never).find((r) => r.message_id === "m-fb9");
    expect(row, "反馈行必须存在").toBeTruthy();
    expect(row!.session_id).toBe(SESSION);
    expect(row!.feedback).toBe("like");
    expect(row!.note, "note 必须落库（5 列轻量写会把它抹成 NULL）").toBe("这条回复有用");
    expect(String(row!.version ?? ""), "version 必须落库（乐观并发的 token）").not.toBe("");
    expect(Number(row!.created_at), "created_at 必须落库").toBeGreaterThan(0);
    expect(Number(row!.updated_at), "updated_at 必须落库").toBeGreaterThan(0);
  });
});
