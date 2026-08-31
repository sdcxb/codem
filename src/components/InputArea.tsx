import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { MessageAttachment } from "../store";
import { FileUpload } from "./FileUpload";
import { SlotBridge } from "../core/slots/SlotBridge";
import { SlotListBridge } from "../core/slots/SlotBridge";
import { PlanModeChip } from "./PlanModeChip";
import { ModelSelector } from "./ModelSelector";
import { PermissionPresetSelector } from "./PermissionPresetSelector";
import { GoalBar } from "./GoalBar";
import { useLang, S } from "../core/i18n/lang";
import type { CollaborationMode } from "../core/agent/agent";
import { SECURITY_MODES, getEffectiveSecurityMode, setProjectSecurityMode, setGlobalSecurityMode, type SecurityMode } from "../core/permission/security-mode";
import { getSkillRegistry } from "../core/skill/skill";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { getCustomOperations, runCustomOperation, getProjectExecutionMode, setProjectExecutionMode, getCurrentBranch, listBranches, isGitRepo, type ExecutionMode } from "../core/environment";
import type { CustomOperation } from "../core/settings/settings";
import { SlashCommandMenu, type SlashCommandItem } from "./SlashCommandMenu";
import { getMultimodalSettings, type MultimodalProviderConfig } from "../core/llm/multimodal";
import { useProjectStore } from "../core/store";
import { ContextBadgeList } from "./ContextBadgeList";
import { MentionAutocomplete, type MentionItem } from "./MentionAutocomplete";
import { ComposerBadges, type ComposerBadge } from "./ComposerBadges";
import { GenerateModeSelector } from "./GenerateModeSelector";
import { ResolutionSelector } from "./ResolutionSelector";
import { SourceSelector } from "./SourceSelector";
import { listSources } from "../core/knowledge";
import { MIMO_MODELS, getConfiguredApiModels, getModelsForMode, type ModelOption } from "../core/model-config";
import { listFilesForMention, getRelativePath } from "../core/file-mention";
import {
  MessageSquare, X, Image as ImageIcon, FileText, Paperclip, Target,
  Volume2, ClipboardList, Zap, BookMarked, Minimize2, Maximize2,
  Square, ArrowRight, ChevronUp, StickyNote, Folder, Globe,
  Home, GitBranch, Clock, RefreshCw, Check, Wrench, Shield, Rocket,
  Sparkles, Cpu, ChevronDown, Wifi, AlertCircle,
  Mic, Square as SquareIcon,
} from "lucide-react";

// Map security mode emoji icons to Lucide components
const securityIconMap: Record<string, JSX.Element> = {
  "🛡️": <Shield size={15} />,
  "⚡": <Zap size={15} />,
  "🚀": <Rocket size={15} />,
};

interface InputAreaProps {
onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
onCancel: () => void;
disabled: boolean;
isStreaming: boolean;
/** No session selected — show "select or create session" hint */
noSession?: boolean;
/** Session ID — when this changes, internal state (attachments, skills, draft) is reset */
sessionKey?: string;
  collaborationMode: CollaborationMode;
  onModeChange: (mode: CollaborationMode) => void;
  /** Project path for per-project security mode */
  projectPath?: string;
  /** #5: Quoted text from selection tooltip */
  quoteContext?: string | null;
  onClearQuote?: () => void;
  /** Bug9: 建议卡片点击时直接替换输入框内容 */
  suggestionPrompt?: string | null;
  onSuggestionConsumed?: () => void;
  /** P3: Active notebook ID for source selector */
  notebookId?: string;
  /** More-actions menu callbacks (per benchmark plan) */
  onToggleSearch?: () => void;
  onToggleQuickPhrase?: () => void;
  onToggleDraftPicker?: () => void;
  onToggleDisplayMode?: () => void;
  onToggleGit?: () => void;
  onToggleWorkbench?: () => void;
  onToggleRightSidebar?: () => void;
  hasDrafts?: boolean;
  /** P0: Model selector props — model picker now lives in input area bottom bar */
  model?: string;
  onModelChange?: (model: string) => void;
  mode?: "cli" | "api";
  /** P1: Connection status indicator */
  connected?: boolean;
  /** Hide knowledge source selector button (notebook mode — source filtering handled externally) */
  hideSourceSelector?: boolean;
}

// HTML escape for backdrop rendering
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function InputArea({ onSend, onCancel, disabled, isStreaming, noSession, sessionKey, collaborationMode, onModeChange, projectPath, quoteContext, onClearQuote, suggestionPrompt, onSuggestionConsumed, notebookId, onToggleSearch, onToggleWorkbench, onToggleQuickPhrase, onToggleDraftPicker, onToggleDisplayMode, onToggleGit, onToggleRightSidebar, hasDrafts, model, onModelChange, mode = "cli", connected = true, hideSourceSelector }: InputAreaProps) {
  const lang = useLang();
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [showSecurityPicker, setShowSecurityPicker] = useState(false);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(projectPath));
  const [showPlusMenu, setShowPlusMenu] = useState(false);
