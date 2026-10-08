/**
 * 技能市场「GitHub 仓库目录」安装：**二进制必须按字节落盘**（本波 SKILL-BIN-1..4）。
 *
 * ## 缺陷形态（同一份"静默损坏"的另一个实现）
 *
 * `installSkillFromGitHubDir`（`skill-market-client.ts`）逐文件 `httpGet(...)` 拿到的是
 * **字符串**（Rust `http_get` 是 `String::from_utf8_lossy`，见 `lib.rs:3933`），
 * 再按文本 `writeFile` 写盘 ⇒ 白名单里的 `.png/.jpg/.jpeg/.gif/.ico` 的非 UTF-8 字节
 * 被替换成 U+FFFD（**图片被静默破坏**），而且 `filesWritten` 照常 +1 ⇒ 假成功。
 *
 * ZIP 那条路径（`installSkillFromZipFiltered` / `installer.ts`）上一波已经改成
 * "二进制按 base64 写、跳过记账、0 文件报失败"；目录路径是**另一个实现**，漏了。
 *
 * ## 修法（本波）
 *
 * 目录路径的每个文件改走 **`http_download`**（Rust 侧把响应字节直接写到目标文件，
 * JS 只拿路径）—— 与 `pet-market-client.ts:57` 的既有包装同一形态，没有新通道。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | SKILL-BIN-1 | 含非 UTF-8 字节的文件落盘后与源**逐字节一致**（含 PNG 魔数 89 50 4E 47 与 0x00/0xFF） |
 * | SKILL-BIN-2 | 该文件**没有**经过「http_get 拿正文 → 文本 writeFile」（替身记录 http_download 的实参） |
 * | SKILL-BIN-3 | 部分文件失败 ⇒ `success:false` + 失败清单 + warning，且**不登记**为可用 |
 * | SKILL-BIN-4 | 反向对照：纯文本技能照常安装成功、内容正确 |
 * | SKILL-BIN-5 | 跳过（白名单外 / 过大）必须**记账** + warning（与 ZIP 路径同一口径） |
 *
 * ⚠️ 判据断言的是**行为**（交给哪个通道、实参是什么、落盘字节是什么），不是实现细节。
 * "落盘字节"由替身按 Rust 侧的真实行为模拟（`lib.rs:3973-3974`：`std::fs::write(&dest, &resp.bytes())`，
 * 原样字节）；JS 侧可判定的部分是"这份字节从未经过 JS 字符串"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { strToU8 } from "fflate";

/** 记录每一次**文本**写盘（路径 / 内容 / 选项） */
const writes: Array<{ path: string; content: string; options?: Record<string, unknown> }> = [];
const addAuditSpy = vi.fn();
const registerSpy = vi.fn();

vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    writeFile: async (path: string, content: string, options?: Record<string, unknown>) => {
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

/** 只替掉注册表（其余（如 `parseSkillMarkdown`）用真货）—— 用来断言"半成品没有登记为可用" */
vi.mock("../core/skill/skill", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getSkillRegistry: () => ({ get: () => undefined, register: registerSpy }),
  };
});

vi.mock("../core/skill/sandbox", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, addInstallAuditEntry: (...args: unknown[]) => addAuditSpy(...args) };
});

import { installMarketSkill, type MarketSkill } from "../core/skill/skill-market-client";

// ========== 替身（照 `skill-install-accounting.test.ts` 的搭法） ==========

/** 模拟 Rust 侧的落盘结果：目标路径 → 字节 */
const disk = new Map<string, Uint8Array>();
/** 记录每一次 `http_download` 的实参（新通道的唯一取证处） */
const downloadCalls: Array<{ url: string; destPath: string; headers?: Record<string, string> }> = [];
/** 记录每一次 `http_get` 的 URL（用来断言二进制**没有**走这条通道） */
const getCalls: string[] = [];

function setupTauri(handler: (cmd: string, args: Record<string, unknown>) => unknown) {
  (globalThis as any).window = {
    dispatchEvent: () => {},
    __TAURI__: { core: { invoke: async (cmd: string, args: Record<string, unknown>) => handler(cmd, args) } },
  };
}

