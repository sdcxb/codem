/**
 * 第 183 波：MCP **resources** 三件套（对标 Pi 的同名工具，命名对齐 Codex / opencode）。
 *
 * ## 与 Pi 的差异（有意）
 *
 * Pi 把这三个工具**无条件**注册（它没有"能力门控"这一步）；我们**按服务端能力门控** ——
 * 只有至少一个已连接服务器在 `initialize` 里声明了 `resources` 才注册。
 *
 * 理由（以平台稳定性与性能为前提）：工具定义会进入**每一轮**请求的 function-calling
 * schema 与系统提示里的 MCP 清单。绝大多数服务器（含我们自己的 codegraph / zvec）不提供
 * resources —— 为它们注册三个永远用不上的工具，是在**每一轮**都付 token 与选择噪声的代价。
 *
 * ## 契约
 *
 * 三个都是**只读**（`readOnly: true`）：读服务器暴露的资源不会改工作区。
 * 访问范围按 `workspace` 声明（资源内容可能含仓库内容），但**内容一律当数据**看 ——
 * 与 `read` 一样裹数据边界由各自的输出形状决定（这里直接返回文本，不上边框：
 * 资源的正文通常不是文件内容，而是服务器生成的说明/记录）。
 *
 * ## 第 184 波（MCPR-10..16）：补齐三处契约形状（对齐 Pi v1.1.0）
 *
 * 1. **分页**：`resources/list` 的返回是 `{ resources, nextCursor? }`。旧实现把 `nextCursor`
 *    直接丢掉 ⇒ 资源多的服务器只看得到第一页，而且模型**无从知道还有更多**
 *    （"没显示"与"没有了"变成同一件事）。现在 `nextCursor` 逐服务器透出，并接受 `cursor`
 *    参数续页（`cursor` 是不透明令牌，只做透传，绝不解析改写）。
 * 2. **二进制落盘**：旧实现只回一句 `[binary resource: … N base64 chars — not inlined]`
 *    —— 数据等于丢了（模型拿不到内容，也没有任何办法拿到）。现在按 MIME 分流：
 *    - `image/*`：**如实说明**"这是图片资源，已保存到 X，但我看不到图像内容"
 *      （我们目前没有把图片喂给模型的通道，不能假装它可见）；
 *    - 文本类（json / xml / yaml / markdown / csv…）：base64 里装的就是文本 ⇒ 解码后内联；
 *    - 其余：base64 **解码成字节**写到应用数据目录的溢出目录，把**路径**给模型
 *      （并说明可以用 `read` / `grep` 去读）。
 *    落盘**失败要如实失败**（`isError: true` + 说清落盘结论），绝不静默退化成"没有内容"。
 * 3. **多段内容标 URI**：一段时保持原文（向后兼容）；**多段时每段前加 `uri:` 标签**，
 *    否则几段内容会粘成一片，模型分不清哪句出自哪个资源。
 *
 * ## 落盘落在哪、谁清理（不新造存储）
 *
 * 复用既有溢出（spill）那一套：目录 = `resolveDataRoot().root` + `spill/<sessionId>/`
 * （见 `src/core/storage/spill.ts` 的 `spillDir`），写盘同样**先 .tmp 再改名**的原子写；
 * 二进制字节交给既有原语 `writeFile(path, base64, { encoding: "base64" })`
 * （Rust 侧 `write_file` 解码成字节，与 `pet-manager.ts` 存 spritesheet 是同一个口子）。
 *
 * ⚠️ **为什么不用 `retainToolResult()` 而是自己写文件**：`retainToolResult` 是"保头保尾、
 * 中间省略"的**文本**语义 —— 用在二进制上会把字节切坏（那就不叫"内容一致"了）。
 * 所以这里直接走同一套 `../file-api` 原语 + 同一套目录约定，文件名同样**带写入时刻毫秒**，
 * 于是 `pruneSpillFiles()` 认得出它（它按 `-<毫秒>.txt` / `-<毫秒>.bin` 判保留期，
 * 默认保留 14 天；调用点在 `App.tsx` 的启动维护里）。
 */
import type { ToolContext, ToolDef, ToolExecuteResult } from "../tools";
import { getMCPRegistry } from "../../mcp/mcp";

/** 文本类 MIME：`blob` 里装的其实就是文本 ⇒ 解码后内联（比给一条路径有用得多） */
const TEXTUAL_MIME_RE =
  /^(text\/|application\/(json|xml|x-yaml|yaml|toml|sql|graphql|javascript|typescript|ecmascript|x-sh|x-python)|[a-z0-9.+-]*\+(json|xml|yaml))/i;

