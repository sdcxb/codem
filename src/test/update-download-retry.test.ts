/**
 * 更新包下载的**有界重试**与**可读错误**（第 82 轮，关闭 `GAP-LIST.md` 的 O-9）
 *
 * ## 现场（本机两次复现）
 *
 * 装机版点「检查更新」：按钮先显示 `发现新版本 1.16.126，下载中…`，
 * 然后变成 **`更新失败: error decoding response body`**。
 * 同一台机器上独立 `curl` 下同一个 40MB 包，第一次在 **27MB** 处 `exit 56`，
 * 加 `--retry 3 --retry-all-errors` 才下全、sha256 与清单一致
 * ⇒ **包没问题，是网络会把长下载掐断**；而应用这一侧"一次失败就放弃 + 印原始错误"。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | UR-1 | 真机形态（第 1 次失败、第 2 次成功）必须**真的重试并成功**，且 `onAttempt` 报出 (2/3) |
 * | UR-2 | 连续失败到上界 ⇒ 恰好尝试 3 次（**有界**），抛出**最后一次的原始错误**（不包装） |
 * | UR-3 | **签名/校验/权限类错误一次就抛、不许重试**（重试会把严重问题稀释成"网络不好"） |
 * | UR-4 | 退避 800→1600ms（用例注入 sleep，不真等），且第一次尝试**不等待** |
 * | UR-5 | `describeUpdateError` 对真机那句给出"原因 + 下一步"并**保留原文**；签名类明说"重试没有用" |
 * | UR-6 | 结构判据：更新按钮必须走 `downloadWithRetry`，**不许**再裸调 `update.downloadAndInstall()` |
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  downloadWithRetry,
  describeUpdateError,
  isRetryableUpdateError,
  MAX_DOWNLOAD_ATTEMPTS,
} from "../core/update/update-retry";

const ROOT = process.cwd();

/** 真机那一句（`reqwest` 的原文） */
const REAL_ERROR = "error decoding response body";

