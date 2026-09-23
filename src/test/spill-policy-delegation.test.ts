/**
 * SpillPolicy 中间件 —— **只做决策，机制全部委托**（第 71 轮）
 *
 * 这个文件要守住的是真机上暴露过的那类缺陷：**同一件事有两份实现，只有一份是活的**。
 *
 * 现场（用户控制台，每个大输出一条）：
 * ```text
 * [spill-policy] saveText failed for bash: (void 0) is not a function; keeping inline content
 * ```
 * 主 agent 循环跑的 `SpillPolicyMiddleware` 用的是 `llm/spill-store.ts`（在渲染进程里依赖
 * 被 vite 映射成空壳的 Node `fs`，且连 `mkdtempSync` 都没有）⇒ **打包版里从未溢出成功过一次**；
 * 而 `core/storage/spill.ts` 那套（`session/executor.ts` 在用、`pruneSpillFiles` 按文件名回收）
 * 一直正常。
 *
 * 现在契约：本中间件只判断 WHEN，写盘/预览/说明全部来自 `core/storage/spill.ts`。
 * 所以这里的断言刻意**不 mock 存储** —— 它必须走真实实现，并用文件 API 的调用参数
 * 反查"写下去的确实是全文"、"模型拿到的定位符确实指向那个文件"。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../core/file-api", () => ({
  getAppDataDir: vi.fn(async () => "C:\\appdata\\"),
  getDefaultCwd: vi.fn(async () => "C:\\work"),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  renameFile: vi.fn(async () => undefined),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
}));

import { getAppDataDir, writeFile, renameFile } from "../core/file-api";
import { SpillPolicyMiddleware } from "../core/llm/spill-policy";
import { utf8Length } from "../core/storage/spill";

const getAppDataDirMock = vi.mocked(getAppDataDir);
const writeFileMock = vi.mocked(writeFile);
const renameFileMock = vi.mocked(renameFile);

/** 中间件的真实调用形状：主循环给的上限是 32768（见 agentic-loop.ts） */
const MAX_INLINE = 4096;

function middleware(maxInlineBytes = MAX_INLINE) {
  return new SpillPolicyMiddleware({ maxInlineBytes });
}

function ctx(sessionId = "s1") {
  return { sessionId } as any;
}

function result(output: string, over: Record<string, unknown> = {}) {
  return { id: "call-42", status: "success", output, ...over } as any;
}

/** 从替换文本里把"已省略 N 字节"读回来，用于核对说明行是否诚实 */
function omittedFromNotice(text: string): number {
  const match = /已省略 (\d+) 字节/.exec(text);
  expect(match, `替换文本里必须有说明行：${text.slice(0, 200)}`).not.toBeNull();
  return Number(match![1]);
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getAppDataDirMock.mockClear().mockResolvedValue("C:\\appdata\\");
  writeFileMock.mockClear().mockResolvedValue(undefined);
  renameFileMock.mockClear().mockResolvedValue(undefined);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("SpillPolicy 中间件：只做决策，机制委托 core/storage/spill.ts", () => {
  it("POLICY-1: 未超上限 → keep，且**零 I/O**（常规结果不打搅磁盘）", async () => {
    const res = await middleware().execute("bash", {}, result("ok"), ctx());

    expect(res.action).toBe("keep");
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(renameFileMock).not.toHaveBeenCalled();
  });

  it("POLICY-2: 超上限 → 全文落盘（原子写），模型只拿到预览 + 诚实的省略说明", async () => {
    const total = 100 * 1024;
    const huge = "A".repeat(total);
    const res = await middleware().execute("bash", {}, result(huge), ctx());

    expect(res.action).toBe("replace");
    const replaced = (res as any).replacedOutput as string;

    // 上限不变式：替换后的文本必须在上限内（这是中间件存在的意义）
    expect(utf8Length(replaced)).toBeLessThanOrEqual(MAX_INLINE);

    // 说明行必须**诚实**：ASCII 文本下省略字节数可以精确算出来
    // 预览预算 = 4096 - 512（通知预留）= 3584 → 前后各 1792 字节
    expect(omittedFromNotice(replaced)).toBe(total - 3584);
    expect(replaced).toContain("完整结果保存在：");

    // 全文（不是预览）确实落盘，且是"先 .tmp 再改名"的原子写
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [tmpPath, written] = writeFileMock.mock.calls[0] as unknown as [string, string];
    expect(written).toBe(huge);
    expect(utf8Length(written)).toBe(total);
    expect(renameFileMock).toHaveBeenCalledTimes(1);
    const [from, to] = renameFileMock.mock.calls[0] as unknown as [string, string];
    expect(from).toBe(tmpPath);
    expect(tmpPath).toBe(`${to}.tmp`);

    // 模型拿到的定位符必须指向**真正写完**的那个文件（否则说明行就是假话）
    expect(replaced).toContain(to);
    expect(to).toMatch(/^C:\\appdata\\spill\\s1\\bash-call-42-\d{10,}\.txt$/);
    // 且文件名能被保留期清理认出来（时间戳写在文件名里）
    expect(/-(\d{10,})\.txt$/.test(to.split("\\").pop()!)).toBe(true);
  });

  it("POLICY-3: read 工具永不溢出（否则会变成 read → spill → read again 死循环）", async () => {
    const res = await middleware().execute("read", {}, result("A".repeat(50 * 1024)), ctx());

    expect(res.action).toBe("keep");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("POLICY-4: 失败的工具结果不溢出（错误信息本身就是给模型的，不能被折叠）", async () => {
    const res = await middleware().execute(
      "bash",
      {},
      result("A".repeat(50 * 1024), { status: "error" }),
      ctx(),
    );

    expect(res.action).toBe("keep");
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("POLICY-5: 写盘失败 → 诚实降级为 keep（正文留在上下文里），绝不把成功的调用变成失败", async () => {
    writeFileMock.mockRejectedValue(new Error("EACCES: 磁盘拒绝写入"));
    const huge = "A".repeat(50 * 1024);

    const res = await middleware().execute("bash", {}, result(huge), ctx());

    expect(res.action).toBe("keep");
    expect((res as any).replacedOutput).toBeUndefined();
    // 失败要有可查的痕迹，且措辞里点明"保留正文"（与真机那条日志同构）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("[spill-policy]");
    expect(msg).toContain("bash");
    expect(msg).toContain("EACCES");
    expect(msg).toContain("keeping inline content");
  });

  it("POLICY-6: 上限小到装不下说明行时，宁可保留正文也不许悄悄超限", async () => {
    // 上限 64 字节 → 预览预算为 0，剩下的说明行本身（含绝对路径）就超过 64 字节
    const res = await middleware(64).execute("bash", {}, result("A".repeat(4096)), ctx());

    expect(res.action).toBe("keep");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("exceeds maxInlineBytes");
    // 注意：这一步确实已经写了盘（全文落盘发生在预算计算之前）——
    // 它不会造成"假定位符"（定位符指向的是真实文件），只是没被用上；
    // 记在这里是为了让下一个人知道这是**已知且有意的**取舍，不是漏判。
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });
});