interface DirFixture {
  /** GitHub Trees API 里的 blob（path 相对仓库根，body 是**真实字节**） */
  entries: Array<{ path: string; body: Uint8Array }>;
  /** 这些相对路径下载失败，值给 HTTP 状态码（**两条通道都失败** ⇒ 判据与通道无关） */
  failures?: Record<string, number>;
}

/**
 * 假 Tauri：只回答目录安装路径真正会用的命令。
 *
 * - `http_get` 按 Rust 的真实行为返回**字符串**（UTF-8 lossy）；
 * - `http_download` 按 Rust 的真实行为把**原样字节**写到 destPath。
 */
function setupGithubDir(repo: string, fx: DirFixture) {
  const byPath = new Map(fx.entries.map((e) => [e.path, e]));
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
          tree: fx.entries.map((e) => ({ path: e.path, type: "blob", size: e.body.length })),
        }),
        headers: {},
      };
    }
    if (url.includes("raw.githubusercontent.com/")) {
      const rel = url.split("/main/")[1] ?? "";
      const entry = byPath.get(rel);
      const status = fx.failures?.[rel] ?? (entry ? 200 : 404);
      if (cmd === "http_get") {
        getCalls.push(url);
        if (status !== 200) return { status, body: "", headers: {} };
        return { status: 200, body: new TextDecoder().decode(entry!.body), headers: {} };
      }
      if (cmd === "http_download") {
        const destPath = String(args?.destPath ?? "");
        downloadCalls.push({ url, destPath, headers: args?.headers as Record<string, string> });
        if (status !== 200) throw new Error(`HTTP ${status}: ${url}`);
        disk.set(destPath, entry!.body.slice());
        return destPath;
      }
    }
    throw new Error(`未预期的命令/URL：${cmd} ${url}`);
  });
}

const md = (name: string) => `---\nname: ${name}\ndescription: 测试技能\n---\n# ${name}\n正文\n`;

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

/** 一段**非法 UTF-8** 的真实 PNG 头（含魔数 89 50 4E 47、0x00、0xFF、截断的多字节序列） */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0xff, 0xd8, 0x80, 0xc3, 0x28, 0xfe, 0x00, 0xff,
]);

beforeEach(() => {
  writes.length = 0;
  downloadCalls.length = 0;
  getCalls.length = 0;
  disk.clear();
  addAuditSpy.mockClear();
  registerSpy.mockClear();
});

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

// ========== SKILL-BIN-1 / 2 ==========

