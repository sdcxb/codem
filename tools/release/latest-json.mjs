/**
 * `latest.json`（Tauri **v2** 更新器清单）的**唯一构造器**。
 *
 * ## 为什么要有这个模块（真机查实的一整条坏链路）
 *
 * 更新器按 `{os}-{arch}-{installer}` 与 `{os}-{arch}` 两个候选键找平台
 * （`tauri-plugin-updater-2.10.1/src/updater.rs:578-597`，`updater_os()` 返 `windows`、
 * `updater_arch()` 返 `x86_64`）。而仓库里那个**被跟踪的**生成脚本
 * （`tools/release/make-latest-json.mjs` 的旧实现）写的是 **`platforms.windows`** ——
 * Tauri **v1** 的写法，在 v2 上**永远不会被读到**，
 * 「检查更新」会直接报 `None of the fallback platforms [...] were found`。
 *
 * 真实发布当时用的是 `.preview-shot/_audit/` 下一个**没入库**的脚本（写对了键），
 * 于是仓库里留下的是"一个错的工具 + 一份对的产物"：
 * 下一个人照工具跑一次，就会把自动更新悄悄弄坏，而 `latest.json` 的那个测试**测不到**
 * （它只看产物，不看生成器）。这就是"两个真相来源"的典型形态。
 *
 * 现在：**构造逻辑只有这一份**（这个模块），CLI 与测试都调它。
 *
 * ## 顺带记一条**不要回退**
 *
 * 别再加 `windows` 这种 v1 键当"兼容"：它在这条链路上永远不会被读到，
 * 只会让下一个人以为"键已经写全了"。
 */

export const REPO = "sdcxb/codem";

/** 发布产物（NSIS 安装包）在 GitHub Releases 上的文件名 */
export function assetName(version) {
  return `Codem_${version}_x64-setup.exe`;
}

/** 安装包在 GitHub Releases 上的下载地址 */
export function assetUrl(version, repo = REPO) {
  return `https://github.com/${repo}/releases/download/v${version}/${assetName(version)}`;
}

/**
 * 构造清单对象（**纯函数**：不读文件、不碰网络，便于测试）。
 *
 * @param {object} o
 * @param {string} o.version   版本号（不带 `v` 前缀）
 * @param {string} o.signature updater 签名文件内容（`Codem_x.y.z_x64-setup.exe.sig` 的全文）
 * @param {string} [o.notes]   更新提示里显示的说明（**按版本给**，不许写死旧版本的 headline）
 * @param {string} [o.pubDate] ISO 时间；缺省用当前时间（秒级，去掉毫秒）
 * @param {string} [o.repo]
 */
export function buildLatestManifest({ version, signature, notes = "", pubDate, repo = REPO }) {
  if (!version) throw new Error("buildLatestManifest: 缺 version");
  const sig = String(signature ?? "").trim();
  if (!sig) throw new Error("buildLatestManifest: 缺 signature（没有签名就不该发布）");
  if (/^v/.test(version)) throw new Error(`buildLatestManifest: version 不该带 v 前缀：${version}`);

  const entry = { signature: sig, url: assetUrl(version, repo) };
  return {
    version,
    notes,
    pub_date: pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      // 装成 NSIS 包时**第一个**被找的键
      "windows-x86_64-nsis": entry,
      // 兜底键：直接跑 target/release/codem.exe 时 installer 为 None，只会找这一个
      "windows-x86_64": entry,
    },
  };
}

/** 清单里平台键必须包含的候选（缺一个就有一条更新路径失效） */
export const REQUIRED_PLATFORM_KEYS = ["windows-x86_64-nsis", "windows-x86_64"];

/**
 * 自检：键必须在、URL 必须指向本版本、签名必须非空。
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateLatestManifest(manifest, { version } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["清单不是对象"];
  if (version && manifest.version !== version) problems.push(`version 是 ${manifest.version}，期望 ${version}`);
  const platforms = manifest.platforms ?? {};
  for (const key of REQUIRED_PLATFORM_KEYS) {
    if (!platforms[key]) problems.push(`缺平台键 ${key}（更新器会报 TargetsNotFound）`);
  }
  if (platforms.windows) problems.push("出现了 v1 的 `windows` 键（v2 更新器永远读不到它，别当兼容留着）");
  for (const [key, v] of Object.entries(platforms)) {
    if (!v || typeof v.signature !== "string" || !v.signature.trim()) problems.push(`${key} 缺签名`);
    if (!v || typeof v.url !== "string" || !v.url.startsWith("https://")) problems.push(`${key} 的 url 不是 https`);
    if (v && manifest.version && !v.url.includes(manifest.version)) problems.push(`${key} 的 url 里没有版本号 ${manifest.version}`);
  }
  return problems;
}
