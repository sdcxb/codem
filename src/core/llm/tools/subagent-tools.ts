/**
 * 子智能体工具集 — 完全对标 DSH 的工具包结构：
 *
 * 1. `subagent` (对标 dsh-tool-subagent) — 委派任务给子智能体
 *    - run_in_background=true (默认): 启动可持续子智能体，立即返回 ID
 *    - run_in_background=false: 等待结果（foreground 一次性）
 *
 * 2. `report` (对标 dsh-tool-subagent-report) — 子智能体向父智能体汇报
 *    - 只在子智能体的工具集中注册
 *
 * 3. `send_message` (对标 dsh-tool-subagent-control) — 向后台子智能体发送消息
 *
 * 4. `interrupt_agent` (对标 dsh-tool-subagent-control) — 中断子智能体的当前轮次
 *
 * 5. `list_agents` (对标 dsh-tool-subagent-control/list-agents) — 列出后台子智能体
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from '../tools';
import type { SubagentRuntime } from '../../subagent/runtime';
import { getLang } from '../../i18n/lang';
import { formatSubagentReport, parseSubagentReport, type SubagentReport } from '../../subagent/report-contract';
// 本文件的工具声明 `timeoutMs: NO_TIMEOUT`（它们是长任务，或会等用户确认），
// 哨兵值必须在声明处可见。
import { NO_TIMEOUT } from '../tool-contract';

// ========== Runtime 引用 ==========

let runtime: SubagentRuntime | null = null;

export function setSubagentRuntime(rt: SubagentRuntime): void {
  runtime = rt;
}

function getRuntime(): SubagentRuntime {
  if (!runtime) {
    throw new Error('SubagentRuntime not initialized');
  }
  return runtime;
}

// ========== 1. subagent 工具 — 对标 dsh-tool-subagent ==========

/**
 * subagent 工具 — 对标 DSH tool-subagent
 *
 * 默认后台运行（continuable 模式），立即返回子智能体 ID。
 * 子智能体完成后，runtime 自动向父智能体推送 settlement 通知。
 * 设置 run_in_background=false 可等待结果。
 */
