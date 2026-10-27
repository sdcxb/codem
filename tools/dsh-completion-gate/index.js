import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "completion-gate";
export const inject = ["sessionProjections", "agents"];

const attempts = new Map();

function pendingTodos(ctx, session) {
  const state = ctx.sessionProjections.stateOf(session, "todos");
  const todos = Array.isArray(state) ? state : state?.todos;
  if (!Array.isArray(todos)) return [];
  return todos.filter((todo) => todo?.status !== "completed");
}

function reminder(pending) {
  return [
    "[COMPLETION GATE] 任务还没有完成，禁止收尾。",
    "",
    "以下 todo 仍是 pending / in_progress：",
    ...pending.map((todo) => `- ${todo.content ?? todo.title ?? "(unnamed)"}`),
    "",
    "继续执行并逐项完成；全部完成后把 todo 标记为 completed，再给最终答复。",
  ].join("\n");
}

export function apply(ctx, config = {}) {
  const maxRounds = Number.isInteger(config.maxRounds) && config.maxRounds > 0 ? config.maxRounds : 3;

  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    if (event.data?.reason !== "completed") return;

    const pending = pendingTodos(ctx, session);
    if (pending.length === 0) {
      attempts.delete(session.id);
      return;
    }

    const count = (attempts.get(session.id) ?? 0) + 1;
    attempts.set(session.id, count);
    if (count > maxRounds) return;

    const agent = ctx.agents.get(session.id);
    if (!agent || typeof agent.followup !== "function") return;

    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: reminder(pending) }],
      }),
    );
  });
}
