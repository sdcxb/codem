/**
 * 回滚（revert）不许**静默**留下残留（第 233 轮审计 · P2 假成功）。
 *
 * ## 缺陷形态
 *
 * `FileChangeTracker.revert()` 末尾两段都以 `true` 收场，而它们**可能没做成**：
 *
 * 1. 清理"本轮新建的未跟踪文件"用的是
 *    `Remove-Item -LiteralPath … -Force -ErrorAction SilentlyContinue` ——
 *    `SilentlyContinue` 吞掉所有错误，而调用方连 `exitCode` 都没看：
 *    文件被占用/权限不足 ⇒ 文件还在，`revert()` 照样 `return true`；
 * 2. `updateStatus(...)` 返回 0（那行不存在）只 `console.warn` 后 `return true` ——
 *    变更历史里会一直显示"未回滚"，而界面刚刚告诉用户"已回滚"。
 *
 * 两者都不是"回滚失败"（补丁确实打回去了），所以**不该**改成 `false`；
 * 但"回滚已完成"这句话必须**带条件**：残留必须被计数、并且**对用户可见**
 * （走 `reportPersistFailure`，与仓库其它"写没落地"路径同一通道），
 * 而不是只进渲染侧 console（那个不进 runtime 日志，见 AGENTS §8）。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | REV-1 | `Remove-Item` 返回非 0 ⇒ **必须上报**（不能静默当作已清理干净） |
 * | REV-2 | `updateStatus` 返回 0 ⇒ **必须上报**（不能只 warn） |
 * | REV-3 | 一切成功 ⇒ **不许**上报（反向对照：别把正常回滚做成刺眼告警） |
 *
 * 变异自证：把两处上报改回纯 `console.warn` ⇒ REV-1 / REV-2 立刻红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const persistFailures: Array<{ area: string; consequence?: string }> = [];

vi.mock("../core/storage/persist-failure", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    reportPersistFailure: (area: string, _err: unknown, consequence?: string) => {
      persistFailures.push({ area, consequence });
    },
    reportActionFailure: () => {},
    reportAdvisory: () => {},
  };
});

const updateStatus = vi.fn(async () => 1);
const RECORD = {
  id: "art-1",
  sessionId: "s-1",
  workspace: "C:\\ws",
  patch: "diff --git a/a.ts b/a.ts\n",
  patchTruncated: 0,
  changed_files: JSON.stringify([{ path: "a.ts", status: "A" }]),
  createdAt: 1,
  status: "applied",
} as never;

vi.mock("../core/storage/file-change-storage", () => ({
  FileChangeStorage: {
    updateStatus: (...args: unknown[]) => updateStatus(...(args as [])),
    getByIdAsync: vi.fn(async () => RECORD),
    get: vi.fn(async () => RECORD),
    save: vi.fn(async () => {}),
  },
}));

import { FileChangeTracker } from "../core/environment/file-change-tracker";

const WS = "C:\\ws";

/** execute_command 桩：按命令形状回答 */
function installTauri(opts: { removeExit?: number } = {}) {
  const removeExit = opts.removeExit ?? 0;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          if (cmd !== "execute_command") return undefined;
          const command = String(args.command ?? "");
          if (command.includes("git") && command.includes("apply")) return { exitCode: 0, stdout: "", stderr: "" };
          if (command.includes("ls-files")) return { exitCode: 1, stdout: "", stderr: "not tracked" };
          if (command.includes("Remove-Item")) return { exitCode: removeExit, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    },
  };
}

beforeEach(() => {
  persistFailures.length = 0;
  updateStatus.mockReset();
  updateStatus.mockResolvedValue(1);
  installTauri();
});

afterEach(() => {
  delete (globalThis as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("回滚残留必须可见", () => {
  it("REV-1: Remove-Item 失败（文件被占用）⇒ 必须上报", async () => {
    installTauri({ removeExit: 1 });
    const ok = await FileChangeTracker.revert("art-1", WS);
    expect(ok, "补丁已回滚 ⇒ 仍返回 true（这不是回滚失败）").toBe(true);
    expect(
      persistFailures.some((f) => /revert/i.test(f.area)),
      "清理失败必须上报（否则用户以为工作区已经干净）",
    ).toBe(true);
  });

  it("REV-2: updateStatus 返回 0（记录行不存在）⇒ 必须上报", async () => {
    updateStatus.mockResolvedValue(0);
    const ok = await FileChangeTracker.revert("art-1", WS);
    expect(ok).toBe(true);
    expect(
      persistFailures.some((f) => /revert/i.test(f.area)),
      "状态没写进去必须上报（否则历史里永远显示未回滚）",
    ).toBe(true);
  });

  it("REV-3（反向对照）: 一切顺利 ⇒ 不许上报", async () => {
    updateStatus.mockResolvedValue(1);
    const ok = await FileChangeTracker.revert("art-1", WS);
    expect(ok).toBe(true);
    expect(persistFailures, "正常回滚不该产生告警").toEqual([]);
  });
});