export function createSubagentTool(): ToolDef {
  const zh = getLang() === 'zh';
  return {
    id: 'subagent',
    contract: { sideEffectScope: "session", accessScope: "session", timeoutMs: NO_TIMEOUT, persistResult: false },
    description:
      zh
        ? '将独立任务委派给子智能体（在独立上下文中工作的子 agent），以卸载聚焦的、独立的工作 — '
        + '研究、范围化实现、分析 — 避免消耗当前对话的上下文。子智能体返回其结果而非中间步骤。'
        + '给它完整、独立的 prompt：它看不到当前对话。'
        + ' 此工具默认在后台运行，立即返回子智能体 ID，并保持子智能体对话可用于后续轮次。'
        + ' 当运行结束时，runtime 会向父智能体发送包含其结果和最终消息的通知；'
        + '使用 send_message 启动同一子智能体对话的后续轮次。'
        + ' 仅当下一步操作依赖结果时才设置 run_in_background: false。'
        : 'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
        + 'to offload focused, independent work — research, a scoped '
        + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
        + 'returns its result, not its intermediate steps. Give it a '
        + 'complete, standalone prompt: it does not see this conversation.'
        + ' This tool runs in the background by default, immediately returns a durable subagent id, '
        + 'and keeps the child conversation available for later turns. When that run settles, the runtime '
        + 'sends the parent a notice containing its outcome and any final assistant message; '
        + '`send_message` starts a later turn in the same child conversation. '
        + 'Set `run_in_background: false` only when your next action depends on receiving the result.',
    guidance:
      zh
        ? '默认在后台使用 subagent。在同一条助手消息中一起启动独立委派，并在它们运行时继续有用的工作。'
        + ' 仅当下一步操作依赖该子智能体的结果时才设置 run_in_background: false。'
        + ' 当后台运行结束时，runtime 会向你发送包含其结果和最终消息的通知。'
        : 'Use subagent in the background by default. Start independent delegations together in one assistant '
        + 'message and continue useful work while they run. Set `run_in_background: false` only when your next '
        + 'action depends on that subagent\'s result. When a background run settles, the runtime sends you a '
        + 'notice containing its outcome and any final assistant message.'
        + ' Use this only for a self-contained subtask whose intermediate output you do NOT need. If the user must be able to open or take over the work, use handoff_to_new_session instead; if the work belongs to an existing session, use delegate_to_session.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: zh
            ? '委派任务的简短描述（3-5 个词），用于显示。'
            : 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: zh
            ? '子智能体的完整、独立任务。它不共享当前对话的上下文，所以包含它需要的一切。'
            : 'The complete, self-contained task for the subagent. It does not share this '
            + 'conversation\'s context, so include everything it needs.',
        },
        agent_id: {
          type: 'string',
          enum: ['general', 'explore', 'build', 'plan'],
          description: zh
            ? '子智能体的 agent 类型。general=通用, explore=探索分析, build=构建实现, plan=规划。默认为 general。'
            : 'Agent type for the subagent. general=general purpose, explore=research/analysis, '
            + 'build=implementation, plan=planning. Defaults to general.',
        },
        profile_id: {
          type: 'string',
          description: zh
            ? '可选：AgentProfile ID，用于注入持久化身份信息（identity/domain/scope）。'
            : 'Optional: AgentProfile ID for persistent identity injection (identity/domain/scope).',
        },
        run_in_background: {
          type: 'boolean',
          description: zh
            ? '是否在后台运行并立即返回子智能体 ID。默认为 true。'
            + '设为 false 可等待结果（当下一步操作依赖结果时）。'
            : 'Whether to run in the background and return a durable subagent id immediately. '
            + 'Defaults to true. Set false to wait for the result when your next action depends on it.',
        },
      },
      required: ['description', 'prompt'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const description = args.description as string;
      const prompt = args.prompt as string;
      const runInBackground = args.run_in_background !== false; // 默认 true

      const agentId = (args.agent_id as string) || 'general'; // LLM 可指定 agent 类型
      const profileId = (args.profile_id as string) || undefined; // 可选 AgentProfile ID
      const cwd = ctx.cwd;

      try {
        if (runInBackground) {
          // 可持续后台模式 — 对标 DSH startContinuable
          const started = await rt.startContinuable({
            provider: 'spawn',
            label: description,
            request: {
              prompt,
              parentSessionId: ctx.sessionId,
              cwd,
              agentId,
              profileId,
            },
            signal: ctx.abort,
          });

          return {
            title: `subagent: ${description}`,
            output: zh
              ? `已启动后台子智能体 ${started.childId}。当它完成时你会自动收到通知。`
              + `使用 send_message 向它发送后续消息。`
              : `Started subagent ${started.childId} in the background. You will be notified when it finishes. `
              + `Use send_message to send it follow-up messages.`, isError: false,
            metadata: { subagentId: started.childId },
          };
        } else {
          // 前台等待模式 — 对标 DSH start (one-shot)
          const run = await rt.start('spawn', {
            label: description,
            prompt,
            parentSessionId: ctx.sessionId,
            cwd,
            agentId,
            profileId,
            signal: ctx.abort,
          });

          const result = await run.result;
          await run.dispose();

          return {
            title: `subagent: ${description}`,
            output: result.stopReason === 'completed'
              ? result.output
              : `${result.stopReason}: ${result.summary}\n${result.output}`,
            isError: result.stopReason !== 'completed',
            metadata: { runId: run.id, stopReason: result.stopReason },
          };
        }
      } catch (error: any) {
        return {
          title: `subagent: ${description}`,
          output: `Error: ${error.message}`, isError: true,
        };
      }
    },
  };
}

// ========== 2. report 工具 — 对标 dsh-tool-subagent-report ==========

/**
 * report 工具 — 对标 DSH tool-subagent-report
 *
 * 只在子智能体的工具集中注册（不在主 agent 中注册）。
 * 子智能体通过此工具主动向父智能体汇报内容。
 */
