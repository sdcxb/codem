import { useEffect, useState, useRef, useCallback, lazy, Suspense } from "react";
import { createPortal } from "react-dom";

// D1-4: 全局错误边界 — 捕获未处理的同步错误和 Promise rejection
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e: ErrorEvent) => {
    console.error('[Global Error]', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    console.error('[Unhandled Rejection]', e.reason);
  });
}

// ====== Cordis 插件系统初始化（P4.3） ======
// 创建全局 Cordis Context 并加载独立 Provider 插件。
// 所有核心服务（LLM、Tools、Session 等）通过独立 Provider 注册为可替换的服务。
import { Context } from "./core/cordis/src/index.ts";
import type { Fiber } from "./core/cordis/src/fiber.ts";
import { SlotsService } from "./core/slots/index.ts";
// YAML 声明式配置加载器（对标 DSH cordis.patch.yml）
import { loadFromEntries, mergeYamlEntries } from "./core/plugin-loader/yaml-loader.ts";
// @ts-ignore — Vite ?raw import
import baseYml from "../config/codem.base.yml?raw";
// @ts-ignore — Vite ?raw import
import desktopYml from "../config/codem.desktop.yml?raw";
import { setActiveContext } from "./core/consumer";
import { SlotBridge, SlotListBridge } from "./core/slots/SlotBridge";

// 全局 Cordis Context（App 生命周期内唯一）
let _codemCtx: Context | null = null;
let _codemCtxPromise: Promise<Context> | null = null;

async function getCordisContext(): Promise<Context> {
  if (_codemCtx) return _codemCtx;
  if (_codemCtxPromise) return _codemCtxPromise;
  console.log('[Cordis] getCordisContext started');

  _codemCtxPromise = (async () => {
  const ctx = new Context();
  console.log('[Cordis] Context created');

  // ====== 对标 DSH boot() 流程 ======
  // 1. 安装 Slot Registry Service（基础 UI 槽位系统）
  ctx.plugin(SlotsService as any);
  console.log('[Cordis] SlotsService loaded');

  // 2. 注册内置插件到 PluginLoader 注册表
  const { registerBuiltinPlugins } = await import("./core/plugin-loader/builtin-registry.ts");
  registerBuiltinPlugins();
  console.log('[Cordis] registerBuiltinPlugins done');

  // 2.5. 注册 LLMEngine 为 Cordis 服务。
  //    必须在 YAML 加载之前完成，因为大量插件声明了 inject: [llmEngine]，
  //    它们在 loadFromEntries 时就需要 ctx.get('llmEngine') 返回有效实例。
  //    如果在 YAML 加载之后才 provide，这些插件会永远 PENDING。
  try {
    const { getLLMEngine } = await import("./core/llm/index.ts");
    const engine = getLLMEngine(ctx);
    console.log('[Cordis] getLLMEngine succeeded, engine:', !!engine);
    ctx.provide('llmEngine', engine);
    console.log('[Cordis] llmEngine service provided (pre-YAML)');
  } catch (e: any) {
    console.error('[Cordis] getLLMEngine failed:', e);
    // 引擎创建失败时仍提供错误消息给用户
    try {
      ctx.provide('llmEngine', {
        getDefaultProvider: () => 'none',
        getDefaultModel: () => 'none',
        providers: { get: () => undefined },
        process: async function* () {
          yield { type: 'error', content: `[Engine Init Error] ${e?.message || e}` } as any;
        },
        abort: () => {},
        updateConfig: () => {},
        setProviderConfig: () => {},
        buildSystemPrompt: () => '',
      });
    } catch (e2) {
      console.warn('[Cordis] llmEngine fallback provide failed:', e2);
    }
  }

  // 3. 从 YAML 声明式配置加载（对标 DSH cordis.patch.yml）
  //    合并 base + desktop bundle，按条件过滤、拓扑排序后加载
  const mergedEntries = mergeYamlEntries(baseYml, desktopYml);
  const yamlResult = loadFromEntries(ctx, mergedEntries);
  console.log(`[Cordis] YAML loader: ${yamlResult.loaded.length} loaded, ${yamlResult.skipped.length} skipped`);

  // 4. 等待所有 fiber 就绪（对标 DSH ctx.get('loader')?.await()）
  await new Promise(resolve => setTimeout(resolve, 0));
  console.log('[Cordis] microtask flush done, collecting fibers...');
  try {
    const fibers: Fiber[] = [];
    ctx.registry.forEach((runtime: any) => {
      for (const fiber of runtime.fibers) {
        fibers.push(fiber);
      }
    });
    console.log(`[Cordis] collected ${fibers.length} fibers, awaiting...`);
    if (fibers.length > 0) {
      const awaitWithTimeout = (f: Fiber) => {
        const p = f.await ? f.await() : Promise.resolve();
        return Promise.race([
          p,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`fiber ${f.name} await timeout`)), 5000))
        ]).catch(err => { console.warn(`[Cordis] fiber await failed: ${f.name}`, err); });
      };
      await Promise.allSettled(fibers.map(awaitWithTimeout));
    }
  } catch (err) {
    console.warn('[Cordis] Error while waiting for fibers:', err);
  }

  // 5. fail-loud 验证：对标 DSH assertEntriesActivated
  //    检查所有 fiber 是否 ACTIVE，PENDING/FAILED 的会抛出错误
  try {
    const { assertActivated } = await import("./core/plugin-loader/yaml-loader.ts");
    await assertActivated(ctx, 'codem');
    console.log('[Cordis] assertActivated passed — all fibers ACTIVE');
  } catch (err: any) {
    // 不终止启动，但明确报告问题（桌面应用不能直接 exit(1)）
    console.error('[Cordis] assertActivated FAILED:', err.message);
  }

  // 6. llmEngine 已在步骤 2.5（YAML 加载前）注册到 Context。
  //    mimoAuth 现在通过 YAML 插件 @codem/mimo-auth 注册，不再在此直接 provide。
  //    如果 YAML 加载失败，getCtxService('mimoAuth') 会返回 null，调用方已有 null 检查。

  // 7. 对标 DSH boot() 的时序：在 YAML 加载和 assert 之后立即设置 active context。
  //    这样后续的 dsh-compat、PluginLoader、UI 插件加载时，
  //    consumer 包中的 tryGetCtx() 可以立即返回有效 ctx，
  //    SlotBridge 的 useCtxReady 可以立即触发，无需轮询等待。
  setActiveContext(ctx);
  console.log('[Cordis] setActiveContext done');

  try {
    // 加载 dsh 兼容适配层（使 dsh 插件可以在 Codem 运行时中加载）
    console.log('[Cordis] loading dsh-compat...');
    const { dshCompatPlugin } = await import("./core/dsh-compat/index.ts");
    ctx.plugin(dshCompatPlugin as any);
    console.log('[Cordis] dsh-compat loaded');

    // === P6: 接入 PluginLoader + UI 插件 ===
    console.log('[Cordis] loading PluginLoader...');
    const { PluginLoader } = await import("./core/plugin-loader/index.ts");
    const { loadUIPlugins } = await import("./core/ui-plugins/index.ts");
    console.log('[Cordis] PluginLoader imported');
    // registerBuiltinPlugins 已在上方 YAML 加载前完成
    // PluginLoader 只做元数据发现（不重复加载已通过 YAML 加载的插件）
    const loader = new PluginLoader(ctx);
    console.log('[Cordis] loader.scan()...');
    await loader.scan();
    console.log('[Cordis] loader.scan() done');
    // 不调用 loader.load() — 所有插件已通过 YAML 声明式加载器加载
    // 加载所有 UI 插件包（注册到 Slot Registry）
    loadUIPlugins(ctx);
    console.log('[Cordis] loadUIPlugins done');

    // 等待 UI 插件 fiber 完成激活，确保 slot 注册在 React 渲染前完成。
    // Cordis fiber 的 _reload 在 await Promise.resolve() 后才执行 apply()，
    // 如果不等待，SlotBridge 可能在 UI 插件注册前渲染，显示 fallback 横幅。
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const uiFibers: Fiber[] = [];
      ctx.registry.forEach((runtime: any) => {
        for (const fiber of runtime.fibers) {
          // 只等待新注册的 fiber（state 非 DISPOSED 且有 inertia）
          if (fiber.inertia) {
            uiFibers.push(fiber);
          }
        }
      });
      if (uiFibers.length > 0) {
        // 对标 DSH assertEntriesActive：等待 fiber 完成但加超时，
        // 避免 fiber await() 永不 resolve 导致整个启动卡死
        const awaitWithTimeout = (f: Fiber) => {
          const p = f.await ? f.await() : Promise.resolve();
          return Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`UI fiber ${f.name} await timeout`)), 10000))
          ]).catch(err => { console.warn(`[Cordis] UI fiber await failed: ${f.name}`, err); });
        };
        await Promise.allSettled(uiFibers.map(awaitWithTimeout));
        const failed = uiFibers.filter(f => f.state === 3 /* FAILED */);
        if (failed.length > 0) {
          console.warn(`[Cordis] ${failed.length} UI fibers FAILED:`, failed.map(f => f.name));
        }
      }
    } catch (err) {
      console.warn('[Cordis] Error while waiting for UI fibers:', err);
    }
  } catch (err) {
    console.error("[Cordis] Failed to load optional plugins (dsh-compat/plugin-loader/ui-plugins):", err);
    // 不抛出 — 核心 Provider 已注册，Context 仍可用
  }

  _codemCtx = ctx;
  console.log('[Cordis] getCordisContext completed successfully');
  return ctx;
  })();

  return _codemCtxPromise;
}
// ====== Cordis 插件系统初始化结束 ======
import { RefreshCw, X, MessageSquare, Terminal, BookOpen, Save, FolderOpen, PencilLine, Trash2, CheckCircle, Menu, Search, Activity, GitBranch, Gamepad2 } from "lucide-react";
// 子智能体任务（任务管理「子智能体」页签）：ESM 环境不能用 require()，必须静态导入 + 订阅
import { getSubagentRuntime } from "./core/subagent/index";
import type { SubagentTask } from "./core/subagent/subagent";
import { readRendererCrashRecord, clearRendererCrashRecord } from "./components/AppErrorBoundary";
import { TooltipProvider } from "./components/ui/tooltip";
import { TitleBar } from "./components/TitleBar";
import { BootSplash } from "./components/BootSplash";
import { WorkspaceBackdrop } from "./components/WorkspaceBackdrop";
import { ToastContainer } from "./components/ToastNotification";
import { ChatPanel } from "./components/ChatPanel";
import { FileLinkContextMenu } from "./components/FileLinkContextMenu";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { FileExplorer } from "./components/FileExplorer";
import { FileEditor } from "./components/FileEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProjectManager } from "./components/ProjectManager";
import { ConfigEditor } from "./components/ConfigEditor";
import { BootstrapWizard } from "./components/BootstrapWizard";
import type { CollaborationMode } from "./core/agent/agent";
import { getEffectiveSecurityMode, type SecurityMode } from "./core/permission/security-mode";
import { tryGetCtx } from "./core/consumer";
import { PermissionDialog, getToolDescription } from "./components/PermissionDialog";
import { DecisionTray, type ApprovalRequest } from "./components/DecisionTray";
import { RightSidebar } from "./components/RightSidebar";
import { Drawer } from "./components/Drawer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { NeedsYouPanel } from "./components/NeedsYouPanel";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { McpManager } from "./components/McpManager";
import { PluginManager } from "./components/PluginManager";
import { SkillManager } from "./components/SkillManager";
import { MemoryManager } from "./components/MemoryManager";
import { SessionRecovery } from "./components/SessionRecovery";
import { UsageStats } from "./components/UsageStats";
import { TaskCenter, type TaskCenterTab } from "./components/TaskCenter";
import { AgentManager } from "./components/AgentManager";
import { DiffViewer } from "./components/DiffViewer";
import { InlineDiffReview } from "./components/InlineDiffReview";
import { InteractiveFormDialog } from "./components/InteractiveFormDialog";
import { PromptChangeReviewDialog } from "./components/PromptChangeReviewDialog";
import { NotebookManager } from "./components/NotebookManager";
import { NotebookWorkspace } from "./components/NotebookWorkspace";
import { SourceViewer } from "./components/SourceViewer";
import { setActiveSourceFilter as setNotebookSourceFilter, createNote, listSources } from "./core/knowledge";
import { GitHubCloneDialog } from "./components/GitHubCloneDialog";
import { CicdPanel } from "./components/CicdPanel";
import { PerformanceDashboard } from "./components/PerformanceDashboard";
import { PlanApprovalCard } from "./components/PlanApprovalCard";
import { setPlanApprovalCallback, clearPlanApprovalCallback, type PlanApprovalOutcome } from "./core/llm/tools/exit-plan-mode";
import { SearchDialog } from "./components/SearchDialog";
import { usePetStore } from "./core/pet/pet-store";
import { loadInstalledPets as loadInstalledPetsPets } from "./core/pet/pet-manager";
import { loadInstalledSkills } from "./core/skill/installer";
import { getSessionMessageBus, getDelegationOrchestrator, executeSessionTurn, isSessionExecuting, startSessionExecution, endSessionExecution } from "./core/session";
import { getSession as getStoredSession } from "./core/storage/session";
import { getProject as getStoredProject } from "./core/storage/project";
// 大富翁小游戏 — 懒加载
const GameViewLazy = lazy(() => import("./plugins/monopoly-game/components/GameView").then(m => ({ default: m.GameView })));
import type { InteractiveFormQuestion, PromptChange } from "./core/llm/tools";
import { useAppStore } from "./store";
import type { Message, ToolCall } from "./store";
import { useProjectStore } from "./core/store";
import { setGlobalCwd } from "./utils/file-link";
import { loadAppIdentity } from "./core/config/loader";
import { AppIdentity, type Session } from "./core/types";
import { getLLMEngine } from "./core/llm";
import { resolveProviderForModel, getFirstConfiguredModel } from "./core/model-config";
import { getMiMoAuth } from "./core/auth/mimo";
import type { PermissionRequest, PermissionResult } from "./core/permission/permission";
import { flushSessionLogWrites } from "./core/storage/session-jsonl";
import { STORAGE_UNAVAILABLE_EVENT } from "./core/storage/health";
import { getModelProfileManager } from "./core/llm/model-profile";
import { migrateFromLocalStorage } from "./core/storage/migration";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "./core/storage/settings";
import { setLang, useLang, S } from "./core/i18n/lang";
import { useWindowState } from "./hooks/useWindowState";
import * as MessageStorage from "./core/storage/message";
// 第 47 轮补 P0：窗口下标 → 会话绝对下标的换算（纯函数，见该文件的长注释）
import { resolveSessionAbsoluteIndex as resolveForkIndex } from "./core/session/fork-index";
import * as SessionStorage from "./core/storage/session";
import { formatAttachmentsInline } from "./core/llm/attachment-formatter";
import { syncAttachmentsToWorkspace } from "./core/llm/attachment-sync";
import { ThemeManager, useSkin } from "./core/theme";
import { HubLayout } from "./components/HubLayout";
import { DreamLayout } from "./components/DreamLayout";
import { OnboardingTour } from "./components/OnboardingTour";
// 第 47 轮补：写盘/操作失败的常驻提示（原来那条通道只在流式期间渲染）
import { PersistFailureBanner } from "./components/PersistFailureBanner";
// 第 47 轮（D-19）：`QuickAccessCards` 的 App 级死 UI 已删除（理由见原渲染点注释），
// 该组件仍由 `ChatPanel.tsx` 通过 `chat-panel-quick-access` 槽位真实渲染，故组件本身保留。
import { CorrectionResultPanel } from "./components/CorrectionResultPanel";
import { ClarificationForm } from "./components/ClarificationForm";
import { PipelineNextStepDialog } from "./components/PipelineNextStepDialog";
import { getAgentRegistry } from "./core/agent/agent";
import type { ClarificationFormData } from "./core/llm/agentic-loop";
import { runSetupScript, runCleanupScript } from "./core/environment";
import { applyStoredUiFont } from "./core/ui-font";
import { debugLog } from "./core/debug";
import { composePersistAlertText, reportActionFailure } from "./core/storage/persist-failure";

/**
 * 退出前的收尾：**排空在途写入 + checkpoint 存储端口**（第 44 轮补上的缺口）。
 *
 * ## 为什么必须有这一步
 *
 * `shutdownRustStoragePort()`（`core/storage/bootstrap.ts`）会做两件退出时必须做的事：
 * ① 排空 `RustStoragePort` 的三个队列（append / events / config）；
 * ② `engine.checkpoint()` 把 WAL 并回主库。
 *
 * 而它在**生产代码里零调用**（只有定义与两个测试）—— 也就是说：退出时这两件事从来没做过。
 * 后果实测（应用内长连接）：
 * - 冷启动 WAL 16.1 KB → 写入约 20 MB 后 **30,425.3 KB**；
 * - **干净退出后仍然 30,425.3 KB**（没 checkpoint）；
 * - 强杀重启后仍然 30,425.3 KB；
 * - 而显式跑一次 `checkpoint` 只要 **10.2 ms**，WAL 立刻归零。
 *
 * 这**不会丢数据**（崩溃测试证明追加日志与事务都已落地），但它让"磁盘上看起来只涨不落"，
 * 并且下次启动要重放 30 MB 的 WAL —— 退出时 10 毫秒的事被挪到了下次启动。
 *
 * ## 为什么放在这里而不是塞进 `quit_app`
 *
 * `quit_app` 是 Rust 侧命令，调用它会立刻结束进程 —— 所以收尾必须在**调用之前**
 * 由渲染侧 await 完成（三处退出路径：窗口关闭 / 托盘退出 / `quit-requested` 事件）。
 * 收敛成一个函数是为了**三处行为一致**：否则"从托盘退出不 flush"这类偏差迟早会出现。
 */
async function finalizeBeforeQuit(): Promise<void> {
  try {
    await flushSessionLogWrites();
  } catch {
    // `flushSessionLogWrites` 内部已自行上报失败；此处兜底防御（退出路径不能再抛）
  }
  try {
    const { shutdownRustStoragePort } = await import("./core/storage/bootstrap");
    await shutdownRustStoragePort();
  } catch {
    // 同上：收尾失败不能让退出流程卡住（Rust 侧有 2.5s 兜底强退）
  }
}

/**
 * 动态获取应用根目录（用户主目录）。
 * 不再写死 D:\mimo，而是从 Tauri 运行时获取用户主目录。
 */
let _appRootCache: string | null = null;
async function getAppRoot(): Promise<string> {
  if (_appRootCache) return _appRootCache;
  try {
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (invoke) {
      _appRootCache = (await invoke("get_default_cwd")) as string;
      return _appRootCache;
    }
  } catch {}
  _appRootCache = "D:\\mimo";
  return _appRootCache;
}

// 同步 fallback：在异步 getAppRoot 完成前使用
const APP_ROOT_FALLBACK = "D:\\mimo";

// 事件级 idle 看门狗（最后防线）：主防线是 provider 请求级超时（对标 DSH
// request_timeout_seconds）。看门狗兜底"工具执行挂起"等其他路径——仅当
// 整个会话连续 WATCHDOG_IDLE_MS 无任何事件输出才触发，宽松且可配置，
// 不是任务总时长硬限制（长编译/长推理不会被误杀）。
const WATCHDOG_IDLE_MS = 15 * 60 * 1000; // 15 分钟无事件
const WATCHDOG_CHECK_MS = 30_000;        // 每 30s 检查一次
type BottomTab = "chat" | "terminal" | "perf" | "files" | "jobs" | "cicd" | "game";

function getCliSessionKey(projectId: string, sessionId: string) {
  return `codem-cli-session-${projectId}-${sessionId}`;
}

function loadCliSessionId(projectId: string, sessionId: string): string | null {
  try {
    return getSetting(getCliSessionKey(projectId, sessionId));
  } catch {}
  return null;
}

function saveCliSessionId(projectId: string, sessionId: string, mimoSessionId: string) {
  try {
    setSetting(getCliSessionKey(projectId, sessionId), mimoSessionId);
  } catch {}
}

function getMode(): "cli" | "api" {
  try {
    const settings = getSettingJSON<any>("codem-settings", {});
    return settings.mode || "api";
  } catch {}
  return "api";
}