/** 常见二进制类型的落盘后缀（认不出来一律 `.bin`；模型按后缀挑工具，所以别乱猜） */
function extensionFor(mimeType: string, uri: string): string {
  const mime = (mimeType || "").toLowerCase();
  const byMime: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/octet-stream": ".bin",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
  };
  if (byMime[mime]) return byMime[mime];
  const slash = mime.indexOf("/");
  if (slash > 0 && /^[a-z0-9.+-]+$/.test(mime.slice(slash + 1))) return `.${mime.slice(slash + 1)}`;
  const dot = uri.lastIndexOf(".");
  if (dot > 0 && /^\.[a-z0-9]{1,8}$/i.test(uri.slice(dot))) return uri.slice(dot).toLowerCase();
  return ".bin";
}

/** 稳定的短哈希（FNV-1a，32 位）—— 只让同一个 uri 的文件名可复现，不是安全哈希 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 文件名里只留安全字符（uri 的末段常常带 `://` 之类） */
function safeSlug(uri: string): string {
  const tail = uri.split(/[\\/]/).pop() || "resource";
  const slug = tail
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[_.]+/, "")
    .slice(0, 40);
  return slug || "resource";
}

/** 目录分隔符：与 baseDir 的风格保持一致（与 spill.ts 同一套判断） */
function separatorFor(baseDir: string): string {
  return baseDir.includes("/") && !baseDir.includes("\\") ? "/" : "\\";
}