describe("GitHub 目录安装：二进制不经 JS 字符串", () => {
  it("SKILL-BIN-1: 含非 UTF-8 字节的资源落盘**逐字节一致**（PNG 魔数 + 0x00/0xFF）", async () => {
    // 前置事实：这份字节确实会被「UTF-8 解码再编码」破坏 —— 否则下面的判据没有区分力
    const roundTrip = new TextEncoder().encode(new TextDecoder().decode(PNG));
    expect(
      Array.from(roundTrip),
      "夹具本身必须是非 UTF-8（否则文本通道也能过，判据就是空的）",
    ).not.toEqual(Array.from(PNG));
    expect(Array.from(PNG.slice(0, 4)), "PNG 魔数").toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(PNG)).toContain(0xff);
    expect(Array.from(PNG)).toContain(0x00);

    const repo = "bin-owner/bin-repo-bytes";
    setupGithubDir(repo, {
      entries: [
        { path: "skills/pic/SKILL.md", body: strToU8(md("pic")) },
        { path: "skills/pic/icon.png", body: PNG },
      ],
    });

    const res = await installMarketSkill(
      marketSkill("pic", { repoFullName: repo, dirPath: "skills/pic", branch: "main" }),
      undefined,
      true,
    );
    expect(res.success, "全部文件都拿到 ⇒ 成功").toBe(true);

    const call = downloadCalls.find((c) => c.url.endsWith("/skills/pic/icon.png"));
    expect(call, "二进制必须由 http_download 直接落盘").toBeTruthy();
    expect(call!.destPath, "目标路径沿用既有的技能目录拼装").toBe(
      "C:\\data\\.codem\\skills\\pic\\icon.png",
    );
    expect(
      Array.from(disk.get(call!.destPath)!),
      "落盘字节必须与源**逐字节一致**（改前是 lossy 字符串 ⇒ U+FFFD EF BF BD 替掉 89/FF/80）",
    ).toEqual(Array.from(PNG));
    expect(disk.get(call!.destPath)!.length).toBe(PNG.length);
  });

  it("SKILL-BIN-2: 二进制**没有**走「http_get 拿正文 → 文本 writeFile」", async () => {
    const repo = "bin-owner/bin-repo-channel";
    setupGithubDir(repo, {
      entries: [
        { path: "skills/pic/SKILL.md", body: strToU8(md("pic")) },
        { path: "skills/pic/icon.png", body: PNG },
      ],
    });

    const res = await installMarketSkill(
      marketSkill("pic", { repoFullName: repo, dirPath: "skills/pic", branch: "main" }),
      undefined,
      true,
    );
    expect(res.success).toBe(true);

    // ① http_get 只允许出现在 SKILL.md 上（那是**文本**：要解析元数据）
    expect(
      getCalls.some((u) => u.includes("icon.png")),
      "二进制不许经 http_get（Rust 侧 from_utf8_lossy ⇒ 字节当场就坏了）",
    ).toBe(false);
    expect(getCalls.map((u) => u.split("/main/")[1])).toEqual(["skills/pic/SKILL.md"]);

    // ② 二进制不许走文本 writeFile
    expect(
      writes.some((w) => w.path.includes("icon.png")),
      "二进制不许走 writeFile 文本通道",
    ).toBe(false);

    // ③ 替身记录的实参：raw 形态的 URL + 技能目录内的目标路径，且只下一次
    const calls = downloadCalls.filter((c) => c.url.includes("icon.png"));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(`https://raw.githubusercontent.com/${repo}/main/skills/pic/icon.png`);
    expect(calls[0].destPath.startsWith("C:\\data\\.codem\\skills\\pic\\")).toBe(true);
  });

  it("SKILL-BIN-2b: 越出技能目录的树条目被拒（http_download 不受 file-api 的工作区守卫保护）", async () => {
    const repo = "bin-owner/bin-repo-escape";
    setupGithubDir(repo, {
      entries: [
        { path: "skills/pic/SKILL.md", body: strToU8(md("pic")) },
        // 目录遍历条目（改写前连 writeFile 都拦不住：技能目录不在工作区内、无 workspace 选项）
        { path: "skills/pic/../../../evil.png", body: PNG },
      ],
    });

    const res = await installMarketSkill(
      marketSkill("pic", { repoFullName: repo, dirPath: "skills/pic", branch: "main" }),
      undefined,
      true,
    );

    expect(downloadCalls.some((c) => c.url.includes("evil.png")), "不许落盘到技能目录外").toBe(false);
    expect(disk.size).toBe(0);
    expect(res.success, "该装的文件没装上 ⇒ 不许报成功").toBe(false);
    expect(res.skipped?.some((s) => s.path.includes("evil.png") && s.reason.includes("技能目录"))).toBe(true);
  });
});

// ========== SKILL-BIN-3 ==========

