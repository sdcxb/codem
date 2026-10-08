/**
 * 第 183 波：MCP **resources 三件套**（对标 Pi，命名对齐 Codex / opencode）。
 *
 * ## 这组判据守什么
 *
 * 1. **按能力门控**（我们与 Pi 的有意差异）：只有已连接且 `initialize` 声明了
 *    `resources` 的服务器存在时才注册；一个都没有时必须**不注册**并且**清理残留**
 *    —— 理由是性能：工具定义会进入每一轮请求的 schema 与提示清单。
 * 2. **协议调用正确**：走 `resources/list` / `resources/templates/list` / `resources/read`。
 * 3. **二进制资源不许内联**（base64 是 token 黑洞）：只描述类型与大小。
 * 4. **失败要说清**（延续第 84 波"假成功"那条纪律）：拿不到清单/读不到资源 ⇒ 显式失败。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: Array<{ server: string; method: string; params: any }> = [];
let capsByServer: Record<string, any> = {};
let resourceList: any[] = [];
let templateList: any[] = [];
let readResult: any = { contents: [] };
let throwOn: string | null = null;

/** MCPR-10 起：分页形状（服务器返回的整页）与落盘失败注入 */
let listPages: Record<string, Array<{ resources: any[]; nextCursor?: string }>> = {};
let throwOnWrite: string | null = null;

vi.mock("../core/mcp/mcp", () => ({
  getMCPRegistry: () => ({
    serversWithResources: () =>
      Object.entries(capsByServer)
        .filter(([, caps]) => caps && caps.resources)
        .map(([name]) => name),
    listResources: async (server: string) => {
      calls.push({ server, method: "resources/list", params: {} });
      if (throwOn === "list") throw new Error("boom");
      return resourceList;
    },
    /**
     * MCPR-10：整页接口。默认用 `resourceList` 兜底（旧用例只设它），
     * 显式设了 `listPages` 就按 cursor 逐页给（cursor 是**不透明**令牌 ⇒ 用
     * `page-<序号>` 的约定把页码编进去；末页之后 = 空 + 无 nextCursor）。
     */
    listResourcesPage: async (server: string, cursor?: string) => {
      calls.push({ server, method: "resources/list", params: cursor ? { cursor } : {} });
      if (throwOn === "list") throw new Error("boom");
      const pages = listPages[server];
      if (!pages) return { resources: resourceList };
      if (!cursor) return pages[0] ?? { resources: [] };
      const at = /^page-(\d+)$/.exec(cursor);
      return (at ? pages[Number(at[1])] : undefined) ?? { resources: [] };
    },
    listResourceTemplates: async (server: string) => {
      calls.push({ server, method: "resources/templates/list", params: {} });
      if (throwOn === "templates") throw new Error("boom");
      return templateList;
    },
    readResource: async (server: string, uri: string) => {
      calls.push({ server, method: "resources/read", params: { uri } });
      if (throwOn === "read") throw new Error("boom");
      return readResult;
    },
  }),
}));

import {
  createListMcpResourceTemplatesTool,
  createListMcpResourcesTool,
  createReadMcpResourceTool,
} from "../core/llm/tools/mcp-resources-tool";
import { MCP_RESOURCE_TOOL_IDS, mcpResourceToolsRegistered, syncMcpResourceTools } from "../core/llm/tools/mcp-resources-sync";
import type { ToolRegistry } from "../core/llm/tools";
import { tmpdir } from "node:os";
import path from "node:path";
// ⚠️ `node:fs` 在**运行时不带** fs（见 vite.config.ts 的 alias）：这正是"落盘必须走
// `core/file-api`（Tauri IPC）"那条纪律的由来。判据自己要读盘对账，所以显式引真模块。
import * as fsSync from "node:fs";
import { __resetDataRootCache } from "../core/storage/data-root";
import { pruneSpillFiles } from "../core/storage/spill";

/** 最小可用的注册表桩（只实现 sync 用到的四个方法） */
function fakeRegistry(initial: string[] = []): ToolRegistry {
  const m = new Map<string, any>(initial.map((id) => [id, { id }]));
  return {
    get: (id: string) => m.get(id),
    register: (def: any) => m.set(def.id, def),
    remove: (id: string) => m.delete(id),
    getAll: () => [...m.values()],
  } as unknown as ToolRegistry;
}

beforeEach(() => {
  calls.length = 0;
  capsByServer = {};
  resourceList = [];
  templateList = [];
  readResult = { contents: [] };
  throwOn = null;
  listPages = {};
  throwOnWrite = null;
});

