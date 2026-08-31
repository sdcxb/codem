/**
 * NotebookWorkspace — 笔记本三栏持久工作区
 *
 * 对标 NotebookLM 三栏布局：
 * - 左栏：Sources Panel（来源管理 + 勾选框 + 摘要预览）
 * - 中栏：Chat Area（对话 + 建议问题 + 引用标注）
 * - 右栏：Notes Panel（笔记 CRUD + Markdown 编辑 + Studio 生成）
 *
 * 新增功能 (借鉴开源项目思路, 自研实现):
 * - 知识图谱视图: 借鉴 Understand-Anything 思路, 自研 Canvas 力导向图
 * - PPT 生成: 借鉴 oh-my-ppt 思路, 自研 HTML 幻灯片生成
 *
 * 皮肤系统兼容: 支持 default / hub / dream 三套皮肤
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Plus, Trash2, Search, FileText, Link as LinkIcon, Type,
  Loader2, BookOpen, ChevronLeft,
  ChevronRight, StickyNote, Pin, Edit3, Save, X, Sparkles, Share2, Presentation,
  Download, Route, Map, XCircle, Layers, Eye, Columns, ChevronDown, ChevronUp,
  PanelLeftOpen, PanelLeftClose, PanelRightOpen, PanelRightClose,
} from 'lucide-react';
// 对话系统复用 — 笔记本专用精简聊天面板
import { NbChatPanel } from './NbChatPanel';
import { useAppStore } from '../store';
import * as SessionStorage from '../core/storage/session';
import * as ProjectStorage from '../core/storage/project';
import type { Session } from '../core/types';
import type { CollaborationMode } from '../core/agent/agent';
// C4: Studio 预览渲染所需的 Markdown 组件
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
// Markdown 编辑器 (借鉴 Lumina Note 思路, 自研实现) — 替代旧 textarea
import { NoteEditor } from './NoteEditor';
// 来源查看器 (对标 NotebookLM 引用跳转原文)
import { SourceViewer } from './SourceViewer';
// 闪卡系统 (借鉴 Lumina Note 思路, 自研 SM-2 实现)
import { FlashcardViewer } from './FlashcardViewer';
import {
  getNotebook,
  listSources, addSource, deleteSourceAndCleanup, indexSource, reindexSource,
  generateSummary, generateGuidedQuestions,
  listNotes, createNote, updateNote, deleteNote,
  generateStudioContent,
  exportNotebookAsMarkdown, downloadMarkdown, generateStudyPath,
  getChunks,
  setActiveSourceFilter,
} from '../core/knowledge';
import type { Notebook, NotebookSource, IndexProgress, Note, StudioContentType, NoteContentType } from '../core/knowledge';
// WikiLinks 同步 + 学习路径 (借鉴 Lumina Note + Understand-Anything 思路)
import { syncNoteLinks } from '../core/knowledge';
import type { StudyPathItem } from '../core/knowledge';
import { useLang } from '../core/i18n/lang';
import { useSkin } from '../core/theme';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import PPTAdapter from './ppt/PPTAdapter';

interface NotebookWorkspaceProps {
  notebookId: string;
  notebookName: string;
  onBack: () => void;
    /** Called when user wants to save an AI response as a note */
  onSaveAIResponseAsNote?: (notebookId: string, title: string, content: string) => void;
  /** 
   * 笔记本内嵌对话回调 — 由 App.tsx 提供，复用主对话引擎
   * 当用户在笔记本中间栏发送消息时，通过此回调触发 agentic loop
   */
  onNotebookSend?: (message: string, session: Session, notebookId: string) => void;
  /** 取消正在运行的对话 */
  onNotebookCancel?: (sessionId: string) => void;
  /** 发送引导消息到正在运行的对话 */
  onNotebookSendGuidance?: (message: string, sessionId: string) => void;
  /** 当前模型 */
  notebookModel?: string;
  /** 模型切换回调 */
  onNotebookModelChange?: (model: string) => void;
  /** 引用点击回调 */
  onCitationClick?: (sourceName: string) => void;
  /** 来源点击回调 */
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
  /** 连接状态 */
  notebookConnected?: boolean;
}

