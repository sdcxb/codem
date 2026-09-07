/**
 * @codem/computer-use — 电脑操作（Codex-style computer use，对标 EAC computer-user）
 *
 * 读屏 + 鼠标键盘自动化，Windows-only。零原生模块：
 * - capture.ps1 / input.ps1（内嵌于 scripts-content.ts，PowerShell + Win32）
 * - 经 executeCommand 起 powershell.exe 执行（Codem Rust 后端杀进程树兜底）
 *
 * 安全模型（用户决策：插件默认开启，工具默认「手动批准」）：
 * - mode: disabled | readonly | manual(默认) | auto
 * - readonly = 仅 screenshot/get_cursor_position/wait 可用
 * - manual = 副作用工具需会话批准（/computer 命令；approvedSessions 内存 Set）
 * - auto = LLM 自由调用
 * - 截图后「看图」：Codem vision-proxy 自动处理 image block（无需本地 OCR）；
 *   computer_see 工具把截图转 base64 image 交视觉模型理解（bbox 提示词）
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { executeCommand } from "../file-api";
import { CAPTURE_PS1, INPUT_PS1 } from "./scripts-content";
import type { ToolDef, ToolContext, ToolExecuteResult } from "../llm/tools";
import type { LLMMessage } from "../storage/message";
import { getLang } from "../i18n/lang";

export type ComputerMode = "disabled" | "readonly" | "manual" | "auto";

const MODES: ComputerMode[] = ["disabled", "readonly", "manual", "auto"];

/** 无副作用工具（任何模式下可用） */
const READONLY_TOOLS = new Set(["computer_screenshot", "computer_get_cursor_position", "computer_wait"]);

const SETTINGS_KEY = "codem-computer-user";
const NS = "codem-computer-user";

interface ComputerSettings {
  mode: ComputerMode;
  ai_can_change_mode: boolean;
  screenshot_dir: string;
  default_scale: number;
  typing_interval_ms: number;
  scroll_units: number;
}

const DEFAULTS: ComputerSettings = {
  mode: "manual",          // 用户决策：插件开 + 工具默认手动批准
  ai_can_change_mode: false,
  screenshot_dir: "",
  default_scale: 1,
  typing_interval_ms: 0,
  scroll_units: 1,
};

