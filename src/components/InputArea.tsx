import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { MessageAttachment } from "../store";
import { FileUpload } from "./FileUpload";
import { showToast } from "./ToastNotification";
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
import { getCustomOperations, runCustomOperation } from "../core/environment";
import type { CustomOperation } from "../core/settings/settings";
import { SlashCommandMenu, type SlashCommandItem } from "./SlashCommandMenu";
import { getMultimodalSettings, transcribeAudioFile, getVoiceInputEngine, isSTTConfigured, type SpeechEngine, type MultimodalProviderConfig } from "../core/llm/multimodal";
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
  Square, ArrowRight, ChevronUp, StickyNote,
  Clock, Check, Wrench, Shield, Rocket,
  Cpu,
  Mic, Square as SquareIcon,
} from "lucide-react";

// Map security mode emoji icons to Lucide components
const securityIconMap: Record<string, JSX.Element> = {
  "🛡️": <Shield size={14} />,
  "⚡": <Zap size={14} />,
  "🚀": <Rocket size={14} />,
};

interface InputAreaProps {
onSend: (message: string, attachments?: MessageAttachment[], selectedSkills?: string[]) => void;
/** When provided and the agent is streaming, the send button injects guidance instead of a new message */
onSendGuidance?: (message: string) => void;
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

/**
 * 选择一个浏览器 MediaRecorder 支持的音频 MIME 类型
 * （优先 opus/webm — Chrome/Edge/WebView2 均支持），找不到则返回 null 用默认值。
 */
function pickAudioRecorderMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // ignore unsupported MIME probes
    }
  }
  return null;
}

