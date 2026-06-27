import type {
  LLMProvider,
  LLMRequest,
  TokenUsage,
} from "./types";
import type { ToolRegistry, ToolContext } from "./tools";
import type { SessionManager, MessageV2, Part, ToolPart } from "./session";

// ========== Processor Events ==========
export type ProcessorEvent =
  | { type: "start"; sessionId: string; messageId: string }
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "tool_start"; messageId: string; toolId: string; toolName: string }
  | { type: "tool_delta"; messageId: string; toolId: string; input: string }
  | { type: "tool_end"; messageId: string; toolId: string; output: string; status: "completed" | "error" }
  | { type: "usage"; usage: TokenUsage }
  | { type: "end"; finishReason: string }
  | { type: "error"; error: string };

// ========== Processor Config ==========
export interface ProcessorConfig {
  provider: LLMProvider;
  model: string;
  tools: ToolRegistry;
  sessions: SessionManager;
  temperature?: number;
  maxTokens?: number;
  maxToolCalls?: number;
}

// ========== Processor ==========
export class Processor {
  private config: ProcessorConfig;
  private abortController: AbortController | null = null;
  private isRunning = false;

  constructor(config: ProcessorConfig) {
    this.config = config;
  }

  /** Run a complete agentic loop */
  async *process(
    sessionId: string,
    userMessage: string,
    cwd: string,
  ): AsyncGenerator<ProcessorEvent, void, unknown> {
    if (this.isRunning) {
      yield { type: "error", error: "Already processing" };
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    const session = this.config.sessions.getSession(sessionId);
    if (!session) {
      yield { type: "error", error: "Session not found" };
      this.isRunning = false;
      return;
    }

    // Add user message
    const userMsg: MessageV2 = {
      id: `msg-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", content: userMessage }],
      timestamp: Date.now(),
    };
    this.config.sessions.addMessage(sessionId, userMsg);

    // Create assistant message
    const assistantMsg: MessageV2 = {
      id: `msg-${Date.now() + 1}`,
      role: "assistant",
      parts: [],
      timestamp: Date.now(),
      model: this.config.model,
    };
    this.config.sessions.addMessage(sessionId, assistantMsg);

    yield { type: "start", sessionId, messageId: assistantMsg.id };

    // Agentic loop
    let iteration = 0;
    const maxIterations = this.config.maxToolCalls || 10;

    while (iteration < maxIterations) {
      iteration++;

      // Build messages for API
      const apiMessages = this.config.sessions.toAPIMessages(session.messages);
      const toolDefs = this.config.tools.getDefinitions();

      const request: LLMRequest = {
        model: this.config.model,
        messages: apiMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        temperature: this.config.temperature ?? 0.7,
        maxTokens: this.config.maxTokens ?? 4096,
        stream: true,
        abortSignal: this.abortController.signal,
      };

      let currentText = "";
      let currentToolCallId: string | null = null;
      let currentToolName: string | null = null;
      let currentToolInput = "";
      let finishReason = "stop";
      let usage: TokenUsage | null = null;
      let toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      try {
        for await (const event of this.config.provider.stream(request)) {
          switch (event.type) {
            case "text_delta":
              currentText += event.text;
              yield { type: "text_delta", messageId: assistantMsg.id, text: event.text };
              break;

            case "tool_use_start":
              currentToolCallId = event.id;
              currentToolName = event.name;
              currentToolInput = "";
              yield { type: "tool_start", messageId: assistantMsg.id, toolId: event.id, toolName: event.name };
              break;

            case "tool_use_delta":
              currentToolInput += event.input;
              yield { type: "tool_delta", messageId: assistantMsg.id, toolId: event.id, input: event.input };
              break;

            case "tool_use_end":
              if (currentToolCallId && currentToolName) {
                try {
                  const input = JSON.parse(currentToolInput);
                  toolCalls.push({ id: currentToolCallId, name: currentToolName, input });
                } catch {}
                currentToolCallId = null;
                currentToolName = null;
                currentToolInput = "";
              }
              break;

            case "usage":
              usage = event.usage;
              break;

            case "end":
              finishReason = event.finishReason;
              break;

            case "error":
              yield { type: "error", error: event.error };
              this.isRunning = false;
              return;
          }
        }
      } catch (error: any) {
        if (error.name === "AbortError") {
          yield { type: "end", finishReason: "aborted" };
        } else {
          yield { type: "error", error: error.message };
        }
        this.isRunning = false;
        return;
      }

      // Add text part to assistant message
      if (currentText) {
        this.config.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
          ...msg,
          parts: [...msg.parts, { type: "text", content: currentText } as Part],
        }));
      }

      // Update usage
      if (usage) {
        yield { type: "usage", usage };
        session.totalUsage.promptTokens += usage.promptTokens;
        session.totalUsage.completionTokens += usage.completionTokens;
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0 || finishReason !== "tool_use") {
        yield { type: "end", finishReason };
        break;
      }

      // Execute tool calls
      const toolCtx: ToolContext = {
        sessionId,
        messageId: assistantMsg.id,
        cwd,
        abort: this.abortController.signal,
        messages: this.config.sessions.toAPIMessages(session.messages),
        metadata: () => {},
      };

      for (const tc of toolCalls) {
        // Add pending tool part
        const toolPart: ToolPart = {
          type: "tool",
          id: tc.id,
          name: tc.name,
          input: tc.input,
          status: "running",
        };

        this.config.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
          ...msg,
          parts: [...msg.parts, toolPart],
        }));

        // Execute tool
        const result = await this.config.tools.execute(tc.id, tc.name, tc.input, toolCtx);

        // Update tool part with result
        this.config.sessions.updateMessage(sessionId, assistantMsg.id, (msg) => ({
          ...msg,
          parts: msg.parts.map((p) =>
            p.type === "tool" && p.id === tc.id
              ? { ...p, output: result.output, status: result.status, error: result.error }
              : p
          ),
        }));

        yield {
          type: "tool_end",
          messageId: assistantMsg.id,
          toolId: tc.id,
          output: result.output || "",
          status: result.status as "completed" | "error",
        };

        // Add tool result as a user message for the next iteration
        const toolResultMsg: MessageV2 = {
          id: `msg-${Date.now()}-${tc.id}`,
          role: "user",
          parts: [{ type: "text", content: `[Tool Result: ${tc.name}]\n${result.output || "(no output)"}` }],
          timestamp: Date.now(),
        };
        this.config.sessions.addMessage(sessionId, toolResultMsg);
      }

      // Reset for next iteration
      currentText = "";
      toolCalls = [];

      // Create new assistant message for next iteration
      const nextAssistantMsg: MessageV2 = {
        id: `msg-${Date.now() + 2}`,
        role: "assistant",
        parts: [],
        timestamp: Date.now(),
        model: this.config.model,
      };
      this.config.sessions.addMessage(sessionId, nextAssistantMsg);
    }

    this.isRunning = false;
  }

  /** Abort current processing */
  abort() {
    this.abortController?.abort();
    this.isRunning = false;
  }
}
