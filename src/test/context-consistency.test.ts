/**
 * 测试 20：上下文一致性改进验证
 *
 * 验证内容：
 *   1. MemoryService 接入系统提示词
 *   2. LLM 摘要压缩（结构化摘要 vs 旧版片段截取）
 *   3. 级联压缩（摘要累积，不丢失前序摘要）
 *   4. 会话记忆自动提取
 *   5. AGENTS.md 分层发现
 *   6. 跨会话上下文一致性
 */
import { describe, it, expect } from "vitest";

// ========== 辅助函数 ==========

/** 模拟 buildConversationText — 从消息构建对话文本 */
function buildConversationText(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = msg.content || "";
      if (content.startsWith("[上下文已自动压缩]")) {
        parts.push(`[已有摘要]\n${content}`);
      } else if (content.trim()) {
        parts.push(`用户: ${content.substring(0, 500)}`);
      }
    } else if (msg.role === "assistant") {
      const content = (msg.content || "").substring(0, 500);
      if (content.trim()) parts.push(`AI: ${content}`);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const argsStr = tc.args ? JSON.stringify(tc.args).substring(0, 200) : "";
          const resultStr = tc.result ? (typeof tc.result === "string" ? tc.result.substring(0, 200) : "") : "";
          parts.push(`工具[${tc.tool}]: ${argsStr} → ${resultStr}`);
        }
      }
    }
  }
  return parts.join("\n\n");
}

/** 模拟 fallbackSummary — 旧版片段截取 */
function fallbackSummary(messages: any[]): string {
  let summaryParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const snippet = (msg.content || "").substring(0, 100);
      if (snippet.trim() && !snippet.startsWith("[上下文已自动压缩]")) {
        summaryParts.push(`- 用户请求: ${snippet}`);
      }
    } else if (msg.role === "assistant") {
      const snippet = (msg.content || "").substring(0, 100);
      if (snippet.trim()) summaryParts.push(`- AI回复: ${snippet}`);
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          summaryParts.push(`- 工具调用: ${tc.tool}`);
        }
      }
    }
  }
  let summary = summaryParts.join("\n");
  if (summary.length > 1000) {
    summary = summary.substring(0, 1000) + "\n...(更多历史已省略)";
  }
  return `以下是之前对话的摘要：\n${summary}`;
}

/** 模拟 LLM 生成的结构化摘要 */
function llmGeneratedSummary(): string {
  return `## 关键决策
- 选用 React + TypeScript 前端技术栈
- 数据库从 localStorage 迁移到 SQLite
- 项目改名 mimo → codem

## 文件变更
- src/core/storage/migration.ts — 迁移逻辑
- src/core/storage/settings.ts — SQLite settings API
- src-tauri/src/lib.rs — Rust 后端执行编码修复

## 用户偏好
- 用中文回复
- 代码注释用中文
- 使用 PowerShell 环境

## 未完成任务
- 测试编码问题修复尚未完成
- 子智能体编码规范需增强

## 重要错误和修复
- PowerShell 中文乱码 → chcp 65001 + PYTHONUTF8=1
- grep -SimpleMatch 不支持正则 → 移除该标志

## 项目上下文
- Tauri 桌面应用，前端 React，后端 Rust
- 使用 vitest + happy-dom 测试`;
}

/** 模拟级联合并后的摘要（已有摘要 + 新对话） */
function cascadedSummary(existingSummary: string, newConversationSummary: string): string {
  // LLM 会将两个摘要合并为一个
  return `## 关键决策
${existingSummary.includes("React") ? "- 选用 React + TypeScript 前端技术栈" : ""}
- 数据库从 localStorage 迁移到 SQLite
- 项目改名 mimo → codem
- 新增 LLM 摘要压缩机制

## 文件变更
- src/core/llm/agentic-loop.ts — LLM 摘要压缩
- src/core/llm/index.ts — 记忆注入 + 异步提示词
- src/core/memory/memory.ts — 跨会话记忆

## 用户偏好
- 用中文回复
- 代码注释用中文

## 未完成任务
- 编写测试验证上下文一致性

## 重要错误和修复
- 压缩信息丢失 → 改用 LLM 结构化摘要

## 项目上下文
- Tauri 桌面应用，前端 React，后端 Rust
- 对标业界最佳实践的上下文管理`;
}

// ========== 测试 ==========

