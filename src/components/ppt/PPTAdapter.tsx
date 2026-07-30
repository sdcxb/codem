/**
 * PPTAdapter — PPTEditor 适配器组件
 *
 * 职责:
 * 1. 从已有笔记内容加载 V2SlideDeck
 * 2. 支持 autoGenerate 模式: 调用 generatePPTContent 从知识库 AI 生成
 * 3. 将编辑结果序列化保存
 * 4. 处理导出下载
 */

import { useEffect, useState, useCallback } from 'react';
import PPTEditor from './PPTEditor';
import { generatePPTContent, deserializeSlideDeck, serializeSlideDeck, type V2SlideDeck } from '../../core/knowledge';
import { PPT_THEMES, createElementId } from '../../core/knowledge/ppt-types';

export interface PPTAdapterProps {
  notebookId: string;
  initialContent?: string;
  title: string;
  /** 是否在打开时自动调用 AI 生成 PPT */
  autoGenerate?: boolean;
  onSave: (title: string, content: string) => void;
  onBack: () => void;
}

export function PPTAdapter({ notebookId, initialContent, title, autoGenerate = false, onSave, onBack }: PPTAdapterProps) {
  const [deck, setDeck] = useState<V2SlideDeck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 初始化: 从 content 加载、AI 生成、或创建空白
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // 1. 尝试从已有内容加载
      if (initialContent) {
        const parsed = deserializeSlideDeck(initialContent);
        if (parsed) {
          if (!cancelled) setDeck(parsed);
          return;
        }
      }

      // 2. AI 自动生成
      if (autoGenerate) {
        if (!cancelled) setLoading(true);
        try {
          const generated = await generatePPTContent(notebookId, title, 8, 'default');
          if (!cancelled) {
            setDeck(generated);
            setLoading(false);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
        }
        return;
      }

      // 3. 创建空白 deck
      if (!cancelled) {
        setDeck({
          title,
          theme: PPT_THEMES[0],
          slides: [{
            id: createElementId(),
            index: 0,
            elements: [],
            background: PPT_THEMES[0].backgroundColor,
            notes: '',
          }],
          canvasWidth: 1280,
          canvasHeight: 720,
        });
      }
    }

    init();
    return () => { cancelled = true; };
  }, [initialContent, title, autoGenerate, notebookId]);

  const handleDeckChange = useCallback((newDeck: V2SlideDeck) => {
    setDeck(newDeck);
  }, []);

  const handleExportHTML = useCallback((html: string) => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [title]);

  const handleExportPPTX = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [title]);

  const handleBack = useCallback(() => {
    if (deck) {
      const content = serializeSlideDeck(deck);
      onSave(title, content);
    }
    onBack();
  }, [deck, title, onSave, onBack]);

  // 加载中
  if (loading) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#1e1e2e', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
        <div style={{ textAlign: 'center', color: '#e0e0e0' }}>
          <div style={{ fontSize: 18, marginBottom: 12 }}>AI 正在生成 PPT...</div>
          <div style={{ fontSize: 13, color: '#888' }}>基于知识库内容生成幻灯片大纲</div>
        </div>
      </div>
    );
  }

  // 生成失败
  if (error) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#1e1e2e', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
        <div style={{ textAlign: 'center', color: '#e0e0e0' }}>
          <div style={{ fontSize: 18, marginBottom: 12, color: '#ff8080' }}>生成失败</div>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 16 }}>{error}</div>
          <button
            onClick={() => {
              setError(null);
              // 回退到空白 deck
              setDeck({
                title,
                theme: PPT_THEMES[0],
                slides: [{
                  id: createElementId(),
                  index: 0,
                  elements: [],
                  background: PPT_THEMES[0].backgroundColor,
                  notes: '',
                }],
                canvasWidth: 1280,
                canvasHeight: 720,
              });
            }}
            style={{ padding: '8px 16px', background: '#7c6cf0', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            创建空白 PPT
          </button>
          <button
            onClick={onBack}
            style={{ padding: '8px 16px', background: '#3a3a4c', color: '#ccc', border: 'none', borderRadius: 6, cursor: 'pointer', marginLeft: 8 }}
          >
            返回
          </button>
        </div>
      </div>
    );
  }

  if (!deck) return null;

  return (
    <PPTEditor
      initialDeck={deck}
      onDeckChange={handleDeckChange}
      onExportHTML={handleExportHTML}
      onExportPPTX={handleExportPPTX}
      onBack={handleBack}
    />
  );
}

export default PPTAdapter;