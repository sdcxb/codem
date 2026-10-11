/**
 * 第 204 波判据：更新下载的**进度换算**（用户实报「正在下载，看不到进度条，进度条一直不动」）。
 *
 * 守的是这条链：`downloadAndInstall(回调)` 收到的 Started/Progress/Finished 事件 → 界面能看见的
 * 字节数与百分比。真机上的三种形态都要对：
 * ① 有 `Content-Length` ⇒ 百分比**单调上涨**；
 * ② 没有 `Content-Length`（某些 CDN）⇒ 只报"已下载 x"，`percent` 为 `null`（**不许编百分比**）；
 * ③ 重试 ⇒ 归零重算（否则会出现 80% → 10% 的假动作）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyProgressEvent, emptyProgress, type DownloadProgress } from "../core/update/download-progress";

const feed = (events: Array<Parameters<typeof applyProgressEvent>[1]>): DownloadProgress =>
  events.reduce<DownloadProgress>((state, event) => applyProgressEvent(state, event), emptyProgress());

describe("UPD-PROGRESS：更新下载进度", () => {
  it("UPD-PROGRESS-1：Started 给总量、Progress 累加、百分比**单调上涨**且封顶 100%", () => {
    const started = applyProgressEvent(emptyProgress(), { event: "Started", data: { contentLength: 1000 } });
    expect(started.totalBytes).toBe(1000);
    expect(started.percent, "起点应当是 0%").toBe(0);

    const half = applyProgressEvent(started, { event: "Progress", data: { chunkLength: 500 } });
    expect(half.downloadedBytes).toBe(500);
    expect(half.percent).toBe(50);
    expect(half.label.zh, "文案要给「已下载 / 总量（百分比）」").toContain("50%");

    const over = applyProgressEvent(half, { event: "Progress", data: { chunkLength: 900 } });
    expect(over.downloadedBytes, "超过总量要夹住（分块统计与实际有出入）").toBe(1000);
    expect(over.percent, "**不许**出现 140%").toBe(100);

    const done = applyProgressEvent(over, { event: "Finished" });
    expect(done.percent).toBe(100);
  });

  it("UPD-PROGRESS-2：总量未知（没有 Content-Length）⇒ 只报已下载，percent 为 null", () => {
    const started = applyProgressEvent(emptyProgress(), { event: "Started", data: { contentLength: 0 } });
    expect(started.totalBytes, "0 当成未知（不是「总量 0 字节」）").toBeNull();
    expect(started.percent).toBeNull();

    const mid = applyProgressEvent(started, { event: "Progress", data: { chunkLength: 2048 } });
    expect(mid.downloadedBytes).toBe(2048);
    expect(mid.percent, "总量未知时不许编百分比（界面走不确定态）").toBeNull();
    expect(mid.label.zh, "要如实说总量未知").toContain("总量未知");
    expect(mid.label.zh).toContain("2.0 KB".slice(0, 3)); // 用了统一的人读实现（KB 级）

    const done = applyProgressEvent(mid, { event: "Finished" });
    expect(done.percent, "总量未知时完成也不能报 100%").toBeNull();
    expect(done.label.zh).toContain("下载完成");
  });

  it("UPD-PROGRESS-3：重试从零重算（Started 归零，不出现 80% → 10% 的假动作）", () => {
    const first = feed([
      { event: "Started", data: { contentLength: 1000 } },
      { event: "Progress", data: { chunkLength: 800 } },
    ]);
    expect(first.percent).toBe(80);

    /* 第二次尝试：插件会再发一个 Started ⇒ 必须归零 */
    const retry = applyProgressEvent(first, { event: "Started", data: { contentLength: 1000 } });
    expect(retry.downloadedBytes).toBe(0);
    expect(retry.percent, "重试之后进度回到 0（而不是停在 80%）").toBe(0);

    const again = applyProgressEvent(retry, { event: "Progress", data: { chunkLength: 100 } });
    expect(again.percent).toBe(10);
  });

  it("UPD-PROGRESS-4：未知事件 / 坏数据不许改状态，也不许算出 NaN", () => {
    const before = feed([{ event: "Started", data: { contentLength: 1000 } }]);
    expect(applyProgressEvent(before, { event: "SomethingElse" }), "未知事件原样返回").toEqual(before);

    const bad = applyProgressEvent(before, { event: "Progress", data: { chunkLength: Number.NaN } });
    expect(bad.downloadedBytes, "NaN 不许污染累加").toBe(0);
    expect(Number.isNaN(bad.percent ?? 0), "百分比不许是 NaN").toBe(false);

    const negative = applyProgressEvent(before, { event: "Progress", data: { chunkLength: -5 } });
    expect(negative.downloadedBytes, "负数分块按 0 处理").toBe(0);
  });
});
/**
 * 结构棘轮：这条 bug 的根因是「回调没传 + 进度条不存在」，两处都写在组件里，
 * 所以除了换算的纯函数判据，还要把**接线本身**锁住 —— 否则下次重构又会静默退化。
 */
describe("UPD-PROGRESS-WIRING：更新界面的接线棘轮", () => {
  const panel = readFileSync(path.resolve(__dirname, "../components/SettingsPanel.tsx"), "utf8");

  it("UPD-PROGRESS-5：downloadAndInstall 必须带事件回调（空参就等于把进度丢掉）", () => {
    expect(panel, "找不到 downloadAndInstall 调用").toContain("downloadAndInstall(");
    expect(panel, "不许再出现不带回调的调用").not.toMatch(/downloadAndInstall\(\)/);
    expect(panel, "回调里要把事件并进状态（否则进度条没有数据源）").toContain("applyProgressEvent(");
    expect(panel, "总量未知时的处理也要在（不确定态）").toContain("emptyProgress(");
  });

  it("UPD-PROGRESS-6：界面必须有真的进度条（可访问的 progressbar），且重试要归零", () => {
    expect(panel, "找不到进度条").toContain('role="progressbar"');
    expect(panel, "进度条要在渲染条件里（不许被短路掉）").toMatch(/\{updateProgress && \(/);
    expect(panel, "确定态要给出 aria-valuenow（读屏可感知）").toContain('"aria-valuenow": updateProgress.percent');
    expect(panel, "重试时进度归零（否则会出现 80% → 10% 的假动作）").toMatch(
      /attempt === 1\) return;[\s\S]{0,400}?downloadedBytes: 0/,
    );
  });
});