function App() {
  const lang = useLang();
  // 窗口状态持久化（对标 dsh main-window-state）：恢复上次窗口尺寸/位置
  useWindowState();
  const { messages, addMessage, appendToMessage, setStreaming, isStreaming, addToolCall, updateToolCall, loadMessages, saveMessages, setLLMStatus, addGuidanceMessage, markGuidanceConsumed, removeGuidanceMessage, clearGuidanceMessages, loadedSessionId } = useAppStore();
  const { currentProject, currentSession, createSession, dbReady, loadFromDB } = useProjectStore();

  /**
   * 第 47 轮（设置链路审计 D-20）：「上次打开的会话」恢复的**一次性闸门**与被占标志。
   *
   * `restoredLastSessionRef`：拿到**明确结论**后才置位（恢复成功 / 会话确实已删除 /
   * 没有键）。"读不到"（`storage-unavailable`）**不置位** —— 否则一次误判定终身。
   *
   * `restoreInFlightRef`：串联保护。effect 依赖含 `currentProject?.path`，而恢复动作
   * 自己会改 `currentProject` —— 没有它就会出现"恢复尚未落地 → effect 再跑 → 又发起一次"
   * 的并发重复恢复。
   */
  const restoredLastSessionRef = useRef(false);
  const restoreInFlightRef = useRef(false);

// P0-FIX: Sync global cwd for file-link resolution — without this, clicking
// file links in markdown output resolves paths against the wrong base dir
// (get_default_cwd returns the global workspace, not the project dir).
setGlobalCwd(currentProject?.path || "");

  // P4.3: 初始化 Cordis 插件系统
  // 在 App 挂载时创建全局 Context，加载桥接插件和 Slot Registry。
  // 所有核心服务通过 ctx.provide() 注册后，插件可以通过 ctx.get() 消费。
  const [cordisReady, setCordisReady] = useState(false);
  useEffect(() => {
    getCordisContext().then(() => {
      // LLMEngine 和 MiMoAuth 已在 getCordisContext 内部注册为 Cordis 服务。
      setCordisReady(true);
    }).catch((err) => {
      console.error("Failed to initialize Cordis context:", err);
      // 即使 Cordis 初始化失败，也继续运行现有功能
      setCordisReady(true);
    });
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(true);
const [rightRailOpen, setRightRailOpen] = useState(false);
  // P3 #46: Mobile sidebar drawer
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [appRoot, setAppRoot] = useState<string>(APP_ROOT_FALLBACK);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string>("general");
  const [showProjectManager, setShowProjectManager] = useState(false);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [showMcpManager, setShowMcpManager] = useState(false);
const [showPluginManager, setShowPluginManager] = useState(false);
  const [showSkillManager, setShowSkillManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showNotebookManager, setShowNotebookManager] = useState(false);
  const [showGitHubClone, setShowGitHubClone] = useState(false);
const [showCicdPanel, setShowCicdPanel] = useState(false);
const [showPerfDashboard, setShowPerfDashboard] = useState(false);
// 插件启用状态 — 控制按钮/面板的显示与隐藏
//
// 第 47 轮（设置链路审计 D-22）：初值仍然**同步**从 localStorage 镜像读 ——
// 首帧不可能拿到 DB（端口未就绪），改成异步初始化会让首帧把 20 多个 UI 插件
// 全部按"启用"渲染一遍再闪回来。DB 权威值与 localStorage→DB 迁移在下方
// `dbReady` 的 effect 里补做（`loadDisabledPlugins`），迁移发生过会打一行 log。
const [pluginDisabledList, setPluginDisabledList] = useState<string[]>(() => {
  try {
    const raw = localStorage.getItem('codem:disabled-plugins');
    if (raw === null) {
      // 首次运行：默认禁用游戏插件（与 `DEFAULT_DISABLED_PLUGINS` 同一份判据，DB 侧由 loadDisabledPlugins 落盘）
      const defaultDisabled = ['@codem/ui-game'];
      localStorage.setItem('codem:disabled-plugins', JSON.stringify(defaultDisabled));
      return defaultDisabled;
    }
    return JSON.parse(raw);
  } catch { return []; }
});
// 监听插件状态变化（PluginManagerService 写入 localStorage 后触发）
useEffect(() => {
  const onStorage = (e: StorageEvent) => {
    if (e.key === 'codem:disabled-plugins') {
      try { setPluginDisabledList(e.newValue ? JSON.parse(e.newValue) : []); } catch {}
    }
  };
  // 也监听自定义事件（同窗口内 PluginManager 操作不会触发 storage 事件）
  const onPluginChange = () => {
    try {
      const raw = localStorage.getItem('codem:disabled-plugins');
      setPluginDisabledList(raw ? JSON.parse(raw) : []);
    } catch (e) { console.warn('[App] catch', e) }
    // 第 47 轮（D-22）：插件开关的权威介质是 DB。`PluginManagerService` 目前仍只写
    // localStorage 镜像，所以镜像一变就把它的新值**收编**进 DB（镜像永远只是 DB 的副本，
    // 而不是第二个真相源；换 profile / 清缓存后用户的选择不会再凭空丢失）。
    // 这里刻意**不**在收编后回写镜像：写镜像同样是 setItem，不加这道闸就会
    // 在这一处形成 setItem → 收编 → setItem 的自激循环。
    void (async () => {
      try {
        const { adoptDisabledPluginsMirror } = await import("./core/session/preferences");
        if (adoptDisabledPluginsMirror()) {
          console.log('[App] 插件禁用列表的 localStorage 镜像已收编进 DB（D-22：DB 为权威介质）');
        }
      } catch (e) {
        console.warn('[App] 插件禁用列表收编进 DB 失败（镜像仍有效）:', e);
      }
    })();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener('codem:plugin-state-changed', onPluginChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('codem:plugin-state-changed', onPluginChange);
  };
}, []);
// 插件是否被禁用
const isPluginDisabled = useCallback((name: string) => pluginDisabledList.includes(name), [pluginDisabledList]);
// P1-3: 扩展条件渲染 — 从 3 个插件扩展到所有 UI 影响插件
// CI/CD 和性能面板由 @codem/ui-misc 提供
const cicdEnabled = !isPluginDisabled('@codem/ui-misc');
const perfEnabled = !isPluginDisabled('@codem/ui-misc');
// 插件管理由 @codem/plugin-registry 和 @codem/ui-slots 提供
const pluginMgrEnabled = !isPluginDisabled('@codem/plugin-registry') && !isPluginDisabled('@codem/ui-slots');
// 插件市场由 @codem/ui-settings-plugin-inventory 提供
const pluginMarketEnabled = !isPluginDisabled('@codem/ui-settings-plugin-inventory');
// 主题切换由 @codem/ui-theme 提供
const themeEnabled = !isPluginDisabled('@codem/ui-theme');
// 侧边栏由 @codem/ui-sidebar 提供
const sidebarEnabled = !isPluginDisabled('@codem/ui-sidebar');
// 对话面板由 @codem/ui-conversation 提供
const conversationEnabled = !isPluginDisabled('@codem/ui-conversation');
// 设置面板由 @codem/ui-settings 提供
const settingsEnabled = !isPluginDisabled('@codem/ui-settings');
// 工具详情由 @codem/ui-tool 提供
const toolDetailsEnabled = !isPluginDisabled('@codem/ui-tool');
// Cordis 管理由 @codem/ui-cordis 提供
const cordisPanelEnabled = !isPluginDisabled('@codem/ui-cordis');
// 子 Agent 面板由 @codem/ui-subagent 提供
const subagentPanelEnabled = !isPluginDisabled('@codem/ui-subagent');
// 附件 UI 由 @codem/ui-attachment 提供
const attachmentEnabled = !isPluginDisabled('@codem/ui-attachment');
// 目标面板由 @codem/ui-goal 提供
const goalPanelEnabled = !isPluginDisabled('@codem/ui-goal');
// Jobs 面板由 @codem/ui-jobs 提供
const jobsPanelEnabled = !isPluginDisabled('@codem/ui-jobs');
// 计划面板由 @codem/ui-plan 提供
const planPanelEnabled = !isPluginDisabled('@codem/ui-plan');
// 工作区面板由 @codem/ui-workspace 提供
const workspacePanelEnabled = !isPluginDisabled('@codem/ui-workspace');
// 游戏面板由 @codem/ui-game 提供（默认关闭）
const gameEnabled = !isPluginDisabled('@codem/ui-game');
const [planApproval, setPlanApproval] = useState<{ plan: string; resolve: (result: PlanApprovalOutcome) => void } | null>(null);
  const [showSearchDialog, setShowSearchDialog] = useState(false);
const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
const [activeNotebookName, setActiveNotebookName] = useState<string>('');
const [notebookWorkspaceId, setNotebookWorkspaceId] = useState<string | null>(null);
/**
 * 「用户此刻在看的那个会话」（第 45 轮功能上下文审计 P0-I1）。
 *
 * ## 为什么需要它
 *
 * 所有"按当前会话"取值/写值的东西（待确认写入、权限请求、澄清表单、纠错结果、
 * 流水线下一步、Prompt 变更、会话级自动保存）原来都直接读 project store 的
 * `currentSession`。而笔记本回合（`handleNotebookSend`）原来会**临时把 `currentSession`
 * 改写成笔记本会话**再在 `finally` 里还原 —— 窗口期内全 App 的"当前会话"语义被换掉，
 * 包括用户自己切换会话的动作都会在结束那一刻被回滚。
 *
 * 现在不再改写全局状态，改为在这里**显式表达**"在屏的是谁"：
 * - 笔记本模式/笔记本工作区开着（`activeNotebookId` 非空）→ 在屏的是**笔记本会话**，
 *   它的 id 由消息列表的归属（`loadedSessionId`）如实给出（笔记本打开时 `loadMessages`
 *   的就是它）；解析不到时才退回落差点的 `currentSession`；
 * - 其它情况 → 主聊天的当前会话（与改之前完全一致）。
 */
const uiSessionId = activeNotebookId
  ? (loadedSessionId ?? currentSession?.id ?? null)
  : (currentSession?.id ?? null);
const [notebookWorkspaceName, setNotebookWorkspaceName] = useState<string>('');
// Citation viewer — opens SourceViewer when user clicks [Source: name] in chat
const [citationViewer, setCitationViewer] = useState<{ sourceId: string; notebookId: string; chunkIndex?: number } | null>(null);
  const [showSessionRecovery, setShowSessionRecovery] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);
const [showTaskCenter, setShowTaskCenter] = useState(false);
const [taskCenterTab, setTaskCenterTab] = useState<TaskCenterTab>("overview");
// 子智能体任务列表：事件驱动订阅（不再在 render 里 require()，那样在 ESM 里必然抛错 → 永远空列表）
const [subagentTasks, setSubagentTasks] = useState<SubagentTask[]>([]);
useEffect(() => {
  const runtime = getSubagentRuntime();
  const update = () => setSubagentTasks(runtime ? runtime.getAllTasks() : []);
  update();
  const unsubscribe = runtime?.subscribe(update);
  return () => {
    if (unsubscribe) unsubscribe();
  };
}, []);
// 团队活动快捷入口：对话顶部「团队」按钮 → 打开任务管理「团队」Tab（B 深合并收敛）
useEffect(() => {
  const openTaskCenter = (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    // 允许指定任意合法页签（如插件派发的 { tab: "board" }）；未指定或非法值回退「概览」。
    // 旧 id（squads → teams、library → board）由 TaskCenter.normalizeTab 归一。
    const requested = typeof detail.tab === "string" && detail.tab ? detail.tab : "overview";
    setTaskCenterTab(requested as TaskCenterTab);
    setShowTaskCenter(true);
  };
  window.addEventListener("codem:open-task-center", openTaskCenter as EventListener);
  return () => window.removeEventListener("codem:open-task-center", openTaskCenter as EventListener);
}, []);
// 「打开某个会话」请求（例如场景里的子智能体 → 打开父会话）。
// 插件用宿主事件表达意图，宿主不依赖插件。
useEffect(() => {
  const openSession = (e: Event) => {
    const sessionId = (e as CustomEvent).detail?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return;
    try {
      useProjectStore.getState().switchSession(sessionId);
      setShowTaskCenter(false);
    } catch {
      /* 忽略：切不过去就保持原样 */
    }
  };
  window.addEventListener("codem:open-session", openSession as EventListener);
  return () => window.removeEventListener("codem:open-session", openSession as EventListener);
}, []);
const [showAgentManager, setShowAgentManager] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("chat");
// 如果性能 tab 被禁用但当前选中它，回退到对话
useEffect(() => {
  if (bottomTab === "perf" && !perfEnabled) setBottomTab("chat");
  // P1-3: 其他 tab 的降级回退
  if (bottomTab === "files" && !workspacePanelEnabled) setBottomTab("chat");
  if (bottomTab === "jobs" && !jobsPanelEnabled) setBottomTab("chat");
}, [bottomTab, perfEnabled, workspacePanelEnabled, jobsPanelEnabled]);
  const [fileExplorerProjectId, setFileExplorerProjectId] = useState<string | null>(null);
  const [fileExplorerRefreshKey, setFileExplorerRefreshKey] = useState(0);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [appIdentity, setAppIdentity] = useState<AppIdentity | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [bootSplashVisible, setBootSplashVisible] = useState(true);
  const [bootSplashPhase, setBootSplashPhase] = useState<"initializing" | "loading-db" | "loading-config" | "ready">("initializing");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  // P2: Onboarding tour — shown on first launch (after DB is ready)
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showOnboardingReplay, setShowOnboardingReplay] = useState(false);
  // Check onboarding flag after DB is initialized (dbReady transitions from false to true)
  // 同时从 settings 重新读取 model/mode/provider，修正首次渲染时 DB 未就绪导致的错误默认值
  useEffect(() => {
    if (dbReady) {
      try {
        const completed = getSetting("onboarding-completed");
        if (!completed) setShowOnboarding(true);
      } catch { /* DB not ready yet — will retry on next render */ }

      // 第 76 波：DB 就绪后台跑一次维护 —— 裁剪"只增不减"的事件表 + 遥测 + VACUUM，
      // 并清理过期的溢出文件（溢出把大文本搬到磁盘，磁盘同样需要保留策略）。
      // 本地库整库常驻内存，表只增不减会让每次保存的导出峰值越来越大（用户报的 out of memory）。
      // 放在启动后台执行：不阻塞首屏，失败也只记日志。
      void (async () => {
        try {
          // 第 18 轮：维护模块从旧引擎里抽出来了（它本来一行都不跑，见 storage/maintenance.ts 的说明）
          const { runDatabaseMaintenance } = await import("./core/storage/maintenance");
          await runDatabaseMaintenance();
        } catch (e) {
          console.warn("[App] 存储维护失败（不影响使用）:", e);
        }
        try {
          const { pruneSpillFiles } = await import("./core/storage/spill");
          await pruneSpillFiles();
        } catch (e) {
          console.warn("[App] 溢出文件清理失败（不影响使用）:", e);
        }
      })();
      // P0: DB 就绪后立即从 settings 同步读取正确的 model/mode/provider
      // 避免依赖 configureEngine 的异步重试链（engine 可能耗时才激活）
      try {
        const settings = getSettingJSON<any>("codem-settings", {});
        let mode: "cli" | "api" = settings.mode === "cli" ? "cli" : "api";
        // 修正历史脏数据
        if (mode === "cli") {
          const m = settings.model || "";
          if (m.startsWith("deepseek") || m.startsWith("claude") ||
            m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("gemini") ||
            m.startsWith("moonshot")) {
            mode = "api";
          }
        }
        let model: string;
        if (mode === "cli") {
          model = settings.model || "mimo-v2.5-pro";
        } else {
          model = settings.model || "";
          if (!model) {
            model = getFirstConfiguredModel().model;
          }
        }
        let provider = "mimo";
        if (mode === "api") {
          if (model) {
            const resolved = resolveProviderForModel(model);
            if (resolved) provider = resolved;
          }
        }
        console.log(`[dbReady] syncing model from settings: mode=${mode}, model=${model}, provider=${provider}`);
        setCliModel(model);
        setCurrentMode(mode);
        setCurrentProvider(provider);
      } catch (e) {
        console.warn("[dbReady] Failed to sync model from settings:", e);
      }
      // Security mode: DB 就绪前 useState 初始化读不到已保存的模式（getDatabase 抛错 → 默认 ask），
      // 这里在 DB 就绪后重新同步，避免用户保存的 "full"/"auto" 在重启后失效。
      try {
        const syncedMode = getEffectiveSecurityMode(currentProject?.path);
        setSecurityMode(syncedMode);
        console.log(`[dbReady] syncing securityMode from settings: ${syncedMode}`);
      } catch (e) {
        console.warn("[dbReady] Failed to sync securityMode from settings:", e);
      }

      /**
       * ## 第 47 轮（设置链路审计 D-20）：恢复「上次打开的会话 / 项目」
       *
       * 改前这个能力**完全不存在**：启动路径只跑 `loadFromDB()`（只写 `projects` 与
       * `dbReady`），从不设置 `currentProject / currentSession` —— 每次启动都停在
       * "无会话"空状态，用户昨天聊到一半的会话要自己在侧边栏里翻出来。
       *
       * 三条纪律（实现在 `core/session/preferences.ts::restoreLastOpenedSession`）：
       * 1. **必须 `dbReady` 之后**才恢复：`getSession` 走引擎端口，首帧读到的是空镜像，
       *    那时"目标不存在"是**假**结论 —— 会走到"清掉这个键"，把"能力缺失"升级成
       *    "用户的上次会话记录被删"；
       * 2. **目标必须能在库里读回来**才恢复（会话可能已被删除、项目可能已级联删会话）；
       *    读不回来就安静回落到"无会话"，走 `console.log` 而不是 `console.error`
       *    （"上次的会话被删了"是完全正常的用户操作，不是故障）；
       * 3. **只有"真的有结论"才收工**（`restoredLastSessionRef`）。
       *
       * 用户在恢复发生前就手动选了会话/项目时**不抢**：`currentSession` 已有值就跳过。
       *
       * ## ⚠️ 第 47 轮补：一次性闸门原来是**会毁数据**的（只读审计坐实）
       *
       * 第一版在这里把 `restoredLastSessionRef.current = true` 放在**尝试之前**，
       * 于是一次尝试定终身。而"这次尝试"可能恰好落在 `sessions` 镜像尚未就绪的窗口里
       * （`App.tsx` 里 `[Store] loadFromDB: found 0 projects` →（就绪后重读）`found 1`
       * 那个补丁就是同一个窗口的物证）—— 那时 `getSession` 读不到，
       * 恢复逻辑会认定"会话已被删除"并**把用户的上次会话键清成 null**，
       * 而闸门已经关上，**再也不会重试**。功能失效之外还毁掉了用户的指针。
       *
       * 现在分两层：
       * - **恢复端**：`resolveRestoreTarget` 区分三态，"读不到"（unavailable）
       *   **既不清键也不恢复**（见 `session.ts::getSessionState`）；
       * - **调用端**：只有拿到**明确结论**（恢复成功 / 会话确实已删除 / 没有键）
       *   才置位闸门；`storage-unavailable` 视为**可重试**，
       *   并且主动 `domainEnsureLoaded("sessions")` 让镜像加载完再试（有界重试，
       *   不是无限轮询 —— 与"项目列表就绪后重读"那条补丁同一种做法）。
       */
      if (!restoredLastSessionRef.current && !restoreInFlightRef.current) {
        restoreInFlightRef.current = true;
        void (async () => {
          const STORAGE_UNAVAILABLE_RETRIES = 12; // 12 × 250ms = 3 秒
          try {
            const { restoreLastOpenedSession, resolveRestoreTarget } = await import("./core/session/preferences");
            const { domainEnsureLoaded } = await import("./core/storage/domain-store");

            for (let attempt = 0; attempt <= STORAGE_UNAVAILABLE_RETRIES; attempt += 1) {
              // 用户在恢复前手动选了会话 → 不抢，收工
              if (useProjectStore.getState().currentSession) {
                restoredLastSessionRef.current = true;
                break;
              }

              const target = resolveRestoreTarget();

              if (target.reason !== "storage-unavailable") {
                // 有明确结论了（没有键 / 已删除 / 找到目标）→ 这是最后一次，闸门关上
                restoredLastSessionRef.current = true;
                restoreLastOpenedSession(
                  {
                    setProjects: (p) => useProjectStore.getState().setProjects(p),
                    setSessions: (s) => useProjectStore.getState().setSessions(s),
                    setState: (partial) => useProjectStore.setState(partial),
                  },
                  "启动恢复",
                );
                break;
              }

              // 读不到（镜像还没接手 / 超上限被拒）：**不清键**，等镜像就绪再试一次
              if (attempt === STORAGE_UNAVAILABLE_RETRIES) {
                console.log(
                  "[App] 会话镜像在 3 秒内仍未就绪 → 本次不恢复（键保持不动，下次启动再试；" +
                    "把「读不到」当成「已删除」会永久抹掉用户的「上次打开的会话」）",
                );
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
              // 主动催一下：让 sessions 镜像开始/继续加载（`domainEnsureLoaded` 需要回调，
              // 这里不为回调做事 —— 下一次循环会重新读一次状态）
              domainEnsureLoaded("sessions", () => {});
            }
          } catch (e) {
            // 恢复失败不许影响正常使用：应用停在"无会话"状态是可用形态
            console.warn("[App] 恢复上次打开的会话失败（按无会话启动）:", e);
          } finally {
            restoreInFlightRef.current = false;
          }
        })();
      }

      /**
       * 第 47 轮（设置链路审计 D-22）：插件启用状态的**权威介质**是 DB
       * （与 `codem-sidebar-width` 等同一种介质），localStorage 只是旧读方的镜像。
       *
       * 首帧的同步初值来自镜像（见 `pluginDisabledList` 的声明处），这里补做：
       * 读 DB 权威值 + 把镜像里的历史值迁移进 DB。
       *
       * 第 48 轮：改调 `reconcileDisabledPluginsAtBoot`（而不是直接读 DB）。原因：
       * "DB 一律为准"在**写入没落地**时是错的 —— 用户刚关掉一个插件、进程在
       * 异步落库前被杀掉，盘上 DB 还是旧值，下一次启动就会把用户的开关
       * **静默改回去**。对账函数用写入时间戳判定"哪一份更新"，
       * 并且把"两种介质不一致"这件事经 `reportPersistFailure` 说出来（不回退成静默路径）。
       */
      void (async () => {
        try {
          const { reconcileDisabledPluginsAtBoot } = await import("./core/session/preferences");
          const state = reconcileDisabledPluginsAtBoot();
          setPluginDisabledList(state.list);
          if (state.migrated) {
            console.log("[App] 插件禁用列表的介质已从 localStorage 迁移到 DB（D-22）");
          }
          if (state.adoptedFromMirror) {
            console.warn(
              "[App] 上一次的插件开关写入没有落到 DB，已按较新的一份（localStorage 镜像）恢复；" +
              "界面上的开关状态以本次显示为准",
            );
          }
        } catch (e) {
          console.warn("[App] 读取插件禁用列表（DB）失败，继续用 localStorage 镜像:", e);
        }
      })();
    }
  }, [dbReady, currentProject?.path]);

  /**
   * 第 47 轮（设置链路审计 D-20）：记下"当前打开的会话 / 项目"，供下次启动恢复。
   *
   * ## 为什么必须有一个**记录**端（而不是只在恢复端写代码）
   *
   * 改前的状况是"两端都没有"：既没有恢复，也没有任何地方写
   * `codem-last-session`（全仓 0 命中）。只补恢复端的话，那个键永远是空的 ——
   * 恢复逻辑每天安静地返回 `no-key`，功能看起来"实现了"其实一次都不会生效。
   *
   * ## 写入时机与失败可见性
   *
   * - 依赖 `dbReady`：DB 就绪前 `setSettingJSON` 写不进去（端口未注册）；
   * - 每次 `currentSession?.id` 变化都记一次（切换、新建、删除回落都算）——
   *   这是"最近一次真实打开的会话"，与"最后修改时间"不是一回事；
   * - 会话被删除后由 `deleteSession` 路径调 `forgetLastSessionIfDeleted` 清键
   *   （见 `core/store.ts`）；这里不做"目标是否存在"的判断（那是恢复端的职责，
   *   记的时候目标必然是存在的）。
   * - 写失败只记 `console.warn`：这是一个**便利性**偏好，不是数据 ——
   *   丢了只影响"下次打开落在哪个会话"，不该弹错误打扰用户。
   *
   * ## ⚠️ 第 47 轮补：**恢复还没落地之前，绝不许把键写成 null**
   *
   * 真机抓到的形态（1.16.70 复核时发现"键被清空、目标会话却好好地在库里"）：
   * 这个 effect 与恢复 effect **在同一次 commit 里**跑，而恢复的第一次读是**异步**的
   * （`await import(...)` 之后才 `readLastSessionId()`）。于是顺序是：
   *
   * ```text
   * 恢复 effect: 发起 async（还没读到键）
   * 记录 effect: 此刻 currentSession === null → writeLastSessionId(null) ← **键被清掉**
   * 恢复 effect: 真正读键 → null → 返回 no-key（安静地什么都不做）
   * ```
   *
   * 结果与"镜像未就绪被当成已删除"是**同一类缺陷**（把"还没有值"当成"用户没有上次会话"），
   * 而且它解释了一个此前的怪现象：同一个功能有时恢复成功、有时不成功 ——
   * 差的就是两个 async 谁先跑完。第 47 轮我在 `resolveRestoreTarget` 那边堵了
   * "读不到 ≠ 已删除"，但**写侧**这条更早的路没堵。
   *
   * 修法：启动期的"没有会话"是一个**瞬时状态**，不是用户的选择 ——
   * 所以先问恢复端"你要不要保留这个键"（`shouldPreserveLastSessionKey()`），
   * 恢复一旦拿到结论（成功 / 确实已删除 / 没有键）就返回 false，记录端随后照常工作。
   *
   * 注意 `currentSession` **有值**时永远照写：那是用户真实打开了一个会话。
   */
  useEffect(() => {
    if (!dbReady) return;
    if (currentSession?.id) {
      // 用户确实打开着某个会话 → 直接记录（这是唯一无歧义的情形）
      void (async () => {
        try {
          const { writeLastSessionId, writeLastProjectId } = await import("./core/session/preferences");
          writeLastSessionId(currentSession.id);
          writeLastProjectId(currentSession.projectId ?? currentProject?.id ?? null);
        } catch (e) {
          console.warn("[App] 记录'上次打开的会话'失败（只影响下次启动的落地位置）:", e);
        }
      })();
      return;
    }
    void (async () => {
      try {
        const { shouldPreserveLastSessionKey, writeLastProjectId } = await import("./core/session/preferences");
        if (shouldPreserveLastSessionKey()) {
          // 启动恢复还没定论 → **不写 null**（写了就等于把用户的"上次会话"抹掉）
          return;
        }
        writeLastProjectId(currentProject?.id ?? null);
      } catch (e) {
        console.warn("[App] 记录'上次打开的会话'失败（只影响下次启动的落地位置）:", e);
      }
    })();
  }, [dbReady, currentSession?.id, currentSession?.projectId, currentProject?.id]);
  // Initialize from saved settings synchronously to avoid UI flash showing wrong model list.
  // getMode() reads from SQLite synchronously; if DB not ready yet, falls back to "api".
  const _initialSettings = (() => {
    try {
      return getSettingJSON<any>("codem-settings", {});
    } catch {
      return {};
    }
  })();
  const _initialMode: "cli" | "api" = (() => {
    const m = _initialSettings.mode;
    if (m === "cli" || m === "api") {
      // 如果 mode=cli 但 model 是 API 模型的前缀，修正为 api（修复历史脏数据）
      const model = _initialSettings.model || "";
      if (m === "cli" && (model.startsWith("deepseek") || model.startsWith("claude") ||
        model.startsWith("gpt") || model.startsWith("o3") || model.startsWith("gemini") ||
        model.startsWith("moonshot"))) {
        return "api";
      }
      return m;
    }
    return "api";
  })();
  // For API mode, find the first provider with an API key (excluding mimo) and use its first model.
  // This avoids defaulting to "gpt-4o" when the user hasn't configured an OpenAI key.
  const _initialModel: string = (() => {
    if (_initialMode === "cli") {
      return _initialSettings.model || "mimo-v2.5-pro";
    }
    // API mode: use saved model if it belongs to a configured provider
    const savedModel: string = _initialSettings.model || "";
    if (savedModel) return savedModel;
    // No saved model: first configured provider (incl. custom) + its first model
    return getFirstConfiguredModel().model;
  })();
  const _initialProvider: string = (() => {
    const model = _initialModel;
    if (_initialMode === "cli") return "mimo";
    if (model) {
      const resolved = resolveProviderForModel(model);
      if (resolved) return resolved;
    }
    return "mimo";
  })();

  const [cliModel, setCliModel] = useState(_initialModel);
  const [currentMode, setCurrentMode] = useState<"cli" | "api">(_initialMode);
  const [currentProvider, setCurrentProvider] = useState(_initialProvider);
  const [collaborationMode, setCollaborationMode] = useState<CollaborationMode>("default");
  const windowVisibleRef = useRef(true);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(currentProject?.path));
  // P0-2: 消除双轨制 — Provider 关闭时不再静默回退到单例。
  // ctx 可用时返回 ctx.get(name)（Cordis 标准模式：可选依赖用 ctx.get，不存在时返回 undefined）；
  // 不可用时返回 null。
  const getCtxService = <K extends string & keyof Context>(name: K): Context[K] | null => {
    const ctx = tryGetCtx();
    if (ctx) {
      const s = ctx.get(name) as Context[K] | null;
      if (s) return s;
      console.warn(`[App] Service "${String(name)}" not available (provider disabled?)`);
      return null;
    }
    return null;
  };

  // 宠物服务获取器 — 优先从 Cordis ctx 获取（一切皆插件原则），
  // 回退到 usePetStore（用于 Cordis Context 初始化前的启动阶段）。
  const getPet = () => {
    const ctx = tryGetCtx();
    if (ctx) {
      const svc = ctx.get('pet') as any;
      if (svc) return svc;
    }
    // 启动阶段回退
    const store = usePetStore.getState();
    return {
      init: () => store.init(),
      showBubble: (m: string, d?: number) => store.showBubble(m, d),
      showRawBubble: (t: string, d?: number) => store.showRawBubble(t, d),
      setPetState: (s: string) => store.setPetState(s as any),
      onLLMStatus: (s: string) => store.onLLMStatus(s as any),
      onStreamEvent: (e: any) => store.onStreamEvent(e),
      setEnabled: (e: boolean) => store.setEnabled(e),
      setActivePet: (s: string | null) => store.setActivePet(s),
      getState: () => store,
      get enabled() { return store.enabled },
    };
  };

  // ===== 大肥鱼式状态卡汇聚器（对标 dsh-dafeiyu CompanionReducer 的薄版）=====
  // 数据源：llm_status / step_progress / tool_start / tool_complete / tool_error /
  // compaction_start / needs_you / end —— 全部来自 agentic-loop 事件，真实不编造。
  // 直接写 usePetStore（updateCard 只存 store + emit，不依赖 ctx 服务）。
  const phaseByPetState: Record<string, string> = {
    thinking: lang === "zh" ? "思考中" : "thinking",
    working: lang === "zh" ? "执行中" : "working",
    review: lang === "zh" ? "整理结果" : "reviewing",
    waiting: lang === "zh" ? "等待确认" : "waiting",
    happy: lang === "zh" ? "任务完成" : "done",
    sad: lang === "zh" ? "遇到问题" : "error",
    idle: "",
    sleeping: lang === "zh" ? "空闲中" : "idle",
  };
  const toolPhase = (name: string): string => {
    const n = (name || "").toLowerCase();
    if (/read|grep|glob|list|search|fetch|web/.test(n)) return lang === "zh" ? "查找" : "searching";
    if (/write|edit|multi_edit|str_replace/.test(n)) return lang === "zh" ? "修改" : "editing";
    if (/bash|run_test|exec/.test(n)) return lang === "zh" ? "执行" : "executing";
    if (/test/.test(n)) return lang === "zh" ? "验证" : "verifying";
    return lang === "zh" ? "执行" : "working";
  };
  const updatePetCard = (partial: Partial<import("./core/pet/pet-types").PetCard>) => {
    const store = usePetStore.getState();
    const prev = store.card || { visible: true } as any;
    const project = useProjectStore.getState().currentProject?.name
      || currentSession?.title
      || "";
    store.updateCard({ ...prev, ...partial, project: partial.project ?? project, visible: true });
  };
  const hidePetCard = () => { usePetStore.getState().updateCard(null); };

  // Track window visibility for task completion notifications
  useEffect(() => {
    const onVisibilityChange = () => { windowVisibleRef.current = !document.hidden; };
    const onBlur = () => { windowVisibleRef.current = false; };
    const onFocus = () => { windowVisibleRef.current = true; };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // 动态加载应用根目录（用户主目录），替换写死的 D:\mimo
  useEffect(() => {
    getAppRoot().then(setAppRoot).catch(() => {});
  }, []);

  // Listen for security mode changes from UI (InputArea toggle, SettingsPanel)
  useEffect(() => {
    const handler = () => {
      setSecurityMode(getEffectiveSecurityMode(currentProject?.path));
    };
    window.addEventListener("codem-security-mode-changed", handler);
    return () => window.removeEventListener("codem-security-mode-changed", handler);
  }, [currentProject?.path]);

  // P0-3: Register plan approval callback — connects exit_plan_mode tool to UI
  useEffect(() => {
    setPlanApprovalCallback(async (plan: string) => {
      return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
        setPlanApproval({ plan, resolve });
      });
    });
    return () => clearPlanApprovalCallback();
  }, []);

  // 监听文件打开事件（来自侧边栏等所有文件浏览器），自动展开右侧栏显示分割窗口
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path) {
        setEditingFile(path);
        // 确保右侧栏展开
        setRightRailOpen(true);
      }
    };
    window.addEventListener("codem:open-file", handler);
    return () => window.removeEventListener("codem:open-file", handler);
  }, []);

  // ENV series: Auto-run setup/cleanup scripts on project switch
  const prevProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    const prevPath = prevProjectPathRef.current;
    const newPath = currentProject?.path || null;

    // Only act when project path actually changes
    if (prevPath === newPath) return;
    prevProjectPathRef.current = newPath;

    // Run cleanup script for the old project (if any)
    if (prevPath) {
      runCleanupScript(prevPath).then((result) => {
        if (result && !result.success) {
          console.warn(`[ENV] Cleanup script failed for ${prevPath}:`, result.stderr);
        }
      }).catch(() => {});
    }

    // Run setup script for the new project (if any)
    if (newPath) {
      runSetupScript(newPath).then((result) => {
        if (result && !result.success) {
          console.warn(`[ENV] Setup script failed for ${newPath}:`, result.stderr);
        }
      }).catch(() => {});
    }
  }, [currentProject?.path]);

  // S4: Pending write confirmation for diff review — per-session for parallel safety
  const [pendingWriteConfirms, setPendingWriteConfirms] = useState<Map<string, {
    filePath: string;
    existingContent: string;
    newContent: string;
    resolve: (result: import("./core/llm/tools").WriteConfirmResult) => void;
  }>>(new Map());
  // Track per-session file change count and auto-approve state for batch review
  const [writeConfirmStats, setWriteConfirmStats] = useState<Map<string, { count: number; autoApprove: boolean }>>(new Map());
  // Convenience accessor: get the pending write confirm for the session on screen（见 `uiSessionId`）
  const pendingWriteConfirm = uiSessionId ? pendingWriteConfirms.get(uiSessionId) : null;
  const writeConfirmStat = uiSessionId ? (writeConfirmStats.get(uiSessionId) || { count: 0, autoApprove: false }) : { count: 0, autoApprove: false };
  const setPendingWriteConfirm = (val: any) => {
    if (!val || !uiSessionId) { return; }
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.set(uiSessionId, val);
      return next;
    });
    // Increment count
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(uiSessionId) || { count: 0, autoApprove: false };
      next.set(uiSessionId, { ...cur, count: cur.count + 1 });
      return next;
    });
  };
  const clearPendingWriteConfirm = () => {
    if (!uiSessionId) return;
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.delete(uiSessionId);
      return next;
    });
  };
  const setSessionAutoApprove = (autoApprove: boolean) => {
    if (!uiSessionId) return;
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(uiSessionId) || { count: 0, autoApprove: false };
      next.set(uiSessionId, { ...cur, autoApprove });
      return next;
    });
  };
  const resetWriteConfirmStats = (sessionId: string) => {
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

// D3: Pending interactive form — per-session for parallel safety
const [pendingInteractiveForms, setPendingInteractiveForms] = useState<Map<string, {
questions: InteractiveFormQuestion[];
resolve: (answers: Record<string, unknown>) => void;
}>>(new Map());
const pendingInteractiveForm = uiSessionId ? pendingInteractiveForms.get(uiSessionId) : null;
const setPendingInteractiveForm = (val: any) => {
  if (!val || !uiSessionId) return;
  setPendingInteractiveForms(prev => { const next = new Map(prev); next.set(uiSessionId, val); return next; });
};
const clearPendingInteractiveForm = () => {
if (!uiSessionId) return;
setPendingInteractiveForms(prev => { const next = new Map(prev); next.delete(uiSessionId); return next; });
};

// P1: Per-session pending clarification forms (AI asks structured questions)
const [pendingClarifications, setPendingClarifications] = useState<Map<string, { form: ClarificationFormData; resolve: (answers: string[]) => void }>>(new Map());
const pendingClarification = uiSessionId ? pendingClarifications.get(uiSessionId) : null;
const clearPendingClarification = () => {
if (!uiSessionId) return;
setPendingClarifications(prev => { const next = new Map(prev); next.delete(uiSessionId); return next; });
};

// P1: Per-session pending correction results (fact-check comparison)
const [pendingCorrections, setPendingCorrections] = useState<Map<string, { original: string; corrected: string; changes: string[] }>>(new Map());
const pendingCorrection = uiSessionId ? pendingCorrections.get(uiSessionId) : null;
const clearPendingCorrection = () => {
if (!uiSessionId) return;
setPendingCorrections(prev => { const next = new Map(prev); next.delete(uiSessionId); return next; });
};

// P1: Per-session pending pipeline next-step dialog
const [pendingPipelineSteps, setPendingPipelineSteps] = useState<Map<string, { contextItems: any[] }>>(new Map());
const pendingPipelineStep = uiSessionId ? pendingPipelineSteps.get(uiSessionId) : null;
const clearPendingPipelineStep = () => {
if (!uiSessionId) return;
setPendingPipelineSteps(prev => { const next = new Map(prev); next.delete(uiSessionId); return next; });
};

// 第 47 轮（D-19）：`showQuickAccess` / `QuickAccessCards` / `quickAccessFavorites`
// 三个状态随死 UI 一起删除 —— 理由见下方原渲染点处的注释（`showQuickAccess` 从来没有被设过 true）。

// D2: Pending prompt changes — per-session for parallel safety
const [pendingPromptChangesMap, setPendingPromptChangesMap] = useState<Map<string, {
changes: PromptChange[];
resolve: (result: { applied: boolean; message: string }) => void;
}>>(new Map());
const pendingPromptChanges = uiSessionId ? pendingPromptChangesMap.get(uiSessionId) : null;
const setPendingPromptChanges = (val: any) => {
  if (!val || !uiSessionId) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.set(uiSessionId, val); return next; });
};
const clearPendingPromptChanges = () => {
  if (!uiSessionId) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.delete(uiSessionId); return next; });
};

