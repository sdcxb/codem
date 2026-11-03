#!/usr/bin/env node
/**
 * 本地**确定性**假模型（OpenAI 兼容），给 Spike A / C 与 parity 判据用。
 *
 * 为什么需要它（而不是拿真 API Key 跑）：
 * 1. Spike 要能被**任何人重复**（无账号、无网络、无额度）；
 * 2. 判据要能断言"工具真的被调用、结果真的回了模型"，假模型可以按脚本走两轮；
 * 3. 真实模型的采样方差会让"通过/失败"变成噪声（本仓吃过这个亏）。
 *
 * 脚本（两轮）：
 *   round 1：返回一个 `read` 工具调用（路径由 `MOCK_TOOL_PATH` 指定，默认 index.html）
 *   round 2：看到 `role:"tool"` 的消息后，返回一段文本，里面带 `MOCK_DONE` 标记
 *
 * 线上形态与真 provider 完全一致（SSE + `data: [DONE]`），所以它验证的是**真实解析路径**。
 */

import { createServer } from "node:http";

export async function startMockProvider({ port = 0, toolPath = "index.html", toolName = "read" } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (!url.pathname.endsWith("/chat/completions") || req.method !== "POST") {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* 空体也当第一轮 */
      }
      requests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      // 只看「最后一条是不是工具结果」：真实会话的历史里本来就有 tool 行，
      // 用 some(...) 会让第一轮就误判成"工具已经回来过"，于是根本不发工具调用。
      // 循环每轮都会把「当前 user 消息」追加在末尾，所以看**最后一条非 user**：
      // 它是 tool ⇒ 这一轮工具已经回来了，可以收尾；否则继续发工具调用。
      const lastNonUser = [...messages].reverse().find((m) => m && m.role !== "user" && m.role !== "system");
      const sawToolResult = Boolean(lastNonUser && lastNonUser.role === "tool");
      const sawAssistant = messages.some((m) => m && m.role === "assistant");
      const stream = body.stream !== false;
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock-1",
            model: "mock-model",
            choices: [{ message: { content: "MOCK_DONE" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ id: "mock-1", model: "mock-model", choices: [{ delta: { role: "assistant" }, index: 0 }] });
      if (!sawToolResult) {
        // 两段参数，验证增量拼装（真 provider 就是这么切的）
        send({
          id: "mock-1",
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name: toolName, arguments: "" },
                  },
                ],
              },
            },
          ],
        });
        send({
          id: "mock-1",
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: toolPath }) } }],
              },
            },
          ],
        });
        send({ id: "mock-1", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const lastTool = [...messages].reverse().find((m) => m && m.role === "tool");
        const preview = typeof lastTool?.content === "string" ? lastTool.content.slice(0, 80).replace(/\s+/g, " ") : "";
        send({
          id: "mock-1",
          model: "mock-model",
          choices: [{ index: 0, delta: { content: `MOCK_DONE 读到 ${preview}` }, finish_reason: null }],
        });
        send({ id: "mock-1", model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ id: "mock-1", model: "mock-model", choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/v1`,
    port: actualPort,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith("mock-provider.mjs");
if (isMain) {
  const provider = await startMockProvider({
    port: Number(process.env.MOCK_PORT ?? 0),
    toolPath: process.env.MOCK_TOOL_PATH ?? "index.html",
  });
  process.stdout.write(`${JSON.stringify({ ready: true, url: provider.url })}\n`);
  const stop = async () => {
    await provider.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
