/**
 * `stack_market` —— 让用户/模型直接使用真实的 stack 市场（列包 / 装包）。
 *
 * 市场本身不是新服务：索引是仓库里的 `stacks/index.json`（HTTPS），
 * 技能从既有真实技能市场（GitHub/ClawHub/Skills.sh/SkillHub）解析并安装。
 */
import type { ToolDef, ToolExecuteResult, ToolContext } from "../llm/tools";
import { fetchStackIndex, installStackFromMarket } from "./stack-market";

export function createStackMarketTool(): ToolDef {
  return {
    id: "stack_market",
    contract: {
      sideEffectScope: "system",
      accessScope: "system",
      /** 结果契约：list/install 两种形状都声明（新工具必须顺手声明，见 output-schema 棘轮） */
      outputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          stacks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                version: { type: "string" },
                description: { type: "string" },
                skills: { type: "array", items: { type: "string" } },
              },
              required: ["name", "version", "skills"],
              additionalProperties: false,
            },
          },
          result: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              installed: { type: "array", items: { type: "string" } },
              missing: { type: "array", items: { type: "string" } },
              failed: {
                type: "array",
                items: {
                  type: "object",
                  properties: { name: { type: "string" }, error: { type: "string" } },
                  required: ["name", "error"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "version", "installed", "missing", "failed"],
            additionalProperties: false,
          },
          error: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    guidance:
      "Use stack_market to list or install a skill pack (stack) from the real market. " +
      "action=list needs no name; action=install requires the exact stack name. " +
      "Skills inside the stack are resolved from the existing skill market sources (GitHub/ClawHub/Skills.sh/SkillHub).",
    description:
      "List or install Codem stacks (skill packs). A stack is a named set of skills published in stacks/index.json; " +
      "installing resolves each skill from the real skill market and reports installed/missing/failed.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "install"], description: "list stacks or install one by name" },
        name: { type: "string", description: "stack name (required for install)" },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const action = String(args.action ?? "");
      if (action === "list") {
        const stacks = await fetchStackIndex();
        if (stacks.length === 0) {
          return { title: "stack_market: 0 stacks", output: "市场里暂时没有 stack。", isError: false, value: { action: "list", stacks: [] } };
        }
        const lines = stacks.map((s) => `- ${s.name}@${s.version}${s.description ? ` — ${s.description}` : ""}（技能：${s.skills.join(", ")}）`);
        return { title: `stack_market: ${stacks.length} stacks`, output: lines.join("\n"), isError: false, value: { action: "list", stacks } };
      }
      if (action === "install") {
        const name = String(args.name ?? "").trim();
        if (!name) return { title: "stack_market: 缺少 name", output: "install 需要 name 参数。", isError: true, value: { action: "install", error: "name required" } };
        const r = await installStackFromMarket(name);
        const lines = [
          `stack ${r.name}@${r.version}`,
          `installed: ${r.installed.length ? r.installed.join(", ") : "（无）"}`,
          `missing: ${r.missing.length ? r.missing.join(", ") : "（无）"}`,
          `failed: ${r.failed.length ? r.failed.map((f) => `${f.name} (${f.error})`).join(", ") : "（无）"}`,
        ];
        return {
          title: `stack_market: ${r.name}`,
          output: lines.join("\n"),
          isError: r.failed.length > 0 || r.missing.length > 0,
        };
      }
      return { title: "stack_market: 未知 action", output: `未知 action：${action}`, isError: true, value: { action, error: "unknown action" } };
    },
  };
}