// Handle model change from chat header - sync with engine
const handleModelChange = useCallback((model: string) => {
// Abort all ongoing streaming sessions
for (const controller of abortControllersRef.current.values()) {
controller.abort();
}
abortControllersRef.current.clear();

    // Save current messages before switching models
    if (currentProject && currentSession && messages.length > 0) {
      console.log(`[ModelChange] Saving ${messages.length} messages before switching to ${model}`);
      saveMessages(currentSession.id);
    }

    setCliModel(model);
    const engine = engineRef.current; if (!engine) { console.warn('[App] engine not available'); return; }

    // Determine provider from model
    const mode = getMode();
    let provider = "openai";
    if (mode === "api") {
      if (model) {
        const resolved = resolveProviderForModel(model);
        if (resolved) provider = resolved;
      }
      setCurrentProvider(provider);
      console.log(`[ModelChange] model=${model}, provider=${provider}`);
    }

    // P0-FIX: Update model AND provider in a single call so loopPool sync is atomic.
    // Previously these were two separate updateConfig calls, causing a brief window
    // where the loop's model was new but provider was stale (or vice versa),
    // leading to dual-model token consumption.
    engine.updateConfig({ defaultModel: model, defaultProvider: provider });

    // Persist the selected model and mode to settings so it survives app restart
    try {
      const settings = getSettingJSON<any>("codem-settings", {});
      const mode = getMode();
      setSettingJSON("codem-settings", { ...settings, model, mode });
    } catch (e) {
      console.warn("[ModelChange] Failed to persist model:", e);
    }
  }, [currentMode]);
const [compactionStatus, setCompactionStatus] = useState<{ active: boolean; messagesRemoved?: number } | null>(null);
const [pendingPermissions, setPendingPermissions] = useState<Map<string, {
request: PermissionRequest;
    resolve: (result: PermissionResult) => void;
  }>>(new Map());
  // Convenience accessor: get the pending permission for the session on screen（见 `uiSessionId`）
  const pendingPermission = uiSessionId ? pendingPermissions.get(uiSessionId) : null;
  // Background permission: first pending permission from a non-current session (delegation system)
  const backgroundPermission = (() => {
    for (const [sid, val] of pendingPermissions) {
      if (!uiSessionId || sid !== uiSessionId) return { sessionId: sid, ...val };
    }
    return null;
  })();
  const setPendingPermission = (val: any) => {
    if (!val || !uiSessionId) { return; }
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.set(uiSessionId, val);
      return next;
    });
  };
  const clearPendingPermission = () => {
    if (!uiSessionId) return;
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.delete(uiSessionId);
      return next;
    });
  };
const [confirmDialog, setConfirmDialog] = useState<{
title: string;
message: string;
confirmLabel: string;
cancelLabel: string;
onConfirm: () => void;
onCancel: () => void;
} | null>(null);
// Safe project removal dialog with 3 options
const [removeProjectDialog, setRemoveProjectDialog] = useState<{
id: string; name: string; path: string;
} | null>(null);
// D2-1: 一切插件化 — 不回退到模块级单例，Provider 禁用时 engineRef 为 null
// 使用 useEffect + 重试机制等待 Provider fiber 变为 ACTIVE
const engineRef = useRef<any>(null);
useEffect(() => {
  let retry = 0
  const timer = setInterval(() => {
    const engine = getCtxService('llmEngine')
    if (engine) {
      console.log(`[App] llmEngine acquired after ${retry * 100}ms`);
      engineRef.current = engine
      clearInterval(timer)
      // engine 可用后立即尝试 configureEngine — 从 DB 读取正确的 model/mode
      // 避免 UI 长时间显示 _initialModel 的错误默认值
      configureEngine();
    } else if (++retry > 50) {
      console.warn('[App] llmEngine provider not available after 5s — check console for provide errors')
      clearInterval(timer)
    }
  }, 100)
  return () => clearInterval(timer)
}, [])
// Per-session abort controllers for parallel execution
const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
/**
 * 第 84 波（审计修正）：切换协作模式的**唯一入口**。
 *
 * 原来 UI 只是 setCollaborationMode(state)，这只影响"下一次请求"。正在跑的
 * 那个回合里 AgenticLoop.config.collaborationMode 还是旧值，PlanModeGuard 继续
 * 生效 —— 用户点了"切到 Default"，AI 这一回合照样写不了文件。
 * 现在同时把活动 loop 一起切掉。
 */
const handleModeChange = useCallback((mode: CollaborationMode): number => {
  setCollaborationMode(mode);
  const sessionId = useProjectStore.getState().currentSession?.id;
  if (!sessionId) return 0;
  try {
    return engineRef.current?.setCollaborationModeForSession?.(sessionId, mode) ?? 0;
  } catch (e) {
    console.warn("[App] Failed to switch live loop collaboration mode:", e);
    throw e;
  }
}, []);
// handleSend ref for automation callbacks (avoids stale closure)
const handleSendRef = useRef<(message: string, attachments?: any[], selectedSkills?: string[]) => void>(() => {});
const mimoSessionRef = useRef<string | null>(null);
  const messagesSessionRef = useRef<string | null>(null);
  /** Tracks which session is currently streaming — for parallel message isolation */
  const streamingSessionIdRef = useRef<string | null>(null);
  