describe("更新包下载：有界重试 + 可读错误（第 82 轮）", () => {
  it("UR-1: 真机形态 —— 第 1 次被掐断、第 2 次成功 ⇒ 必须重试成功并报出进度", async () => {
    const attempts: Array<{ attempt: number; total: number; waitedMs: number }> = [];
    let calls = 0;
    const result = await downloadWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error(REAL_ERROR);
        return "installed";
      },
      { attempts: 3, baseDelayMs: 800, sleep: async () => {}, onAttempt: (i) => attempts.push(i) },
    );

    expect(result, "第 2 次成功就必须把成功结果带出来").toBe("installed");
    expect(calls, "run 必须被调用两次（一次失败 + 一次成功）").toBe(2);
    expect(attempts.map((a) => a.attempt), "界面要能显示第几次尝试").toEqual([1, 2]);
    expect(attempts[0].waitedMs, "第一次尝试不等待").toBe(0);
    expect(attempts[1].waitedMs, "第二次尝试前退避 800ms").toBe(800);
    expect(attempts[1].error, "重试时要能看到上一次的原因（用于日志）").toBeInstanceOf(Error);
  });

  it("UR-2: 一直失败 ⇒ 恰好尝试 3 次（有界）且抛出**最后一次的原始错误**", async () => {
    let calls = 0;
    const err = new Error(REAL_ERROR);
    await expect(
      downloadWithRetry(async () => { calls++; throw err; }, { attempts: 3, sleep: async () => {} }),
    ).rejects.toBe(err); // ⚠️ 必须是**同一个**错误对象：包装会丢掉 isRetryable 需要的原始特征
    expect(calls, "上界是 3 次，不许无限重试").toBe(3);
  });

  it("UR-3: 签名/权限类错误**一次就抛**（重试没有意义）", async () => {
    const signatureErr = new Error("signature verification failed: invalid signature");
    expect(isRetryableUpdateError(signatureErr), "签名类不许被判成可重试").toBe(false);

    let calls = 0;
    await expect(
      downloadWithRetry(async () => { calls++; throw signatureErr; }, { attempts: 3, sleep: async () => {} }),
    ).rejects.toBe(signatureErr);
    expect(calls, "签名类错误只许试一次").toBe(1);

    // 反向对照：网络类必须判成可重试（否则上面那条"一次就抛"会掩盖真正的网络问题）
    expect(isRetryableUpdateError(new Error(REAL_ERROR))).toBe(true);
    // 不认识的错误默认**不重试**（宁可少试一次，也不把未知问题当网络抖动）
    expect(isRetryableUpdateError(new Error("some brand new failure we never saw"))).toBe(false);

    /*
     * ⚠️ **优先级**：同时含"签名"与"网络"特征的错误必须按**签名**处理（⇒ 不可重试）。
     *
     * 这一条是突变验证逼出来的：第一版只测了纯签名串（`signature verification failed`），
     * 而它本来就不含任何网络特征串 —— 于是把"排除签名"那段代码删掉之后判据**照样绿**
     * （Mutation M4 未被抓住）。也就是说那条用例当时**根本没在判优先级**。
     * 真实世界确实会出现混合串：下载被掐断之后，装配/校验阶段报的错会带上底层连接信息。
     */
    const mixed = new Error("signature verification failed: unexpected end of stream (connection reset)");
    expect(isRetryableUpdateError(mixed), "混合串必须按签名类处理 ⇒ 不可重试").toBe(false);
    let mixedCalls = 0;
    await expect(
      downloadWithRetry(async () => { mixedCalls++; throw mixed; }, { attempts: 3, sleep: async () => {} }),
    ).rejects.toBe(mixed);
    expect(mixedCalls, "混合串同样只许试一次").toBe(1);
  });

  it("UR-4: 退避按 800→1600 递增，且注入的 sleep 收到真实延时", async () => {
    const slept: number[] = [];
    let calls = 0;
    await downloadWithRetry(
      async () => {
        calls++;
        if (calls < 4) throw new Error(REAL_ERROR);
        return "ok";
      },
      { attempts: 4, baseDelayMs: 800, sleep: async (ms) => { slept.push(ms); } },
    );
    expect(slept, "4 次尝试 ⇒ 3 次退避，且翻倍").toEqual([800, 1600, 3200]);
    expect(calls).toBe(4);
  });

  it("UR-4b: 次数会被夹到硬性上界（传 999 也不许变成「无限重试」）", async () => {
    let calls = 0;
    await expect(
      downloadWithRetry(async () => { calls++; throw new Error(REAL_ERROR); }, { attempts: 999, sleep: async () => {} }),
    ).rejects.toThrow();
    expect(calls, `硬性上界 ${MAX_DOWNLOAD_ATTEMPTS}`).toBe(MAX_DOWNLOAD_ATTEMPTS);
  });

  it("UR-5: 错误措辞给出「原因 + 下一步」，并且**保留原文**", () => {
    const zh = describeUpdateError(new Error(REAL_ERROR), "zh");
    expect(zh, "要说清是「下载被掐断」").toContain("掐断");
    expect(zh, "要给出下一步").toMatch(/重试|手动下载/);
    expect(zh, "原文必须带出来（用户能贴给我们）").toContain(REAL_ERROR);

    const sign = describeUpdateError(new Error("signature verification failed"), "zh");
    expect(sign, "签名类必须明说重试没用").toContain("重试没有用");
    expect(sign).toContain("signature verification failed");

    const unknown = describeUpdateError(new Error("totally new failure"), "zh");
    expect(unknown, "不认识的错误不许编原因，但要带原文").toContain("totally new failure");
    expect(describeUpdateError(undefined, "en"), "空错误也要有话说（不许空字符串）").not.toBe("");
  });

  it("UR-6: 更新按钮必须走这条路径（结构判据）", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/components/SettingsPanel.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    /*
     * ⚠️ 判据必须**锚在行首的 `await`** 上：第一版写成"文本里出现 `downloadWithRetry(() => …)` 即可"，
     * 于是把那一行改成 `if (false) await downloadWithRetry(...)`（等于没走这条路径）
     * 判据**照样绿**（Mutation M6 未被抓住）。锚行首之后，"被 if/注释/别的前缀包起来"就红。
     */
    expect(src, "必须有一条**独立语句**形态的 `await downloadWithRetry(...)`").toMatch(
      /\n\s*await downloadWithRetry\(\(\) => update\.downloadAndInstall\(\), \{/,
    );
    expect(src, "不许再有裸的 `await update.downloadAndInstall()`（那是一次失败就放弃的旧写法）").not.toMatch(
      /await\s+update\.downloadAndInstall\(\)/,
    );
    expect(src, "错误措辞必须走 describeUpdateError").toContain("describeUpdateError(");
    // 反向对照：确认这个正则真的在判（把前缀加上就该匹配不上）
    expect(
      "              if (false) await downloadWithRetry(() => update.downloadAndInstall(), {",
      "对照项：带前缀的形态必须判不通过",
    ).not.toMatch(/\n\s*await downloadWithRetry\(\(\) => update\.downloadAndInstall\(\), \{/);
  });
});