describe("GitHub 目录安装：含二进制的部分失败如实报", () => {
  it("SKILL-BIN-3: 部分失败 ⇒ success:false + 失败清单 + warning，且不登记为可用", async () => {
    const repo = "bin-owner/bin-repo-partial";
    setupGithubDir(repo, {
      entries: [
        { path: "skills/x/SKILL.md", body: strToU8(md("x")) },
        { path: "skills/x/icon.png", body: PNG },
        { path: "skills/x/main.py", body: strToU8("print(1)\n") },
      ],
      failures: { "skills/x/icon.png": 403 },
    });

    const res = await installMarketSkill(
      marketSkill("x", { repoFullName: repo, dirPath: "skills/x", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success, "10 个里 9 个失败也报成功 —— 这就是被修的假成功").toBe(false);
    expect(res.filesWritten, "成功几个要说清").toBe(2);
    expect(res.skipped?.map((s) => s.path), "失败几个 + 是哪些").toEqual(["icon.png"]);
    expect(res.skipped?.[0]?.reason, "为什么").toContain("403");
    expect(res.warning, "与 ZIP 那条路径同口径：如实说技能不完整").toContain("不完整");
    expect(res.error).toMatch(/成功 2 个/);
    expect(res.error).toMatch(/失败 1 个/);

    // 残缺安装**不许**登记为可用
    expect(registerSpy, "半成品不许注册").not.toHaveBeenCalled();
    expect(addAuditSpy, "半成品不许写安装审计").not.toHaveBeenCalled();
    expect(disk.has("C:\\data\\.codem\\skills\\x\\icon.png"), "失败的文件不该在盘上").toBe(false);
  });
});

// ========== SKILL-BIN-5：跳过也要记账（与 ZIP 那条路径同一口径） ==========

describe("GitHub 目录安装：跳过要记账", () => {
  it("SKILL-BIN-5: 白名单外的扩展名 / 过大文件必须记账 + warning（不许静默少装几个文件）", async () => {
    const repo = "bin-owner/bin-repo-skipped";
    setupGithubDir(repo, {
      entries: [
        { path: "skills/s/SKILL.md", body: strToU8(md("s")) },
        { path: "skills/s/notes.md", body: strToU8("ok\n") },
        { path: "skills/s/payload.dat", body: strToU8("不在白名单里") },
        { path: "skills/s/big.png", body: new Uint8Array(1024 * 1024 + 8) },
      ],
    });

    const res = await installMarketSkill(
      marketSkill("s", { repoFullName: repo, dirPath: "skills/s", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success, "跳过不是失败：技能仍可用").toBe(true);
    expect(res.filesWritten).toBe(2);
    expect(
      res.skipped?.map((s) => s.path).sort(),
      "改前是裸 continue —— 一个都不记，用户以为装全了（ZIP 路径早已记为 skipped）",
    ).toEqual(["big.png", "payload.dat"]);
    expect(res.skipped?.find((s) => s.path === "payload.dat")?.reason).toContain(".dat");
    expect(res.skipped?.find((s) => s.path === "big.png")?.reason).toContain("过大");
    expect(res.warning, "如实说技能可能不完整（与 ZIP 逐字同一口径）").toContain("跳过");

    // 被跳过的文件**不该**被下载（跳过发生在扫描阶段，省掉请求）
    expect(downloadCalls.some((c) => c.url.includes("payload.dat") || c.url.includes("big.png"))).toBe(false);
  });
});

// ========== SKILL-BIN-4（反向对照） ==========
describe("GitHub 目录安装：纯文本路径别被改坏", () => {
  it("SKILL-BIN-4: 纯文本技能照常安装成功，内容正确", async () => {
    const repo = "bin-owner/bin-repo-text";
    const mdText = md("text");
    const notes = "hello\nworld\n";
    const json = '{"a":1}\n';
    setupGithubDir(repo, {
      entries: [
        { path: "skills/text/SKILL.md", body: strToU8(mdText) },
        { path: "skills/text/notes.md", body: strToU8(notes) },
        { path: "skills/text/data.json", body: strToU8(json) },
      ],
    });

    const res = await installMarketSkill(
      marketSkill("text", { repoFullName: repo, dirPath: "skills/text", branch: "main" }),
      undefined,
      true,
    );

    expect(res.success).toBe(true);
    expect(res.filesWritten).toBe(3);
    expect(res.skipped).toBeUndefined();

    // SKILL.md：解析元数据必须读文本 ⇒ 它按文本写盘（`.md` 按定义是文本），内容一字不差
    const mdWrite = writes.find((w) => w.path.endsWith("SKILL.md"));
    expect(mdWrite?.content).toBe(mdText);
    expect(mdWrite?.path).toBe("C:\\data\\.codem\\skills\\text\\SKILL.md");

    // 其余文本文件走字节通道，内容同样正确（文本没被字节通道弄坏）
    expect(new TextDecoder().decode(disk.get("C:\\data\\.codem\\skills\\text\\notes.md")!)).toBe(notes);
    expect(new TextDecoder().decode(disk.get("C:\\data\\.codem\\skills\\text\\data.json")!)).toBe(json);

    // 全成功 ⇒ 照常登记
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(addAuditSpy).toHaveBeenCalledTimes(1);
  });
});
