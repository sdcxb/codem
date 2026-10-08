/**
 * 技能市场安装：**部分失败必须如实报**（第 184 波 F2 / F3）。
 *
 * ## 两个缺陷形态（同一条纪律的两份实现）
 *
 * - **F2**（`installGitHubDir` 路径，`skill-market-client.ts`）：逐文件 `httpGet`，
 *   非 200 或写盘失败只 `console.warn`/`continue`，**唯一**失败判据是 `filesWritten === 0`
 *   ⇒ 10 个里 9 个因限流/403 失败也报「安装成功」并登记为可用；审计哈希
 *   （`computeContentHash`）还覆盖了"下载成功"的子集，与磁盘上的技能不等价。
 * - **F3**（`installSkillFromZipFiltered`）：跳过不记账、0 文件报成功、
 *   二进制（`.png/.jpg/.gif/.ico`）被 `strFromU8` + 文本 `writeFile` **按 UTF-8 写坏**。
 *
 * 两套真相对照：`installer.ts:211-237` 同类情形会带 `skipped` + `warning`。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SKILL-F2-1 | 部分文件下载失败 ⇒ **不许** success；如实给出"成功几个 / 失败几个 / 为什么" |
 * | SKILL-F2-2 | 写盘失败同样如实报（不许当成功） |
 * | SKILL-F2-3 | 半成品**不写安装审计**（哈希只对"真的装上的那份"算） |
 * | SKILL-F3-1 | 二进制按字节写盘（`{encoding:'base64'}` + 解码后与原字节一致） |
 * | SKILL-F3-2 | 跳过（扩展名/过大）必须**记账**，并如实带 warning |
 * | SKILL-F3-3 | 一个文件都没写进去 ⇒ **失败**（不许报成功） |
 * | SKILL-F3-4 | 写盘失败 ⇒ 失败（不是"跳过"） |
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync, strToU8 } from "fflate";

/** 记录每一次写盘（路径 / 内容 / 选项）—— 字节一致性的唯一取证处 */
const writes: Array<{ path: string; content: string; options?: Record<string, unknown> }> = [];
let writeShouldThrow: (path: string) => boolean = () => false;

const addAuditSpy = vi.fn();

vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    writeFile: async (path: string, content: string, options?: Record<string, unknown>) => {
      if (writeShouldThrow(path)) throw new Error("磁盘满（模拟写盘失败）");
      writes.push({ path, content, options });
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
  return { ...actual, addInstallAuditEntry: (...args: unknown[]) => addAuditSpy(...args) };
});

import { installMarketSkill, type MarketSkill } from "../core/skill/skill-market-client";
import { u8ToBase64 } from "../core/file-api";

/** 假 Tauri 运行时：只回答安装路径真正会用的三条命令 */
function setupTauri(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
  (globalThis as any).window = {
    dispatchEvent: () => {},
    __TAURI__: { core: { invoke: async (cmd: string, args: Record<string, unknown>) => handler(cmd, args) } },
  };
}

// ========== 工具 ==========

const md = (name: string) => `---\nname: ${name}\ndescription: 测试技能\n---\n# ${name}\n正文\n`;

/** 造一个"已经下到临时文件"的 ZIP（走 `installSkillFromZipFiltered` 那条路） */
function zipInstall(skillName: string, entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries, { level: 0 });
}

function marketSkill(name: string, patch: Partial<MarketSkill> = {}): MarketSkill {
  return {
    id: `t-${name}`,
    name,
    displayName: name,
    description: "d",
    sourceId: "t-src",
    sourceName: "T",
    downloadUrl: "https://example.com/skill.zip",
    installType: "dir",
    ...patch,
  };
}

let zipBytes: Uint8Array = new Uint8Array();

beforeEach(() => {
  writes.length = 0;
  addAuditSpy.mockClear();
  writeShouldThrow = () => false;
  zipBytes = new Uint8Array();
});

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

// ========== F3：ZIP 目录过滤安装 ==========

