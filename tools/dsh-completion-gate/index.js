import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "completion-gate";
export const inject = ["sessionProjections"];

const attempts = new WeakMap();
const originalStep = AgentLoop.prototype.step;
let patched = false;

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
  if (patched) return;
  patched = true;
  const maxRounds = Number.isInteger(config.maxRounds) && config.maxRounds > 0 ? config.maxRounds : 3;

  /*
   * turn() does:
   *   const stepEnd = await this.step(decision);
   *   if (turnEnds === null || ...) turnEnds = stepEnd;
   * A completed stepEnd causes turn/end completed. Returning null keeps
   * turnEnds null, so the same turn continues with another step.
   */
  AgentLoop.prototype.step = async function completionGatedStep(decision) {
    const result = await originalStep.call(this, decision);
    if (result?.kind !== "completed") return result;

    const pending = pendingTodos(ctx, this.session);
    if (pending.length === 0) {
      attempts.delete(this.session);
      return result;
    }

    const count = (attempts.get(this.session) ?? 0) + 1;
    attempts.set(this.session, count);
    if (count > maxRounds) return result;

    this.inject(createUserMessage({
      content: [{ type: "text", text: reminder(pending) }],
    }));
    return null;
  };
}