export function getComputerSettings(): ComputerSettings {
  try {
    return { ...DEFAULTS, ...(getSettingJSON<Partial<ComputerSettings>>(SETTINGS_KEY, {}) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setComputerMode(mode: ComputerMode): void {
  const cur = getComputerSettings();
  setSettingJSON(SETTINGS_KEY, { ...cur, mode });
}

// ========== 会话级批准（/computer 命令） ==========

/** 已批准会话集合（内存，重启失效——对标 EAC /computer toggle） */
const approvedSessions = new Set<string>();

export function approveSession(sessionId: string): boolean {
  if (approvedSessions.has(sessionId)) {
    approvedSessions.delete(sessionId);
    return false; // toggle off
  }
  approvedSessions.add(sessionId);
  return true; // toggle on
}

export function isSessionApproved(sessionId: string): boolean {
  return approvedSessions.has(sessionId);
}

// ========== PowerShell 执行 ==========

function b64(s: string): string {
  // UTF-8 base64（PS [Convert]::FromBase64String 解码后按 UTF8 读）
  return Buffer.from(s, "utf8").toString("base64");
}

export interface PsOut {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/**
 * 执行内嵌 PowerShell 脚本（capture/input），经 -Json <base64> 传参。
 * 脚本以临时文件落盘（避免命令行超长/编码问题），执行后删除。
 */
export async function runPs(script: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<PsOut> {
  // Tauri 环境：经 file-api writeFile 落临时脚本（浏览器无 Node fs）。
  // 脚本放系统临时目录（Windows %TEMP% 绝对路径），执行后删除。
  const { writeFile, deletePath } = await import("../file-api");
  const tmp = `${getTempDir()}\\cu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.ps1`;
  try {
    await writeFile(tmp, script);
    const jsonArg = b64(JSON.stringify(payload));
    const { stdout } = await executeCommand(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}" -Json "${jsonArg}"`,
      undefined,
      timeoutMs,
    );
    // 脚本输出单行 JSON（stdout 可能含 PS 警告前缀 → 取最后一行 JSON）
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed as PsOut;
      } catch { /* not json */ }
    }
    return { ok: false, error: `脚本无有效 JSON 输出: ${stdout.slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { await deletePath(tmp); } catch { /* ignore */ }
  }
}

/** 系统临时目录（浏览器环境经 Tauri env 或默认） */
function getTempDir(): string {
  try {
    const tauri = (window as any).__TAURI__;
    const env = tauri?.os?.platform ? process?.env?.TEMP : undefined;
    return env || (typeof process !== "undefined" && process.env?.TEMP) || "C:\\Windows\\Temp";
  } catch {
    return "C:\\Windows\\Temp";
  }
}

// ========== 模式门禁 ==========

/** 门禁：允许返回 void；拒绝抛错（manual 未批准带 awaitingApproval 标记） */
export function modeGate(toolName: string, ctx: ToolContext): void {
  const cfg = getComputerSettings();
  if (cfg.mode === "disabled") {
    throw new Error("电脑操作已禁用：请到「设置 → 电脑操作」切换模式（当前工具调用被拒）");
  }
  if (cfg.mode === "readonly" && !READONLY_TOOLS.has(toolName)) {
    throw new Error(`电脑操作只读模式：${toolName} 不允许执行，仅截图/读光标/等待可用`);
  }
  if (cfg.mode === "manual" && !READONLY_TOOLS.has(toolName)) {
    if (!isSessionApproved(ctx.sessionId)) {
      const e = new Error(
        "需要批准：当前为手动批准模式。请先对助手说「批准电脑操作」或在对话框输入 /computer 批准后重试（批准后本会话可用）。",
      ) as Error & { awaitingApproval?: boolean };
      e.awaitingApproval = true;
      throw e;
    }
  }
}

// ========== 工具工厂 ==========

const zh = () => getLang() === "zh";
const COORD_DESC = () => (zh() ? "相对多屏虚拟屏原点的像素坐标 [x, y]（原点 = computer_screenshot 返回的 virtual_offset）" : "Pixel coords [x,y] relative to the multi-monitor virtual screen origin (returned by computer_screenshot as virtual_offset)");

function out(title: string, output: string): ToolExecuteResult {
  return { title, output };
}

function simpleOut(title: string, v: PsOut): ToolExecuteResult {
  if (v.ok === false) return { title, output: `Error: ${v.error || "unknown"}` };
  const lines: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    if (k === "ok") continue;
    if (val === undefined || val === null) continue;
    lines.push(`${k}: ${JSON.stringify(val)}`);
  }
  return { title, output: lines.join("\n") };
}

// ---- screenshot ----

export function createComputerScreenshotTool(): ToolDef {
  return {
    id: "computer_screenshot",
    description: zh()
      ? "把整个虚拟屏（多显示器合并区）截成本地 PNG 并返回路径与尺寸。坐标系统一为相对虚拟屏原点的像素（返回 virtual_offset）。截屏后可让视觉模型看（本客户端自动处理图片）。"
      : "Capture the full virtual screen (multi-monitor union) to a local PNG; returns path/size and virtual_offset for pixel-coordinate mapping.",
    guidance: zh()
      ? "操作电脑前先截图了解当前屏幕；执行后再次截图验证结果。"
      : "Screenshot before operating to see the screen; screenshot again after to verify.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: zh() ? "输出路径（绝对或相对 cwd，可选）" : "Output path (optional)" },
        region: { type: "array", items: { type: "number" }, description: zh() ? "裁剪区 [x0,y0,x1,y1] 0..1 小数（可选）" : "Crop region [x0,y0,x1,y1] 0..1 (optional)" },
        scale: { type: "number", description: zh() ? "缩放 0.1..1（默认 1 原分辨率）" : "Scale 0.1..1 (default 1)" },
      },
      required: [],
    },
    async execute(args, ctx) {
      modeGate("computer_screenshot", ctx);
      const cfg = getComputerSettings();
      const outPath = (args.path as string) || `${cfg.screenshot_dir || process.env.TEMP || "."}\\codem-shot-${Date.now()}.png`;
      const v = await runPs(CAPTURE_PS1, {
        outPath,
        region: args.region ?? null,
        scale: (args.scale as number) ?? cfg.default_scale,
      });
      if (v.ok === false) return out("computer_screenshot", `Error: ${v.error}`);
      // 截图成功 → 把图片信息回给模型（路径 + 尺寸 + 虚拟屏偏移）
      return {
        title: "computer_screenshot",
        output:
          `截图已保存: ${v.path}\n` +
          `尺寸: ${v.width}×${v.height}\n` +
          `virtual_offset: [${(v.virtual_offset as number[]).join(", ")}]\n\n` +
          (zh()
            ? "如需理解画面内容，可将此截图作为图片发送（vision 通道自动处理），或用 computer_see。坐标为相对虚拟屏原点像素。"
            : "To understand the screen, send this screenshot as an image (auto vision) or use computer_see. Coords are pixels relative to the virtual origin."),
        metadata: { imagePath: String(v.path), width: v.width as number, height: v.height as number, virtual_offset: v.virtual_offset },
      };
    },
  };
}

// ---- click / type / keypress / scroll / drag / move_mouse / wait / get_cursor ----

// 各工具 schema 精确声明（见 psInputTool），统一走 INPUT_PS1 执行。

function psInputTool(spec: {
  id: string; descZh: string; descEn: string;
  props: Record<string, unknown>; required: string[];
  build: (args: Record<string, unknown>, cfg: ComputerSettings) => Record<string, unknown>;
  readonly?: boolean;
}): ToolDef {
  return {
    id: spec.id,
    description: zh() ? spec.descZh : spec.descEn,
    guidance: zh()
      ? "执行前先 computer_screenshot 定位，用视觉理解坐标，再操作；操作后截图验证。"
      : "Screenshot first to locate, understand coords via vision, then act; verify with a follow-up screenshot.",
    parameters: { type: "object", properties: spec.props, required: spec.required },
    async execute(args, ctx) {
      modeGate(spec.id, ctx);
      const cfg = getComputerSettings();
      const payload = spec.build(args as Record<string, unknown>, cfg);
      const v = await runPs(INPUT_PS1, payload);
      return simpleOut(spec.id, v);
    },
  };
}

const coordProp = () => ({ type: "array", items: { type: "number" }, description: COORD_DESC() });

export function createComputerInputTools(): ToolDef[] {
  return [
    psInputTool({
      id: "computer_click",
      descZh: "在 [x,y] 点击（click/right_click/double_click）",
      descEn: "Click at [x,y] (click/right_click/double_click)",
      props: { coordinate: coordProp(), action: { type: "string", enum: ["click", "right_click", "double_click"], description: "default click" } },
      required: ["coordinate"],
      build: (a) => ({ action: "click", coordinate: a.coordinate, button: a.action || "click" }),
    }),
    psInputTool({
      id: "computer_type",
      descZh: "输入文本（UTF-16，含中文）",
      descEn: "Type text (UTF-16, CJK supported)",
      props: { text: { type: "string" }, send_enter: { type: "boolean" } },
      required: ["text"],
      build: (a, cfg) => ({ action: "type", text: a.text, sendEnter: !!a.send_enter, typingIntervalMs: cfg.typing_interval_ms }),
    }),
    psInputTool({
      id: "computer_keypress",
      descZh: "组合键，如 [\"ctrl\",\"c\"]、[\"alt\",\"tab\"]",
      descEn: "Key combo, e.g. [\"ctrl\",\"c\"], [\"alt\",\"tab\"]",
      props: { keys: { type: "array", items: { type: "string" } } },
      required: ["keys"],
      build: (a) => ({ action: "keypress", keys: a.keys }),
    }),
    psInputTool({
      id: "computer_scroll",
      descZh: "在 [x,y] 滚轮（up/down/left/right）",
      descEn: "Scroll at [x,y] (up/down/left/right)",
      props: { coordinate: coordProp(), direction: { type: "string", enum: ["up", "down", "left", "right"] }, clicks: { type: "number" } },
      required: ["coordinate"],
      build: (a, cfg) => ({ action: "scroll", coordinate: a.coordinate, direction: a.direction || "down", clicks: (a.clicks as number) || cfg.scroll_units }),
    }),
    psInputTool({
      id: "computer_drag",
      descZh: "从 start 拖到 end（可选 hold_keys）",
      descEn: "Drag from start to end (optional hold_keys)",
      props: { start_coordinate: coordProp(), end_coordinate: coordProp(), hold_keys: { type: "array", items: { type: "string" } } },
      required: ["start_coordinate", "end_coordinate"],
      build: (a) => ({ action: "drag", start: a.start_coordinate, end: a.end_coordinate, holdKeys: a.hold_keys }),
    }),
    psInputTool({
      id: "computer_move_mouse",
      descZh: "移动光标（不点击）",
      descEn: "Move cursor without clicking",
      props: { coordinate: coordProp() },
      required: ["coordinate"],
      build: (a) => ({ action: "move_mouse", coordinate: a.coordinate }),
    }),
    psInputTool({
      id: "computer_wait",
      descZh: "等待 ms（让 UI 稳定）",
      descEn: "Wait ms (let UI settle)",
      props: { ms: { type: "number" } },
      required: ["ms"],
      build: (a) => ({ action: "wait", ms: a.ms }),
      readonly: true,
    }),
    psInputTool({
      id: "computer_get_cursor_position",
      descZh: "读取当前光标位置 [x,y]",
      descEn: "Read current cursor position [x,y]",
      props: {},
      required: [],
      build: () => ({ action: "get_cursor_position" }),
      readonly: true,
    }),
  ];
}

// ---- computer_see：截图 → 视觉模型理解（Codem vision 通道替代 EAC picturereader） ----

export function createComputerSeeTool(): ToolDef {
  return {
    id: "computer_see",
    description: zh()
      ? "分析一张截图/图片文件并返回结构化描述：布局、元素坐标（bbox）、文字 OCR、颜色。替代 EAC 的 picturereader 本地 OCR 链——走本客户端视觉模型通道。"
      : "Analyze a screenshot/image file and return structured description: layout, element bounding boxes, OCR text, colors. Uses the client's vision channel.",
    guidance: zh()
      ? "需要「看」屏幕时：先 computer_screenshot 拿路径 → computer_see 分析 → 得到元素坐标后 computer_click/type。"
      : "To 'see' the screen: computer_screenshot to get a path, then computer_see to analyze and get element coords, then click/type.",
    parameters: {
      type: "object",
      properties: {
        image_path: { type: "string", description: zh() ? "截图/图片路径（computer_screenshot 的输出 path）" : "Image path from computer_screenshot" },
        query: { type: "string", description: zh() ? "可选：具体要看什么（如「找到搜索框的坐标」）" : "Optional: what to look for (e.g. 'find the search box coords')" },
      },
      required: ["image_path"],
    },
    async execute(args, ctx) {
      modeGate("computer_see", ctx);
      const imgPath = args.image_path as string;
      try {
        // Tauri 读二进制为 base64（浏览器无 Node fs）
        const tauri = (window as any).__TAURI__;
        let b64img: string;
        if (tauri?.core?.invoke) {
          b64img = await tauri.core.invoke("read_file_base64", { path: imgPath });
        } else {
          // 测试/非 Tauri：跳过（无图可读）
          return out("computer_see", "Error: read_file_base64 需要 Tauri 环境");
        }
        // 经 vision-proxy：主模型支持 vision 则直接看；否则自动调视觉模型描述（OCR/布局）
        const { getVisionProxy } = await import("../llm/vision-proxy");
        const vp = getVisionProxy();
        const { getLLMEngine } = await import("../llm");
        const engine = getLLMEngine();
        const chatModel = engine.getDefaultModel();
        const chatProvider = engine.getDefaultProvider();
        const ext = imgPath.split(".").pop()?.toLowerCase();
        const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
        // 追加 query 提示（若提供），引导视觉模型给出坐标定位
        const q = (args.query as string) || "";
        const prompt: LLMMessage = {
          id: "computer-see",
          role: "user",
          content: [
            { type: "image", mediaType, data: b64img },
            ...(q ? [{ type: "text" as const, text: q + (zh() ? "（若涉及界面元素请给出大致像素坐标）" : " (if UI elements, give approximate pixel coords)") }] : []),
          ],
        };
        const result = await vp.processMessages([prompt], chatModel, chatProvider);
        // processMessages 返回 messages（image→text 替换）；取最后 user 文本作为描述
        const msgs = result.messages;
        let desc = "";
        for (let i = msgs.length - 1; i >= 0; i--) {
          const c = msgs[i].content;
          if (typeof c === "string" && c) { desc = c; break; }
          if (Array.isArray(c)) {
            const txt = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
            if (txt) { desc = txt; break; }
          }
        }
        return out("computer_see", desc
          ? (zh() ? `画面分析结果${q ? `（关注: ${q}）` : ""}:\n${desc}` : `Analysis${q ? ` (focus: ${q})` : ""}:\n${desc}`)
          : (zh() ? "未获得视觉描述（视觉模型不可用或图片无效）" : "No vision description obtained"));
      } catch (e) {
        return out("computer_see", `Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ---- set_mode ----

export function createComputerSetModeTool(): ToolDef {
  return {
    id: "computer_set_mode",
    description: zh()
      ? "修改电脑操作模式（disabled/readonly/manual/auto）。仅在设置允许 AI 改模式时可用。"
      : "Change computer-use mode (disabled/readonly/manual/auto). Only usable when settings allow AI to change mode.",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: MODES } },
      required: ["mode"],
    },
    async execute(args, ctx) {
      modeGate("computer_set_mode", ctx); // 至少按当前模式门禁
      const cfg = getComputerSettings();
      if (!cfg.ai_can_change_mode) {
        return out("computer_set_mode", zh() ? "被拒：设置未允许 AI 修改模式（设置 → 电脑操作 → AI 可修改模式）" : "Denied: AI mode-change not enabled in settings");
      }
      const mode = args.mode as ComputerMode;
      if (!MODES.includes(mode)) return out("computer_set_mode", `invalid mode: ${mode}`);
      setComputerMode(mode);
      return out("computer_set_mode", `mode → ${mode}`);
    },
  };
}

/** 注册全部 computer_* 工具（defer——低频高危工具不常驻 schema） */
export function registerComputerUseTools(register: (t: ToolDef) => void): void {
  const mark = (t: ToolDef): ToolDef => {
    t.shouldDefer = true;
    t.searchHint = "电脑操作：截屏/鼠标键盘自动化（读屏后操作桌面应用）——用户要求操作电脑/桌面/浏览器时使用";
    return t;
  };
  register(mark(createComputerScreenshotTool()));
  for (const t of createComputerInputTools()) register(mark(t));
  register(mark(createComputerSeeTool()));
  register(mark(createComputerSetModeTool()));
}

export { NS, SETTINGS_KEY };
