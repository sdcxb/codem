/**
 * 本机模型配置（LLM）—— 解析、传递与**从环境里清除**。
 *
 * 为什么单独一个模块（而不是塞进 `HostConfig`）：
 * - `HostConfig` 会被日志、诊断、错误详情整份带出去（`host.hello` 也会挑字段返回）。
 *   API Key 一旦作为「配置字段」存在，就迟早会被某条日志顺手打出来；
 * - 这个模块的**唯一出口**是两个东西：`HostRuntime` 的私有字段（只给 provider 用）
 *   与 `takeLlmConfigFromEnv()` 的返回值。没有 getter、没有 `toString`、没有诊断字段。
 *
 * ## 为什么要从环境变量里删掉（而不是留着）
 *
 * Host 会为工具调用 spawn 子进程（bash / git / codem-db）。Node 的 `spawn` 默认继承
 * `process.env` ⇒ 模型只要跑一次 `env` / `printenv`，Key 就进了**工具输出**，而工具输出
 * 会被写成会话消息、截图、导出报告。这是真实的泄漏链，不是理论风险。
 *
 * 所以：解析完立刻 `delete`，并且 spawn 子进程时再显式剔除一遍（纵深防御：
 * 将来某条新路径忘了删，也不会把 Key 传下去）。
 *
 * ## 传输方式：stdin 优先，环境变量兜底
 *
 * Android 端用 `--llm-stdin`（启动后由外壳写一行 JSON 再关掉 stdin）：
 * `CODEM_LLM_API_KEY` 从此**不进进程环境**，`/proc/<pid>/environ` 里也没有它
 * （运行时 `delete process.env` 擦不掉 execve 时的初始环境块）。
 * 开发机 / 判据仍可用环境变量（大量 spike 脚本依赖它）。
 */

import { createInterface, type Interface } from "node:readline";

/** 三个环境变量的**唯一**清单：清理逻辑只能引用它，避免漏删一个。 */
export const LLM_ENV_KEYS = ["CODEM_LLM_BASE_URL", "CODEM_LLM_MODEL", "CODEM_LLM_API_KEY"] as const;

export interface LlmConfig {
  /** OpenAI 兼容端点（如 `https://api.deepseek.com/v1`） */
  baseUrl: string;
  /** 模型名（如 `deepseek-chat`） */
  model: string;
  /** API Key；本地/免鉴权的端点可以为空 */
  apiKey?: string;
}

/** stdin 读配置的默认上限：拉起方（Android 外壳）在 `pb.start()` 后立刻写，正常是毫秒级 */
export const LLM_STDIN_TIMEOUT_MS = 10_000;

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 从环境解析（**不修改**环境）。
 *
 * 不完整的配置（只给了 base 没给 model）视为「没配置」：Host 保持原来的
 * `UNSUPPORTED` 行为 —— 半套配置比没有配置更难解释。
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const baseUrl = trim(env.CODEM_LLM_BASE_URL);
  const model = trim(env.CODEM_LLM_MODEL);
  const apiKey = trim(env.CODEM_LLM_API_KEY);
  if (!baseUrl || !model) return null;
  return apiKey ? { baseUrl, model, apiKey } : { baseUrl, model };
}

/**
 * 解析并把三个变量从环境里**删掉**（Host 启动时必须走这条，不能走 `resolveLlmConfig`）。
 *
 * 返回 `null` 表示没配置；返回后 `env` 里一定不再有 `CODEM_LLM_*`。
 */
export function takeLlmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const config = resolveLlmConfig(env);
  clearLlmEnv(env);
  return config;
}

/** 原地删除三个变量（给已经在改造中的 env 对象用，如 `git-exec` 的合并结果） */
export function clearLlmEnv(env: NodeJS.ProcessEnv): void {
  for (const key of LLM_ENV_KEYS) delete env[key];
}

/**
 * 返回一份**不含** `CODEM_LLM_*` 的副本（不改原对象）。
 *
 * 子进程一律用这个：`spawn(..., { env: withoutLlmEnv(process.env) })`。
 */
export function withoutLlmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  clearLlmEnv(copy);
  return copy;
}

/**
 * 解析 stdin 的一行 JSON。
 *
 * 错误信息**不回显原文**：畸形配置里可能正躺着用户粘贴错的 Key，
 * 而错误信息会被写进 `host.log` / 抛给外壳的日志。
 */
export function parseLlmConfigJson(raw: string): LlmConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("模型配置不是合法 JSON（内容不回显）");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型配置必须是 JSON 对象（内容不回显）");
  }
  const record = value as Record<string, unknown>;
  const baseUrl = trim(record.baseUrl);
  const model = trim(record.model);
  const apiKey = trim(record.apiKey);
  if (!baseUrl || !model) throw new Error("模型配置缺少 baseUrl / model（内容不回显）");
  return apiKey ? { baseUrl, model, apiKey } : { baseUrl, model };
}

/**
 * 从 stdin 读**一行**配置（`--llm-stdin`）。
 *
 * 只读第一行就关掉 readline：Host 之后不用 stdin，读多了反而可能与未来的交互入口抢字节。
 * 超时/提前 EOF 一律**失败**，绝不回退到环境变量 ——
 * 否则"以为用了新 Key 其实用了旧环境变量"会变成最难查的一类事故。
 */
export function readLlmConfigFromStdin(
  stream: NodeJS.ReadableStream,
  timeoutMs: number = LLM_STDIN_TIMEOUT_MS,
): Promise<LlmConfig> {
  return new Promise<LlmConfig>((resolve, reject) => {
    let settled = false;
    const rl = createLines(stream);
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`未在 ${timeoutMs}ms 内从 stdin 收到模型配置`)));
    }, timeoutMs);
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn();
    }
    rl.once("line", (line: string) => {
      settle(() => {
        try {
          resolve(parseLlmConfigJson(line));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
    rl.once("close", () => settle(() => reject(new Error("stdin 已关闭但没收到模型配置"))));
    rl.once("error", (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

/** 单独抽出来只为让判据能替换输入流，并保持 `readLlmConfigFromStdin` 只有一处 IO 细节 */
function createLines(stream: NodeJS.ReadableStream): Interface {
  return createInterface({ input: stream, crlfDelay: Infinity });
}
