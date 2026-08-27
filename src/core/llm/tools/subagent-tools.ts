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
        + 'notice containing its outcome and any final assistant message.',
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
              + `Use send_message to send it follow-up messages.`,
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
            metadata: { runId: run.id, stopReason: result.stopReason },
          };
        }
      } catch (error: any) {
        return {
          title: `subagent: ${description}`,
          output: `Error: ${error.message}`,
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
    description:
      zh
        ? '向启动你的 agent 汇报选定的内容。在完成前调用一次，给出自足的最终结果；'
        + '更早调用可用于汇报会改变该 agent 下一步操作的进展或发现。'
        + '该 agent 共享你的工作空间但不会自动收到你的记录、工具输出或推理，'
        + '所以完成工作本身不是结果。汇报不会结束你的轮次或完成你的工作，'
        + '只有你的直接父智能体会收到它。调用失败可能仍然已经到达，所以不要盲目重试。'
        : 'Report selected content to the agent that started you. Call this once before you finish, with a '
        + 'self-contained final result, and earlier for progress or findings that change what that agent does '
        + 'next. That agent shares your workspace but does not automatically receive your transcript, tool '
        + 'output, or reasoning, so finishing your work is not itself a result. Reporting does not end your '
        + 'turn or finish your work, and only your direct parent receives it. A failed call may still have '
        + 'arrived, so do not blindly repeat it.',
    guidance:
      zh
        ? '在完成前使用 report 工具汇报结果：调用一次给出自足的答案。'
        + '启动你的 agent 共享你的工作空间但不会自动收到你的记录、工具输出或推理，'
        + '所以像 "完成" 这样的结束语让它什么也用不了。'
        + '更早也汇报任何会改变该 agent 下一步操作的部分发现；汇报不会结束你的轮次。'
        : 'Deliver your result with the report tool before you finish: call it once with a self-contained '
        + 'answer. The agent that started you shares your workspace but does not automatically receive your '
        + 'transcript, tool output, or reasoning, so a closing remark such as "done" leaves it nothing it can '
        + 'use. Report earlier as well whenever a partial finding changes what that agent should do next; '
        + 'reporting never ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: zh
            ? '给父智能体的可操作内容；总结结论并引用相关的共享路径。'
            : 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
        },
      },
      required: ['output'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      const rt = getRuntime();
      const content = args.output as string;

      try {
        // ctx.sessionId 直接就是 childId — 不再有多重 sub- 前缀
        // runtime.executeContinuable 现在直接使用 activation.childId 作为 sessionId
        const childId = ctx.sessionId;

        const messageId = await rt.reportFrom(childId, content, {
          delivery: 'wakeup',
          signal: ctx.abort,
        });

        return {
          title: 'report',
          output: zh
            ? `汇报已被启动你的 agent 接受为消息 ${messageId}`
            : `report accepted by the agent that started you as message ${messageId}`,
          metadata: { messageId },
        };
      } catch (error: any) {
        return {
          title: 'report',
          output: zh
            ? `汇报失败: ${error.message}`
            : `Report failed: ${error.message}`,
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
            : `message queued as the next turn for subagent ${subagentId}`,
          metadata: { messageId },
        };
      } catch (error: any) {
        return {
          title: `send_message: ${subagentId}`,
          output: zh
            ? `消息未送达: ${error.message}`
            : `Message NOT delivered: ${error.message}`,
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
            : `interrupt requested for agent ${agentId}`,
          metadata: { accepted: true },
        };
      } catch (error: any) {
        return {
          title: `interrupt_agent: ${agentId}`,
          output: zh
            ? `中断失败: ${error.message}`
            : `Interrupt failed: ${error.message}`,
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
        metadata: { count: entries.length },
      };
    },
  };
}