// Streaming buffer - batch text updates to reduce re-renders
// Keyed by sessionId for parallel isolation — each session has its own buffer
const streamBufferRef = useRef<Map<string, { id: string; text: string; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
// Reasoning buffer — same pattern as text buffer, batch reasoning updates to 100ms
const reasoningBufferRef = useRef<Map<string, { id: string; text: string; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
const generatedFilesRef = useRef<Set<string>>(new Set());
/**
 * P0-1：当前正在跑的 `runAgenticLoop` 的**那份消息快照**（见 loop 里的 `loopMessages`）。
 *
 * 为什么用 ref 而不是把 `loopMessages` 直接传进来：`flushStreamBuffer` /
 * `flushReasoningBuffer` 是组件级 `useCallback`（定义在 loop 之前），
 * 而 `loopMessages` 是每次调用 loop 时新建的局部量 —— 只能通过 ref 共享。
 * 一次只有一个活跃的流式 loop（`streamingSessionIdRef` 也是同一个假设），
 * 所以单个 ref 足够；`sessionId` 用来防止"上一个 loop 的残留"被误用。
 */
const loopMessageSnapshotRef = useRef<{ sessionId: string; messages: Map<string, Message> } | null>(null);
/**
 * 把一段**流式增量**记进 loop 自己那份消息里。
 *
 * 为什么必须有：`buffer.text` 原来只在"正在查看这个会话"时才通过
 * `appendToMessage` 进 store，**非查看态直接丢弃**（`buffer.text = ""`）——
 * 于是后台会话的正文从头到尾只存在于内存 buffer 里，用户切回来时它已经没了。
 * 光把消息落库还不够：落下去的那条 `content` 会是空壳。
 *
 * ⚠️ 这里刻意**不**读 store 里那条消息（不 `useAppStore.getState().messages.find()`）：
 * 归属不一致时（用户已切走）那份列表属于别的会话，按 id 去查可能**命中别的会话的同名 id**
 * 并把两边的正文拼在一起。内容只从 loop 自己那份里取，来源单一。
 */
const appendToLoopSnapshot = (
  sessionId: string,
  messageId: string,
  text: string,
  field: "content" | "reasoning",
) => {
  const snapshot = loopMessageSnapshotRef.current;
  if (!snapshot || snapshot.sessionId !== sessionId || !text) return;
  const own = snapshot.messages.get(messageId);
  if (!own) return;
  snapshot.messages.set(messageId, { ...own, [field]: (own[field] || "") + text } as Message);
};
  const flushStreamBuffer = useCallback((sessionId?: string) => {
    const buffers = streamBufferRef.current;
    // If sessionId given, flush only that session's buffer; otherwise flush all
    const toFlush = sessionId ? [buffers.get(sessionId)].filter(Boolean) : Array.from(buffers.values());
    for (const buffer of toFlush) {
      if (!buffer) continue;
      if (buffer.id && buffer.text) {
        // Only append to UI if this session is currently being viewed
        const viewing = useProjectStore.getState().currentSession?.id;
        if (viewing === sessionId) {
          appendToMessage(buffer.id, buffer.text);
        } else if (sessionId) {
          // P0-1：**非查看态不再丢文本** —— 记进 loop 自己那份，落库时它才不是空壳
          appendToLoopSnapshot(sessionId, buffer.id, buffer.text, "content");
        }
        buffer.text = "";
      }
      buffer.timer = null;
    }
  }, [appendToMessage]);

  // Flush reasoning buffer — batch reasoning_delta updates to reduce re-renders
  const flushReasoningBuffer = useCallback((sessionId?: string) => {
    const buffers = reasoningBufferRef.current;
    const toFlush = sessionId ? [buffers.get(sessionId)].filter(Boolean) : Array.from(buffers.values());
    for (const buffer of toFlush) {
      if (!buffer) continue;
      if (buffer.id && buffer.text) {
        const viewing = useProjectStore.getState().currentSession?.id;
        if (viewing === sessionId) {
          // P3: append 增量到现有 reasoning（消息已由 reasoning_delta 创建）
          const msg = useAppStore.getState().messages.find((m) => m.id === buffer.id);
          if (msg) {
            useAppStore.getState().updateMessage(buffer.id, { reasoning: (msg.reasoning || "") + buffer.text } as any);
          }
        } else if (sessionId) {
          // P0-1：同上 —— 后台会话的 reasoning 也要进 loop 自己那份
          appendToLoopSnapshot(sessionId, buffer.id, buffer.text, "reasoning");
        }
        buffer.text = "";
      }
      buffer.timer = null;
    }
  }, []);

  // Flush all buffers on unmount
  useEffect(() => {
    return () => {
for (const buffer of streamBufferRef.current.values()) {
if (buffer.timer) clearTimeout(buffer.timer);
}
flushStreamBuffer(); // flush all on unmount
};
}, [flushStreamBuffer]);

  useEffect(() => {
    /**
     * 启动顺序（第 18 轮简化）：**只注册 Rust 存储端口**。
     *
     * 历史（P5 第 4 段）：这里曾经要"先注册端口，再决定要不要 `initDatabase()`"——
     * 因为当时默认走 Rust 但仍会加载 WASM 库，等于一点内存都没省。
     * 现在旧引擎整个不存在了：注册失败就是**没有存储**（`bootstrap` 会广播
     * `codem:storage-unavailable`，App 收到后抢救会话并提示用户），没有第二条路可退。
     */
    (async () => {
      try {
        const { registerRustStoragePort, importSettingsFromLegacyDb, migrateFromLegacyDb } = await import("./core/storage/bootstrap");

        // ① 注册端口（唯一的数据源）
        let boot: Awaited<ReturnType<typeof registerRustStoragePort>> = { kind: "skipped", reason: "未尝试" };
        try {
          boot = await registerRustStoragePort();
        } catch (e) {
          // 注册函数内部已把失败如实上报 + 广播"存储不可用"；这里只补一行诊断
          console.error("[Storage] 端口注册未预期地抛错（本进程将没有可用存储）:", e);
        }
        const rustActive = boot.kind === "registered";

        if (rustActive && boot.kind === "registered" && boot.opened) {
          console.log(`[Storage] Rust 引擎已就绪：${boot.health?.path}（${boot.health?.tables} 表 / ${boot.health?.journalMode}）`);
        }
        // 首次切到 Rust 时把配置从旧库搬过来（否则用户会觉得"设置全丢了"）。
        // 注意：此时旧库可能**根本没加载**（rust 模式下就是如此），
        // importSettingsFromLegacyDb 内部对"旧库读不到"是按"全新安装"处理的（返回 0），
        // 所以这里不会把"没加载"误报成故障。
        if (rustActive) {
          // **首次自动迁移**（P5 第 6 段）：必须在任何"读会话/消息"之前跑完。
          // 引擎是 rust 时渲染进程不再加载旧库，所以新库若是空的，界面会显示"暂无对话" ——
          // 而用户的会话其实都在旧库里。这一步由 Rust 侧只读打开旧库搬过来（含逐表对账）。
          // 幂等：新库已有会话 / 已有迁移标记时直接跳过，绝不覆盖用户在新库上的数据。
          await migrateFromLegacyDb();
          // 给"已经迁移过"的库补上搜索索引重建（中文搜索修复）。
          // 独立于迁移标记：迁移幂等会跳过，这些用户否则永远拿不到修复。
          await (await import("./core/storage/bootstrap")).repairSearchIndexOnce();
          // 旧库路径在这里解析一次并传入：让该函数的依赖显式可见（也便于测试替身）
          await importSettingsFromLegacyDb("storage.settings-import", await (await import("./core/storage/bootstrap")).legacyDbPath());
          /*
           * **启动自检：用户内容无故消失 → 从旧库恢复**（第 32 轮）。
           *
           * 放在所有迁移/修复**之后**、任何"读会话消息"之前：
           * 事故形态是"迁移对账通过、标记已写，之后内容被清空"，而渲染侧所有审计点
           * 都没记录到删除。与其继续追调用栈（已花两轮真机实验），先保证
           * **无论谁删的，用户都不真的丢数据** —— 判据三条同时成立才动手（见 self-heal.ts）。
           */
          try {
            const { verifyUserContentOrRestore } = await import("./core/storage/self-heal");
            const { legacyDbPath } = await import("./core/storage/bootstrap");
            const heal = await verifyUserContentOrRestore(await legacyDbPath());
            if (heal.kind === "restored") {
              console.warn(
                `[Storage] 自检发现消息全空（上次水位 ${heal.previous?.messages} 条）—— 已从旧库恢复 ${heal.restoredRows} 行`,
              );
            }
          } catch (e) {
            console.warn("[Storage] 启动自检未完成（不影响启动）:", e);
          }
        }

        // 第 92 波 P3 第 5 段：为**当前会话**预热事件镜像。
        //
        // 为什么要预热"当前会话"而不是全部：事件镜像的加载是按会话惰性的，
        // 而路由规则要求"镜像加载完成后读写才走 Rust"。不预热的话，
        // 当前会话在第一次访问前会把 append 写进旧库，等镜像加载完再切过去，
        // 那批事件就只在旧库里了（窗口期）。预热当前会话能把窗口期缩到最小。
        const activeId = useProjectStore.getState().currentSession?.id;
        if (activeId) {
          const { getStoragePort, hasStoragePort } = await import("./core/storage/port");
          if (hasStoragePort() && getStoragePort().kind === "rust") {
            const p = getStoragePort() as unknown as {
              warmupEvents?: (ids: string[]) => void;
              warmupMessages?: (id: string) => void;
            };
            p.warmupEvents?.([activeId]);
            // 消息索引镜像也一起预热：否则该会话第一次读会落到旧库，
            // 而旧库的 hidden 状态已经过时（写已经切到 Rust）→ 会把压缩消息复活
            p.warmupMessages?.(activeId);
          }
        }
        // 第 56 波：字号缩放必须在**数据库就绪后**应用（设置存在 SQLite 里，早期读取拿不到值）。
        // 之前启动应用的是旧扁平键 codem-font-size（通常不存在 → 13px），而设置页应用的是
        // codem-settings.fontSize（默认 14）→ 打开设置时全站突然放大且不回退。
        applyStoredUiFont();
        // Expose settings functions via globalThis for Cordis Provider plugins that
        // need settings access but can't use require() in browser (ESM) environment.
        // This acts as a service locator bridge — Provider plugins can opt-in via
        // (globalThis as any).__codemSettings?.getSettingJSON(...)
        const { getSettingJSON, setSettingJSON, getSetting, setSetting } = await import("./core/storage/settings");
        (globalThis as any).__codemSettings = { getSettingJSON, setSettingJSON, getSetting, setSetting };
        await migrateFromLocalStorage();
        setBootSplashPhase("loading-config");
        ThemeManager.init();
        // 第 61 波：恢复「对话显示模式」。
        // 这个设置此前**只写不读**（设置页把它写进 codem-display-mode，但重启后没人读回来，
        // 显示模式永远回到 store 的默认值）—— 属于"死字段"里最有存在感的一种：设置项看起来生效、实则不落地。
        try {
          const savedDisplayMode = getSetting("codem-display-mode");
          if (savedDisplayMode === "unified" || savedDisplayMode === "segmented") {
            useAppStore.getState().setDisplayMode(savedDisplayMode);
          }
        } catch { /* 读不到就用默认值 */ }
        /**
         * **域镜像预取：把"就绪窗口"挪到首屏之前**（第 12 轮）。
         *
         * 下面那段项目列表的补丁是"事后补救"（有界重试 + 重读），而且**只覆盖 projects 一个域**。
         * 其余十几个域（目标 / 收件箱 / 问题 / 团队 / 闪卡 / 画像 / 草稿 / 轮次文件变更…）
         * 都是"面板首次渲染时同步读一次"，**没有任何重读机制** ——
         * 如果那一瞬间镜像还没加载完，它们会一直显示空列表直到用户手动切换页面。
         *
         * 所以在这里（所有迁移/自检之后、**任何读会话/项目之前**）把热表拉齐：
         * 就绪的域从此永远命中；超时/被拒的域会进 `pending`，
         * 下面按"就绪即重读"注册一次性兜底（不轮询）。
         */
        try {
          const { prefetchDomainMirrors, HOT_DOMAIN_TABLES } = await import("./core/storage/bootstrap");
          const pf = await prefetchDomainMirrors();
          console.log(
            `[Storage] 域镜像预取：就绪 ${pf.ready.length}/${HOT_DOMAIN_TABLES.length}（${pf.ms}ms）` +
              (pf.pending.length > 0 ? `；未就绪：${pf.pending.join(" / ")}` : ""),
          );
          if (pf.pending.length > 0) {
            /**
             * 兜底：未就绪的表**就绪后重读一次**（一次性回调，不轮询）。
             * 判据与项目列表那条补丁同源：必须是"这张表的镜像就绪了"，
             * 而不是"端口存在"—— 否则重读会在镜像加载完成前触发，拿到的还是空。
             */
            const { domainEnsureLoaded } = await import("./core/storage/domain-store");
            for (const table of pf.pending) {
              domainEnsureLoaded(table, () => {
                console.log(`[Storage] ${table} 镜像就绪 → 重新加载一次（预取超时兜底）`);
                useProjectStore.getState().loadFromDB();
              });
            }
          }
        } catch (e) {
          console.warn("[Storage] 域镜像预取失败（不影响启动，各域按需惰性加载）:", e);
        }
        useProjectStore.getState().loadFromDB();
        // S0-3: Initialize Capability Seam — register default local providers
        /**
         * 启动竞态修正（第 24 轮）：**端口就绪前读到的是空列表，之后没人再读一次。**
         *
         * 引擎是 rust 时，读路径要等端口注册 + 镜像加载完才会接手；在此之前 listProjects()
         * 只能返回空（旧库在 rust 模式下刻意不存在，这是 P5 的既定设计）。
         * 于是首屏会一直显示"暂无项目 / 暂无对话"，而数据其实都在库里
         * （从"项目"菜单能看到 mimo-gui）—— 用户装完第一眼看到的就是这个，极易被当成数据丢了。
         *
         * 这里做**有界重试**（不是无限轮询）：端口就绪 -> 立刻重新加载一次；
         * 20 次 x 250ms = 5 秒仍未就绪就放弃（引擎真出问题时有它自己的失败上报通道，
         * 不该在这里无限重试把它掩盖掉）。
         */
        void (async () => {
          try {
            const { hasStoragePort, getStoragePort } = await import("./core/storage/port");
            // 判据必须是「projects 这张表的**镜像**已就绪」，不是「端口存在」：
            // 第一版只判 hasStoragePort()，重试在镜像加载完成前就触发，拿到的仍是空列表
            // （真机实测：日志打了"重新加载"，界面照样"暂无项目"）。
            const projectsReady = () => {
              if (!hasStoragePort()) return false;
              const port = getStoragePort() as unknown as {
                domains?: { isReady?: (t: string) => boolean };
              };
              /**
               * 第 19 轮：这里原来有一句 `if (port.kind !== "rust") return true;`
               * （"wasm 回退：旧库就是数据源"）—— 它是删旧引擎时漏下的**最后一点 A 态判断**，
               * 而且方向是反的：端口在却不是 rust 时就宣布"就绪"，于是重试根本不会触发。
               *
               * 它**恒不成立**（`kind` 已是常量 `"rust"`），删除后判据只剩一条：
               * **projects 域的镜像是否真的就绪** —— 这正是下面注释里说的、第一版踩过的坑。
               */
              return port.domains?.isReady?.("projects") === true;
            };
            for (let attempt = 0; attempt < 40; attempt++) {
              if (projectsReady()) {
                useProjectStore.getState().loadFromDB();
                console.log("[Store] 端口就绪后重新加载了项目列表（启动竞态修正）");
                return;
              }
              await new Promise((r) => setTimeout(r, 150));
            }
            console.warn("[Store] projects 镜像在 6 秒内未就绪，项目列表可能为空（引擎自身会另行上报失败原因）");
          } catch { /* 端口模块不可用：保持首次加载的结果 */ }
        })();
        // for filesystem and shell. Tools can now access these capabilities
        // through the seam registry instead of hard-importing file-api.
        // S0-3: Initialize Capability Seam — register default local providers
        const { initDefaultSeams } = await import("./core/seam/types");
        await initDefaultSeams();
        // DB is now ready — re-configure engine to read the correct mode/model/provider.
        // The initial configureEngine() in the other useEffect may have run before DB init.
        configureEngine();
        // Reload model profiles from database — they may have been loaded before DB init
        // 重试等待 Provider fiber 变为 ACTIVE
        { const tryReload = (retry = 0) => {
            const mp = getCtxService('modelProfile')
            if (mp) { mp.reload(); }
            else if (retry < 50) { setTimeout(() => tryReload(retry + 1), 100); }
          }; tryReload();
        }
      } catch (err) {
        console.error("[App] Init failed:", err);
        useProjectStore.getState().loadFromDB();
      }

      // Detect installer default language on first run (no language setting in DB)
      // NSIS installer (Chinese .exe) → default "zh"
      // MSI installer (English .msi) → default "en"
      const existingLang = getSetting("codem-language");
      if (!existingLang) {
        try {
          const { invoke } = (window as any).__TAURI__?.core || {};
          if (invoke) {
            const installerLang = await invoke("get_installer_default_lang");
            if (installerLang === "en" || installerLang === "zh") {
              setLang(installerLang);
              console.log(`[App] Detected installer language: ${installerLang}`);
            }
          }
        } catch (e) {
          console.warn("[App] Failed to detect installer language:", e);
        }
      }

      // Load identity AFTER database is ready
      const identity = loadAppIdentity();
      setAppIdentity(identity);
      if (!identity.onboarded || !identity.name) {
        setShowBootstrap(true);
      }

      // Start automation engines (file watch + timer triggers)
      try {
        const { startAutomationEngines, getAutomationConfig } = await import("./core/automation/automation-manager");
        const config = getAutomationConfig();
        if (config.triggers.length > 0) {
          startAutomationEngines((trigger) => {
            console.log(`[Automation] Triggered: ${trigger.name}`);
            // Create a new session and send the trigger message
            const session = useProjectStore.getState().createSession(`🤖 ${trigger.name}`);
            if (session) {
              handleSendRef.current(trigger.message, [], []);
            }
          });
        }
      } catch (e) {
        console.warn("[App] Automation engine startup failed:", e);
      }

      // Initialize pet system
      try {
        await loadInstalledPetsPets();
        await getPet().init();
      } catch (e) {
        console.warn("[App] Pet system init failed:", e);
      }

      // Initialize installed skills from disk
      try {
        const loaded = await loadInstalledSkills();
        console.log(`[App] Loaded ${loaded} installed skills from disk`);
      } catch (e) {
        console.warn("[App] Skills loading from disk failed:", e);
      }

      // Listen for "查看剩余 Token" requests from pet context menu
      const tauriForPet = (window as any).__TAURI__;
      if (tauriForPet?.event?.listen) {
        tauriForPet.event.listen("pet-check-tokens-request", async () => {
          try {
            const engine = engineRef.current; if (!engine) { console.warn('[App] engine not available'); return; }
            if (!engine) {
              getPet().showBubble("引擎未初始化");
              return;
            }
            // Use context manager to calculate remaining tokens for current session
            const sessionId = useProjectStore.getState().currentSession?.id;
            if (!sessionId) {
              getPet().showBubble("没有活跃会话");
              return;
            }
            const messages = MessageStorage.listMessages(sessionId);
            const budget = engine.context.calculateBudgetFromMessages(messages);
            const remaining = budget.remaining;
            const total = budget.total;
            const used = budget.used;
            getPet().showBubble(
              `剩余 Token: ${remaining.toLocaleString()} / ${total.toLocaleString()}（已用 ${used.toLocaleString()}）`,
              6000
            );
          } catch {
            getPet().showBubble("查询 Token 失败");
          }
        });
      }

      // All initialization complete — transition boot splash to ready
      setBootSplashPhase("ready");
    })();
  }, []);

  // ========== 跨会话委派系统接入 ==========
  // 监听 SessionMessageBus 的委派事件，当其他会话委派任务到当前项目会话时，
  // 自动在后台执行 executeSessionTurn。
  // 依赖 dbReady：等 DB 初始化后再创建 Orchestrator，避免 getDatabase() 报错。
  useEffect(() => {
    if (!dbReady) return;
    const bus = getSessionMessageBus();
    const orchestrator = getDelegationOrchestrator();

    // 订阅所有会话的委派消息（通配符）
    const unsub = bus.subscribeAll((msg) => {
      if (msg.type !== "delegation") return;

      // 委派请求到达：在目标会话后台执行
      const { targetSessionId, task, taskId, sourceSessionId } = msg;
      if (!task || !taskId) return;

      /**
       * 第 83 波（审计修正）：这一整段里**每一个"不执行"的分支都必须把失败写回任务**。
       *
       * 原来这些分支只是 `console.log/warn` 然后 `return`，而任务在 `delegate()` 里
       * 已经被置成 running —— 于是它**永久停在"执行中"**：委派页签永远显示在跑，
       * 父会话 `wait_for_delegation` 永远等一个不会来的结果，直到用户手动终止。
       * 这里统一走 `failTask`，让发起方**立刻**拿到"没跑起来 + 为什么"。
       */
      const failHonestly = (reason: string) => {
        console.warn(`[Delegation] 任务 ${taskId} 未能执行：${reason}`);
        try {
          orchestrator.failTask(taskId, reason);
        } catch (e) {
          console.warn('[Delegation] failTask failed:', e);
        }
      };

      // 防止重复执行
      if (isSessionExecuting(targetSessionId)) {
        failHonestly(
          `目标会话 ${targetSessionId} 正在执行另一个后台回合，本次委派没有被启动（不是排队）。` +
            `请等它结束后重新发起，或改用别的会话。`,
        );
        return;
      }

      // 获取目标会话信息
      const session = useProjectStore.getState().sessions.find((s) => s.id === targetSessionId);
      if (!session) {
        /**
         * 第 83 波（真机验证时发现）：UI store 里只有**当前项目**的会话，
         * 而委派目标可能在别的项目 / 全局作用域 —— 那时这里会直接判失败，
         * 父会话只看到"任务已创建"，要等到 wait_for_delegation 才知道对面根本没跑。
         * 所以回退到持久层再查一次；确实不存在才失败。
         */
        let persisted: any = null;
        try {
          persisted = getStoredSession(targetSessionId);
        } catch (e) {
          console.warn(`[Delegation] 查询目标会话失败: ${targetSessionId}`, e);
        }
        if (!persisted) {
          console.warn(`[Delegation] Target session not found: ${targetSessionId}`);
          orchestrator.failTask(taskId, `Target session not found: ${targetSessionId}`);
          return;
        }
        /**
         * cwd 必须按**目标会话自己所属项目**解析（真机验证时踩到）：
         * 第一版回退只用了"当前项目"的路径，而发起方常常是全局会话（没有项目）→
         * 落到兜底 `D:\mimo`（不存在）→ 目标会话里每条 bash 都失败 → 循环以 too_many_errors 收场。
         * 顺序：目标会话的 worktree > 目标会话所属项目 > 当前项目 > 兜底。
         */
        let cwdFallback = persisted.worktreePath || "";
        if (!cwdFallback && persisted.projectId) {
          try {
            cwdFallback = getStoredProject(persisted.projectId)?.path || "";
          } catch (e) {
            console.warn(`[Delegation] 解析目标会话项目路径失败: ${targetSessionId}`, e);
          }
        }
        if (!cwdFallback) cwdFallback = useProjectStore.getState().currentProject?.path || "D:\\mimo";
        const engineFallback = engineRef.current;
        if (!engineFallback) { failHonestly('LLM 引擎尚未就绪（engine not available），本次委派没有被启动。请稍后重新发起。'); return; }
        console.log(`[Delegation] Target session ${targetSessionId} 不在当前项目的 UI 列表里，改用持久层记录执行（cwd=${cwdFallback}）`);
        executeSessionTurn({
          sessionId: targetSessionId,
          message: task,
          cwd: cwdFallback,
          engine: engineFallback as any,
          delegationTaskId: taskId,
          onPermissionRequest: (request) => {
            return new Promise((resolve) => {
              setPendingPermissions((prev) => {
                const next = new Map(prev);
                next.set(targetSessionId, { request, resolve });
                return next;
              });
            });
          },
        }).catch((err) => {
          console.error(`[Delegation] executeSessionTurn failed for ${targetSessionId}:`, err);
        });
        return;
      }

      /**
       * 工作目录按**目标会话自己所属项目**解析（第 45 轮功能上下文审计 P1-I3）。
       *
       * 原来这里是 `const project = currentProject; let cwd = project?.path`，
       * 而同一文件另一条分支（目标会话不在当前项目列表里时的回退，见上面
       * `cwdFallback` 的注释）**已经**按目标会话的项目解析了 —— 同文件两条规则不一致。
       *
       * 后果是实打实的"操作 A 却按 B 的策略执行"：
       * ① 整个回合在错误的工作目录里跑（相对路径写进错的工作区、read/grep 命中错仓库）；
       * ② `executor.ts:291` 用这个 cwd 取安全模式（项目级 > 全局），于是拿到**别的项目**的覆盖值。
       *
       * 顺序与那条分支统一：目标会话的 worktree > 目标会话所属项目 > 当前项目 > 兜底。
       */
      let cwd = "";
      if (session.worktreePath) {
        cwd = session.worktreePath;
      } else if (session.projectId) {
        const targetProject = useProjectStore.getState().projects.find((p) => p.id === session.projectId);
        cwd = targetProject?.path || "";
        if (!cwd) {
          try {
            cwd = getStoredProject(session.projectId)?.path || "";
          } catch (e) {
            console.warn(`[Delegation] 解析目标会话所属项目路径失败: ${session.projectId}`, e);
          }
        }
      }
      if (!cwd) cwd = useProjectStore.getState().currentProject?.path || "D:\\mimo";
      if (cwd !== (useProjectStore.getState().currentProject?.path || "D:\\mimo")) {
        console.log(`[Delegation] cwd 按目标会话所属项目解析：session=${targetSessionId} project=${session.projectId || "(无)"} cwd=${cwd}`);
      }

      const engine = engineRef.current; if (!engine) { failHonestly('LLM 引擎尚未就绪（engine not available），本次委派没有被启动。请稍后重新发起。'); return; }

      // 后台执行（不阻塞 UI）
      executeSessionTurn({
        sessionId: targetSessionId,
        message: task,
        cwd,
        engine: engine as any,
        delegationTaskId: taskId,
        onPermissionRequest: (request) => {
          // 后台权限请求：放入 per-session Map，UI 显示通知
          return new Promise((resolve) => {
            setPendingPermissions((prev) => {
              const next = new Map(prev);
              next.set(targetSessionId, { request, resolve });
              return next;
            });
          });
        },
      }).catch((err) => {
        console.error(`[Delegation] executeSessionTurn failed for ${targetSessionId}:`, err);
        // 第 83 波：抛出来的失败同样要写回任务（否则任务停在 running，父会话干等）
        failHonestly(`后台执行抛出异常：${err?.message || String(err)}`);
      });
    });

    return () => {
      unsub();
    };
  }, [dbReady]);

  // ========== 微信 ClawBot 桥（iLink）==========
  // dbReady + 插件启用后启动引擎桥（幂等）：监听 ilink-* 事件 → peer→会话 → agent 回合 → 回复。
  // 传输层（登录/长轮询）在 Rust 常驻；插件被禁用时本 effect 不启动监听，
  // 微信消息即不再驱动 agent（与 KNOWN riskDescription 一致——审计 D2/P5 修复）。
  const wechatBridgeEnabled = !isPluginDisabled("@codem/wechat-bridge");
  useEffect(() => {
    if (!dbReady || !wechatBridgeEnabled) return;
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    import("./core/wechat-bridge/wechat-bridge")
      .then((m) => {
        if (cancelled) return;
        cleanup = m.startWechatBridge();
      })
      .catch((e) => console.warn("[wechat-bridge] start failed:", e));
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [dbReady, wechatBridgeEnabled]);

  // ========== 手机连接（phone-link，对标 dsh-phone）==========
  // dbReady + 插件启用后启动引擎半层：监听 phone-request（Rust LAN 服务代理上来的
  // /api/* 请求）→ 真实数据/引擎回合 → phone_respond；autoStart 拉起 LAN 服务。
  // 插件被禁用：不启动监听并停掉 Rust LAN 服务（已配对手机随即不可访问——D2/P5 修复）。
  const phoneLinkEnabled = !isPluginDisabled("@codem/phone-link");
  useEffect(() => {
    if (!dbReady || !phoneLinkEnabled) {
      // 禁用态兜底：若 Rust LAN 服务仍在运行则停掉（关闭外部可达面）
      try {
        (window as any).__TAURI__?.core?.invoke?.("phone_stop");
      } catch { /* noop */ }
      return;
    }
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    import("./core/phone-link/phone-link")
      .then((m) => {
        if (cancelled) return;
        cleanup = m.startPhoneLink();
      })
      .catch((e) => console.warn("[phone-link] start failed:", e));
    return () => {
      cancelled = true;
      cleanup?.();
      // 本 effect 因插件禁用/卸载而清理时，同样停掉 Rust LAN 服务
      try {
        (window as any).__TAURI__?.core?.invoke?.("phone_stop");
      } catch { /* noop */ }
    };
  }, [dbReady, phoneLinkEnabled]);

  // ========== computer-use 插件启停联动 ==========
  // 工具注册在引擎构造时无条件进行；禁用插件时把门禁标志置 false（modeGate 全拒）
  // ——与 riskDescription「关闭后 computer_* 工具不可用」一致（审计 D2/B3 修复）。
  const computerUseEnabled = !isPluginDisabled("@codem/computer-use");
  useEffect(() => {
    let cancelled = false;
    import("./core/computer-use/computer-use")
      .then((m) => {
        if (!cancelled) m.setComputerPluginEnabled(computerUseEnabled);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [computerUseEnabled]);

  // ========== 团队深合并（B）：squad_dispatch 已桥接 agent-teams ==========
  // 旧的自定义事件派发路由已删除——squad_dispatch 现在直接创建
  // agent-teams 运行时团队（见 core/squad/squad-tools.ts），不再需要 App 建
  // Leader 会话自行编排。运行时团队经 AgentTeamsService 自管理。

  // Configure engine based on mode and settings
  const configureEngine = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) {
      // engine 还不可用 — engineRef useEffect 会在获取后调用 configureEngine
      return;
    }
    const saved = getSettingJSON<any>("codem-settings", null);
    if (!saved) {
      // DB 尚未就绪 — dbReady useEffect 会在 DB 初始化后调用 configureEngine
      return;
    }

    if (saved) {
      const settings = saved;
      console.log(`[configureEngine] settings: mode=${settings.mode}, model=${settings.model}, providers=${(settings.providers||[]).map((p:any)=>p.id+':'+(p.apiKey?'Y':'N')).join(',')}`);

      // Load dynamically fetched models from DB (cached from previous refreshModels calls)
      try {
        engine.loadDynamicModels();
      } catch (e) {
        console.warn('[configureEngine] loadDynamicModels failed:', e);
      }

      // 修正历史脏数据：如果 mode=cli 但 model 是 API 模型前缀，推断为 api
      let effectiveMode = settings.mode;
      if (effectiveMode === "cli") {
        const m = settings.model || "";
        if (m.startsWith("deepseek") || m.startsWith("claude") ||
          m.startsWith("gpt") || m.startsWith("o3") || m.startsWith("gemini") ||
          m.startsWith("moonshot")) {
          effectiveMode = "api";
          console.log(`[configureEngine] dirty-data fix: mode cli→api (model=${m})`);
        }
      }
      // 如果 mode 未设置，默认为 api
      if (effectiveMode !== "cli" && effectiveMode !== "api") {
        effectiveMode = "api";
      }
      const prevMode = getMode();
      const modeChanged = effectiveMode !== prevMode;

      // Save messages before switching modes
      if (modeChanged && currentProject && currentSession && messages.length > 0) {
        saveMessages(currentSession.id);
      }

      if (effectiveMode === "cli") {
        // CLI mode: use saved model or default to mimo-v2.5-pro
        const model = settings.model || "mimo-v2.5-pro";
        console.log(`[configureEngine] CLI mode: setting model=${model}`);
        engine.updateConfig({ defaultProvider: "mimo", defaultModel: model });
        setCliModel(model);
        setCurrentMode("cli");
        setCurrentProvider("mimo");
        // Persist mode + model so it survives restart
        try {
          const s = getSettingJSON<any>("codem-settings", {});
          setSettingJSON("codem-settings", { ...s, mode: "cli", model });
        } catch (e) {
          console.warn("[Engine] Failed to persist cli mode:", e);
        }
        // D2-1: 一切插件化 — 不回退到 getMiMoAuth() 单例
        // 重试等待 Provider fiber 变为 ACTIVE
        const auth = getCtxService('mimoAuth');
        if (!auth) { console.warn('[App] mimoAuth provider not available'); return; }
        let account = auth.getActiveAccount();
        if (!account) {
          account = await auth.loadFromAuthJson();
        }
        if (account) {
          engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
          console.log("[Engine] CLI mode: loaded API key");
        } else {
          console.warn("[Engine] CLI mode: no account found, please login");
        }
      } else {
        // API mode: use configured API keys
        if (settings.providers) {
          for (const p of settings.providers) {
            if (p.apiKey) {
              if (p.custom) {
                engine.registerCustomProvider(p.id, { name: p.name, apiKey: p.apiKey, baseUrl: p.baseUrl });
              } else {
                engine.setProviderConfig(p.id, { apiKey: p.apiKey, baseUrl: p.baseUrl });
              }
              console.log(`[Engine] API mode: set ${p.id} apiKey`);
            }
          }
        }
        // Determine provider from selected model
        const model = settings.model || "";
        let provider = "openai"; // default fallback
        if (model) {
          const resolved = resolveProviderForModel(model);
          if (resolved) provider = resolved;
        }
        // If model doesn't match any provider, use first configured provider's first model
        // (custom providers resolve their first dynamic model via getFirstConfiguredModel)
        let finalModel = model;
        if (!model || provider === "openai" && !model.startsWith("gpt") && !model.startsWith("o3")) {
          const first = getFirstConfiguredModel();
          provider = first.provider;
          finalModel = first.model;
        }
        engine.updateConfig({ defaultProvider: provider, defaultModel: finalModel });
        console.log(`[configureEngine] API mode: setting model=${finalModel}, provider=${provider}`);
        setCliModel(finalModel);
        setCurrentMode("api");
        setCurrentProvider(provider);
        // Persist mode + model so it survives restart
        try {
          const s = getSettingJSON<any>("codem-settings", {});
          setSettingJSON("codem-settings", { ...s, mode: "api", model: finalModel });
        } catch (e) {
          console.warn("[Engine] Failed to persist api mode:", e);
        }
        console.log(`[Engine] API mode: provider=${provider}, model=${finalModel}`);
      }
    }
  }, []);

  useEffect(() => {
    configureEngine();
    // Listen for settings changes from SettingsPanel
    window.addEventListener("codem-settings-changed", configureEngine);
    return () => window.removeEventListener("codem-settings-changed", configureEngine);
  }, [configureEngine]);

  // Handle window close request from Rust (tray icon support)
  useEffect(() => {
    const { listen } = (window as any).__TAURI__?.event || {};
    if (!listen) return;

    let unlisten: (() => void) | undefined;
    listen("close-requested", async () => {
      const closeBehavior = getSetting("codem-close-behavior"); // "tray" | "close" | null
      if (closeBehavior === "close") {
        /**
         * 退出前把在途写入落盘（第 18 轮：`flushDatabase()` → `flushSessionLogWrites()`）。
         *
         * 旧引擎的写入有 500ms 防抖 + 整库导出，所以"退出前 flush"是必需的；
         * 端口世界的写入**是一条命令 = 一次事务**，已经落地，没有可 flush 的缓冲。
         * 但**追加日志（权威副本）**仍然是排队异步写的 —— 那才是退出前真正必须 flush 的东西。
         *
         * 第 44 轮：再加上存储端口的 stop + checkpoint（见 `finalizeBeforeQuit` 的说明：
         * 这两件事原来在生产路径上从来没做过）。
         */
        await finalizeBeforeQuit();
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("quit_app");
        return;
      }
      // 最小化到托盘前也把权威日志的在途追加写完
      void flushSessionLogWrites();
      if (closeBehavior === "tray") {
        // Minimize to tray
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("hide_to_tray");
      } else {
        // First time — show dialog
        setShowCloseConfirm(true);
      }
    }).then((un: () => void) => { unlisten = un; });

    // 崩溃检测（对标 dsh crash-evidence）：上次进程异常退出时 Rust 发出此事件。
    // 提示用户检查是否有未保存内容 / 可用恢复面板。
    let unlistenCrash: (() => void) | undefined;
    listen("previous-run-unclean", () => {
      console.warn("[App] Previous run did not exit cleanly — checking recovery");
      // 不阻塞：仅提示用户可去"设置 → 会话恢复"查看
      // 第 47 轮补：这条"上次没正常退出"的通知原来塞进引导队列 → 空闲时不可见，
      // 而它恰恰是"用户该去检查数据"的提醒。改走常驻提示通道。
      useAppStore.getState().addPersistAlert({
        area: "crash.previous-run-unclean",
        kind: "action",
        message: "检测到上次 Codem 未正常退出（可能崩溃或被强制关闭）。若发现会话内容缺失，可前往 设置 → 会话恢复 查看已保存的快照。",
      });
    }).then((un: () => void) => { unlistenCrash = un; });

    // 渲染崩溃恢复证据（对标 dsh crash-evidence）：上次界面渲染崩溃时
    // AppErrorBoundary 写入了 localStorage 标记；恢复后（reload）在此消费：
    // 提示用户已自动恢复，避免"白屏→恢复"后用户不知情。
    const rendererCrash = readRendererCrashRecord();
    if (rendererCrash) {
      clearRendererCrashRecord();
      // 第 47 轮补：同上，改走常驻提示通道（否则空闲时看不到）
      useAppStore.getState().addPersistAlert({
        area: "crash.renderer-recovered",
        kind: "action",
        message: "检测到上次界面渲染异常，已自动恢复（会话数据均保留在本地数据库）。若此提示反复出现，可在设置中检查会话快照或尝试重置界面设置。",
      });
    }

    // 存储不可用提示（第 18 轮：接替旧的 `codem:db-save-failed`）。
    //
    // 旧事件由 sql.js 的保存路径派发；旧引擎删除后没人再派发它 —— 而**"写盘失败要可见"**
    // 这件事在端口世界里由 `persist-failure.ts` 统一承担（下面的 `onPersistFail`，
    // 所有 `reportPersistFailure` 都会经过它）。所以这里不再需要第二个监听器：
    // 重复的通道只会让"同一次失败提示两遍"。
    /**
     * 第 87 波（B 类：假成功）：统一承接"写盘失败但界面照常当成功"的上报。
     *
     * 全项目曾有 31 处写/动作路径在 catch 里只打一行日志（更新会话标题、删除项目、
     * 保存权限规则、导出设置、成本上限、恢复快照……）—— 用户看到改动生效、重启后丢失。
     * 现在这些路径统一走 `reportPersistFailure` → 这里变成**一次性可见提示**
     * （同一区域只提示第一次，随后只累计次数，避免磁盘满时刷屏）。
     */
    const reportedPersistAreas = new Set<string>();
    const onPersistFail = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as
        | { area?: string; message?: string; count?: number; kind?: "persist" | "action"; consequence?: string }
        | undefined;
      const area = detail?.area || "unknown";
      if (reportedPersistAreas.has(area)) return; // 同一区域只提示一次
      reportedPersistAreas.add(area);
      /**
       * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：改走**常驻提示通道**，不再塞进引导队列
       *
       * 原来这里是 `addGuidanceMessage(...)`，而那条队列在界面上唯一的渲染点带着
       * `isSessionStreaming` 前置条件 → **用户空闲时（大多数写失败发生的时刻）
       * 界面什么都不显示**；而流式期间它又被渲染成一条"待接收引导"，其主按钮会
       * **中断正在生成的回复**（这条告警从来没进过引导队列，点下去只是打断回答）。
       *
       * 现在走 `addPersistAlert`：与流式状态无关、常驻可关闭、同区域累计次数。
       *
       * ## 第 48 轮：文案拼装抽到 `composePersistAlertText`（纯函数）
       *
       * 原因见该函数的注释：原来这段拼装写在这里，于是"横幅上到底印了什么"
       * 只能靠真机肉眼核验 —— 而真机核验抓到的正是**后果那句与真实情况矛盾**
       * （插件开关的介质对账已经把值恢复进 DB 了，横幅却说"重启应用后会丢失"）。
       * 抽出来之后文案本身可以被用例钉住。
       */
      useAppStore.getState().addPersistAlert({
        area,
        kind: detail?.kind === "action" ? "action" : "persist",
        message: composePersistAlertText({
          area,
          message: detail?.message || "未知原因",
          count: detail?.count ?? 1,
          kind: detail?.kind === "action" ? "action" : "persist",
          ...(detail?.consequence ? { consequence: detail.consequence } : {}),
        }),
      });
    };
    let unlistenPersist: (() => void) | undefined;
    window.addEventListener("codem:persist-failed", onPersistFail as EventListener);
    unlistenPersist = () => window.removeEventListener("codem:persist-failed", onPersistFail as EventListener);

    // 第 84 波：会话创建写库失败（store.createSession 上报）——
    // 该会话只存在于内存，重启后整段对话会消失，必须当场提示而不是静默。
    const onSessionPersistFail = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { sessionId?: string; error?: string } | undefined;
      // 第 47 轮补：同样走常驻提示通道（原来塞进引导队列 → 空闲时不可见）
      useAppStore.getState().addPersistAlert({
        area: "session.create",
        kind: "persist",
        message:
          `新建的会话无法写入数据库：${detail?.error || "未知原因"}。` +
          `这段对话目前只存在于内存中，重启应用后会丢失；请先复制重要内容，并检查磁盘空间/数据库文件占用。`,
      });
    };
    let unlistenSessionPersist: (() => void) | undefined;
    window.addEventListener("codem:session-persist-failed", onSessionPersistFail as EventListener);
    unlistenSessionPersist = () => window.removeEventListener("codem:session-persist-failed", onSessionPersistFail as EventListener);

    /**
     * **存储不可用 → 抢救当前会话**（第 18 轮：接替旧的 `codem:db-fatal`）。
     *
     * 旧事件由 sql.js 派发（OOM / WASM 陷阱），旧引擎删除后没人再派发它 —— 但**抢救能力本身
     * 必须留着**：新架构下"写入已经不可能成功"的唯一成因是 **Rust 引擎没起来**（端口未注册），
     * 生产者就是 `bootstrap` 的注册失败路径（`notifyStorageUnavailable`）。
     *
     * 抢救方式与旧实现一致：**直接写 JSON 文件、不经过存储层**（那时唯一还走得通的路）。
     */
    let unlistenStorageDown: (() => void) | undefined;
    const onStorageUnavailable = async (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { reason?: string; detail?: string } | undefined;
      const state = useAppStore.getState();
      const sessionId = useProjectStore.getState().currentSession?.id || "";
      let rescuePath = "";
      try {
        const msgs = state.messages || [];
        if (msgs.length > 0) {
          const { invoke } = (window as any).__TAURI__?.core || {};
          if (invoke) {
            const dir = await invoke("get_app_data_dir");
            rescuePath = `${dir}codem-session-rescue-${Date.now()}.json`;
            await invoke("write_file", {
              path: rescuePath,
              content: JSON.stringify({ sessionId, rescuedAt: new Date().toISOString(), messages: msgs }, null, 2),
            });
            console.log(`[Storage] 会话已抢救到 ${rescuePath}（${msgs.length} 条消息）`);
          }
        }
      } catch (e) {
        console.warn("[Storage] 会话抢救写入失败:", e);
      }
      // 第 47 轮补：这是最严重的一条告警（存储引擎没起来），原来塞进引导队列 →
      // 空闲时**完全不可见**。改走常驻提示通道（与流式状态无关、必须被看到）。
      useAppStore.getState().addPersistAlert({
        area: "storage.unavailable",
        kind: "persist",
        message:
          `存储引擎未启动，本次写入不会保存（原因：${detail?.reason || "未知"}）。` +
          (rescuePath ? `当前会话已抢救到：${rescuePath}。` : "") +
          "请关闭并重新打开应用后重试；若反复出现，请把上面那份 rescue 文件发我。",
      });
    };
    window.addEventListener(STORAGE_UNAVAILABLE_EVENT, onStorageUnavailable as EventListener);
    unlistenStorageDown = () => window.removeEventListener(STORAGE_UNAVAILABLE_EVENT, onStorageUnavailable as EventListener);

    // 托盘"退出"菜单 → Rust emit quit-requested：先把**权威日志的在途追加**写完再真正退出
    // （端口写入是事务、已落地；有防抖缓冲的是 JSONL 追加，见上）。
    // Rust 侧有 2.5s 兜底强退，因此这里不需要超时保护。
    let unlistenQuitReq: (() => void) | undefined;
    listen("quit-requested", async () => {
      // 第 44 轮：统一走 `finalizeBeforeQuit`（排空在途追加 + 存储端口 stop/checkpoint）
      await finalizeBeforeQuit();
      const { invoke } = (window as any).__TAURI__?.core || {};
      invoke?.("quit_app");
    }).then((un: () => void) => { unlistenQuitReq = un; });

    return () => { unlisten?.(); unlistenCrash?.(); unlistenStorageDown?.(); unlistenSessionPersist?.(); unlistenPersist?.(); unlistenQuitReq?.(); };
  }, []);

  const handleCloseChoice = useCallback(async (action: "tray" | "close", remember: boolean) => {
    setShowCloseConfirm(false);
    if (remember) {
      setSetting("codem-close-behavior", action);
    }
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (action === "tray") {
      // 最小化到托盘前把权威日志的在途追加写完
      void flushSessionLogWrites();
      invoke?.("hide_to_tray");
    } else {
      // 退出前写完在途追加；quit_app 会立刻结束 Rust 进程，所以必须 await。
      // 第 44 轮：统一走 `finalizeBeforeQuit`（含存储端口 stop/checkpoint）。
      await finalizeBeforeQuit();
      invoke?.("quit_app");
    }
  }, []);

  useEffect(() => {
    if (currentSession) {
      /**
       * 切走之前把**上一份列表**落库（第 45 轮 P0-I1）。
       *
       * 判据从 `messagesSessionRef.current`（App 级 ref，只在"主聊天切换会话"时更新）
       * 换成 `loadedSessionId`（**那份 messages 自己的归属**，与列表同一次 `set` 落定）。
       * 笔记本工作区打开时 `messages` 属于笔记本会话，而 `messagesSessionRef` 还写着主会话
       * —— 用 ref 判定就会把笔记本的列表写给主会话（被 `saveMessages` 的归属守卫拒绝 + 误报失败）。
       */
      const loaded = useAppStore.getState().loadedSessionId;
      if (loaded && loaded !== currentSession.id && messages.length > 0) {
        saveMessages(loaded);
      }
      messagesSessionRef.current = currentSession.id;
      loadMessages(currentSession.id);
      // CLI session ID is keyed by project + session; for global sessions, use "" as project ID
      const projId = currentProject?.id || "";
      const saved = loadCliSessionId(projId, currentSession.id);
      mimoSessionRef.current = saved;
    }
  }, [currentProject?.id, currentSession?.id]);

  // Auto-save messages with debounce (every 2 seconds during streaming, immediately when done)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    /**
     * ## 自动保存按"列表的归属"保存，而不是按 `currentSession`（第 45 轮 P0-I1）
     *
     * 这段原来要求 `messagesSessionRef.current === currentSession.id` 并用
     * `currentSession.id` 落库 —— 也就是"用全局当前会话去认领这份列表"。
     * 笔记本回合原来靠改写 `currentSession` 让这个判据恰好成立（于是笔记本的自动保存**
     * 反而被跳过**：`messagesSessionRef` 还是主会话，条件不成立）；
     * 一旦不再改写（本轮的修法），同一条判据就会把**笔记本的列表**当成主会话的列表去写
     * → 被 `saveMessages` 的归属守卫拒绝并每 2 秒上报一次假失败。
     *
     * 正确口径只有一个：这份 `messages` 属于谁（`loadedSessionId`）就写给谁。
     * 于是笔记本回合期间：自动保存写的是**笔记本会话**（原来是漏保存的）；
     * 主聊天：与改之前完全一致；后台会话：依旧由 loop 的显式落库负责。
     */
    const owner = loadedSessionId;
    if (owner && messages.length > 0) {
      if (isStreaming) {
        // Debounce during streaming
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          debugLog("autosave", `Debounce save: ${messages.length} messages to ${owner}`);
          saveMessages(owner);
        }, 2000);
      } else {
        // Save immediately when not streaming
        console.log(`[AutoSave] Immediate save: ${messages.length} messages to ${owner}`);
        saveMessages(owner);
      }
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, isStreaming, loadedSessionId]);

  // Save messages before unmount or session switch
  useEffect(() => {
    return () => {
      if (currentSession && messages.length > 0) {
        saveMessages(currentSession.id);
      }
    };
  }, [currentSession?.id]);

