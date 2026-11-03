/**
 * 本机模型配置的判据（LLM-CFG-1..7）。
 *
 * 守的是两条**真实存在过的泄漏链**：
 * 1. `CODEM_LLM_*` 留在 `process.env` ⇒ bash/git/codem-db 子进程继承 ⇒ 模型跑一次
 *    `env` 就把 Key 打进工具输出（→ 会话消息 / 截图 / 导出）；
 * 2. `makeProvider()` 每次运行都从环境读 ⇒ 无法证明"配置只在启动时解析一次"。
 *
 * 变异自证：把 `takeLlmConfigFromEnv` 里的 `clearLlmEnv` 注释掉，LLM-CFG-2 立刻变红；
 * 把 `bash-run` 的 `env` 改回 `process.env`，LLM-CFG-6 立刻变红。
 */
import { PassThrough, Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import {
  LLM_ENV_KEYS,
  parseLlmConfigJson,
  readLlmConfigFromStdin,
  resolveLlmConfig,
  takeLlmConfigFromEnv,
  withoutLlmEnv,
} from "../../packages/host/src/llm-config";
import { executeBash } from "../../packages/host/src/bash-run";

const KEY = "sk-test-llmcfg-0123456789";
const isWin = process.platform === "win32";

function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of LLM_ENV_KEYS) delete env[name];
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

