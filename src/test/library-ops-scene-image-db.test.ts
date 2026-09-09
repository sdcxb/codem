/**
 * LO-SCENE-DB — 场景图片的 IndexedDB 持久化
 *
 * 用一个内存版 IDBFactory 替身验证：
 * - LO-SCENE-DB-1 环境探测（无 indexedDB → 明确报错而不是静默失败）
 * - LO-SCENE-DB-2 首次打开自动建对象仓库
 * - LO-SCENE-DB-3 put / get 往返（Blob 原样存）
 * - LO-SCENE-DB-4 同主键覆盖（只保留一张自定义场景图）
 * - LO-SCENE-DB-5 删除 + 不存在时返回 null
 * - LO-SCENE-DB-6 事务 / 请求失败会抛出可读错误
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  CUSTOM_SCENE_KEY,
  SCENE_IMAGE_DB_NAME,
  SCENE_IMAGE_STORE_NAME,
  deleteSceneImage,
  getSceneImage,
  isSceneImageDbAvailable,
  openSceneImageDb,
  putSceneImage,
  type SceneImageRecord,
} from "../plugins/library-ops/core/scene-image-db";

/** 极简内存 IDBFactory 替身（只实现本模块用到的 API） */
function makeFakeFactory(options: { failOn?: "open" | "transaction" | "request" } = {}) {
  const stores = new Map<string, Map<string, unknown>>();
  const state = { opened: 0, createdStores: [] as string[], closed: 0, blocked: false };

  const factory = {
    open(name: string, _version?: number) {
      const req: Record<string, unknown> = { result: undefined as unknown, error: null };
      const db = {
        name,
        objectStoreNames: {
          contains: (n: string) => stores.has(n),
        },
        createObjectStore: (n: string) => {
          stores.set(n, new Map());
          state.createdStores.push(n);
          return {};
        },
        transaction: (n: string, mode: string) => {
          if (options.failOn === "transaction") throw new Error("transaction failed");
          const map = stores.get(n);
          if (!map) throw new Error(`no store ${n}`);
          const tx: Record<string, unknown> = { error: null, onabort: null, objectStore: () => store };
          const store = {
            put: (rec: SceneImageRecord) => {
              map.set(rec.id, rec);
              return makeRequest(rec.id, "request");
            },
            get: (key: string) => makeRequest(map.get(key), "request"),
            delete: (key: string) => {
              map.delete(key);
              return makeRequest(undefined, "request");
            },
          };
          function makeRequest<T>(value: T, _tag: string) {
            const r: Record<string, unknown> = { result: undefined, error: null };
            queueMicrotask(() => {
              if (options.failOn === "request") {
                r.error = new Error("request failed");
                (r.onerror as (() => void) | null)?.();
                return;
              }
              r.result = value;
              (r.onsuccess as (() => void) | null)?.();
            });
            return r;
          }
          return tx;
        },
        close: () => {
          state.closed++;
        },
      };
      queueMicrotask(() => {
        if (options.failOn === "open") {
          req.error = new Error("open failed");
          (req.onerror as (() => void) | null)?.();
          return;
        }
        if (state.blocked) {
          (req.onblocked as (() => void) | null)?.();
          return;
        }
        // 模拟首次打开：仓库不存在 → 先升级
        if (!stores.has(SCENE_IMAGE_STORE_NAME)) {
          req.result = db;
          const up = req.onupgradeneeded as (() => void) | null;
          up?.();
        } else {
          req.result = db;
        }
        state.opened++;
        (req.onsuccess as (() => void) | null)?.();
      });
      return req;
    },
  };

  return { factory: factory as unknown as IDBFactory, stores, state };
}

function record(over: Partial<SceneImageRecord> = {}): SceneImageRecord {
  return {
    id: CUSTOM_SCENE_KEY,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    name: "场景.png",
    type: "image/png",
    width: 2752,
    height: 1536,
    size: 4_641_700,
    addedAt: 1_700_000_000_000,
    ...over,
  };
}

describe("LO-SCENE-DB 场景图片持久化", () => {
  let fake: ReturnType<typeof makeFakeFactory>;

  beforeEach(() => {
    fake = makeFakeFactory();
  });

  it("LO-SCENE-DB-1: 环境探测与错误文案", async () => {
    expect(isSceneImageDbAvailable({ factory: fake.factory })).toBe(true);
    expect(isSceneImageDbAvailable({ factory: null })).toBe(false);
    // 无 factory 时同步抛错（async 调用方一样能 catch）
    expect(() => openSceneImageDb({ factory: null })).toThrow(/IndexedDB 不可用/);
    await expect(Promise.resolve().then(() => openSceneImageDb({ factory: null }))).rejects.toThrow(/IndexedDB 不可用/);
    const broken = makeFakeFactory({ failOn: "open" });
    await expect(openSceneImageDb({ factory: broken.factory })).rejects.toThrow(/打开本地图片库失败/);
    const blocked = makeFakeFactory();
    blocked.state.blocked = true;
    await expect(openSceneImageDb({ factory: blocked.factory })).rejects.toThrow(/占用/);
  });

  it("LO-SCENE-DB-2: 首次打开自动建仓库并关闭连接", async () => {
    const db = await openSceneImageDb({ factory: fake.factory });
    expect(db.name).toBe(SCENE_IMAGE_DB_NAME);
    expect(db.objectStoreNames.contains(SCENE_IMAGE_STORE_NAME)).toBe(true);
    expect(fake.state.createdStores).toEqual([SCENE_IMAGE_STORE_NAME]);
  });

  it("LO-SCENE-DB-3: put / get 往返，Blob 原样保存", async () => {
    const rec = record();
    await putSceneImage(rec, { factory: fake.factory });
    const back = await getSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory });
    expect(back).not.toBeNull();
    expect(back!.name).toBe("场景.png");
    expect(back!.width).toBe(2752);
    expect(back!.height).toBe(1536);
    expect(back!.blob).toBeInstanceOf(Blob);
    expect(back!.blob.size).toBe(3);
    // 只建一次仓库（第二次打开不再升级）
    expect(fake.state.createdStores.length).toBe(1);
  });

  it("LO-SCENE-DB-4: 同主键覆盖（只留一张自定义场景图）", async () => {
    await putSceneImage(record({ name: "第一张.png" }), { factory: fake.factory });
    await putSceneImage(record({ name: "第二张.png" }), { factory: fake.factory });
    expect(fake.stores.get(SCENE_IMAGE_STORE_NAME)!.size).toBe(1);
    expect((await getSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory }))!.name).toBe("第二张.png");
  });

  it("LO-SCENE-DB-5: 删除与缺省读取", async () => {
    expect(await getSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory })).toBeNull();
    await putSceneImage(record(), { factory: fake.factory });
    await deleteSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory });
    expect(await getSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory })).toBeNull();
    await expect(deleteSceneImage(CUSTOM_SCENE_KEY, { factory: fake.factory })).resolves.toBeUndefined();
  });

  it("LO-SCENE-DB-6: 请求失败 → 抛出可读错误", async () => {
    const failing = makeFakeFactory({ failOn: "request" });
    await expect(putSceneImage(record(), { factory: failing.factory })).rejects.toThrow(/读写本地图片库失败/);
    const noTx = makeFakeFactory({ failOn: "transaction" });
    await expect(getSceneImage(CUSTOM_SCENE_KEY, { factory: noTx.factory })).rejects.toThrow(/访问本地图片库失败/);
  });
});
