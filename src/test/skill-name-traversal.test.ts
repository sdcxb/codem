/**
 * 技能名不得变成路径（第 233 轮审计 · P0 目录穿越）。
 *
 * ## 缺陷形态
 *
 * `installSkillFromZip` 用 **`skill.name` 直接拼安装目录**：
 *
 * ```ts
 * const skillDir = `${skillsDir}${sep}${skill.name}`;   // installer.ts:152
 * const fullPath = `${skillDir}${sep}${relativePath}`;  // :207
 * await writeFile(fullPath, ...);                       // :217/219
 * ```
 *
 * 而 `skill.name` 来自 **SKILL.md 的 `name:` 字段**（`skill.ts:569-571`，`name = value`，零校验）
 * 或**市场条目名**（`preferredName` 直接覆盖，`installer.ts:132-134`）。ZIP 内条目路径有
 * `isSafePath()` 拦 `..`/绝对路径，**但目录名本身没有被拦** ⇒
 * `name: ..\..\..\evil` ⇒ 写到 `%APPDATA%\.codem\skills\..\..\..\evil\SKILL.md`
 * ⇒ **技能根之外任意可写位置**（允许的扩展名里含 `.ps1/.bat/.js`）。
 *
 * 写入侧的 Rust 命令在 `workspace = None` 时**不做沙箱判定**（`write_sandbox_violation`：
 * `let Some(ws) = workspace else { return Ok(None) }`），而技能安装正是无 workspace 的写，
 * 所以这一层也不会兜住。
 *
 * 删除侧同一类问题：`checkDeleteTarget` 只做**词法**比较（不折叠 `..`），
 * 于是 `filePath = <skillsRoot>\..\..\evil` 既不是根、也不以根开头 ⇒ 守卫放行 ⇒
 * `delete_directory_permanent` 删到技能根之外。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SKN-1 | SKILL.md 的 `name` 含 `..` ⇒ **拒绝安装**（不许有文件写到技能根之外） |
 * | SKN-2 | `preferredName`（市场名）含 `..` ⇒ 同样拒绝 |
 * | SKN-3 | 含路径分隔符 / 绝对路径 / 空名的技能名 ⇒ 拒绝 |
 * | SKN-4 | 合法名（含中文、点、下划线、连字符）照旧安装成功（反向对照） |
 * | SKN-5 | 卸载：`filePath` 折叠后落在技能根之外 ⇒ 拒绝删除，且**不调用** `deleteDirectoryPermanent` |
 * | SKN-6 | 卸载：正常的技能目录照旧删除（反向对照） |
 *
 * 变异自证：把 `assertSafeSkillName` 的调用去掉（或让校验恒返回 true）⇒ SKN-1/2/3 立刻红。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";

const writes: Array<{ path: string; content: string }> = [];

vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    writeFile: async (path: string, content: string) => {
      writes.push({ path, content });
    },
    readFile: vi.fn(),
    deletePath: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    deleteDirectoryPermanent: vi.fn(async () => {}),
    listDirectory: vi.fn(async () => []),
    getAppDataDir: vi.fn(async () => "C:\\data\\"),
    executeCommand: vi.fn(),
    isPathWithinWorkspace: vi.fn(() => true),
  };
});

vi.mock("../core/skill/sandbox", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, addInstallAuditEntry: () => {} };
});

vi.mock("../core/skill/skill-delete-diag", () => ({ diagTrail: () => {} }));

import { installSkillFromZip, uninstallSkill } from "../core/skill/installer";
import { getSkillRegistry, isSafeSkillName } from "../core/skill/skill";
import * as fileApi from "../core/file-api";

/** 技能根（与 mock 的 getAppDataDir 对应） */
const SKILLS_ROOT = "C:\\data\\.codem\\skills";

const md = (name: string) => `---\nname: ${name}\ndescription: 测试技能\n---\n# body\n`;

function zipWithSkillMd(name: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ "SKILL.md": strToU8(md(name)), ...extra }, { level: 0 });
}

/** 折叠 `..` 的朴素实现（测试侧判据用，不依赖被测代码） */
function fold(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\//g, "\\").split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("\\");
}

function installTauri() {
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: () => {},
    __TAURI__: { core: { invoke: async () => undefined } },
  };
}

