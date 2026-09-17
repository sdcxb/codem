/**
 * 测试 15：编码测试 — 中文和 Emoji 在 Tool Calls 参数中
 *
 * 改动影响：
 *   - Fork 功能复制消息时会复制 tool_calls
 *   - tool_calls 的 args 是 JSON 字符串存储在 SQLite 中
 *   - 如果中文路径/emoji 在 JSON 序列化时出问题，工具调用会失败
 *
 * ⚠️ P5 端口化（本文件 6 个用例的修法）：工具调用的**存储位置**在端口模式下变了 ——
 * 产品由 `messages.upsert_index` 把整批 tool_calls 落到端口的 `tool_calls` 表，
 * 而消息镜像刻意不含 tool_calls（工具结果全文不进渲染进程镜像），旧库那份也不存在。
 * 所以"args 里的中文/emoji 有没有坏"必须**读端口那张表**来验（见 `toolCallsOf`）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import { getStoragePort, hasStoragePort } from "../core/storage/port";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

/** 工具调用（读回来的一行，args 已解析成对象） */
type ToolCallLike = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  status?: string;
};

/**
 * 读回某条消息的工具调用 —— 读**产品真正把 tool_calls 写进去的那一侧**。
 *
 * - **B 态**（端口已注册，默认）：`createMessage` → `writeIndexViaRust` → 端口命令
 *   `messages.upsert_index`（单事务整批替换）→ 端口的 `tool_calls` 表。
 *   真实 Rust 侧读它就是 `tool_calls.list`（`repo.rs`），镜像行不含这一列。
 * - **A 态**（`CODEM_TEST_PORT=0`，端口未注册）：旧库是唯一数据源，`getMessage` 从
 *   旧库的 `tool_calls` 表读回。
 *
 * 两态读各自那一侧，断言（中文/emoji 逐字相等）在两种形态下都成立。
 *
 * ⚠️ 已知产品缺口（本文件最后那条 fork 用例因此仍红）：端口模式下**同步**读路径拿不到
 * tool_calls —— `writeIndexViaRust` 不填 `toolCallCache`（与 `message.ts` 里
 * "缓存由写路径 addToolCall / updateToolCall / upsert_index 负责维护"的注释不符），
 * 镜像行也不含这一列，异步预热（`tool_calls.list`）只在 `getMessage` 里触发、且 `listMessages`
 * 那条路（fork 用的就是它）从不触发。所以本文件的编码断言读端口表（存储边界），
 * 而"fork 复制后还在不在"只能由那条 fork 用例来钉。
 */
function toolCallsOf(messageId: string): ToolCallLike[] {
  if (hasStoragePort()) {
    const port = getStoragePort() as unknown as { __table(name: string): Array<Record<string, unknown>> };
    return port
      .__table("tool_calls")
      .filter((r) => r.message_id === messageId)
      .map((r) => ({
        id: String(r.id ?? ""),
        tool: String(r.tool ?? ""),
        // 真实 Rust 侧该列是 JSON 文本（`tool_calls.list` 返回字符串，读侧自行 parse）；
        // 内存端口存的是对象。两种形状都要能读。
        args: (typeof r.args === "string" ? JSON.parse(r.args) : (r.args ?? {})) as Record<string, unknown>,
        result: (r.result as string | null) ?? undefined,
        status: (r.status as string | null) ?? undefined,
      }));
  }
  return (MessageStorage.getMessage(messageId)?.toolCalls ?? []) as ToolCallLike[];
}