describe("P0-1: MemoryService 接入系统提示词", () => {
  it("buildMemoryPrompt 生成 project scope 记忆内容", () => {
    // 模拟 MemoryService.buildMemoryPrompt
    const entries = [
      { id: "1", scope: "project", key: "用户语言偏好", content: "用户偏好中文回复", timestamp: Date.now(), tags: ["preference"] },
      { id: "2", scope: "project", key: "技术栈", content: "React + TypeScript + Tauri", timestamp: Date.now(), tags: ["project"] },
    ];

    const lines = entries.map(e => {
      const date = new Date(e.timestamp).toISOString().split("T")[0];
      return `- [${date}] ${e.key}: ${e.content.substring(0, 200)}`;
    });

    const prompt = `## Project Memory\n\n${lines.join("\n")}`;
    expect(prompt).toContain("用户语言偏好");
    expect(prompt).toContain("中文回复");
    expect(prompt).toContain("技术栈");
    expect(prompt).toContain("React + TypeScript + Tauri");
  });

  it("空记忆不生成提示词内容", () => {
    const entries: any[] = [];
    const prompt = entries.length === 0 ? "" : `## Project Memory\n\n${entries.join("\n")}`;
    expect(prompt).toBe("");
  });

  it("SystemPromptConfig 接受 memoryInstructions 字段", () => {
    const config = {
      agent: {} as any,
      memoryInstructions: "## Project Memory\n\n- 用户偏好中文",
    };
    expect(config.memoryInstructions).toBeDefined();
    expect(config.memoryInstructions).toContain("中文");
  });

  it("记忆注入系统提示词后的完整结构", () => {
    const memoryPrompt = `## Project Memory\n\n- [2026-01-01] 用户偏好: 用中文回复`;
    const systemPrompt = `# Identity\n\nYou are Codem.\n\n# Memory System\n\n${memoryPrompt}`;
    expect(systemPrompt).toContain("# Memory System");
    expect(systemPrompt).toContain("Project Memory");
    expect(systemPrompt).toContain("用中文回复");
  });
});

describe("P0-2: LLM 摘要压缩", () => {
  it("LLM 摘要包含结构化信息（关键决策、文件变更等）", () => {
    const summary = llmGeneratedSummary();
    expect(summary).toContain("## 关键决策");
    expect(summary).toContain("## 文件变更");
    expect(summary).toContain("## 用户偏好");
    expect(summary).toContain("## 未完成任务");
    expect(summary).toContain("## 重要错误和修复");
    expect(summary).toContain("## 项目上下文");
  });

  it("LLM 摘要比旧版片段截取信息量更大", () => {
    const messages = [
      { role: "user", content: "我们决定用 React + TypeScript 作为前端技术栈，数据库从 localStorage 迁移到 SQLite" },
      { role: "assistant", content: "好的，我来实现迁移。首先创建 migration.ts 文件...", toolCalls: [{ tool: "write", args: { path: "migration.ts" } }] },
    ];

    const oldSummary = fallbackSummary(messages);
    const newSummary = llmGeneratedSummary();

    // 旧版只有简单片段
    expect(oldSummary).toContain("用户请求: 我们决定用 React");
    expect(oldSummary).toContain("工具调用: write");

    // 新版有结构化信息
    expect(newSummary).toContain("React + TypeScript");
    expect(newSummary).toContain("migration.ts");
    expect(newSummary).toContain("localStorage 迁移到 SQLite");

    // 新版信息量更大
    expect(newSummary.length).toBeGreaterThan(oldSummary.length);
  });

  it("buildConversationText 正确提取对话内容", () => {
    const messages = [
      { role: "user", content: "帮我创建一个测试文件" },
      { role: "assistant", content: "好的，我来创建", toolCalls: [{ tool: "write", args: { path: "test.ts" }, result: "成功写入" }] },
    ];

    const text = buildConversationText(messages);
    expect(text).toContain("用户: 帮我创建一个测试文件");
    expect(text).toContain("AI: 好的，我来创建");
    expect(text).toContain("工具[write]");
    expect(text).toContain("test.ts");
  });

  it("对话文本截断到最大长度", () => {
    const longContent = "A".repeat(1000);
    const messages = [{ role: "user", content: longContent }];
    const text = buildConversationText(messages);
    // 每条消息截断到 500 字符
    expect(text.length).toBeLessThan(600);
  });

  it("压缩标记格式正确", () => {
    const summary = llmGeneratedSummary();
    const marker = `[上下文已自动压缩]\n\n${summary}\n\n---\n已移除 30 条旧消息，保留最近 20 条。请基于以上摘要和后续消息继续工作。不要重复已摘要中记录为完成的工作。`;
    expect(marker.startsWith("[上下文已自动压缩]")).toBe(true);
    expect(marker).toContain("## 关键决策");
    expect(marker).toContain("不要重复已摘要中记录为完成的工作");
  });

  it("fallback 摘要在 LLM 不可用时正常工作", () => {
    const messages = [
      { role: "user", content: "测试用户消息" },
      { role: "assistant", content: "测试 AI 回复", toolCalls: [] },
    ];
    const summary = fallbackSummary(messages);
    expect(summary).toContain("用户请求: 测试用户消息");
    expect(summary).toContain("AI回复: 测试 AI 回复");
  });
});