describe("ZIP 目录过滤安装（第 184 波 F3）", () => {
  it("SKILL-F3-1: 二进制资源按**字节**写盘（不再被 UTF-8 解码破坏）", async () => {
    // 一段**非法 UTF-8** 的字节序列（真实 PNG 头 + 若干高位字节）
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd8, 0xfe, 0x00, 0x80, 0x7f]);
    zipBytes = zipInstall("foo", {
      "repo-abc/skills/foo/SKILL.md": strToU8(md("foo")),
      "repo-abc/skills/foo/icon.png": png,
      "repo-abc/skills/foo/notes.txt": strToU8("hello"),
    });
    setupTauri((cmd) => {
      if (cmd === "get_app_data_dir") return "C:\\data\\";
      if (cmd === "http_download") return "";
      if (cmd === "read_file") return Buffer.from(zipBytes).toString("base64");
      throw new Error(`未预期的命令：${cmd}`);
    });

    const res = await installMarketSkill(marketSkill("foo", { dirPath: "skills/foo" }), undefined, true);
    expect(res.success, "全部文件都写成功 ⇒ 成功").toBe(true);

    const pngWrite = writes.find((w) => w.path.endsWith("icon.png"));
    expect(pngWrite, "图标必须被写盘").toBeTruthy();
    expect(
      pngWrite!.options?.encoding,
      "二进制必须走 writeFile(..., {encoding:'base64'})；改前是 strFromU8 + 文本写盘 ⇒ 字节被替换字符破坏",
    ).toBe("base64");
    expect(
      Array.from(Buffer.from(pngWrite!.content, "base64")),
      "解码后必须与原字节**逐字节一致**",
    ).toEqual(Array.from(png));

    // 文本仍然按 UTF-8 文本写（别把好的弄坏）
    const txtWrite = writes.find((w) => w.path.endsWith("notes.txt"));
    expect(txtWrite!.content).toBe("hello");
    expect(txtWrite!.options?.encoding).toBeUndefined();
  });

  it("SKILL-F3-1b: u8ToBase64 是逐字节编码（不是 UTF-8 往返）", () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0xc3, 0x28]);
    expect(Array.from(Buffer.from(u8ToBase64(bytes), "base64"))).toEqual(Array.from(bytes));
  });

  it("SKILL-F3-2: 跳过的文件必须**记账**（扩展名不在白名单）并如实带 warning", async () => {
    zipBytes = zipInstall("bar", {
      "repo-abc/skills/bar/SKILL.md": strToU8(md("bar")),
      "repo-abc/skills/bar/notes.txt": strToU8("ok"),
      "repo-abc/skills/bar/payload.dat": strToU8("不在白名单里"),
    });
    setupTauri((cmd) => {
      if (cmd === "get_app_data_dir") return "C:\\data\\";
      if (cmd === "http_download") return "";
      if (cmd === "read_file") return Buffer.from(zipBytes).toString("base64");
      throw new Error(`未预期的命令：${cmd}`);
    });

    const res = await installMarketSkill(marketSkill("bar", { dirPath: "skills/bar" }), undefined, true);

    expect(res.success).toBe(true);
    expect(res.filesWritten).toBe(2);
    expect(
      res.skipped?.map((s) => s.path),
      "改前是裸 continue —— 一个都不记，调用方以为技能是完整装上的",
    ).toEqual(["payload.dat"]);
    expect(res.skipped?.[0]?.reason).toContain(".dat");
    expect(res.warning, "要如实说技能可能不完整").toContain("跳过");
  });

  it("SKILL-F3-3: 一个文件都没写进去 ⇒ 必须报失败（零文件判据）", async () => {
    // SKILL.md 超过 1MB ⇒ 连它一起被跳过 ⇒ filesWritten === 0
    const bigMd = `${md("big")}${"x".repeat(1024 * 1024 + 32)}`;
    zipBytes = zipInstall("big", { "repo-abc/skills/big/SKILL.md": strToU8(bigMd) });
    setupTauri((cmd) => {
      if (cmd === "get_app_data_dir") return "C:\\data\\";
      if (cmd === "http_download") return "";
      if (cmd === "read_file") return Buffer.from(zipBytes).toString("base64");
      throw new Error(`未预期的命令：${cmd}`);
    });

    const res = await installMarketSkill(marketSkill("big", { dirPath: "skills/big" }), undefined, true);

    expect(res.success, "改前这里没有零文件判据，照样报 success:true + 「安装成功！」").toBe(false);
    expect(res.filesWritten).toBe(0);
    expect(res.error).toContain("全部被跳过");
    expect(res.skipped?.length, "被跳过的原因要能诊断").toBeGreaterThan(0);
  });

  it("SKILL-F3-4: 写盘失败 ⇒ 失败（不是可忽略的「跳过」）", async () => {
    zipBytes = zipInstall("baz", {
      "repo-abc/skills/baz/SKILL.md": strToU8(md("baz")),
      "repo-abc/skills/baz/run.py": strToU8("print(1)"),
    });
    writeShouldThrow = (p) => p.endsWith("run.py");
    setupTauri((cmd) => {
      if (cmd === "get_app_data_dir") return "C:\\data\\";
      if (cmd === "http_download") return "";
      if (cmd === "read_file") return Buffer.from(zipBytes).toString("base64");
      throw new Error(`未预期的命令：${cmd}`);
    });

    const res = await installMarketSkill(marketSkill("baz", { dirPath: "skills/baz" }), undefined, true);

    expect(res.success, "脚本没装上就报成功 = 半成品假成功").toBe(false);
    expect(res.error).toContain("写盘失败");
    expect(res.skipped?.some((s) => s.path === "run.py" && s.reason.includes("写盘失败"))).toBe(true);
  });
});

// ========== F2：GitHub 目录逐文件下载 ==========