export function createReportTool(): ToolDef {
  const zh = getLang() === 'zh';
  return {
    id: 'report',
    contract: { sideEffectScope: "session", accessScope: "session", timeoutMs: NO_TIMEOUT, persistResult: false },
    description:
      zh
        ? '向启动你的 agent 汇报结构化结果。完成前必须调用一次；调用会被 runtime 校验，坏报告会被拒绝并返回错误。'
        + 'status/summary 必填；verified 只写你实际执行过的命令，调用方给的结果放 source=caller。'
        + '更早调用可用于汇报会改变该 agent 下一步操作的进展或发现。'
        : 'Report a structured result to the agent that started you. Call once before finishing; the runtime validates it '
        + 'and rejects malformed reports. status/summary are required; verified must contain commands you actually ran, '
        + 'use source=caller for results supplied by the caller.',
    guidance:
      zh
        ? '在完成前使用 report 工具汇报结构化结果：status、summary 必填；verified 只写本 agent 实际跑过的命令。'
        + '调用方给的结果只能放 source=caller，不能当成自己的验证。汇报不会结束你的轮次。'
        : 'Deliver a structured report with the report tool before you finish: status and summary are required. '
        + 'verified must contain commands you actually ran; results supplied by the caller use source=caller. '
        + 'Reporting never ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['success', 'partial', 'failed', 'blocked', 'unknown'],
          description: zh ? '最终状态；success 不等于已验证' : 'Final status; success does not mean verified',
        },
        summary: { type: 'string', description: zh ? '一句话结论（<=300 字）' : 'One-line outcome (<=300 chars)' },
        changed: {
          type: 'array',
          items: { type: 'string' },
          description: zh ? '改动的文件路径；只读任务留空' : 'Changed file paths; empty for read-only tasks',
        },
        verified: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              ok: { type: 'boolean' },
              source: { type: 'string', enum: ['agent', 'caller'] },
              evidence: { type: 'string' },
            },
            required: ['command', 'ok', 'source'],
          },
          description: zh ? '实际执行/核对过的命令；调用方给的结果必须标 source=caller' : 'Commands actually run/checked; caller-supplied results must use source=caller',
        },
        unverified: { type: 'array', items: { type: 'string' }, description: zh ? '没执行的检查及原因' : 'Checks not run and why' },
        open: { type: 'array', items: { type: 'string' }, description: zh ? '需要父 agent 决策或补做的事' : 'Items the parent must decide or follow up' },
        output: { type: 'string', description: zh ? '可选：给父 agent 的自足细节' : 'Optional: self-contained detail for the parent' },
      },
      required: [],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const childId = ctx.sessionId;
      const hasStructured =
        args.status !== undefined ||
        args.summary !== undefined ||
        Array.isArray(args.verified) ||
        Array.isArray(args.changed) ||
        Array.isArray(args.unverified) ||
        Array.isArray(args.open);

      let report: SubagentReport | undefined;
      let content = String(args.output ?? '').trim();
      if (hasStructured) {
        const parsed = parseSubagentReport({
          status: args.status,
          summary: args.summary,
          changed: args.changed,
          verified: args.verified,
          unverified: args.unverified,
          open: args.open,
          output: args.output,
        });
        if (!parsed.ok || !parsed.report) {
          return {
            title: 'Report rejected',
            output: zh
              ? '报告未提交：' + (parsed.error || '格式错误') + '。请补齐 status/summary；verified 项必须带 command/ok/source。'
              : 'Report not submitted: ' + (parsed.error || 'invalid format') + '. Provide status/summary; each verified item needs command/ok/source.',
            isError: true,
          };
        }
        report = parsed.report;
        content = formatSubagentReport(report);
      }
      if (!content) {
        return {
          title: 'Report rejected',
          output: zh ? '报告未提交：结构化字段和 output 至少提供一个。' : 'Report not submitted: provide structured fields or output.',
          isError: true,
        };
      }

      try {
        const messageId = await rt.reportFrom(childId, content, {
          delivery: 'wakeup',
          signal: ctx.abort,
          report,
        });

        return {
          title: 'report',
          output: zh
            ? '汇报已被启动你的 agent 接受为消息 ' + messageId
            : 'Report accepted by the agent that started you as message ' + messageId,
          isError: false,
          metadata: { messageId, report },
        };
      } catch (error: any) {
        return {
          title: 'report',
          output: zh ? '汇报失败: ' + error.message : 'Report failed: ' + error.message,
          isError: true,
        };
      }
    },
  };
}

// ========== 3. send_message 工具 — 对标 dsh-tool-subagent-control ==========

