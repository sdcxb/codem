/**
 * 退出收尾的接线（第 44 轮）。
 *
 * ## 这条测试守的是什么
 *
 * `shutdownRustStoragePort()` 会做两件退出时必须做的事：**排空端口写队列**与 **checkpoint**
 * （把 WAL 并回主库）。而它原来在生产代码里**零调用** —— 也就是说这两件事从来没发生过。
 * 真机实测的形态：写入约 20 MB 之后 WAL 涨到 **30,425.3 KB**，
 * **干净退出后仍然是 30,425.3 KB**（没有 checkpoint），而显式 checkpoint 只要 **10.2 ms**
 * 就能把它归零 —— 退出时 10 毫秒的事被挪到了下次启动（下次要重放 30 MB 的 WAL）。
 *
 * 现在三条退出路径（窗口关闭 / 托盘退出 / 托盘菜单的 `quit-requested` 事件）
 * 统一走 `finalizeBeforeQuit()`。
 *
 * ## 为什么是源码级断言
 *
 * 这三处都在 `App.tsx` 的 React effect / 回调里，退出流程本身**不可在单测里真正触发**
 * （它会调 `quit_app` 结束进程）。所以能守的是**接线**：三处都必须经过同一个函数、
 * 而那个函数必须**同时**排空在途追加与停端口。
 * 真机侧验的是**能力**（`checkpoint` 在打包版上把 WAL 16,706,632 B → 0），
 * 两者合起来才够。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(__dirname, "..", "App.tsx"), "utf8");

describe("退出收尾必须真的执行（finalizeBeforeQuit）", () => {
  it("QUIT-1: 存在统一的收尾函数，且它同时排空在途追加与停端口", () => {
    expect(appSrc, "必须有一个退出收尾函数").toContain("async function finalizeBeforeQuit");
    const body = appSrc.slice(appSrc.indexOf("async function finalizeBeforeQuit"));
    const end = body.indexOf("\n}\n");
    const fn = body.slice(0, end > 0 ? end : 2000);
    expect(fn, "必须排空权威日志的在途追加").toContain("flushSessionLogWrites()");
    expect(fn, "必须停端口（port.stop() = 排空队列 + checkpoint）").toContain("shutdownRustStoragePort");
  });

  it("QUIT-2: 三处退出路径都走它，且**收尾必须发生在 quit_app 之前**", () => {
    const calls = appSrc.match(/await finalizeBeforeQuit\(\);/g) ?? [];
    expect(calls.length, "窗口关闭 / 托盘退出 / quit-requested 三条路径都要收尾").toBeGreaterThanOrEqual(3);

    /*
     * ⚠️ 这一条原本只断言"调用次数 ≥ 3"和"两处 indexOf 都 ≥ 0" —— 那**没有验证顺序**：
     * `quit_app` 会立刻结束 Rust 进程，所以"收尾在它之后"等于没收尾。
     * 对抗性审计指出了这个漏洞（取到 `finAt` 却从未用它做比较），现在逐点比较：
     * 每一处 `quit_app` 之前都必须有一个 `finalizeBeforeQuit`，且距离在**同一个代码块**的量级内
     * （用 400 字符窗口近似"紧邻"，避免跨函数误配）。
     */
    const quitIdx: number[] = [];
    for (let i = appSrc.indexOf('invoke?.("quit_app")'); i >= 0; i = appSrc.indexOf('invoke?.("quit_app")', i + 1)) {
      quitIdx.push(i);
    }
    expect(quitIdx.length, "必须有 quit_app 调用点").toBeGreaterThanOrEqual(3);

    for (const q of quitIdx) {
      const before = appSrc.lastIndexOf("await finalizeBeforeQuit();", q);
      expect(before, `第 ${q} 字符处的 quit_app 之前必须有收尾调用`).toBeGreaterThanOrEqual(0);
      expect(
        q - before,
        `quit_app 之前 ${q - before} 字符处才有收尾 —— 必须紧邻（收尾要先 await 完）`,
      ).toBeLessThan(400);
    }
  });

  it("QUIT-3: 收尾失败不能把退出流程卡死（两条 await 各自兜底）", () => {
    const body = appSrc.slice(appSrc.indexOf("async function finalizeBeforeQuit"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    const tryCount = (fn.match(/try \{/g) ?? []).length;
    expect(tryCount, "两段收尾各自要有 try/catch（退出路径不能再抛）").toBeGreaterThanOrEqual(2);
  });
});
