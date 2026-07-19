/**
 * 笔记本管理组件
 *
 * 对标 NotebookLM：
 * - 笔记本列表（创建/删除/搜索）
 * - 点击进入笔记本详情（来源管理 + 对话）
 */

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Trash2, Search, ArrowLeft, FileText, Link as LinkIcon, Type, Loader2, AlertCircle, CheckCircle, MessageSquare } from 'lucide-react';
import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  getNotebook,
  listSources,
  addSource,
  deleteSourceAndCleanup,
  indexSource,
  generateSummary,
  generateGuidedQuestions,
} from '../core/knowledge';
import type { Notebook, NotebookSource, IndexProgress } from '../core/knowledge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { useAppStore } from '../store';
import { useLang, S } from '../core/i18n/lang';

interface NotebookManagerProps {
  onClose: () => void;
  onOpenNotebookChat: (notebookId: string, notebookName: string) => void;
}

export function NotebookManager({ onClose, onOpenNotebookChat }: NotebookManagerProps) {
  const lang = useLang();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Notebook | null>(null);
  const [selectedNotebook, setSelectedNotebook] = useState<Notebook | null>(null);
  const [sources, setSources] = useState<NotebookSource[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [showAddSource, setShowAddSource] = useState(false);
  const [sourceType, setSourceType] = useState<'text' | 'file' | 'url'>('text');
  const [sourceName, setSourceName] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceFilePath, setSourceFilePath] = useState('');
  const [guidedQuestions, setGuidedQuestions] = useState<string[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  const refreshNotebooks = useCallback(() => {
    setNotebooks(listNotebooks());
  }, []);

  useEffect(() => {
    refreshNotebooks();
  }, [refreshNotebooks]);

  // Load sources when a notebook is selected
  useEffect(() => {
    if (selectedNotebook) {
      setSources(listSources(selectedNotebook.id));
      // Load guided questions
      setLoadingQuestions(true);
      generateGuidedQuestions(selectedNotebook.id).then((qs) => {
        setGuidedQuestions(qs);
        setLoadingQuestions(false);
      }).catch(() => setLoadingQuestions(false));
    } else {
      setSources([]);
      setGuidedQuestions([]);
    }
  }, [selectedNotebook]);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createNotebook({ name: newName.trim(), description: newDesc.trim() || undefined });
    setNewName('');
    setNewDesc('');
    setShowCreate(false);
    refreshNotebooks();
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteNotebook(deleteTarget.id);
    setDeleteTarget(null);
    refreshNotebooks();
  };

  const handleAddSource = async () => {
    if (!selectedNotebook || !sourceName.trim()) return;

    const source = addSource({
      notebookId: selectedNotebook.id,
      name: sourceName.trim(),
      type: sourceType,
      content: sourceType === 'text' ? sourceContent : undefined,
      url: sourceType === 'url' ? sourceUrl : undefined,
      filePath: sourceType === 'file' ? sourceFilePath : undefined,
    });

    setSources(listSources(selectedNotebook.id));
    setShowAddSource(false);
    setSourceName('');
    setSourceContent('');
    setSourceUrl('');
    setSourceFilePath('');

    // Auto-index the new source
    setIndexing(true);
    await indexSource(source, (progress) => {
      setIndexProgress(progress);
    });
    setIndexing(false);
    setIndexProgress(null);

    // Refresh sources and notebook info
    setSources(listSources(selectedNotebook.id));
    const updated = getNotebook(selectedNotebook.id);
    if (updated) setSelectedNotebook(updated);
    refreshNotebooks();

    // Generate summary if this was the first source
    if (sources.length === 0) {
      await generateSummary(selectedNotebook.id);
      const refreshed = getNotebook(selectedNotebook.id);
      if (refreshed) setSelectedNotebook(refreshed);
    }

    // Refresh guided questions
    setLoadingQuestions(true);
    generateGuidedQuestions(selectedNotebook.id).then((qs) => {
      setGuidedQuestions(qs);
      setLoadingQuestions(false);
    }).catch(() => setLoadingQuestions(false));
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (!selectedNotebook) return;
    await deleteSourceAndCleanup(sourceId, selectedNotebook.id);
    setSources(listSources(selectedNotebook.id));
    const updated = getNotebook(selectedNotebook.id);
    if (updated) setSelectedNotebook(updated);
    refreshNotebooks();
  };

  const handleFileSelect = async () => {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) return;
    try {
      const { invoke } = (window as any).__TAURI__.core;
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Text & Code', extensions: ['txt', 'md', 'json', 'yaml', 'xml', 'csv', 'ts', 'js', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'sh', 'sql', 'html', 'css', 'log', 'pdf'] }],
      });
      if (selected) {
        const filePath = typeof selected === 'string' ? selected : (selected as any).path;
        setSourceFilePath(filePath);
        // Auto-fill name from filename
        const filename = filePath.split(/[\\/]/).pop() || 'file';
        if (!sourceName) setSourceName(filename);
      }
    } catch (e) {
      console.error('File select error:', e);
    }
  };

  const filteredNotebooks = notebooks.filter((nb) =>
    nb.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (nb.description || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ========== Notebook Detail View ==========
  if (selectedNotebook) {
    return (
      <div className="notebook-detail-view">
        <div className="notebook-detail-header">
          <button className="notebook-back-btn" onClick={() => setSelectedNotebook(null)}>
            <ArrowLeft className="w-4 h-4" />
            <span>{lang === 'zh' ? '返回列表' : 'Back'}</span>
          </button>
          <h2 className="notebook-title">{selectedNotebook.name}</h2>
          <button
            className="notebook-chat-btn"
            onClick={() => onOpenNotebookChat(selectedNotebook.id, selectedNotebook.name)}
          >
            <MessageSquare className="w-4 h-4" />
            <span>{lang === 'zh' ? '开始对话' : 'Chat'}</span>
          </button>
        </div>

        {selectedNotebook.description && (
          <p className="notebook-description">{selectedNotebook.description}</p>
        )}

        {/* Summary */}
        {selectedNotebook.summary && selectedNotebook.summaryStatus === 'completed' && (
          <div className="notebook-summary-section">
            <h3 className="notebook-section-title">
              <BookOpen className="w-4 h-4" />
              {lang === 'zh' ? '笔记本摘要' : 'Summary'}
            </h3>
            <p className="notebook-summary-text">{selectedNotebook.summary}</p>
          </div>
        )}
        {selectedNotebook.summaryStatus === 'generating' && (
          <div className="notebook-summary-section">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{lang === 'zh' ? '正在生成摘要...' : 'Generating summary...'}</span>
          </div>
        )}

        {/* Sources */}
        <div className="notebook-sources-section">
          <div className="notebook-section-header">
            <h3 className="notebook-section-title">
              <FileText className="w-4 h-4" />
              {lang === 'zh' ? '来源' : 'Sources'}
              <Badge variant="muted">{sources.length}</Badge>
            </h3>
            <button
              className="notebook-add-source-btn"
              onClick={() => setShowAddSource(true)}
              disabled={indexing}
            >
              <Plus className="w-4 h-4" />
              {lang === 'zh' ? '添加来源' : 'Add Source'}
            </button>
          </div>

          {sources.length === 0 && !indexing && (
            <div className="notebook-empty-state">
              <FileText className="w-8 h-8 text-muted-foreground" />
              <p>{lang === 'zh' ? '暂无来源，添加文件/文本/URL 开始知识化' : 'No sources yet. Add files, text, or URLs to get started.'}</p>
            </div>
          )}

          <div className="notebook-source-list">
            {sources.map((src) => (
              <SourceItem
                key={src.id}
                source={src}
                onDelete={() => handleDeleteSource(src.id)}
              />
            ))}
          </div>

          {/* Indexing progress */}
          {indexing && indexProgress && (
            <div className="notebook-indexing-progress">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>
                {lang === 'zh' ? '正在索引' : 'Indexing'}: {indexProgress.sourceName}
                {indexProgress.totalChunks ? ` (${indexProgress.currentChunk}/${indexProgress.totalChunks})` : ''}
              </span>
              {indexProgress.totalChunks && (
                <Progress value={((indexProgress.currentChunk || 0) / indexProgress.totalChunks) * 100} />
              )}
            </div>
          )}
        </div>

        {/* Guided Questions */}
        {guidedQuestions.length > 0 && (
          <div className="notebook-guided-questions">
            <h3 className="notebook-section-title">
              <MessageSquare className="w-4 h-4" />
              {lang === 'zh' ? '建议问题' : 'Suggested Questions'}
            </h3>
            <div className="notebook-question-list">
              {guidedQuestions.map((q, i) => (
                <button
                  key={i}
                  className="notebook-question-item"
                  onClick={() => onOpenNotebookChat(selectedNotebook.id, selectedNotebook.name)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {loadingQuestions && sources.length > 0 && (
          <div className="notebook-guided-questions">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{lang === 'zh' ? '正在生成建议问题...' : 'Generating questions...'}</span>
          </div>
        )}

        {/* Stats */}
        <div className="notebook-stats">
          <Badge variant="muted">
            {selectedNotebook.sourceCount} {lang === 'zh' ? '来源' : 'sources'}
          </Badge>
          <Badge variant="muted">
            {selectedNotebook.chunkCount} {lang === 'zh' ? '文本块' : 'chunks'}
          </Badge>
        </div>

        {/* Add Source Dialog */}
        {showAddSource && (
          <Dialog open={showAddSource} onOpenChange={setShowAddSource}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{lang === 'zh' ? '添加来源' : 'Add Source'}</DialogTitle>
              </DialogHeader>
              <div className="notebook-add-source-form">
                <div className="notebook-source-type-tabs">
                  <button
                    className={`source-type-tab ${sourceType === 'text' ? 'active' : ''}`}
                    onClick={() => setSourceType('text')}
                  >
                    <Type className="w-4 h-4" />
                    {lang === 'zh' ? '文本' : 'Text'}
                  </button>
                  <button
                    className={`source-type-tab ${sourceType === 'file' ? 'active' : ''}`}
                    onClick={() => setSourceType('file')}
                  >
                    <FileText className="w-4 h-4" />
                    {lang === 'zh' ? '文件' : 'File'}
                  </button>
                  <button
                    className={`source-type-tab ${sourceType === 'url' ? 'active' : ''}`}
                    onClick={() => setSourceType('url')}
                  >
                    <LinkIcon className="w-4 h-4" />
                    URL
                  </button>
                </div>

                <input
                  className="notebook-input"
                  placeholder={lang === 'zh' ? '来源名称' : 'Source name'}
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                />

                {sourceType === 'text' && (
                  <textarea
                    className="notebook-textarea"
                    placeholder={lang === 'zh' ? '粘贴文本内容...' : 'Paste text content...'}
                    value={sourceContent}
                    onChange={(e) => setSourceContent(e.target.value)}
                    rows={6}
                  />
                )}

                {sourceType === 'file' && (
                  <div className="notebook-file-select">
                    <button className="notebook-file-btn" onClick={handleFileSelect}>
                      <FileText className="w-4 h-4" />
                      {lang === 'zh' ? '选择文件' : 'Choose File'}
                    </button>
                    {sourceFilePath && (
                      <span className="notebook-file-path">{sourceFilePath}</span>
                    )}
                  </div>
                )}

                {sourceType === 'url' && (
                  <input
                    className="notebook-input"
                    placeholder="https://example.com/article"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                  />
                )}
              </div>
              <DialogFooter>
                <button className="notebook-btn-cancel" onClick={() => setShowAddSource(false)}>
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </button>
                <button className="notebook-btn-confirm" onClick={handleAddSource} disabled={!sourceName.trim()}>
                  {lang === 'zh' ? '添加并索引' : 'Add & Index'}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    );
  }

  // ========== Notebook List View ==========
  return (
    <div className="notebook-manager">
      <div className="notebook-manager-header">
        <div className="notebook-manager-title-row">
          <h2 className="notebook-manager-title">
            <BookOpen className="w-5 h-5" />
            {lang === 'zh' ? '知识笔记本' : 'Knowledge Notebooks'}
          </h2>
          <button className="notebook-close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="notebook-manager-toolbar">
          <div className="notebook-search-box">
            <Search className="w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={lang === 'zh' ? '搜索笔记本...' : 'Search notebooks...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <button className="notebook-create-btn" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" />
            {lang === 'zh' ? '新建笔记本' : 'New Notebook'}
          </button>
        </div>
      </div>

      {filteredNotebooks.length === 0 ? (
        <div className="notebook-empty-state">
          <BookOpen className="w-12 h-12 text-muted-foreground" />
          <p className="text-lg font-medium">
            {searchQuery
              ? (lang === 'zh' ? '未找到匹配的笔记本' : 'No matching notebooks found')
              : (lang === 'zh' ? '暂无笔记本' : 'No notebooks yet')}
          </p>
          <p className="text-sm text-muted-foreground">
            {lang === 'zh' ? '创建一个笔记本，上传文件进行知识化处理' : 'Create a notebook and upload files to get started'}
          </p>
          {!searchQuery && (
            <button className="notebook-create-btn" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" />
              {lang === 'zh' ? '新建笔记本' : 'New Notebook'}
            </button>
          )}
        </div>
      ) : (
        <div className="notebook-grid">
          {filteredNotebooks.map((nb) => (
            <div
              key={nb.id}
              className="notebook-card"
              onClick={() => setSelectedNotebook(nb)}
            >
              <div className="notebook-card-header">
                <BookOpen className="w-5 h-5 text-primary" />
                <h3 className="notebook-card-title">{nb.name}</h3>
                <button
                  className="notebook-card-delete"
                  onClick={(e) => { e.stopPropagation(); setDeleteTarget(nb); }}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {nb.description && (
                <p className="notebook-card-desc">{nb.description}</p>
              )}
              {nb.summary && nb.summaryStatus === 'completed' && (
                <p className="notebook-card-summary">{nb.summary.slice(0, 120)}...</p>
              )}
              <div className="notebook-card-stats">
                <Badge variant="muted">
                  <FileText className="w-3 h-3" />
                  {nb.sourceCount}
                </Badge>
                <Badge variant="muted">
                  {nb.chunkCount} {lang === 'zh' ? '块' : 'chunks'}
                </Badge>
                {nb.summaryStatus === 'completed' && (
                  <Badge variant="success">
                    <CheckCircle className="w-3 h-3" />
                    {lang === 'zh' ? '已索引' : 'Indexed'}
                  </Badge>
                )}
                {nb.summaryStatus === 'generating' && (
                  <Badge variant="warning">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {lang === 'zh' ? '处理中' : 'Processing'}
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lang === 'zh' ? '新建笔记本' : 'New Notebook'}</DialogTitle>
          </DialogHeader>
          <div className="notebook-create-form">
            <input
              className="notebook-input"
              placeholder={lang === 'zh' ? '笔记本名称' : 'Notebook name'}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <textarea
              className="notebook-textarea"
              placeholder={lang === 'zh' ? '描述（可选）' : 'Description (optional)'}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <button className="notebook-btn-cancel" onClick={() => setShowCreate(false)}>
              {lang === 'zh' ? '取消' : 'Cancel'}
            </button>
            <button className="notebook-btn-confirm" onClick={handleCreate} disabled={!newName.trim()}>
              {lang === 'zh' ? '创建' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{lang === 'zh' ? '删除笔记本' : 'Delete Notebook'}</AlertDialogTitle>
            <AlertDialogDescription>
              {lang === 'zh'
                ? `确定要删除笔记本「${deleteTarget?.name}」吗？所有来源和索引数据将被永久删除。`
                : `Are you sure you want to delete "${deleteTarget?.name}"? All sources and indexed data will be permanently removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{lang === 'zh' ? '取消' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="destructive">
              {lang === 'zh' ? '删除' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ========== Source Item Component ==========

function SourceItem({ source, onDelete }: { source: NotebookSource; onDelete: () => void }) {
  const lang = useLang();

  const icon = source.type === 'file' ? <FileText className="w-4 h-4" /> :
    source.type === 'url' ? <LinkIcon className="w-4 h-4" /> :
    <Type className="w-4 h-4" />;

  return (
    <div className="notebook-source-item">
      <div className="notebook-source-icon">{icon}</div>
      <div className="notebook-source-info">
        <span className="notebook-source-name">{source.name}</span>
        <div className="notebook-source-meta">
          <Badge variant={source.status === 'indexed' ? 'success' : source.status === 'failed' ? 'danger' : 'muted'}>
            {source.status === 'indexed' ? <CheckCircle className="w-3 h-3" /> :
             source.status === 'failed' ? <AlertCircle className="w-3 h-3" /> :
             <Loader2 className="w-3 h-3 animate-spin" />}
            {source.status}
          </Badge>
          {source.chunkCount > 0 && (
            <span className="notebook-source-chunks">{source.chunkCount} chunks</span>
          )}
          {source.errorMessage && (
            <span className="notebook-source-error" title={source.errorMessage}>⚠</span>
          )}
        </div>
      </div>
      <button className="notebook-source-delete" onClick={onDelete}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
