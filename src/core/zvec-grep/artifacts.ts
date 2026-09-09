/**
 * zvec-grep 运行时安装的 Rust command 封装。
 *
 * Rust 侧（src-tauri/src/lib.rs）：
 * - http_download_ext(url, dest_path, timeout_secs?, headers?) — 长超时大文件下载
 * - extract_zip(zip_path, dest_dir) — zip-slip 安全的 zip 解压
 *
 * 前端不接触大二进制内存：下载直接落盘（Rust），解压在 Rust 完成。
 */

export async function downloadFileExt(
  url: string,
  destPath: string,
  timeoutSecs?: number,
): Promise<string> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri runtime not available");
  }
  return invoke("http_download_ext", {
    url,
    destPath,
    timeoutSecs: timeoutSecs ?? null,
    headers: null,
  }) as Promise<string>;
}

/** 解压 zip 到目录，返回写入文件数 */
export async function extractZip(zipPath: string, destDir: string): Promise<number> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) {
    throw new Error("Tauri runtime not available");
  }
  return invoke("extract_zip", { zipPath, destDir }) as Promise<number>;
}

/** 应用数据目录（含尾部 .codem 前缀的基础路径） */
export async function getAppDataBaseDir(): Promise<string> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) return ".codem";
  const dataDir: string = await invoke("get_app_data_dir");
  const sep = dataDir.includes("/") && !dataDir.includes("\\") ? "/" : "\\";
  return dataDir.endsWith(".codem") || dataDir.endsWith(".codem/")
    ? dataDir
    : `${dataDir}.codem${sep}`;
}
