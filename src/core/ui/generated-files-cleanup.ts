/**
 * 「清理过程文件」的物理删除 —— 从 `ChatPanel.tsx` / `NbChatPanel.tsx` 里抽出来的**唯一实现**。
 *
 * ## 第 184 波（UI 审计 F5）：删除失败**不许**抹记录
 *
 * 两块面板原来各写了一份逐字相同的代码：
 * ```ts
 * for (const file of files) {
 *   try { await (window as any).__TAURI__?.core.invoke("delete_file", { path: file }); }
 *   catch (e) { console.warn("[ChatPanel] Failed to delete file:", file, e); }   // ← 只有一行日志
 * }
 * removeGeneratedFiles(messageId, files);   // ← **无条件**执行（只改内存）
 * ```
 * 后果：文件被占用 / 只读 / 删除失败时，界面条目与落库记录（`generatedFiles?.length`
 * 参与 `messageFingerprint`，见 `src/store.ts:43`）**照样被抹掉** ——
 * 文件还在磁盘上，而"它是谁生成的、在哪"这个唯一线索没了，**不可逆**。
 *
 * 现在：只对**真的删掉**的条目调 `removeGeneratedFiles`；
 * 失败项**保留在清单里**并走仓库统一的可见通道（`reportActionFailure`），
 * 面板上另给一行如实提示。
 *
 * `removeGeneratedFiles` 的调用**留给面板**（它持有 store 绑定），
 * 这里只返回"哪些真的删掉了"这个事实 —— 判据因此可以只断言事实，不必渲染整块面板。
 */

import { reportActionFailure } from "../storage/persist-failure";

export interface DeleteGeneratedFilesResult {
  /** 物理删除成功的文件 */
  deleted: string[];
  /** 物理删除失败的文件（**必须**留在清单里） */
  failed: Array<{ file: string; error: string }>;
}

/**
 * 逐个物理删除。
 *
 * ⚠️ `window.__TAURI__` 缺失 / `invoke` 不存在也算**失败**（修前 `?.` 让整条链路
 * 静默变成 undefined，然后被当成"删掉了"）。
 */
export async function deleteGeneratedFiles(params: {
  files: string[];
  /** 调用哪个命令（默认 `delete_file`） */
  invoke?: (file: string) => Promise<unknown>;
  /** 失败上报的区域标识（"chatPanel.deleteFiles" / "nbChatPanel.deleteFiles"） */
  area: string;
}): Promise<DeleteGeneratedFilesResult> {
  const { files, area } = params;
  const invokeFn =
    params.invoke ??
    (async (file: string) => {
      const core = (globalThis as any).window?.__TAURI__?.core;
      if (!core || typeof core.invoke !== "function") {
        throw new Error("桌面删除通道不可用（__TAURI__.core.invoke 不存在）—— 文件未被删除");
      }
      return core.invoke("delete_file", { path: file });
    });

  const deleted: string[] = [];
  const failed: Array<{ file: string; error: string }> = [];
  for (const file of files) {
    try {
      await invokeFn(file);
      deleted.push(file);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 可见（不再只是一行 console.warn）：文件仍在，记录也必须留着
      console.warn(`[${area}] Failed to delete file:`, file, e);
      reportActionFailure(area, e, `文件仍在磁盘上：${file}（已保留清单条目，可重试）`);
      failed.push({ file, error: message });
    }
  }
  return { deleted, failed };
}
