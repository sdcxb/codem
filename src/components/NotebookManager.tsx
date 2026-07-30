/**
 * 笔记本管理组件
 *
 * 对标 NotebookLM：
 * - 笔记本列表（创建/删除/搜索）
 * - 点击进入笔记本详情（来源管理 + 对话）
 */

import { useState, useEffect, useCallback } from 'react';
import { BookOpen, Plus, Trash2, Search, ArrowLeft, FileText, Link as LinkIcon, Type, Loader2, AlertCircle, CheckCircle, MessageSquare, LayoutGrid, Edit2, Folder, FolderPlus, Upload, ChevronDown, ChevronRight } from 'lucide-react';
import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  getNotebook,
  updateNotebook,
  listSources,
  addSource,
  deleteSourceAndCleanup,
  indexSource,
  generateSummary,
  generateGuidedQuestions,
  createGroup,
  listGroups,
  updateGroup,
  deleteGroup,
  importNotebookFromFile,
} from '../core/knowledge';
import type { Notebook, NotebookSource, IndexProgress, NotebookGroup } from '../core/knowledge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { useAppStore } from '../store';
import { useLang, S } from '../core/i18n/lang';

interface NotebookManagerProps {
  onClose: () => void;
  onOpenNotebookChat: (notebookId: string, notebookName: string) => void;
  onOpenWorkspace?: (notebookId: string, notebookName: string) => void;
}

