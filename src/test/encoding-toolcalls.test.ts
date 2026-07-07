/**
 * 测试 15：编码测试 — 中文和 Emoji 在 Tool Calls 参数中
 *
 * 改动影响：
 *   - Fork 功能复制消息时会复制 tool_calls
 *   - tool_calls 的 args 是 JSON 字符串存储在 SQLite 中
 *   - 如果中文路径/emoji 在 JSON 序列化时出问题，工具调用会失败
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import * as MessageStorage from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import type { Message } from "../store";

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

    const loaded = MessageStorage.getMessage("tc-cn-path");
    expect(loaded!.toolCalls).toBeDefined();
    expect(loaded!.toolCalls![0].args.path).toBe("D:\\项目\\源码\\你好.py");
    expect(loaded!.toolCalls![0].result).toBe("文件内容：你好世界");
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
    expect(loaded!.toolCalls![0].args.path).toBe("D:\\test\\配置 ⚙️.json");
    expect(loaded!.toolCalls![0].args.content).toBe('{"name": "闪电 ⚡"}');
    expect(loaded!.toolCalls![0].result).toBe("写入成功 ✅");
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
    const args = loaded!.toolCalls![0].args as any;
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
    const args = loaded!.toolCalls![0].args as any;
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
    expect(loaded!.toolCalls).toHaveLength(3);
    expect(loaded!.toolCalls![0].args.path).toBe("D:\\中文\\文件.txt");
    expect(loaded!.toolCalls![2].args.path).toBe("D:\\目录 📁");
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
    expect(forkedMsg.toolCalls).toBeDefined();
    expect(forkedMsg.toolCalls![0].args.path).toBe("D:\\项目\\测试 ⚡.py");
    expect(forkedMsg.toolCalls![0].args.content).toBe('print("你好 🌍")');
    expect(forkedMsg.toolCalls![0].result).toBe("写入成功 ✅");
  });
});