// Keep handleSendRef updated for automation callbacks (defined after handleSend below)

// ========== Send Message ==========
  /**
   * ===== 笔记本内嵌对话回调 — 复用 runAgenticLoop =====
   *
   * ## 第 45 轮修正（功能上下文审计 P0-I1）：**不再全局改写 `currentSession`**
   *
   * 原实现把笔记本会话 `setState` 成 project store 的 `currentSession`，跑完再还原，
   * 理由是"让 `runAgenticLoop` 里的 `isViewingSession()` 与 `activeNotebookId` 生效"。
   * 代价是**全 App 的"当前会话"语义在窗口期内被换掉**：
   *  - `pendingWriteConfirm` / 权限 / 澄清 / 纠错 / 流水线 / Prompt 变更这些面板
   *    全部按 `currentSession` 取值（见 `uiSessionId` 的说明）——虽然它们**写入**时用的
   *    是会话自己的 id，但"显示谁的待确认项"被换成了笔记本会话；
   *  - `App.tsx` 里按 `currentSession?.id` 触发的 effect 会跑一遍
   *    （`loadMessages(笔记本会话)`、把 `messagesSessionRef` 改成笔记本会话）；
   *  - `handleSend` / `handleRegenerate` / `handleEditAndRewind` 都在**调用时刻**读
   *    `currentSession` —— 窗口期内用户在主输入框发消息会落进**笔记本会话**；
   *  - `finally` 无条件还原快照：用户在窗口期内主动切走的会话会被**静默回滚**。
   *
   * 现在三件事各归其位（没有全局改写，也就没有"窗口期"）：
   * ① **消息归属**：面板/权限按 `uiSessionId`（在屏的会话）取值；
   * ② **UI 更新落到哪份列表**：`runAgenticLoop` 的 `isViewingSession()` 改成看
   *    **消息列表的归属**（`loadedSessionId`）——笔记本打开时那份列表就是笔记本会话的，
   *    所以流式文本照旧进笔记本界面；
   * ③ **落库**：`persistLoopMessages()` 一直就是显式的 `saveMessages(session.id, explicit)`，
   *    与 `currentSession` 无关（这也正是"后台会话"能正确落库的那条路）。
   *
   * 另外把笔记本 id **显式传进** `runAgenticLoop`：原来它读的是渲染闭包里的
   * `activeNotebookId` 状态，而 `setActiveNotebookId` 是异步的 —— 第一次发送时闭包里
   * 还是旧值（`null`），知识检索因此不会在本轮启用。显式传参没有这个时序问题。
   */
  const handleNotebookSend = async (message: string, session: Session, nbId: string) => {
    // 只记"当前打开的是哪个笔记本"（UI 横幅/引用点击用），**不动** `currentSession`
    setActiveNotebookId(nbId);
    // 调用主 agentic loop —— notebookId 由参数显式带入（见上）
    await runAgenticLoop(message, session, undefined, { notebookId: nbId });
  };

  const handleNotebookCancel = (sessionId: string) => {
    const controller = abortControllersRef.current.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(sessionId);
    }
    engineRef.current?.abortSession(sessionId);
    useAppStore.getState().setSessionActive(sessionId, false);
  };

  const handleNotebookSendGuidance = (message: string, sessionId: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    const item = engine.sendGuidance(sessionId, message);
    if (item) {
      useAppStore.getState().addGuidanceMessage({
        id: item.id,
        message,
        timestamp: item.timestamp,
        consumed: false,
      });
    }
  };

  // 笔记本内嵌对话的引用/来源点击 — 复用已有的 handler
  const handleNotebookCitationClick = (sourceName: string) => {
    if (!activeNotebookId) return;
    const sources = listSources(activeNotebookId);
    const source = sources.find(s => s.name === sourceName || s.name.includes(sourceName));
    if (source) {
      setCitationViewer({ sourceId: source.id, notebookId: activeNotebookId });
    }
  };

  const handleNotebookSourceClick = (sourceId: string, chunkIndex?: number) => {
    if (!activeNotebookId) return;
    setCitationViewer({ sourceId, notebookId: activeNotebookId, chunkIndex });
  };

  const handleSend = async (message: string, attachments?: any[], selectedSkills?: string[]) => {
// Always read latest currentSession from store (avoids stale closure)
// FIX(2026-09): 首页无会话时也可直接输入 —— 发送时自动创建"全局对话"
// （projectId=""），对标 dsh 客户端"启动即全局对话可输入"。
let session = useProjectStore.getState().currentSession;
if (!session) {
  try {
    session = useProjectStore.getState().createSession();
    console.log(`[App] No session — auto-created global session: ${session.id}`);
  } catch (e) {
    console.warn('[App] Auto-create session failed:', e);
    return;
  }
}

    // F3.2: Handle /memory slash commands
    const trimmedMessage = message.trim();

    // /computer — computer-use 会话级批准开关（对标 EAC /computer toggle）
    if (trimmedMessage === "/computer" || trimmedMessage.startsWith("/computer ")) {
      const { approveSession } = await import("./core/computer-use/computer-use");
      const nowApproved = approveSession(session.id);
      addMessage({
        id: `computer-${Date.now()}`,
        role: "system",
        content: nowApproved
          ? "✅ 电脑操作已批准：本会话允许执行 computer_* 键鼠工具（重启后需重新批准）。再次输入 /computer 撤销。"
          : "电脑操作批准已撤销：本会话不再允许执行键鼠工具（只读工具仍可用）。再次输入 /computer 重新批准。",
        timestamp: Date.now(),
        status: "done",
      });
      if (session) saveMessages(session.id);
      return;
    }

    if (trimmedMessage.startsWith("/memory")) {
      const parts = trimmedMessage.split(/\s+/);
      const subcommand = parts[1]?.toLowerCase();
      const engineInstance = engineRef.current; if (!engineInstance) { console.warn('[App] engine not available'); return; }
      const sessionId = session.id;

      if (subcommand === "off" || subcommand === "disable") {
        engineInstance.setMemoryEnabled(sessionId, false);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "记忆提取已关闭。本会话不再自动提取记忆。使用 /memory on 重新开启。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "on" || subcommand === "enable") {
        engineInstance.setMemoryEnabled(sessionId, true);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "记忆提取已开启。本会话将自动提取记忆。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "status") {
        const enabled = engineInstance.isMemoryEnabled(sessionId);
        const stats = engineInstance.getMemoryConsolidationStats(sessionId);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `记忆状态: ${enabled ? "✅ 开启" : "❌ 关闭"}\n记忆总数: ${stats.totalEntries}\n潜在重复: ${stats.potentialDuplicates}\n作用域分布: 项目=${stats.scopeBreakdown.project}, 全局=${stats.scopeBreakdown.global}, 会话=${stats.scopeBreakdown.session}`,
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else if (subcommand === "consolidate" || subcommand === "clean") {
        const result = await engineInstance.consolidateMemories(sessionId);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `记忆整合完成：合并 ${result.duplicatesMerged} 条重复，清理 ${result.staleRemoved} 条过期，裁剪 ${result.capacityTrimmed} 条超额。`,
          timestamp: Date.now(),
          status: "done",
        });
        return;
      } else {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "用法：\n/memory on — 开启记忆提取\n/memory off — 关闭记忆提取\n/memory status — 查看记忆状态\n/memory consolidate — 手动整合记忆",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      }
    }

    // F3.3: Handle /generate-agents slash command
    if (trimmedMessage === "/generate-agents" || trimmedMessage === "/gen-agents") {
      const projectPath = currentProject?.path;
      if (!projectPath) {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "❌ 未找到项目路径，请先打开一个项目。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      }
      addMessage({
        id: `system-${Date.now()}`,
        role: "system",
        content: "🔍 正在分析项目结构并生成 AGENTS.md...",
        timestamp: Date.now(),
        status: "done",
      });
      try {
        const { generateAgentsMd } = await import("./core/project/files");
        const { writeFile } = await import("./core/file-api");
        const content = await generateAgentsMd(projectPath);
        await writeFile(`${projectPath}\\AGENTS.md`, content);
        addMessage({
          id: `system-${Date.now() + 1}`,
          role: "system",
          content: `✅ AGENTS.md 已生成并写入项目根目录。\n\n生成内容摘要：\n- 检测技术栈和框架\n- 识别项目结构\n- 推断构建/测试/lint 命令\n- 生成代码规范和 AI 规则\n\n你可以编辑 AGENTS.md 来补充更多项目特定信息。`,
          timestamp: Date.now(),
          status: "done",
        });
      } catch (e: any) {
        addMessage({
          id: `system-${Date.now() + 1}`,
          role: "system",
          content: `❌ 生成 AGENTS.md 失败：${e?.message || e}`,
          timestamp: Date.now(),
          status: "done",
        });
      }
      return;
    }

    // R3-2.2: /feedback command — record session-level feedback
    if (trimmedMessage.startsWith("/feedback")) {
      const feedbackText = trimmedMessage.slice("/feedback".length).trim();
      if (!feedbackText) {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: "用法：/feedback <反馈内容>\n示例：/feedback 这个会话非常有帮助，帮我解决了架构问题。",
          timestamp: Date.now(),
          status: "done",
        });
        return;
      }
      try {
        const { recordSessionFeedback } = await import("./core/llm/feedback");
        recordSessionFeedback(session.id, feedbackText);
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `✅ 反馈已记录到会话 ${session.id.substring(0, 8)}... 的事件日志中。`,
          timestamp: Date.now(),
          status: "done",
        });
      } catch (e: any) {
        addMessage({
          id: `system-${Date.now()}`,
          role: "system",
          content: `❌ 记录反馈失败：${e?.message || e}`,
          timestamp: Date.now(),
          status: "done",
        });
      }
      return;
    }

    useProjectStore.getState().updateSession(session.id, {
      messageCount: session.messageCount + 1,
      lastMessageAt: Date.now(),
    });

    let userContent = message;
    if (attachments && attachments.length > 0) {
      // Sync attachments to the workspace .attachments/ directory so the LLM
      // can use read/grep/glob tools on them directly (Wegent-style sandbox sync).
      const cwd = currentProject?.path || await getAppRoot();
      const syncedAttachments = await syncAttachmentsToWorkspace(attachments, cwd);

      // Wegent-style: inline attachment content with truncation annotations
      // Small files (< 4KB) are fully inlined; large files get head+tail preview
      // LLM naturally calls read_attachment when it sees "Truncated: yes"
      const attachmentInfo = formatAttachmentsInline(syncedAttachments);
      userContent = attachmentInfo + (message ? "\n\n" + message : "");

      // Use synced attachments (with sandboxPath) for the message
      addMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        status: "done",
        attachments: syncedAttachments,
      });
    } else {
      addMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: userContent,
        timestamp: Date.now(),
        status: "done",
      });
    }

    // Immediately save to database so agentic loop can read it
    saveMessages(session.id);

      await runAgenticLoop(message, session, selectedSkills);
  };

  // P1-5: Save last AI response as a note in the active notebook
  const handleSaveAIResponseAsNote = () => {
    if (!activeNotebookId) return;
    // Find the last AI message
    const lastAIMessage = [...messages].reverse().find(m => m.role === 'assistant' && m.content.trim());
    if (!lastAIMessage) {
      alert(lang === 'zh' ? '没有可保存的 AI 回复' : 'No AI response to save');
      return;
    }
    const title = lang === 'zh'
      ? `AI回复 ${new Date().toLocaleString('zh-CN')}`
      : `AI Response ${new Date().toLocaleString('en-US')}`;
    createNote({ notebookId: activeNotebookId, title, content: lastAIMessage.content });
    alert(lang === 'zh' ? '已保存为笔记' : 'Saved as note');
  };

  // B4: Handle citation click — find source by name and open SourceViewer
  const handleCitationClick = useCallback((sourceName: string) => {
    if (!activeNotebookId) return;
    const sources = listSources(activeNotebookId);
    // Try exact match first, then partial match
    const source = sources.find(s => s.name === sourceName)
      || sources.find(s => s.name.toLowerCase() === sourceName.toLowerCase())
      || sources.find(s => s.name.toLowerCase().includes(sourceName.toLowerCase()));
    if (source) {
      setCitationViewer({ sourceId: source.id, notebookId: activeNotebookId });
    }
  }, [activeNotebookId]);

  // Handle source click from structured metadata — directly use sourceId (no name lookup needed)
  const handleSourceClick = useCallback((sourceId: string, chunkIndex?: number) => {
    if (!activeNotebookId) return;
    setCitationViewer({ sourceId, notebookId: activeNotebookId, chunkIndex });
  }, [activeNotebookId]);

  // Keep handleSendRef updated for automation callbacks (avoids stale closure)
  useEffect(() => {
    handleSendRef.current = handleSend;
  });

  // ========== Guidance (mid-turn steering) ==========
  // Send a guidance message to the currently running agentic loop.
  // The message is enqueued and will be consumed at the next iteration boundary.
  const handleSendGuidance = useCallback((message: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    const engine = engineRef.current; if (!engine) { console.warn('[App] engine not available'); return; }
    const item = engine.sendGuidance(session.id, message);
    if (item) {
      // Add to guidance messages in the store for UI display (id matches the queue item)
      addGuidanceMessage({
        id: item.id,
        message,
        timestamp: item.timestamp,
        consumed: false,
      });
      console.log(`[Guidance] Sent to session ${session.id}: "${message.substring(0, 80)}..."`);
    } else {
      console.warn(`[Guidance] Failed to send — no active loop for session ${session.id}`);
    }
  }, [addGuidanceMessage]);

  const handleSendGuidanceImmediate = useCallback((message: string, existingGuidanceId?: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    const engine = engineRef.current; if (!engine) { console.warn('[App] engine not available'); return; }
    if (existingGuidanceId) {
      // "Inject now" on an already-pending guidance bubble: the message is already
      // in the queue — just interrupt the current reply so it takes effect now.
      const ok = engine.interruptForGuidance(session.id);
      if (ok) {
        removeGuidanceMessage(existingGuidanceId);
        console.log(`[Guidance] Injecting pending guidance now: "${message.substring(0, 80)}..."`);
      } else {
        console.warn(`[Guidance] Failed to interrupt for pending guidance — no active loop for session ${session.id}`);
      }
      return;
    }
    const item = engine.sendGuidanceImmediate(session.id, message);
    if (item) {
      addGuidanceMessage({
        id: item.id,
        message,
        timestamp: item.timestamp,
        consumed: false,
      });
      console.log(`[Guidance] Sent (immediate) to session ${session.id}: "${message.substring(0, 80)}..."`);
    } else {
      console.warn(`[Guidance] Failed to send (immediate) — no active loop for session ${session.id}`);
    }
  }, [addGuidanceMessage, removeGuidanceMessage]);

  // Listen for immediate guidance events from ChatPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) {
        handleSendGuidanceImmediate(detail.message, detail.guidanceId);
      }
    };
    window.addEventListener('codem-guidance-immediate', handler);
    return () => window.removeEventListener('codem-guidance-immediate', handler);
  }, [handleSendGuidanceImmediate]);

  /**
   * Run the agentic loop — shared by handleSend and handleRegenerate.
   * This function handles provider setup, streaming, tool calls, and
   * all event processing from the LLM engine.
   */
  /**
   * 跑一轮 agentic loop（前台）。
   *
   * @param opts.notebookId 笔记本知识检索的会话级开关（**显式传参**，第 45 轮 P0-I1）：
   *   笔记本回调传 `nbId`，其余路径沿用"当前打开的笔记本"状态。
   *   为什么不只读状态：`setActiveNotebookId` 是异步的，而本函数是渲染闭包 ——
   *   笔记本工作区里的**第一次**发送读到的仍是旧值（`null`），知识检索不会生效。
   *
   * ## P1-I2（第 45 轮功能上下文审计）：同一会话不允许并发两轮
   *
   * `AgenticLoop` 实例是**按会话池化复用**的，而 `run()` 的第一件事就是覆盖
   * `abortController` / `state` / `currentSessionId`（`agentic-loop.ts:787–795`）。
   * 前台（这里）与后台（`executeSessionTurn`：委派 / 微信桥 / 手机续聊）若同时进入同一会话，
   * 两轮会互相清空 `readCache` / `writeCache`、共用 `msgCache` 与 `securityMode` ——
   * 表现是"工具调用被判成重复而跳过""上下文少一段""停止停错会话"。
   *
   * 后台入口一直有守卫（`isSessionExecuting`）；**前台入口原来没有任何守卫**。
   * 现在用同一个登记表（`startSessionExecution` / `endSessionExecution`，与
   * `executeSessionTurn` 共用 `activeExecutions`）：两个方向互相可见。
   * 整个函数体包在 `try/finally` 里 → **所有**早退路径（含"引擎没就绪""认证失败"）
   * 都会注销登记，不会把这个会话永久卡成"正在执行中"。
   */
  const runAgenticLoop = async (
    message: string,
    session: Session,
    selectedSkills?: string[],
    opts?: { notebookId?: string },
  ) => {
    if (!session) return;
    if (isSessionExecuting(session.id)) {
      console.warn(`[runAgenticLoop] 会话 ${session.id} 已在执行中 —— 前台回合被拒绝（同一会话不并发）`);
      addMessage({
        id: `busy-${Date.now()}`,
        role: "system",
        content: "[Error] 这个会话已有一轮正在执行中（可能是后台委派 / 微信桥 / 手机续聊）。请等它结束，或先点停止。",
        timestamp: Date.now(),
        status: "error",
      });
      return;
    }
    startSessionExecution(session.id);
    try {
    const notebookIdForLoop = opts?.notebookId ?? activeNotebookId;


    const mode = getMode();
    const engine = engineRef.current;
    if (!engine) {
      console.warn('[App] engine not available — llmEngine provider not registered');
      addMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: '[Error] LLM Engine 未初始化。请检查控制台日志中的 [Cordis] 错误信息。',
        timestamp: Date.now(),
        status: 'error',
      });
      return;
    }

    

    const provider = engine.getDefaultProvider();
    const model = engine.getDefaultModel();
    console.log(`[runAgenticLoop] provider=${provider}, model=${model}, mode=${mode}`);

    const providerObj = engine.providers.get(provider);
    

    if (mode === "cli") {
      // D2-1: 一切插件化 — 不回退到 getMiMoAuth() 单例
      const auth = getCtxService('mimoAuth');
      if (!auth) { console.warn('[App] mimoAuth provider not available'); return; }
      let account = auth.getActiveAccount();
      if (!account) {
        account = await auth.loadFromAuthJson();
      }
      if (!account) {
        addMessage({
          id: 'err-' + Date.now(),
          role: 'system',
          content: '[Error] MiMo auth not found. Please login first.',
          timestamp: Date.now(),
          status: "error",
        });
        return;
      }
      engine.setProviderConfig("mimo", { apiKey: account.accessToken, baseUrl: account.url });
    }

    
