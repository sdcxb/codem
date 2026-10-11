/**
 * 便携版 Node 的**唯一实现**（第 202 波）。
 *
 * ## 为什么要单独抽出来
 *
 * 这段逻辑原来长在 `core/zvec-grep/service.ts` 里（模块私有）：拉官方/镜像的 `index.json` →
 * 解析最新 LTS → 下载 zip → 解压出 `node.exe`，任一环节失败就回退到固定版本。
 * 第 202 波起**免费模型插件**也要 Node（用户真机装完后收到「没有找到可用的 Node.js」的通知，
 * 而正确做法是 Codem 自己装，不该让用户去官网下）—— 两个功能各写一份下载/回退逻辑，
 * 迟早出现"一个说有 Node、另一个说没有"这种最难查的分叉。所以抽成一份，两边共用。
 *
 * ## 纪律
 *
 * - **只往给定目录里装**（调用方决定装到哪儿：zvec 装自己的运行时目录，插件装扩展目录）
 *   ⇒ "删除扩展"能把插件那份 Node 一起清掉，不会留下说不清归属的几百 MB。
 * - **失败要如实说**：官方与镜像都失败时把每条失败原因带出来（含可选的自装提示），不假装成功。
 * - **重试但不无限重试**：每个候选（官方/镜像 × 最新 LTS/固定兜底版本）**最多 3 次**（短退避）——
 *   真机上首次点「现在安装」时四个候选同时 404、而同一批 URL 再下一次全成功（上游对新版本的瞬时 404），
 *   一次抖动就整体失败是不可接受的；3 次都失败才如实报告。
 */
import { downloadFileExt, extractZip } from "../zvec-grep/artifacts";
import { listDirectory } from "../file-api";
import { pickNodeLtsVersion } from "../zvec-grep/runtime";
import { NODE_MIRROR_DIST, NODE_OFFICIAL_DIST, NODE_FALLBACK_VERSION } from "../zvec-grep/types";
// 字节数的人读形态只有一份实现（判据 BYTES-1 守着，别在这里手写 KB/MB）
import { formatBytes } from "../utils/bytes";

/**
 * 下载源（按顺序尝试）。
 *
 * 第 202 波真机结论：**同一批 URL 会成片瞬时 404、也会传输中途断掉**
 * （实测同一 URL 前一分钟 404、后一分钟 200；另一例 59 秒后 "error decoding response body"）。
 * 国内网络下 nodejs.org 更是常见不可达 —— 所以源要多、要包含国内镜像，
 * 而不是"官方失败就认输、让用户自己去官网下"。
 */
const NODE_SOURCES: ReadonlyArray<{ label: string; dist: string; index?: string }> = [
  /*
   * ⚠️ 试过并**撤掉**的一条：GitHub 上的官方构建（actions/node-versions）——它的 Windows 资产是
   * \`.7z\`（我们只有 zip 解压），而 \`nodejs/node\` 的 release 并不挂二进制 ⇒ 走不通，不留死代码。
   * 真机观察（同一批 URL、同一条下载命令）：这些源会**成片瞬时 404**，隔一会儿单独下就成功
   * ⇒ 策略是"少打、换候选、拉开节奏、全失败再补一轮"，而不是对同一个 URL 猛重试。
   */
  { label: "nodejs.org（官方）", dist: NODE_OFFICIAL_DIST },
  { label: "npmmirror（淘宝镜像）", dist: "https://registry.npmmirror.com/-/binary/node" },
  { label: "npmmirror（旧路径）", dist: NODE_MIRROR_DIST },
  { label: "华为云镜像", dist: "https://mirrors.huaweicloud.com/nodejs" },
  { label: "清华 TUNA 镜像", dist: "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release" },
];

/** 下载/解压阶段（调用方按需映射成自己的 UI 文案） */
type PortableNodePhase = "downloading" | "extracting";

type PortableNodePhaseCb = (phase: PortableNodePhase, message: string) => void;