/** base64 文本 → 原始文本（先去掉换行/空白，再按 UTF-8 解码） */
function decodeBase64Text(blob: string): string {
  const binary = atob(blob.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** 落盘文件名：`mcp-resource-<uri 末段>-<稳定哈希>-<写入时刻毫秒><后缀>` */
function blobFileName(uri: string, ext: string): string {
  return `mcp-resource-${safeSlug(uri)}-${shortHash(uri)}-${Date.now()}${ext}`;
}

/**
 * 把 base64 内容写成**原始字节**文件（应用数据目录的会话私有溢出目录，原子写：先 .tmp 再改名）。
 *
 * 返回落盘路径；**失败会抛出**（由调用方转成 `isError: true`）。
 */
async function writeBlobFile(base64: string, ctx: ToolContext | undefined, fileName: string): Promise<string> {
  const { writeFile, renameFile } = await import("../../file-api");
  const baseDir = (await (await import("../../storage/data-root")).resolveDataRoot()).root;
  const sep = separatorFor(baseDir);
  const session = (ctx?.sessionId || "global").replace(/[^\w.-]+/g, "_");
  const locator = `${baseDir}spill${sep}${session}${sep}${fileName}`;
  await writeFile(`${locator}.tmp`, base64, { encoding: "base64" });
  await renameFile(`${locator}.tmp`, locator);
  return locator;
}

/**
 * 落盘失败的**紧凑**说明。
 *
 * 为什么压一下（第 184 波实测）：`resolveDataRoot()` 的失败信息本身是"分层解释"的
 * （引擎问不到 → 兜底也失败 → 拒绝退回相对路径），直接内联会把同一段话重复两遍、
 * 几百字符写进工具结果。这里只取**第一句**（含真实原因），其余留给日志。
 */
function describeWriteFailure(e: unknown): string {
  const msg = String((e as any)?.message ?? e ?? "未知原因");
  const firstClause = msg.split(/[；;。]/)[0].trim();
  const compact = firstClause || msg;
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

/**
 * 二进制资源：落盘 + 给出**可读回的路径**。图片按"存了但我看不到"如实说明。
 *
 * 落盘**失败**分两档处置（都不是"假装没有内容"）：
 * - **非图片**：`throw` ⇒ 调用方转成 `isError: true`。内容只能从盘上拿到，写不进去就是**真失败**
 *   （说成"未内联"会把"数据丢了"伪装成"按策略不内联"）。
 * - **图片**：退回**说清失败原因**的描述。我们没有把图片喂给模型的通道，所以图片内容
 *   本来就不进上下文 —— 这里没有"数据丢失"可言，不该把一次读资源变成失败
 *   （MCPR-6 的既有形状也要求图片路径**不是** `isError`）。
 *
 * @throws 非图片资源落盘失败
 */
async function spillBinaryResource(
  blob: string,
  mimeType: string,
  uri: string,
  ctx?: ToolContext,
): Promise<string> {
  const clean = blob.replace(/\s+/g, "");
  const byteHint = Math.floor((clean.length * 3) / 4);
  const ext = extensionFor(mimeType, uri);
  const fileName = blobFileName(uri, ext);
  const isImage = /^image\//i.test(mimeType || "");
  let path = "";
  try {
    path = await writeBlobFile(clean, ctx, fileName);
  } catch (e: any) {
    const why = describeWriteFailure(e);
    if (isImage) {
      return `[image resource: ${mimeType || "unknown type"}, ~${byteHint} bytes — not inlined；未能保存到临时文件（${why}）。这是图片资源，当前没有把图像内容喂给模型的通道，我无法看到这张图]`;
    }
    throw new Error(
      `非内联的二进制资源（${mimeType || "unknown type"}, ~${byteHint} bytes）落盘失败：${why}` +
        `（原定落点：${fileName}）—— 内容没有进上下文，不能当成『没有内容』`,
    );
  }
  if (isImage) {
    // 图片：不假装模型能看到像素 —— 只如实说明"已保存到这里，但我看不到图像内容"
    return `[image resource: ${mimeType || "unknown type"}, ~${byteHint} bytes — saved to ${path}；这是图片资源，当前没有把图像内容喂给模型的通道，我无法看到这张图]`;
  }
  return (
    `[binary resource: ${mimeType || "unknown type"}, ~${byteHint} bytes — not inlined；` +
    `已解码（base64 → 原始字节）写入文件：${path}；可以用 read / grep 读它]`
  );
}

/** 把资源内容整理成模型可读文本（容错：不同服务器返回的形状差异很大） */
async function formatResourceContents(contents: unknown, ctx?: ToolContext): Promise<string> {
  if (!Array.isArray(contents) || contents.length === 0) return "(empty resource)";
  const multi = contents.length > 1;
  const parts: string[] = [];
  for (const c of contents as any[]) {
    const uri = typeof c?.uri === "string" ? c.uri : "";
    // 第 184 波：多段时每段前加 `uri:` 标签 —— 否则几段内容会粘成一片，分不清出处
    const label = multi ? `${uri ? `uri: ${uri}` : "uri: (unknown)"}\n` : "";
    parts.push(label + (await formatOneContent(c, ctx)));
  }
  return parts.join("\n\n");
}

/** 单段内容的呈现（文本内联 / 二进制落盘 / 认不出来就如实说） */
async function formatOneContent(c: any, ctx?: ToolContext): Promise<string> {
  if (c == null) return "(null)";
  if (typeof c === "string") return c;
  if (typeof c.text === "string") return c.text;
  if (typeof c.blob === "string") {
    const mimeType = typeof c.mimeType === "string" ? c.mimeType : "";
    // 文本类：base64 里装的就是文本 ⇒ 解码内联，不落盘（少一次 I/O，也少一个定位符）
    if (TEXTUAL_MIME_RE.test(mimeType)) {
      try {
        return decodeBase64Text(c.blob);
      } catch {
        // 解码失败就落到盘上 —— 别假装内容不存在
      }
    }
    return await spillBinaryResource(c.blob, mimeType, typeof c.uri === "string" ? c.uri : "", ctx);
  }
  return JSON.stringify(c);
}

/** 已连接且在 initialize 里声明了 `resources` 的服务器名 */
function serversWithResources(): string[] {
  try {
    return getMCPRegistry().serversWithResources();
  } catch {
    return [];
  }
}

export function createListMcpResourcesTool(): ToolDef {
  return {
    id: "list_mcp_resources",
    description:
      "List the read-only resources exposed by a connected MCP server (documents, records, reference data). " +
      "The result contains URIs you can pass to read_mcp_resource. " +
      "When the answer reports nextCursor, pass it back as `cursor` to get the next page.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name (see the MCP section of the system prompt)" },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous call's nextCursor. Omit it for the first page.",
        },
      },
      required: [],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args): Promise<ToolExecuteResult> => {
      try {
        const registry = getMCPRegistry();
        const server = typeof args.server === "string" && args.server ? args.server : undefined;
        const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
        const targets = server ? [server] : registry.serversWithResources();
        if (targets.length === 0) {
          return {
            title: "list_mcp_resources",
            output: "No connected MCP server exposes resources.",
            isError: false,
          };
        }
        const chunks: string[] = [];
        for (const name of targets) {
          const page = await registry.listResourcesPage(name, cursor);
          const list = Array.isArray(page?.resources) ? page.resources : [];
          const nextCursor =
            typeof (page as any)?.nextCursor === "string" && (page as any).nextCursor
              ? (page as any).nextCursor
              : undefined;
          if (list.length === 0 && !nextCursor) {
            chunks.push(`${name}: (no resources)`);
            continue;
          }
          // 第 184 波：服务器名与分页游标**标在块头**，"这一页是谁的、还有没有更多"一眼可见
          const header = `${name}:${cursor ? ` (cursor: ${cursor})` : ""}${
            nextCursor ? ` nextCursor: ${nextCursor}` : ""
          }`;
          const lines = list.map(
            (r: any) => `  - ${r.uri}${r.name ? ` — ${r.name}` : ""}${r.mimeType ? ` (${r.mimeType})` : ""}`,
          );
          if (nextCursor) {
            lines.push(`  (more resources on this server — call list_mcp_resources with cursor="${nextCursor}")`);
          }
          chunks.push(lines.length ? `${header}\n${lines.join("\n")}` : header);
        }
        return { title: "list_mcp_resources", output: chunks.join("\n\n"), isError: false };
      } catch (e: any) {
        return { title: "list_mcp_resources", output: `Error listing MCP resources: ${e?.message || e}`, isError: true };
      }
    },
  };
}