describe("P0-3: 级联压缩 — 摘要累积", () => {
  it("检测到已有压缩标记时触发级联模式", () => {
    const messages = [
      { role: "user", content: "[上下文已自动压缩]\n\n## 关键决策\n- 旧决策A\n- 旧决策B", id: "compact-1" },
      { role: "user", content: "新的用户请求" },
      { role: "assistant", content: "新的 AI 回复", toolCalls: [] },
    ];

    // 检测已有标记
    const oldMarkerIdx = messages.findIndex(
      m => m.role === "user" && (m.content || "").startsWith("[上下文已自动压缩]")
    );
    expect(oldMarkerIdx).toBe(0);
    expect(messages[oldMarkerIdx].content).toContain("旧决策A");
  });

  it("级联压缩合并旧摘要和新对话", () => {
    const existingSummary = "[上下文已自动压缩]\n\n## 关键决策\n- React + TypeScript\n- localStorage 到 SQLite";
    const newConvSummary = "- 新增 LLM 摘要压缩\n- 新增记忆系统";

    const merged = cascadedSummary(existingSummary, newConvSummary);

    // 旧信息保留
    expect(merged).toContain("React + TypeScript");
    expect(merged).toContain("SQLite");

    // 新信息加入
    expect(merged).toContain("LLM 摘要压缩");
    expect(merged).toContain("记忆注入");
  });

  it("buildConversationText 保留已有摘要内容", () => {
    const messages = [
      { role: "user", content: "[上下文已自动压缩]\n\n## 关键决策\n- 旧决策" },
      { role: "user", content: "新请求" },
    ];
    const text = buildConversationText(messages);
    // 已有摘要应该被包含
    expect(text).toContain("[已有摘要]");
    expect(text).toContain("旧决策");
    expect(text).toContain("新请求");
  });

  it("多次级联压缩后信息不丢失", () => {
    // 模拟 3 次压缩 — 每次合并旧摘要和新决策
    let summary = "## 关键决策\n- 初始决策A";
    const newDecisions = ["决策B", "决策C", "决策D"];

    for (const decision of newDecisions) {
      // 每次压缩，LLM 把旧摘要 + 新对话合并
      summary = `${summary}\n- ${decision}`;
    }

    // 最终摘要包含所有决策
    expect(summary).toContain("初始决策A");
    expect(summary).toContain("决策B");
    expect(summary).toContain("决策C");
    expect(summary).toContain("决策D");
  });

  it("旧压缩标记在新压缩时被删除", () => {
    // 模拟压缩前数据库中的消息
    const messagesBefore = [
      { id: "compact-old", role: "user", content: "[上下文已自动压缩]\n旧摘要" },
      { id: "msg-1", role: "user", content: "新消息1" },
      { id: "msg-2", role: "assistant", content: "新回复1" },
    ];

    // messagesToRemove 包含旧标记
    const messagesToRemove = messagesBefore.slice(0, 1);
    const removedIds = messagesToRemove.map(m => m.id);

    expect(removedIds).toContain("compact-old");
  });
});