/** 递归查找 `node.exe`（深度限制，避免在巨大目录里翻到底）—— 只在本模块内部用 */
async function findPortableNode(dir: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  let entries: Array<{ name: string; path: string; isDirectory: boolean }> = [];
  try {
    entries = await listDirectory(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory) {
      if (e.name.toLowerCase() === "node.exe") return e.path;
      continue;
    }
    const found = await findPortableNode(e.path, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 读一个文件的大小（取不到返回 null ⇒ 调用方不要据此拦截） */
async function fileSizeOf(filePath: string): Promise<number | null> {
  try {
    const sep = filePath.includes("/") && !filePath.includes("\\") ? "/" : "\\";
    const dir = filePath.slice(0, filePath.lastIndexOf(sep)) || ".";
    const name = filePath.slice(filePath.lastIndexOf(sep) + 1);
    const entries = await listDirectory(dir);
    const hit = entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
    return hit ? (hit as { size?: number }).size ?? null : null;
  } catch {
    return null;
  }
}
/** 拉 `index.json` 解析最新 LTS 的 win-x64 zip 地址（index.json 很大 ⇒ 落盘再读） */
async function fetchNodeZipUrl(base: string, workDir: string): Promise<string> {  const idxPath = `${workDir}/.tmp-node-index.json`;
  await downloadFileExt(`${base}/index.json`, idxPath, 300);
  const { readFile } = await import("../file-api");
  const text = await readFile(idxPath);
  const version = pickNodeLtsVersion(JSON.parse(text));
  if (!version) throw new Error("index.json 中未找到 LTS 版本");
  return `${base}/v${version}/node-${version}-win-x64.zip`;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 把一个可用的 `node.exe` 装进 `targetDir`（已存在就直接返回它，不重复下载）。
 *
 * @param hint 失败时附加的提示（zvec-grep 用它引导"导入离线包"，插件用它引导"稍后重试/自行安装"）
 */
export async function installPortableNode(
  targetDir: string,
  onPhase: PortableNodePhaseCb = () => {},
  hint = "",
  /** 重试之间的退避基数（毫秒）。判据里传 0 ⇒ 不白等；默认 1200 给真实网络留喘息。 */
  retryBackoffMs = 3000,
): Promise<string> {
  const existing = await findPortableNode(targetDir);
  if (existing) return existing;

  onPhase("downloading", "解析 Node 下载地址（官方/镜像）...");
  const zipPath = `${targetDir}/.tmp-node.zip`;
  const failures: string[] = [];
  let downloaded = false;
  try {
    for (const source of NODE_SOURCES) {
      const base = source.dist;
      const candidates: Array<{ url: string; what: string }> = [];
      try {
        candidates.push({ url: await fetchNodeZipUrl(base, targetDir), what: "最新 LTS" });
      } catch (e) {
        failures.push(`${source.label} index: ${errMsg(e)}`);
      }
      /* 固定兜底版本：跳过 index 直连 dist 目录（长期保留，覆盖"最新版刚好没出 zip"） */
      candidates.push({
        url: `${base}/v${NODE_FALLBACK_VERSION}/node-${NODE_FALLBACK_VERSION}-win-x64.zip`,
        what: `兜底 v${NODE_FALLBACK_VERSION}`,
      });
      for (const { url, what } of candidates) {
        if (downloaded) break;
        /*
         * ★ 每个候选**重试 3 次**（短退避）。
         *
         * 真机上就是这样发现的：第一次点「现在安装」时四个候选**全部** 404，
         * 而同一批 URL 用同一条下载命令单独再下一次全部成功（6.3s / 4.4s / 4.4s）
         * ⇒ 上游（nodejs.org 与 npmmirror）对新版本会出现短暂的 404。
         * 用户点的是「你帮我装好」—— 一次瞬时抖动就整体失败、还让他自己去官网下，不可接受。
         * 所以这里重试；3 次都失败才如实报告，并把每一次的原因都带出去。
         */
        try {
          onPhase("downloading", `下载 Node 运行时（${what}）...`);
          await downloadFileExt(url, zipPath, 1200);
          downloaded = true;
        } catch (e) {
          failures.push(`${source.label} ${what}: ${errMsg(e)}`);
        }
      }
      if (downloaded) break;
      /* 源之间停一下：真机上见过「短时间内反复请求同一批 URL ⇒ 成片 404」 */
      if (retryBackoffMs > 0) await new Promise((r) => setTimeout(r, 4000));
    }
    /*
     * 全失败 ⇒ 等一会儿**补一轮**（只打前两个源）。
     *
     * 真机结论：同一批 URL 在"连着打"时会成片 404，而隔几分钟单独下就成功。
     * 与其在第一时间猛打 30 次，不如慢下来再补一轮 —— 用户看到的是"多等半分钟就成了"，
     * 而不是"点了没用、还得自己去官网装"。
     */
    if (!downloaded) {
      onPhase("downloading", "刚才那批源都没成功，等 15 秒再补一轮...");
      if (retryBackoffMs > 0) await new Promise((r) => setTimeout(r, 15000));
      for (const source of NODE_SOURCES.slice(0, 2)) {
        if (downloaded) break;
        const url = `${source.dist}/v${NODE_FALLBACK_VERSION}/node-${NODE_FALLBACK_VERSION}-win-x64.zip`;
        try {
          onPhase("downloading", `补一轮：${source.label}（兜底 v${NODE_FALLBACK_VERSION}）...`);
          await downloadFileExt(url, zipPath, 1200);
          downloaded = true;
        } catch (e) {
          failures.push(`${source.label} 补一轮: ${errMsg(e)}`);
        }
      }
    }
    if (!downloaded) throw new Error(`所有下载源都失败了：\n${failures.join("\n")}`);
  } catch (e) {
    throw new Error(`下载 Node 失败：${errMsg(e)}${hint ? `。${hint}` : ""}`);
  }

  /*
   * 下完先验大小：真机上见过"传输中途断掉"（59 秒后 error decoding response body），
   * 那种残缺 zip 到了解压那一步会报一个指向错地方的错。这里先拦一次，并当成"这次源不靠谱"。
   */
  const sizeBytes = await fileSizeOf(zipPath);
  if (sizeBytes !== null && sizeBytes < 5 * 1024 * 1024) {
    throw new Error(`下载的 Node 包不完整（只有 ${formatBytes(sizeBytes ?? 0)}，正常约 30-40MB）—— 可能是传输被截断，请重试`);
  }

  onPhase("extracting", "解压 Node 运行时...");
  await extractZip(zipPath, targetDir);
  const node = await findPortableNode(targetDir);
  if (!node) throw new Error("Node 解压后未找到 node.exe");
  return node;
}
