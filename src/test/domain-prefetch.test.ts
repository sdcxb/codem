/**
 * 域镜像预取的契约（第 12 轮）。
 *
 * ## 守的是什么
 *
 * 域镜像是"**同步读、异步加载**"：面板首次渲染时同步读一次，若那一刻镜像还没就绪，
 * 它拿到的是"该域的合理空结果"（B 态的正确行为）—— 而**没有任何东西会在稍后重读**。
 * 项目列表之所以没事，是 `App.tsx` 里给它单独打过补丁（第 24 轮），其余十几个域都没有。
 *
 * 真机日志（v1.16.57 启动）：
 * `[Store] loadFromDB: found 0 "projects"` → 端口就绪后重读 → `found 1 "projects"`。
 *
 * `prefetchDomainMirrors()` 的作用就是把这个窗口挪到首屏之前，并且**如实报告**
 * 哪些表没就绪（而不是静默略过）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { domainReadMany } from "../core/storage/domain-store";
import { createFakeStoragePort } from "./fake-storage-port";

afterEach(() => {
  setStoragePort(null);
});

describe("域镜像预取", () => {
  it("PF-1: 正常情况全部就绪，且返回耗时（不阻塞启动）", async () => {
    const port = createFakeStoragePort({ seed: { projects: [{ id: "p1", name: "P" }] } });
    setStoragePort(port);

    const { prefetchDomainMirrors, HOT_DOMAIN_TABLES } = await import("../core/storage/bootstrap");
    const pf = await prefetchDomainMirrors({ tables: ["projects", "goals", "inbox"] });

    expect(pf.pending, "全部就绪时不该有 pending").toEqual([]);
    expect(pf.ready.sort()).toEqual(["goals", "inbox", "projects"]);
    expect(typeof pf.ms).toBe("number");
    expect(HOT_DOMAIN_TABLES.length, "热表清单不能是空的（否则等于没预取）").toBeGreaterThan(10);
  });

  it("PF-2: 某张表永不就绪 → 进 pending，且**不会**把启动拖到时薪之外", async () => {
    const port = createFakeStoragePort({ neverReady: ["goals"] });
    setStoragePort(port);

    const { prefetchDomainMirrors } = await import("../core/storage/bootstrap");
    const started = Date.now();
    const pf = await prefetchDomainMirrors({ tables: ["projects", "goals"], perTableMs: 60, totalMs: 200 });
    const elapsed = Date.now() - started;

    expect(pf.ready).toEqual(["projects"]);
    expect(pf.pending, "没就绪的表必须被如实报出来（不能静默略过）").toEqual(["goals"]);
    expect(elapsed, "单表超时必须生效（一张坏表不能拖住整个启动）").toBeLessThan(600);
  });

  it("PF-3: A 态（端口未注册）→ 不算失败，返回全 pending", async () => {
    setStoragePort(null);

    const { prefetchDomainMirrors } = await import("../core/storage/bootstrap");
    const pf = await prefetchDomainMirrors({ tables: ["projects", "goals"] });

    expect(pf.ready).toEqual([]);
    expect(pf.pending).toEqual(["projects", "goals"]);
  });

  it("PF-4: 预取之后，该域的**同步读**必须真的拿到数据（这才是预取的意义）", async () => {
    const port = createFakeStoragePort({ seed: { projects: [{ id: "p1", name: "P" }] } });
    setStoragePort(port);

    const { prefetchDomainMirrors } = await import("../core/storage/bootstrap");
    await prefetchDomainMirrors({ tables: ["projects"] });

    const rows = domainReadMany<{ id: string }>("projects", (r) => ({ id: String(r.id) }));
    expect(rows, "预取后必须已路由（undefined = 没接手，说明预取没生效）").toBeDefined();
    expect(rows?.map((r) => r.id)).toEqual(["p1"]);
  });
});
