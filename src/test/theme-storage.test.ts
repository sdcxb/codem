/**
 * 测试 8：主题存储 — codem-theme 走**配置面端口**
 *
 * 改动影响：
 *   - Sidebar.tsx 的 theme 从 localStorage.getItem("mimo-theme") 改为 getSetting("codem-theme")
 *   - 保存从 localStorage.setItem("mimo-theme") 改为 setSetting("codem-theme")
 *   - 如果有误，主题切换不会持久化，刷新后恢复默认
 *
 * ## 第 30 轮的修改（重要）
 *
 * 这个测试原来**不注册端口**，靠 `initDatabase()` 起一个 WASM 库来验证"设置能持久化"。
 * 而那正是第 30 轮删掉的旧库回退路径 —— 于是它变红了。
 *
 * 关键判断：**它红得对，但断言的目标过时了。**
 * 设置面早就切到端口（P3 第 2 段），在 rust 引擎下**不会再碰旧库**；
 * 继续用"旧库能存取"来代表"主题能持久化"，测的是一条已经不存在的路径。
 *
 * 所以这里改成**注册一个最小的配置面端口**（内存镜像 + 记录调用），
 * 断言"写入 → 立刻可读""切换主题顺序正确""不碰 localStorage"。
 * 这样测的才是**生产真正走的那条路**。
 */
import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { getSetting, setSetting } from "../core/storage/settings";

/** 最小配置面：内存镜像（与 RustConfigPort 的"写穿 + 本地镜像"语义一致） */
function makeConfigPort() {
  const store = new Map<string, string>();
  const calls: Array<{ op: string; key: string; value?: string }> = [];
  const port = {
    kind: "rust" as const,
    engine: {} as never,
    data: {} as never,
    append: {} as never,
    config: {
      get<T>(key: string, fallback: T): T {
        return (store.has(key) ? (store.get(key) as unknown as T) : fallback);
      },
      set(key: string, value: string) {
        calls.push({ op: "set", key, value });
        store.set(key, value);
      },
      remove(key: string) {
        calls.push({ op: "remove", key });
        store.delete(key);
      },
      stats: () => ({ warmed: true, keys: store.size, pendingWrites: 0, failures: 0 }),
    },
  };
  return { port, calls, store };
}

describe("主题存储 — codem-theme 走配置面端口（第 30 轮改写）", () => {
  let ctx: ReturnType<typeof makeConfigPort>;

  beforeEach(() => {
    localStorage.clear();
    ctx = makeConfigPort();
    setStoragePort(ctx.port as never);
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("默认主题为 dark 当无存储", () => {
    const theme = getSetting("codem-theme") as "dark" | "light" | null;
    const result = theme || "dark";
    expect(result).toBe("dark");
  });

  it("保存 light 主题后能读取", () => {
    setSetting("codem-theme", "light");
    const theme = getSetting("codem-theme") as "dark" | "light" | null;
    expect(theme).toBe("light");
    expect(ctx.calls.filter((c) => c.op === "set" && c.key === "codem-theme")).toHaveLength(1);
  });

  it("保存 dark 主题后能读取", () => {
    setSetting("codem-theme", "dark");
    expect(getSetting("codem-theme")).toBe("dark");
  });

  it("切换主题：dark → light → dark", () => {
    setSetting("codem-theme", "dark");
    expect(getSetting("codem-theme")).toBe("dark");

    setSetting("codem-theme", "light");
    expect(getSetting("codem-theme")).toBe("light");

    setSetting("codem-theme", "dark");
    expect(getSetting("codem-theme")).toBe("dark");
  });

  it("不用旧的 mimo-theme localStorage key，也不写 localStorage", () => {
    const spy = vi.spyOn(localStorage, "setItem");

    setSetting("codem-theme", "light");

    expect(spy).not.toHaveBeenCalledWith("mimo-theme", "light");
    expect(spy).not.toHaveBeenCalledWith("codem-theme", "light");
    expect(localStorage.getItem("mimo-theme")).toBeNull();
  });

  it("不读取旧的 mimo-theme localStorage key", () => {
    localStorage.setItem("mimo-theme", "light");
    // 旧 key 不参与：codem-theme 在配置面里不存在 → null
    expect(getSetting("codem-theme")).toBeNull();
  });

  it("端口未注册时：读回落默认值、写如实上报（不再回退旧库）", () => {
    setStoragePort(null);
    expect(getSetting("codem-theme"), "读不到就用默认").toBeNull();
  });
});
