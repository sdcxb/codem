/**
 * InProcessSpawnProvider — 对标 DSH @deepseek-ai/dsh-subagent-spawn-in-process
 *
 * 进程内 Spawn 子智能体 Provider：在当前进程中创建一个全新的子 Agent，
 * 不继承父对话上下文，拥有独立的 session、系统提示和工具集。
 *
 * 这是「最轻量」的传输层 —— 复用 AgenticLoop 的 quiescent teardown。
 */

import type {
  SubagentProvider,
  SubagentRun,
  SubagentResult,
  SubagentStartRequest,
  SubagentCapabilities,
} from './runtime-types';
import { parseTaskResult } from './subagent';
import { sanitizeSubagentOutput } from './runtime';
import type { LLMEngine } from '../llm';
import { getLang } from '../i18n/lang';

export class InProcessSpawnProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    depthLimit: true,
    toolFilter: true,
    persona: true,
  };
  readonly inheritsParentContext = false;

  constructor(
    readonly name: string,
    private engine: LLMEngine,
  ) {}

  /**
   * 启动一次性子智能体 — 对标 DSH SpawnInProcessProvider.start()
   *
   * 在当前进程中创建一个全新的 AgenticLoop 运行子智能体任务。
   * 调用方获得 run 句柄，await run.result 获取结果后 dispose。
   */
  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const childId = `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const abort = new AbortController();

    // 监听调用方的取消信号
    request.signal.addEventListener('abort', () => abort.abort());

    const resultPromise = this.executeRun(childId, request, abort);

    return {
      id: childId,
      result: resultPromise,
      async dispose() {
        abort.abort({ kind: 'parent' } as any);
      },
    };
  }

  /**
   * 准备可持续子智能体 — 对标 DSH prepareContinuable()
   * Spawn 模式不继承父上下文，所以 seed 为空。
   */
  prepareContinuable(): Promise<{ seed?: unknown[] }> {
    return Promise.resolve({});
  }

  /**
   * 执行子智能体任务
   */
  private async executeRun(
    sessionId: string,
    request: SubagentStartRequest,
    abort: AbortController,
  ): Promise<SubagentResult> {
    try {
      let output = '';
      let toolResults: string[] = [];
      const zh = getLang() === 'zh';

      for await (const event of this.engine.processSubagent(
        sessionId,
        request.prompt,
        request.cwd,
        request.agentId || 'general',
        request.profileId,
      )) {
        if (abort.signal.aborted) {
          return {
            output: '',
            stopReason: 'aborted',
            filesTouched: [],
            summary: zh ? '任务被取消' : 'Task was cancelled',
          };
        }
        if (event.type === 'text_delta') {
          output += event.text;
        }
        if (event.type === 'tool_complete' && event.result) {
          const toolOutput = typeof event.result === 'string'
            ? event.result
            : (event.result as any).output || '';
          // 防注入：使用 sanitizeSubagentOutput 净化工具结果
          const cleanToolOutput = sanitizeSubagentOutput(toolOutput);
          if (cleanToolOutput) {
            toolResults.push(cleanToolOutput);
          }
        }
      }

      // 防注入：使用 sanitizeSubagentOutput 净化子智能体输出
      output = sanitizeSubagentOutput(output);

      const fullOutput = toolResults.length > 0
        ? output + '\n\n' + (zh ? '[工具结果]' : '[Tool Results]') + '\n' + toolResults.join('\n---\n')
        : output;

      const parsed = parseTaskResult(fullOutput);

      return {
        output: parsed.output,
        stopReason: 'completed',
        filesTouched: parsed.filesTouched,
        summary: parsed.summary,
      };
    } catch (err: any) {
      return {
        output: '',
        stopReason: 'error',
        filesTouched: [],
        summary: err.message,
      };
    }
  }
}
