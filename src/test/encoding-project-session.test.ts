/**
 * 测试 14：编码测试 — 中文和 Emoji 在项目名、路径、会话标题、消息内容中
 *
 * 改动影响：
 *   - ProjectManager.tsx 删除了 localStorage，项目完全走 SQLite projects 表
 *   - 会话和消息也在 SQLite 中
 *   - 如果 SQLite 的 TEXT 类型在序列化/反序列化多字节字符时有问题，数据会损坏
 */
import { describe, it, expect, beforeEach } from "vitest";
import { initDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import type { Message } from "../store";

describe("编码测试 — 项目名/路径中的中文和 Emoji", () => {
  beforeEach(async () => {
    await initDatabase();
  });

  it("中文项目名存储和读取", () => {
    ProjectStorage.createProject({
      id: "proj-cn",
      name: "我的项目",
      path: "D:\\项目\\测试",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const projects = ProjectStorage.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("我的项目");
    expect(projects[0].path).toBe("D:\\项目\\测试");
  });

  it("Emoji 项目名存储和读取", () => {
    ProjectStorage.createProject({
      id: "proj-emoji",
      name: "🚀火箭项目 🎯",
      path: "D:\\rockets\\🚀",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const project = ProjectStorage.getProject("proj-emoji");
    expect(project).not.toBeNull();
    expect(project!.name).toBe("🚀火箭项目 🎯");
    expect(project!.path).toBe("D:\\rockets\\🚀");
  });

  it("中文和 Emoji 混合路径", () => {
    const path = "D:\\开发\\项目⚡\\测试目录";
    ProjectStorage.createProject({
      id: "proj-mix",
      name: "混合项目 🧪",
      path,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const project = ProjectStorage.getProject("proj-mix");
    expect(project!.path).toBe(path);
  });

  it("中文项目描述", () => {
    ProjectStorage.createProject({
      id: "proj-desc",
      name: "测试项目",
      path: "D:\\test",
      description: "这是一个「重要」的项目 📌",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const project = ProjectStorage.getProject("proj-desc");
    expect(project!.description).toBe("这是一个「重要」的项目 📌");
  });

  it("更新中文项目名", () => {
    ProjectStorage.createProject({
      id: "proj-update",
      name: "旧名字",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.updateProject("proj-update", { name: "新名字 ✨" });
    const project = ProjectStorage.getProject("proj-update");
    expect(project!.name).toBe("新名字 ✨");
  });

  it("删除中文项目名项目", () => {
    ProjectStorage.createProject({
      id: "proj-del",
      name: "要删除的项目 🗑️",
      path: "D:\\删除",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.deleteProject("proj-del");
    expect(ProjectStorage.getProject("proj-del")).toBeNull();
  });
});

describe("编码测试 — 会话标题中的中文和 Emoji", () => {
  const projectId = "proj-session-test";

  beforeEach(async () => {
    await initDatabase();
    ProjectStorage.createProject({
      id: projectId,
      name: "Test",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  });

  it("中文会话标题存储和读取", () => {
    SessionStorage.createSession({
      id: "sess-cn",
      projectId,
      title: "讨论中文编码问题",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const sessions = SessionStorage.listSessions(projectId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("讨论中文编码问题");
  });

  it("Emoji 会话标题", () => {
    SessionStorage.createSession({
      id: "sess-emoji",
      projectId,
      title: "🎉庆祝会话 ✨",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const session = SessionStorage.getSession("sess-emoji");
    expect(session!.title).toBe("🎉庆祝会话 ✨");
  });

  it("超长中文会话标题", () => {
    const title = "这是一个超长的会话标题".repeat(20);
    SessionStorage.createSession({
      id: "sess-long",
      projectId,
      title,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    const session = SessionStorage.getSession("sess-long");
    expect(session!.title).toBe(title);
  });
});

describe("编码测试 — 消息内容中的中文和 Emoji", () => {
  const projectId = "proj-msg-test";
  const sessionId = "sess-msg-test";

  beforeEach(async () => {
    await initDatabase();
    ProjectStorage.createProject({
      id: projectId,
      name: "Test",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: sessionId,
      projectId,
      title: "测试会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });
  });

  it("纯中文消息内容", () => {
    const msg: Message = {
      id: "msg-cn",
      role: "user",
      content: "你好，请帮我写一个函数来计算斐波那契数列",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-cn");
    expect(loaded!.content).toBe("你好，请帮我写一个函数来计算斐波那契数列");
  });

  it("Emoji 消息内容", () => {
    const msg: Message = {
      id: "msg-emoji",
      role: "user",
      content: "🤖 帮我写代码 🚀✨",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-emoji");
    expect(loaded!.content).toBe("🤖 帮我写代码 🚀✨");
  });

  it("复合 emoji 消息内容", () => {
    const msg: Message = {
      id: "msg-complex-emoji",
      role: "assistant",
      content: "好的！🧑‍💻 开始编码 👨‍👩‍👧‍👦 团队协作 🇨🇳",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-complex-emoji");
    expect(loaded!.content).toBe("好的！🧑‍💻 开始编码 👨‍👩‍👧‍👦 团队协作 🇨🇳");
  });

  it("包含代码块和中文的混合内容", () => {
    const content = `这是中文说明：

\`\`\`python
def 你好():
    print("你好世界 🌍")
\`\`\`

上面的函数会输出「你好世界」`;

    const msg: Message = {
      id: "msg-mixed",
      role: "assistant",
      content,
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-mixed");
    expect(loaded!.content).toBe(content);
  });

  it("中文 reasoning 内容", () => {
    const msg: Message = {
      id: "msg-reasoning",
      role: "assistant",
      content: "答案是 42",
      reasoning: "用户问了一个问题，我需要思考一下…🤔 答案应该是 42",
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-reasoning");
    expect(loaded!.reasoning).toBe("用户问了一个问题，我需要思考一下…🤔 答案应该是 42");
  });

  it("中文 generatedFiles 路径", () => {
    const msg: Message = {
      id: "msg-genfiles",
      role: "assistant",
      content: "已创建文件",
      timestamp: Date.now(),
      status: "done",
      generatedFiles: ["D:\\项目\\源码\\你好.py", "D:\\test\\配置文件 ⚙️.json"],
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-genfiles");
    expect(loaded!.generatedFiles).toBeDefined();
    expect(loaded!.generatedFiles![0]).toBe("D:\\项目\\源码\\你好.py");
    expect(loaded!.generatedFiles![1]).toBe("D:\\test\\配置文件 ⚙️.json");
  });

  it("超长中文消息内容", () => {
    const content = "这是一段很长的中文消息。".repeat(500); // 12 chars × 500 = 6000
    const msg: Message = {
      id: "msg-long",
      role: "user",
      content,
      timestamp: Date.now(),
      status: "done",
    };
    MessageStorage.createMessage(msg, sessionId);

    const loaded = MessageStorage.getMessage("msg-long");
    expect(loaded!.content).toBe(content);
    expect(loaded!.content.length).toBe(6000);
  });

  it("listMessages 正确返回中文和 emoji 消息", () => {
    const messages: Message[] = [
      { id: "lm-1", role: "user", content: "你好 👋", timestamp: 1000, status: "done" },
      { id: "lm-2", role: "assistant", content: "你好！有什么可以帮你的？😊", timestamp: 2000, status: "done" },
      { id: "lm-3", role: "user", content: "帮我看看这个「错误」", timestamp: 3000, status: "done" },
    ];

    for (const msg of messages) {
      MessageStorage.createMessage(msg, sessionId);
    }

    const loaded = MessageStorage.listMessages(sessionId);
    expect(loaded).toHaveLength(3);
    expect(loaded[0].content).toBe("你好 👋");
    expect(loaded[1].content).toBe("你好！有什么可以帮你的？😊");
    expect(loaded[2].content).toBe("帮我看看这个「错误」");
  });
});
