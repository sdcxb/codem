/**
 * Attachment Sync Service — 上传附件时同步到项目工作目录的 .attachments/ 子目录。
 *
 * 对标 Wegent 的 sandbox_file_syncer：附件不仅存在 DB 里，还同步到文件系统，
 * 让 LLM 可以用 read / grep / glob 等文件工具直接操作附件内容，而不局限于
 * read_attachment 工具的分页读取。
 *
 * 同步策略：
 * - 文本类附件（file/code）：写入 .attachments/{attachmentId}-{filename}
 * - 图片附件：不同步到文件系统（vision channel 处理）
 * - URL 附件：不同步（无文件内容）
 *
 * 路径规则：{workspace}/.attachments/{id}-{name}
 * 该路径会存入 attachment.sandboxPath，并在内联预览中告诉 LLM。
 */

import { writeFile } from "../file-api";
import type { MessageAttachment } from "../../store";

/** 项目工作区内的附件目录名（相对路径） */
const ATTACHMENTS_DIR = ".attachments";

/**
 * 将附件同步到项目工作目录。
 * 只在 Tauri 模式下执行（浏览器模式无文件系统访问）。
 *
 * @param att 附件对象（会被原地修改 sandboxPath 字段）
 * @param workspace 项目工作目录绝对路径
 * @returns 更新后的附件（sandboxPath 已填充），如果同步失败则不变
 */
export async function syncAttachmentToWorkspace(
  att: MessageAttachment,
  workspace: string,
): Promise<MessageAttachment> {
  // 图片和 URL 不同步
  if (att.type === "image" || att.type === "url") {
    return att;
  }

  // 需要有内容才能同步
  const content = att.content || att.preview;
  if (!content) {
    return att;
  }

  // 构建沙箱路径：.attachments/{id}-{name}
  // 用 id 前缀避免同名文件冲突
  // 安全清理：先消除 ".." 防止路径穿越，再清理其他特殊字符
  const sanitized = att.name
    .replace(/\.\./g, "_") // 防止路径穿越
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "_");
  const safeName = sanitized;
  const relativePath = `${ATTACHMENTS_DIR}/${att.id}-${safeName}`;

  try {
    // 写入工作目录（writeFile 会处理路径拼接）
    const fullPath = `${workspace}/${relativePath}`.replace(/\\/g, "/");
    await writeFile(fullPath, content, { workspace });
    att.sandboxPath = relativePath;
    console.log(`[attachment-sync] Synced "${att.name}" to ${relativePath}`);
  } catch (err) {
    // 同步失败不阻塞上传流程，LLM 仍可用 read_attachment 读
    console.warn(`[attachment-sync] Failed to sync "${att.name}":`, err);
  }

  return att;
}

/**
 * 批量同步附件到工作目录。
 */
export async function syncAttachmentsToWorkspace(
  attachments: MessageAttachment[],
  workspace: string,
): Promise<MessageAttachment[]> {
  const results: MessageAttachment[] = [];
  for (const att of attachments) {
    const synced = await syncAttachmentToWorkspace(att, workspace);
    results.push(synced);
  }
  return results;
}