export function InputArea({ onSend, onCancel, onSendGuidance, disabled, isStreaming, noSession, sessionKey, collaborationMode, onModeChange, projectPath, quoteContext, onClearQuote, suggestionPrompt, onSuggestionConsumed, notebookId, onToggleSearch, onToggleWorkbench, onToggleQuickPhrase, onToggleDraftPicker, onToggleDisplayMode, onToggleGit, onToggleRightSidebar, hasDrafts, model, onModelChange, mode = "cli", connected = true, hideSourceSelector }: InputAreaProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const [showSecurityPicker, setShowSecurityPicker] = useState(false);
  const [securityMode, setSecurityMode] = useState<SecurityMode>(getEffectiveSecurityMode(projectPath));
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [plusMenuPos, setPlusMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillPickerPos, setSkillPickerPos] = useState<{ left: number; bottom: number } | null>(null);
  const skillPickerBtnRef = useRef<HTMLDivElement>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRowRef = useRef<HTMLDivElement>(null);
  const [slashMenuPos, setSlashMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  // A3 (对标 meow-smooth 失焦折叠): 失焦时把多行输入折叠成单行胶囊，
  // 点击/聚焦即时展开并恢复草稿与滚动位置。
  const [blurFolded, setBlurFolded] = useState(false);
  const inputCardRef = useRef<HTMLDivElement>(null);

  // P3-26: Voice input — 双引擎闭环
  //   - browser: Web Speech API（浏览器/WebView2 原生，零配置，Tauri WebView2 下可能不可用）
  //   - whisper: MediaRecorder 录音 → OpenAI Whisper 云端转写（多模态 STT 配置）
  // 引擎在 设置 → 语音 → 语音输入引擎 中选择，持久化 codem-voice-settings.speechEngine。
  const [voiceEngine, setVoiceEngine] = useState<SpeechEngine>(() => getVoiceInputEngine());
  const [whisperActive, setWhisperActive] = useState(false); // MediaRecorder 录音中
  const [whisperBusy, setWhisperBusy] = useState(false);     // 云端转写请求进行中
  const [voiceError, setVoiceError] = useState<string | null>(null); // 内联提示（自动消失，另有 toast）
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // 把一段转写文本追加到输入框末尾（并同步草稿持久化）
  const appendTranscript = useCallback((text: string) => {
    if (!text) return;
    setInput(prev => {
      const newVal = prev + text;
      setDraft(newVal);
      return newVal;
    });
  }, []);

  // 释放麦克风流与 recorder 引用
  const stopMediaTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  // 云端 Whisper：Blob 上传转写 → 追加文本 / 报错（区分“未配置”引导）
  const transcribeWhisperBlob = useCallback(async (blob: Blob) => {
    setWhisperBusy(true);
    setVoiceError(null);
    try {
      const text = await transcribeAudioFile(blob);
      appendTranscript(text);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      if (!isSTTConfigured()) {
        const msg = zh
          ? "云端 Whisper 未配置：请在 设置 → 多模态 → STT 语音输入 中启用并配置 OpenAI（whisper-1）后重试。"
          : "Cloud Whisper not configured. Enable an OpenAI provider (whisper-1) in Settings → Multimodal → STT Voice Input and retry.";
        setVoiceError(msg);
        showToast("warning", msg, 7000);
      } else {
        const msg = zh ? `语音转写失败：${raw}` : `Transcription failed: ${raw}`;
        setVoiceError(msg);
        showToast("error", msg, 7000);
      }
    } finally {
      setWhisperBusy(false);
    }
  }, [zh, appendTranscript]);

  // 取消录音：停止并丢弃（引擎切换/异常时用，不触发转写）
  const cancelWhisperCapture = useCallback(() => {
    audioChunksRef.current = [];
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {}
    }
    stopMediaTracks();
    setWhisperActive(false);
    setWhisperBusy(false);
  }, [stopMediaTracks]);

  // 停止录音并转写（MediaRecorder.stop → onstop 中收尾）
  const stopWhisperCapture = useCallback(() => {
    const rec = mediaRecorderRef.current;
    if (!rec || rec.state === "inactive") {
      stopMediaTracks();
      setWhisperActive(false);
      return;
    }
    try {
      rec.stop();
    } catch (e) {
      console.warn("[InputArea] stop recorder:", e);
      stopMediaTracks();
      setWhisperActive(false);
    }
  }, [stopMediaTracks]);

  // 云端 Whisper：点击麦克风开始录音（getUserMedia + MediaRecorder）
  const startWhisperCapture = useCallback(async () => {
    if (whisperBusy || whisperActive) return;
    if (!isSTTConfigured()) {
      const msg = zh
        ? "云端 Whisper 未配置：请在 设置 → 多模态 → STT 语音输入 中启用并配置 OpenAI（whisper-1）。"
        : "Cloud Whisper not configured. Enable and configure OpenAI (whisper-1) in Settings → Multimodal → STT Voice Input.";
      setVoiceError(msg);
      showToast("warning", msg, 7000);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const msg = zh
        ? "当前环境不支持麦克风录音（getUserMedia 不可用）。"
        : "Microphone recording is unavailable here (getUserMedia missing).";
      setVoiceError(msg);
      showToast("error", msg);
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      const msg = zh
        ? "当前环境不支持 MediaRecorder 录音。"
        : "MediaRecorder is not supported in this environment.";
      setVoiceError(msg);
      showToast("error", msg);
      return;
    }
    setVoiceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const msg = zh ? `无法访问麦克风：${detail}` : `Microphone unavailable: ${detail}`;
      setVoiceError(msg);
      showToast("error", msg);
      return;
    }
    let rec: MediaRecorder;
    try {
      const mimeType = pickAudioRecorderMimeType();
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      const msg = zh ? "无法启动录音（MediaRecorder 初始化失败）。" : "Failed to start recording (MediaRecorder init failed).";
      setVoiceError(msg);
      showToast("error", msg);
      return;
    }
    audioChunksRef.current = [];
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const chunks = audioChunksRef.current;
      const blobType = rec.mimeType || "audio/webm";
      audioChunksRef.current = [];
      stopMediaTracks();
      setWhisperActive(false);
      if (chunks.length === 0) {
        const msg = zh ? "未捕获到录音内容，请重试。" : "No audio captured — please try again.";
        setVoiceError(msg);
        showToast("warning", msg);
        return;
      }
      const blob = new Blob(chunks, { type: blobType });
      void transcribeWhisperBlob(blob);
    };
    rec.onerror = () => {
      stopMediaTracks();
      setWhisperActive(false);
      const msg = zh ? "录音出错，请重试。" : "Recording error — please try again.";
      setVoiceError(msg);
      showToast("error", msg);
    };
    mediaRecorderRef.current = rec;
    mediaStreamRef.current = stream;
    try {
      rec.start();
      setWhisperActive(true);
    } catch (e) {
      stopMediaTracks();
      const msg = zh ? "无法开始录音，请重试。" : "Failed to start recording — please retry.";
      setVoiceError(msg);
      showToast("error", msg);
    }
  }, [zh, whisperBusy, whisperActive, stopMediaTracks, transcribeWhisperBlob]);

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
    onFinalResult: (text) => appendTranscript(text),
    onInterimResult: () => {
      // interim 文本通过 voiceInterim 悬浮提示展示，避免光标跳动
    },
    onError: (msg) => {
      const display = msg === "Microphone permission denied"
        ? S.voice.micPermissionDenied[lang]
        : msg;
      setVoiceError(display);
      showToast("error", display);
    },
  });

  // 引擎在设置面板中被修改 → 同步到本地 state
  useEffect(() => {
    const handler = () => setVoiceEngine(getVoiceInputEngine());
    window.addEventListener("codem-voice-settings-changed", handler);
    return () => window.removeEventListener("codem-voice-settings-changed", handler);
  }, []);

  // 引擎切换时终止进行中的捕获会话（丢弃录音，不转写）
  const prevVoiceEngineRef = useRef<SpeechEngine>(voiceEngine);
  useEffect(() => {
    if (prevVoiceEngineRef.current !== voiceEngine) {
      prevVoiceEngineRef.current = voiceEngine;
      if (isListeningVoice) stopVoice();
      cancelWhisperCapture();
    }
  }, [voiceEngine, isListeningVoice, stopVoice, cancelWhisperCapture]);

  // 内联错误提示 8 秒后自动消失（另有 toast 通知）
  useEffect(() => {
    if (!voiceError) return;
    const t = setTimeout(() => setVoiceError(null), 8000);
    return () => clearTimeout(t);
  }, [voiceError]);

  // 卸载时释放麦克风与录音器（丢弃未完成录音）
  useEffect(() => {
    return () => {
      const rec = mediaRecorderRef.current;
      if (rec) {
        try {
          rec.onstop = null;
          if (rec.state !== "inactive") rec.stop();
        } catch {}
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
        mediaStreamRef.current = null;
      }
      mediaRecorderRef.current = null;
    };
  }, []);

  // 处理语音按钮点击（按引擎分流）
  const handleVoiceToggle = useCallback(() => {
    if (disabled) return;
    if (voiceEngine === "whisper") {
      // 云端 Whisper：录音中 → 停止并转写；空闲 → 开始录音
      if (whisperBusy) return; // 转写中，忽略再次点击
      if (whisperActive) {
        stopWhisperCapture();
      } else {
        void startWhisperCapture();
      }
      return;
    }
    // === browser 引擎（Web Speech API） ===
    if (!voiceSupported) {
      const msg = zh
        ? "当前环境不支持浏览器语音识别：请在 设置 → 语音 中把「语音输入引擎」切换为「云端 Whisper（OpenAI）」。"
        : "Browser speech recognition is unavailable here — switch the voice input engine to Cloud Whisper (OpenAI) in Settings → Voice.";
      setVoiceError(msg);
      showToast("warning", msg, 7000);
      return;
    }
    if (isListeningVoice) {
      stopVoice();
      // Flush any interim text
      if (voiceInterim) appendTranscript(voiceInterim);
    } else {
      resetVoice();
      startVoice();
    }
  }, [
    disabled, voiceEngine, whisperBusy, whisperActive, stopWhisperCapture, startWhisperCapture,
    voiceSupported, isListeningVoice, stopVoice, startVoice, resetVoice, voiceInterim,
    appendTranscript, zh,
  ]);

  // Auto-focus textarea after browser voice stops
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

  // Compute +menu position when toggled
  useEffect(() => {
    if (showPlusMenu && plusBtnRef.current) {
      const rect = plusBtnRef.current.getBoundingClientRect();
      setPlusMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    } else {
      setPlusMenuPos(null);
    }
  }, [showPlusMenu]);

  // Compute skill picker position when toggled
  useEffect(() => {
    if (showSkillPicker && skillPickerBtnRef.current) {
      const rect = skillPickerBtnRef.current.getBoundingClientRect();
      setSkillPickerPos({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    } else {
      setSkillPickerPos(null);
    }
  }, [showSkillPicker]);

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

  // === Bottom bar state (执行模式已移至顶部 TitleBar) ===
  const [showMoreActions, setShowMoreActions] = useState(false);
  // P0: IME composition state — prevents Enter from firing during Chinese/Japanese input
  const compositionJustEndedRef = useRef(false);
  // P1: Drag-over state for file drop zone — depth counter prevents flicker on nested elements
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

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
  // 将 /skill-name 模式高亮为 pill 标签。
  // 仅在文本含 /xxx 模式时才启用镜像层（textarea 透明由 backdrop 画文字）——
  // 无 / 模式时 textarea 直接显示文字，caret 与文字同源渲染，
  // 根治"backdrop 与 textarea 排版差 → 光标视觉错位"类问题（如长 URL 粘贴）。
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

  // 文本是否含 /xxx 模式（决定是否启用 backdrop 镜像层）——须在 draft 声明后
  const hasSkillPattern = useMemo(() => {
    const t = draft || input;
    return t ? /(?:^|\s)\/[a-zA-Z0-9_-]+/.test(t) : false;
  }, [draft, input]);

  // === Input history (up-arrow recall, cmd doskey style) ===
  // Global across sessions, persisted to localStorage (project convention).
  const INPUT_HISTORY_KEY = "codem-input-history";
  const INPUT_HISTORY_LIMIT = 100;
  const historyRef = useRef<string[]>([]);
  // -1 = not browsing history (editing a fresh draft)
  const historyIndexRef = useRef(-1);
  const pendingDraftRef = useRef("");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(INPUT_HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          historyRef.current = parsed.filter((s) => typeof s === "string");
        }
      }
    } catch (e) {
      console.warn("[InputArea] load history:", e);
    }
  }, []);

  const pushHistory = (text: string) => {
    const t = text.trim();
    if (!t) return;
    const h = historyRef.current;
    // Skip consecutive duplicates (doskey behaviour)
    if (h[h.length - 1] === t) return;
    h.push(t);
    if (h.length > INPUT_HISTORY_LIMIT) h.splice(0, h.length - INPUT_HISTORY_LIMIT);
    try {
      localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(h));
    } catch (e) {
      console.warn("[InputArea] save history:", e);
    }
  };

  const restoreCaretEnd = () => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      }
    });
  };

  /** 测量给定文本在 textarea 相同布局下的视觉行数（兼容 pre-wrap 软换行） */
  const measureVisualLines = (text: string): number => {
    const ta = textareaRef.current;
    if (!ta) return 1;
    const probe = document.createElement("div");
    const cs = window.getComputedStyle(ta);
    probe.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-wrap:break-word",
      `font-family:${cs.fontFamily}`,
      `font-size:${cs.fontSize}`,
      `font-weight:${cs.fontWeight}`,
      `line-height:${cs.lineHeight}`,
      `width:${ta.clientWidth}px`,
      `padding-left:${cs.paddingLeft}`,
      `padding-right:${cs.paddingRight}`,
      `letter-spacing:${cs.letterSpacing}`,
      `word-spacing:${cs.wordSpacing}`,
    ].join(";");
    probe.textContent = text;
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    document.body.removeChild(probe);
    const lh = parseFloat(cs.lineHeight) || 24;
    return Math.max(1, Math.round(h / lh));
  };

  /** 光标是否位于视觉第一行（wrap 折行也算多行） */
  const isCaretOnFirstVisualLine = (ta: HTMLTextAreaElement, caret: number): boolean => {
    return measureVisualLines(ta.value.slice(0, caret)) <= 1;
  };

  /** 光标是否位于视觉最后一行（wrap 折行也算多行） */
  const isCaretOnLastVisualLine = (ta: HTMLTextAreaElement, caret: number): boolean => {
    return measureVisualLines(ta.value.slice(caret)) <= 1;
  };

  /** Browse input history. Returns true when the key was consumed. */
  const browseHistory = (dir: 1 | -1) => {
    const h = historyRef.current;
    if (h.length === 0) return false;
    const ta = textareaRef.current;
    if (!ta) return false;
    const value = ta.value;
    const caret = ta.selectionStart ?? value.length;
    // Multi-line guard: only recall when the caret is on the boundary line,
    // otherwise let the native caret move handle the gesture.
    // 注意：textarea 是 pre-wrap 软换行，wrap 折行不产生 "\n"，
    // 因此必须按视觉行判断（用镜像测量），否则光标在折行的第二行按 ↑
    // 会直接填充历史而不是先移动光标。
    if (dir === -1) {
      if (!isCaretOnFirstVisualLine(ta, caret)) return false;
    } else {
      if (!isCaretOnLastVisualLine(ta, caret)) return false;
    }
    if (historyIndexRef.current === -1) {
      // Entering history browse: remember the in-progress draft so ArrowDown
      // past the newest entry can restore it. ArrowDown on a fresh draft
      // stays native (caret down) — matching the terminal.
      if (dir !== -1) return false;
      pendingDraftRef.current = value;
      historyIndexRef.current = h.length - 1;
    } else if (dir === -1) {
      // Wrap around to the newest when passing the oldest (doskey cycles).
      historyIndexRef.current = (historyIndexRef.current - 1 + h.length) % h.length;
    } else {
      if (historyIndexRef.current >= h.length - 1) {
        // Past the newest entry: restore the draft we saved on entry.
        historyIndexRef.current = -1;
        setDraft(pendingDraftRef.current);
        setInput(pendingDraftRef.current);
        restoreCaretEnd();
        return true;
      }
      historyIndexRef.current += 1;
    }
    const recalled = h[historyIndexRef.current];
    setDraft(recalled);
    setInput(recalled);
    restoreCaretEnd();
    return true;
  };

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
    ? (lang === "zh" ? "输入消息，回车将自动新建全局对话" : "Type a message - Enter starts a new global chat")
    : disabled ? S.sidebar.disabledHint[lang]
    : isStreaming && onSendGuidance
      ? (lang === "zh" ? "输入消息，回车发送将作为引导消息注入当前任务" : "Type a message - Enter will inject it as guidance into the running task")
    : tipList[tipIndex];

  // Load custom operations
  useEffect(() => {
    setCustomOps(getCustomOperations());
    const handler = () => setCustomOps(getCustomOperations());
    window.addEventListener("codem-settings-changed", handler);
    return () => window.removeEventListener("codem-settings-changed", handler);
  }, []);


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

  // Auto-resize: 让 .input-backdrop-wrapper 跟随 textarea 高度一起增长。
  // textarea 与 backdrop 都是 absolute 定位，不会撑开 wrapper；若不显式同步
  // wrapper 高度，文本超过 wrapper 的 min-height 后会溢出输入框边框，并浮在
  // action row 上方拦截点击（放大按钮失效）。
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    const wrapper = ta?.parentElement; // .input-backdrop-wrapper
    if (!ta || !wrapper) return;
    const maxH = expanded ? 480 : 280;
    const minH = expanded ? 200 : 56;
    // textarea 是 absolute+inset:0，高度被拉伸跟随 wrapper。
    // 测量前必须先重置两者到 minH，否则 scrollHeight >= clientHeight = 旧 wrapper 高度，
    // 删除内容后高度永远卡在旧值无法收缩。
    wrapper.style.height = `${minH}px`;
    ta.style.height = `${minH}px`;
    // A3: 失焦折叠 —— 固定为单行胶囊（仅当内容超过一行时才生效；空/单行本来就保持 minH）
    if (blurFolded) {
      const one = `${minH}px`;
      ta.style.height = one;
      wrapper.style.height = one;
      return;
    }
    const h = Math.max(minH, Math.min(ta.scrollHeight, maxH));
    ta.style.height = `${h}px`;
    wrapper.style.height = `${h}px`;
  }, [expanded, blurFolded]);

  useEffect(() => {
    resizeTextarea();
  }, [input, draft, resizeTextarea]);

  // A3: 失焦折叠 —— 仅当输入框持有焦点且内容超过一行时，在失焦后收成单行
  const handleFocusWithin = useCallback(() => {
    // 容器内任何元素获得焦点 → 展开
    setBlurFolded((prev) => {
      if (prev) resizeTextarea();
      return false;
    });
  }, [resizeTextarea]);

  const handleBlurWithin = useCallback((e: React.FocusEvent) => {
    // 焦点转移到容器内（点击按钮/菜单等）不折叠
    const card = inputCardRef.current;
    if (card && e.relatedTarget && card.contains(e.relatedTarget as Node)) return;
    const ta = textareaRef.current;
    if (!ta) return;
    // 多行内容才折叠：超过单行高度（~56px）或含换行
    const multiline = ta.scrollHeight > 70 || /\n/.test(ta.value || "");
    if (!multiline) { setBlurFolded(false); return; }
    setBlurFolded(true);
  }, []);

  const handleSubmit = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || disabled) return;
    // P3: Prepend generate mode hint for non-text modes
    let message = input.trim();
    if (showMultimodal && generateMode !== "text") {
      const modeHint = generateMode === "image" ? `[Generate image at ${resolution}] ` : `[Generate video at ${resolution}] `;
      message = modeHint + message;
    }
    // Record the user's raw input (without generate-mode hint) for up-arrow recall
    pushHistory(input.trim());
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
    setBlurFolded(false);
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
    // Input history recall (cmd doskey style): ArrowUp shows the previous
    // input, ArrowDown moves forward. Guarded by IME composition.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (e.nativeEvent.isComposing) return;
      if (browseHistory(e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
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

  // 本会话内用户手动删除过的 GitHub URL（避免 reconcile 自动加回）
  const removedGithubUrlsRef = useRef<Set<string>>(new Set());

  const addGithubBadge = useCallback((url: string) => {
    setComposerBadges((prev) => {
      if (prev.some((b) => b.id === `github-${url}`)) return prev;
      const match = url.match(/github\.com\/([^/\s?#]+)/);
      const repoName = match ? match[1] : url;
      return [...prev, { id: `github-${url}`, type: "github" as const, label: repoName, meta: url, removable: true }];
    });
  }, []);

  const removeBadge = useCallback((id: string) => {
    setComposerBadges((prev) => {
      const target = prev.find((b) => b.id === id);
      if (target?.type === "github" && typeof target.meta === "string") {
        removedGithubUrlsRef.current.add(target.meta);
      }
      return prev.filter((b) => b.id !== id);
    });
  }, []);

  // === GitHub URL detection in text（防抖 + 同步式 reconcile） ===
  // 修复：手打 URL 时 onChange 逐字符触发检测，每个"未输完的前缀"都被当作
  // 完整 URL 加 badge（…/c、…/ca … 每个前缀 id 不同 → 标签堆积）。
  // 现在：①输入停顿 500ms 后才检测；②reconcile 同步——旧前缀被更长 URL
  // 取代时移除、删除的 URL 加回；用户手动删除的尊重（removedGithubUrlsRef）。
  const githubBadgeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reconcileGithubBadges = useCallback((text: string) => {
    const urlRegex = /https?:\/\/github\.com\/[^\s<>"']+/gi;
    const matches = text.match(urlRegex) || [];
    // 去尾标点 + 去重
    const targets: string[] = [];
    for (const raw of matches) {
      const cleaned = raw.replace(/[),.;\]]+$/, "");
      if (!targets.includes(cleaned)) targets.push(cleaned);
    }
    setComposerBadges((prev) => {
      // 1) 保留非 github badge；github badge 仅当其 URL 仍精确出现在当前文本中
      const kept = prev.filter((b) => {
        if (b.type !== "github") return true;
        return typeof b.meta === "string" && targets.includes(b.meta);
      });
      // 2) 添加当前文本中缺失的 github badge（跳过用户手动删除过的）
      const out = [...kept];
      for (const t of targets) {
        if (
          !out.some((b) => b.type === "github" && b.meta === t) &&
          !removedGithubUrlsRef.current.has(t)
        ) {
          const m = t.match(/github\.com\/([^/\s?#]+)/);
          out.push({
            id: `github-${t}`,
            type: "github" as const,
            label: m ? m[1] : t,
            meta: t,
            removable: true,
          });
        }
      }
      return out;
    });
  }, []);

  const scheduleGithubBadgeReconcile = useCallback((text: string) => {
    if (githubBadgeDebounceRef.current) clearTimeout(githubBadgeDebounceRef.current);
    githubBadgeDebounceRef.current = setTimeout(() => {
      githubBadgeDebounceRef.current = null;
      reconcileGithubBadges(text);
    }, 500);
  }, [reconcileGithubBadges]);

  // 组件卸载清理防抖
  useEffect(() => {
    return () => {
      if (githubBadgeDebounceRef.current) clearTimeout(githubBadgeDebounceRef.current);
    };
  }, []);

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

  const currentModeInfo = SECURITY_MODES.find(m => m.mode === securityMode)!;

  // 麦克风按钮激活态 & 提示文案（按引擎：browser / whisper）
  const micActive = voiceEngine === "whisper" ? (whisperActive || whisperBusy) : isListeningVoice;
  const voiceTitle = voiceEngine === "whisper"
    ? whisperBusy
      ? (zh ? "正在云端转写…" : "Transcribing in the cloud…")
      : whisperActive
        ? (zh ? "停止录音并转写" : "Stop recording & transcribe")
        : (zh ? "开始语音输入（云端 Whisper 录音）" : "Start voice input (Cloud Whisper recording)")
    : voiceSupported
      ? (isListeningVoice ? S.voice.stopListening[lang] : S.voice.startListening[lang])
      : (zh
        ? "浏览器语音识别在此环境不可用 — 请到 设置 → 语音 把引擎切换为「云端 Whisper」。点击查看提示。"
        : "Browser speech recognition unavailable here — switch to Cloud Whisper in Settings → Voice. Click for details.");

  return (
    <div
      ref={inputCardRef}
      className={`input-area input-card-container ${isDragOver ? "drag-over" : ""} ${blurFolded ? "blur-folded" : ""}`}
      onFocusCapture={handleFocusWithin}
      onBlurCapture={handleBlurWithin}
      onMouseDownCapture={(e) => {
        // A3: 点击折叠态输入卡任意处 → 聚焦 textarea 展开
        if (blurFolded && textareaRef.current && !(e.target as HTMLElement).closest?.("button, a, input, select, textarea, [role='button']")) {
          e.preventDefault();
          textareaRef.current.focus();
        }
      }}
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
                <img src={att.content} alt={att.name} className="pending-attachment-thumb" />
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
              return <div className="attachment-hint">{zh ? "当前模型不支持视觉，图片将以文字标注发送。配置视觉代理请在 设置→多模态→Vision 中开启。" : "Current model doesn't support vision. Images will be sent as text. Configure vision proxy in Settings→Multimodal→Vision."}</div>;
            } else if (!supportsVision && visionConfig?.enabled) {
              return <div className="attachment-hint">{zh ? "将使用视觉代理 (" + visionConfig.model + ") 描述图片内容" : "Will use vision proxy (" + visionConfig.model + ") to describe image"}</div>;
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
            <div
              className="slash-menu-portal"
              style={{
                left: slashMenuPos.left,
                bottom: slashMenuPos.bottom,
                width: slashMenuPos.width,
                zIndex: "var(--z-top)",
              }}
            >
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

          {/* DSH-aligned mirror backdrop: 仅在文本含 /xxx 模式时启用——
              此时 textarea 文字透明（caret 仍可见），backdrop 渲染文字与 pill 高亮；
              无 / 模式时 textarea 直接显示文字（与 caret 同源，避免视觉错位）。 */}
          <div className={`input-backdrop-wrapper ${expanded ? "expanded" : ""}`}>
            {hasSkillPattern && (
              <div className="input-backdrop" aria-hidden="true">
                {renderBackdropContent(draft || input, skillLexicon)}
              </div>
            )}
            <textarea
              ref={textareaRef}
              className={`message-input ${hasSkillPattern ? "mirror-mode" : ""} ${expanded ? "expanded" : ""} ${micActive ? "voice-listening" : ""}`}
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
              scheduleGithubBadgeReconcile(val);
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
            onScroll={(e) => {
              // 超限内部滚动时同步 backdrop，保持 /skill pill 高亮与文字对齐
              const bd = e.currentTarget.parentElement?.querySelector('.input-backdrop');
              if (bd) bd.scrollTop = e.currentTarget.scrollTop;
            }}
            placeholder={dynamicPlaceholder}
            disabled={disabled}
            rows={2}
          />

          {/* P3-26: Voice 状态指示 — browser interim / whisper 录音·转写中 / 错误提示 */}
          {((isListeningVoice && voiceInterim) || whisperActive || whisperBusy || voiceError) && (
            <span
              className={`voice-status ${voiceError ? "voice-status--error" : ""}`}
              title={voiceError || undefined}
            >
              {voiceError
                ? (voiceError.length > 60 ? voiceError.slice(0, 60) + "…" : voiceError)
                : whisperActive
                  ? (zh ? "● 录音中… 点击停止并转写" : "● Recording… click to stop & transcribe")
                  : whisperBusy
                    ? (zh ? "云端转写中…" : "Transcribing in the cloud…")
                    : voiceInterim}
            </span>
          )}
          </div>
        </div>

        {/* Action row — 左侧工具按钮 + 右侧发送按钮 */}
        <div className="input-action-row">
          {/* 左侧工具组 */}
          <div className="input-tools-left">
            {/* + button — 添加文件/技能/多模态 */}
            <div className="input-relative-anchor">
              <button ref={plusBtnRef} className={`mode-toggle-btn mode-toggle-btn--compact ${showPlusMenu ? "is-active" : ""}`} aria-haspopup="menu" aria-expanded={showPlusMenu} onClick={() => setShowPlusMenu(!showPlusMenu)}
                title={zh ? "添加" : "Add"}
              >
                ＋
              </button>
              {showPlusMenu && plusMenuPos && createPortal(
                <>
                  <div className="popover-shield" style={{ zIndex: "var(--z-top)" }} onClick={() => setShowPlusMenu(false)} />
                  <div
                    className="skill-picker-popup popover-shell input-popover"
                    style={{
                      left: plusMenuPos.left, bottom: plusMenuPos.bottom,
                      minWidth: 200, zIndex: "var(--z-top)",
                    }}
                  >
                    <button className="more-action-item"
                      onClick={() => { setShowPlusMenu(false); document.getElementById('file-upload-input')?.click(); }}>
                      <Paperclip size={14} /> <span>{zh ? "上传文件" : "Upload file"}</span>
                    </button>
                    <button className="more-action-item"
                      onClick={() => { setShowPlusMenu(false); setShowSkillPicker(true); }}>
                      <Target size={14} /> <span>{zh ? "选择技能" : "Select skills"}</span>
                    </button>
                    <div className="menu-divider" />
                    {(() => {
                      const mmSettings = getMultimodalSettings();
                      const imageGenConfig = mmSettings.imageGen;
                      const ttsConfig = mmSettings.tts;
                      return (<>
                        <button
                          disabled={!imageGenConfig}
                          className="more-action-item"
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
                          {!imageGenConfig && <span className="input-popover-hint">{zh ? "未配置" : "Not configured"}</span>}
                        </button>
                        <button
                          disabled={!ttsConfig}
                          className="more-action-item"
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
                          {!ttsConfig && <span className="input-popover-hint">{zh ? "未配置" : "Not configured"}</span>}
                        </button>
                      </>);
                    })()}
                  </div>
                </>,
                document.body
              )}
            </div>

            {/* Hidden file upload input — SlotBridge 消费 app.attachment slot */}
            <SlotBridge name="app.attachment" fallback={FileUpload} onUpload={handleUpload} hideButton />

            {/* Skill picker popup */}
            <div ref={skillPickerBtnRef} className="input-relative-anchor">
              {showSkillPicker && skillPickerPos && createPortal(
                <>
                  <div className="popover-shield" style={{ zIndex: "var(--z-top)" }} onClick={() => setShowSkillPicker(false)} />
                  <div
                    className="skill-picker-popup popover-shell input-popover input-popover--skills"
                    style={{
                      left: skillPickerPos.left, bottom: skillPickerPos.bottom,
                      minWidth: 220, zIndex: "var(--z-top)",
                    }}
                  >
                    <div className="input-popover-title">
                      {zh ? "选择技能（本次消息）" : "Select skills (this message)"}
                    </div>
                    {(() => {
                      let disabled: string[] = [];
                      try { disabled = getSettingJSON<string[]>("codem-disabled-skills", []); } catch {}
                      const skills = getSkillRegistry().getAll().filter(s => !disabled.includes(s.name));
                      if (skills.length === 0) {
                        return <div className="input-popover-empty">{zh ? "无可用技能" : "No skills available"}</div>;
                      }
                      return skills.map(s => (
                        <label key={s.name} className="skill-option">
                          <input type="checkbox" checked={selectedSkills.includes(s.name)} onChange={(e) => {
                            if (e.target.checked) setSelectedSkills([...selectedSkills, s.name]);
                            else setSelectedSkills(selectedSkills.filter(n => n !== s.name));
                          }} className="skill-option-check" />
                          <div>
                            <div className="skill-option-name">{s.displayName || s.name}</div>
                            <div className="skill-option-desc">{s.description}</div>
                          </div>
                        </label>
                      ));
                    })()}
                  </div>
                </>,
                document.body
              )}
            </div>

            {/* Collaboration mode — SlotBridge 消费 app.plan-mode-chip */}
            <SlotBridge
              name="app.plan-mode-chip"
              fallback={PlanModeChip}
              mode={collaborationMode}
              onModeChange={(m: CollaborationMode) => onModeChange?.(m)}
              locked={isStreaming}
            />
            {/* 内联回退：当 PlanModeChip 未显示时（非 plan 模式），保留可点击的切换按钮 */}
            {collaborationMode !== 'plan' && (
              <button
                className="mode-toggle-btn"
                onClick={() => onModeChange?.('plan')}
                title={zh ? "执行模式 — 点击切换到计划模式" : "Execute mode — click for plan mode"}
              >
                <Zap size={14} />
              </button>
            )}

            {/* P4: Knowledge source selector (notebook mode) — hidden when hideSourceSelector is true */}
            {notebookId && !hideSourceSelector && (
              <button
                className={`mode-toggle-btn ${showSourceSelector ? "is-active" : ""}`}
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
              >
                <BookMarked size={14} />
              </button>
            )}
            {showSourceSelector && notebookId && !hideSourceSelector && (
              <div className="input-float-anchor" style={{ zIndex: "var(--z-chrome)" }}>
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
              <div className="input-float-anchor input-float-panel" style={{ zIndex: "var(--z-chrome)" }}>
                <GenerateModeSelector mode={generateMode} onModeChange={setGenerateMode} />
                <ResolutionSelector resolution={resolution} onResolutionChange={setResolution} />
                <button
                  onClick={() => { setShowMultimodal(false); setGenerateMode("text"); }}
                  className="input-float-panel-close"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {/* 右侧发送组 */}
          <div className="input-tools-right">
            {/* Voice input — 双引擎：browser (Web Speech API) / whisper (云端 OpenAI) */}
            <button
              className={`mode-toggle-btn mode-toggle-btn--mic ${micActive ? "voice-rec-active" : ""}`}
              onClick={handleVoiceToggle}
              disabled={disabled || (voiceEngine === "whisper" && whisperBusy)}
              title={voiceTitle}
              style={{
                opacity: disabled ? 0.4 : (voiceEngine === "browser" && !voiceSupported ? 0.55 : 1),
              }}
            >
              {micActive ? <SquareIcon size={14} fill="currentColor" /> : <Mic size={14} />}
            </button>

            {/* Expand/collapse */}
            <button
              className="mode-toggle-btn"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? S.sidebar.collapseInput[lang] : S.sidebar.expandInput[lang]}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>

            {/* Send button group: send + up-arrow (wecode-aligned single-button state machine)
                对标 .wecode-ref getChatSendState：同一按钮位按状态切换，不做三段式。
                - 非流式 → Send（正常发送）
                - 流式 + 输入框有内容 → Send（保持与平时一致的发送按钮；ChatPanel 的 onSend
                  内部已分流：流式时走 onSendGuidance，即引导消息进入引导栏）
                - 流式 + 输入框空 → Stop（停止当前回复）
            */}
            <div className="input-send-group">
              {isStreaming && !input.trim() && pendingAttachments.length === 0 ? (
                <button className="send-btn send-btn--split-left cancel-btn" onClick={onCancel} title={S.input.cancel[lang]}><Square size={14} fill="currentColor" /></button>
              ) : (
                <button
                  className={`send-btn send-btn--split-left ${disabled ? "disabled" : ""}`}
                  onClick={handleSubmit}
                  disabled={disabled || (!input.trim() && pendingAttachments.length === 0)}
                  title={isStreaming ? (zh ? "发送引导消息（注入当前任务）" : "Send guidance (inject into current task)") : (zh ? "发送 (Enter)" : "Send (Enter)")}
                ><ArrowRight size={16} /></button>
              )}

              {/* Up-arrow */}
              <button
                onClick={() => setShowMoreActions(!showMoreActions)}
                title={zh ? "快捷短语 / 草稿" : "Quick phrases / Drafts"}
                className={`send-more-btn ${disabled ? "is-disabled" : showMoreActions ? "is-open" : ""}`}
              >
                <ChevronUp size={10} />
              </button>
              {showMoreActions && (
                <>
                  <div className="popover-shield" style={{ zIndex: 99 }} onClick={() => setShowMoreActions(false)} />
                  <div
                    className="skill-picker-popup popover-shell input-popover input-popover--more"
                    style={{ minWidth: 200, zIndex: "var(--z-chrome)" }}
                  >
                    {onToggleQuickPhrase && (
                      <button className="more-action-item" onClick={() => { onToggleQuickPhrase(); setShowMoreActions(false); }}>
                        <ClipboardList size={14} /> <span>{zh ? "快捷短语" : "Quick Phrases"}</span>
                      </button>
                    )}
                    {onToggleDraftPicker && hasDrafts && (
                      <button className="more-action-item" onClick={() => { onToggleDraftPicker(); setShowMoreActions(false); }}>
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

      {/* === Bottom control bar — 仅保留自定义操作（连接状态/输入提示已隐藏） === */}
      {customOps.filter(op => op.command.trim()).length > 0 && (
        <div className="input-control-bar">
          {customOps.filter(op => op.command.trim()).slice(0, 2).map(op => (
            <button
              key={op.id}
              className={`input-control-item ${runningOp === op.id ? "is-busy" : ""}`}
              onClick={() => handleRunOp(op)}
              disabled={runningOp !== null}
              title={`${op.name}: ${op.command}`}
            >
              {runningOp === op.id ? <Clock size={12} /> : <Wrench size={12} />} {op.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