export function NotebookManager({ onClose, onOpenNotebookChat, onOpenWorkspace }: NotebookManagerProps) {
  const lang = useLang();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [groups, setGroups] = useState<NotebookGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [importing, setImporting] = useState(false);
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
  // B13: Edit notebook description
  const [editingDesc, setEditingDesc] = useState(false);
  const [descInput, setDescInput] = useState('');

  const refreshNotebooks = useCallback(() => {
    setNotebooks(listNotebooks());
    setGroups(listGroups());
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

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return;
    createGroup({ name: newGroupName.trim() });
    setNewGroupName('');
    setShowCreateGroup(false);
    refreshNotebooks();
  };

  const handleDeleteGroup = (groupId: string) => {
    deleteGroup(groupId);
    refreshNotebooks();
  };

  const handleMoveNotebook = (notebookId: string, groupId: string | null) => {
    updateNotebook(notebookId, { groupId: groupId ?? undefined });
    refreshNotebooks();
  };

  const handleImport = async () => {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!selected) return;
      const filePath = typeof selected === 'string' ? selected : (selected as any).path;
      setImporting(true);
      const result = await importNotebookFromFile(filePath);
      refreshNotebooks();
      alert(lang === 'zh'
        ? `导入完成: ${result.sourcesCreated} 个来源, ${result.notesCreated} 个笔记${result.errors.length ? ', ' + result.errors.length + ' 个错误' : ''}`
        : `Import complete: ${result.sourcesCreated} sources, ${result.notesCreated} notes${result.errors.length ? ', ' + result.errors.length + ' errors' : ''}`
      );
    } catch (e) {
      console.error('Import failed:', e);
      alert(lang === 'zh' ? `导入失败: ${e instanceof Error ? e.message : '未知错误'}` : `Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setImporting(false);
    }
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
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
        filters: [{ name: 'Text & Code', extensions: ['txt', 'md', 'json', 'yaml', 'xml', 'csv', 'ts', 'js', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'sh', 'sql', 'html', 'css', 'log', 'pdf', 'docx'] }],
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

  // B13: Save notebook description
  const handleSaveDesc = () => {
    if (!selectedNotebook) return;
    updateNotebook(selectedNotebook.id, { description: descInput.trim() });
    const updated = getNotebook(selectedNotebook.id);
    if (updated) setSelectedNotebook(updated);
    refreshNotebooks();
    setEditingDesc(false);
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
          {onOpenWorkspace && (
            <button
              className="notebook-chat-btn"
              onClick={() => onOpenWorkspace(selectedNotebook.id, selectedNotebook.name)}
              style={{ marginRight: '6px' }}
            >
              <LayoutGrid className="w-4 h-4" />
              <span>{lang === 'zh' ? '工作区' : 'Workspace'}</span>
            </button>
          )}
          <button
            className="notebook-chat-btn"
            onClick={() => onOpenNotebookChat(selectedNotebook.id, selectedNotebook.name)}
          >
            <MessageSquare className="w-4 h-4" />
            <span>{lang === 'zh' ? '开始对话' : 'Chat'}</span>
          </button>
        </div>

        {selectedNotebook.description && !editingDesc && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <p className="notebook-description" style={{ flex: 1 }}>{selectedNotebook.description}</p>
            <button
              onClick={() => { setDescInput(selectedNotebook.description || ''); setEditingDesc(true); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px', flexShrink: 0 }}
              title={lang === 'zh' ? '编辑描述' : 'Edit description'}
            >
              <Edit2 className="w-3 h-3" />
            </button>
          </div>
        )}
        {(!selectedNotebook.description || editingDesc) && (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
            <input
              className="notebook-input"
              placeholder={lang === 'zh' ? '添加描述...' : 'Add description...'}
              value={descInput}
              onChange={(e) => setDescInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveDesc(); if (e.key === 'Escape') setEditingDesc(false); }}
              autoFocus={editingDesc}
              style={{ flex: 1 }}
            />
            {editingDesc && (
              <>
                <button className="notebook-btn-confirm" onClick={handleSaveDesc} style={{ padding: '4px 12px', fontSize: '12px' }}>
                  {lang === 'zh' ? '保存' : 'Save'}
                </button>
                <button className="notebook-btn-cancel" onClick={() => setEditingDesc(false)} style={{ padding: '4px 12px', fontSize: '12px' }}>
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </button>
              </>
            )}
          </div>
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
          <button className="notebook-create-btn" onClick={() => setShowCreateGroup(true)} title={lang === 'zh' ? '新建分组' : 'New Group'}>
            <FolderPlus className="w-4 h-4" />
            {lang === 'zh' ? '分组' : 'Group'}
          </button>
          <button className="notebook-create-btn" onClick={handleImport} disabled={importing} title={lang === 'zh' ? '导入 Markdown' : 'Import Markdown'}>
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {lang === 'zh' ? '导入' : 'Import'}
          </button>
          <button className="notebook-create-btn" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4" />
            {lang === 'zh' ? '新建笔记本' : 'New Notebook'}
          </button>
        </div>
      </div>

      {filteredNotebooks.length === 0 && groups.length === 0 ? (
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
        <div className="notebook-list-container">
          {/* Grouped notebooks */}
          {groups.map((group) => {
            const groupNotebooks = filteredNotebooks.filter(nb => nb.groupId === group.id);
            if (groupNotebooks.length === 0 && searchQuery) return null;
            const isExpanded = expandedGroups.has(group.id);
            return (
              <div key={group.id} className="notebook-group-section">
                <div className="notebook-group-header" onClick={() => toggleGroup(group.id)}>
                  {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <Folder className="w-4 h-4 text-primary" />
                  <span className="notebook-group-name">{group.name}</span>
                  <span className="nb-count-badge">{groupNotebooks.length}</span>
                  <button
                    className="notebook-card-delete"
                    onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group.id); }}
                    title={lang === 'zh' ? '删除分组' : 'Delete Group'}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                {isExpanded && groupNotebooks.length > 0 && (
                  <div className="notebook-grid">
                    {groupNotebooks.map((nb) => (
                      <NotebookCard
                        key={nb.id}
                        nb={nb}
                        lang={lang}
                        groups={groups}
                        onOpen={() => onOpenWorkspace ? onOpenWorkspace(nb.id, nb.name) : onOpenNotebookChat(nb.id, nb.name)}
                        onChat={() => onOpenNotebookChat(nb.id, nb.name)}
                        onDelete={() => setDeleteTarget(nb)}
                        onMove={handleMoveNotebook}
                      />
                    ))}
                  </div>
                )}
                {isExpanded && groupNotebooks.length === 0 && (
                  <p className="notebook-group-empty">{lang === 'zh' ? '暂无笔记本' : 'No notebooks'}</p>
                )}
              </div>
            );
          })}
          {/* Ungrouped notebooks */}
          {(() => {
            const ungrouped = filteredNotebooks.filter(nb => !nb.groupId || !groups.find(g => g.id === nb.groupId));
            if (ungrouped.length === 0) return null;
            return (
              <div className="notebook-grid" style={{ marginTop: groups.length > 0 ? '12px' : '0' }}>
                {ungrouped.map((nb) => (
                  <NotebookCard
                    key={nb.id}
                    nb={nb}
                    lang={lang}
                    groups={groups}
                    onOpen={() => onOpenWorkspace ? onOpenWorkspace(nb.id, nb.name) : onOpenNotebookChat(nb.id, nb.name)}
                    onChat={() => onOpenNotebookChat(nb.id, nb.name)}
                    onDelete={() => setDeleteTarget(nb)}
                    onMove={handleMoveNotebook}
                  />
                ))}
              </div>
            );
          })()}
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

      {/* Create Group Dialog (A14) */}
      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{lang === 'zh' ? '新建分组' : 'New Group'}</DialogTitle>
          </DialogHeader>
          <div className="notebook-create-form">
            <input
              className="notebook-input"
              placeholder={lang === 'zh' ? '分组名称' : 'Group name'}
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGroup(); }}
            />
          </div>
          <DialogFooter>
            <button className="notebook-btn-cancel" onClick={() => setShowCreateGroup(false)}>
              {lang === 'zh' ? '取消' : 'Cancel'}
            </button>
            <button className="notebook-btn-confirm" onClick={handleCreateGroup} disabled={!newGroupName.trim()}>
              {lang === 'zh' ? '创建' : 'Create'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ========== Notebook Card Component (A14: with group assignment) ==========

function NotebookCard({
  nb, lang, groups, onOpen, onChat, onDelete, onMove,
}: {
  nb: Notebook;
  lang: string;
  groups: NotebookGroup[];
  onOpen: () => void;
  onChat: () => void;
  onDelete: () => void;
  onMove: (notebookId: string, groupId: string | null) => void;
}) {
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const isZh = lang === 'zh';

  return (
    <div
      className="notebook-card"
      onClick={onOpen}
    >
      <div className="notebook-card-header">
        <BookOpen className="w-5 h-5 text-primary" />
        <h3 className="notebook-card-title">{nb.name}</h3>
        <button
          className="notebook-card-delete"
          onClick={(e) => { e.stopPropagation(); onChat(); }}
          title={isZh ? '直接对话' : 'Chat directly'}
          style={{ marginRight: '2px' }}
        >
          <MessageSquare className="w-3.5 h-3.5" />
        </button>
        <div style={{ position: 'relative' }}>
          <button
            className="notebook-card-delete"
            onClick={(e) => { e.stopPropagation(); setShowMoveMenu(!showMoveMenu); }}
            title={isZh ? '移动到分组' : 'Move to group'}
          >
            <Folder className="w-3.5 h-3.5" />
          </button>
          {showMoveMenu && (
            <div className="nb-move-menu" onClick={(e) => e.stopPropagation()}>
              <button
                className="nb-move-option"
                onClick={() => { onMove(nb.id, null); setShowMoveMenu(false); }}
              >
                {isZh ? '无分组' : 'No group'}
              </button>
              {groups.map(g => (
                <button
                  key={g.id}
                  className="nb-move-option"
                  onClick={() => { onMove(nb.id, g.id); setShowMoveMenu(false); }}
                >
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="notebook-card-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
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
          {nb.chunkCount} {isZh ? '块' : 'chunks'}
        </Badge>
        {nb.summaryStatus === 'completed' && (
          <Badge variant="success">
            <CheckCircle className="w-3 h-3" />
            {isZh ? '已索引' : 'Indexed'}
          </Badge>
        )}
        {nb.summaryStatus === 'generating' && (
          <Badge variant="warning">
            <Loader2 className="w-3 h-3 animate-spin" />
            {isZh ? '处理中' : 'Processing'}
          </Badge>
        )}
      </div>
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
