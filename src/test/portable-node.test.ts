/**
 * 第 202 波判据：**便携版 Node 的下载/回退/重试**（`core/portable-node` 的唯一实现）。
 *
 * ## 这些判据守的是真机踩出来的坑
 *
 * 第一次点「现在安装」时，四个候选（官方最新 LTS、官方兜底版本、镜像最新 LTS、镜像兜底版本）
 * **全部 404**；而同一批 URL 用**同一条下载命令**单独再下一次，三个都成功
 * （6.3s / 4.4s / 4.4s）⇒ 上游对新版本会出现**瞬时 404**。用户点的是"你帮我装好"，
 * 一次抖动就整体失败、还让他自己去官网下，是不可接受的 —— 所以每个候选要重试。
 *
 * 判据只覆盖这一层的**契约**（重试、回退、失败如实），不联网：
 * 依赖（`downloadFileExt` / `extractZip` / `listDirectory` / index 解析）全部注入假实现。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const downloadMock = vi.fn();
const extractMock = vi.fn();
const listDirectoryMock = vi.fn();
const readFileMock = vi.fn();
const pickLtsMock = vi.fn();

vi.mock("../core/zvec-grep/artifacts", () => ({
  downloadFileExt: (...a: unknown[]) => downloadMock(...a),
  extractZip: (...a: unknown[]) => extractMock(...a),
}));
vi.mock("../core/file-api", () => ({
  listDirectory: (...a: unknown[]) => listDirectoryMock(...a),
  readFile: (...a: unknown[]) => readFileMock(...a),
}));
vi.mock("../core/zvec-grep/runtime", () => ({
  pickNodeLtsVersion: (...a: unknown[]) => pickLtsMock(...a),
}));

import { installPortableNode } from "../core/portable-node";

const TARGET = "C:\\appdata\\extensions\\our-free-model\\runtime";

beforeEach(() => {
  vi.clearAllMocks();
  /* 目标目录一开始是空的（没有任何 node.exe）；解压后目录里出现它 */
  listDirectoryMock.mockResolvedValue([]);
  extractMock.mockImplementation(async () => {
    listDirectoryMock.mockResolvedValue([
      { name: "node-v22-x64", path: `${TARGET}\\node-v22-x64`, isDirectory: true },
      { name: "node.exe", path: `${TARGET}\\node-v22-x64\\node.exe`, isDirectory: false },
    ]);
    return 1;
  });
  readFileMock.mockResolvedValue(JSON.stringify([{ version: "v24.21.0", lts: "Krypton" }]));
  pickLtsMock.mockReturnValue("24.21.0");
});

describe("PORTABLE-NODE：便携版 Node 的下载契约", () => {
  it("PN-1：目标目录里已经有 node.exe ⇒ **不下载**，直接复用它", async () => {
    listDirectoryMock.mockResolvedValue([
      { name: "node.exe", path: `${TARGET}\\node.exe`, isDirectory: false },
    ]);
    const exe = await installPortableNode(TARGET, () => {}, "", 0);
    expect(exe).toBe(`${TARGET}\\node.exe`);
    expect(downloadMock, "已经有了就不该再下 30MB").not.toHaveBeenCalled();
  });

  it("PN-2：某个候选瞬时失败 ⇒ **同一个源换兜底版本接着试**（不让用户白点一次）", async () => {
    /*
     * 真机结论：同一批 URL 会成片瞬时 404，而隔一会儿单独下就成功。
     * 所以契约不是"对同一个 URL 猛重试 3 次"（那会把请求打成串、更容易被整片拒掉），
     * 而是：**换候选/换源、把节奏拉开、全失败再补一轮** —— 用户侧的感受是"多等一下就成了"。
     */
    downloadMock
      /* 顺序：index.json（成功）→ 最新 LTS 的 zip（失败）→ 兜底版本的 zip（成功） */
      .mockResolvedValueOnce("index.json")
      .mockRejectedValueOnce(new Error("HTTP 404 Not Found: https://nodejs.org/dist/v24.21.0/…zip"))
      .mockResolvedValueOnce("ok");

    const phases: string[] = [];
    const exe = await installPortableNode(TARGET, (_p, message) => phases.push(message), "", 0);

    expect(exe, "换了候选之后要拿到 node.exe").toContain("node.exe");
    const urls = downloadMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("v24.21.0")), "前提：先试了最新 LTS").toBe(true);
    expect(urls.some((u) => u.includes("v24.19.0")), "最新 LTS 失败后要换兜底版本").toBe(true);
    expect(phases.length, "要有进度，别让用户以为卡了").toBeGreaterThan(1);
    expect(extractMock, "下载成功后才解压").toHaveBeenCalledTimes(1);
  });

  it("PN-3：官方源失败要**回退到镜像**（并换兜底版本），最终成功", async () => {
    downloadMock.mockImplementation(async (url: string) => {
      if (String(url).includes("nodejs.org")) throw new Error("HTTP 502: 官方源挂了");
      return "ok";
    });
    const exe = await installPortableNode(TARGET, () => {}, "", 0);
    expect(exe).toContain("node.exe");
    const urls = downloadMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("npmmirror")), "官方全失败之后要试镜像").toBe(true);
    expect(urls.some((u) => u.includes("nodejs.org")), "前提：确实先试过官方源").toBe(true);
  });

  it("PN-4：全都失败要**如实报错**（原因逐条带出，不假装成功）", async () => {
    downloadMock.mockRejectedValue(new Error("HTTP 404 Not Found"));
    await expect(installPortableNode(TARGET, () => {}, "可以稍后重试", 0)).rejects.toThrow(/下载 Node 失败/);
    await expect(installPortableNode(TARGET, () => {}, "可以稍后重试", 0)).rejects.toThrow(/补一轮|所有下载源/);
    await expect(installPortableNode(TARGET, () => {}, "可以稍后重试", 0)).rejects.toThrow(/可以稍后重试/);
    expect(extractMock, "没下到就不该去解压").not.toHaveBeenCalled();
  });
});