export function NotebookWorkspace({
  notebookId,
  notebookName,
  onBack,
    onNotebookSend,
  onNotebookCancel,
  onNotebookSendGuidance,
  notebookModel,
  onNotebookModelChange,
  onCitationClick,
  onSourceClick,
  notebookConnected = true,
}: NotebookWorkspaceProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const { skin } = useSkin();
  // 对话系统状态 — 复用主应用的 store
  const { messages: chatMessages, loadMessages, saveMessages, clearMessages } = useAppStore();

  // View mode: 'sources' | 'chat' | 'notes' | 'graph'
  // Graph 视图借鉴 Understand-Anything 的图谱优先布局思路
  const [viewMode, setViewMode] = useState<'sources' | 'graph'>('sources');
  const isGraphMode = viewMode === 'graph';

  // ===== 笔记本内嵌对话管理 =====
  // 将每个笔记本视为一个虚拟项目，复用主应用的 session/message 机制
  // 虚拟项目 ID 格式: notebook:{notebookId}，避免与真实项目冲突
  const notebookProjectId = `notebook:${notebookId}`;
  const [notebookSessions, setNotebookSessions] = useState<Session[]>([]);
  const [notebookCurrentSession, setNotebookCurrentSession] = useState<Session | null>(null);
  const [collaborationMode] = useState<CollaborationMode>('default');

  // PPT editor state
  const [showPPTEditor, setShowPPTEditor] = useState(false);
  const [pptNoteId, setPptNoteId] = useState<string | null>(null);
  const [pptTitle, setPptTitle] = useState('');
  const [pptAutoGenerate, setPptAutoGenerate] = useState(false);

  // State
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  // Panel collapse state
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // Summary collapse state — 控制笔记本级摘要的显示/隐藏
  const [summaryCollapsed, setSummaryCollapsed] = useState(false);

  // Source selection (checkboxes)
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());

  // Add source dialog
  const [showAddSource, setShowAddSource] = useState(false);
  const [sourceType, setSourceType] = useState<'text' | 'file' | 'url'>('text');
  const [sourceName, setSourceName] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceFilePaths, setSourceFilePaths] = useState<string[]>([]);

  // Note editing
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [showNoteEditor, setShowNoteEditor] = useState(false);

  // Note tag filter
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // Note full-text search
  const [noteSearchQuery, setNoteSearchQuery] = useState('');

  // Studio dropdown
  const [showStudio, setShowStudio] = useState(false);
  const [studioGenerating, setStudioGenerating] = useState(false);
  const studioRef = useRef<HTMLDivElement>(null);

  // C4: Studio 生成内容预览状态 — 生成后先预览再保存
  const [studioPreview, setStudioPreview] = useState<{ title: string; content: string; contentType: StudioContentType } | null>(null);
  const [studioPreviewMode, setStudioPreviewMode] = useState<'preview' | 'edit' | 'split'>('preview');
  const [studioPreviewContent, setStudioPreviewContent] = useState('');
  const [studioPreviewTitle, setStudioPreviewTitle] = useState('');

  // Export menu (对标 NotebookLM 导出功能)
  const [showExport, setShowExport] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // Study path (借鉴 Understand-Anything Guided Tours 思路)
  const [showStudyPath, setShowStudyPath] = useState(false);
  const [studyPath, setStudyPath] = useState<StudyPathItem[]>([]);

  // Flashcards (借鉴 Lumina Note 思路, 自研 SM-2 实现)
  const [showFlashcards, setShowFlashcards] = useState(false);
  // C5: 从特定笔记生成闪卡 — 传递 noteId 给 FlashcardViewer
  const [flashcardNoteId, setFlashcardNoteId] = useState<string | undefined>(undefined);

  // Source viewer (对标 NotebookLM 引用跳转原文)
  const [viewingSource, setViewingSource] = useState<{ sourceId: string; chunkIndex?: number; highlightText?: string } | null>(null);

  // Close studio dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (studioRef.current && !studioRef.current.contains(e.target as Node)) {
        setShowStudio(false);
      }
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setShowExport(false);
      }
    };
    if (showStudio || showExport) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showStudio, showExport]);

  const studioOptions: { type: StudioContentType; icon: string; labelZh: string; labelEn: string }[] = [
    { type: 'summary', icon: '📋', labelZh: '内容摘要', labelEn: 'Summary' },
    { type: 'outline', icon: '📑', labelZh: '内容大纲', labelEn: 'Outline' },
    { type: 'study_guide', icon: '🎓', labelZh: '学习指南', labelEn: 'Study Guide' },
    { type: 'faq', icon: '❓', labelZh: '常见问题', labelEn: 'FAQ' },
    { type: 'timeline', icon: '📅', labelZh: '事件时间线', labelEn: 'Timeline' },
    { type: 'brief', icon: '📝', labelZh: '简要简报', labelEn: 'Brief' },
    { type: 'key_insights', icon: '💡', labelZh: '关键洞察', labelEn: 'Key Insights' },
    { type: 'mindmap', icon: '🧠', labelZh: '思维导图', labelEn: 'Mind Map' },
  ];

  const handleStudioGenerate = async (contentType: StudioContentType) => {
    setShowStudio(false);

    // 模型能力检测
    const { checkFeatureAvailability } = await import('../core/llm/capability-detector');
    const capCheck = checkFeatureAvailability('studio-content');
    if (!capCheck.available) {
      alert(isZh ? capCheck.warnings[0]?.zh : capCheck.warnings[0]?.en);
      return;
    }

    setStudioGenerating(true);
    try {
      const result = await generateStudioContent(notebookId, contentType);
      // C4: 不再直接创建笔记，而是先预览，让用户编辑后再保存
      setStudioPreview({ title: result.title, content: result.content, contentType });
      setStudioPreviewContent(result.content);
      setStudioPreviewTitle(result.title);
      setStudioPreviewMode('preview');
    } catch (e) {
      console.error('Studio generation failed:', e);
      alert(isZh ? `生成失败: ${e instanceof Error ? e.message : '未知错误'}` : `Generation failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStudioGenerating(false);
    }
  };

  // C4: 保存 Studio 预览内容为笔记
  const handleStudioPreviewSave = () => {
    if (!studioPreview) return;
    const note = createNote({
      notebookId,
      title: studioPreviewTitle.trim() || studioPreview.title,
      content: studioPreviewContent,
    });
    setNotes(listNotes(notebookId));
    setStudioPreview(null);
    // 保存后在编辑器中打开，方便进一步编辑
    setEditingNote(note);
    setShowNoteEditor(true);
  };

  // PPT 生成 — AI 从知识库自动生成 PPT
  const handleGeneratePPT = () => {
    setShowStudio(false);
    setShowPPTEditor(true);
    setPptNoteId(null);
    setPptTitle(isZh ? 'PPT 演示' : 'PPT Presentation');
    setPptAutoGenerate(true); // 触发 AI 自动生成
  };

  // 保存 PPT 为笔记
  const handleSavePPT = (title: string, content: string) => {
    if (pptNoteId) {
      updateNote(pptNoteId, { title, content });
    } else {
      const note = createNote({
        notebookId,
        title,
        content,
        contentType: 'ppt' as NoteContentType,
      });
      setPptNoteId(note.id);
    }
    setNotes(listNotes(notebookId));
    setShowPPTEditor(false);
    setPptAutoGenerate(false);
  };

  // 打开已有 PPT 笔记进行编辑
  const handleEditPPTNote = (note: Note) => {
    setPptNoteId(note.id);
    setPptTitle(note.title);
    setPptAutoGenerate(false); // 编辑已有笔记不需要自动生成
    setShowPPTEditor(true);
  };

  // 导出笔记本 (对标 NotebookLM 导出功能)
  const handleExportNotebook = () => {
    setShowExport(false);
    const md = exportNotebookAsMarkdown(notebookId);
    downloadMarkdown(notebookName, md);
  };

  // 学习路径 (借鉴 Understand-Anything Guided Tours 思路, 自研拓扑排序)
  const handleShowStudyPath = () => {
    const path = generateStudyPath(notebookId);
    setStudyPath(path.items);
    setShowStudyPath(true);
  };

  // Load data
  const refreshAll = useCallback(() => {
    const nb = getNotebook(notebookId);
    if (nb) setNotebook(nb);
    setSources(listSources(notebookId));
    setNotes(listNotes(notebookId));
  }, [notebookId]);

  useEffect(() => {
    refreshAll();
    setLoadingQuestions(true);
    generateGuidedQuestions(notebookId).then((qs) => {
      setGuidedQuestions(qs);
      setLoadingQuestions(false);
    }).catch(() => setLoadingQuestions(false));
  }, [refreshAll, notebookId]);

  // ===== 监听外部工具创建笔记的事件（如 generate_ppt 工具） =====
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.notebookId === notebookId) {
        setNotes(listNotes(notebookId));
      }
    };
    window.addEventListener('notebook:note-created', handler);
    return () => window.removeEventListener('notebook:note-created', handler);
  }, [notebookId]);

  // ===== 笔记本内嵌对话：初始化虚拟项目 + 加载历史对话 =====
  useEffect(() => {
    // 为笔记本创建/获取虚拟项目，使复用的对话系统能正确管理 session
    const virtualProjectId = `notebook:${notebookId}`;
    let project = ProjectStorage.getProject(virtualProjectId);
    if (!project) {
      project = {
        id: virtualProjectId,
        name: `📓 ${notebookName}`,
        path: '',  // 笔记本对话不需要工作目录
        description: `Notebook: ${notebookName}`,
        pinned: false,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      try { ProjectStorage.createProject(project); } catch (e) { console.warn('[NotebookWorkspace] Virtual project creation failed:', e); }
    } else {
      ProjectStorage.updateProject(virtualProjectId, { lastAccessedAt: Date.now() });
    }

    // 加载该笔记本的所有对话 session
    const sessions = SessionStorage.listSessions(virtualProjectId);
    setNotebookSessions(sessions);

    // 如果有历史 session，加载最近一个
    if (sessions.length > 0) {
      const latest = sessions[0]; // listSessions 按 last_message_at DESC 排序
      setNotebookCurrentSession(latest);
      loadMessages(latest.id);
    } else {
      // 没有历史对话，创建新 session
      const newSession: Session = {
        id: `nb-ses-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        projectId: virtualProjectId,
        title: isZh ? '对话 1' : 'Chat 1',
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
        messageCount: 0,
        pinned: false,
      };
      try { SessionStorage.createSession(newSession); } catch (e) { console.warn('[NotebookWorkspace] Session creation failed:', e); }
      setNotebookSessions([newSession]);
      setNotebookCurrentSession(newSession);
      clearMessages();
    }

    // 清理：当笔记本关闭时，恢复主应用的 session 状态
    return () => {
      clearMessages();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  // Select all indexed sources by default
  useEffect(() => {
    const indexed = sources.filter(s => s.status === 'indexed');
    if (indexed.length > 0 && selectedSourceIds.size === 0) {
      setSelectedSourceIds(new Set(indexed.map(s => s.id)));
    }
  }, [sources, selectedSourceIds.size]);

  // Handlers
  const handleAddSource = async () => {
    if (!sourceName.trim()) return;

    // For file type with multiple files, add each as a separate source
    if (sourceType === 'file' && sourceFilePaths.length > 0) {
      setShowAddSource(false);
      setIndexing(true);
      for (let i = 0; i < sourceFilePaths.length; i++) {
        const fp = sourceFilePaths[i];
        const fname = fp.split(/[\\/]/).pop() || `file-${i}`;
        // 如果只有一个文件且名称看起来像是时间戳/纯数字，用文件名替换
        let nameToUse = sourceFilePaths.length === 1 ? sourceName.trim() : fname;
        if (/^\d{10,}$/.test(nameToUse)) {
          nameToUse = fname;
        }
        const source = addSource({
          notebookId,
          name: nameToUse,
          type: 'file',
          filePath: fp,
        });
        await indexSource(source, (progress) => setIndexProgress(progress));
      }
      setIndexing(false);
      setIndexProgress(null);
      setSourceName(''); setSourceContent(''); setSourceUrl(''); setSourceFilePaths([]);
      setSources(listSources(notebookId));
      const updated = getNotebook(notebookId);
      if (updated) setNotebook(updated);

      if (sources.length === 0) {
        await generateSummary(notebookId);
        const refreshed = getNotebook(notebookId);
        if (refreshed) setNotebook(refreshed);
      }

      setLoadingQuestions(true);
      generateGuidedQuestions(notebookId).then((qs) => {
        setGuidedQuestions(qs);
        setLoadingQuestions(false);
      }).catch(() => setLoadingQuestions(false));

      // 后台自动提取知识图谱（不阻塞 UI）
      import('../core/knowledge').then(({ extractKnowledgeGraph }) => {
        extractKnowledgeGraph(notebookId).catch((e) => {
          console.warn('[NotebookWorkspace] Auto graph extraction failed:', e);
        });
      });
      return;
    }

    const source = addSource({
      notebookId,
      name: (() => {
        // 如果名称是纯数字时间戳，用文件名/URL/默认值替换
        let n = sourceName.trim();
        if (/^\d{10,}$/.test(n)) {
          if (sourceType === 'file' && sourceFilePaths[0]) {
            n = sourceFilePaths[0].split(/[\\/]/).pop() || n;
          } else if (sourceType === 'url' && sourceUrl) {
            n = sourceUrl.split('/')[2] || sourceUrl;
          } else {
            n = 'Untitled';
          }
        }
        return n;
      })(),
      type: sourceType,
      content: sourceType === 'text' ? sourceContent : undefined,
      url: sourceType === 'url' ? sourceUrl : undefined,
      filePath: sourceType === 'file' ? (sourceFilePaths[0] || undefined) : undefined,
    });

    setSources(listSources(notebookId));
    setShowAddSource(false);
    setSourceName(''); setSourceContent(''); setSourceUrl(''); setSourceFilePaths([]);

    setIndexing(true);
    await indexSource(source, (progress) => setIndexProgress(progress));
    setIndexing(false);
    setIndexProgress(null);

    setSources(listSources(notebookId));
    const updated = getNotebook(notebookId);
    if (updated) setNotebook(updated);

    if (sources.length === 0) {
      await generateSummary(notebookId);
      const refreshed = getNotebook(notebookId);
      if (refreshed) setNotebook(refreshed);
    }

    setLoadingQuestions(true);
    generateGuidedQuestions(notebookId).then((qs) => {
      setGuidedQuestions(qs);
      setLoadingQuestions(false);
    }).catch(() => setLoadingQuestions(false));

    // 后台自动提取知识图谱（不阻塞 UI）
    import('../core/knowledge').then(({ extractKnowledgeGraph }) => {
      extractKnowledgeGraph(notebookId).catch((e) => {
        console.warn('[NotebookWorkspace] Auto graph extraction failed:', e);
      });
    });
  };

  const handleDeleteSource = async (sourceId: string) => {
    await deleteSourceAndCleanup(sourceId, notebookId);
    setSources(listSources(notebookId));
    const updated = getNotebook(notebookId);
    if (updated) setNotebook(updated);
    setSelectedSourceIds(prev => {
      const next = new Set(prev);
      next.delete(sourceId);
      return next;
    });
  };

  // B10: 重新索引来源
  const handleReindexSource = async (sourceId: string) => {
    const source = sources.find(s => s.id === sourceId);
    if (!source) return;
    setIndexing(true);
    try {
      await reindexSource(sourceId, (progress) => setIndexProgress(progress));
      setSources(listSources(notebookId));
      const updated = getNotebook(notebookId);
      if (updated) setNotebook(updated);
    } catch (e) {
      console.error('Reindex failed:', e);
      alert(isZh ? `重新索引失败: ${e instanceof Error ? e.message : '未知错误'}` : `Reindex failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setIndexing(false);
      setIndexProgress(null);
    }
  };

  const handleToggleSource = (sourceId: string) => {
    setSelectedSourceIds(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };

  const handleFileSelect = async () => {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        filters: [{ name: 'Text & Code', extensions: ['txt', 'md', 'json', 'yaml', 'xml', 'csv', 'ts', 'js', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'sh', 'sql', 'html', 'css', 'log', 'pdf', 'docx'] }],
      });
      if (selected) {
        // multiple: true → selected is string[] (or null)
        const paths: string[] = Array.isArray(selected)
          ? selected
          : [typeof selected === 'string' ? selected : (selected as any).path];
        setSourceFilePaths(paths);
        // Auto-fill name from first file if empty
        if (paths.length > 0 && !sourceName) {
          setSourceName(paths[0].split(/[\\/]/).pop() || 'file');
        }
      }
    } catch (e) {
      console.error('File select error:', e);
    }
  };

  // Note handlers
  const handleCreateNote = () => {
const note = createNote({ notebookId, title: isZh ? '新笔记' : 'New Note' });
setNotes(listNotes(notebookId));
setEditingNote(note);
setShowNoteEditor(true);
};

  const handleSaveNote = (title: string, content: string, tags?: string[]) => {
    if (!editingNote) return;
    updateNote(editingNote.id, { title, content, tags });
    // 同步 WikiLinks 双向链接 — 借鉴 Lumina Note 思路, 自研实现
    syncNoteLinks(editingNote.id, notebookId, content);
    setNotes(listNotes(notebookId));
    setShowNoteEditor(false);
    setEditingNote(null);
  };

  // 置顶/取消置顶笔记
  const handleTogglePin = (noteId: string) => {
    const note = notes.find(n => n.id === noteId);
    if (!note) return;
    const newPinOrder = note.pinOrder > 0 ? 0 : 1;
    updateNote(noteId, { pinOrder: newPinOrder });
    setNotes(listNotes(notebookId));
  };

  // 导航到其他笔记 (点击 WikiLink 时)
  const handleNavigateToNote = (noteId: string) => {
    const targetNote = notes.find(n => n.id === noteId);
    if (targetNote) {
      setEditingNote(targetNote);
    }
  };

  const handleDeleteNote = (noteId: string) => {
    deleteNote(noteId);
    setNotes(listNotes(notebookId));
    if (editingNote?.id === noteId) {
      setShowNoteEditor(false);
      setEditingNote(null);
    }
  };

  const handleEditNote = (note: Note) => {
    setEditingNote(note);
    setShowNoteEditor(true);
  };

  const handleSaveAINote = (title: string, content: string) => {
    createNote({ notebookId, title, content, sourceId: undefined });
    setNotes(listNotes(notebookId));
  };

  // ===== 笔记本内嵌对话 handlers =====

  // 发送消息 — 复用 App.tsx 的 agentic loop
  const handleNotebookSend = useCallback(async (message: string, _attachments?: any[], _selectedSkills?: string[]) => {
    const session = notebookCurrentSession;
    if (!session || !onNotebookSend) return;

    // 对标 NotebookLM: 发送消息前设置来源过滤器
    // 勾选的来源 ID 传给底层 RAG 检索引擎，限制检索范围
    // 空集 = 全部已索引来源参与检索（NotebookLM 默认行为）
    const indexedSourceIds = Array.from(selectedSourceIds);
    setActiveSourceFilter(indexedSourceIds.length > 0 ? indexedSourceIds : null);

    // 添加用户消息到 UI
    useAppStore.getState().addMessage({
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      status: 'done',
    });
    saveMessages(session.id);

    // 更新 session 消息计数
    const updatedCount = session.messageCount + 1;
    SessionStorage.updateSession(session.id, { messageCount: updatedCount, lastMessageAt: Date.now() });
    const updatedSession = { ...session, messageCount: updatedCount, lastMessageAt: Date.now() };
    setNotebookCurrentSession(updatedSession);

    // 调用 App.tsx 提供的 agentic loop
    onNotebookSend(message, updatedSession, notebookId);
  }, [notebookCurrentSession, onNotebookSend, saveMessages, notebookId, selectedSourceIds]);

  // 取消对话
  const handleNotebookCancel = useCallback(() => {
    if (notebookCurrentSession && onNotebookCancel) {
      onNotebookCancel(notebookCurrentSession.id);
    }
  }, [notebookCurrentSession, onNotebookCancel]);

  // 发送引导消息
  const handleNotebookSendGuidance = useCallback((message: string) => {
    if (notebookCurrentSession && onNotebookSendGuidance) {
      onNotebookSendGuidance(message, notebookCurrentSession.id);
    }
  }, [notebookCurrentSession, onNotebookSendGuidance]);

  // 切换 session
  const handleNotebookSwitchSession = useCallback((sessionId: string) => {
    const session = notebookSessions.find(s => s.id === sessionId);
    if (!session) return;
    setNotebookCurrentSession(session);
    loadMessages(session.id);
  }, [notebookSessions, loadMessages]);

  // 创建新 session
  const handleNotebookNewSession = useCallback(() => {
    const sessionNumber = notebookSessions.length + 1;
    const newSession: Session = {
      id: `nb-ses-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      projectId: notebookProjectId,
      title: isZh ? `对话 ${sessionNumber}` : `Chat ${sessionNumber}`,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      pinned: false,
    };
    try { SessionStorage.createSession(newSession); } catch (e) { console.warn('[NotebookWorkspace] New session creation failed:', e); }
    setNotebookSessions(prev => [newSession, ...prev]);
    setNotebookCurrentSession(newSession);
    clearMessages();
  }, [notebookSessions.length, notebookProjectId, isZh, clearMessages]);

  return (
    <div className="nb-workspace">
      {/* Header */}
      <div className="nb-workspace-header">
        <button className="nb-back-btn" onClick={onBack}>
          <ArrowLeft className="w-3 h-3" />
          <span>{isZh ? '笔记本列表' : 'Notebooks'}</span>
        </button>
        <h2 className="nb-workspace-title">
          <BookOpen className="w-3 h-3" />
          {notebookName}
        </h2>
        <div className="nb-workspace-actions">
          {/* 导出按钮 (对标 NotebookLM 导出功能) */}
          <div className="nb-studio-wrapper" ref={exportRef}>
            <button
              className="nb-studio-btn"
              onClick={() => setShowExport(!showExport)}
              disabled={sources.length === 0}
            >
              <Download className="w-3 h-3" />
              <span>{isZh ? '导出' : 'Export'}</span>
            </button>
            {showExport && (
              <div className="nb-export-menu">
                <button className="nb-studio-option" onClick={handleExportNotebook}>
                  <span className="nb-studio-icon">📄</span>
                  <span>{isZh ? '导出为 Markdown' : 'Export as Markdown'}</span>
                </button>
              </div>
            )}
          </div>
          {/* 学习路径 (借鉴 Understand-Anything Guided Tours) */}
          <button
            className="nb-studio-btn"
            onClick={handleShowStudyPath}
            disabled={sources.filter(s => s.status === 'indexed').length === 0}
            title={isZh ? '学习路径' : 'Study Path'}
          >
            <Route className="w-3 h-3" />
            <span>{isZh ? '学习路径' : 'Study Path'}</span>
          </button>
          {/* 闪卡 (借鉴 Lumina Note 思路) */}
          <button
            className="nb-studio-btn"
            onClick={() => setShowFlashcards(true)}
            title={isZh ? '闪卡' : 'Flashcards'}
          >
            <Layers className="w-3 h-3" />
            <span>{isZh ? '闪卡' : 'Flashcards'}</span>
          </button>
          <div className="nb-studio-wrapper" ref={studioRef}>
            <button
              className="nb-studio-btn"
              onClick={() => setShowStudio(!showStudio)}
              disabled={studioGenerating || sources.filter(s => s.status === 'indexed').length === 0}
            >
              {studioGenerating ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              <span>Studio</span>
            </button>
            {showStudio && (
              <div className="nb-studio-dropdown">
                <div className="nb-studio-dropdown-header">
                  {isZh ? '生成内容' : 'Generate Content'}
                </div>
                {studioOptions.map((opt) => (
                  <button
                    key={opt.type}
                    className="nb-studio-option"
                    onClick={() => handleStudioGenerate(opt.type)}
                  >
                    <span className="nb-studio-icon">{opt.icon}</span>
                    <span>{isZh ? opt.labelZh : opt.labelEn}</span>
                  </button>
                ))}
                {/* PPT 生成入口 — 借鉴 oh-my-ppt 思路, 自研实现 */}
                <div className="nb-studio-divider" />
                <button
                  className="nb-studio-option nb-studio-ppt"
                  onClick={handleGeneratePPT}
                >
                  <span className="nb-studio-icon">📊</span>
                  <span>{isZh ? 'PPT 演示' : 'PPT Presentation'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* PPT Editor (全屏覆盖) — 自研可视化编辑器 */}
      {showPPTEditor && (
        <PPTAdapter
          notebookId={notebookId}
          initialContent={pptNoteId ? notes.find(n => n.id === pptNoteId)?.content : undefined}
          title={pptTitle}
          autoGenerate={pptAutoGenerate}
          sourceIds={Array.from(selectedSourceIds)}
          onSave={handleSavePPT}
          onBack={() => { setShowPPTEditor(false); setPptAutoGenerate(false); }}
        />
      )}

{/* Graph View — 借鉴 Understand-Anything 思路, 自研 Canvas 力导向图 */}
{isGraphMode && !showPPTEditor ? (
<KnowledgeGraphView
notebookId={notebookId}
              onNodeSelect={(node) => {
                // 跳转到节点关联的来源原文，并高亮节点标签
                if (node.sourceIds && node.sourceIds.length > 0) {
                  setViewingSource({ sourceId: node.sourceIds[0], highlightText: node.label });
                } else if (node.chunkIds && node.chunkIds.length > 0) {
                  // 如果有 chunk ID，尝试找到对应的 source
                  const chunks = getChunks(notebookId);
                  const chunk = chunks.find(c => c.id === node.chunkIds[0]);
                  if (chunk) {
                    setViewingSource({ sourceId: chunk.sourceId, chunkIndex: chunk.chunkIndex, highlightText: node.label });
                  }
                }
              }}
/>
) : !isGraphMode && !showPPTEditor ? (
        <div className="nb-workspace-body">
        {/* Left: Sources Panel */}
        <div className={`nb-sources-panel ${leftCollapsed ? 'collapsed' : ''}`}>
          {!leftCollapsed && (
            <>
              <div className="nb-panel-header">
                <button
                  className="nb-collapse-btn"
                  onClick={() => setLeftCollapsed(!leftCollapsed)}
                  title={leftCollapsed ? (isZh ? '展开' : 'Expand') : (isZh ? '折叠' : 'Collapse')}
                >
                  <PanelLeftClose size={16} />
                </button>
                <div className="nb-panel-tabs" style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                  <button
                    className={`nb-view-tab ${viewMode === 'sources' ? 'active' : ''}`}
                    onClick={() => setViewMode('sources')}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    {isZh ? '来源' : 'Sources'}
                    <span className="nb-count-badge">{sources.length}</span>
                  </button>
                  <button
                    className={`nb-view-tab ${isGraphMode ? 'active' : ''}`}
                    onClick={() => setViewMode('graph')}
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    {isZh ? '图谱' : 'Graph'}
                  </button>
                </div>
                <button
                  className="nb-add-btn"
                  onClick={() => setShowAddSource(true)}
                  disabled={indexing}
                  title={isZh ? '添加来源' : 'Add Source'}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="nb-source-list">
                {sources.length === 0 && !indexing && (
                  <div className="nb-empty-mini">
                    <FileText className="w-6 h-6 opacity-40" />
                    <p>{isZh ? '添加文件/文本/URL' : 'Add files, text, or URLs'}</p>
                  </div>
                )}
                {sources.map((src) => (
                  <SourceCard
                    key={src.id}
                    source={src}
                    selected={selectedSourceIds.has(src.id)}
                    onToggle={() => handleToggleSource(src.id)}
                    onDelete={() => handleDeleteSource(src.id)}
                    onViewSource={() => setViewingSource({ sourceId: src.id })}
                    onReindex={() => handleReindexSource(src.id)}
                  />
                ))}
              </div>

              {indexing && indexProgress && (
                <div className="nb-indexing-progress">
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                  <span>
                    {isZh ? '索引中' : 'Indexing'}: {indexProgress.sourceName}
                    {indexProgress.totalChunks ? ` (${indexProgress.currentChunk}/${indexProgress.totalChunks})` : ''}
                  </span>
                </div>
              )}

              {/* Summary — 可折叠 */}
              {notebook?.summary && notebook.summaryStatus === 'completed' && (
                <div className="nb-summary-section">
                  <button
                    className="nb-summary-toggle"
                    onClick={() => setSummaryCollapsed(!summaryCollapsed)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '4px',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      padding: 0, width: '100%',
                    }}
                  >
                    <BookOpen className="w-3 h-3" />
                    <span className="nb-section-label" style={{ margin: 0 }}>
                      {isZh ? '摘要' : 'Summary'}
                    </span>
                    {summaryCollapsed
                      ? <ChevronRight className="w-3 h-3" style={{ marginLeft: 'auto' }} />
                      : <ChevronDown className="w-3 h-3" style={{ marginLeft: 'auto' }} />}
                  </button>
                  {!summaryCollapsed && (
                    <p className="nb-summary-text" style={{ marginTop: '6px' }}>{notebook.summary}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Center: Chat Area — 笔记本专用精简对话面板 */}
        <div className="nb-chat-panel">
          {notebookCurrentSession ? (
            <NbChatPanel
              onSend={handleNotebookSend}
              onCancel={handleNotebookCancel}
              onSendGuidance={handleNotebookSendGuidance}
              sessionId={notebookCurrentSession.id}
              connected={notebookConnected}
              model={notebookModel || ''}
              onModelChange={onNotebookModelChange || (() => {})}
              mode="api"
              collaborationMode={collaborationMode}
              onModeChange={() => {}}
              currentSessionId={notebookCurrentSession.id}
              onCitationClick={onCitationClick}
              onSourceClick={onSourceClick}
              notebookId={notebookId}
              guidedQuestions={guidedQuestions}
              loadingQuestions={loadingQuestions}
              hasSources={sources.length > 0}
            />
          ) : sources.length === 0 && !indexing ? (
            <div className="nb-chat-empty">
              <BookOpen className="w-12 h-12 opacity-30" />
              <p className="nb-empty-title">{isZh ? '开始使用笔记本' : 'Get Started'}</p>
              <p className="nb-empty-desc">
                {isZh ? '在左侧添加来源，即可开始知识问答' : 'Add sources on the left to start asking questions'}
              </p>
            </div>
          ) : null}
        </div>

        {/* Right: Notes Panel */}
        <div className={`nb-notes-panel ${rightCollapsed ? 'collapsed' : ''}`}>
          {!rightCollapsed && (
            <>
              <div className="nb-panel-header">
                <button
                  className="nb-collapse-btn"
                  onClick={() => setRightCollapsed(!rightCollapsed)}
                  title={rightCollapsed ? (isZh ? '展开' : 'Expand') : (isZh ? '折叠' : 'Collapse')}
                >
                  <PanelRightClose size={16} />
                </button>
                <h3 className="nb-panel-title">
                  <StickyNote className="w-3 h-3" />
                  {isZh ? '笔记' : 'Notes'}
                  <span className="nb-count-badge">{notes.length}</span>
                </h3>
                <button
                  className="nb-add-btn"
                  onClick={handleCreateNote}
                  title={isZh ? '新建笔记' : 'New Note'}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Note search */}
              {notes.length > 0 && (
                <div style={{ padding: '4px 12px 6px' }}>
                  <input
                    type="text"
                    value={noteSearchQuery}
                    onChange={(e) => setNoteSearchQuery(e.target.value)}
                    placeholder={isZh ? '搜索笔记...' : 'Search notes...'}
                    style={{
                      width: '100%',
                      padding: '4px 8px',
                      fontSize: 'var(--fs-sm)',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '6px',
                      color: 'var(--text-primary)',
                      outline: 'none',
                    }}
                  />
                </div>
              )}

              <div className="nb-note-list">
                {notes.length === 0 && (
                  <div className="nb-empty-mini">
                    <StickyNote className="w-6 h-6 opacity-40" />
                    <p>{isZh ? '点击 + 创建笔记' : 'Click + to create a note'}</p>
                  </div>
                )}
                {/* Tag filter bar */}
                {Array.from(new Set(notes.flatMap(n => n.tags || []))).length > 0 && (
                  <div style={{
                    display: 'flex',
                    gap: '4px',
                    flexWrap: 'wrap',
                    padding: '4px 0 8px',
                  }}>
                    <button
                      style={{
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: 'var(--fs-xs)',
                        border: '1px solid var(--border-primary)',
                        background: !tagFilter ? 'var(--accent)' : 'transparent',
                        color: !tagFilter ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                        cursor: 'pointer',
                      }}
                      onClick={() => setTagFilter(null)}
                    >
                      {isZh ? '全部' : 'All'}
                    </button>
                    {Array.from(new Set(notes.flatMap(n => n.tags || []))).map(tag => (
                      <button
                        key={tag}
                        style={{
                          padding: '2px 8px',
                          borderRadius: '10px',
                          fontSize: 'var(--fs-xs)',
                          border: '1px solid var(--border-primary)',
                          background: tagFilter === tag ? 'var(--accent)' : 'transparent',
                          color: tagFilter === tag ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                          cursor: 'pointer',
                        }}
                        onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
                {(() => {
  let filteredNotes = notes;
  if (tagFilter) {
    filteredNotes = filteredNotes.filter(n => (n.tags || []).includes(tagFilter));
  }
  if (noteSearchQuery.trim()) {
    const q = noteSearchQuery.toLowerCase();
    filteredNotes = filteredNotes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      (n.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }
  return filteredNotes;
})().map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onEdit={() => handleEditNote(note)}
                    onDelete={() => handleDeleteNote(note.id)}
                    onEditPPT={() => handleEditPPTNote(note)}
                    onTogglePin={() => handleTogglePin(note.id)}
                    onGenerateFlashcards={() => { setFlashcardNoteId(note.id); setShowFlashcards(true); }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
        </div>
      ) : null}

      {/* Add Source Dialog */}
      {showAddSource && (
        <AddSourceDialog
          isZh={isZh}
          sourceType={sourceType}
          setSourceType={setSourceType}
          sourceName={sourceName}
          setSourceName={setSourceName}
          sourceContent={sourceContent}
          setSourceContent={setSourceContent}
          sourceUrl={sourceUrl}
          setSourceUrl={setSourceUrl}
          sourceFilePaths={sourceFilePaths}
          onFileSelect={handleFileSelect}
          onConfirm={handleAddSource}
          onCancel={() => setShowAddSource(false)}
        />
      )}

      {/* Note Editor — Markdown 编辑器 + WikiLinks + Backlinks (借鉴 Lumina Note 思路) */}
      {showNoteEditor && editingNote && (
        <NoteEditor
          note={editingNote}
          notebookId={notebookId}
          onSave={handleSaveNote}
          onCancel={() => { setShowNoteEditor(false); setEditingNote(null); }}
          onNavigateToNote={handleNavigateToNote}
        />
      )}

      {/* 来源查看器 (对标 NotebookLM 引用跳转原文) */}
      {viewingSource && (
        <SourceViewer
          sourceId={viewingSource.sourceId}
          notebookId={notebookId}
          highlightChunkIndex={viewingSource.chunkIndex}
          highlightText={viewingSource.highlightText}
          onClose={() => setViewingSource(null)}
        />
      )}

      {/* 学习路径弹窗 (借鉴 Understand-Anything Guided Tours 思路, 自研拓扑排序) */}
      {showStudyPath && (
        <div className="nb-dialog-overlay" onClick={() => setShowStudyPath(false)}>
          <div className="nb-dialog" style={{ width: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div className="nb-dialog-header">
              <h3 className="nb-dialog-title">
                <Route className="w-4 h-4" />
                {isZh ? '引导式学习路径' : 'Guided Study Path'}
              </h3>
              <button className="nb-dialog-close" onClick={() => setShowStudyPath(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="nb-study-path">
              {studyPath.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                  <Map className="w-8 h-8" style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                  <p>{isZh ? '请先生成知识图谱后再使用学习路径' : 'Please generate a knowledge graph first'}</p>
                </div>
              ) : (
                <>
                  <div className="nb-study-path-header">
                    <h4 className="nb-study-path-title">
                      {isZh ? '按依赖顺序学习' : 'Learn in dependency order'}
                    </h4>
                    <p className="nb-study-path-desc">
                      {isZh
                        ? `共 ${studyPath.length} 个知识点，按拓扑排序排列`
                        : `${studyPath.length} concepts, sorted by topological order`}
                    </p>
                  </div>
                  <div className="nb-study-path-list">
                    {studyPath.map((item, idx) => (
                      <div key={item.node.id}>
                        <div
                          className="nb-study-path-item"
                          style={{ cursor: 'pointer', transition: 'background 0.15s ease' }}
                          onClick={() => {
                            // B12: 点击学习路径步骤 → 跳转到对应笔记或图谱节点
                            const matchingNote = notes.find(n =>
                              n.title.toLowerCase().includes(item.node.label.toLowerCase()) ||
                              item.node.label.toLowerCase().includes(n.title.toLowerCase())
                            );
                            if (matchingNote) {
                              setEditingNote(matchingNote);
                              setShowNoteEditor(true);
                            } else {
                              // No matching note → switch to graph view and select the node
                              setViewMode('graph');
                              setShowStudyPath(false);
                            }
                          }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; }}
                        >
                          <div className="nb-study-path-num">{item.order}</div>
                          <div className="nb-study-path-content">
                            <p className="nb-study-path-item-title">{item.node.label}</p>
                            {item.node.description && (
                              <p className="nb-study-path-item-desc">{item.node.description}</p>
                            )}
                            <p className="nb-study-path-item-desc" style={{ opacity: 0.7 }}>
                              {item.reason}
                            </p>
                          </div>
                        </div>
                        {idx < studyPath.length - 1 && <div className="nb-study-path-connector" />}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 闪卡查看器 (借鉴 Lumina Note 思路, 自研 SM-2 实现) */}
      {showFlashcards && (
        <FlashcardViewer
          notebookId={notebookId}
          noteId={flashcardNoteId}
          onClose={() => { setShowFlashcards(false); setFlashcardNoteId(undefined); }}
        />
      )}

      {/* C4: Studio 生成内容预览对话框 — 生成后预览/编辑再保存 */}
      {studioPreview && (
        <div className="nb-dialog-overlay" onClick={() => setStudioPreview(null)}>
          <div
            className="nb-dialog"
            style={{ width: '900px', maxWidth: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nb-dialog-header">
              <h3 className="nb-dialog-title">
                <Sparkles className="w-4 h-4" />
                <input
                  type="text"
                  value={studioPreviewTitle}
                  onChange={(e) => setStudioPreviewTitle(e.target.value)}
                  style={{
                    background: 'transparent', border: 'none', outline: 'none',
                    color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit',
                    flex: 1, minWidth: '200px',
                  }}
                />
              </h3>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                {/* 模式切换: 预览 / 编辑 / 分屏 */}
                <button
                  className={`nb-mode-btn ${studioPreviewMode === 'preview' ? 'active' : ''}`}
                  onClick={() => setStudioPreviewMode('preview')}
                  title={isZh ? '预览模式' : 'Preview'}
                  style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>
                <button
                  className={`nb-mode-btn ${studioPreviewMode === 'edit' ? 'active' : ''}`}
                  onClick={() => setStudioPreviewMode('edit')}
                  title={isZh ? '编辑模式' : 'Edit'}
                  style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>
                <button
                  className={`nb-mode-btn ${studioPreviewMode === 'split' ? 'active' : ''}`}
                  onClick={() => setStudioPreviewMode('split')}
                  title={isZh ? '分屏模式' : 'Split'}
                  style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
                >
                  <Columns className="w-3.5 h-3.5" />
                </button>
                <button className="nb-dialog-close" onClick={() => setStudioPreview(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 内容区域 */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: studioPreviewMode === 'split' ? 'row' : 'column' }}>
              {/* 编辑区 */}
              {studioPreviewMode !== 'preview' && (
                <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', borderRight: studioPreviewMode === 'split' ? '1px solid var(--border-primary)' : 'none' }}>
                  <textarea
                    value={studioPreviewContent}
                    onChange={(e) => setStudioPreviewContent(e.target.value)}
                    style={{
                      width: '100%', height: '100%', minHeight: '400px',
                      padding: '8px', fontSize: 'var(--fs-base)', lineHeight: '1.6',
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-primary)',
                      borderRadius: '6px', color: 'var(--text-primary)',
                      outline: 'none', resize: 'none', fontFamily: 'var(--font-mono, monospace)',
                    }}
                    placeholder={isZh ? '编辑内容...' : 'Edit content...'}
                  />
                </div>
              )}
              {/* 预览区 */}
              {studioPreviewMode !== 'edit' && (
                <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
                  <div className="nb-md-preview">
                    {studioPreviewContent.trim() ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                          code: ({ className, children }: any) => {
                            const match = /language-(\w+)/.exec(className || '');
                            const codeStr = String(children).replace(/\n$/, '');
                            if (match && match[1] === 'mermaid') {
                              return (
                                <div style={{ padding: '8px', background: 'var(--bg-tertiary)', borderRadius: '6px', margin: '8px 0' }}>
                                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                                    {codeStr}
                                  </pre>
                                  <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                                    {isZh ? '保存为笔记后可查看渲染的 Mermaid 图表' : 'Save as note to view rendered Mermaid diagram'}
                                  </p>
                                </div>
                              );
                            }
                            return <code className={className}>{children}</code>;
                          },
                        }}
                      >
                        {studioPreviewContent}
                      </ReactMarkdown>
                    ) : (
                      <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '40px' }}>
                        {isZh ? '内容为空' : 'Content is empty'}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 底部操作栏 */}
            <div className="nb-dialog-footer" style={{ padding: '12px 20px', borderTop: '1px solid var(--border-primary)' }}>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginRight: 'auto' }}>
                {isZh ? '预览满意后点击保存，或切换到编辑模式修改内容' : 'Preview, then save. Switch to edit mode to modify.'}
              </span>
              <button className="nb-btn-cancel" onClick={() => setStudioPreview(null)}>
                {isZh ? '丢弃' : 'Discard'}
              </button>
              <button className="nb-btn-confirm" onClick={handleStudioPreviewSave}>
                <Save className="w-3.5 h-3.5" />
                {isZh ? '保存为笔记' : 'Save as Note'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ========== Source Card Component ==========

function SourceCard({
  source, selected, onToggle, onDelete, onViewSource, onReindex,
}: {
  source: NotebookSource;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onViewSource?: () => void;
  onReindex?: () => void;
}) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const [expanded, setExpanded] = useState(false);
  const [summaryCollapsed, setSummaryCollapsed] = useState(true);

  const icon = source.type === 'file' ? <FileText className="w-3 h-3" /> :
    source.type === 'url' ? <LinkIcon className="w-3 h-3" /> :
    <Type className="w-3 h-3" />;

  const previewText = source.content
    ? source.content.slice(0, 120).replace(/\n/g, ' ')
    : source.filePath
      ? source.filePath
      : source.url
        ? source.url
        : '';

  const typeLabel = source.type === 'file' ? (isZh ? '文件' : 'File') :
    source.type === 'url' ? 'URL' :
    isZh ? '文本' : 'Text';

  const statusColor = source.status === 'indexed' ? 'var(--success, #22c55e)' :
    source.status === 'processing' ? 'var(--warning, #eab308)' :
    source.status === 'failed' ? 'var(--destructive, #ef4444)' :
    'var(--text-muted)';

  return (
    <div className={`nb-source-card ${selected ? 'selected' : ''} ${source.status === 'indexed' ? '' : 'disabled'}`}>
      {/* 收起态：单行 — 图标 + checkbox + 名称 + 状态点 + hover操作 */}
      <div className="nb-source-row" onClick={() => setExpanded(!expanded)}>
        <label className="nb-source-checkbox" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={source.status !== 'indexed'}
          />
          <span className="nb-checkmark"></span>
        </label>
        <span className="nb-source-icon">{icon}</span>
        <span className="nb-source-name">{source.name}</span>
        <span className="nb-source-status-dot" style={{ background: statusColor }} title={source.status} />
        <button className="nb-source-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <Trash2 className="w-2.5 h-2.5" />
        </button>
      </div>

      {/* 展开态：详情 */}
      {expanded && (
        <div className="nb-source-detail">
          {/* Meta 行 */}
          <div className="nb-source-meta">
            <span className="nb-source-type-tag">{typeLabel}</span>
            {source.chunkCount > 0 && <span className="nb-source-chunks">{source.chunkCount} {isZh ? '块' : 'chk'}</span>}
            {source.size != null && source.size > 0 && (
              <span className="nb-source-size">{(source.size / 1024).toFixed(1)}KB</span>
            )}
            <span className="nb-source-status-text" style={{ color: statusColor }}>{source.status}</span>
          </div>

          {/* 预览文本 */}
          {previewText && (
            <p className="nb-source-preview">{previewText}{source.content && source.content.length > 120 && '...'}</p>
          )}

          {/* AI 摘要 */}
          {source.summary && (
            <div className="nb-source-summary">
              <button
                className="nb-source-summary-toggle"
                onClick={(e) => { e.stopPropagation(); setSummaryCollapsed(!summaryCollapsed); }}
              >
                <Sparkles className="w-2.5 h-2.5" />
                <span className="nb-source-summary-label">{isZh ? 'AI 摘要' : 'AI Summary'}</span>
                {summaryCollapsed
                  ? <ChevronRight className="w-2.5 h-2.5" style={{ marginLeft: 'auto' }} />
                  : <ChevronDown className="w-2.5 h-2.5" style={{ marginLeft: 'auto' }} />}
              </button>
              {!summaryCollapsed && (
                <>
                  <p className="nb-source-summary-text">{source.summary}</p>
                  {source.keyTopics && source.keyTopics.length > 0 && (
                    <div className="nb-source-topics">
                      {source.keyTopics.map((topic, i) => (
                        <span key={i} className="nb-source-topic-tag">{topic}</span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* 错误信息 */}
          {source.errorMessage && (
            <div className="nb-source-error">{source.errorMessage}</div>
          )}

          {/* 操作栏 */}
          {((source.status === 'indexed' && onViewSource) || onReindex) && (
            <div className="nb-source-actions">
              {source.status === 'indexed' && onViewSource && (
                <button
                  className="nb-source-action-btn"
                  onClick={(e) => { e.stopPropagation(); onViewSource(); }}
                  title={isZh ? '查看原文' : 'View Source'}
                >
                  <FileText className="w-2.5 h-2.5" />
                  {isZh ? '原文' : 'View'}
                </button>
              )}
              {onReindex && (
                <button
                  className="nb-source-action-btn"
                  onClick={(e) => { e.stopPropagation(); onReindex(); }}
                  title={isZh ? '重新索引' : 'Re-index'}
                >
                  <Loader2 className="w-2.5 h-2.5" />
                  {isZh ? '重索引' : 'Reindex'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ========== Note Card Component ==========

function NoteCard({
  note, onEdit, onDelete, onEditPPT, onTogglePin, onGenerateFlashcards,
}: {
  note: Note;
  onEdit: () => void;
  onDelete: () => void;
  onEditPPT?: () => void;
  onTogglePin?: () => void;
  onGenerateFlashcards?: () => void;
}) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const isPPT = note.contentType === 'ppt';
  const isPinned = note.pinOrder > 0;
  const preview = isPPT
    ? (isZh ? 'PPT 演示文稿' : 'PPT Presentation')
    : note.content.replace(/[#*`\[\]]/g, '').slice(0, 80);

  return (
    <div
      className="nb-note-card"
      onClick={isPPT && onEditPPT ? onEditPPT : onEdit}
      style={isPinned ? { borderLeft: '2px solid var(--accent)' } : undefined}
    >
      <div className="nb-note-card-header">
        {isPPT ? (
          <Presentation className="w-2.5 h-2.5 text-primary" />
        ) : (
          <StickyNote className="w-2.5 h-2.5 text-primary" />
        )}
        <span className="nb-note-title">{note.title}</span>
        {isPinned && <Pin className="w-2.5 h-2.5" style={{ color: 'var(--accent)' }} />}
        <button
          className="nb-note-delete"
          onClick={(e) => { e.stopPropagation(); onTogglePin?.(); }}
          title={isPinned ? (isZh ? '取消置顶' : 'Unpin') : (isZh ? '置顶' : 'Pin')}
          style={{ opacity: isPinned ? 1 : 0.4 }}
        >
          <Pin className="w-2.5 h-2.5" />
        </button>
        <button className="nb-note-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          <Trash2 className="w-2.5 h-2.5" />
        </button>
      </div>
      {preview && <p className="nb-note-preview">{preview}</p>}
      {note.tags && note.tags.length > 0 && (
        <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap', marginTop: '2px' }}>
          {note.tags.map(tag => (
            <span
              key={tag}
              style={{
                padding: '0 4px',
                background: 'var(--bg-tertiary)',
                borderRadius: '6px',
                fontSize: '8px',
                color: 'var(--text-muted)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="nb-note-meta">
        <span>{new Date(note.updatedAt).toLocaleDateString(isZh ? 'zh-CN' : 'en-US')}</span>
        {isPPT && <span className="nb-note-source-tag">PPT</span>}
        {note.sourceId && !isPPT && <span className="nb-note-source-tag">AI</span>}
        {/* C5: 从笔记生成闪卡按钮 */}
        {!isPPT && onGenerateFlashcards && (
          <button
            onClick={(e) => { e.stopPropagation(); onGenerateFlashcards(); }}
            title={isZh ? '从笔记生成闪卡' : 'Generate Flashcards from Note'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '2px',
              padding: '0 4px', background: 'transparent', border: 'none',
              color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-xs)',
            }}
          >
            <Layers className="w-2.5 h-2.5" />
            {isZh ? '闪卡' : 'Cards'}
          </button>
        )}
      </div>
    </div>
  );
}

// ========== Add Source Dialog ==========

function AddSourceDialog({
  isZh, sourceType, setSourceType, sourceName, setSourceName,
  sourceContent, setSourceContent, sourceUrl, setSourceUrl,
  sourceFilePaths, onFileSelect, onConfirm, onCancel,
}: any) {
  return (
    <div className="nb-dialog-overlay" onClick={onCancel}>
      <div className="nb-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="nb-dialog-title">{isZh ? '添加来源' : 'Add Source'}</h3>
        <div className="nb-source-type-tabs">
          <button className={`nb-type-tab ${sourceType === 'text' ? 'active' : ''}`} onClick={() => setSourceType('text')}>
            <Type className="w-4 h-4" />{isZh ? '文本' : 'Text'}
          </button>
          <button className={`nb-type-tab ${sourceType === 'file' ? 'active' : ''}`} onClick={() => setSourceType('file')}>
            <FileText className="w-4 h-4" />{isZh ? '文件' : 'File'}
          </button>
          <button className={`nb-type-tab ${sourceType === 'url' ? 'active' : ''}`} onClick={() => setSourceType('url')}>
            <LinkIcon className="w-4 h-4" />URL
          </button>
        </div>
        <input
          className="nb-dialog-input"
          placeholder={isZh ? '来源名称' : 'Source name'}
          value={sourceName}
          onChange={(e) => setSourceName(e.target.value)}
        />
        {sourceType === 'text' && (
          <textarea
            className="nb-dialog-textarea"
            placeholder={isZh ? '粘贴文本内容...' : 'Paste text content...'}
            value={sourceContent}
            onChange={(e) => setSourceContent(e.target.value)}
            rows={6}
          />
        )}
        {sourceType === 'file' && (
          <div className="nb-file-select">
            <button className="nb-file-btn" onClick={onFileSelect}>
              <FileText className="w-4 h-4" />{isZh ? '选择文件' : 'Choose File'}
            </button>
            {sourceFilePaths.length > 0 && (
          <div className="nb-file-path-list">
            {sourceFilePaths.length === 1
              ? <span className="nb-file-path">{sourceFilePaths[0]}</span>
              : <>
                <span className="nb-file-count">{sourceFilePaths.length} 个文件已选</span>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {sourceFilePaths.map((p, i) => {
                    const name = p.split(/[\\/]/).pop() || p;
                    return <div key={i}>• {name}</div>;
                  })}
                </div>
              </>
            }
          </div>
        )}
          </div>
        )}
        {sourceType === 'url' && (
          <input
            className="nb-dialog-input"
            placeholder="https://example.com/article"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
          />
        )}
        <div className="nb-dialog-footer">
          <button className="nb-btn-cancel" onClick={onCancel}>{isZh ? '取消' : 'Cancel'}</button>
          <button className="nb-btn-confirm" onClick={onConfirm} disabled={!sourceName.trim()}>
            {isZh ? '添加并索引' : 'Add & Index'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ========== Note Editor Dialog (removed — replaced by NoteEditor component) ==========