describe("LLM-CFG-1 解析：去空格 / 空值 / 半套配置", () => {
  it("三个都齐时返回配置，并去掉首尾空格", () => {
    const got = resolveLlmConfig(
      envWith({
        CODEM_LLM_BASE_URL: "  https://api.example.com/v1  ",
        CODEM_LLM_MODEL: " deepseek-chat ",
        CODEM_LLM_API_KEY: ` ${KEY} `,
      }),
    );
    expect(got).toEqual({ baseUrl: "https://api.example.com/v1", model: "deepseek-chat", apiKey: KEY });
  });

  it("没有 Key 也合法（本地免鉴权端点）", () => {
    const got = resolveLlmConfig(
      envWith({ CODEM_LLM_BASE_URL: "http://127.0.0.1:11434/v1", CODEM_LLM_MODEL: "qwen" }),
    );
    expect(got).toEqual({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen" });
    expect("apiKey" in (got as object)).toBe(false);
  });

  it("半套配置（只有 base 或只有 model）视为没配置", () => {
    expect(resolveLlmConfig(envWith({ CODEM_LLM_BASE_URL: "https://x/v1" }))).toBeNull();
    expect(resolveLlmConfig(envWith({ CODEM_LLM_MODEL: "m" }))).toBeNull();
    expect(resolveLlmConfig(envWith({}))).toBeNull();
  });

  it("空字符串等于没写", () => {
    expect(
      resolveLlmConfig(envWith({ CODEM_LLM_BASE_URL: "   ", CODEM_LLM_MODEL: "m" })),
    ).toBeNull();
  });
});

describe("LLM-CFG-2 解析后必须把三个变量从环境里删掉", () => {
  it("takeLlmConfigFromEnv 返回配置，且 env 里一个都不剩", () => {
    const env = envWith({
      CODEM_LLM_BASE_URL: "https://api.example.com/v1",
      CODEM_LLM_MODEL: "m",
      CODEM_LLM_API_KEY: KEY,
    });
    const got = takeLlmConfigFromEnv(env);
    expect(got?.apiKey).toBe(KEY);
    for (const name of LLM_ENV_KEYS) expect(env[name], `${name} 必须被删掉`).toBeUndefined();
    // 工具输出/诊断里永远不该再出现这个值
    expect(JSON.stringify(env)).not.toContain(KEY);
  });

  it("没配置时也会清（半套配置同样不许留在环境里）", () => {
    const env = envWith({ CODEM_LLM_BASE_URL: "https://x/v1", CODEM_LLM_API_KEY: KEY });
    expect(takeLlmConfigFromEnv(env)).toBeNull();
    for (const name of LLM_ENV_KEYS) expect(env[name]).toBeUndefined();
  });
});

describe("LLM-CFG-3 子进程环境构建：副本、不改原对象", () => {
  it("withoutLlmEnv 返回新对象且不含 LLM 变量，原对象不变", () => {
    const source = envWith({ CODEM_LLM_API_KEY: KEY, CODEM_OTHER: "kept" });
    const copy = withoutLlmEnv(source);
    expect(copy.CODEM_OTHER).toBe("kept");
    for (const name of LLM_ENV_KEYS) expect(copy[name]).toBeUndefined();
    // 原对象必须原样（否则调用点顺序一换就又是"删了但没删干净"）
    expect(source.CODEM_LLM_API_KEY).toBe(KEY);
    expect(copy).not.toBe(source);
  });
});

describe("LLM-CFG-4 stdin 配置：只读一行、畸形不回显", () => {
  it("解析合法的单行 JSON", () => {
    expect(parseLlmConfigJson(`{"baseUrl":"https://x/v1","model":"m","apiKey":"${KEY}"}`)).toEqual({
      baseUrl: "https://x/v1",
      model: "m",
      apiKey: KEY,
    });
  });

  it("畸形 JSON 的错误信息**不含原文**（原文里可能正躺着粘贴错的 Key）", () => {
    let message = "";
    try {
      parseLlmConfigJson(`{"baseUrl":"https://x/v1","model":"m","apiKey":"${KEY}"`);
    } catch (e) {
      message = String((e as Error).message ?? e);
    }
    expect(message).toContain("JSON");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("baseUrl");
  });

  it("缺字段 / 不是对象 ⇒ 报错（不猜默认值）", () => {
    expect(() => parseLlmConfigJson(`{"baseUrl":"https://x/v1"}`)).toThrow();
    expect(() => parseLlmConfigJson(`[]`)).toThrow();
    expect(() => parseLlmConfigJson(`"https://x/v1"`)).toThrow();
  });

  it("从流里读一行就结束（第二行不会被消费）", async () => {
    const stream = Readable.from([`{"baseUrl":"https://x/v1","model":"m","apiKey":"${KEY}"}\n{"baseUrl":"https://evil/v1","model":"m"}\n`]);
    const got = await readLlmConfigFromStdin(stream, 2_000);
    expect(got.baseUrl).toBe("https://x/v1");
  });

  it("超时 ⇒ 失败（不回落环境变量）", async () => {
    const stream = new PassThrough();
    await expect(readLlmConfigFromStdin(stream, 40)).rejects.toThrow(/stdin/);
  });
});

describe("LLM-CFG-6 工具子进程拿不到 Key（真正的泄漏面）", () => {
  const saved = process.env.CODEM_LLM_API_KEY;
  const savedKeep = process.env.CODEM_LLM_KEEP;
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEM_LLM_API_KEY;
    else process.env.CODEM_LLM_API_KEY = saved;
    if (savedKeep === undefined) delete process.env.CODEM_LLM_KEEP;
    else process.env.CODEM_LLM_KEEP = savedKeep;
  });

  it("bash 命令看不到 CODEM_LLM_API_KEY，但其它环境变量照常继承", async () => {
    process.env.CODEM_LLM_API_KEY = KEY;
    process.env.CODEM_LLM_KEEP = "kept-value";
    const ws = await mkdtemp(join(tmpdir(), "codem-llm-env-"));
    const command = isWin ? "echo key=[%CODEM_LLM_API_KEY%] keep=[%CODEM_LLM_KEEP%]" : 'echo "key=[$CODEM_LLM_API_KEY] keep=[$CODEM_LLM_KEEP]"';
    const r = await executeBash({ command, workspace: ws, approve: async () => ({ allowed: true }) });
    expect(r.output).not.toContain(KEY);
    // 变异自证：把 env 换成空对象，这一条会红（证明我们只剔了 LLM 变量，没有把环境清空）
    expect(r.output).toContain("kept-value");
  });
});

describe("LLM-CFG-7 源码不变量：运行时不从环境读 Key", () => {
  it("runtime.ts 的 makeProvider 只用构造时捕获的配置", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(__dirname, "../../packages/host/src/runtime.ts"), "utf8");
    expect(src).toContain("this.llm");
    // 回到"每次运行都读环境"就等于把 Key 的寿命延长到整个进程（且环境里本来就不该有）
    expect(src).not.toContain("process.env.CODEM_LLM_API_KEY");
    expect(src).not.toContain("process.env.CODEM_LLM_BASE_URL");
  });

  it("cli.ts 在创建 runtime 之前解析并清环境", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(__dirname, "../../packages/host/src/cli.ts"), "utf8");
    const parseAt = src.indexOf("takeLlmConfigFromEnv(process.env)");
    const createAt = src.indexOf("HostRuntime.create(config");
    expect(parseAt).toBeGreaterThan(0);
    expect(createAt).toBeGreaterThan(parseAt);
    expect(src).toContain("readLlmConfigFromStdin");
  });
});