/* ===== MCPR-10..16 的工件脚手架：真实临时目录 + 把 `core/file-api` 的 Tauri IPC 指到它 =====
 *
 * ⚠️ 为什么必须走 `window.__TAURI__.core.invoke` 这一层、而不是 mock 掉 `file-api` 模块：
 * 契约要求"**真的**写到盘上、路径能读回、内容一致"。只在 mock 里对账内容，等于自证同义反复，
 * 证明不了"落盘路径上的字节 = 资源字节"。这里把 IPC 落到真实文件系统（用 `write_file`
 * 的 `encoding: "base64"` 语义 —— 与 Rust 侧一致），于是判据读的是**盘上的字节**。
 */
const tauriBackup = (globalThis as any).window?.__TAURI__;
const tempDirs: string[] = [];
/** 当前临时 data-root 的库文件路径（`storage_info` 要如实报出来） */
let tempDbPath = "";

function fakeTauriInvoke(command: string, args: Record<string, any> = {}): Promise<any> {
  if (command === "storage_info") {
    return Promise.resolve({ path: tempDbPath, standard: false, reason: "mcp-resources test temp dir" });
  }
  // 与 Rust `write_file` 同语义：encoding === "base64" 时把 base64 解码成**原始字节**
  if (command === "write_file") {
    if (throwOnWrite) throw new Error(throwOnWrite);
    const bytes = Buffer.from(String(args.content), args.encoding === "base64" ? "base64" : "utf8");
    fsSync.mkdirSync(path.dirname(String(args.path)), { recursive: true });
    fsSync.writeFileSync(String(args.path), bytes);
    return Promise.resolve(null);
  }
  if (command === "rename_file") {
    fsSync.renameSync(String(args.oldPath), String(args.newPath));
    return Promise.resolve(null);
  }
  if (command === "list_directory") {
    const dir = String(args.path);
    if (!fsSync.existsSync(dir)) throw new Error(`not a directory: ${dir}`);
    return Promise.resolve(
      fsSync.readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        path: path.join(dir, e.name),
        isDirectory: e.isDirectory(),
      })),
    );
  }
  if (command === "delete_file") {
    fsSync.rmSync(String(args.path), { force: true });
    return Promise.resolve(null);
  }
  throw new Error(`unexpected Tauri command in mcp-resources test: ${command}`);
}

/** 每个用例一个临时 data-root：`storage_info` 指向 `<tmp>/codem-db-rust.bin` */
function useTempDataRoot(): string {
  const base = fsSync.mkdtempSync(path.join(tmpdir(), "mcp-res-"));
  tempDirs.push(base);
  tempDbPath = path.join(base, "codem-db-rust.bin");
  (globalThis as any).window.__TAURI__ = { core: { invoke: fakeTauriInvoke } };
  __resetDataRootCache();
  return base;
}

