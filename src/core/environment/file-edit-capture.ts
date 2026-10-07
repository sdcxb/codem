/**
 * **编辑前整文件捕获**（第 46 波 ✓，照 DSH 的 `dsh-workspace-changes` ✓）。
 *
 * ## 为什么必须有它（这是 B 项的前置 ✓）
 *
 * 现状 ✓：`FileChangeTracker` 靠**每个有改动的迭代都跑一遍 git**（`stash create` +
 *   `rev-parse` + `ls-files` + 两次 `diff` ✓）来判断"这一轮改了什么" ✓ ——
 *   实测 **~180 次 git 调用/格** ✓（占全部 exec 的 88% ✓，≈57s/格 ≈ 12% 墙钟 ✗）。
 *
 * DSH 的做法 ✓（`dsh-workspace-changes` 文档原文 ✓）：
 *   「在 `write`、`edit` … 调用运行之前，记录器把该路径上的文件**复制**到 Session 的临时目录，
 *     每轮每个路径只复制第一次，轮次结束时再复制一次；副本按其字节的 **SHA-1** 命名，
 *     相同内容只存一份。**这一步不需要 git。**」✓
 *   ⇒ ★ 于是"改了没有 / 改了又还原没有"**不必靠 git 快照** ✓ —— 用**内容哈希**就够 ✓✓
 *
 * 本模块只做**最纯的那一半** ✓：把"编辑前的样子"按路径记下来（首次优先 ✓），
 *   并提供"现在和编辑前是否一样"（= **被还原** ✓）✓。
 *   ⇒ 它**不调 git、不读 SQLite、不发事件** ✓ ⇒ 可以独立判据 ✓、也不改任何现有行为 ✓。
 *
 * ## 已知边界（写清 ✓）
 * · 只记 **SHA-1 + 字节数** ✓（不存内容 ✓）⇒ 够判"是否被还原" ✓，不能用来回滚内容 ✗
 *   （回滚仍走既有的 git patch 通道 ✓，本模块不动它 ✓）
 * · 超过 `maxBytes` 的文件只记 `oversized` ✓（不读内容 ✓）——与 DSH 的 `maxFileBytes` 同规 ✓
 * · 二进制/读不到（权限、目录、临时文件）一律返回 `null` ✓ 并**静默跳过** ✓（宁可少记，不可报错 ✗）
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface CapturedFile {
  /** 捕获时的绝对路径（原样保留 ✓，调用方负责归一 ✓） */
  path: string;
  /** 捕获时的内容哈希（`sha1:<hex>` ✓）；`oversized` 时为 `""` ✓ */
  sha1: string;
  /** 捕获时的字节数 ✓ */
  size: number;
  /** 超过上限 ⇒ 没读内容 ✓ */
  oversized?: boolean;
}

export interface FileEditCaptureOptions {
  /** 单文件上限（字节 ✓）；超过只记 `oversized` ✓。默认 2 MiB（与 DSH 的 `maxFileBytes` 同值 ✓） */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

const hashOf = (buf: Buffer): string => "sha1:" + createHash("sha1").update(buf).digest("hex");

export class FileEditCapture {
  private readonly maxBytes: number;
  /** 首次捕获优先 ✓（"编辑前"必须是**最初**那一次 ✓） */
  private readonly captured = new Map<string, CapturedFile>();

  constructor(opts: FileEditCaptureOptions = {}) {
    this.maxBytes = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  }

  /**
   * 记录某路径**编辑前**的样子 ✓。
   * @returns 本次实际记录的那条 ✓；若该路径**已记过** ⇒ 返回**原来那条** ✓（首记优先 ✓）；
   *          读不到（不存在/权限/目录）⇒ `null` ✓。
   */
  capture(path: string): CapturedFile | null {
    const seen = this.captured.get(path);
    if (seen) return seen;
    let size = 0;
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      size = st.size;
    } catch {
      return null;
    }
    if (size > this.maxBytes) {
      const rec: CapturedFile = { path, sha1: "", size, oversized: true };
      this.captured.set(path, rec);
      return rec;
    }
    try {
      const rec: CapturedFile = { path, sha1: hashOf(readFileSync(path)), size };
      this.captured.set(path, rec);
      return rec;
    } catch {
      return null;
    }
  }

  has(path: string): boolean {
    return this.captured.has(path);
  }

  get(path: string): CapturedFile | undefined {
    return this.captured.get(path);
  }

  size(): number {
    return this.captured.size;
  }

  paths(): string[] {
    return [...this.captured.keys()];
  }

  /**
   * 该路径**现在**的内容是否与捕获时一致 ✓。
   *
   * 用途 ✓：`true` = 这个文件**回到了编辑前的样子** ✓（"改了又还原" ✓ —— 现有 `reverted` 守卫
   *   正是要这种信号 ✓，而它以后不必再靠 git 快照 ✓）。
   *
   * 保守约定 ✓（不利情形都给 `false` ✓，宁可说"变了" ✗ 也不误报"还原了" ✗）：
   *   · 没有捕获记录 ⇒ `false` ✓
   *   · `oversized` ⇒ `false` ✓（没读过内容 ⇒ 不能断言相同 ✓）
   *   · 现在读不到（被删/权限/目录）⇒ `false` ✓
   *   · 字节数先比 ✓（不同 ⇒ `false` ✓，省一次哈希 ✓）
   */
  isSameAsCaptured(path: string): boolean {
    const rec = this.captured.get(path);
    if (!rec || rec.oversized || !rec.sha1) return false;
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size !== rec.size) return false;
      return hashOf(readFileSync(path)) === rec.sha1;
    } catch {
      return false;
    }
  }

  /** 已捕获、且**现在与捕获时一致**的路径 ✓（= 被还原的那些 ✓，按捕获顺序 ✓） */
  revertedPaths(): string[] {
    return [...this.captured.keys()].filter((p) => this.isSameAsCaptured(p));
  }

  clear(): void {
    this.captured.clear();
  }
}