setStreaming(true);
useAppStore.getState().setSessionActive(session.id, true);
streamingSessionIdRef.current = session.id;

    const providerName = engine.getDefaultProvider();
    const modelName = engine.getDefaultModel();
    console.log(`[runAgenticLoop] pre-process check: provider=${providerName}, model=${modelName}`);

    const providerObj2 = engine.providers.get(providerName);

    // 从 DB 重新加载 provider API keys（修复 configureEngine 时序竞争）
    try {
      const _savedSettings = getSettingJSON<any>("codem-settings", null);
      if (_savedSettings?.providers) {
        for (const p of _savedSettings.providers) {
          if (p.apiKey) {
            if (p.custom) {
              engine.registerCustomProvider(p.id, { name: p.name, apiKey: p.apiKey, baseUrl: p.baseUrl });
            } else {
              engine.setProviderConfig(p.id, { apiKey: p.apiKey, baseUrl: p.baseUrl });
            }
          }
        }
      }
    } catch (e) { console.warn('[runAgenticLoop] failed to reload provider keys:', e) }

    console.log(`[runAgenticLoop] provider=${providerName}, isConfigured=${providerObj2?.isConfigured()}`);

    if (providerObj2 && !providerObj2.isConfigured() && providerName !== "mimo") {
      const savedSettings = getSettingJSON<any>("codem-settings", null);
      const providerInfo = savedSettings?.providers?.find((p:any) => p.id === providerName);
      console.warn(`[runAgenticLoop] ${providerName} not configured. DB has apiKey: ${!!providerInfo?.apiKey}`);
      setStreaming(false);
      useAppStore.getState().setSessionActive(session.id, false);
      streamingSessionIdRef.current = null;
      addMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: `[Error] ${providerName} not configured.\n\nDebug: DB has settings=${!!savedSettings}, providers=${savedSettings?.providers?.length || 0}, ${providerName} hasKey=${!!providerInfo?.apiKey}`,
        timestamp: Date.now(),
        status: 'error',
      });
      return;
    }

    // Determine cwd: use worktree path if session has one, otherwise project path
    let cwd = currentProject?.path || await getAppRoot();
    if (session.worktreePath) {
      cwd = session.worktreePath;
    } else if (session.executionMode === "git_worktree" && currentProject?.path) {
      // Session wants worktree mode but doesn't have a path yet — create one
      try {
        const { createWorktree, getProjectExecutionMode } = await import("./core/environment");
        const wtPath = await createWorktree(currentProject.path, session.id, session.worktreeBranch);
        cwd = wtPath;
        // Persist the worktree path on the session
        useProjectStore.getState().updateSession(session.id, { worktreePath: wtPath });
        session.worktreePath = wtPath;
      } catch (e) {
        console.error("[App] Failed to create worktree, falling back to project dir:", e);
        addMessage({
          id: `wt-err-${Date.now()}`,
          role: "system",
          content: lang === "zh"
            ? `❌ 工作树创建失败，使用本地目录: ${e instanceof Error ? e.message : String(e)}`
            : `❌ Worktree creation failed, using local dir: ${e instanceof Error ? e.message : String(e)}`,
          timestamp: Date.now(),
          status: "error",
        });
      }
    }
    // Show success toast if worktree was just created
    if (session.worktreePath && session.executionMode === "git_worktree" && cwd === session.worktreePath) {
      addMessage({
        id: `wt-ok-${Date.now()}`,
        role: "system",
        content: lang === "zh" ? `🌲 工作树已创建: ${session.worktreePath}` : `🌲 Worktree created: ${session.worktreePath}`,
        timestamp: Date.now(),
        status: "done",
      });
    }
    let assistantMsgId = `assistant-${Date.now()}`;
    let assistantContent = "";
    let reasoningContent = "";
    let lastAssistantMsgId = "";

    // Record start time for execution timer
    useAppStore.getState().setStreamStartTime(Date.now());

    /**
     * ===== P0-1：这个 loop **自己的那份消息列表**（跨会话污染的修法） =====
     *
     * ## 为什么必须由 loop 自己记
     *
     * 原来的 `safeAddMessage` 长这样：
     * ```
     * if (isViewingSession()) addMessage(msg);
     * if (session) saveMessages(session.id);          // ← 注释写着 "Always persist to DB regardless"
     * ```
     * 两句合起来是**两个方向都错**：
     *
     * 1. `saveMessages(sessionId)` 内部写的是 `get().messages`，也就是"**当前加载的那个会话**"
     *    的列表 —— 用户切走之后那份列表属于别的会话，于是**别的会话的消息被按本会话落库**
     *    （权威 JSONL 按 sessionId 决定文件名，读路径还会把它合并显示出来）；
     * 2. `addMessage` 被"只在查看时更新 UI"拦掉之后，"持久化"实际上依赖 store 列表 ——
     *    于是**后台会话自己产生的 App 级消息一条都没落库**，注释里那句承诺是假的
     *    （真机形态：后台跑完一轮，切回去看不到那轮的系统消息/工具消息）。
     *
     * 修法：loop 维护自己创建/更新的那几条消息（下面的 `loopMessages`），落库一律走
     * `saveMessages(session.id, [...loopMessages.values()])` —— **explicit 形态**，
     * 于是"写谁的消息"由 loop 自己声明，与用户当前在看哪个会话彻底解耦。
     *
     * ## 为什么初始要装一份"快照"而不是空 Map
     *
     * loop 开始时（用户还在看这个会话）store 里那份列表就是本会话的当前全量；
     * 把它装进来，loop 的落库才是"本会话的完整列表"。否则一旦用户切走，
     * loop 再落库就只剩自己新建的几条，而 store 里那份**本会话**的既有消息
     * 再也不会有任何调用点去写（autosave 也被 `messagesSessionRef` 挡住了）。
     *
     * 快照只在归属一致时取（`loadedSessionId === session.id`）—— 不一致说明
     * store 里那份是别的会话的，一条都不能进 loop 的这份。
     */
    const loopMessages = new Map<string, Message>();
    {
      const store = useAppStore.getState();
      if (store.loadedSessionId === session.id) {
        for (const m of store.messages) loopMessages.set(m.id, m);
      }
    }
    /**
     * 把这个 loop 的这份快照挂到组件级 ref 上，供上面的
     * `appendToLoopSnapshot`（流式 buffer 的两条 flush 路径）写入。
     * loop 结束时清掉，避免下一个会话的 loop 误用上一轮的残留。
     */
    loopMessageSnapshotRef.current = { sessionId: session.id, messages: loopMessages };

    /**
     * 落库：**只写本 loop 自己那份**（explicit），并返回同一个 Map 供上层同步取用。
     *
     * 选 `saveMessages(session.id, explicit)` 而不是直接 `MessageStorage.createMessage(msg, session.id)`：
     * - 前者保留了 `saveMessages` 既有的两件事 —— 指纹去重（第 91 波：长会话下绝大多数消息
     *   内容没变，不该反复写库）与统一失败上报（`reportPersistFailure("store.saveMessages")`）；
     * - 后者会绕开它们，把"每次 start/tool_start/tool_complete/tool_error/finally 都全量重写"
     *   请回来（那正是存储压力的来源），而且失败再也不可见。
     * 另外它就是**同步**的（内部逐条同步 `MessageStorage.createMessage`），不引入 await。
     */
    const persistLoopMessages = () => {
      if (!session) return;
      saveMessages(session.id, [...loopMessages.values()]);
    };

    // Helper: check if this session's messages are the ones currently loaded in the UI
    /**
     * ## 判据换成"消息列表的归属"（第 45 轮功能上下文审计 P0-I1）
     *
     * 原来是 `useProjectStore.getState().currentSession?.id === session.id`。这条判据
     * 依赖"全局当前会话"这一个状态，而笔记本回合正是靠**改写它**才让流式文本进界面的
     * （见 `handleNotebookSend` 的长注释）。现在不做那次改写了，判据改为问一个更直接的事实：
     * **这份消息列表装的是不是这个会话的消息**（`loadedSessionId`，它与列表在同一次 `set`
     * 里落定，见 `src/store.ts:334–342`）。
     *
     * - 笔记本工作区打开时，它自己 `loadMessages(笔记本会话)`（`NotebookWorkspace.tsx:364`）
     *   → `loadedSessionId` 就是笔记本会话 → 本会话的流式更新照旧进界面 ✅；
     * - 后台会话（用户已切走）→ 两个判据都不成立 → 只落库、不碰界面 ✅（与既有行为一致）；
     * - 新建会话的开头一瞬（`loadMessages` 还没跑）→ 保留"当前会话"这一支兜底 ✅。
     */
    const isViewingSession = () => {
      if (useAppStore.getState().loadedSessionId === session.id) return true;
      const viewing = useProjectStore.getState().currentSession?.id;
      return viewing === session.id;
    };
    /**
     * Safe message helpers：**UI 只在查看这个会话时更新**（这条行为不变），
     * 但**落库与查看态无关** —— 一律写 loop 自己那份（上面 `persistLoopMessages`）。
     *
     * ⚠️ 这几个 helper 必须定义在 `try` **之外**：`catch` 分支也要用
     * （原来的 `catch` 里那句裸 `addMessage` 会把错误气泡加进"当前显示的会话"）。
     */
    const safeAddMessage = (msg: Message) => {
      // 先记进 loop 自己那份：即使此刻没在看这个会话，这条也必须有归属、必须落库
      loopMessages.set(msg.id, msg);
      if (isViewingSession()) addMessage(msg);
      persistLoopMessages();
    };
    const safeUpdateMessage = (id: string, update: any) => {
      // loop 自己那份同步更新（落库时写的才是"最新版本"，而不是创建时的空壳）
      const own = loopMessages.get(id);
      if (own) loopMessages.set(id, { ...own, ...update });
      if (isViewingSession()) useAppStore.getState().updateMessage(id, update);
    };
    /**
     * 工具调用的等价物。
     *
     * 原实现是 `if (isViewingSession()) addToolCall(...)` / `updateToolCall(...)` —— 于是
     * **非查看态那次工具调用根本没进 loop 的这份列表**，落库写下去的消息永远是"没有工具调用"
     * 的版本。而下一轮迭代要从存储里读回工具调用来构造上下文
     * （见下面 `Immediately save tool call so agentic loop can read it` 的注释），
     * 读到的就是缺了 `result` 的旧版本 → 模型看不到自己刚拿到的结果（会反复重发同一个调用）。
     * 这里把两边都做：UI 仍然只在查看时更新，loop 自己那份无论何时都更新。
     */
    const applyToolCallToOwnCopy = (
      messageId: string,
      mutate: (toolCalls: ToolCall[]) => ToolCall[],
    ) => {
      const own = loopMessages.get(messageId);
      if (!own) return;
      loopMessages.set(messageId, { ...own, toolCalls: mutate(own.toolCalls || []) });
    };
    const safeAddToolCall = (messageId: string, toolCall: ToolCall) => {
      applyToolCallToOwnCopy(messageId, (list) =>
        list.some((t) => t.id === toolCall.id)
          ? list.map((t) => (t.id === toolCall.id ? { ...t, ...toolCall } : t))
          : [...list, toolCall],
      );
      if (isViewingSession()) addToolCall(messageId, toolCall);
    };
    const safeUpdateToolCall = (messageId: string, toolId: string, update: Partial<ToolCall>) => {
      applyToolCallToOwnCopy(messageId, (list) =>
        list.map((t) => (t.id === toolId ? { ...t, ...update } : t)),
      );
      if (isViewingSession()) updateToolCall(messageId, toolId, update);
    };

    // Watchdog timer lives outside try so the finally block can clear it.
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    try {
console.log(`[runAgenticLoop] starting engine.process for session=${session.id}`);
const sessionAbort = new AbortController();
abortControllersRef.current.set(session.id, sessionAbort);

      // 事件级 idle 看门狗：仅当连续 WATCHDOG_IDLE_MS 无任何事件输出才触发。
      // 触发后 abort 该会话底层 LLM 调用并强制清理状态，让会话恢复可用。
      let lastEventAt = Date.now();
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastEventAt > WATCHDOG_IDLE_MS) {
          console.warn(`[runAgenticLoop] Watchdog: no events for ${WATCHDOG_IDLE_MS}ms — aborting session ${session.id}`);
          sessionAbort.abort();
          engineRef.current?.abortSession(session.id);
          useAppStore.getState().setSessionActive(session.id, false);
          setStreaming(false);
          streamingSessionIdRef.current = null;
          safeAddMessage({
            id: 'watchdog-' + Date.now(),
            role: 'system',
            content: '⚠️ 任务超过 15 分钟无响应，已自动终止（可能是 LLM 服务端无响应）。请重试。',
            timestamp: Date.now(),
            status: 'error',
          });
        }
      }, WATCHDOG_CHECK_MS);

      let lastEvent: any = undefined;
      for await (const event of engine.process(session.id, message, cwd, undefined, {
        onPermissionRequest: (request) => {
          return new Promise((resolve) => {
            // Per-session: set permission for this specific session
            setPendingPermissions(prev => {
              const next = new Map(prev);
              next.set(session.id, { request, resolve });
              return next;
            });
          });
        },
        collaborationMode,
        // S4: Wire up write confirmation for diff review (inline, non-modal)
        onWriteConfirm: (params) => {
          // Check if user has enabled auto-approve for this session
          const stat = writeConfirmStats.get(session.id);
          if (stat?.autoApprove) {
            return Promise.resolve({ action: "accept" as const });
          }
          return new Promise((resolve) => {
            // Per-session: set write confirm for this specific session
            setPendingWriteConfirms(prev => {
              const next = new Map(prev);
              next.set(session.id, { ...params, resolve });
              return next;
            });
            // Increment count for this session
            setWriteConfirmStats(prev => {
              const next = new Map(prev);
              const cur = next.get(session.id) || { count: 0, autoApprove: false };
              next.set(session.id, { ...cur, count: cur.count + 1 });
              return next;
            });
          });
        },
        // Deep thinking: read reasoning effort from settings (set via model picker dropdown)
        ...((() => {
          const effort = getSettingJSON<string>("codem-reasoning-effort", "high");
          if (effort && effort !== "off") {
            return { reasoningEffort: effort as "low" | "medium" | "high" | "ultra" };
          }
          return {};
        })()),
        // Security mode: three-tier approval policy
        securityMode,
        // D2: Prompt optimization callbacks
        getSystemPrompt: () => {
          // Return the current system prompt from the engine
          return engine.buildSystemPrompt(session.id, undefined, cwd);
        },
        onPromptChangeSubmit: (changes: PromptChange[]) => {
          return new Promise((resolve) => {
            setPendingPromptChangesMap(prev => {
              const next = new Map(prev);
              next.set(session.id, { changes, resolve });
              return next;
            });
          });
        },
        // D3: Interactive form callback
        onInteractiveForm: (questions: InteractiveFormQuestion[]) => {
          return new Promise((resolve) => {
            setPendingInteractiveForms(prev => {
              const next = new Map(prev);
              next.set(session.id, { questions, resolve });
              return next;
            });
          });
        },
        // F5: Notebook knowledge mode（显式传参优先 —— 见 runAgenticLoopInner 的说明）
        ...(notebookIdForLoop ? { notebookId: notebookIdForLoop } : {}),
        // User-selected skills (injected with 🎯 marker in system prompt)
        ...(selectedSkills && selectedSkills.length > 0 ? { userSelectedSkills: selectedSkills } : {}),
      })) {
        if (sessionAbort.signal.aborted) break;
        lastEventAt = Date.now();

        switch (event.type) {
          case "knowledge_sources": {
            // Auto-retrieved knowledge sources from notebook RAG
            // Create assistant message if it doesn't exist yet (sources arrive before text)
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                status: "streaming",
                retrievedSources: event.sources,
              });
              // Don't saveMessages here — the empty streaming message will be
              // persisted when text_delta or tool_start arrives with actual content.
              // Saving an empty message triggers unnecessary DB writes and event log
              // duplication during streaming.
            } else {
              safeUpdateMessage(assistantMsgId, {
                retrievedSources: event.sources,
              } as any);
            }
            break;
          }

          case "reasoning_delta":
            reasoningContent += event.text;
            // Create assistant message if it doesn't exist yet (reasoning often arrives before text)
            // 判据同 text_delta：问 loop 自己那份，而不是"当前显示的那个会话"的列表（P0-1）
            if (!loopMessages.has(assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                content: "",
                timestamp: Date.now(),
                status: "streaming",
              });
            }
            // Batch reasoning updates to 100ms — same pattern as text_delta buffer.
            // Without this, every reasoning token triggers a store update and
            // full message list re-render, causing UI freeze on long responses.
            {
              let rbuf = reasoningBufferRef.current.get(session.id);
              if (!rbuf) { rbuf = { id: "", text: "", timer: null }; reasoningBufferRef.current.set(session.id, rbuf); }
              rbuf.id = assistantMsgId;
              // P3: 增量累积 —— 原来存全量 reasoningContent，flush 时整段 replace，
              // 长 reasoning 每次 100ms 都传递整段大字符串。改为只累积增量。
              rbuf.text += event.text;
              if (!rbuf.timer) {
                rbuf.timer = setTimeout(() => flushReasoningBuffer(session.id), 100);
              }
            }
            break;

          case "start": {
            // Each iteration gets its own assistant message so the LLM sees
            // clear iteration boundaries in its context. Previously all
            // iterations accumulated into one giant message, causing the LLM
            // to lose track of which tool results belonged to which iteration.
            //
            // Both unified and segmented modes create separate DB messages per
            // iteration. The difference is purely visual: unified mode collapses
            // reasoning and tool calls by default (handled in MessageBubble.tsx
            // via displayMode === "unified" check).
            const iter = 'iteration' in event ? event.iteration : 1;
            if (iter > 1) {
// Finalize previous, create new message — same for both modes
flushStreamBuffer(session.id);
flushReasoningBuffer(session.id);
              if (loopMessages.has(assistantMsgId)) {
                safeUpdateMessage(assistantMsgId, {
                  status: "done",
                  reasoning: reasoningContent || undefined,
                } as any);
                // P0-1：写 loop 自己那份（不能用无 explicit 的 saveMessages —— 那会写"当前显示的会话"）
                persistLoopMessages();
              }
              // Start a new assistant message for this iteration
              lastAssistantMsgId = assistantMsgId;
              assistantMsgId = `assistant-${Date.now()}-${iter}`;
              assistantContent = "";
              reasoningContent = "";
              generatedFilesRef.current.clear();
            }
            break;
          }

          case "llm_status": {
            // State-based connection tracking — no timers, just state transitions
            // connecting → streaming → executing_tools → (next iteration or done)
            setLLMStatus(event.status);
            // Bridge to pet system
            getPet().onLLMStatus(event.status);
            // 大肥鱼式状态卡：LLM 状态 → 阶段
            if (event.status === "connecting" || event.status === "streaming") {
              updatePetCard({ phase: lang === "zh" ? "思考中" : "thinking" });
            } else if (event.status === "executing_tools") {
              updatePetCard({ phase: lang === "zh" ? "执行中" : "working" });
            }
            break;
          }

          case "step_progress": {
            // Deterministic step progress from the agentic loop itself
            useAppStore.getState().setStepProgress({
              current: event.step,
              total: event.total ?? 0,
              title: event.title || "",
              steps: event.steps?.map(s => ({ title: s.title })) ?? null,
            });
            // P0-2: 步骤进度气泡
            const stepTitle = event.title || `步骤 ${event.step}`;
            const stepTotal = event.total ? `/${event.total}` : "";
            getPet().showRawBubble(`${stepTitle}${stepTotal}`, 3000);
            // 大肥鱼式状态卡：真实步骤进度
            updatePetCard({
              phase: phaseByPetState["thinking"] || undefined,
              step: { current: event.step, total: event.total ?? null, title: event.title || undefined },
              message: stepTitle,
            });
            break;
          }

          case "text_delta":
            assistantContent += event.text;
            /*
             * 判据换成 loop 自己那份（P0-1）。原来问的是 `useAppStore.getState().messages`：
             * 用户切走之后那份列表属于**别的**会话，这里永远查不到 → 每个 delta 都会
             * `safeAddMessage` 一次（非查看态下就是"每 100ms 把同一条消息重写一遍库"）。
             */
            if (!loopMessages.has(assistantMsgId)) {
              safeAddMessage({
                id: assistantMsgId,
                role: "assistant",
                // FIX: content 初始为空 —— 文本统一由 streamBuffer flush 追加。
                // 此前用累积的 assistantContent 初始化 content，而 buf.text 也从
                // 第一个 delta 开始累积，flush 时会把开头段落再 append 一遍，
                // 导致句子首词重复（如「已已获取」「现在现在」「第三第三」）。
                // reasoning / knowledge_sources 分支已用空 content，此处对齐。
                content: "",
                timestamp: Date.now(),
                status: "streaming",
              });
            }
            // Per-session buffer
            let buf = streamBufferRef.current.get(session.id);
            if (!buf) { buf = { id: "", text: "", timer: null }; streamBufferRef.current.set(session.id, buf); }
            buf.id = assistantMsgId;
            buf.text += event.text;
            if (!buf.timer) {
              buf.timer = setTimeout(() => flushStreamBuffer(session.id), 100);
            }
            break;

          case "tool_start": {
            flushStreamBuffer(session.id);
            flushReasoningBuffer(session.id);
            // Bridge to pet system
            getPet().onStreamEvent(event);
            const tc = "toolCall" in event ? event.toolCall : null;
            // 大肥鱼式状态卡：工具阶段（查找/修改/执行…）
            if (tc?.name) {
              updatePetCard({
                phase: toolPhase(tc.name),
                message: lang === "zh" ? `正在${toolPhase(tc.name)}` : toolPhase(tc.name),
              });
            }
            if (tc) {
              if (!loopMessages.has(assistantMsgId)) {
                safeAddMessage({
                  id: assistantMsgId,
                  role: "assistant",
                  content: "",
                  timestamp: Date.now(),
                  status: "streaming",
                });
              }
              let buf2 = streamBufferRef.current.get(session.id);
              if (!buf2) { buf2 = { id: "", text: "", timer: null }; streamBufferRef.current.set(session.id, buf2); }
              buf2.id = assistantMsgId;
              // UI：只在查看本会话时更新；loop 自己那份**无论何时**都要记
              // （否则落库写下去的是"没有工具调用"的版本 —— 下一轮迭代读回来就缺 result）
              safeAddToolCall(assistantMsgId, {
                id: tc.id,
                tool: tc.name,
                args: { ...tc.input, name: tc.input?.name || (tc as any).metadata?.name },
                status: "running",
              });
              // Immediately save tool call so agentic loop can read it
              // P0-1：explicit 形态（写 loop 自己那份），且**保留即时性** —— 下一轮迭代要读回来
              persistLoopMessages();
            }
            break;
          }

          case "tool_complete": {
            // Bridge to pet system
            getPet().onStreamEvent(event);
            // 大肥鱼式状态卡：工具完成 → 整理结果
            updatePetCard({ phase: lang === "zh" ? "整理结果" : "reviewing" });
            const tc = "toolCall" in event ? event.toolCall : null;
            if (tc) {
              // Extract the output string from the result
              let resultStr: string;
              let toolMetadata: Record<string, any> | undefined;
              if (typeof event.result === "string") {
                resultStr = event.result;
              } else if (event.result && typeof event.result === "object" && "output" in event.result) {
                resultStr = (event.result as any).output;
                // 提取结构化元数据（如 search_notebook 的来源引用信息）
                if ((event.result as any).metadata) {
                  toolMetadata = (event.result as any).metadata;
                }
              } else {
                resultStr = JSON.stringify(event.result || "");
              }
              // Filter out <system-reminder> tags from tool results
              resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
              // 第 84 波：工具自己汇报失败（result.status="error"）时界面必须显示失败，
              // 不能一律标成 "done"（原来失败的写操作在时间线里是绿的）。
              const resultStatus = (event.result && typeof event.result === "object" && "status" in event.result)
                ? (event.result as any).status
                : undefined;
              // UI 只在查看时更新；loop 自己那份必须记下 result ——
              // 下一轮迭代就是从存储里读回工具调用结果的，缺了它就等于模型看不到自己的输出
              safeUpdateToolCall(assistantMsgId, tc.id, {
                status: resultStatus === "error" ? "error" : "done",
                result: resultStr,
                metadata: toolMetadata,
              });
              // Track generated files from write tool
              if (tc.name === "write" && tc.input?.path) {
                generatedFilesRef.current.add(tc.input.path as string);
              }
              // Notify NotebookWorkspace when a PPT note is created via generate_ppt tool
              if (tc.name === "generate_ppt" && toolMetadata?.notebookId) {
                window.dispatchEvent(new CustomEvent("notebook:note-created", {
                  detail: { notebookId: toolMetadata.notebookId, noteId: toolMetadata.noteId }
                }));
              }
              // Immediately save so next agentic loop iteration can read it
              // P0-1：explicit 形态（写 loop 自己那份）
              persistLoopMessages();
            }
            break;
          }

          case "tool_error": {
            // Bridge to pet system
            getPet().onStreamEvent(event);
            // 大肥鱼式状态卡：工具出错
            updatePetCard({
              phase: lang === "zh" ? "遇到问题" : "error",
              message: lang === "zh" ? "工具执行出错" : "tool error",
            });
            const tc = "toolCall" in event ? event.toolCall : null;
            const err = "error" in event ? event.error : "Unknown error";
            
            if (tc) {
              if (tc.id) {
                // UI 只在查看时更新；loop 自己那份无论何时都记（工具调用必须留下"失败"这个事实）
                safeUpdateToolCall(assistantMsgId, tc.id, {
                  status: "error",
                  result: err,
                });
              } else {
                // executeIteration 级错误（无具体 tool call）— 空 id 的
                // updateToolCall 无效，用户看不到任何反馈。直接上报错误消息。
                // P0-1：safeAddMessage 的 UI 那一支仍然按查看态，但**落库不再依赖查看态**
                safeAddMessage({
                  id: 'tool-error-' + Date.now(),
                  role: "system",
                  content: `⚠️ 工具执行失败：${err}`,
                  timestamp: Date.now(),
                  status: "error",
                });
              }
              // Immediately save tool error
              // P0-1：explicit 形态（写 loop 自己那份）
              persistLoopMessages();
            }
            break;
          }

          case "compaction_start": {
            setCompactionStatus({ active: true });
            // P1-8: 宠物切到 waiting 状态 + 压缩提示气泡
            getPet().setPetState("waiting");
            getPet().showRawBubble("正在压缩上下文…", 5000);
            break;
          }

          case "compaction_end": {
            const removed = "messagesRemoved" in event ? event.messagesRemoved : 0;
            setCompactionStatus({ active: false, messagesRemoved: removed });
            // Reload messages from DB since old ones were soft-deleted by compaction.
            // Do NOT call saveMessages here — the UI store's message list is stale
            // (it still contains the pre-compaction messages), and writing it back
            // would re-create the soft-deleted messages as non-hidden, undoing the
            // compaction. The DB is the source of truth after compaction.
            /*
             * P0-1（同类）：`loadMessages` 是**UI 的读**，它会连 `loadedSessionId` 一起改掉。
             * 后台会话压缩完成时若无条件调用，就会把**别的会话**的列表铺到用户正在看的界面上，
             * 并把归属改成后台会话（于是用户那个会话的 autosave 全部被守卫拒绝）。
             * 所以这一句与 `addMessage` 同一条规则：只在查看本会话时做。
             */
            if (isViewingSession()) loadMessages(session.id);
            // P1-8: 恢复宠物状态 + 压缩完成气泡
            getPet().setPetState("idle");
            if (removed > 0) {
              getPet().showRawBubble(`已压缩 ${removed} 条消息`, 3000);
            }
            // Auto-clear compaction status after 3 seconds
            setTimeout(() => setCompactionStatus(null), 3000);
            break;
          }

          case "guidance_received": {
            // Mark the guidance message as consumed in the store
            markGuidanceConsumed(event.guidanceId);
        // Injected guidance no longer stays in the status bar — remove it so the bar auto-disappears.
        removeGuidanceMessage(event.guidanceId);
            // Show a brief toast/notification via pet system
            getPet().showRawBubble(`📨 引导消息已注入: ${event.message.substring(0, 40)}...`, 3000);
            break;
          }

          case "clarification": {
            // P1: AI asks the user a structured question via a form
            setPendingClarifications(prev => {
              const next = new Map(prev);
              next.set(session.id, { form: event.form, resolve: event.resolve });
              return next;
            });
            break;
          }

          case "correction_complete": {
            // P1: Fact-check result is ready for user review
            setPendingCorrections(prev => {
              const next = new Map(prev);
              next.set(session.id, { original: event.original, corrected: event.corrected, changes: event.changes });
              return next;
            });
            break;
          }

          case "pipeline_step_complete": {
            // P1: A pipeline step completed — offer context for next step
            // Build context items from recent messages and notebook sources
            const contextItems: any[] = [];
            // Add recent user messages as context options
            const recentMessages = useAppStore.getState().messages.slice(-5);
            for (const msg of recentMessages) {
              if (msg.content) {
                contextItems.push({
                  id: msg.id,
                  type: 'message' as const,
                  title: msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : ''),
                  content: msg.content,
                });
              }
            }
            // If in notebook mode, add notebook as context
            if (activeNotebookId) {
              contextItems.push({
                id: `notebook-${activeNotebookId}`,
                type: 'notebook' as const,
                title: activeNotebookName || 'Notebook',
              });
            }
            setPendingPipelineSteps(prev => {
              const next = new Map(prev);
              next.set(session.id, { contextItems });
              return next;
            });
            break;
          }

          case "todo_list_created": {
            // P1: AI created a todo list — store will be updated via tool metadata
            // The todo data is persisted by the show-todo tool to SQLite
            // No additional UI action needed here — ChatPanel reads todos from DB
            break;
          }

          case "retry": {
            // 对标 DSH resetForRetry：LLM 流重试前清空本 session 的 buffer。
            // loop 重试是静默的（catch → sleep → 重新 stream），第一轮失败前
            // yield 的部分 text/reasoning 已进 buffer（100ms 批量 flush），
            // 若不清理，重试流 append 到同一条消息 → 同迭代内整段重复。
            const rbuf = streamBufferRef.current.get(session.id);
            if (rbuf) { rbuf.text = ""; rbuf.timer = null; }
            const rrbuf = reasoningBufferRef.current.get(session.id);
            if (rrbuf) { rrbuf.text = ""; rrbuf.timer = null; }
            break;
          }

          case "end": {
            lastEvent = event;
            // Bridge to pet system
            getPet().onStreamEvent(event);
            // Show bubble notification on task completion
            const isOverflow = "result" in event && event.result?.type === "overflow";
            if (!isOverflow) {
              // Determine if tools were used (task with actions) vs simple chat
              const fileCount = generatedFilesRef.current.size;
              const hadToolCalls = fileCount > 0;
              if (hadToolCalls) {
                // P0-3 + P1-9: 有文件变更时用 waving 状态 + 文件数摘要
                getPet().setPetState("waving");
                const bubbleMsg = fileCount === 1 ? "任务完成！修改了 1 个文件" : `任务完成！修改了 ${fileCount} 个文件`;
                setTimeout(() => getPet().showBubble(bubbleMsg), 300);
              } else {
                const bubbleMsg = "回复完成了！";
                setTimeout(() => getPet().showBubble(bubbleMsg), 300);
              }
            }
            // Handle overflow result (context completely exhausted)
            if ("result" in event && event.result?.type === "overflow") {
              const msg = event.result.message || "上下文窗口已满，请开启新对话。";
              safeAddMessage({
                id: 'overflow-' + Date.now(),
                role: "system",
                content: `⚠️ ${msg}`,
                timestamp: Date.now(),
                status: "error",
              });
            // 对标 DSH: 非正常结束的 turn 必须对用户可见 — 绝不静默结束。
            // too_many_errors / error 等失败 reason 之前被静默吞掉，
            // 用户看到的是"发消息不回复"。这里将失败原因明确上报。
            if ("result" in event && event.result?.type === "stop") {
              const reason = (event.result as any).reason;
              if (reason === "too_many_errors" || reason === "error") {
                const errMsg = reason === "too_many_errors"
                  ? "LLM 调用连续失败多次，任务已停止。可能是 LLM 服务端无响应或上下文过长。请检查服务状态后重试。"
                  : "任务执行出错，已停止。请检查控制台日志或重试。";
                safeAddMessage({
                  id: 'loop-error-' + Date.now(),
                  role: "system",
                  content: `⚠️ ${errMsg}`,
                  timestamp: Date.now(),
                  status: "error",
                });
                // 大肥鱼式状态卡：任务失败
                updatePetCard({ phase: lang === "zh" ? "遇到问题" : "error", message: errMsg });
              } else {
                // 大肥鱼式状态卡：任务完成（保留 2s 后隐藏由下方清理）
                updatePetCard({ phase: lang === "zh" ? "任务完成" : "done" });
                setTimeout(() => {
                  const st = usePetStore.getState();
                  if (st.card?.phase && (st.card.phase === "任务完成" || st.card.phase === "done")) hidePetCard();
                }, 2500);
              }
            }
            }
            break;
          }
        }
      }

      if (assistantContent) {
        const generatedFiles = Array.from(generatedFilesRef.current);
        // 对标 DSH turn 级 metadata：将 turn 状态写入消息 metadata，
        // 供 StatsLine（统计行）和 TurnStatus（错误/重试/max-tokens 通知行）消费。
        const turnEndTime = Date.now();
        const turnMetadata: Record<string, any> = {};
        // 从 end 事件中提取 turn 级信息
        if ("result" in lastEvent && lastEvent.result) {
          const result = lastEvent.result as any;
          // stop reason → turnStatus
          if (result.reason === "too_many_errors") {
            turnMetadata.turnStatus = { kind: "error", message: "Consecutive errors exceeded limit", code: result.reason };
          } else if (result.reason === "max_iterations") {
            turnMetadata.turnStatus = { kind: "error", message: "Iteration limit reached", code: result.reason };
          } else if (result.reason === "no_progress") {
            turnMetadata.turnStatus = { kind: "error", message: "No progress detected — loop stopped", code: result.reason };
          } else if (result.reason === "overflow") {
            turnMetadata.turnStatus = { kind: "max-tokens" };
          }
          // usage 数据
          if (result.usage) {
            turnMetadata.usage = result.usage;
            turnMetadata.turnEndTime = turnEndTime;
          }
        }
        safeUpdateMessage(assistantMsgId, {
          status: "done",
          generatedFiles: generatedFiles.length > 0 ? generatedFiles : undefined,
          metadata: Object.keys(turnMetadata).length > 0 ? turnMetadata : undefined,
        });
        generatedFilesRef.current.clear();
      }
    } catch (error: any) {
      
      // P0-1：错误消息也必须落进 loop 自己那份（原来这句 addMessage 连 UI 都会漏到别的会话上：
      // `addMessage` 写的是**当前加载的列表** —— 后台会话出错时它把错误气泡加到了别的会话里，
      // 再被 autosave 保存到那个会话。safeAddMessage 的 UI 那一支仍按查看态。
      safeAddMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: '[Error] ' + (error.message || String(error)),
        timestamp: Date.now(),
        status: 'error',
      });
    } finally {
if (watchdogTimer) clearInterval(watchdogTimer);
// Flush any remaining buffered text for this session
flushStreamBuffer(session.id);
flushReasoningBuffer(session.id);
      // Clear step progress after a short delay so user sees the final state
      setTimeout(() => useAppStore.getState().setStepProgress(null), 2000);
      // 大肥鱼式状态卡：回合结束（非完成态如取消/错误）后延迟归位。
      // P2：归位应清"任何仍停留的过程态"（含英文 thinking/working、工具阶段
      // searching/editing/executing/verifying 等），保留结束态（完成/错误）给上层呈现。
      setTimeout(() => {
        const st = usePetStore.getState();
        const KEEP_END = new Set(["任务完成", "done", "遇到问题", "error"]);
        if (st.card && !KEEP_END.has(st.card.phase || "")) {
          hidePetCard();
        }
      }, 2500);
      // Clear guidance messages when the run ends
      clearGuidanceMessages();
      // Clear stream start time
      useAppStore.getState().setStreamStartTime(null);
      
setStreaming(false);
if (session) {
useAppStore.getState().setSessionActive(session.id, false);
// Reset auto-approve flag when the turn ends
resetWriteConfirmStats(session.id);
}
streamingSessionIdRef.current = null;
abortControllersRef.current.delete(session?.id || "");
      // P0-1：回合结束时把 loop 自己那份落库（explicit 形态）——
      // 用户已经切走时，这一步就是"后台跑完的那轮消息"唯一的落库点
      persistLoopMessages();
      // 快照用完就摘掉（只属于这一次 loop）
      if (loopMessageSnapshotRef.current?.messages === loopMessages) {
        loopMessageSnapshotRef.current = null;
      }
      // Task completion notification when app is in background or minimized
      if (!windowVisibleRef.current) {
        // 通过宠物气泡通知（如果宠物已启用）
        const petStore = getPet();
        if (petStore.enabled) {
          const sessionTitle = session.title || "对话";
          const userQuestion = message.length > 30 ? message.substring(0, 30) + "..." : message;
          petStore.showBubble(`✅ ${sessionTitle} 完成：${userQuestion}`, 6000);
        }
        // Only send a native notification — do NOT steal focus / unminimize the window
        // (用户已切到其他应用办公，弹窗会打断操作；已有完成提示标签即可)
        try {
          const tauri = (window as any).__TAURI__;
          if (tauri?.core?.invoke) {
            let granted = true;
            try {
              granted = await tauri.core.invoke("plugin:notification|is_permission_granted");
              if (!granted) {
                const result = await tauri.core.invoke("plugin:notification|request_permission");
                granted = result === 2 || result === "granted";
              }
            } catch (e) { console.warn('[App] notification permission check failed', e) }
            if (granted) {
              const sessionTitle = session.title || "对话";
              const userQuestion = message.length > 30 ? message.substring(0, 30) + "..." : message;
              await tauri.core.invoke("plugin:notification|notify", {
                options: { title: `任务完成 — ${sessionTitle}`, body: `"${userQuestion}" 执行完毕，点击查看结果` }
              });
              console.log("[Notify] Notification sent (window NOT focused)");
            }
          }
        } catch (e) { console.warn("[Notify] Native notification failed:", e); }
      }
    }
    } finally {
      // 与入口的 startSessionExecution 成对：无论如何都要注销（见函数头 P1-I2 的说明）
      endSessionExecution(session.id);
    }
  };

  /**
   * Regenerate the assistant response for the current Q&A turn.
   * Called from the LAST assistant message in a turn. Finds the user message
   * that started this turn, deletes ALL assistant messages in the turn,
   * and re-runs the agentic loop from that user message.
   */
  const handleRegenerate = async (messageIndex: number) => {
    const session = useProjectStore.getState().currentSession;
    if (!session || isStreaming) return;

    const allMessages = useAppStore.getState().messages;
    if (messageIndex < 0 || messageIndex >= allMessages.length) return;

    // Find the user message that started this turn (search backwards from messageIndex)
    let userMessage = "";
    let userIndex = -1;
    for (let i = messageIndex; i >= 0; i--) {
      if (allMessages[i].role === "user") {
        userMessage = allMessages[i].content;
        userIndex = i;
        break;
      }
    }
    if (!userMessage || userIndex === -1) return;

    // Collect message IDs to delete (all messages AFTER the user message = entire assistant response)
    const idsToDelete = allMessages.slice(userIndex + 1).map((m) => m.id);

    // Truncate messages in store: keep everything up to and including the user message
    useAppStore.setState({ messages: allMessages.slice(0, userIndex + 1) });

    // Delete removed messages from DB
    if (idsToDelete.length > 0) {
      try { MessageStorage.deleteMessagesByIds(idsToDelete); } catch (e) {
        console.error("[Regenerate] Failed to delete messages:", e);
      }
    }

    // Re-run the agentic loop with the original user message
    await runAgenticLoop(userMessage, session);
  };

  /**
   * P0: Edit a user message and resend — deletes the original message and all
   * messages after it, then re-runs the agentic loop with the new content.
   */
  const handleEditAndResend = async (messageId: string, newContent: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    // P0 fix: use per-session active check instead of global isStreaming,
    // so editing works even when another session is streaming.
    const activeSessions = useAppStore.getState().activeSessions;
    if (activeSessions.has(session.id)) return;

    const allMessages = useAppStore.getState().messages;
    const targetMessage = allMessages.find((m) => m.id === messageId);
    if (!targetMessage || targetMessage.role !== "user") return;

    // 1. Update the message content in the store
    useAppStore.getState().updateMessage(messageId, { content: newContent });

    // 2. Update in DB
    try {
      MessageStorage.updateMessageContent(messageId, newContent);
    } catch (e) {
      console.error("[EditAndResend] Failed to update message content:", e);
    }

    // 3. Delete all messages AFTER this message (from DB)
    try {
      const deletedCount = MessageStorage.deleteMessagesAfter(session.id, messageId);
      console.log(`[EditAndResend] Deleted ${deletedCount} messages after edited message`);
    } catch (e) {
      console.error("[EditAndResend] Failed to delete subsequent messages:", e);
    }

    // 4. Remove messages after this one from the store
    useAppStore.getState().removeMessagesAfter(messageId, false);

    // 5. Re-run the agentic loop with the new content
    await runAgenticLoop(newContent, session);
  };

  /**
   * 「分叉」入口（第 44 轮：从三份内联实现收敛到这里）。
   *
   * 三处 `onFork` 原来各自把整段逻辑抄了一遍，而三份都没有写 `parent_id` ——
   * 于是 `session_trace`（按 `parent_id` 追溯祖先/后代）在生产里永远只报
   * `Parent: (root)` / `Ancestors: []`，也就是"完整谱系"这个能力从来没有数据。
   *
   * 现在统一调 `useProjectStore.forkSession`：它会走 `SessionStorage.forkSession`
   * （**写 parent_id**）、把项目归属解析成**源会话所属项目**、并按 `messageIndex` 复制消息
   * （消息/工具调用/附件 id 三者都换新 —— 第 45 轮 P1-D2 / P1-D3）。
   * UI 这边只负责"分叉完把新会话的消息读进来"。
   */
  /**
   * ## 第 47 轮补（功能上下文审计 **P0**）：把"窗口内下标"换算成"会话内绝对下标"
   *
   * `useAppStore().messages` **不是整个会话的历史**：`loadMessages` 只装载**最后 10 条**
   * （`src/store.ts` 的 `INITIAL_LIMIT`），向上滚动时才按批**前插**更旧的。
   * 而 `ChatPanel` 传给 `onFork` 的 `origIndex` 是**这份窗口里的下标**。
   *
   * `store.forkSession(id, messageIndex)` 拿这个数当**绝对下标**去
   * `MessageStorage.listMessages()`（全量会话）里切片。于是真机形态是：
   * 一个 100 条的会话里点最后一轮的分叉 → 窗口下标 9 → **复制了会话开头那 10 条**
   * （而不是分叉点之前的 100 条）→ 用户拿到一个内容完全不对的新会话。
   * 静默、无报错、而且短会话（≤10 条）下完全正常 —— 这正是它一直没被发现的原因。
   *
   * 换算本身抽在 `core/session/fork-index.ts`（纯函数，有专门的用例守着）——
   * 这里只负责把"窗口"和"读全量"两个依赖注进去。
   */
  const resolveSessionAbsoluteIndex = useCallback((sessionId: string, windowIndex: number): number => {
    const result = resolveForkIndex(
      sessionId,
      windowIndex,
      useAppStore.getState().messages,
      (sid) => MessageStorage.listMessages(sid),
    );
    if (result.shifted) {
      console.log(
        `[fork] 窗口下标 ${windowIndex} → 会话内绝对下标 ${result.absoluteIndex}` +
          `（窗口首条之前还有 ${result.offset} 条历史未装载）`,
      );
    }
    return result.absoluteIndex;
  }, []);

  const handleFork = useCallback((messageIndex: number) => {
    const store = useProjectStore.getState();
    const source = store.currentSession;
    if (!source) return;
    try {
      // 第 47 轮补 P0：UI 给的是**窗口下标**，forkSession 要的是**绝对下标**
      const absoluteIndex = resolveSessionAbsoluteIndex(source.id, messageIndex);
      const child = store.forkSession(source.id, absoluteIndex, 'Fork: ' + source.title);
      loadMessages(child.id);
    } catch (e) {
      // 分叉失败必须可见：静默失败会让用户以为"新会话建好了"而实际什么都没有
      reportActionFailure("app.forkSession", e, "分叉会话创建失败");
    }
  }, [loadMessages, resolveSessionAbsoluteIndex]);

  /**
   * P0 (对标 dsh-message-rewind / Trae "编辑并回退"):
   * Edit a past user message and resend it in a NEW forked session.
   * - The new session contains everything BEFORE the edited message (the
   *   previous turns), then the edited message is sent as a fresh user turn.
   * - The original session is kept untouched (no deletion).
   * The user message must not be the first message of the session.
   */
  const handleEditAndRewind = async (messageId: string, newContent: string) => {
    const session = useProjectStore.getState().currentSession;
    if (!session) return;
    const activeSessions = useAppStore.getState().activeSessions;
    if (activeSessions.has(session.id)) return;

    const allMessages = useAppStore.getState().messages;
    const targetIdx = allMessages.findIndex((m) => m.id === messageId);
    if (targetIdx < 0 || allMessages[targetIdx].role !== "user") return;
    // First message of the session cannot be rewound (no completed turn precedes it).
    if (targetIdx === 0) {
      addMessage({
        id: `sys-${Date.now()}`,
        role: "system",
        content: lang === "zh"
          ? "这是会话的第一条消息，没有可回退的上下文。可改用「编辑并重发」。"
          : "This is the first message of the session — nothing to rewind to. Use Edit & Resend instead.",
        timestamp: Date.now(),
        status: "done",
      });
      return;
    }

    const prefix = allMessages.slice(0, targetIdx); // everything before the edited message
    const newSession = createSession(`Rewind: ${session.title}`);
    /*
     * 记下谱系（第 44 轮）。
     *
     * "编辑并回退"产生的新会话与原会话是**明确的父子关系**，但这里原来只调了
     * `createSession`（不写 `parent_id`）—— 于是 `session_trace` 对新会话只报
     * `Parent: (root)` / `Ancestors: []`，"这个会话是从哪一条分出来的"这个事实永久丢失。
     * `SessionStorage.forkSession` 是**唯一**会写 `parent_id` 的写点，所以这里补一次调用
     * 把关系钉住 —— 会话行走 upsert，重复写是幂等的。
     *
     * ⚠️ 第 45 轮（P2-D6 的加重形态）：`SessionStorage.forkSession` **不再复制事件日志**了。
     * 原来它会整段复制，而这里只复制**前缀消息** —— 于是回退会话带着"源会话全量事件 +
     * 仅前缀消息"，事件里描述的后半段对话在子会话里根本不存在（投影会凭空造出消息）。
     * 现在事件只由消息自己的写入产生，这个不一致从根上消失。
     */
    try {
      SessionStorage.forkSession(session.id, newSession.id, newSession.projectId, newSession.title);
    } catch (e) {
      reportActionFailure("app.rewind.linkParent", e, "回退会话的谱系未写入");
    }

    /**
     * 1. 复制前缀消息进新会话（**新 id**）。
     *
     * 走 `MessageStorage.copyMessageToSession`：消息 id / 工具调用 id / **附件 id**
     * 三者一起换新（第 45 轮 P1-D3）。这里原来是本地 `clone()`，只换前两者 ——
     * 附件 id 与源会话共用，会让源消息的附件**被改指到回退会话**。
     */
    const ts = Date.now();
    for (const m of prefix) {
      try {
        MessageStorage.copyMessageToSession(m, newSession.id, `rw-${ts}`);
      } catch (e) { console.warn("[Rewind] copy prefix failed:", e); }
    }
    // 2. Write the edited message as the new user turn.
    try {
      MessageStorage.createMessage({
        id: `user-rw-${ts}-${Math.random().toString(36).substr(2, 5)}`,
        role: "user",
        content: newContent,
        timestamp: Date.now(),
        status: "done",
      }, newSession.id);
    } catch (e) { console.warn("[Rewind] write edited message failed:", e); }

    /**
     * ## 第 47 轮（功能上下文审计 P2-D11）：回退之后必须重算会话的消息计数
     *
     * `createSession` 建出来的会话行 `message_count = 0`，随后这里
     * **逐条 `copyMessageToSession` + `createMessage`** 往库里写（`prefix.length` 条 + 1 条编辑后的），
     * 而会话行的计数只靠引擎侧 `bump_session_message_count` 递增 —— 任何一条没 bump
     * （历史形态：外键拒绝 / 写被回绝 / 复制时抛错被下面吞掉）都会让侧边栏与
     * `session_trace` 长期显示错的条数，直到 12 小时一次的启动维护对账。
     *
     * 这里调用**已存在**的 `reconcileSessionMessageCountById`（`message.ts:2533`，
     * 读引擎 `messages.count.total` 真值写回），**不写第二份重算实现**。
     * 三态如实处理：`unavailable`（端口没有 `command` 能力 / 该会话读失败）时
     * 留下一行告警 —— "读不到"不许被读成"对上了"。
     */
    void MessageStorage.reconcileSessionMessageCountById(
      newSession.id,
      "编辑并回退后按索引真值重算",
    ).then((state) => {
      if (state === "unavailable") {
        console.warn("[Rewind] 索引真值读不到（端口无 command 能力），会话消息计数未重算");
      }
    }).catch((e) => {
      reportActionFailure("app.rewind.reconcileMessageCount", e, "回退会话的消息计数未重算");
    });

    // 3. Load the new session from DB (also switches currentSession rendering).
    loadMessages(newSession.id);

    // 4. Re-run the agentic loop on the forked session with the edited content.
    await runAgenticLoop(newContent, newSession);
  };

  /**
   * P0: Re-edit is now handled internally by ChatPanel — no parent state needed.
   * The onReEdit prop is optional and not passed, so ChatPanel manages its own quoteContext.
   */

  const handleCancel = () => {
// Abort the current session's streaming
if (currentSession) {
const controller = abortControllersRef.current.get(currentSession.id);
if (controller) {
controller.abort();
abortControllersRef.current.delete(currentSession.id);
}
// 真正中断该会话底层 LLM 调用（之前只 abort 默认实例，per-session loop 停不掉）
engineRef.current?.abortSession(currentSession.id);
} else {
// Fallback: abort all
for (const controller of abortControllersRef.current.values()) {
controller.abort();
}
abortControllersRef.current.clear();
engineRef.current?.abort();
}
    // Note: Sub-agents continue running when main task is paused
    // Only global pause should freeze everything
    setStreaming(false);
  };

  // Global pause: freeze everything (main + sub-agents)
  // DSH-style: engine.abort() now drains SubagentRuntime automatically
  const handleGlobalPause = () => {
    // Abort all active sessions
    for (const controller of abortControllersRef.current.values()) {
      controller.abort();
    }
    abortControllersRef.current.clear();
    // engine.abort() calls SubagentRuntime.drain() — no need for old SubagentManager.cancelAll()
    engineRef.current?.abort();
    setStreaming(false);
  };

  const handleToggleFileExplorer = (projectId: string) => {
    const state = useProjectStore.getState();
    if (state.currentProject?.id !== projectId) {
      useProjectStore.getState().openProject(projectId);
    }
    // 直接展开右侧栏并切换到文件 Tab（不再用浮动浏览器）
    setRightRailOpen(true);
    setFileExplorerProjectId((prev) => (prev === projectId ? null : projectId));
  };

  const handleBootstrapComplete = (identity: AppIdentity) => {
    setAppIdentity(identity);
    setShowBootstrap(false);
  };

  const { skin } = useSkin();

  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={500}>
    <div className="app">
      <SlotBridge name="app.boot-splash" fallback={BootSplash}
        visible={bootSplashVisible}
        phase={bootSplashPhase}
        progress={bootSplashPhase === "initializing" ? 15 : bootSplashPhase === "loading-db" ? 45 : bootSplashPhase === "loading-config" ? 75 : 100}
        onComplete={() => setBootSplashVisible(false)}
      />
      <SlotBridge name="app.workspace-backdrop" fallback={WorkspaceBackdrop} />
      <SlotBridge name="app.toast-container" fallback={ToastContainer}  />
      <FileLinkContextMenu />
      <SlotBridge name="app.titlebar" fallback={TitleBar}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        onNewChat={() => {
          useProjectStore.setState({ currentProject: null });
          createSession();
        }}
        onSearch={() => setShowSearchDialog(true)}
        onSettings={settingsEnabled ? () => setShowSettings(true) : undefined}
        rightRailOpen={rightRailOpen}
        onToggleRightRail={() => setRightRailOpen(!rightRailOpen)}
        terminalOpen={bottomTab === "terminal"}
        onToggleTerminal={() => setBottomTab(bottomTab === "terminal" ? "chat" : "terminal")}
      />
      <div className="app-content">
      {!dbReady ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "var(--text-secondary)" }}>
          Loading...
        </div>
      ) : (
        <>
          {showBootstrap && (
            <SlotBridge name="app.bootstrap-wizard" fallback={BootstrapWizard} appRoot={appRoot} onComplete={handleBootstrapComplete}  />
          )}

          {/* 核心内容：Sidebar + MainArea，根据皮肤选择不同布局包裹 */}
          {skin === "hub" ? (
            <SlotBridge name="app.skin-layout" fallback={HubLayout}
              rightRailOpen={rightRailOpen}
              onToggleRightRail={() => setRightRailOpen(!rightRailOpen)}
              onTasks={() => setShowProjectManager(true)}
              onSkills={() => setShowSkillManager(true)}
              onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
              onNewChat={() => {
                // 新建全局对话（不属于任何项目）
                useProjectStore.setState({ currentProject: null });
                createSession();
              }}
              onNewProject={() => setShowProjectManager(true)}
              onImportProject={() => setShowProjectManager(true)}
              onGitHubClone={() => setShowGitHubClone(true)}
              onOpenSession={(sessionId, projectId) => {
                // 切换到指定会话
                useProjectStore.getState().openProject(projectId);
                useProjectStore.getState().switchSession(sessionId);
              }}
              editingFile={editingFile}
              onEditingFileChange={setEditingFile}
              refreshKey={fileExplorerRefreshKey}
              sidebar={
                sidebarOpen ? (
                  <SlotBridge name="app.sidebar" fallback={Sidebar}
                    identity={appIdentity}
                    onSettings={settingsEnabled ? () => setShowSettings(true) : undefined}
                    onProjects={() => setShowProjectManager(true)}
                    onConfig={() => setShowConfigEditor(true)}
                    onMcp={() => setShowMcpManager(true)}
          onPlugins={pluginMgrEnabled ? () => setShowPluginManager(true) : undefined}
                    onSkills={() => setShowSkillManager(true)}
                    onMemory={() => setShowMemoryManager(true)}
                    onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
                    onAgents={() => setShowAgentManager(true)}
                    onPerf={perfEnabled ? () => { setSettingsInitialTab("performance"); setShowSettings(true); } : undefined}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
                    fileExplorerProjectId={fileExplorerProjectId}
                    onToggleFileExplorer={handleToggleFileExplorer}
                  />
                ) : null
              }
              mainPanel={
                <div className="main-area">
                  <div className="panel-right">
                    <div className="panel-tabs" style={{ display: "none" }}>
<SlotListBridge name="bottom-panel.tabs" />
</div>
                    <div className="panel-content">
                      {compactionStatus && (
                        <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                          {compactionStatus.active ? (
                            <><span className="compaction-spinner" /> 正在压缩上下文...</>
                          ) : (
                            <><CheckCircle size={12} className="icon-inline-gap" /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                          )}
                        </div>
                      )}
                      {activeNotebookId && (
                        <div className="notebook-mode-banner">
                          <span className="notebook-mode-icon"><BookOpen size={16} /></span>
<span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button className="notebook-mode-save" onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }} title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}><FolderOpen size={14} /></button>
<button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}><X size={14} /></button>
</div>
)}
{(bottomTab === "chat" || bottomTab === "terminal") && (
                        <SlotBridge name="app.conversation" fallback={ChatPanel}
                          onSend={handleSend}
                          onCancel={handleCancel}
                          onSendGuidance={handleSendGuidance}
                          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                          sidebarOpen={sidebarOpen}
                          onRegenerate={handleRegenerate}
                          onEditAndResend={handleEditAndResend}
onEditAndRewind={handleEditAndRewind}
                          sessionId={currentSession?.id}
                          onFork={handleFork}
                          connected={true}
                          model={cliModel}
                          onModelChange={handleModelChange}
                          mode={currentMode}
                          providerId={currentProvider}
                          collaborationMode={collaborationMode}
                          onModeChange={handleModeChange}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                      )}
{bottomTab === "terminal" && (
<div className="terminal-drawer">
  <div className="terminal-drawer-header">
    <span className="terminal-drawer-title"><Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}</span>
    <button
      className="terminal-drawer-close"
      onClick={() => setBottomTab("chat")}
      title={lang === "zh" ? "关闭终端" : "Close terminal"}
      aria-label={lang === "zh" ? "关闭终端" : "Close terminal"}
    >
      <X size={14} />
    </button>
  </div>
  <div className="terminal-drawer-body">
    <SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot} />
  </div>