const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRowRef = useRef<HTMLDivElement>(null);
  const [slashMenuPos, setSlashMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [expanded, setExpanded] = useState(false);

  // P3-26: Voice input — Web Speech API STT
  const {
    isListening: isListeningVoice,
    interimTranscript: voiceInterim,
    isSupported: voiceSupported,
    start: startVoice,
    stop: stopVoice,
    reset: resetVoice,
  } = useSpeechRecognition({
    continuous: true,
    interimResults: true,
    onFinalResult: (text) => {
      // Append recognized text to current input
      setInput(prev => {
        const newVal = prev + text;
        setDraft(newVal);
        return newVal;
      });
    },
    onInterimResult: (text) => {
      // Show interim text in a subtle indicator (state is tracked via interimTranscript)
      // We don't modify the input directly during interim to avoid cursor jumping
    },
  });

  // Handle voice start/stop toggle
  const handleVoiceToggle = useCallback(() => {
    if (!voiceSupported) return;
    if (isListeningVoice) {
      stopVoice();
      // Flush any interim text
      if (voiceInterim) {
        setInput(prev => {
          const newVal = prev + voiceInterim;
          setDraft(newVal);
          return newVal;
        });
      }
    } else {
      resetVoice();
      startVoice();
    }
  }, [voiceSupported, isListeningVoice, stopVoice, startVoice, resetVoice, voiceInterim]);

  // Auto-focus textarea after voice stops
  useEffect(() => {
    if (!isListeningVoice) {
      // Refocus textarea and place cursor at end
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      }
    }
  }, [isListeningVoice]);
  const [customOps, setCustomOps] = useState<CustomOperation[]>([]);
  const [runningOp, setRunningOp] = useState<string | null>(null);
  const [slashFilter, setSlashFilter] = useState<string | null>(null);

  // 当 slashFilter 开启时，计算输入框在屏幕中的位置，用 Portal 渲染菜单
  useEffect(() => {
    if (slashFilter !== null && textareaRowRef.current) {
      const rect = textareaRowRef.current.getBoundingClientRect();
      setSlashMenuPos({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 4, // 菜单在输入框上方，留 4px 间距
        width: rect.width,
      });
    } else {
      setSlashMenuPos(null);
    }
  }, [slashFilter]);
  // P4: Mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  // Composer badges: file refs, GitHub links, quotes, URLs
  const [composerBadges, setComposerBadges] = useState<ComposerBadge[]>([]);
  const fileMentionCache = useRef<{ cwd: string; items: MentionItem[]; ts: number } | null>(null);
  // P4: Context badges for current input
  const [contextBadges, setContextBadges] = useState<Array<{ id: string; type: "notebook" | "file" | "url"; label: string; icon?: string }>>([]);
  // P3: Multimodal generate mode + resolution
  const [generateMode, setGenerateMode] = useState<"text" | "image" | "video">("text");
  const [resolution, setResolution] = useState("1024x1024");
  const [showMultimodal, setShowMultimodal] = useState(false);
  // P4: Knowledge source selector (notebook mode)
  const [showSourceSelector, setShowSourceSelector] = useState(false);
  const [notebookSources, setNotebookSources] = useState<Array<{ id: string; name: string; type: "notebook" | "file" | "url" }>>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const { currentProject, currentSession, projects, openProject, createSession, switchSession, getProjectSessions } = useProjectStore();

  // === Bottom bar state ===
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("current_workspace");
  const [currentBranchName, setCurrentBranchName] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [isGitProject, setIsGitProject] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  // P0: IME composition state — prevents Enter from firing during Chinese/Japanese input
  const compositionJustEndedRef = useRef(false);
  // P1: Drag-over state for file drop zone — depth counter prevents flicker on nested elements
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const zh = lang === "zh";

  // DSH-aligned: 构建已安装技能名称集合，用于 backdrop 层检测 /skill-name 模式
  const skillLexicon = useMemo(() => {
    const names = new Set<string>();
    try {
      const disabled = getSettingJSON<string[]>("codem-disabled-skills", []);
      const skills = getSkillRegistry().getAll().filter(s => !disabled.includes(s.name));
      for (const s of skills) {
        names.add(s.name.toLowerCase());
        if (s.displayName) names.add(s.displayName.toLowerCase());
      }
    } catch {}
    return names;
  }, [sessionKey]);

  // DSH-aligned mirror backdrop: 在 backdrop 层中渲染文本，
  // 将 /skill-name 模式高亮为 pill 标签
  const renderBackdropContent = useCallback((text: string, lexicon: Set<string>) => {
    if (!text) return <span />;
    // 匹配 /word 模式（在行首或空格之后）
    // 用 dangerouslySetInnerHTML 确保不在元素之间引入不可见间距
    const regex = /(?:^|\s)(\/[a-zA-Z0-9_-]+)/g;
    let html = "";
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const prefix = match[0].length - match[1].length; // 前导空格或空
      const skillName = match[1].slice(1).toLowerCase(); // 去掉 / 转小写
      const startPos = match.index + prefix;

      // 添加前面的普通文本（HTML escape）
      if (startPos > lastIndex) {
        html += escapeHtml(text.slice(lastIndex, startPos));
      }

      // 检查是否匹配已安装技能
      const isSkill = lexicon.has(skillName);
      if (isSkill) {
        // 渲染为高亮 pill 标签
        html += `<span class="skill-pill-token">${escapeHtml(match[1])}</span>`;
      } else {
        // 非技能的 /xxx 文本，普通渲染
        html += escapeHtml(match[1]);
      }

      lastIndex = startPos + match[1].length;
    }

    // 添加剩余文本
    if (lastIndex < text.length) {
      html += escapeHtml(text.slice(lastIndex));
    }

    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }, []);

  // P1 #12: Draft persistence — saves input per session
  const draftKey = currentSession?.id || currentProject?.id || "__global__";
  const { draft, setDraft, clearDraft } = useDraftPersistence(draftKey);

  // Reset internal state when session changes (new chat / switch session)
  // DSH 对齐: DSH 的 InputBar 中附件状态来自 useInput (session 级别 store)，
  // session 切换时自动重置。mimo-gui 的 InputArea 使用组件内部 state，
  // 需要手动监听 sessionKey 变化并重置。
  const prevSessionKey = useRef(sessionKey);
  useEffect(() => {
    if (prevSessionKey.current !== sessionKey) {
      prevSessionKey.current = sessionKey;
      setPendingAttachments([]);
      setSelectedSkills([]);
      setInput("");
      setSlashFilter(null);
      setComposerBadges([]);
      clearDraft();
    }
  }, [sessionKey]);

  // P1 #15: Random tip text — rotates placeholder periodically
  const tipList = useMemo(() => zh ? [
    "输入问题开始对话 · / 选择技能",
    "拖拽文件直接上传 · @ 提及文件",
    "按 Enter 发送 · Shift+Enter 换行",
    "输入 / 快速选择技能",
    "粘贴图片自动识别并上传",
  ] : [
    "Ask anything · Type / for skills",
    "Drop files to upload · @ to mention",
    "Press Enter to send · Shift+Enter for newline",
    "Type / to quickly select skills",
    "Paste images to auto-upload",
  ], [zh]);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * tipList.length));
  useEffect(() => {
    const timer = setInterval(() => {
      setTipIndex(prev => (prev + 1) % tipList.length);
    }, 8000);
    return () => clearInterval(timer);
  }, [tipList.length]);
  const dynamicPlaceholder = noSession
    ? (lang === "zh" ? "请新建或选择历史对话后发起任务" : "Create or select a session to start")
    : disabled ? S.sidebar.disabledHint[lang]
    : tipList[tipIndex];

  // Load custom operations
  useEffect(() => {
    setCustomOps(getCustomOperations());
    const handler = () => setCustomOps(getCustomOperations());
    window.addEventListener("codem-settings-changed", handler);
    return () => window.removeEventListener("codem-settings-changed", handler);
  }, []);

  // Load execution mode + git info when project changes
  useEffect(() => {
    if (!projectPath) {
      setExecutionMode("current_workspace");
      setIsGitProject(false);
      setCurrentBranchName("");
      setBranches([]);
      return;
    }
    setExecutionMode(getProjectExecutionMode(projectPath));
    isGitRepo(projectPath).then(async (isRepo) => {
      setIsGitProject(isRepo);
      if (isRepo) {
        setBranchLoading(true);
        try {
          const [br, allBr] = await Promise.all([
            getCurrentBranch(projectPath),
            listBranches(projectPath),
          ]);
          setCurrentBranchName(br);
          setBranches(allBr);
        } catch {
          setCurrentBranchName("");
          setBranches([]);
        } finally {
          setBranchLoading(false);
        }
      } else {
        setCurrentBranchName("");
        setBranches([]);
      }
    });
  }, [projectPath]);

  // Listen for execution mode changes
  useEffect(() => {
    const handler = () => {
      if (projectPath) setExecutionMode(getProjectExecutionMode(projectPath));
    };
    window.addEventListener("codem-execution-mode-changed", handler);
    return () => window.removeEventListener("codem-execution-mode-changed", handler);
  }, [projectPath]);

  const refreshBranch = useCallback(async () => {
    if (!projectPath) return;
    setBranchLoading(true);
    try {
      const [br, allBr] = await Promise.all([
        getCurrentBranch(projectPath),
        listBranches(projectPath),
      ]);
      setCurrentBranchName(br);
      setBranches(allBr);
    } catch { /* ignore */ } finally {
      setBranchLoading(false);
    }
  }, [projectPath]);

  const handleRunOp = async (op: CustomOperation) => {
    if (!op.command.trim() || runningOp) return;
    setRunningOp(op.id);
    try {
      const { useProjectStore } = await import("../core/store");
      const cwd = useProjectStore.getState().currentProject?.path;
      if (!cwd) return;
      await runCustomOperation(op.id, cwd);
    } catch (e) {
      console.error("[InputArea] Custom operation failed:", e);
    } finally {
      setRunningOp(null);
    }
  };

  useEffect(() => {
    if (quoteContext) {
      const quoted = quoteContext.split("\n").map((line) => `> ${line}`).join("\n");
      setInput((prev) => prev ? `${prev}\n\n${quoted}\n\n` : `${quoted}\n\n`);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [quoteContext]);

  // Bug9: 建议卡片点击时直接替换输入框内容（而非追加）
  useEffect(() => {
    if (suggestionPrompt) {
      setInput(suggestionPrompt);
      setDraft(suggestionPrompt);
      setTimeout(() => textareaRef.current?.focus(), 50);
      onSuggestionConsumed?.();
    }
  }, [suggestionPrompt, onSuggestionConsumed]);

  useEffect(() => {
    setSecurityMode(getEffectiveSecurityMode(projectPath));
  }, [projectPath]);

  useEffect(() => {
    const handler = () => setSecurityMode(getEffectiveSecurityMode(projectPath));
    window.addEventListener("codem-security-mode-changed", handler);
    return () => window.removeEventListener("codem-security-mode-changed", handler);
  }, [projectPath]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 280)}px`;
    }
  }, [input]);

  const handleSubmit = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || disabled) return;
    // P3: Prepend generate mode hint for non-text modes
    let message = input.trim();
    if (showMultimodal && generateMode !== "text") {
      const modeHint = generateMode === "image" ? `[Generate image at ${resolution}] ` : `[Generate video at ${resolution}] `;
      message = modeHint + message;
    }
    onSend(message, pendingAttachments.length > 0 ? pendingAttachments : undefined, selectedSkills.length > 0 ? selectedSkills : undefined);
    // P1 #12: Clear draft on send
    clearDraft();
    setInput("");
    setPendingAttachments([]);
    setSelectedSkills([]);
    setSlashFilter(null);
    setComposerBadges([]);
    // P3: Reset multimodal after send
    if (showMultimodal && generateMode !== "text") {
      setGenerateMode("text");
      setShowMultimodal(false);
    }
  };

  // P0: Model list for inline model selector
  const modelList: ModelOption[] = getModelsForMode(mode);
  const currentModelName = modelList.find(m => m.id === model)?.name || model || "";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // P0: IME composition guard — suppress Enter right after compositionEnd
    if (compositionJustEndedRef.current) {
      compositionJustEndedRef.current = false;
      if (e.key === "Enter") {
        e.preventDefault();
        return;
      }
    }
    // DSH-aligned: 当 slash 命令菜单或 mention 菜单打开时，
    // Enter/ArrowUp/ArrowDown/Escape 由各自的 keydown handler 处理，不触发发送
    if (slashFilter !== null || mentionQuery !== null) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // P0: Also check nativeEvent.isComposing for extra safety
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const ext = file.type.split("/")[1] || "png";
      const name = `clipboard-${Date.now()}.${ext}`;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const attachment: MessageAttachment = {
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name, type: "image", content: dataUrl, mimeType: file.type, size: file.size,
        };
        setPendingAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = (attachments: MessageAttachment[]) => {
    setPendingAttachments((prev) => [...prev, ...attachments]);
  };

  // === Composer badge helpers ===

  const addFileBadge = useCallback((path: string, name: string) => {
    setComposerBadges((prev) => {
      if (prev.some((b) => b.id === `file-${path}`)) return prev;
      return [...prev, { id: `file-${path}`, type: "file" as const, label: name, meta: getRelativePath(path, currentProject?.path || ""), removable: true }];
    });
  }, [currentProject]);

  const addGithubBadge = useCallback((url: string) => {
    setComposerBadges((prev) => {
      if (prev.some((b) => b.id === `github-${url}`)) return prev;
      const match = url.match(/github\.com\/([^/\s?#]+)/);
      const repoName = match ? match[1] : url;
      return [...prev, { id: `github-${url}`, type: "github" as const, label: repoName, meta: url, removable: true }];
    });
  }, []);

  const removeBadge = useCallback((id: string) => {
    setComposerBadges((prev) => prev.filter((b) => b.id !== id));
  }, []);

  // === GitHub URL detection in text ===
  const detectGithubUrls = useCallback((text: string) => {
    const urlRegex = /https?:\/\/github\.com\/[^\s<>"']+/gi;
    const matches = text.match(urlRegex);
    if (matches) {
      matches.forEach((url) => {
        const cleaned = url.replace(/[),.;\]]+$/, "");
        addGithubBadge(cleaned);
      });
    }
  }, [addGithubBadge]);

  // === Load files for @mention from real filesystem ===
  const loadMentionFiles = useCallback(async (cwd: string) => {
    const now = Date.now();
    if (fileMentionCache.current && fileMentionCache.current.cwd === cwd && now - fileMentionCache.current.ts < 10000) {
      return fileMentionCache.current.items;
    }
    const files = await listFilesForMention(cwd);
    const items: MentionItem[] = files.map((f) => ({
      id: f.id,
      type: f.type === "folder" ? "notebook" as const : "file" as const,
      label: f.label,
      path: f.path,
    }));
    fileMentionCache.current = { cwd, items, ts: now };
    return items;
  }, []);

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const cycleSecurityMode = () => {
    const modes: SecurityMode[] = ["ask", "auto", "full"];
    const currentIdx = modes.indexOf(securityMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    if (projectPath) setProjectSecurityMode(projectPath, nextMode);
    else setGlobalSecurityMode(nextMode);
    setShowSecurityPicker(false);
  };

  const selectSecurityMode = (mode: SecurityMode) => {
    if (projectPath) setProjectSecurityMode(projectPath, mode);
    else setGlobalSecurityMode(mode);
    setShowSecurityPicker(false);
  };

  const handleExecutionModeChange = async (mode: ExecutionMode) => {
    if (!projectPath) {
      setShowModeMenu(false);
      return;
    }
    // Check for uncommitted changes before switching modes
    if (isGitProject) {
      try {
        const { hasUncommittedChanges } = await import("../core/environment");
        const dirty = await hasUncommittedChanges(projectPath);
        if (dirty) {
          if (!confirm(zh
? "当前工作区有未提交的修改。切换模式可能导致修改丢失。确认切换？"
: "The current workspace has uncommitted changes. Switching modes may cause loss. Continue?")) {
            setShowModeMenu(false);
            return;
          }
        }
      } catch {
        // If check fails, proceed anyway
      }
    }
    setProjectExecutionMode(projectPath, mode);
    setExecutionMode(mode);
    if (mode === "git_worktree") refreshBranch();
    setShowModeMenu(false);
  };

const handleSelectProject = (projectId: string) => {
  openProject(projectId);
  // Try to open the most recently interacted session instead of always creating a new one
  const sessions = getProjectSessions(projectId);
  if (sessions.length > 0) {
    // Sort by lastMessageAt descending, pick the most recent
    const sorted = [...sessions].sort((a: any, b: any) => {
      const aTime = a.lastMessageAt || a.createdAt || 0;
      const bTime = b.lastMessageAt || b.createdAt || 0;
      return bTime - aTime;
    });
    switchSession(sorted[0].id);
  } else {
    // No existing sessions — create a new one
    createSession();
  }
  setShowProjectMenu(false);
};

  // Close all bottom-bar dropdowns
  const closeBottomMenus = useCallback(() => {
    setShowProjectMenu(false);
    setShowModeMenu(false);
    setShowBranchMenu(false);
    setShowModelMenu(false);
  }, []);

  const currentModeInfo = SECURITY_MODES.find(m => m.mode === securityMode)!;

  // Whether execution mode can be changed (locked when streaming)
  const modeLocked = isStreaming;

  return (
    <div className={`input-area input-card-container ${isDragOver ? "drag-over" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        dragDepthRef.current++;
        setIsDragOver(true);
      }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDragOver(false);
        // Check for file path drag from FileExplorer (custom data type)
        const filePath = e.dataTransfer.getData("application/x-file-path");
        const fileName = e.dataTransfer.getData("application/x-file-name");
        if (filePath && fileName) {
          // File dragged from file browser → add as file reference badge
          addFileBadge(filePath, fileName);
          // Also insert @filename mention in text
          const mention = `@${fileName} `;
          const newVal = (input ? input + " " : "") + mention;
          setInput(newVal);
          setDraft(newVal);
          return;
        }
        // P1: Handle OS-level file drop (files from outside the app)
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
          const atts: MessageAttachment[] = files.map(f => ({
            id: `drop-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
            name: f.name, type: f.type.startsWith("image/") ? "image" : "file",
            content: "", mimeType: f.type, size: f.size,
          }));
          setPendingAttachments(prev => [...prev, ...atts]);
        }
      }}
    >
      {/* SlotBridge 消费 app.goal-bar — 目标指示条（对标 DSH GoalBar） */}
      <SlotBridge
        name="app.goal-bar"
        fallback={null}
      />
      {/* Quote context banner — enhanced reference card */}
      {quoteContext && (
        <div className="quote-context-banner quote-context-card">
          <div className="quote-context-left">
            <span className="quote-context-icon"><MessageSquare size={14} /></span>
            <div className="quote-context-body">
              <span className="quote-context-label">{zh ? "引用对话" : "Quoted message"}</span>
              <span className="quote-context-text">{quoteContext.length > 120 ? quoteContext.substring(0, 120) + "..." : quoteContext}</span>
            </div>
          </div>
          <button className="quote-context-clear" onClick={() => onClearQuote?.()}><X size={14} /></button>
        </div>
      )}

      {/* Composer badges — file refs, GitHub links, etc. */}
      <ComposerBadges badges={composerBadges} onRemove={removeBadge} />

      {/* Pending Attachments */}
      {pendingAttachments.length > 0 && (
        <div className="pending-attachments">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="pending-attachment">
              <span className="attachment-icon">{att.type === "image" ? <ImageIcon size={14} /> : <FileText size={14} />}</span>
              {att.type === "image" && att.content ? (
                <img src={att.content} alt={att.name} style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4, marginRight: 4 }} />
              ) : null}
              <span className="attachment-name">{att.name}</span>
              {att.size && <span className="attachment-size">{formatSize(att.size)}</span>}
              <button className="attachment-remove" onClick={() => removeAttachment(att.id)}><X size={12} /></button>
            </div>
          ))}
          {pendingAttachments.some((a) => a.type === "image") && (() => {
            const visionConfig = getMultimodalSettings().vision;
            const settings = JSON.parse(localStorage.getItem("codem-settings") || "{}");
            const currentModel = settings.model || "";
            const supportsVision = currentModel.startsWith("gpt-4o") || currentModel.startsWith("claude-3") || currentModel.startsWith("claude-4") || currentModel.startsWith("gemini-1.5") || currentModel.startsWith("gemini-2") || currentModel.startsWith("o3") || currentModel.startsWith("o4");
            if (!supportsVision && !visionConfig?.enabled) {
              return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>{zh ? "当前模型不支持视觉，图片将以文字标注发送。配置视觉代理请在 设置→多模态→Vision 中开启。" : "Current model doesn't support vision. Images will be sent as text. Configure vision proxy in Settings→Multimodal→Vision."}</div>;
            } else if (!supportsVision && visionConfig?.enabled) {
              return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>{zh ? "将使用视觉代理 (" + visionConfig.model + ") 描述图片内容" : "Will use vision proxy (" + visionConfig.model + ") to describe image"}</div>;
            }
            return null;
          })()}
        </div>
      )}

      {/* === P-UI: 两行结构 — textarea 上方独占，action row 下方 === */}
      <div className="input-wrapper">
        {/* Textarea row — textarea 占满全部宽度 */}
        <div className="input-textarea-row" ref={textareaRowRef}>
          {/* Slash command menu — 用 Portal 渲染到 document.body，避免被 overflow:hidden 裁剪 */}
          {slashFilter !== null && slashMenuPos && createPortal(
            <div style={{
              position: "fixed",
              left: slashMenuPos.left,
              bottom: slashMenuPos.bottom,
              width: slashMenuPos.width,
              zIndex: 99999,
            }}>
              <SlotBridge
                name="app.ui-commands"
                fallback={SlashCommandMenu}
                filter={slashFilter}
                onSelect={(item: SlashCommandItem) => {
                  // DSH-aligned: 将 /skill-name 作为字面文本插入输入框
                  // 发送时 processSkillGestures 会检测 /name 手势并注入 <skill_content>
                  const newVal = input.replace(/\/([^\s]*)$/, `/${item.id} `);
                  setInput(newVal);
                  setDraft(newVal);
                  setSlashFilter(null);
                  textareaRef.current?.focus();
                }}
                onClose={() => setSlashFilter(null)}
              />
            </div>,
            document.body
          )}

          {/* SlotListBridge 消费 conversation.input slot — 允许插件注入输入区组件 */}
          <SlotListBridge name="conversation.input" />

          {/* P4: Mention autocomplete dropdown */}
          {mentionQuery !== null && (
            <MentionAutocomplete
              items={mentionItems}
              query={mentionQuery}
              onSelect={(item) => {
                const newVal = input.replace(/@([^\s]*)$/, `@${item.label} `);
                setInput(newVal);
                setDraft(newVal);
                setMentionQuery(null);
                if (item.type === "file" && item.path) {
                  addFileBadge(item.path, item.label);
                }
                textareaRef.current?.focus();
              }}
              onClose={() => setMentionQuery(null)}
            />
          )}

          {/* P4: Context badges showing active attachments and skills */}
          <ContextBadgeList badges={contextBadges} />

          {/* DSH-aligned mirror backdrop: 在 textarea 下叠一层 backdrop div，
              将 /skill-name 模式渲染为高亮 pill 标签。
              textarea 文字透明（caret 仍可见），backdrop 提供可见的文本和 pill 高亮。 */}
          <div className={`input-backdrop-wrapper ${expanded ? "expanded" : ""}`}>
            <div className="input-backdrop" aria-hidden="true">
              {renderBackdropContent(draft || input, skillLexicon)}
            </div>
            <textarea
              ref={textareaRef}
              className={`message-input ${expanded ? "expanded" : ""} ${isListeningVoice ? "voice-listening" : ""}`}
              value={draft || input}
            onChange={(e) => {
              const val = e.target.value;
              setDraft(val);
              setInput(val);
              const slashMatch = val.match(/(?:^|\s)\/([^\s]*)$/);
              setSlashFilter(slashMatch ? slashMatch[1] : null);
              const mentionMatch = val.match(/(?:^|\s)@([^\s]*)$/);
              if (mentionMatch) {
                setMentionQuery(mentionMatch[1]);
                if (currentProject?.path) {
                  loadMentionFiles(currentProject.path).then(setMentionItems);
                }
              } else {
                setMentionQuery(null);
              }
              detectGithubUrls(val);
              const badges: Array<{ id: string; type: "notebook" | "file" | "url"; label: string; icon?: string }> = [];
              if (pendingAttachments.length > 0) {
                pendingAttachments.forEach((att) => {
                  badges.push({ id: att.id, type: "file", label: att.name, icon: "file" });
                });
              }
              setContextBadges(badges);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { compositionJustEndedRef.current = false; }}
            onCompositionEnd={() => {
              compositionJustEndedRef.current = true;
              setTimeout(() => { compositionJustEndedRef.current = false; }, 100);
            }}
            onPaste={handlePaste}
            placeholder={dynamicPlaceholder}
            disabled={disabled}
            rows={2}
          />

          {/* P3-26: Voice interim text indicator */}
          {isListeningVoice && voiceInterim && (
            <span style={{
              position: "absolute",
              right: 60,
              bottom: 8,
              fontSize: 11,
              color: "var(--text-muted)",
              fontStyle: "italic",
              opacity: 0.7,
              pointerEvents: "none",
              maxWidth: 200,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {voiceInterim}
            </span>
          )}
          </div>
        </div>

        {/* Action row — 左侧工具按钮 + 右侧发送按钮 */}
        <div className="input-action-row">
          {/* 左侧工具组 */}
          <div className="input-tools-left">
            {/* + button — 添加文件/技能/多模态 */}
            <div style={{ position: "relative" }}>
              <button
                className="mode-toggle-btn"
                onClick={() => setShowPlusMenu(!showPlusMenu)}
                title={zh ? "添加" : "Add"}
                style={showPlusMenu ? { background: "var(--accent)", color: "#fff", fontSize: 10, width: 18, height: 18, padding: 0, minWidth: 18 } : { fontSize: 10, width: 18, height: 18, padding: 0, minWidth: 18 }}
              >
                ＋
              </button>
              {showPlusMenu && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowPlusMenu(false)} />
                  <div className="skill-picker-popup" style={{
                    position: "absolute", bottom: "100%", left: 0, marginBottom: 4,
                    minWidth: 200, zIndex: 100, padding: 4,
                  }}>
                    <button className="more-action-item" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 12, width: "100%", textAlign: "left" }}
                      onClick={() => { setShowPlusMenu(false); document.getElementById('file-upload-input')?.click(); }}>
                      <Paperclip size={14} /> <span>{zh ? "上传文件" : "Upload file"}</span>
                    </button>
                    <button className="more-action-item" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 12, width: "100%", textAlign: "left" }}
                      onClick={() => { setShowPlusMenu(false); setShowSkillPicker(true); }}>
                      <Target size={14} /> <span>{zh ? "选择技能" : "Select skills"}</span>
                    </button>
                    <div style={{ height: 1, background: "var(--border-color)", margin: "4px 0" }} />
                    {(() => {
                      const mmSettings = getMultimodalSettings();
                      const imageGenConfig = mmSettings.imageGen;
                      const ttsConfig = mmSettings.tts;
                      return (<>
                        <button
                          disabled={!imageGenConfig}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                            cursor: imageGenConfig ? "pointer" : "not-allowed",
                            border: "none", fontSize: 12, width: "100%", textAlign: "left",
                            background: "transparent",
                            color: imageGenConfig ? "var(--text-primary)" : "var(--text-muted)",
                          }}
                          title={imageGenConfig ? (zh ? "生成图片" : "Generate image") : (zh ? "请先在设置中配置图像生成模型" : "Please configure image generation model in Settings")}
                          onClick={() => {
                            if (!imageGenConfig) return;
                            setShowPlusMenu(false);
                            setShowMultimodal(true);
                            setGenerateMode("image");
                            textareaRef.current?.focus();
                          }}
                        >
                          <ImageIcon size={14} /> <span>{zh ? "生成图片" : "Generate image"}</span>
                          {!imageGenConfig && <span style={{ fontSize: 9, opacity: 0.6, marginLeft: "auto" }}>{zh ? "未配置" : "Not configured"}</span>}
                        </button>
                        <button
                          disabled={!ttsConfig}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                            cursor: ttsConfig ? "pointer" : "not-allowed",
                            border: "none", fontSize: 12, width: "100%", textAlign: "left",
                            background: "transparent",
                            color: ttsConfig ? "var(--text-primary)" : "var(--text-muted)",
                          }}
                          title={ttsConfig ? (zh ? "语音合成" : "Voice synthesis") : (zh ? "请先在设置中配置语音合成模型" : "Please configure TTS model in Settings")}
                          onClick={() => {
                            if (!ttsConfig) return;
                            setShowPlusMenu(false);
                            setShowMultimodal(true);
                            setGenerateMode("text");
                            setInput((prev) => prev || (zh ? "请将以下文本转为语音：" : "Convert the following text to speech: "));
                            textareaRef.current?.focus();
                          }}
                        >
                          <Volume2 size={14} /> <span>{zh ? "语音合成" : "Voice synthesis"}</span>
                          {!ttsConfig && <span style={{ fontSize: 9, opacity: 0.6, marginLeft: "auto" }}>{zh ? "未配置" : "Not configured"}</span>}
                        </button>
                      </>);
                    })()}
                  </div>
                </>
              )}
            </div>

            {/* Hidden file upload input — SlotBridge 消费 app.attachment slot */}
            <SlotBridge name="app.attachment" fallback={FileUpload} onUpload={handleUpload} hideButton />

            {/* Skill picker popup */}
            <div style={{ position: "relative" }}>
              {showSkillPicker && (
                <>
                  <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} onClick={() => setShowSkillPicker(false)} />
                  <div className="skill-picker-popup" style={{
                    position: "absolute", bottom: "100%", left: 0, marginBottom: 4,
                    minWidth: 220, maxWidth: 320, zIndex: 100, maxHeight: 300, overflowY: "auto",
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, opacity: 0.7 }}>
                      {zh ? "选择技能（本次消息）" : "Select skills (this message)"}
                    </div>
                    {(() => {
                      let disabled: string[] = [];
                      try { disabled = getSettingJSON<string[]>("codem-disabled-skills", []); } catch {}
                      const skills = getSkillRegistry().getAll().filter(s => !disabled.includes(s.name));
                      if (skills.length === 0) {
                        return <div style={{ fontSize: 11, opacity: 0.5, padding: "8px 0" }}>{zh ? "无可用技能" : "No skills available"}</div>;
                      }
                      return skills.map(s => (
                        <label key={s.name} style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 4px", cursor: "pointer", borderRadius: 4, fontSize: 11 }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary)")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          <input type="checkbox" checked={selectedSkills.includes(s.name)} onChange={(e) => {
                            if (e.target.checked) setSelectedSkills([...selectedSkills, s.name]);
                            else setSelectedSkills(selectedSkills.filter(n => n !== s.name));
                          }} style={{ marginTop: 2 }} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{s.displayName || s.name}</div>
                            <div style={{ opacity: 0.6, fontSize: 10, lineHeight: 1.3 }}>{s.description}</div>
                          </div>
                        </label>
                      ));
                    })()}
                  </div>
                </>
              )}
            </div>

            {/* Collaboration mode — SlotBridge 消费 app.plan-mode-chip */}

            {/* P4: Knowledge source selector (notebook mode) — hidden when hideSourceSelector is true */}
            {notebookId && !hideSourceSelector && (
              <button
                className={`mode-toggle-btn ${showSourceSelector ? "active" : ""}`}
                onClick={() => {
                  if (!showSourceSelector) {
                    try {
                      const sources = listSources(notebookId);
                      setNotebookSources(sources.map(s => ({ id: s.id, name: s.name, type: (s.type as any) || "file" })));
                    } catch {}
                  }
                  setShowSourceSelector(!showSourceSelector);
                }}
                title={zh ? "知识来源选择器" : "Knowledge source selector"}
                style={showSourceSelector ? { background: "var(--accent)", color: "#fff" } : {}}
              >
                <BookMarked size={14} />
              </button>
            )}
            {showSourceSelector && notebookId && !hideSourceSelector && (
              <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 100 }}>
                <SourceSelector
                  sources={notebookSources}
                  selectedIds={selectedSourceIds}
                  onSelectionChange={setSelectedSourceIds}
                />
              </div>
            )}

            {/* Security mode — SlotBridge 消费 app.permission-preset-selector */}
            <SlotBridge
              name="app.permission-preset-selector"
              fallback={PermissionPresetSelector}
              projectPath={projectPath}
              currentMode={securityMode}
              onModeChange={(m: SecurityMode) => {
                setSecurityMode(m)
                if (projectPath) setProjectSecurityMode(projectPath, m)
                else setGlobalSecurityMode(m)
              }}
              compact
              locked={isStreaming}
            />

            {/* P3: Multimodal generate mode panel */}
            {showMultimodal && generateMode !== "text" && (
              <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 100, padding: "8px 12px", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 6, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <GenerateModeSelector mode={generateMode} onModeChange={setGenerateMode} />
                <ResolutionSelector resolution={resolution} onResolutionChange={setResolution} />
                <button
                  onClick={() => { setShowMultimodal(false); setGenerateMode("text"); }}
                  style={{ marginLeft: "auto", padding: "4px 8px", fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border-primary)", borderRadius: 4 }}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {/* 右侧发送组 */}
          <div className="input-tools-right">
            {/* Voice input */}
            <button
              className={`mode-toggle-btn ${isListeningVoice ? "voice-rec-active" : ""}`}
              onClick={handleVoiceToggle}
              disabled={disabled || !voiceSupported}
              title={voiceSupported
                ? (isListeningVoice ? S.voice.stopListening[lang] : S.voice.startListening[lang])
                : S.voice.speechUnsupported[lang]
              }
              style={{
                color: isListeningVoice ? "var(--danger, #ef4444)" : undefined,
                opacity: voiceSupported ? 1 : 0.3,
              }}
            >
              {isListeningVoice ? <SquareIcon size={14} fill="currentColor" /> : <Mic size={14} />}
            </button>

            {/* Expand/collapse */}
            <button
              className="mode-toggle-btn"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? S.sidebar.collapseInput[lang] : S.sidebar.expandInput[lang]}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>

            {/* Send button group: send + up-arrow */}
            <div style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0, position: "relative" }}>
              {isStreaming ? (
                <button className="send-btn cancel-btn" onClick={onCancel} title={S.input.cancel[lang]} style={{ borderRadius: "6px 0 0 6px" }}><Square size={14} fill="currentColor" /></button>
              ) : (
                <button
                  className={`send-btn ${disabled ? "disabled" : ""}`}
                  onClick={handleSubmit}
                  disabled={disabled || (!input.trim() && pendingAttachments.length === 0)}
                  style={{ borderRadius: "6px 0 0 6px" }}
                  title={zh ? "发送 (Enter)" : "Send (Enter)"}
                ><ArrowRight size={16} /></button>
              )}

              {/* Up-arrow */}
              <button
                onClick={() => setShowMoreActions(!showMoreActions)}
                title={zh ? "快捷短语 / 草稿" : "Quick phrases / Drafts"}
                style={{
                  width: 18, height: 32, padding: 0, border: "none",
                  background: disabled ? "var(--bg-tertiary)" : (showMoreActions ? "var(--accent-hover)" : "var(--accent)"),
                  color: disabled ? "var(--text-muted)" : "white", fontSize: 9, cursor: "pointer",
                  borderRadius: "0 6px 6px 0", display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <ChevronUp size={10} />
              </button>
              {showMoreActions && (
                <>
                  <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setShowMoreActions(false)} />
                  <div className="skill-picker-popup" style={{
                    position: "absolute", bottom: "100%", right: 0, marginBottom: 4,
                    minWidth: 200, zIndex: 100, maxHeight: 400, overflowY: "auto",
                  }}>
                    {onToggleQuickPhrase && (
                      <button className="more-action-item" onClick={() => { onToggleQuickPhrase(); setShowMoreActions(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 12, width: "100%", textAlign: "left" }}>
                        <ClipboardList size={14} /> <span>{zh ? "快捷短语" : "Quick Phrases"}</span>
                      </button>
                    )}
                    {onToggleDraftPicker && hasDrafts && (
                      <button className="more-action-item" onClick={() => { onToggleDraftPicker(); setShowMoreActions(false); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 12, width: "100%", textAlign: "left" }}>
                        <StickyNote size={14} /> <span>{zh ? "提示词草稿" : "Prompt Drafts"}</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* === Bottom control bar — unified single-line with model selector === */}
      {/* Project dropdown backdrop */}
      {(showProjectMenu || showModeMenu || showBranchMenu || showModelMenu) && (
        <div onClick={closeBottomMenus} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      )}

      <div className="input-control-bar">
        {/* Project indicator */}
        <div style={{ position: "relative" }}>
          <button
            className="input-control-item project-indicator"
            onClick={() => { setShowProjectMenu(!showProjectMenu); setShowModeMenu(false); setShowBranchMenu(false); }}
            title={currentProject ? currentProject.path : (zh ? "选择项目" : "Select project")}
          >
            <span style={{ fontSize: 13, display: "flex", alignItems: "center" }}>{currentProject ? <Folder size={13} /> : <Globe size={13} />}</span>
            <span className="project-indicator-name">
              {currentProject ? currentProject.name : (zh ? "全局对话" : "Global")}
            </span>
            <span style={{ fontSize: 9, opacity: 0.5 }}><ChevronDown size={10} /></span>
          </button>
          {showProjectMenu && (
            <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 260, maxHeight: 240, overflowY: "auto" }}>
              <div className="bottom-bar-dropdown-header">{zh ? "切换项目" : "Switch Project"}</div>
              {projects.length === 0 && (
                <div className="bottom-bar-dropdown-empty">{zh ? "无项目" : "No projects"}</div>
              )}
              {projects.map(p => (
                <button
                  key={p.id}
                  className={`bottom-bar-dropdown-item ${currentProject?.id === p.id ? "active" : ""}`}
                  onClick={() => handleSelectProject(p.id)}
                >
                  <span style={{ fontSize: 14, display: "flex", alignItems: "center" }}><Folder size={14} /></span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{p.name}</div>
                    <div style={{ fontSize: 10, opacity: 0.5 }}>{p.path}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="input-control-divider" />

        {/* Execution mode (本地处理 / 新工作树) */}
        <div style={{ position: "relative" }}>
          <button
            className={`input-control-item ${executionMode === "git_worktree" ? "active" : ""}`}
            onClick={() => { if (!modeLocked) { setShowModeMenu(!showModeMenu); setShowProjectMenu(false); setShowBranchMenu(false); } }}
            disabled={modeLocked}
            title={zh ? "执行模式" : "Execution mode"}
            style={{ opacity: modeLocked ? 0.5 : 1 }}
          >
            <span style={{ fontSize: 13, display: "flex", alignItems: "center" }}>{executionMode === "git_worktree" ? <GitBranch size={13} /> : <Home size={13} />}</span>
            <span>{executionMode === "git_worktree" ? (zh ? "新工作树" : "Worktree") : (zh ? "本地处理" : "Local")}</span>
            <span style={{ fontSize: 9, opacity: 0.5 }}><ChevronDown size={10} /></span>
          </button>
          {showModeMenu && (
            <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 200 }}>
              <div className="bottom-bar-dropdown-header">{zh ? "执行模式" : "Execution Mode"}</div>
              <button
                className={`bottom-bar-dropdown-item ${executionMode === "current_workspace" ? "active" : ""}`}
                onClick={() => handleExecutionModeChange("current_workspace")}
              >
                <span style={{ fontSize: 16, display: "flex", alignItems: "center" }}><Home size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{zh ? "本地处理" : "Local workspace"}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{zh ? "共享项目目录" : "Shared project directory"}</div>
                </div>
              </button>
              <button
                className={`bottom-bar-dropdown-item ${executionMode === "git_worktree" ? "active" : ""}`}
                onClick={() => handleExecutionModeChange("git_worktree")}
                disabled={!isGitProject}
                style={{ opacity: isGitProject ? 1 : 0.4 }}
                title={isGitProject ? "" : (zh ? "需要 Git 仓库项目才能使用工作树模式" : "Git repository required for worktree mode")}
              >
                <span style={{ fontSize: 16, display: "flex", alignItems: "center" }}><GitBranch size={16} /></span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{zh ? "新工作树" : "New worktree"}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{zh ? "每次任务独立隔离" : "Isolated per-task"}</div>
                </div>
              </button>
            </div>
          )}
        </div>

        {/* Branch selector (only for git projects) */}
        {isGitProject && (
          <>
            <div className="input-control-divider" />
            <div style={{ position: "relative" }}>
              <button
                className="input-control-item"
                onClick={() => { setShowBranchMenu(!showBranchMenu); setShowProjectMenu(false); setShowModeMenu(false); }}
                title={zh ? "选择分支" : "Select branch"}
              >
                <span style={{ fontSize: 13, display: "flex", alignItems: "center" }}><GitBranch size={13} /></span>
                <span>{branchLoading ? "..." : (currentBranchName || (zh ? "分支" : "Branch"))}</span>
                <span style={{ fontSize: 9, opacity: 0.5 }}><ChevronDown size={10} /></span>
              </button>
              {showBranchMenu && (
                <div className="bottom-bar-dropdown" style={{ position: "absolute", bottom: "100%", left: 0, marginBottom: 4, minWidth: 200, maxHeight: 240, overflowY: "auto" }}>
                  <div className="bottom-bar-dropdown-header" style={{ display: "flex", alignItems: "center" }}>
                    <span>{zh ? "选择分支" : "Select Branch"}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); refreshBranch(); }}
                      style={{ marginLeft: "auto", fontSize: 10, opacity: 0.6, cursor: "pointer", background: "none", border: "none", color: "inherit" }}
                    >
                      {branchLoading ? <Clock size={12} /> : <RefreshCw size={12} />}
                    </button>
                  </div>
                  {branchLoading && <div className="bottom-bar-dropdown-empty">{zh ? "加载中..." : "Loading..."}</div>}
                  {!branchLoading && branches.length === 0 && (
                    <div className="bottom-bar-dropdown-empty">{zh ? "无分支" : "No branches"}</div>
                  )}
                  {!branchLoading && branches.map(br => (
                    <button
                      key={br}
                      className={`bottom-bar-dropdown-item ${br === currentBranchName ? "active" : ""}`}
                      onClick={async () => {
                if (projectPath && br !== currentBranchName) {
                  // Execute git checkout — PowerShell-safe single-quoted paths
                  try {
                    const { executeCommand } = await import("../core/file-api");
                    const safePath = projectPath.replace(/'/g, "''");
                    const safeBranch = br.replace(/'/g, "''");
                    const result = await executeCommand(
                      `git -C '${safePath}' checkout '${safeBranch}'`,
                      projectPath
                    );
                    if (result.exitCode && result.exitCode !== 0) {
                      console.error("[InputArea] git checkout failed:", result.stderr);
                      alert(`${zh ? "切换分支失败: " : "Checkout failed: "}${result.stderr}`);
                    } else {
                      setCurrentBranchName(br);
                    }
                  } catch (e) {
                    console.error("[InputArea] git checkout error:", e);
                    alert(`${zh ? "切换分支失败: " : "Checkout failed: "}${e}`);
                  }
                }
                setShowBranchMenu(false);
              }}
                    >
                      <span style={{ fontSize: 14, display: "flex", alignItems: "center" }}>{br === currentBranchName ? <Check size={14} /> : <GitBranch size={14} />}</span>
                      <span style={{ fontSize: 12 }}>{br}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Custom operations */}
        {customOps.filter(op => op.command.trim()).length > 0 && (
          <>
            <div className="input-control-divider" />
            {customOps.filter(op => op.command.trim()).slice(0, 2).map(op => (
              <button
                key={op.id}
                className="input-control-item"
                onClick={() => handleRunOp(op)}
                disabled={runningOp !== null}
                title={`${op.name}: ${op.command}`}
                style={{ opacity: runningOp === op.id ? 0.5 : 1 }}
              >
                {runningOp === op.id ? <Clock size={12} /> : <Wrench size={12} />} {op.name}
              </button>
            ))}
          </>
        )}

        {/* P1: Connection status indicator */}
        <div className="input-control-divider" />
        <span className="input-control-item" style={{ cursor: "default", opacity: connected ? 0.7 : 1, color: connected ? "var(--text-muted)" : "var(--warning)" }}>
          {connected ? <Wifi size={12} /> : <AlertCircle size={12} />}
          <span>{connected ? (zh ? "已连接" : "Online") : (zh ? "离线" : "Offline")}</span>
        </span>

        {/* Right side: hint */}
        <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
          <Sparkles size={10} />
          {zh ? "输入 / 选择技能 · 拖拽文件上传" : "Type / for skills · Drop files"}
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
