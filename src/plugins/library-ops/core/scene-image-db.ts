/**
 * 场景图片持久化 —— IndexedDB（Blob 原样存，不转 base64）。
 *
 * 为什么用 IndexedDB 而不是 localStorage：
 * - 一张 2752×1536 的 PNG 有 4～5MB，base64 后 ~6MB，直接超出 localStorage 配额；
 * - IndexedDB 可以存 Blob，读出来 `URL.createObjectURL` 即可渲染，零解码开销；
 * - 配额按磁盘算（通常几百 MB～数 GB），且异步不卡主线程。
 *
 * 所有 API 都接受可注入的 `factory`，方便单测；缺省用全局 `indexedDB`。
 * 任何失败都抛出带中文文案的 Error，由 store 转成界面提示（不静默）。
 */

/** 数据库名（与 localStorage 键同前缀，互不干扰） */
export const SCENE_IMAGE_DB_NAME = "codem-library-ops";

/** 对象仓库名 */
export const SCENE_IMAGE_STORE_NAME = "scene-images";

/** 自定义场景在仓库里的固定主键（只保留一张，新上传覆盖旧的） */
export const CUSTOM_SCENE_KEY = "custom-scene";

/** 仓库记录 */
export interface SceneImageRecord {
  id: string;
  blob: Blob;
  name: string;
  type: string;
  width: number;
  height: number;
  size: number;
  addedAt: number;
}

export interface SceneImageDbDeps {
  factory?: IDBFactory | null;
  dbName?: string;
  storeName?: string;
}

function resolveFactory(deps: SceneImageDbDeps): IDBFactory {
  const factory = deps.factory !== undefined ? deps.factory : typeof indexedDB !== "undefined" ? indexedDB : null;
  if (!factory) throw new Error("当前环境不支持本地图片存储（IndexedDB 不可用），本次上传只对当前会话有效。");
  return factory;
}

/** 当前环境是否支持持久化（设置面板据此提示） */
export function isSceneImageDbAvailable(deps: SceneImageDbDeps = {}): boolean {
  try {
    resolveFactory(deps);
    return true;
  } catch {
    return false;
  }
}

/** 打开数据库（首次自动建仓库） */
export function openSceneImageDb(deps: SceneImageDbDeps = {}): Promise<IDBDatabase> {
  const factory = resolveFactory(deps);
  const dbName = deps.dbName ?? SCENE_IMAGE_DB_NAME;
  const storeName = deps.storeName ?? SCENE_IMAGE_STORE_NAME;
  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(dbName, 1);
    } catch (e) {
      reject(new Error(`打开本地图片库失败：${messageOf(e)}`));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(`打开本地图片库失败：${messageOf(req.error)}`));
    req.onblocked = () => reject(new Error("本地图片库被其它窗口占用，请关闭其它 Codem 窗口后重试。"));
  });
}

/** 通用事务封装：一次事务内跑一个请求 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  deps: SceneImageDbDeps,
): Promise<T> {
  const db = await openSceneImageDb(deps);
  const storeName = deps.storeName ?? SCENE_IMAGE_STORE_NAME;
  try {
    return await new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, mode);
      } catch (e) {
        reject(new Error(`访问本地图片库失败：${messageOf(e)}`));
        return;
      }
      const req = run(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`读写本地图片库失败：${messageOf(req.error)}`));
      tx.onabort = () => reject(new Error(`本地图片库事务被中止：${messageOf(tx.error)}`));
    });
  } finally {
    db.close?.();
  }
}

/** 保存（同主键覆盖） */
export async function putSceneImage(record: SceneImageRecord, deps: SceneImageDbDeps = {}): Promise<void> {
  await withStore("readwrite", (store) => store.put(record) as IDBRequest<IDBValidKey>, deps);
}

/** 读取（不存在返回 null） */
export async function getSceneImage(
  id: string = CUSTOM_SCENE_KEY,
  deps: SceneImageDbDeps = {},
): Promise<SceneImageRecord | null> {
  const value = await withStore<SceneImageRecord | undefined>("readonly", (store) => store.get(id), deps);
  return value ?? null;
}

/** 删除（不存在也成功） */
export async function deleteSceneImage(id: string = CUSTOM_SCENE_KEY, deps: SceneImageDbDeps = {}): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id) as IDBRequest<undefined>, deps);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e ?? "未知错误");
}
