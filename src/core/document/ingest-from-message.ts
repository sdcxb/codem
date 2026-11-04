/**
 * 入口 3.2：用户消息里**明确给出的本地路径** → 文档索引（ADR-0008 §12）。
 *
 * 设计取舍：
 * - **自动但可撤销**（Q2 决定）：只要「存在 + 文档扩展名 + 在允许根内」就登记，
 *   不要求用户先敲 `/index`；UI 的状态条能看到并移除。
 * - **只处理本条消息**：不扫历史，避免把对话里偶然出现的路径反复入索引。
 * - **不阻塞发送**：`handleSend` 里 fire-and-forget；索引慢不该让用户等。
 */

import { exists } from "../file-api";
import { collectIndexablePaths, stripCodeFromMessage } from "./path-ingest";
import { ingestPath } from "./client";

export interface PathIngestOutcome {
  path: string;
  jobId?: string;
  error?: string;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export async function ingestDocumentPathsFromMessage(params: {
  message: string;
  cwd: string;
  collectionId: string;
  /** 允许根（默认只允许当前工作目录/项目根）；空数组 = 不限制（仅测试用） */
  allowedRoots?: string[];
  maxPaths?: number;
}): Promise<PathIngestOutcome[]> {
  const roots = params.allowedRoots ?? (params.cwd ? [params.cwd] : []);
  const candidates = await collectIndexablePaths({
    message: stripCodeFromMessage(params.message),
    cwd: params.cwd,
    exists: (path) => exists(path),
    allowedRoots: roots,
    maxPaths: params.maxPaths ?? 20,
  });

  const out: PathIngestOutcome[] = [];
  for (const candidate of candidates) {
    try {
      const res = await ingestPath({
        collectionId: params.collectionId,
        path: candidate.path,
        kind: "path",
        name: baseName(candidate.path),
        sourceRef: candidate.raw,
      });
      out.push({ path: candidate.path, jobId: res.job_id });
    } catch (e: any) {
      // 单个路径失败不影响其他路径，也不影响消息发送
      out.push({ path: candidate.path, error: e?.message ?? String(e) });
    }
  }
  return out;
}
