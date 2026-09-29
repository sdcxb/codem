/**
 * 门禁：契约**命名谓词**的行为。
 *
 * ## 为什么单独测谓词
 *
 * 第 121 轮把散落在 7 处的判据收敛成 6 个谓词（`requiresPathGuard` /
 * `mutatesWorkspace` / `needsPreCallSnapshot` / `shouldPersist` /
 * `allowedInReadOnlyMode` / `isShellLike`）。收敛的意义是**判据只有一份**，
 * 所以它必须被直接测到 —— 否则某个谓词悄悄退化（比如漏掉 `destructive` 分支），
 * 而调用点因为数据恰好不触发那个分支，整套测试仍然全绿。
 *
 * 这个文件是**变异自证逼出来的**：M6（把 `needsPreCallSnapshot` 里的
 * `|| contract.destructive` 删掉）当时**没有任何测试变红** —— 说明
 * 「破坏性动作要拍快照」这条能力实际上没被守。补上。
 */
import { describe, it, expect } from "vitest";
import {
  allowedInReadOnlyMode,
  isShellLike,
  mutatesWorkspace,
  needsPreCallSnapshot,
  requiresPathGuard,
  resolveToolContract,
  shouldPersist,
  type ToolContract,
} from "../core/llm/tool-contract";
import { createDefaultToolRegistry } from "../core/llm/tools";

/** 造一个解析后的契约；缺省全走"安全侧"。 */
function c(contract: ToolContract = {}) {
  return resolveToolContract(contract, "test_tool");
}

describe("requiresPathGuard：看「访问边界」而不是「副作用」", () => {
  it("只读但访问工作区 ⇒ 要检查（沙箱要拦工作区外读取）", () => {
    const r = c({ readOnly: true, accessScope: "workspace" });
    expect(r.sideEffectScope).toBe("none"); // 它不改任何东西
    expect(requiresPathGuard(r)).toBe(true); // 但仍要检查路径
  });

  it("不访问外部边界 ⇒ 不检查", () => {
    expect(requiresPathGuard(c({ accessScope: "none" }))).toBe(false);
  });

  it("访问网络/会话 ⇒ 也算访问边界（会走一次取 path，取不到就放行）", () => {
    expect(requiresPathGuard(c({ accessScope: "network" }))).toBe(true);
    expect(requiresPathGuard(c({ accessScope: "session" }))).toBe(true);
  });
});

describe("mutatesWorkspace：只读访问工作区不算改", () => {
  it("read（只读 + workspace 访问）⇒ 不改", () => {
    expect(mutatesWorkspace(c({ readOnly: true, accessScope: "workspace" }))).toBe(false);
  });

  it("write（非只读 + workspace）⇒ 改", () => {
    expect(mutatesWorkspace(c({ sideEffectScope: "workspace" }))).toBe(true);
  });

  it("改会话态不算改工作区", () => {
    expect(mutatesWorkspace(c({ sideEffectScope: "session" }))).toBe(false);
  });
});

describe("needsPreCallSnapshot：改工作区 **或** 破坏性都要快照", () => {
  it("改工作区 ⇒ 要", () => {
    expect(needsPreCallSnapshot(c({ sideEffectScope: "workspace" }))).toBe(true);
  });

  it("只读访问 ⇒ 不要", () => {
    expect(needsPreCallSnapshot(c({ readOnly: true, accessScope: "workspace" }))).toBe(false);
  });

  it("**破坏性但改的不是文件（删笔记/杀任务）⇒ 也要**（这条此前没被守）", () => {
    const del = c({ destructive: true, sideEffectScope: "session" });
    expect(mutatesWorkspace(del)).toBe(false); // 不改工作区……
    expect(needsPreCallSnapshot(del)).toBe(true); // ……但它是不可逆的，要快照
  });

  it("真实 registry 上：破坏性工具都被快照覆盖", () => {
    const registry = createDefaultToolRegistry();
    const destructive = registry.getAll().filter((t) => registry.getContract(t.id).destructive);
    expect(destructive.length, "应当存在破坏性工具，否则这条恒真").toBeGreaterThan(0);
    for (const t of destructive) {
      expect(needsPreCallSnapshot(registry.getContract(t.id)), `${t.id} 应被快照覆盖`).toBe(true);
    }
  });
});

describe("shouldPersist / allowedInReadOnlyMode", () => {
  it("落盘缺省为真；显式 false 才不落盘", () => {
    expect(shouldPersist(c({}))).toBe(true);
    expect(shouldPersist(c({ persistResult: false }))).toBe(false);
  });

  it("计划模式放行只看 readOnly（不看有没有副作用）", () => {
    expect(allowedInReadOnlyMode(c({ readOnly: true }))).toBe(true);
    // 无副作用但会改会话态 ⇒ 仍不是"只读"，计划模式下不放行
    expect(
      allowedInReadOnlyMode(c({ sideEffectScope: "session", accessScope: "session" })),
    ).toBe(false);
  });
});

describe("isShellLike：唯一的按名特例，行为要写清", () => {
  it("bash 恒为真（它的写/读取决于命令，静态声明表达不了）", () => {
    expect(isShellLike("bash", c({ sideEffectScope: "system" }))).toBe(true);
  });

  it("其它 system 类工具也为真（新增系统工具自动纳入，不必改代码）", () => {
    expect(isShellLike("run_code", c({ sideEffectScope: "system" }))).toBe(true);
    expect(isShellLike("terminal_send", c({ sideEffectScope: "system" }))).toBe(true);
  });

  it("非 system 类为假", () => {
    expect(isShellLike("read", c({ readOnly: true, accessScope: "workspace" }))).toBe(false);
    expect(isShellLike("write", c({ sideEffectScope: "workspace" }))).toBe(false);
  });

  it("真实 registry：只读的终端工具**不该**被当成 shell 类（否则命令判定会误伤）", () => {
    const registry = createDefaultToolRegistry();
    // terminal_list / terminal_read 是只读的，它们不带 command 参数
    for (const id of ["terminal_list", "terminal_read"]) {
      const contract = registry.getContract(id);
      expect(contract.readOnly, `${id} 应是只读`).toBe(true);
    }
  });
});
