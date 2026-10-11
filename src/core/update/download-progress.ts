/**
 * 「检查更新」下载进度的换算（第 204 波，用户实报）。
 *
 * ## 用户报的是什么
 *
 * > 有个小bug，检查更新升级的时候，正在下载，看不到进度条，进度条一直不动。
 *
 * 真机与代码对上了，而且是**两件事**：
 * 1. 更新界面里**根本没有进度条** —— 只有一句静态文案「发现新版本 x.y.z，下载中…」；
 * 2. `update.downloadAndInstall()` **没传事件回调** ⇒ `tauri-plugin-updater` 发的
 *    `Started / Progress / Finished` 事件（`Progress` 带 `chunkLength`）**根本没人接**。
 *    所以哪怕加一根进度条，也没数据可动。
 *
 * 这里把"事件流 → 进度状态"做成**纯函数**：界面只负责渲染，判定与边界都在这里，可单测。
 *
 * ## 边界（真机上都会遇到，必须写死口径）
 *
 * - **总量未知**（`contentLength` 缺失或 0 —— 有些 CDN 不回 `Content-Length`）：
 *   `percent` 为 `null`，界面显示**不确定态**并只报"已下载 x MB"，**不许**编一个百分比出来；
 * - **超过总量**（分块统计与实际略有出入）⇒ 夹在 100%，不显示 103%；
 * - **重试**（`update-retry` 的第 2/3 次尝试）⇒ 从**零重新计**，否则进度会显示成 80% 又跳回 10%；
 * - **完成**⇒ 若有总量则直接顶到 100%（`Finished` 事件本身不带字节数）。
 */
import { formatBytes } from "../utils/bytes";

/** 更新下载的进度状态（界面直接渲染它） */
export interface DownloadProgress {
  /** 已下载字节数（重试时归零） */
  downloadedBytes: number;
  /** 总量（未知时为 null —— 有些源不回 Content-Length） */
  totalBytes: number | null;
  /** 百分比 0..100（总量未知时为 null ⇒ 界面走不确定态） */
  percent: number | null;
  /** 人读文案（中英各一份，界面按语言选） */
  label: { zh: string; en: string };
}

/** 插件事件的最小形状（只取我们真正用到的字段，避免和上游类型强耦合） */
export interface UpdateDownloadEvent {
  event: "Started" | "Progress" | "Finished" | string;
  data?: { contentLength?: number; chunkLength?: number };
}

export function emptyProgress(): DownloadProgress {
  return {
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    label: { zh: "正在下载…", en: "Downloading…" },
  };
}

function describe(downloaded: number, total: number | null): DownloadProgress["label"] {
  const got = formatBytes(downloaded);
  if (total === null) {
    return { zh: `已下载 ${got}（总量未知）`, en: `Downloaded ${got} (total unknown)` };
  }
  const all = formatBytes(total);
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
  return { zh: `${got} / ${all}（${pct}%）`, en: `${got} / ${all} (${pct}%)` };
}

/** 把一次插件事件并进进度状态（**纯函数**：同样的输入永远同样的输出） */
export function applyProgressEvent(state: DownloadProgress, event: UpdateDownloadEvent): DownloadProgress {
  const kind = String(event.event ?? "");
  const contentLength = Number(event.data?.contentLength ?? 0);
  const chunkLength = Number(event.data?.chunkLength ?? 0);

  if (kind === "Started") {
    const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
    return { downloadedBytes: 0, totalBytes: total, percent: total ? 0 : null, label: describe(0, total) };
  }

  if (kind === "Progress") {
    const step = Number.isFinite(chunkLength) && chunkLength > 0 ? chunkLength : 0;
    const downloaded = state.downloadedBytes + step;
    const total = state.totalBytes;
    if (!total) {
      /* 总量未知：只报"已下载多少"，**不编百分比** */
      return { ...state, downloadedBytes: downloaded, label: describe(downloaded, null) };
    }
    const clamped = Math.min(downloaded, total);
    const percent = Math.min(100, Math.round((clamped / total) * 100));
    return { downloadedBytes: clamped, totalBytes: total, percent, label: describe(clamped, total) };
  }

  if (kind === "Finished") {
    const total = state.totalBytes;
    const downloaded = total ?? state.downloadedBytes;
    return {
      downloadedBytes: downloaded,
      totalBytes: total,
      percent: total ? 100 : null,
      label: total ? describe(total, total) : { zh: "下载完成", en: "Download finished" },
    };
  }

  /* 未知事件：原样返回（**不猜**，也不改状态） */
  return state;
}