afterEach(() => {
  __resetDataRootCache();
  if (tauriBackup === undefined) delete (globalThis as any).window.__TAURI__;
  else (globalThis as any).window.__TAURI__ = tauriBackup;
  while (tempDirs.length) fsSync.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/**
 * 从工具输出里把落盘文件**读回来**（判据要对账盘上的字节，所以必须真的定位到文件）。
 *
 * ⚠️ 这里**只从输出里取文件名**，"应该在哪个目录"由判据自己按已知的临时 data-root
 * 算出来。理由是实测踩过两次坑：想从混排了中文说明的输出里正则截一条 Windows 绝对路径，
 * 要么被目录分隔符卡住（`[^\s\\/]+` 匹配不了嵌套目录），要么丢掉盘符 —— 于是判据
 * 会在**错误的路径**上找文件，红得莫名其妙。文件名足够证明"输出里的落盘路径是真的"。
 */
function readBackSpilledFile(output: string, base: string, session: string): { path: string; bytes: Buffer } {
  const sepEsc = "[\\\\/]";
  const m = new RegExp(`spill${sepEsc}${session}${sepEsc}([\\w.-]+\\.(?:bin|png))`).exec(output);
  expect(m, `输出里必须给出落盘的会话私有路径与文件名：${output}`).toBeTruthy();
  const full = path.join(base, "spill", session, m![1]);
  expect(fsSync.existsSync(full), `落盘路径必须真实存在：${full}`).toBe(true);
  return { path: full, bytes: fsSync.readFileSync(full) };
}

describe("第 183 波 · MCP resources（MCPR）", () => {
  it("MCPR-1: 没有任何服务器声明 resources ⇒ **不注册**（每一轮都不为用不上的工具付 token）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, []);
    expect(mcpResourceToolsRegistered(reg)).toEqual([]);
  });

  it("MCPR-2: 有能力时三个工具都注册，且都是**只读**（访问范围 workspace）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, ["docs-server"]);
    expect(mcpResourceToolsRegistered(reg).sort()).toEqual([...MCP_RESOURCE_TOOL_IDS].sort());
    for (const id of MCP_RESOURCE_TOOL_IDS) {
      const def: any = reg.get(id);
      expect(def.contract.readOnly, `${id} 必须只读`).toBe(true);
      expect(def.contract.accessScope).toBe("workspace");
      expect(def.contract.persistResult).toBe(false);
    }
  });

  it("MCPR-3: 能力消失（断连）⇒ **清理残留**（提示与可调用集合严格一致）", () => {
    const reg = fakeRegistry();
    syncMcpResourceTools(reg, ["docs-server"]);
    expect(mcpResourceToolsRegistered(reg)).toHaveLength(3);
    syncMcpResourceTools(reg, []);
    expect(mcpResourceToolsRegistered(reg)).toEqual([]);
  });

  it("MCPR-4: list_mcp_resources 走 `resources/list`，把 uri / name / mimeType 呈现给模型", async () => {
    capsByServer = { "docs-server": { resources: {} } };
    resourceList = [{ uri: "docs://a.md", name: "A", mimeType: "text/markdown" }];
    const res: any = await createListMcpResourcesTool().execute!({}, {} as any);
    expect(calls).toEqual([{ server: "docs-server", method: "resources/list", params: {} }]);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("docs://a.md");
    expect(res.output).toContain("A");
    expect(res.output).toContain("text/markdown");
  });

  it("MCPR-5: 模板工具走 `resources/templates/list`", async () => {
    capsByServer = { "docs-server": { resources: {} } };
    templateList = [{ uriTemplate: "docs://{path}", name: "any doc" }];
    const res: any = await createListMcpResourceTemplatesTool().execute!({}, {} as any);
    expect(calls[0].method).toBe("resources/templates/list");
    expect(res.output).toContain("docs://{path}");
  });

  it("MCPR-6: read_mcp_resource 走 `resources/read`；**二进制资源只描述、不内联**（base64 是 token 黑洞）", async () => {
    readResult = {
      contents: [
        { uri: "docs://a.md", text: "hello" },
        { uri: "docs://b.png", mimeType: "image/png", blob: "A".repeat(5000) },
      ],
    };
    const res: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://a.md" }, {} as any);
    expect(calls).toEqual([{ server: "s", method: "resources/read", params: { uri: "docs://a.md" } }]);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hello");
    // 关键：不能把 5000 个 base64 字符灌进上下文
    expect(res.output).not.toContain("A".repeat(100));
    expect(res.output).toContain("not inlined");
  });

  it("MCPR-7: 失败**必须说清**（不许假成功）：协议抛错与 isError 两条路径都显式失败", async () => {
    throwOn = "read";
    const a: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://x" }, {} as any);
    expect(a.isError).toBe(true);
    expect(a.output).toContain("boom");

    throwOn = null;
    readResult = { contents: [{ text: "denied" }], isError: true };
    const b: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://x" }, {} as any);
    expect(b.isError).toBe(true);
    expect(b.output).toContain("denied");

    // 参数缺失也是失败，不是"空成功"
    const c: any = await createReadMcpResourceTool().execute!({ server: "s" }, {} as any);
    expect(c.isError).toBe(true);
    expect(c.output).toContain("required");
  });

  it("MCPR-8: 没有服务器时给出**明确说明**而不是空串（模型要知道为什么没结果）", async () => {
    const res: any = await createListMcpResourcesTool().execute!({}, {} as any);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("No connected MCP server exposes resources.");
    expect(calls).toEqual([]);
  });

  it("MCPR-9: **接线**在真实链路上（防『判据长在没人走的链路』的老毛病）", async () => {
    const fs = await import("node:fs");
    const index = fs.readFileSync("src/core/llm/index.ts", "utf8");
    // ① 服务方法存在，且它把能力名单交给 sync（而不是自己瞎注册）
    expect(index).toMatch(/syncMcpResourceTools\(\)\s*:\s*void\s*\{/);
    expect(index).toMatch(/syncMcpResourceTools\(this\.tools,\s*servers\)/);
    // ② 能力来自 MCP 侧的 serversWithResources（不是写死的常量）
    expect(index).toMatch(/serversWithResources/);
    // ③ 真的在构建系统提示时被调用（与 codegraph / zvec 的 sync 并列 —— 那是同一处时机）
    expect(index).toMatch(/this\.syncMcpResourceTools\(\);/);
    const buildIdx = index.indexOf("this.syncCodeGraphTools();");
    const mcpIdx = index.indexOf("this.syncMcpResourceTools();");
    expect(buildIdx, "codegraph sync 应当仍在").toBeGreaterThan(-1);
    expect(mcpIdx, "MCP resources sync 必须在同一处时机被调用").toBeGreaterThan(buildIdx);
  });

  /* ============ 第 184 波：分页 / 二进制落盘 / 多段标 URI ============ */

  it("MCPR-10: list_mcp_resources 透出 nextCursor，并接受 cursor 续页（不透明令牌，逐字回传）", async () => {
    capsByServer = { "docs-server": { resources: {} } };
    listPages = {
      "docs-server": [
        { resources: [{ uri: "docs://a", name: "A" }], nextCursor: "page-1" },
        { resources: [{ uri: "docs://b", name: "B" }], nextCursor: "page-2" },
        { resources: [{ uri: "docs://c", name: "C" }] },
      ],
    };

    const first: any = await createListMcpResourcesTool().execute!({}, {} as any);
    expect(first.isError).toBe(false);
    expect(first.output).toContain("docs://a");
    // 判据：游标必须**透出来**，否则模型无从知道还有更多（"没显示" ≠ "没有了"）
    expect(first.output).toContain("nextCursor: page-1");
    expect(first.output).toContain('cursor="page-1"');

    const second: any = await createListMcpResourcesTool().execute!({ cursor: "page-1" }, {} as any);
    expect(second.output).toContain("docs://b");
    expect(second.output).toContain("nextCursor: page-2");

    const third: any = await createListMcpResourcesTool().execute!({ cursor: "page-2" }, {} as any);
    expect(third.output).toContain("docs://c");
    expect(third.output).not.toContain("nextCursor"); // 末页：不再说还有更多

    // 协议层：cursor 逐字传给 `resources/list` 的 params.cursor（不透明令牌，绝不改写）
    expect(calls).toEqual([
      { server: "docs-server", method: "resources/list", params: {} },
      { server: "docs-server", method: "resources/list", params: { cursor: "page-1" } },
      { server: "docs-server", method: "resources/list", params: { cursor: "page-2" } },
    ]);
  });

  it("MCPR-11: 二进制资源**解码落盘**，路径能读回、字节与资源**完全一致**（不再是一句『not inlined』）", async () => {
    const base = useTempDataRoot();
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10, 0x80, 0x7f, 0x00]); // 非文本字节
    capsByServer = { "docs-server": { resources: {} } };
    readResult = {
      contents: [{ uri: "docs://blob.bin", mimeType: "application/octet-stream", blob: raw.toString("base64") }],
    };

    const res: any = await createReadMcpResourceTool().execute!(
      { server: "docs-server", uri: "docs://blob.bin" },
      { sessionId: "sess-1" } as any,
    );
    expect(res.isError).toBe(false);
    // ① 路径给出来了（模型要能用 read / grep 去读）
    const back = readBackSpilledFile(res.output, base, "sess-1");
    const stored = back.path;
    // ② 盘上字节 = 资源字节（逐字节一致，不是"看起来像"）
    expect(back.bytes.equals(raw)).toBe(true);
    // ③ 落盘在**会话私有**的溢出目录里（与既有 spill 约定同一处，不是自造目录）
    expect(stored).toContain(path.join(base, "spill", "sess-1"));
    // ④ 名字带写入时刻毫秒 ⇒ 既有回收机制（pruneSpillFiles）认得出它
    expect(path.basename(stored)).toMatch(/-(\d{10,})\.bin$/);
    // ⑤ 正文仍然只有描述、没有 base64（token 黑洞那条判据不放松）
    expect(res.output).not.toContain(raw.toString("base64"));
    // ⑥ 说清怎么读它
    expect(res.output).toContain("read");
    expect(res.output).toContain("grep");
  });

  it("MCPR-12: 图片资源**如实说明**『已保存但我看不到图像内容』，不假装模型能看见", async () => {
    const base = useTempDataRoot();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    readResult = { contents: [{ uri: "docs://pic.png", mimeType: "image/png", blob: png.toString("base64") }] };

    const res: any = await createReadMcpResourceTool().execute!(
      { server: "s", uri: "docs://pic.png" },
      { sessionId: "sess-2" } as any,
    );
    expect(res.isError).toBe(false);
    const back = readBackSpilledFile(res.output, base, "sess-2");
    expect(back.bytes.equals(png)).toBe(true);
    expect(res.output).toContain("image");
    // 关键：不许暗示模型看得到像素
    expect(res.output).toMatch(/无法看到|not visible|看不到/);
  });

  it("MCPR-13: 落盘目录归 `pruneSpillFiles()` 管（既有回收按写入时刻判保留期，没有新增清理者）", async () => {
    const base = useTempDataRoot();
    const old = Buffer.from("old-binary");
    readResult = {
      contents: [{ uri: "docs://old.bin", mimeType: "application/octet-stream", blob: old.toString("base64") }],
    };
    const res: any = await createReadMcpResourceTool().execute!(
      { server: "s", uri: "docs://old.bin" },
      { sessionId: "sess-3" } as any,
    );
    const m = readBackSpilledFile(res.output, base, "sess-3");
    const stored = m.path;
    // 把它伪造成"30 天前写的"（时间写在文件名里 ⇒ 改个名字就是改年龄）
    const aged = stored.replace(/-(\d{10,})\.bin$/, `-${Date.now() - 30 * 24 * 60 * 60 * 1000}.bin`);
    fsSync.renameSync(stored, aged);

    const pruned = await pruneSpillFiles({ keepDays: 14, now: Date.now() });
    expect(pruned.deletedFiles).toBe(1);
    expect(fsSync.existsSync(aged)).toBe(false);
  });

  it("MCPR-14: 落盘失败**如实失败**（isError:true + 说清落盘结论），绝不静默当成『没有内容』", async () => {
    useTempDataRoot();
    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    readResult = {
      contents: [{ uri: "docs://x.bin", mimeType: "application/octet-stream", blob: raw.toString("base64") }],
    };
    throwOnWrite = "EACCES: permission denied";

    const res: any = await createReadMcpResourceTool().execute!(
      { server: "s", uri: "docs://x.bin" },
      { sessionId: "sess-4" } as any,
    );
    expect(res.isError).toBe(true);
    // 失败原因可见，且仍然给出了"本该写到哪"（否则排查没有落点）
    expect(res.output).toMatch(/EACCES|permission denied/);
    expect(res.output).toContain("mcp-resource-x.bin");
    expect(res.output).toMatch(/落盘失败|failed/);
    // 不许把失败说成"没有内容 / 未内联"就完事
    expect(res.output).not.toBe("");
  });

  it("MCPR-15: 多段内容每段前标 `uri:`（否则几段会粘成一片、分不清出处）", async () => {
    readResult = {
      contents: [
        { uri: "docs://a.md", text: "ALPHA" },
        { uri: "docs://b.md", text: "BETA" },
      ],
    };
    const res: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://a.md" }, {} as any);
    expect(res.isError).toBe(false);
    expect(res.output).toContain("uri: docs://a.md\nALPHA");
    expect(res.output).toContain("uri: docs://b.md\nBETA");

    // 单段保持原文（不额外加标签 —— 向后兼容 MCPR-6 的既有形状）
    readResult = { contents: [{ uri: "docs://a.md", text: "ALPHA" }] };
    const single: any = await createReadMcpResourceTool().execute!({ server: "s", uri: "docs://a.md" }, {} as any);
    expect(single.output).toBe("ALPHA");
  });

  it("MCPR-16: `cursor` 是**可选**参数且声明进 schema（模型才知道可以续页）", () => {
    const props = (createListMcpResourcesTool().parameters as any).properties;
    expect(Object.keys(props)).toContain("cursor");
    expect(props.cursor.type).toBe("string");
    expect((createListMcpResourcesTool().parameters as any).required).toEqual([]);
  });

  it("MCPR-17: `cursor` 真的进到协议 params、`nextCursor` 真的从返回值取（不是只改了工具层）", () => {
    // ⚠️ 本文件把 `core/mcp/mcp` 整块 mock 了 ⇒ 上面所有用例都证明不了**通道**本身。
    // 这条按源码形状守（与 MCPR-9 同一手法）：params 必须带 cursor，返回必须取 nextCursor。
    const src = fsSync.readFileSync("src/core/mcp/mcp.ts", "utf8");
    expect(src).toMatch(/listResourcesPage\(serverName: string, cursor\?: string\)/);
    expect(src).toMatch(/"resources\/list",\s*cursor \? \{ cursor \} : \{\}/);
    expect(src).toMatch(/nextCursor/);
    // 客户端门面（MCPRegistry）也必须透传，否则工具层问不到整页
    expect(src).toMatch(
      /listResourcesPage\(serverName: string, cursor\?: string\): Promise<\{ resources: any\[\]; nextCursor\?: string \}>/,
    );
  });
});