beforeEach(() => {
  writes.length = 0;
  installTauri();
  const registry = getSkillRegistry();
  for (const n of ["evil", "good-skill", "uninst-evil", "uninst-good"]) registry.remove(n);
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe("技能名不得变成路径（安装侧）", () => {
  it("SKN-1: SKILL.md 的 name 含 .. ⇒ 拒绝安装，且没有任何文件写到技能根之外", async () => {
    const res = await installSkillFromZip(zipWithSkillMd("..\\..\\..\\evil"), undefined, true);
    expect(res.success, "带目录穿越的技能名必须被拒绝").toBe(false);
    const escaped = writes.filter((w) => !fold(w.path).toLowerCase().startsWith(fold(SKILLS_ROOT).toLowerCase() + "\\"));
    expect(escaped.map((w) => w.path), "有文件被写到技能根之外").toEqual([]);
  });

  it("SKN-2: preferredName（市场名）含 .. ⇒ 同样拒绝", async () => {
    const res = await installSkillFromZip(zipWithSkillMd("harmless"), undefined, true, "..\\..\\evil2");
    expect(res.success, "市场名含 .. 必须被拒绝").toBe(false);
  });

  it("SKN-3: 含分隔符 / 绝对路径 / `.` / `..` ⇒ 拒绝", async () => {
    for (const bad of ["a/b", "a\\b", "C:\\x", ".", ".."]) {
      const res = await installSkillFromZip(zipWithSkillMd(bad), undefined, true);
      expect(res.success, `技能名 ${JSON.stringify(bad)} 必须被拒绝`).toBe(false);
    }
  });

  it("SKN-3c: 名字校验器本身的形状判据（UNC / 控制字符 / 空白 / 盘符）", () => {
    const bad = ["", "   ", ".", "..", "a/b", "a\\b", "C:\\x", "c:", "\\\\srv\\share", "a\nb", "a\u0000b", "a\u007fb"];
    for (const n of bad) expect(isSafeSkillName(n), `应拒绝 ${JSON.stringify(n)}`).toBe(false);
    const good = ["foo", "good-skill", "中文技能", "a.b_c-1", "  padded  "];
    for (const n of good) expect(isSafeSkillName(n), `应接受 ${JSON.stringify(n)}`).toBe(true);
    expect(isSafeSkillName(42)).toBe(false);
    expect(isSafeSkillName(null)).toBe(false);
  });

  it("SKN-3b: 空名字走「从路径推导」的既有回退 ⇒ 也必须落在技能根之内", async () => {
    // 空 `name:` 是历史兼容路径（parser 用文件名兜底），不能要求它失败，
    // 但"写不写到根外"这条安全性质同样必须成立。
    writes.length = 0;
    const res = await installSkillFromZip(zipWithSkillMd(""), undefined, true);
    if (res.success) {
      for (const w of writes) {
        expect(fold(w.path).toLowerCase().startsWith(fold(SKILLS_ROOT).toLowerCase() + "\\")).toBe(true);
      }
    }
  });

  it("SKN-4（反向对照）: 合法名照旧安装并写到技能根之内", async () => {
    const res = await installSkillFromZip(zipWithSkillMd("good-skill"), undefined, true);
    expect(res.success).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(fold(w.path).toLowerCase().startsWith(fold(SKILLS_ROOT).toLowerCase() + "\\")).toBe(true);
    }
    expect(res.skill?.filePath).toBe(`${SKILLS_ROOT}\\good-skill`);
  });
});

describe("技能名不得变成路径（卸载侧）", () => {
  function register(name: string, filePath: string) {
    getSkillRegistry().register({
      name,
      description: "d",
      prompt: "p",
      filePath,
      source: "user",
      enabled: true,
      contextMode: "inline",
    } as never);
  }

  it("SKN-5: filePath 折叠后越出技能根 ⇒ 拒绝删除，且不调用永久删除", async () => {
    register("uninst-evil", `${SKILLS_ROOT}\\..\\..\\evil`);
    const del = vi.mocked(fileApi.deleteDirectoryPermanent);
    const res = await uninstallSkill("uninst-evil");
    expect(res.success, "越界目标必须拒绝").toBe(false);
    expect(del, "越界目标不许真的去删").not.toHaveBeenCalled();
  });

  it("SKN-6（反向对照）: 正常的技能目录照旧删除", async () => {
    register("uninst-good", `${SKILLS_ROOT}\\uninst-good`);
    const del = vi.mocked(fileApi.deleteDirectoryPermanent);
    const res = await uninstallSkill("uninst-good");
    expect(res.success).toBe(true);
    expect(del).toHaveBeenCalledWith(`${SKILLS_ROOT}\\uninst-good`);
  });
});
