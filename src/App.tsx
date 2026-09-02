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
import { RefreshCw, X, MessageSquare, Terminal, BookOpen, Save, FolderOpen, PencilLine, Trash2, CheckCircle, Menu, Hammer, ClipboardList, Search, Bot, Activity, GitBranch, Gamepad2 } from "lucide-react";
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
import { setPlanApprovalCallback, clearPlanApprovalCallback } from "./core/llm/tools/exit-plan-mode";
import { SearchDialog } from "./components/SearchDialog";
import { usePetStore } from "./core/pet/pet-store";
import { loadInstalledPets as loadInstalledPetsPets } from "./core/pet/pet-manager";
import { loadInstalledSkills } from "./core/skill/installer";
import { getSessionMessageBus, getDelegationOrchestrator, executeSessionTurn, isSessionExecuting } from "./core/session";
// 大富翁小游戏 — 懒加载
const GameViewLazy = lazy(() => import("./plugins/monopoly-game/components/GameView").then(m => ({ default: m.GameView })));
import type { InteractiveFormQuestion, PromptChange } from "./core/llm/tools";
import { useAppStore } from "./store";
import { useProjectStore } from "./core/store";
import { setGlobalCwd } from "./utils/file-link";
import { loadAppIdentity } from "./core/config/loader";
import { AppIdentity, type Session } from "./core/types";
import { getLLMEngine } from "./core/llm";
import { resolveProviderForModel, getFirstConfiguredModel } from "./core/model-config";
import { getMiMoAuth } from "./core/auth/mimo";
import type { PermissionRequest, PermissionResult } from "./core/permission/permission";
import { initDatabase, resetDatabase, flushDatabase } from "./core/storage";
import { getModelProfileManager } from "./core/llm/model-profile";
import { migrateFromLocalStorage } from "./core/storage/migration";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "./core/storage/settings";
import { setLang, useLang, S } from "./core/i18n/lang";
import * as MessageStorage from "./core/storage/message";
import { formatAttachmentsInline } from "./core/llm/attachment-formatter";
import { syncAttachmentsToWorkspace } from "./core/llm/attachment-sync";
import { ThemeManager, useSkin } from "./core/theme";
import { HubLayout } from "./components/HubLayout";
import { DreamLayout } from "./components/DreamLayout";
import { OnboardingTour } from "./components/OnboardingTour";
import { QuickAccessCards } from "./components/QuickAccessCards";
import { CorrectionResultPanel } from "./components/CorrectionResultPanel";
import { ClarificationForm } from "./components/ClarificationForm";
import { PipelineNextStepDialog } from "./components/PipelineNextStepDialog";
import { getAgentRegistry } from "./core/agent/agent";
import type { ClarificationFormData } from "./core/llm/agentic-loop";
import { runSetupScript, runCleanupScript } from "./core/environment";

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
  const { messages, addMessage, appendToMessage, setStreaming, isStreaming, addToolCall, updateToolCall, loadMessages, saveMessages, setLLMStatus, addGuidanceMessage, markGuidanceConsumed, removeGuidanceMessage, clearGuidanceMessages } = useAppStore();
  const { currentProject, currentSession, createSession, dbReady, loadFromDB } = useProjectStore();

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
const [pluginDisabledList, setPluginDisabledList] = useState<string[]>(() => {
  try {
    const raw = localStorage.getItem('codem:disabled-plugins');
    if (raw === null) {
      // 首次运行：默认禁用游戏插件
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
const [planApproval, setPlanApproval] = useState<{ plan: string; resolve: (result: { approved: boolean; feedback?: string }) => void } | null>(null);
  const [showSearchDialog, setShowSearchDialog] = useState(false);
const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
const [activeNotebookName, setActiveNotebookName] = useState<string>('');
const [notebookWorkspaceId, setNotebookWorkspaceId] = useState<string | null>(null);
const [notebookWorkspaceName, setNotebookWorkspaceName] = useState<string>('');
// Citation viewer — opens SourceViewer when user clicks [Source: name] in chat
const [citationViewer, setCitationViewer] = useState<{ sourceId: string; notebookId: string; chunkIndex?: number } | null>(null);
  const [showSessionRecovery, setShowSessionRecovery] = useState(false);
  const [showUsageStats, setShowUsageStats] = useState(false);
const [showTaskCenter, setShowTaskCenter] = useState(false);
const [taskCenterTab, setTaskCenterTab] = useState<TaskCenterTab>("overview");
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
    }
  }, [dbReady, currentProject?.path]);
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
  // Convenience accessor: get the pending write confirm for the current session
  const pendingWriteConfirm = currentSession ? pendingWriteConfirms.get(currentSession.id) : null;
  const writeConfirmStat = currentSession ? (writeConfirmStats.get(currentSession.id) || { count: 0, autoApprove: false }) : { count: 0, autoApprove: false };
  const setPendingWriteConfirm = (val: any) => {
    if (!val || !currentSession) { return; }
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.set(currentSession.id, val);
      return next;
    });
    // Increment count
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(currentSession.id) || { count: 0, autoApprove: false };
      next.set(currentSession.id, { ...cur, count: cur.count + 1 });
      return next;
    });
  };
  const clearPendingWriteConfirm = () => {
    if (!currentSession) return;
    setPendingWriteConfirms(prev => {
      const next = new Map(prev);
      next.delete(currentSession.id);
      return next;
    });
  };
  const setSessionAutoApprove = (autoApprove: boolean) => {
    if (!currentSession) return;
    setWriteConfirmStats(prev => {
      const next = new Map(prev);
      const cur = next.get(currentSession.id) || { count: 0, autoApprove: false };
      next.set(currentSession.id, { ...cur, autoApprove });
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
const pendingInteractiveForm = currentSession ? pendingInteractiveForms.get(currentSession.id) : null;
const setPendingInteractiveForm = (val: any) => {
  if (!val || !currentSession) return;
  setPendingInteractiveForms(prev => { const next = new Map(prev); next.set(currentSession.id, val); return next; });
};
const clearPendingInteractiveForm = () => {
if (!currentSession) return;
setPendingInteractiveForms(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending clarification forms (AI asks structured questions)
const [pendingClarifications, setPendingClarifications] = useState<Map<string, { form: ClarificationFormData; resolve: (answers: string[]) => void }>>(new Map());
const pendingClarification = currentSession ? pendingClarifications.get(currentSession.id) : null;
const clearPendingClarification = () => {
if (!currentSession) return;
setPendingClarifications(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending correction results (fact-check comparison)
const [pendingCorrections, setPendingCorrections] = useState<Map<string, { original: string; corrected: string; changes: string[] }>>(new Map());
const pendingCorrection = currentSession ? pendingCorrections.get(currentSession.id) : null;
const clearPendingCorrection = () => {
if (!currentSession) return;
setPendingCorrections(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P1: Per-session pending pipeline next-step dialog
const [pendingPipelineSteps, setPendingPipelineSteps] = useState<Map<string, { contextItems: any[] }>>(new Map());
const pendingPipelineStep = currentSession ? pendingPipelineSteps.get(currentSession.id) : null;
const clearPendingPipelineStep = () => {
if (!currentSession) return;
setPendingPipelineSteps(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
};

// P2: QuickAccessCards — agent quick access
const [showQuickAccess, setShowQuickAccess] = useState(false);
const [quickAccessFavorites, setQuickAccessFavorites] = useState<Set<string>>(() => {
try { return new Set(getSettingJSON<string[]>("codem-quick-access-favorites", [])); } catch { return new Set(); }
});

// D2: Pending prompt changes — per-session for parallel safety
const [pendingPromptChangesMap, setPendingPromptChangesMap] = useState<Map<string, {
changes: PromptChange[];
resolve: (result: { applied: boolean; message: string }) => void;
}>>(new Map());
const pendingPromptChanges = currentSession ? pendingPromptChangesMap.get(currentSession.id) : null;
const setPendingPromptChanges = (val: any) => {
  if (!val || !currentSession) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.set(currentSession.id, val); return next; });
};
const clearPendingPromptChanges = () => {
  if (!currentSession) return;
  setPendingPromptChangesMap(prev => { const next = new Map(prev); next.delete(currentSession.id); return next; });
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
  // Convenience accessor: get the pending permission for the current session
  const pendingPermission = currentSession ? pendingPermissions.get(currentSession.id) : null;
  // Background permission: first pending permission from a non-current session (delegation system)
  const backgroundPermission = (() => {
    for (const [sid, val] of pendingPermissions) {
      if (!currentSession || sid !== currentSession.id) return { sessionId: sid, ...val };
    }
    return null;
  })();
  const setPendingPermission = (val: any) => {
    if (!val || !currentSession) { return; }
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.set(currentSession.id, val);
      return next;
    });
  };
  const clearPendingPermission = () => {
    if (!currentSession) return;
    setPendingPermissions(prev => {
      const next = new Map(prev);
      next.delete(currentSession.id);
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
          useAppStore.getState().updateMessage(buffer.id, { reasoning: buffer.text } as any);
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
    // Initialize SQLite first, then load everything from database
    (async () => {
      try {
        setBootSplashPhase("loading-db");
        await initDatabase();
        // Expose settings functions via globalThis for Cordis Provider plugins that
        // need settings access but can't use require() in browser (ESM) environment.
        // This acts as a service locator bridge — Provider plugins can opt-in via
        // (globalThis as any).__codemSettings?.getSettingJSON(...)
        const { getSettingJSON, setSettingJSON, getSetting, setSetting } = await import("./core/storage/settings");
        (globalThis as any).__codemSettings = { getSettingJSON, setSettingJSON, getSetting, setSetting };
        await migrateFromLocalStorage();
        setBootSplashPhase("loading-config");
        ThemeManager.init();
        useProjectStore.getState().loadFromDB();
        // S0-3: Initialize Capability Seam — register default local providers
        // for filesystem and shell. Tools can now access these capabilities
        // through the seam registry instead of hard-importing file-api.
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

      // 防止重复执行
      if (isSessionExecuting(targetSessionId)) {
        console.log(`[Delegation] Session ${targetSessionId} is already executing, delegation ${taskId} queued`);
        return;
      }

      // 获取目标会话信息
      const session = useProjectStore.getState().sessions.find((s) => s.id === targetSessionId);
      if (!session) {
        console.warn(`[Delegation] Target session not found: ${targetSessionId}`);
        orchestrator.failTask(taskId, `Target session not found: ${targetSessionId}`);
        return;
      }

      // 获取工作目录
      const project = useProjectStore.getState().currentProject;
      let cwd = project?.path || "D:\\mimo";
      if (session.worktreePath) {
        cwd = session.worktreePath;
      }

      const engine = engineRef.current; if (!engine) { console.warn('[App] engine not available'); return; }

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
      });
    });

    return () => {
      unsub();
    };
  }, [dbReady]);

  // ========== Squad Dispatch 路由 ==========
  // 监听 squad_dispatch 工具发出的事件，创建 Leader 会话并后台执行。
  useEffect(() => {
    const handleSquadDispatch = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || !detail.squadId || !detail.task) return;

      const { squadId, task, originalTask, sourceSessionId, projectId } = detail;
      console.log(`[Squad] Dispatch received: squad=${squadId}, task=${originalTask.substring(0, 60)}...`);

      // Get squad info
      const { getSquadManager } = await import("./core/squad/squad");
      const mgr = getSquadManager();
      const squad = mgr.getSquad(squadId);
      if (!squad) {
        console.error(`[Squad] Squad not found: ${squadId}`);
        return;
      }

      // Create a new session for the leader
      const leaderSessionTitle = `[Squad] ${squad.name}: ${originalTask.substring(0, 40)}`;
      const state = useProjectStore.getState();
      const targetProjectId = projectId || state.currentProject?.id || "";

      // Switch to the target project if needed
      if (targetProjectId && state.currentProject?.id !== targetProjectId) {
        state.openProject(targetProjectId);
      }

      // Create a new session
      const newSession = state.createSession();
      const newSessionId = newSession.id;
      console.log(`[Squad] Leader session created: ${newSessionId} for squad ${squad.name}`);

      // Wait a tick for the session to be available
      setTimeout(async () => {
        const session = useProjectStore.getState().sessions.find((s) => s.id === newSessionId);
        if (!session) {
          console.error(`[Squad] Leader session not found after creation: ${newSessionId}`);
          return;
        }

        // Determine cwd: use worktree path if session has one, otherwise project path
        const project = useProjectStore.getState().currentProject;
        let cwd = session.worktreePath || project?.path || "";

        // Execute the task in the leader session
        executeSessionTurn({
          sessionId: newSessionId,
          message: task,
          cwd,
          engine: engineRef.current as any,
          onPermissionRequest: (request) => {
            return new Promise((resolve) => {
              setPendingPermissions((prev) => {
                const next = new Map(prev);
                next.set(newSessionId, { request, resolve });
                return next;
              });
            });
          },
        }).catch((err) => {
          console.error(`[Squad] Leader executeSessionTurn failed for ${newSessionId}:`, err);
        });
      }, 200);
    };

    window.addEventListener("codem-squad-dispatch", handleSquadDispatch as EventListener);
    return () => {
      window.removeEventListener("codem-squad-dispatch", handleSquadDispatch as EventListener);
    };
  }, []);

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
        // Flush all pending DB writes BEFORE quitting; quit_app exits the Rust process
        // immediately, so a fire-and-forget flush would be killed mid-write.
        await flushDatabase();
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("quit_app");
        return;
      }
      // Flush any pending DB writes before minimizing
      flushDatabase();
      if (closeBehavior === "tray") {
        // Minimize to tray
        const { invoke } = (window as any).__TAURI__?.core || {};
        invoke?.("hide_to_tray");
      } else {
        // First time — show dialog
        setShowCloseConfirm(true);
      }
    }).then((un: () => void) => { unlisten = un; });

    return () => { unlisten?.(); };
  }, []);

  const handleCloseChoice = useCallback(async (action: "tray" | "close", remember: boolean) => {
    setShowCloseConfirm(false);
    if (remember) {
      setSetting("codem-close-behavior", action);
    }
    const { invoke } = (window as any).__TAURI__?.core || {};
    if (action === "tray") {
      // Flush any pending DB writes before minimizing
      flushDatabase();
      invoke?.("hide_to_tray");
    } else {
      // Flush ALL pending DB writes before quitting; quit_app exits the Rust process immediately
      await flushDatabase();
      invoke?.("quit_app");
    }
  }, []);

  useEffect(() => {
    if (currentSession) {
      // Save old messages to old session before switching
      if (messagesSessionRef.current && messagesSessionRef.current !== currentSession.id && messages.length > 0) {
        saveMessages(messagesSessionRef.current);
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
    if (currentSession && messages.length > 0 && messagesSessionRef.current === currentSession.id) {
      if (isStreaming) {
        // Debounce during streaming
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          console.log(`[AutoSave] Debounce save: ${messages.length} messages to ${currentSession.id}`);
          saveMessages(currentSession.id);
        }, 2000);
      } else {
        // Save immediately when not streaming
        console.log(`[AutoSave] Immediate save: ${messages.length} messages to ${currentSession.id}`);
        saveMessages(currentSession.id);
      }
    }
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages, isStreaming]);

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
  // ===== 笔记本内嵌对话回调 — 复用 runAgenticLoop =====
  // 将笔记本的 session 临时设为 currentSession，使 runAgenticLoop 中的
  // isViewingSession() 和 activeNotebookId 能正确工作
  const handleNotebookSend = async (message: string, session: Session, nbId: string) => {
    // 保存原始 session 以便恢复
    const store = useProjectStore.getState();
    const originalSession = store.currentSession;

    // 临时切换到笔记本 session
    useProjectStore.setState({ currentSession: session });
    setActiveNotebookId(nbId);

    try {
      // 调用主 agentic loop — 它内部会使用 activeNotebookId 启用知识检索
      await runAgenticLoop(message, session);
    } finally {
      // 恢复原始 session 状态
      useProjectStore.setState({ currentSession: originalSession });
    }
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
const session = useProjectStore.getState().currentSession;
if (!session) return;

    // F3.2: Handle /memory slash commands
    const trimmedMessage = message.trim();
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
  const runAgenticLoop = async (message: string, session: Session, selectedSkills?: string[]) => {
    if (!session) return;

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

    // Watchdog timer lives outside try so the finally block can clear it.
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    try {
console.log(`[runAgenticLoop] starting engine.process for session=${session.id}`);
const sessionAbort = new AbortController();
abortControllersRef.current.set(session.id, sessionAbort);

// Helper: check if this session is currently being viewed (for UI updates)
const isViewingSession = () => {
  const viewing = useProjectStore.getState().currentSession?.id;
  return viewing === session.id;
};
// Safe message helpers: only update UI if viewing this session, always save to DB
const safeAddMessage = (msg: any) => {
  if (isViewingSession()) addMessage(msg);
  // Always persist to DB regardless
  if (session) saveMessages(session.id);
};
const safeUpdateMessage = (id: string, update: any) => {
  if (isViewingSession()) useAppStore.getState().updateMessage(id, update);
};

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
        // F5: Notebook knowledge mode
        ...(activeNotebookId ? { notebookId: activeNotebookId } : {}),
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
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
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
              rbuf.text = reasoningContent; // full reasoning content (replace, not append)
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
              if (useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
                safeUpdateMessage(assistantMsgId, {
                  status: "done",
                  reasoning: reasoningContent || undefined,
                } as any);
                if (session) {
                  saveMessages(session.id);
                }
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
            break;
          }

          case "text_delta":
            assistantContent += event.text;
            if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
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
            if (tc) {
              if (!useAppStore.getState().messages.find((m) => m.id === assistantMsgId)) {
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
              if (isViewingSession()) addToolCall(assistantMsgId, {
                id: tc.id,
                tool: tc.name,
                args: { ...tc.input, name: tc.input?.name || (tc as any).metadata?.name },
                status: "running",
              });
              // Immediately save tool call so agentic loop can read it
if (session) {
saveMessages(session.id);
}
            }
            break;
          }

          case "tool_complete": {
            // Bridge to pet system
            getPet().onStreamEvent(event);
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
              if (isViewingSession()) updateToolCall(assistantMsgId, tc.id, {
                status: "done",
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
if (session) {
saveMessages(session.id);
}
            }
            break;
          }

          case "tool_error": {
            // Bridge to pet system
            getPet().onStreamEvent(event);
            const tc = "toolCall" in event ? event.toolCall : null;
            const err = "error" in event ? event.error : "Unknown error";
            
            if (tc) {
              if (tc.id) {
                if (isViewingSession()) updateToolCall(assistantMsgId, tc.id, {
                  status: "error",
                  result: err,
                });
              } else {
                // executeIteration 级错误（无具体 tool call）— 空 id 的
                // updateToolCall 无效，用户看不到任何反馈。直接上报错误消息。
                if (isViewingSession()) safeAddMessage({
                  id: 'tool-error-' + Date.now(),
                  role: "system",
                  content: `⚠️ 工具执行失败：${err}`,
                  timestamp: Date.now(),
                  status: "error",
                });
              }
              // Immediately save tool error
if (session) {
saveMessages(session.id);
}
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
        if (session) {
          loadMessages(session.id);
        }
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
      
      addMessage({
        id: 'err-' + Date.now(),
        role: 'system',
        content: '[Error] ' + (error.message || String(error)),
        timestamp: Date.now(),
        status: 'error',
      });
      if (session) saveMessages(session.id);
    } finally {
if (watchdogTimer) clearInterval(watchdogTimer);
// Flush any remaining buffered text for this session
flushStreamBuffer(session.id);
flushReasoningBuffer(session.id);
      // Clear step progress after a short delay so user sees the final state
      setTimeout(() => useAppStore.getState().setStepProgress(null), 2000);
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
      if (session) {
        saveMessages(session.id);
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
                    onPerf={perfEnabled ? () => setBottomTab("perf") : undefined}
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
                    <div className="panel-tabs">
                      <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
                        <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
                      </button>
<button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
<Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
</button>
{perfEnabled && (
<button className={`tab ${bottomTab === "perf" ? "active" : ""}`} onClick={() => setBottomTab("perf")}>
<Activity size={14} /> {lang === "zh" ? "性能" : "Perf"}
</button>
)}
{gameEnabled && (
<button className={`tab ${bottomTab === "game" ? "active" : ""}`} onClick={() => setBottomTab("game")}>
<Gamepad2 size={14} /> {lang === "zh" ? "游戏" : "Game"}
</button>
)}
                    {/* SlotListBridge 消费 bottom-panel.tabs — list 类型，允许插件注入底部面板 tab */}
                      <SlotListBridge name="bottom-panel.tabs" />
                    </div>
                    <div className="panel-content">
                      {compactionStatus && (
                        <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                          {compactionStatus.active ? (
                            <><span className="compaction-spinner" /> 正在压缩上下文...</>
                          ) : (
                            <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
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
{bottomTab === "chat" && (
                        <SlotBridge name="app.conversation" fallback={ChatPanel}
                          onSend={handleSend}
                          onCancel={handleCancel}
                          onSendGuidance={handleSendGuidance}
                          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                          onRegenerate={handleRegenerate}
                          onEditAndResend={handleEditAndResend}
                          sessionId={currentSession?.id}
                          onFork={(messageIndex) => {
                            if (currentSession && currentProject) {
                              const newSession = createSession('Fork: ' + currentSession.title);
                              const sourceMessages = MessageStorage.listMessages(currentSession.id);
                              if (sourceMessages.length > 0) {
                                let endIdx = sourceMessages.length;
                                for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                                  if (sourceMessages[i].role === "user") { endIdx = i; break; }
                                }
                                const forkedMessages = sourceMessages.slice(0, endIdx);
                                const forkTs = Date.now();
                                for (const msg of forkedMessages) {
                                  const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                                  MessageStorage.createMessage({
                                    ...msg, id: newMsgId,
                                    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}` })),
                                  }, newSession.id);
                                }
                                loadMessages(newSession.id);
                              }
                            }
                          }}
                          connected={true}
                          model={cliModel}
                          onModelChange={handleModelChange}
                          mode={currentMode}
                          providerId={currentProvider}
                          collaborationMode={collaborationMode}
                          onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                      )}
{bottomTab === "terminal" && (
<SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot}  />
)}
{perfEnabled && bottomTab === "perf" && (
<SlotBridge name="app.performance-dashboard" fallback={PerformanceDashboard} onClose={() => setBottomTab("chat")}  />
)}
{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "#fff", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
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
onPerf={perfEnabled ? () => setBottomTab("perf") : undefined}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
                  fileExplorerProjectId={fileExplorerProjectId}
                  onToggleFileExplorer={handleToggleFileExplorer}
                />
              )}

              <div className="main-area">
                <div className="panel-right">
                  <div className="panel-tabs">
                    <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
                      <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
                    </button>
<button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
<Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
</button>
{perfEnabled && (
<button className={`tab ${bottomTab === "perf" ? "active" : ""}`} onClick={() => setBottomTab("perf")}>
<Activity size={14} /> {lang === "zh" ? "性能" : "Perf"}
</button>
)}
{gameEnabled && (
<button className={`tab ${bottomTab === "game" ? "active" : ""}`} onClick={() => setBottomTab("game")}>
<Gamepad2 size={14} /> {lang === "zh" ? "游戏" : "Game"}
</button>
)}
                  </div>
                  <div className="panel-content">
                    {compactionStatus && (
                      <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                        {compactionStatus.active ? (
                          <><span className="compaction-spinner" /> 正在压缩上下文...</>
                        ) : (
                          <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
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
{bottomTab === "chat" && (
<SlotBridge name="app.conversation" fallback={ChatPanel}
onSend={handleSend}
                        onCancel={handleCancel}
                        onSendGuidance={handleSendGuidance}
                        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                        onRegenerate={handleRegenerate}
                        onEditAndResend={handleEditAndResend}
                        sessionId={currentSession?.id}
                        onFork={(messageIndex) => {
                          if (currentSession && currentProject) {
                            const newSession = createSession('Fork: ' + currentSession.title);
                            const sourceMessages = MessageStorage.listMessages(currentSession.id);
                            if (sourceMessages.length > 0) {
                              let endIdx = sourceMessages.length;
                              for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                                if (sourceMessages[i].role === "user") { endIdx = i; break; }
                              }
                              const forkedMessages = sourceMessages.slice(0, endIdx);
                              const forkTs = Date.now();
                              for (const msg of forkedMessages) {
                                const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                                MessageStorage.createMessage({
                                  ...msg, id: newMsgId,
                                  toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}` })),
                                }, newSession.id);
                              }
                              loadMessages(newSession.id);
                            }
                          }
                        }}
                        connected={true}
                        model={cliModel}
                        onModelChange={handleModelChange}
                        mode={currentMode}
                        providerId={currentProvider}
                        collaborationMode={collaborationMode}
                        onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
                    )}
{bottomTab === "terminal" && (
<SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot}  />
)}
{perfEnabled && bottomTab === "perf" && (
<SlotBridge name="app.performance-dashboard" fallback={PerformanceDashboard} onClose={() => setBottomTab("chat")}  />
)}
{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "#fff", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
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
onPerf={perfEnabled ? () => setBottomTab("perf") : undefined}
onRemoveProject={(id, name, path) => {
  setRemoveProjectDialog({ id, name, path });
}}
          fileExplorerProjectId={fileExplorerProjectId}
          onToggleFileExplorer={handleToggleFileExplorer}
        />
      )}

      <div className="main-area">
        <div className="panel-right">
          <div className="panel-tabs">
            <button className={`tab ${bottomTab === "chat" ? "active" : ""}`} onClick={() => setBottomTab("chat")}>
              <MessageSquare size={14} /> {lang === "zh" ? "对话" : "Chat"}
            </button>
<button className={`tab ${bottomTab === "terminal" ? "active" : ""}`} onClick={() => setBottomTab("terminal")}>
<Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}
</button>
{perfEnabled && (
<button className={`tab ${bottomTab === "perf" ? "active" : ""}`} onClick={() => setBottomTab("perf")}>
<Activity size={14} /> {lang === "zh" ? "性能" : "Perf"}
</button>
)}
{gameEnabled && (
<button className={`tab ${bottomTab === "game" ? "active" : ""}`} onClick={() => setBottomTab("game")}>
<Gamepad2 size={14} /> {lang === "zh" ? "游戏" : "Game"}
</button>
)}
          </div>

          <div className="panel-content">
            {compactionStatus && (
              <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
                {compactionStatus.active ? (
                  <><span className="compaction-spinner" /> 正在压缩上下文...</>
                ) : (
                  <><CheckCircle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
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
            {bottomTab === "chat" && (
<SlotBridge name="app.conversation" fallback={ChatPanel}
onSend={handleSend}
                onCancel={handleCancel}
                onSendGuidance={handleSendGuidance}
                onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onRegenerate={handleRegenerate}
                onEditAndResend={handleEditAndResend}
                sessionId={currentSession?.id}
                onFork={(messageIndex) => {
                  if (currentSession && currentProject) {
                    const newSession = createSession('Fork: ' + currentSession.title);
                    // Fork messages from SQLite via MessageStorage
                    const sourceMessages = MessageStorage.listMessages(currentSession.id);
                    if (sourceMessages.length > 0) {
                      // Fork the entire Q&A turn: from the user message at messageIndex
                      // through all subsequent assistant messages until the next user message.
                      let endIdx = sourceMessages.length;
                      for (let i = messageIndex + 1; i < sourceMessages.length; i++) {
                        if (sourceMessages[i].role === "user") {
                          endIdx = i;
                          break;
                        }
                      }
                      const forkedMessages = sourceMessages.slice(0, endIdx);
                      const forkTs = Date.now();
                      for (const msg of forkedMessages) {
                        // Generate new IDs to avoid conflicts with source messages
                        const newMsgId = `${msg.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`;
                        MessageStorage.createMessage({
                          ...msg,
                          id: newMsgId,
                          toolCalls: msg.toolCalls?.map((tc) => ({
                            ...tc,
                            id: `${tc.id}-fork-${forkTs}-${Math.random().toString(36).substr(2, 5)}`,
                          })),
                        }, newSession.id);
                      }
                      loadMessages(newSession.id);
                    }
                  }
                }}
                connected={true}
                model={cliModel}
                onModelChange={handleModelChange}
                mode={currentMode}
                providerId={currentProvider}
                collaborationMode={collaborationMode}
                onModeChange={setCollaborationMode}
projectPath={currentProject?.path}
currentSessionId={currentSession?.id}
onCitationClick={activeNotebookId ? handleCitationClick : undefined}
onSourceClick={activeNotebookId ? handleSourceClick : undefined}
notebookId={activeNotebookId || undefined}
/>
            )}
{bottomTab === "terminal" && (
<SlotBridge name="app.terminal" fallback={TerminalPanel} cwd={currentProject?.path || appRoot}  />
)}
{perfEnabled && bottomTab === "perf" && (
<SlotBridge name="app.performance-dashboard" fallback={PerformanceDashboard} onClose={() => setBottomTab("chat")}  />
)}
{gameEnabled && bottomTab === "game" && (
  <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
    <Suspense fallback={<div style={{ color: "#fff", textAlign: "center", marginTop: 200 }}>加载游戏...</div>}>
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
onPerf={perfEnabled ? () => { setBottomTab("perf"); setMobileSidebarOpen(false); } : undefined}
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
            planApproval.resolve({ approved: true });
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
          subagentTasks={(() => {
            try {
              const { getSubagentRuntime } = require("./core/subagent/index");
              const runtime = getSubagentRuntime();
              return runtime ? runtime.getAllTasks() : [];
            } catch { return []; }
          })()}
          onSelectSubagent={() => {
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
                  style={{ padding: "10px 16px", borderRadius: 6, border: "1px solid var(--border-primary)", background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer", fontSize: 'var(--fs-base)', textAlign: "left" }}
                  onClick={() => { useProjectStore.getState().deleteProject(id); setRemoveProjectDialog(null); }}
                >
                  <span style={{ fontWeight: 600 }}>📁 {lang === "zh" ? "仅移除项目" : "Remove Only"}</span>
                  <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除，不删除文件" : "Remove from list, keep files"}</div>
                </button>
                <button
                  style={{ padding: "10px 16px", borderRadius: 6, border: "1px solid #e74c3c", background: "none", color: "#e74c3c", cursor: "pointer", fontSize: 'var(--fs-base)', textAlign: "left" }}
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
                  <span style={{ fontWeight: 600 }}><Trash2 size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> {lang === "zh" ? "移除并删除文件到回收站" : "Remove & Recycle"}</span>
                  <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginTop: 2 }}>{lang === "zh" ? "从列表移除 + 文件送入回收站" : "Remove from list + send files to Recycle Bin"}</div>
                </button>
              </div>
              <button
                className="confirm-btn cancel"
                style={{ width: "100%", padding: "8px 16px", borderRadius: 6 }}
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
      {currentSession && (
        <SlotBridge name="app.needs-you-panel" fallback={NeedsYouPanel}
          sessionId={currentSession.id}
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
        <div className="dialog-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
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
        <div className="dialog-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
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

      {/* P2: Quick Access Cards — show agent shortcuts */}
      {showQuickAccess && messages.length === 0 && !isStreaming && (
        <div style={{ padding: "12px 16px", maxWidth: "600px", margin: "0 auto" }}>
          <SlotBridge name="app.quick-access-cards" fallback={QuickAccessCards}
            agents={((getCtxService('agentRegistry') as any) || { getPrimary: () => [] as any[] }).getPrimary().map((a: any) => ({
              id: a.id,
              name: a.name,
              description: a.description,
              icon: a.id === 'build' ? <Hammer size={20} /> : a.id === 'plan' ? <ClipboardList size={20} /> : a.id === 'explore' ? <Search size={20} /> : <Bot size={20} />,
            }))}
            favoriteIds={quickAccessFavorites}
            onSelect={(agentId: string) => {
              const agent = ((getCtxService('agentRegistry') as any) || { get: () => null }).get(agentId);
              if (agent) {
                // Switch collaboration mode based on agent's config
                if (agent.collaborationMode === "plan") {
                  setCollaborationMode("plan");
                } else {
                  setCollaborationMode("default");
                }
                // Pre-fill input with agent context and send
                const prompt = lang === 'zh'
                  ? `使用${agent.name}模式：${agent.description}`
                  : `Use ${agent.name} mode: ${agent.description}`;
                handleSend(prompt);
              }
              setShowQuickAccess(false);
            }}
            onToggleFavorite={(agentId: string) => {
              setQuickAccessFavorites(prev => {
                const next = new Set(prev);
                if (next.has(agentId)) next.delete(agentId);
                else next.add(agentId);
                setSettingJSON("codem-quick-access-favorites", Array.from(next));
                return next;
              });
            }}
          />
        </div>
      )}

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