</div>
)}

{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "var(--text-on-accent)", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
      <GameViewLazy />
    </Suspense>
  </div>
)}
                    </div>
                  </div>
                </div>
              }
            />
          ) : skin === "dream" ? (
            <SlotBridge name="app.skin-layout" fallback={DreamLayout}>
              {sidebarOpen && (
<SlotBridge name="app.sidebar" fallback={Sidebar}
identity={appIdentity}
                  onSettings={settingsEnabled ? () => setShowSettings(true) : undefined}
                  onProjects={() => setShowProjectManager(true)}
                  onConfig={() => setShowConfigEditor(true)}
                  onMcp={() => setShowMcpManager(true)}
          onPlugins={pluginMgrEnabled ? () => setShowPluginManager(true) : undefined}
                  onSkills={() => setShowSkillManager(true)}
                  onMemory={() => setShowMemoryManager(true)}
                  onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
onAgents={() => setShowAgentManager(true)}
onPerf={perfEnabled ? () => { setSettingsInitialTab("performance"); setShowSettings(true); } : undefined}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
                  fileExplorerProjectId={fileExplorerProjectId}
                  onToggleFileExplorer={handleToggleFileExplorer}
                />
              )}

              <div className="main-area">
                <div className="panel-right">
                  <div className="panel-tabs" style={{ display: "none" }}></div>
                  <div className="panel-content">
                    {compactionStatus && (
                      <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                        {compactionStatus.active ? (
                          <><span className="compaction-spinner" /> 正在压缩上下文...</>
                        ) : (
                          <><CheckCircle size={12} className="icon-inline-gap" /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                        )}
                      </div>
                    )}
                    {activeNotebookId && (
                      <div className="notebook-mode-banner">
                        <span className="notebook-mode-icon"><BookOpen size={16} /></span>
<span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button className="notebook-mode-save" onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }} title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}><FolderOpen size={14} /></button>
<button className="notebook-mode-close" onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}><X size={14} /></button>
</div>
)}
{(bottomTab === "chat" || bottomTab === "terminal") && (
<SlotBridge name="app.conversation" fallback={ChatPanel}
onSend={handleSend}
                        onCancel={handleCancel}
                        onSendGuidance={handleSendGuidance}
                        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                        sidebarOpen={sidebarOpen}
                        onRegenerate={handleRegenerate}
                        onEditAndResend={handleEditAndResend}
onEditAndRewind={handleEditAndRewind}
                        sessionId={currentSession?.id}
                        onFork={handleFork}
                        connected={true}
                        model={cliModel}
                        onModelChange={handleModelChange}
                        mode={currentMode}
                        providerId={currentProvider}
                        collaborationMode={collaborationMode}
                        onModeChange={handleModeChange}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                    )}
{bottomTab === "terminal" && (
<div className="terminal-drawer">
  <div className="terminal-drawer-header">
    <span className="terminal-drawer-title"><Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}</span>
    <button
      className="terminal-drawer-close"
      onClick={() => setBottomTab("chat")}
      title={lang === "zh" ? "关闭终端" : "Close terminal"}
      aria-label={lang === "zh" ? "关闭终端" : "Close terminal"}
    >
      <X size={14} />
    </button>
  </div>
  <div className="terminal-drawer-body">
    <SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot} />
  </div>
</div>
)}

{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "var(--text-on-accent)", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
      <GameViewLazy />
    </Suspense>
  </div>
)}
                  </div>
                </div>
            </div>
{/* Right sidebar for Dream skin */}
<SlotBridge name="app.right-sidebar" fallback={RightSidebar}
collapsed={!rightRailOpen}
onToggleCollapse={() => setRightRailOpen(!rightRailOpen)}
onNewChat={() => { useProjectStore.setState({ currentProject: null }); createSession(); }}
onNewProject={() => setShowProjectManager(true)}
onImportProject={() => setShowProjectManager(true)}
onGitHubClone={() => setShowGitHubClone(true)}
onOpenSession={(sessionId: string, projectId: string) => { useProjectStore.getState().openProject(projectId); useProjectStore.getState().switchSession(sessionId); }}
editingFile={editingFile}
onEditingFileChange={setEditingFile}
refreshKey={fileExplorerRefreshKey}
/>
          </SlotBridge>
          ) : (
            <>
              {/* 默认皮肤：原始布局，不受 ThemeManager 干预 */}
          {/* P3 #46: Mobile sidebar hamburger button */}
          <button
            className="mobile-sidebar-toggle"
            onClick={() => setMobileSidebarOpen(true)}
            title={lang === "zh" ? "打开菜单" : "Open menu"}
            style={{ display: "none" }}
          >
            <Menu size={20} />
          </button>
          {sidebarOpen && (
<SlotBridge name="app.sidebar" fallback={Sidebar}
identity={appIdentity}
          onSettings={settingsEnabled ? () => setShowSettings(true) : undefined}
          onProjects={() => setShowProjectManager(true)}
          onConfig={() => setShowConfigEditor(true)}
          onMcp={() => setShowMcpManager(true)}
          onPlugins={pluginMgrEnabled ? () => setShowPluginManager(true) : undefined}
          onSkills={() => setShowSkillManager(true)}
          onMemory={() => setShowMemoryManager(true)}
          onNotebooks={() => setShowNotebookManager(true)}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); }}