describe("编码测试 — Tool Calls 参数中的中文和 Emoji", () => {
  const projectId = "proj-tc-test";
  const sessionId = "sess-tc-test";

  beforeEach(async () => {
    await initDatabase();
    ProjectStorage.createProject({
      id: projectId,
      name: "测试项目 🧪",
      path: "D:\\测试",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: sessionId,
      projectId,
      title: "工具调用测试 🔧",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
  });

  it("tool call args 包含中文文件路径", () => {
    const msg: Message = {
      id: "tc-cn-path",
      role: "assistant",
      content: "读取了文件",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-1",
          tool: "read_file",
          args: { path: "D:\\项目\\源码\\你好.py" },
          result: "文件内容：你好世界",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    // 正文走产品读路径（B 态由端口镜像返回）
    const loaded = MessageStorage.getMessage("tc-cn-path");
    expect(loaded!.content).toBe("读取了文件");
    // 工具调用读端口存储（B 态的唯一落点）
    const calls = toolCallsOf("tc-cn-path");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("read_file");
    expect(calls[0].args.path).toBe("D:\\项目\\源码\\你好.py");
    expect(calls[0].result).toBe("文件内容：你好世界");
  });

  it("tool call args 包含 emoji", () => {
    const msg: Message = {
      id: "tc-emoji",
      role: "assistant",
      content: "创建了文件",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-2",
          tool: "write_file",
          args: { path: "D:\\test\\配置 ⚙️.json", content: '{"name": "闪电 ⚡"}' },
          result: "写入成功 ✅",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("tc-emoji");
    expect(loaded!.content).toBe("创建了文件");
    const calls = toolCallsOf("tc-emoji");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("write_file");
    expect(calls[0].args.path).toBe("D:\\test\\配置 ⚙️.json");
    expect(calls[0].args.content).toBe('{"name": "闪电 ⚡"}');
    expect(calls[0].result).toBe("写入成功 ✅");
  });

  it("tool call args 包含复杂嵌套中文 JSON", () => {
    const msg: Message = {
      id: "tc-nested",
      role: "assistant",
      content: "执行了复杂操作",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-3",
          tool: "execute_command",
          args: {
            command: "echo 你好世界 🌍",
            options: {
              cwd: "D:\\工作目录",
              env: { LANG: "zh_CN.UTF-8", GREETING: "你好 🎉" },
            },
          },
          result: "你好世界 🌍\n",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("tc-nested");
    expect(loaded!.content).toBe("执行了复杂操作");
    const calls = toolCallsOf("tc-nested");
    expect(calls).toHaveLength(1);
    const args = calls[0].args as any;
    expect(args.command).toBe("echo 你好世界 🌍");
    expect(args.options.cwd).toBe("D:\\工作目录");
    expect(args.options.env.GREETING).toBe("你好 🎉");
  });

  it("tool call args 包含中文命令", () => {
    const msg: Message = {
      id: "tc-cn-cmd",
      role: "assistant",
      content: "执行了命令",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-4",
          tool: "execute_command",
          args: { command: "dir /b D:\\文档\\*.md" },
          result: "笔记1.md\n笔记2.md",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("tc-cn-cmd");
    expect(loaded!.content).toBe("执行了命令");
    const calls = toolCallsOf("tc-cn-cmd");
    expect(calls).toHaveLength(1);
    const args = calls[0].args as any;
    expect(args.command).toBe("dir /b D:\\文档\\*.md");
  });

  it("多个 tool calls 混合中文和 emoji", () => {
    const msg: Message = {
      id: "tc-multi",
      role: "assistant",
      content: "执行了多个操作",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-a",
          tool: "read_file",
          args: { path: "D:\\中文\\文件.txt" },
          result: "内容",
          status: "done",
        },
        {
          id: "tc-b",
          tool: "write_file",
          args: { path: "D:\\输出\\结果.json", content: "结果 ✅" },
          result: "成功",
          status: "done",
        },
        {
          id: "tc-c",
          tool: "list_directory",
          args: { path: "D:\\目录 📁" },
          result: "[\"文件1.py\", \"文件2.md\"]",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("tc-multi");
    expect(loaded!.content).toBe("执行了多个操作");
    const calls = toolCallsOf("tc-multi");
    expect(calls).toHaveLength(3);
    expect(calls[0].args.path).toBe("D:\\中文\\文件.txt");
    expect(calls[2].args.path).toBe("D:\\目录 📁");
  });

  // ===== Fork 中文/emoji tool calls =====
  it("fork 包含中文/emoji tool calls 的消息后内容完整", () => {
    const sourceMsg: Message = {
      id: "tc-fork-src",
      role: "assistant",
      content: "执行了中文文件操作",
      timestamp: Date.now(),
      status: "done",
      toolCalls: [
        {
          id: "tc-fork-1",
          tool: "write_file",
          args: { path: "D:\\项目\\测试 ⚡.py", content: 'print("你好 🌍")' },
          result: "写入成功 ✅",
          status: "done",
        },
      ],
    };
    MessageStorage.createMessage(sourceMsg, sessionId);

    const newSessionId = "sess-fork-tc";
    SessionStorage.createSession({
      id: newSessionId,
      projectId,
      title: "Fork: 工具调用测试",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    // 模拟 fork
    const sourceMessages = MessageStorage.listMessages(sessionId);
    const forkTs = Date.now();
    for (const msg of sourceMessages) {
      const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
      MessageStorage.createMessage({
        ...msg,
        id: newMsgId,
        toolCalls: msg.toolCalls?.map((tc) => ({
          ...tc,
          id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`,
        })),
      }, newSessionId);
    }

    const forkedMsgs = MessageStorage.listMessages(newSessionId);
    expect(forkedMsgs).toHaveLength(1);
    const forkedMsg = forkedMsgs[0];
    expect(forkedMsg.content).toBe("执行了中文文件操作");
    // fork 过去的副本带没带上 tool_calls：读新消息 id 在端口存储里的那份
    const forkedCalls = toolCallsOf(forkedMsg.id);
    expect(forkedCalls).toHaveLength(1);
    expect(forkedCalls[0].tool).toBe("write_file");
    expect(forkedCalls[0].args.path).toBe("D:\\项目\\测试 ⚡.py");
    expect(forkedCalls[0].args.content).toBe('print("你好 🌍")');
    expect(forkedCalls[0].result).toBe("写入成功 ✅");
  });
});
