/**
 * TRACE-QUIET —— 破坏性命令留痕的**格式契约**（第 69 轮）。
 *
 * 真机现场（用户贴的启动控制台）：4 条 `storage.compact` 留痕，每条**带 8 行调用栈**：
 * ```text
 * [StorageTrace] storage.compact table= target=""
 *     at ce.command (bootstrap-…js:8:1103)
 *     at D (maintenance-…js:2:3363)
 *     …
 * ```
 * 它们不是错误（compact 是维护每轮启动都会跑的空间回收），但"命令 + 一屏栈"在人眼里就是异常。
 *
 * 口径（由 `formatDestructiveTrace` 单一实现，两处调用点共用）：
 *   · **例行命令（compact）**：一行，**不打栈**；
 *   · **可能删数据的命令（delete / replace_table）**：`warn` + **保留调用栈**（罕见、要取证）；
 *   · 开了诊断开关（`localStorage['codem-debug'] = 'storage-trace'` 或
 *     `window.__CODEM_DEBUG__ = 'storage-trace'`）之后，例行命令**也**打栈。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatDestructiveTrace } from "../core/storage/rust-port";
import { resetDebugCache } from "../core/debug";

const lineCount = (s: string) => s.split("\n").length;
/**
 * "带不带调用栈"的判据：**首行之后还有非空内容**。
 * ⚠️ 不要断言 `/\n\s+at /` —— 测试环境（happy-dom/vitest）里 `Error.stack` 的帧格式与 Node 不同，
 * 第一版就是这么写的，于是"带栈"的两条用例在**正确实现**上红了（假阴性）。
 */
const hasStackTail = (s: string) => s.split("\n").slice(1).join("").trim().length > 0;

beforeEach(() => {
  delete (globalThis as any).__CODEM_DEBUG__;
  try {
    (globalThis as any).localStorage?.removeItem?.("codem-debug");
  } catch {
    /* 非浏览器环境 */
  }
  resetDebugCache();
});

afterEach(() => {
  delete (globalThis as any).__CODEM_DEBUG__;
  resetDebugCache();
});

describe("TRACE-QUIET 破坏性命令留痕", () => {
  it("TRACE-QUIET-1：例行命令（compact）只留一行，不打调用栈", () => {
    const { text, routine } = formatDestructiveTrace("StorageTrace", "storage.compact", 'table= target=""');
    expect(routine, "compact 必须被判为例行命令（级别用 log）").toBe(true);
    expect(lineCount(text), `compact 留痕应当只有一行，实际 ${lineCount(text)} 行：\n${text}`).toBe(1);
    expect(text, "留痕必须仍然说清命令与目标（不能因为去栈就把内容也去了）").toContain("storage.compact");
    expect(text).toContain('target=""');
    expect(text, "不许残留调用栈痕迹").not.toMatch(/\n\s+at /);
  });

  it("TRACE-QUIET-2：可能删数据的命令（delete / replace_table）保留调用栈，且级别是 warn", () => {
    for (const cmd of ["messages.delete", "messages.replace_table"]) {
      const { text, routine } = formatDestructiveTrace("IpcTrace", cmd, "params={}");
      expect(routine, `${cmd} 不能被执行例行命令处理（它可能删数据，要 warn + 带栈）`).toBe(false);
      expect(lineCount(text), `${cmd} 的留痕必须带调用栈`).toBeGreaterThan(1);
      expect(hasStackTail(text), `调用栈不见了（第二行起必须有内容）：\n${text}`).toBe(true);
    }
  });

  it("TRACE-QUIET-3：开了诊断开关后，例行命令**也**打栈（排查时不能丢信息）", () => {
    (globalThis as any).__CODEM_DEBUG__ = "storage-trace";
    resetDebugCache();
    const { text } = formatDestructiveTrace("StorageTrace", "storage.compact", 'table= target=""');
    expect(lineCount(text), "开了 storage-trace 之后应当带调用栈").toBeGreaterThan(1);
    expect(hasStackTail(text), `调用栈不见了（第二行起必须有内容）：\n${text}`).toBe(true);
  });
});
