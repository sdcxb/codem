/**
 * SpillStore — 工具输出溢出存储服务
 *
 * 设计对标 DSH `@deepseek-ai/dsh-spill` + `@deepseek-ai/dsh-spill-local`。
 *
 * 三角色分离（与 DSH 一致）：
 * - SpillStore（本文件）：服务定义 + 本地实现 — 持久化大文本 + 返回定位器
 * - SpillPolicy（spill-policy.ts）：post-execute 转换器 — 决定何时溢出并构建预览
 * - 工具管线：在 post-execute 层调用 SpillPolicy
 *
 * 语义：
 * - saveText 持久化 FULL content 原文，返回 opaque locator + 字节数 + 检索提示
 * - 存储按 sessionId 分组（会话级私有目录）
 * - saveText 在真实存储失败时 REJECTS — 调用方决定降级策略
 *
 * 模型体验：
 * - 大输出被替换为 head/tail 预览 + 定位器 + 检索提示
 * - 模型可用 read 工具按 offset/limit 读取溢出文件
 */

import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { tmpdir } from "os";

// ========== Vocabulary Types ==========

/** 不透明的模型面向定位器 — 本地后端是文件路径，未来后端可能是 URI/key */
export type SpillLocator = string;

/** 持久化溢出结果的请求 */
export interface SaveTextSpill {
  /** 拥有会话 — 存储命名空间 */
  owner: { sessionId: string };
  /** 产生此结果的工具和调用 — 用于命名和检查，非访问控制 */
  source: { toolName: string; callId: string; label: string };
  /** 调用方建议的文件名基名（如 "web_fetch.txt"）— 后端会净化 */
  suggestedName: string;
  /** 要持久化的完整文本（UTF-8） */
  content: string;
}

/** 已保存的溢出工件 */
export interface SpillRef {
  /** 模型面向的不透明定位器 */
  locator: SpillLocator;
  /** 已写入的字节数 */
  bytes: number;
  /** 模型面向的检索提示 */
  retrievalHint: string;
}

// ========== Local Spill Store Implementation ==========

/** 默认溢出根目录 — 每进程私有（0700），惰性创建 */
let defaultRoot: string | undefined;

/**
 * 获取默认溢出根目录：OS tmpdir 下的私有每进程目录。
 * 使用 mkdtempSync 生成不可预测后缀 + 0700 权限，
 * 防止其他本地用户读取溢出工具输出或预创建符号链接。
 */
function privateRoot(): string {
  if (!defaultRoot) {
    defaultRoot = fs.mkdtempSync(path.join(tmpdir(), "codem-spill-"));
  }
  return defaultRoot;
}

/**
 * 将任意字符串编码为单个安全路径段，在所有 JS 字符串上单射。
 * 中和 `../`、绝对路径、NUL 和分隔符。
 * 每个 code unit 要么字面保留（`[A-Za-z0-9._-]`），要么转义为 `~XXXX`。
 */
function encodeSegment(raw: string): string {
  if (raw.length === 0) return "~";
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

/**
 * 会话级目录：`<root>/session-<hash(sessionId)>`
 * 使用 SHA-256 前 12 字符作为稳定哈希。
 */
function sessionDir(root: string, sessionId: string): string {
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return path.join(root, `session-${hash}`);
}

// ========== SpillStore Service ==========

/**
 * 溢出存储服务 — 持久化工具的大文本输出并返回模型面向的定位器。
 *
 * 这是服务定义角色：定义 WHAT（持久化 + 定位器），不定义 HOW（后端选择存储方式）。
 * 当前内置本地文件系统后端，未来可替换为远程/数据库后端。
 */
export class SpillStore {
  /** 溢出根目录（可配置，默认为 privateRoot()） */
  private root: string;

  constructor(root?: string) {
    this.root = root || privateRoot();
  }

  /**
   * 持久化 `input.content` 到会话级溢出文件。
   *
   * @param input 拥有会话、来源、建议名和完整文本
   * @returns 已保存工件的 SpillRef（定位器 + 字节数 + 检索提示）
   * @throws 在真实存储失败时（权限、ENOSPC、后端不可用）
   */
  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const dir = sessionDir(this.root, input.owner.sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const safeName = encodeSegment(input.suggestedName);
    // 随机前缀 + 安全名 — 不可预测（防符号链接植入）且可读
    const fileName = `${randomBytes(6).toString("hex")}-${safeName}`;
    const filePath = path.join(dir, fileName);

    const bytes = Buffer.byteLength(input.content, "utf8");
    fs.writeFileSync(filePath, input.content, { encoding: "utf8", mode: 0o600 });

    const retrievalHint = "Use read with offset/limit, or grep this path to search within it.";

    return {
      locator: filePath,
      bytes,
      retrievalHint,
    };
  }

  /**
   * 检查路径是否为有效的溢出文件（安全验证）。
   */
  isSpillPath(locator: string): boolean {
    try {
      const dir = path.dirname(locator);
      // 必须在溢出根目录下
      if (!dir.startsWith(this.root)) return false;
      return fs.existsSync(locator);
    } catch {
      return false;
    }
  }
}

// ========== Singleton ==========

let spillStoreInstance: SpillStore | null = null;

export function getSpillStore(): SpillStore {
  if (!spillStoreInstance) {
    spillStoreInstance = new SpillStore();
  }
  return spillStoreInstance;
}

/**
 * 配置溢出根目录（可在应用启动时调用）。
 */
export function configureSpillRoot(root: string): void {
  spillStoreInstance = new SpillStore(root);
}