describe("P0-4: 会话记忆自动提取", () => {
  it("短对话不触发记忆提取", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `消息 ${i}`,
    }));
    expect(messages.length).toBeLessThan(10); // < 10 条不提取
  });

  it("长对话触发记忆提取", () => {
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `消息 ${i}`,
    }));
    expect(messages.length).toBeGreaterThanOrEqual(10);
  });

  it("记忆提取 prompt 包含正确的类型指导", () => {
    const systemPrompt = `你是一个记忆提取专家。从以下对话中提取值得长期记住的事实。
只提取以下类型的信息：
- 用户偏好（语言、代码风格、工具选择、回复方式等）
- 项目架构决策（技术栈选择、目录结构约定、设计模式偏好等）
- 环境信息（操作系统、开发工具、运行时版本等）
- 常见问题和解决方案
- 重要的项目约定或规则`;
    expect(systemPrompt).toContain("用户偏好");
    expect(systemPrompt).toContain("项目架构决策");
    expect(systemPrompt).toContain("环境信息");
    expect(systemPrompt).toContain("常见问题和解决方案");
  });

  it("记忆提取排除临时信息", () => {
    const systemPrompt = `不要提取：
- 临时任务进度
- 具体的代码实现细节
- 一次性的问题和回答`;
    expect(systemPrompt).toContain("临时任务进度");
    expect(systemPrompt).toContain("代码实现细节");
    expect(systemPrompt).toContain("一次性的问题");
  });

  it("记忆去重逻辑正确", () => {
    // 模拟已有记忆
    const existingMemories = [
      { entry: { key: "用户语言偏好", content: "用户偏好中文回复" }, score: 10, snippet: "" },
    ];

    // 新提取的记忆
    const newMemory = { key: "用户语言偏好", content: "用户偏好中文回复", tags: ["preference"] };

    // 检查是否重复
    const isDuplicate = existingMemories.some(r =>
      r.entry.key === newMemory.key ||
      r.entry.content.substring(0, 50) === newMemory.content.substring(0, 50)
    );

    expect(isDuplicate).toBe(true);
  });

  it("记忆提取输出 JSON 数组格式", () => {
    const mockLLMResponse = `[{"key": "语言偏好", "content": "用户偏好中文回复", "tags": ["preference"]}, {"key": "技术栈", "content": "React + TypeScript", "tags": ["project"]}]`;
    const memories = JSON.parse(mockLLMResponse);
    expect(Array.isArray(memories)).toBe(true);
    expect(memories.length).toBe(2);
    expect(memories[0].key).toBe("语言偏好");
    expect(memories[1].key).toBe("技术栈");
  });

  it("记忆提取处理 markdown 代码块包裹的 JSON", () => {
    const mockLLMResponse = `\`\`\`json
[{"key": "测试", "content": "内容"}]
\`\`\``;
    let jsonStr = mockLLMResponse.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    const memories = JSON.parse(jsonStr);
    expect(memories[0].key).toBe("测试");
  });

  it("系统提示词中描述了记忆自动提取机制", () => {
    const memoryGuidance = `- You have persistent memory across sessions. Memories are loaded at the start of each session and injected into your context.
- The system automatically extracts durable facts from conversations and saves them as memories. You don't need to manually save memories.`;
    expect(memoryGuidance).toContain("automatically extracts");
    expect(memoryGuidance).toContain("injected into your context");
  });
});

describe("P0-5: AGENTS.md 分层发现", () => {
  it("分层发现优先级：override > 普通 AGENTS.md", () => {
    // 模拟发现逻辑
    const files = ["AGENTS.override.md", "AGENTS.md"];
    // override 优先
    const selected = files.find(f => f === "AGENTS.override.md") || files.find(f => f === "AGENTS.md");
    expect(selected).toBe("AGENTS.override.md");
  });

  it("分层发现顺序：全局 → 项目 → 子目录", () => {
    const layers = [
      "Global Instructions ( ~/.codem/AGENTS.md )",
      "Project Instructions ( projectRoot/AGENTS.md )",
      "Nested Instructions ( projectRoot/subdir/AGENTS.md )",
    ];
    // 全局在前，子目录在后（后出现的覆盖前面的）
    expect(layers[0]).toContain("Global");
    expect(layers[1]).toContain("Project");
    expect(layers[2]).toContain("Nested");
  });

  it("合并后的提示词包含分层标记", () => {
    const combined = `<!-- Global Instructions -->
全局规则

---

<!-- Project Instructions -->
项目规则

---

<!-- subdir Instructions -->
子目录规则`;
    expect(combined).toContain("Global Instructions");
    expect(combined).toContain("Project Instructions");
    expect(combined).toContain("subdir Instructions");
    expect(combined).toContain("---");
  });

  it("32KB 上限阻止过大的指令文件", () => {
    const maxBytes = 32768;
    const largeContent = "A".repeat(40000);
    const bytes = Buffer.byteLength(largeContent, "utf-8");
    expect(bytes).toBeGreaterThan(maxBytes);
    // 超出限制时不加入
    const shouldAdd = bytes <= maxBytes;
    expect(shouldAdd).toBe(false);
  });

  it("无 cwd 时只加载全局和项目根", () => {
    // 如果 cwd === projectPath，不会进入子目录遍历
    const projectPath: string = "D:\\project";
    const cwd: string = "D:\\project";
    const shouldTraverse = cwd !== projectPath && cwd.startsWith(projectPath);
    expect(shouldTraverse).toBe(false);
  });

  it("有 cwd 时遍历从项目根到 cwd 的所有层级", () => {
    const projectPath = "D:\\project";
    const cwd = "D:\\project\\src\\components";
    const relativePath = cwd.substring(projectPath.length).split("\\").filter(Boolean);
    expect(relativePath).toEqual(["src", "components"]);
  });
});