export function createListMcpResourceTemplatesTool(): ToolDef {
  return {
    id: "list_mcp_resource_templates",
    description:
      "List the parameterised resource templates (URI templates) exposed by a connected MCP server. " +
      "Fill in the template variables and pass the resulting URI to read_mcp_resource.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
      },
      required: [],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args): Promise<ToolExecuteResult> => {
      try {
        const registry = getMCPRegistry();
        const server = typeof args.server === "string" && args.server ? args.server : undefined;
        const targets = server ? [server] : registry.serversWithResources();
        if (targets.length === 0) {
          return {
            title: "list_mcp_resource_templates",
            output: "No connected MCP server exposes resources.",
            isError: false,
          };
        }
        const chunks: string[] = [];
        for (const name of targets) {
          const tpl = await registry.listResourceTemplates(name);
          if (tpl.length === 0) {
            chunks.push(`${name}: (no templates)`);
            continue;
          }
          chunks.push(
            `${name}:\n` +
              tpl.map((t: any) => `  - ${t.uriTemplate}${t.name ? ` — ${t.name}` : ""}`).join("\n"),
          );
        }
        return { title: "list_mcp_resource_templates", output: chunks.join("\n\n"), isError: false };
      } catch (e: any) {
        return {
          title: "list_mcp_resource_templates",
          output: `Error listing MCP resource templates: ${e?.message || e}`,
          isError: true,
        };
      }
    },
  };
}

export function createReadMcpResourceTool(): ToolDef {
  return {
    id: "read_mcp_resource",
    description:
      "Read one resource from a connected MCP server by URI (get the URI from list_mcp_resources " +
      "or list_mcp_resource_templates). Text is returned inline; non-image binary resources are " +
      "decoded and saved to a file whose path is returned (read it with read/grep); images are saved " +
      "too, but their pixels are not visible to you.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["server", "uri"],
    },
    contract: { readOnly: true, accessScope: "workspace", persistResult: false },
    execute: async (args, ctx): Promise<ToolExecuteResult> => {
      const server = typeof args.server === "string" ? args.server : "";
      const uri = typeof args.uri === "string" ? args.uri : "";
      if (!server || !uri) {
        return { title: "read_mcp_resource", output: "Error: both `server` and `uri` are required.", isError: true };
      }
      try {
        const result = await getMCPRegistry().readResource(server, uri);
        // MCP 规定读资源失败用 isError 汇报（协议层失败则在上面 catch 里）
        if (result && (result as any).isError) {
          return {
            title: `read_mcp_resource: ${uri}`,
            output: `[MCP resource error] ${await formatResourceContents((result as any).contents, ctx)}`,
            isError: true,
          };
        }
        return {
          title: `read_mcp_resource: ${uri}`,
          output: await formatResourceContents((result as any)?.contents, ctx),
          isError: false,
        };
      } catch (e: any) {
        return {
          title: `read_mcp_resource: ${uri}`,
          output: `Error reading MCP resource: ${e?.message || e}`,
          isError: true,
        };
      }
    },
  };
}

/** 三个工具（按同一顺序注册，便于判据断言） */
export function createMcpResourceTools(): ToolDef[] {
  return [createListMcpResourcesTool(), createListMcpResourceTemplatesTool(), createReadMcpResourceTool()];
}