describe("GitHub 目录安装：逐文件失败（第 184 波 F2）", () => {
  /**
   * ⚠️ 每个用例用**不同的仓库名**：`repoTreeCache` 是模块级的（30 分钟 TTL），
   * 同一个 owner/repo 会让后一个用例拿到前一个用例的文件树（夹具串味）。
   */
  function setupGithub(
    repo: string,
    opts: { rawStatus: Record<string, number>; tree: Array<{ path: string; size: number }> },
  ) {
    setupTauri((cmd, args) => {
      if (cmd === "get_app_data_dir") return "C:\\data\\";
      const url = String(args?.url ?? "");
      if (url === `https://api.github.com/repos/${repo}`) {
        return { status: 200, body: JSON.stringify({ default_branch: "main" }), headers: {} };
      }
      if (url.includes(`/repos/${repo}/git/trees/`)) {
        return {
          status: 200,
          body: JSON.stringify({
            sha: "s",
            tree: opts.tree.map((e) => ({ path: e.path, type: "blob", size: e.size })),
          }),
          headers: {},
        };
      }
      if (url.includes("raw.githubusercontent.com")) {
        const rel = url.split("/main/")[1] ?? "";
        const status = opts.rawStatus[rel] ?? 200;
        return { status, body: status === 200 ? md("f2-partial") : "", headers: {} };
      }
      throw new Error(`未预期的 URL：${url}`);
    });
  }

  it("SKILL-F2-1: 部分文件下载失败 ⇒ 不许报成功，且如实给出成功/失败/原因", async () => {
    const repo = "f2-owner/f2-repo-partial";
    setupGithub(repo, {
      tree: [
        { path: "skills/foo/SKILL.md", size: 80 },
        { path: "skills/foo/main.py", size: 40 },
        { path: "skills/foo/helper.md", size: 40 },
      ],
      rawStatus: {
        "skills/foo/SKILL.md": 200,
        "skills/foo/main.py": 403, // 限流/权限：拿不到
        "skills/foo/helper.md": 200,
      },
    });

    const res = await installMarketSkill(
      marketSkill("f2-partial", { repoFullName: repo, dirPath: "skills/foo", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success, "10 个里 9 个失败也报成功 —— 这就是被修的假成功").toBe(false);
    expect(res.filesWritten, "成功几个要说清").toBe(2);
    expect(res.skipped?.map((s) => s.path), "失败几个 + 是哪些").toEqual(["main.py"]);
    expect(res.skipped?.[0]?.reason, "为什么").toContain("403");
    expect(res.error).toMatch(/成功 2 个/);
    expect(res.error).toMatch(/失败 1 个/);
    expect(addAuditSpy, "半成品不许登记安装审计").not.toHaveBeenCalled();
  });

  it("SKILL-F2-2: 写盘失败同样如实报（不许当成功）", async () => {
    const repo = "f2-owner/f2-repo-writefail";
    setupGithub(repo, {
      tree: [
        { path: "skills/foo/SKILL.md", size: 80 },
        { path: "skills/foo/main.py", size: 40 },
      ],
      rawStatus: { "skills/foo/SKILL.md": 200, "skills/foo/main.py": 200 },
    });
    writeShouldThrow = (p) => p.endsWith("main.py");

    const res = await installMarketSkill(
      marketSkill("f2-writefail", { repoFullName: repo, dirPath: "skills/foo", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success).toBe(false);
    expect(res.skipped?.[0]?.reason).toContain("写盘失败");
    expect(addAuditSpy).not.toHaveBeenCalled();
  });

  it("SKILL-F2-3: 全部失败 ⇒ 失败，并列出原因（不是一句「所有文件下载失败」了事）", async () => {
    const repo = "f2-owner/f2-repo-allfail";
    setupGithub(repo, {
      tree: [
        { path: "skills/foo/SKILL.md", size: 80 },
        { path: "skills/foo/main.py", size: 40 },
      ],
      rawStatus: { "skills/foo/SKILL.md": 200, "skills/foo/main.py": 500 },
    });

    const res = await installMarketSkill(
      marketSkill("f2-allfail", { repoFullName: repo, dirPath: "skills/foo", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success).toBe(false);
    expect(res.filesWritten).toBe(1);
    expect(res.error).toContain("500");
  });

  it("SKILL-F2-4 反向对照：全部成功时必须照常成功（别把好的弄坏）", async () => {
    const repo = "f2-owner/f2-repo-ok";
    setupGithub(repo, {
      tree: [
        { path: "skills/foo/SKILL.md", size: 80 },
        { path: "skills/foo/main.py", size: 40 },
      ],
      rawStatus: { "skills/foo/SKILL.md": 200, "skills/foo/main.py": 200 },
    });

    const res = await installMarketSkill(
      marketSkill("f2-ok", { repoFullName: repo, dirPath: "skills/foo", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success).toBe(true);
    expect(res.filesWritten).toBe(2);
    expect(res.skipped).toBeUndefined();
    expect(addAuditSpy, "全成功才登记审计").toHaveBeenCalledTimes(1);
  });
});