export function createSendMessageTool(): ToolDef {
  const zh = getLang() === 'zh';
  return {
    id: 'send_message',
    contract: { sideEffectScope: "session", accessScope: "session", timeoutMs: NO_TIMEOUT, persistResult: false },
    description:
      zh
        ? '通过子智能体 ID 向后台子智能体发送消息，继续同一对话。'
        + '它成为子智能体的下一轮：如果它仍在工作，消息会等待其当前轮次完成，'
        + '所以它无法重定向正在进行的工作。此调用不返回子智能体的答案 — '
        + '只确认消息已送达 — 所以用它给予更多工作。失败意味着消息未送达。'
        : 'Send a message to a background subagent by its subagent id, continuing the same conversation. It '
        + 'becomes the subagent\'s next turn: if it is still working, the message waits until its current turn '
        + 'finishes, so it cannot redirect work already underway. This call returns no answer from the '
        + 'subagent — only confirmation that the message was delivered — so use it to give it more work. A '
        + 'failure means the message was NOT delivered.',
    parameters: {
      type: 'object',
      properties: {
        subagent_id: {
          type: 'string',
          description: zh
            ? '后台子智能体启动时返回的子智能体 ID。'
            : 'The subagent id returned when the background subagent was started.',
        },
        message: {
          type: 'string',
          description: zh
            ? '要发送给子智能体的消息。'
            : 'The message to deliver to the subagent.',
        },
      },
      required: ['subagent_id', 'message'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const subagentId = args.subagent_id as string;
      const message = args.message as string;

      try {
        const messageId = await rt.followup(
          ctx.sessionId,
          subagentId,
          message,
          { signal: ctx.abort },
        );

        return {
          title: `send_message: ${subagentId}`,
          output: zh
            ? `消息已作为子智能体 ${subagentId} 的下一轮排队`
            : `message queued as the next turn for subagent ${subagentId}`, isError: false,
          metadata: { messageId },
        };
      } catch (error: any) {
        return {
          title: `send_message: ${subagentId}`,
          output: zh
            ? `消息未送达: ${error.message}`
            : `Message NOT delivered: ${error.message}`, isError: true,
        };
      }
    },
  };
}

// ========== 4. interrupt_agent 工具 — 对标 dsh-tool-subagent-control ==========

export function createInterruptAgentTool(): ToolDef {
  const zh = getLang() === 'zh';
  return {
    id: 'interrupt_agent',
    contract: { sideEffectScope: "session", accessScope: "session", timeoutMs: NO_TIMEOUT, persistResult: false },
    description:
      zh
        ? '通过 agent ID 请求取消后台 agent 的当前轮次。目标可以是你的直接子智能体或更深的 agent。'
        + '只停止当前轮次：已排队的消息保持等待，已启动的 agent 继续运行，'
        + 'agent 本身可用于后续操作。此调用在停止请求被接受后立即返回，'
        + '所以目标可能短暂地继续运行；中断已完成的 agent 是被接受的 no-op。'
        : 'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
        + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
        + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
        + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
        + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
        + 'an accepted no-op.',
    parameters: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: zh
            ? '要中断的运行 agent 的 ID。'
            : 'The agent id of the running agent to interrupt.',
        },
      },
      required: ['agent_id'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const agentId = args.agent_id as string;

      try {
        rt.interrupt(agentId, {
          kind: 'ancestor',
          callerSessionId: ctx.sessionId,
        });

        return {
          title: `interrupt_agent: ${agentId}`,
          output: zh
            ? `已请求中断 agent ${agentId}`
            : `interrupt requested for agent ${agentId}`, isError: false,
          metadata: { accepted: true },
        };
      } catch (error: any) {
        return {
          title: `interrupt_agent: ${agentId}`,
          output: zh
            ? `中断失败: ${error.message}`
            : `Interrupt failed: ${error.message}`, isError: true,
        };
      }
    },
  };
}

// ========== 5. list_agents 工具 — 对标 dsh-tool-subagent-control/list-agents ==========

export function createListAgentsTool(): ToolDef {
  const zh = getLang() === 'zh';
  return {
    id: 'list_agents',
    contract: { readOnly: true, accessScope: "session", timeoutMs: NO_TIMEOUT, persistResult: false },
    description:
      zh
        ? '按持久 ID 和标签列出你的可持续后台子智能体。'
        + '用它来回忆你启动了哪些子智能体，而不是轮询完成状态 — 完成时你会被通知。'
        + '状态来自实时注册表：running 表示正在工作，idle 表示已加载但轮次间空闲，'
        + 'ready 表示只在存储中存在 — 可恢复、非终结、也不是等待收集的结果。'
        + 'send_message 可在同一对话中启动新轮次。'
        : 'List your continuable background subagents by durable id and label. Use it to recall which ones '
        + 'you started, not to poll for completion — you are told when one finishes. Status comes from the live '
        + 'registry: running means the agent is working right now, idle means it is loaded but between turns '
        + '(it may be waiting on agents it started), and ready means it exists only in storage — resumable, not '
        + 'terminal, and not a result waiting to be collected; a `send_message` starts a new turn on the same '
        + 'conversation, and a direct child remains a `send_message` candidate in every status. The snapshot is not a delivery '
        + 'promise — `send_message` performs the authoritative check and may still fail.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const entries = rt.listChildren(ctx.sessionId);

      const output = entries.length === 0
        ? (zh ? '(无子智能体)' : '(no subagents)')
        : entries.map(entry =>
            `${entry.id} [${entry.status}] — ${entry.label}`
          ).join('\n');

      return {
        title: 'list_agents',
        output,
        isError: false,
        metadata: { count: entries.length },
      };
    },
  };
}