onAgents={() => setShowAgentManager(true)}
onPerf={perfEnabled ? () => { setSettingsInitialTab("performance"); setShowSettings(true); } : undefined}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
          fileExplorerProjectId={fileExplorerProjectId}
          onToggleFileExplorer={handleToggleFileExplorer}
        />
      )}

      <div className="main-area">
        <div className="panel-right">
          <div className="panel-tabs" style={{ display: "none" }}></div>

          <div className="panel-content">
            {compactionStatus && (
              <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                {compactionStatus.active ? (
                  <><span className="compaction-spinner" /> 正在压缩上下文...</>
                ) : (
                  <><CheckCircle size={12} className="icon-inline-gap" /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                )}
              </div>
            )}
            {activeNotebookId && (
              <div className="notebook-mode-banner">
                <span className="notebook-mode-icon"><BookOpen size={16} /></span>
                <span>{lang === 'zh' ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
<button className="notebook-mode-save" onClick={handleSaveAIResponseAsNote} title={lang === 'zh' ? '保存AI回复为笔记' : 'Save AI response as note'}><Save size={14} /></button>
<button
  className="notebook-mode-save"
  onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }}
  title={lang === 'zh' ? '返回工作区' : 'Back to Workspace'}
><FolderOpen size={14} /></button>
<button
  className="notebook-mode-close"
  onClick={() => { setActiveNotebookId(null); setActiveNotebookName(''); setNotebookSourceFilter(null); }}
>
  <X size={14} />
</button>
              </div>
            )}
            {(bottomTab === "chat" || bottomTab === "terminal") && (
<SlotBridge name="app.conversation" fallback={ChatPanel}
onSend={handleSend}
                onCancel={handleCancel}
                onSendGuidance={handleSendGuidance}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                sidebarOpen={sidebarOpen}
                onRegenerate={handleRegenerate}
                onEditAndResend={handleEditAndResend}
onEditAndRewind={handleEditAndRewind}
                sessionId={currentSession?.id}
                onFork={handleFork}
                connected={true}
                model={cliModel}
                onModelChange={handleModelChange}
                mode={currentMode}
                providerId={currentProvider}
                collaborationMode={collaborationMode}
                onModeChange={handleModeChange}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
            )}
{bottomTab === "terminal" && (
<div className="terminal-drawer">
  <div className="terminal-drawer-header">
    <span className="terminal-drawer-title"><Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}</span>
    <button
      className="terminal-drawer-close"
      onClick={() => setBottomTab("chat")}
      title={lang === "zh" ? "关闭终端" : "Close terminal"}
      aria-label={lang === "zh" ? "关闭终端" : "Close terminal"}
    >
      <X size={14} />
    </button>
  </div>
  <div className="terminal-drawer-body">
    <SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot} />
  </div>
</div>
)}

{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "var(--text-on-accent)", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
      <GameViewLazy />
    </Suspense>
  </div>
)}
          </div>
        </div>
      </div>

{/* Right sidebar for default skin */}
<SlotBridge name="app.right-sidebar" fallback={RightSidebar}
collapsed={!rightRailOpen}
onToggleCollapse={() => setRightRailOpen(!rightRailOpen)}
onNewChat={() => { useProjectStore.setState({ currentProject: null }); createSession(); }}
onNewProject={() => setShowProjectManager(true)}
onImportProject={() => setShowProjectManager(true)}
onGitHubClone={() => setShowGitHubClone(true)}
onOpenSession={(sessionId: string, projectId: string) => { useProjectStore.getState().openProject(projectId); useProjectStore.getState().switchSession(sessionId); }}
editingFile={editingFile}
onEditingFileChange={setEditingFile}
refreshKey={fileExplorerRefreshKey}
/>
        </>
          )}

          {/* P3 #46: Mobile sidebar Drawer */}
          <Drawer
            open={mobileSidebarOpen}
            onClose={() => setMobileSidebarOpen(false)}
            side="left"
            size={280}
            title={lang === "zh" ? "菜单" : "Menu"}
          >
<SlotBridge name="app.sidebar" fallback={Sidebar}
identity={appIdentity}
              onSettings={() => { setShowSettings(true); setMobileSidebarOpen(false); }}
              onProjects={() => { setShowProjectManager(true); setMobileSidebarOpen(false); }}
              onConfig={() => { setShowConfigEditor(true); setMobileSidebarOpen(false); }}
              onMcp={() => { setShowMcpManager(true); setMobileSidebarOpen(false); }}
            onPlugins={pluginMgrEnabled ? () => { setShowPluginManager(true); setMobileSidebarOpen(false); } : undefined}
              onSkills={() => { setShowSkillManager(true); setMobileSidebarOpen(false); }}
              onMemory={() => { setShowMemoryManager(true); setMobileSidebarOpen(false); }}
              onNotebooks={() => { setShowNotebookManager(true); setMobileSidebarOpen(false); }}
onTaskCenter={() => { setTaskCenterTab("overview"); setShowTaskCenter(true); setMobileSidebarOpen(false); }}
onAgents={() => { setShowAgentManager(true); setMobileSidebarOpen(false); }}
onPerf={perfEnabled ? () => { setSettingsInitialTab("performance"); setShowSettings(true); setMobileSidebarOpen(false); } : undefined}
              onRemoveProject={(id, name, path) => { setRemoveProjectDialog({ id, name, path }); setMobileSidebarOpen(false); }}
              fileExplorerProjectId={fileExplorerProjectId}
              onToggleFileExplorer={handleToggleFileExplorer}
              onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            />
          </Drawer>

{showSettings && (
<SlotBridge name="app.settings" fallback={SettingsPanel}
onClose={() => { setSettingsInitialTab("general"); setShowSettings(false); }}
initialTab={settingsInitialTab}
onSessionRecovery={() => { setShowSettings(false); setShowSessionRecovery(true); }}
          onUsageStats={() => { setShowSettings(false); setShowUsageStats(true); }}
          setShowOnboardingReplay={(v) => { setShowOnboardingReplay(v); setShowSettings(false); }}
        />
      )}
      {showProjectManager && <SlotBridge name="app.project-manager" fallback={ProjectManager} onClose={() => setShowProjectManager(false)}  />}
      {showConfigEditor && currentProject && (
        <SlotBridge name="app.config-editor" fallback={ConfigEditor}
          appRoot={appRoot}
          projectPath={currentProject.path}
          onClose={() => setShowConfigEditor(false)}
        />
      )}

      {showMcpManager && (
        <div className="modal-overlay" onClick={() => setShowMcpManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.mcp-manager" fallback={McpManager} onClose={() => setShowMcpManager(false)}  />
          </div>
        </div>
      )}

      {showPluginManager && (
        <div className="modal-overlay" onClick={() => setShowPluginManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.plugin-manager" fallback={PluginManager} onClose={() => setShowPluginManager(false)}  />
          </div>
        </div>
      )}

      {showSkillManager && (
        <div className="modal-overlay" onClick={() => setShowSkillManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.skill-manager" fallback={SkillManager} onClose={() => setShowSkillManager(false)}  />
          </div>
        </div>
      )}

      {showMemoryManager && (
        <div className="modal-overlay" onClick={() => setShowMemoryManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.memory-manager" fallback={MemoryManager} onClose={() => setShowMemoryManager(false)}  />
          </div>
        </div>
      )}

      {showGitHubClone && (
        <SlotBridge name="app.github-clone-dialog" fallback={GitHubCloneDialog} onClose={() => setShowGitHubClone(false)}  />
      )}

      {/* P0-3: Plan Approval Card — shown when model calls exit_plan_mode */}
      {planApproval && (
        <SlotBridge name="app.plan-approval-card" fallback={PlanApprovalCard}
          plan={planApproval.plan}
          onApprove={() => {
            // 第 84 波：批准 = 真的切模式。原来只 resolve({approved:true})，
            // UI 仍是 Plan 模式、正在运行的 loop 也仍是 Plan 模式 → 工具宣称
            // "你现在是 Default 模式" 而后面每个写操作都被拦下（假成功）。
            const sessionId = currentSession?.id;
            let loops = 0;
            let failure: string | null = null;
            try {
              loops = handleModeChange("default");
            } catch (e: any) {
              failure = e?.message || String(e);
            }
            planApproval.resolve({
              approved: true,
              modeSwitched: failure === null,
              modeNote:
                failure !== null
                  ? `切换协作模式时出错：${failure}`
                  : sessionId
                    ? `协作模式已切到 default；当前活动 loop 切换数=${loops}`
                    : "已切到 default（当时没有活动会话，只影响后续请求）",
            });
            setPlanApproval(null);
          }}
          onReject={(feedback) => {
            planApproval.resolve({ approved: false, feedback });
            setPlanApproval(null);
          }}
        />
      )}

      {showSearchDialog && (
        <SlotBridge name="app.search-dialog" fallback={SearchDialog}
          onClose={() => setShowSearchDialog(false)}
          onSwitchProject={(projectId) => { useProjectStore.getState().openProject(projectId); setShowSearchDialog(false); }}
          onNewSession={() => { if (currentProject) createSession(); setShowSearchDialog(false); }}
          onOpenSkills={() => { setShowSkillManager(true); setShowSearchDialog(false); }}
        />
      )}

{showNotebookManager && (
<div className="modal-overlay notebook-modal-overlay" onClick={() => setShowNotebookManager(false)}>
<div className="modal-editor" style={{ maxWidth: '900px', height: '80vh', maxHeight: 'calc(100vh - 36px)' }} onClick={(e) => e.stopPropagation()}>
<SlotBridge name="app.notebook-manager" fallback={NotebookManager}
onClose={() => setShowNotebookManager(false)}
onOpenWorkspace={(notebookId, notebookName) => {
setNotebookWorkspaceId(notebookId);
setNotebookWorkspaceName(notebookName);
setShowNotebookManager(false);
}}
onOpenNotebookChat={(notebookId, notebookName) => {
setActiveNotebookId(notebookId);
setActiveNotebookName(notebookName);
setShowNotebookManager(false);
}}
/>
</div>
</div>
)}

      {notebookWorkspaceId && (
        <div className="nb-workspace-overlay">
          <SlotBridge name="app.notebook-workspace" fallback={NotebookWorkspace}
            notebookId={notebookWorkspaceId}
            notebookName={notebookWorkspaceName}
            onBack={() => { setNotebookWorkspaceId(null); setShowNotebookManager(true); }}
            onNotebookSend={handleNotebookSend}
            onNotebookCancel={handleNotebookCancel}
            onNotebookSendGuidance={handleNotebookSendGuidance}
            notebookModel={cliModel}
            onNotebookModelChange={handleModelChange}
            onCitationClick={handleNotebookCitationClick}
            onSourceClick={handleNotebookSourceClick}
            notebookConnected={true}
          />
        </div>
      )}

{/* B4: Citation viewer — opens SourceViewer when user clicks a source citation in chat */}
{citationViewer && (
<SlotBridge name="app.source-viewer" fallback={SourceViewer}
sourceId={citationViewer.sourceId}
notebookId={citationViewer.notebookId}
highlightChunkIndex={citationViewer.chunkIndex}
onClose={() => setCitationViewer(null)}
/>
)}

      {showSessionRecovery && (
        <div className="modal-overlay" onClick={() => setShowSessionRecovery(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.session-recovery" fallback={SessionRecovery} onClose={() => setShowSessionRecovery(false)}  />
          </div>
        </div>
      )}

      {showUsageStats && (
        <div className="modal-overlay" onClick={() => setShowUsageStats(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()}>
            <SlotBridge name="app.usage-stats" fallback={UsageStats} onClose={() => setShowUsageStats(false)}  />
          </div>
        </div>
      )}

      {showTaskCenter && (
        <SlotBridge name="app.task-center" fallback={TaskCenter}
          onClose={() => setShowTaskCenter(false)}
          initialTab={taskCenterTab}
          subagentTasks={subagentTasks}
          onSelectSubagent={(taskId: string) => {
            // 选中子智能体任务：切到它的父会话（SubagentTask.parentId），再关掉面板
            try {
              const task = subagentTasks.find((t) => t.id === taskId);
              if (task?.parentId) useProjectStore.getState().switchSession(task.parentId);
            } catch {
              /* 忽略：切不过去就只关面板 */
            }
            setShowTaskCenter(false);
          }}
        />
      )}

      {showAgentManager && (
        <div className="modal-overlay" onClick={() => setShowAgentManager(false)}>
          <div className="modal-editor" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, maxHeight: "85vh" }}>
            <SlotBridge name="app.agent-manager" fallback={AgentManager} onClose={() => setShowAgentManager(false)}  />
          </div>
        </div>
      )}



      {/* P1 #24: DecisionTray — inline decision UI replaces popup for main permissions */}
      {pendingPermission && (() => {
        const req = pendingPermission.request as any;
        // DSH-aligned: PermissionRequest 的字段是 input（不是 args）。
        // description 复用 PermissionDialog 的 getToolDescription，从 input
        // 提取命令/路径/pattern，让用户在批准前能看到具体内容。
        const reqInput: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
        // DSH commandOf: bash 家族只展示命令本身（muted code line），
        // 其他工具展示完整参数 JSON。
        const approvalReq: ApprovalRequest = {
          type: "approval",
          id: req.id,
          toolName: req.tool || req.title || "tool",
          description: getToolDescription(req.tool, reqInput),
          args: typeof reqInput.command === "string"
            ? reqInput.command
            : (Object.keys(reqInput).length > 0 ? JSON.stringify(reqInput, null, 2) : undefined),
        };
        return (
          <SlotBridge name="app.decision-tray" fallback={DecisionTray}
            request={approvalReq}
            onApprove={(id: string) => {
              pendingPermission.resolve({ requestId: id, action: "allow", alwaysAllow: false });
              clearPendingPermission();
            }}
            onReject={(id: string) => {
              pendingPermission.resolve({ requestId: id, action: "deny", alwaysAllow: false });
              clearPendingPermission();
            }}
            onClarify={() => {}}
          />
        );
      })()}

      {/* Background session permission (from delegation system) — still uses popup as fallback */}
      {!pendingPermission && backgroundPermission && (
        <SlotBridge name="app.permission-dialog" fallback={PermissionDialog}
          request={{ ...(backgroundPermission.request as any), title: `[委派任务] ${(backgroundPermission.request as any).title || backgroundPermission.request.tool || ''}` } as any}
          onResolve={(allow: boolean, alwaysAllow?: boolean) => {
            backgroundPermission.resolve({
              requestId: backgroundPermission.request.id,
              action: allow ? "allow" : "deny",
              alwaysAllow,
            });
            setPendingPermissions((prev) => {
              const next = new Map(prev);
              next.delete(backgroundPermission.sessionId);
              return next;
            });
          }}
        />
      )}

      {confirmDialog && (
        <SlotBridge name="app.confirm-dialog" fallback={ConfirmDialog}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
         />
      )}

      {/* Safe project removal dialog — 3 options, click outside = cancel */}
      {removeProjectDialog && (() => {
        const { id, name, path } = removeProjectDialog;
        return createPortal(
          <div className="confirm-overlay" onClick={() => setRemoveProjectDialog(null)}>
            <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
              <div className="confirm-title">{lang === "zh" ? "移除项目" : "Remove Project"}</div>
              <div className="confirm-message" style={{ marginBottom: 16 }}>
                {lang === "zh" ? `确定要移除项目 "${name}" 吗？` : `Remove project "${name}"?`}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 8 }}>
                <button
                  style={{ padding: "10px 16px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer", fontSize: 'var(--fs-base)', textAlign: "left" }}
                  onClick={() => { useProjectStore.getState().deleteProject(id); setRemoveProjectDialog(null); }}
                >
                  <span style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <FolderOpen size={14} className="icon-inline" />
                    {lang === "zh" ? "仅移除项目" : "Remove Only"}
                  </span>
                  <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除，不删除文件" : "Remove from list, keep files"}</div>
                </button>
                <button
                  style={{ padding: "10px 16px", borderRadius: "var(--radius-sm)", border: "1px solid var(--error)", background: "none", color: "var(--error)", cursor: "pointer", fontSize: 'var(--fs-base)', textAlign: "left" }}
                  onClick={async () => {
                    try {
                      const { invoke } = (window as any).__TAURI__.core;
                      await invoke("delete_directory", { path });
                    } catch (e) {
                      console.error("Failed to move to recycle bin:", e);
                    }
                    useProjectStore.getState().deleteProject(id);
                    setRemoveProjectDialog(null);
                  }}
                >
                  <span style={{ fontWeight: 600 }}><Trash2 size={14} className="icon-inline-gap" /> {lang === "zh" ? "移除并删除文件到回收站" : "Remove & Recycle"}</span>
                  <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除 + 文件送入回收站" : "Remove from list + send files to Recycle Bin"}</div>
                </button>
              </div>
              <button
                className="confirm-btn cancel"
                style={{ width: "100%", padding: "8px 16px", borderRadius: "var(--radius-sm)" }}
                onClick={() => setRemoveProjectDialog(null)}
              >
                {lang === "zh" ? "取消" : "Cancel"}
              </button>
            </div>
          </div>,
          document.body
        );
      })()}

      {showCloseConfirm && (
        <SlotBridge name="app.close-confirm-dialog" fallback={CloseConfirmDialog} onChoose={handleCloseChoice}  />
      )}

      {/* P1-8: Needs You — Agent proactively asks user a precise question */}
      {/*
        `uiSessionId` 而不是 `currentSession.id`（第 45 轮 P0-I1）：这张面板读的是
        **会话级**的提问队列（`needs-you-queue`），归属必须与"在屏的会话"一致 ——
        笔记本回合原来靠临时改写 currentSession 才让它指到笔记本会话，现在没有那次改写了。
      */}
      {uiSessionId && (
        <SlotBridge name="app.needs-you-panel" fallback={NeedsYouPanel}
          sessionId={uiSessionId}
          onAnswer={(itemId: string, answer: string) => {
            import("./core/llm/needs-you-queue").then(({ getNeedsYouQueue }) => {
              getNeedsYouQueue().answer(itemId, answer);
            });
          }}
          onSkip={(sid: string) => {
            import("./core/llm/needs-you-queue").then(({ getNeedsYouQueue }) => {
              getNeedsYouQueue().skip(sid);
            });
          }}
        />
      )}

      {/* S4: Inline Diff Review for file overwrites (replaces modal popup) */}
      {pendingWriteConfirm && (
        <div className="inline-diff-container">
          <SlotBridge name="app.inline-diff-review" fallback={InlineDiffReview}
            filePath={pendingWriteConfirm.filePath}
            before={pendingWriteConfirm.existingContent}
            after={pendingWriteConfirm.newContent}
            sequenceInfo={writeConfirmStat.count > 1 ? `文件 ${writeConfirmStat.count}` : undefined}
            onAccept={() => {
              pendingWriteConfirm.resolve({ action: "accept" });
              clearPendingWriteConfirm();
            }}
            onReject={() => {
              pendingWriteConfirm.resolve({ action: "reject" });
              clearPendingWriteConfirm();
            }}
            onCustom={(instruction: string) => {
              pendingWriteConfirm.resolve({ action: "custom", instruction });
              clearPendingWriteConfirm();
            }}
            onAcceptAll={() => {
              // Auto-approve this file and all future files in this turn
              pendingWriteConfirm.resolve({ action: "accept" });
              clearPendingWriteConfirm();
              setSessionAutoApprove(true);
            }}
          />
        </div>
      )}

      {/* D3: Interactive Form Dialog */}
      {pendingInteractiveForm && (
        <SlotBridge name="app.interactive-form-dialog" fallback={InteractiveFormDialog}
          questions={pendingInteractiveForm.questions}
          onSubmit={(answers: Record<string, any>) => {
            pendingInteractiveForm.resolve(answers);
            clearPendingInteractiveForm();
          }}
          onCancel={() => {
            pendingInteractiveForm.resolve({});
            clearPendingInteractiveForm();
          }}
        />
      )}

      {/* P1: Clarification Form — AI asks structured questions */}
      {pendingClarification && (
        <div className="dialog-overlay" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => { pendingClarification.resolve([]); clearPendingClarification(); }}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "500px", width: "90vw" }}>
            <SlotBridge name="app.clarification-form" fallback={ClarificationForm}
              form={pendingClarification.form}
              onSubmit={(answers: Record<string, any>) => {
                const flatAnswers = Object.values(answers).flatMap((a: any) => Array.isArray(a) ? a : [a]) as string[];
                pendingClarification.resolve(flatAnswers);
                clearPendingClarification();
              }}
              onCancel={() => {
                pendingClarification.resolve([]);
                clearPendingClarification();
              }}
            />
          </div>
        </div>
      )}

      {/* P1: Correction Result Panel — fact-check comparison */}
      {pendingCorrection && (
        <div className="dialog-overlay" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => clearPendingCorrection()}>
          <div onClick={(e) => e.stopPropagation()} style={{ maxWidth: "800px", width: "90vw", maxHeight: "80vh", overflowY: "auto" }}>
            <SlotBridge name="app.correction-result-panel" fallback={CorrectionResultPanel}
              original={pendingCorrection.original}
              corrected={pendingCorrection.corrected}
              changes={pendingCorrection.changes}
              onApply={() => {
                // Replace the last assistant message content with the corrected version
                const msgs = useAppStore.getState().messages;
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.status === 'done');
                if (lastAssistant) {
                  useAppStore.getState().updateMessage(lastAssistant.id, { content: pendingCorrection.corrected });
                  if (currentSession) saveMessages(currentSession.id);
                }
                clearPendingCorrection();
              }}
              onDismiss={() => {
                clearPendingCorrection();
              }}
            />
          </div>
        </div>
      )}

      {/* P1: Pipeline Next Step Dialog */}
      {pendingPipelineStep && (
        <SlotBridge name="app.pipeline-next-step-dialog" fallback={PipelineNextStepDialog}
          contextItems={pendingPipelineStep.contextItems}
          onSubmit={(_selectedContext: any, customPrompt: string, _mode: any) => {
            if (customPrompt) {
              handleSend(customPrompt);
            }
            clearPendingPipelineStep();
          }}
          onDismiss={() => {
            clearPendingPipelineStep();
          }}
        />
      )}

      {/*
        第 47 轮（设置链路审计 D-19 收口）：这里原来有一整块「快速访问卡片」
        （`SlotBridge name="app.quick-access-cards"` + `QuickAccessCards` fallback）。
        它的显示条件是 `showQuickAccess && …`，而 `showQuickAccess` 是
        `useState(false)`，全仓**只有 `setShowQuickAccess(false)`** ——
        从来没有一处把它设成 `true`，所以这块 JSX 在运行时**永远不渲染**：
        槽位 `app.quick-access-cards` 也永远不会被求值，插件往那个名字注册的卡片
        一辈子不会出现（"注册成功但永远不显示"）。

        按"能看见的功能优先于看不见的代码"处理：**删除这块死 UI**，而不是在这里
        随手补一个入口——那是产品决策（空会话首屏到底要不要展示 agent 快捷卡片），
        不属于审计整改范围。活着的同类能力在 `ChatPanel`（它 `useState(true)`，
        由 `chat-panel-quick-access` 槽位渲染，`SlotBridge` 在那里是真接入的）。
        守门用例：`settings-tail-fixes.test.ts` 的 SKEY-D19-*。
      */}

      {/* D2: Prompt Change Review Dialog */}
      {pendingPromptChanges && (
        <SlotBridge name="app.prompt-change-review-dialog" fallback={PromptChangeReviewDialog}
          changes={pendingPromptChanges.changes}
          onApply={(appliedChanges: any[]) => {
            // Here you would apply the changes to the actual system prompt
            // For now, we just confirm what was applied
            const msg = appliedChanges.length > 0
              ? `Applied ${appliedChanges.length} prompt change(s): ${appliedChanges.map((c: any) => c.name).join(", ")}`
              : "No changes were applied.";
            pendingPromptChanges.resolve({ applied: appliedChanges.length > 0, message: msg });
            clearPendingPromptChanges();
          }}
          onCancel={() => {
            pendingPromptChanges.resolve({ applied: false, message: "User cancelled all changes." });
            clearPendingPromptChanges();
          }}
        />
      )}

      {/*
        第 47 轮补（UI/UX 审计 P1）：失败/崩溃提示的**常驻出口**。

        放在应用树的最外层（与流式状态无关）：写盘失败意味着"这次改动重启后会丢"，
        而它绝大多数时候发生在用户**空闲**时 —— 原来那条通道（`guidanceMessages`）
        只在流式期间渲染，于是空闲时界面什么都不显示，违反"失败必须可见"这条仓库级契约。
      */}
      <PersistFailureBanner />

      {/* P2: Onboarding tour for first-time users or replay from Help */}
      {(showOnboarding || showOnboardingReplay) && (
        <SlotBridge name="app.onboarding-tour" fallback={OnboardingTour}
          steps={[
            { target: ".chat-panel", title: lang === "zh" ? "对话面板" : "Chat Panel", content: lang === "zh" ? "在这里与 AI 进行对话交互" : "Chat with AI here", position: "right" },
            { target: ".sidebar-toggle", title: lang === "zh" ? "侧边栏" : "Sidebar", content: lang === "zh" ? "管理会话历史和项目" : "Manage sessions and projects", position: "right" },
            { target: ".model-selector", title: lang === "zh" ? "模型选择" : "Model Selector", content: lang === "zh" ? "切换不同的 AI 模型" : "Switch between AI models", position: "bottom" },
            { target: ".message-input", title: lang === "zh" ? "输入区域" : "Input Area", content: lang === "zh" ? "输入你的问题或任务，支持附件上传和技能选择" : "Type your questions, upload files, and select skills", position: "top" },
          ]}
          onComplete={() => {
            setSetting("onboarding-completed", "1");
            setShowOnboarding(false);
            setShowOnboardingReplay(false);
          }}
          onSkip={() => {
            setSetting("onboarding-completed", "1");
            setShowOnboarding(false);
            setShowOnboardingReplay(false);
          }}
        />
      )}
        </>
      )}
      </div>

      {/* 全局覆盖层 slot — 宠物已迁移到独立窗口 + Cordis PetProvider */}
      <SlotListBridge name="app.overlay" />
      {/* 全局监控面板 slot — ContextMonitor 等 */}
      <SlotBridge name="app.monitor" fallback={null} />
      {/* 全局目标/TODO 面板 slot — TodoListDisplay 等 */}
      <SlotBridge name="app.goal" fallback={null} />

      {/* app.subagent 不在此渲染 — DelegationPanel 是模态弹窗，需要 onClose prop，不能放在无 props 的 SlotBridge 中 */}
      {/* app.user-questions 和 app.workflow-run 不在此渲染。
          InteractiveFormDialog 需要 questions/onSubmit/onCancel props，
          ActivityTimeline 需要 items prop，
          二者均通过各自的条件渲染路径使用，不能放在无 props 的 SlotBridge 中。 */}

</div>
</TooltipProvider>
);
}

export default App;