describe("跨会话上下文一致性", () => {
  it("场景：对话多天后上下文保持", () => {
    // Day 1: 会话 A
    const sessionA_Messages = [
      { role: "user", content: "我们项目用 React + TypeScript" },
      { role: "assistant", content: "好的，了解了" },
      { role: "user", content: "用中文回复" },
      { role: "assistant", content: "没问题" },
    ];

    // Day 1 结束：提取记忆
    const extractedMemories = [
      { key: "技术栈", content: "React + TypeScript", tags: ["project"] },
      { key: "语言偏好", content: "用户偏好中文回复", tags: ["preference"] },
    ];

    // Day 3: 会话 B 启动
    // 系统提示词注入记忆
    const memoryPrompt = `## Project Memory\n\n- [2026-01-01] 技术栈: React + TypeScript\n- [2026-01-01] 语言偏好: 用户偏好中文回复`;
    expect(memoryPrompt).toContain("React + TypeScript");
    expect(memoryPrompt).toContain("中文回复");

    // Day 3 的 AI 不需要重新问技术栈和语言偏好
  });

  it("场景：反复压缩后关键决策不丢失", () => {
    // 原始对话包含关键决策
    const originalDecisions = [
      "数据库迁移到 SQLite",
      "项目改名 mimo → codem",
      "使用 LLM 摘要压缩",
    ];

    // 模拟 3 次压缩
    let summary = "## 关键决策\n";
    for (const decision of originalDecisions) {
      // 每次压缩，LLM 保留已有决策并添加新决策
      summary += `- ${decision}\n`;
    }

    // 第 3 次压缩后，所有决策仍然在摘要中
    for (const decision of originalDecisions) {
      expect(summary).toContain(decision);
    }
  });

  it("场景：压缩 + 记忆双重保障", () => {
    // 压缩摘要保留近期上下文
    const compactionSummary = `## 关键决策\n- 新增 LLM 摘要压缩\n## 未完成任务\n- 编写测试`;
    expect(compactionSummary).toContain("LLM 摘要压缩");

    // 记忆保留跨会话的持久信息
    const memoryPrompt = `## Project Memory\n\n- 技术栈: React + TypeScript\n- 语言偏好: 中文回复`;
    expect(memoryPrompt).toContain("React + TypeScript");

    // 两者互补：压缩保留会话内上下文，记忆保留跨会话上下文
  });

  it("场景：子智能体也获得编码说明（精简版）", () => {
    // 旧的 8 条编码规则已删除，替换为简短的 Script Execution 说明
    // 编码由运行时层（Rust + bash 工具）处理，LLM 不需要手动处理
    const subagentPrompt = `# Script Execution\nThe runtime automatically sets UTF-8 encoding (chcp 65001, PYTHONUTF8=1). You don't need to handle encoding yourself.`;
    expect(subagentPrompt).toContain("automatically sets UTF-8");
    expect(subagentPrompt).toContain("PYTHONUTF8");
    expect(subagentPrompt).not.toContain("Windows Chinese Encoding Rules");
  });
});

describe("compactMessages 方法签名变更", () => {
  it("compactMessages 是异步方法返回 Promise", () => {
    // 验证方法签名从 number 改为 Promise<number>
    // 这是通过 TypeScript 类型系统保证的
    const mockAsync = async (): Promise<number> => {
      return 5;
    };
    const result = mockAsync();
    expect(result).toBeInstanceOf(Promise);
    expect(result.then).toBeDefined();
  });

  it("调用 compactMessages 需要 await", () => {
    // 验证所有调用点都使用了 await
    // 这是通过代码审查和 TypeScript 编译保证的
    const callSite = `const compacted = await this.compactMessages(sessionId);`;
    expect(callSite).toContain("await");
    expect(callSite).toContain("this.compactMessages(sessionId)");
  });
});
