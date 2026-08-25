/**
 * FlashcardViewer — 闪卡学习与复习组件
 *
 * 借鉴 Lumina Note 的闪卡功能, 自研实现:
 * - SM-2 间隔重复算法
 * - 翻卡交互
 * - 复习评分 (Again / Hard / Good / Easy)
 * - AI 生成闪卡
 */

import { useState, useEffect, useCallback } from 'react';
import { Layers, RotateCw, Plus, Trash2, Sparkles, Loader2 } from 'lucide-react';
import { ActionIcons } from '../core/icons/icon-map';
import {
  listFlashcards, getDueFlashcards, createFlashcard, deleteFlashcard,
  reviewFlashcard, listFlashcardsByNote, getDueFlashcardsByNote,
  type Flashcard, type ReviewRating,
} from '../core/knowledge/flashcard-store';
import { generateFlashcards } from '../core/knowledge';
import { useLang } from '../core/i18n/lang';

interface FlashcardViewerProps {
  notebookId: string;
  noteId?: string;
  onClose: () => void;
}

export function FlashcardViewer({ notebookId, noteId, onClose }: FlashcardViewerProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const CloseIcon = ActionIcons.close;

  const [cards, setCards] = useState<Flashcard[]>([]);
  const [dueCards, setDueCards] = useState<Flashcard[]>([]);
  const [mode, setMode] = useState<'list' | 'review' | 'create'>('list');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');

  const refresh = useCallback(() => {
    // C5: 如果提供了 noteId，只显示该笔记的闪卡
    if (noteId) {
      setCards(listFlashcardsByNote(noteId));
      setDueCards(getDueFlashcardsByNote(noteId));
    } else {
      setCards(listFlashcards(notebookId));
      setDueCards(getDueFlashcards(notebookId));
    }
  }, [notebookId, noteId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleStartReview = () => {
    const reviewPool = dueCards.length > 0 ? dueCards : cards;
    if (reviewPool.length === 0) return;
    setDueCards(reviewPool);
    setCurrentIdx(0);
    setShowAnswer(false);
    setMode('review');
  };

  const handleReview = (rating: ReviewRating) => {
    const card = dueCards[currentIdx];
    if (!card) return;
    reviewFlashcard(card.id, rating);
    if (currentIdx < dueCards.length - 1) {
      setCurrentIdx(currentIdx + 1);
      setShowAnswer(false);
    } else {
      setMode('list');
      refresh();
    }
  };

  const handleCreate = () => {
    if (!front.trim() || !back.trim()) return;
    createFlashcard({ notebookId, front: front.trim(), back: back.trim() });
    setFront(''); setBack('');
    refresh();
    setMode('list');
  };

  const handleAIGenerate = async () => {
    // 模型能力检测
    const { checkFeatureAvailability } = await import('../core/llm/capability-detector');
    const capCheck = checkFeatureAvailability('ai-flashcards');
    if (!capCheck.available) {
      alert(isZh ? capCheck.warnings[0]?.zh : capCheck.warnings[0]?.en);
      return;
    }

    setGenerating(true);
    try {
      // C5: 传递 noteId 以从特定笔记内容生成闪卡
      const cards = await generateFlashcards(notebookId, 15, noteId);
      for (const card of cards) {
        createFlashcard({ notebookId, noteId, front: card.front, back: card.back });
      }
      refresh();
    } catch (e) {
      console.error('AI flashcard generation failed:', e);
    } finally {
      setGenerating(false);
    }
  };

  // ========== Review Mode ==========
  if (mode === 'review' && dueCards.length > 0) {
    const card = dueCards[currentIdx];
    return (
      <div className="nb-dialog-overlay" onClick={onClose}>
        <div className="nb-dialog" style={{ width: '600px', maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
          <div className="nb-dialog-header">
            <h3 className="nb-dialog-title">
              <Layers size={16} />
              {isZh ? '闪卡复习' : 'Flashcard Review'}
              <span style={{ fontSize: '12px', opacity: 0.5, marginLeft: '8px' }}>
                {currentIdx + 1} / {dueCards.length}
              </span>
            </h3>
            <button className="nb-dialog-close" onClick={() => setMode('list')}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div style={{ padding: '24px', minHeight: '300px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div
              onClick={() => setShowAnswer(!showAnswer)}
              style={{
                width: '100%', minHeight: '200px', padding: '24px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-primary)',
                borderRadius: '12px', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                textAlign: 'center', transition: 'all 0.2s ease',
              }}
            >
              {!showAnswer ? (
                <>
                  <span style={{ fontSize: '10px', opacity: 0.4, textTransform: 'uppercase', marginBottom: '12px' }}>
                    {isZh ? '问题' : 'Question'}
                  </span>
                  <p style={{ fontSize: '16px', lineHeight: '1.6', margin: 0 }}>{card.front}</p>
                  <span style={{ fontSize: '11px', opacity: 0.4, marginTop: '16px' }}>
                    {isZh ? '点击查看答案' : 'Click to reveal answer'}
                  </span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '10px', opacity: 0.4, textTransform: 'uppercase', marginBottom: '12px' }}>
                    {isZh ? '答案' : 'Answer'}
                  </span>
                  <p style={{ fontSize: '14px', lineHeight: '1.6', margin: 0, opacity: 0.9 }}>{card.back}</p>
                </>
              )}
            </div>
            {showAnswer && (
              <div style={{ display: 'flex', gap: '8px', marginTop: '20px', width: '100%' }}>
                {([
                  { r: 'again' as ReviewRating, label: isZh ? '重来' : 'Again', color: '#ef4444' },
                  { r: 'hard' as ReviewRating, label: isZh ? '困难' : 'Hard', color: '#eab308' },
                  { r: 'good' as ReviewRating, label: isZh ? '良好' : 'Good', color: '#22c55e' },
                  { r: 'easy' as ReviewRating, label: isZh ? '简单' : 'Easy', color: '#6366f1' },
                ]).map(({ r, label, color }) => (
                  <button
                    key={r}
                    onClick={() => handleReview(r)}
                    style={{
                      flex: 1, padding: '10px',
                      background: `${color}22`, border: `1px solid ${color}55`,
                      borderRadius: '8px', color, cursor: 'pointer',
                      fontSize: '13px', fontWeight: 500,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== Create Mode ==========
  if (mode === 'create') {
    return (
      <div className="nb-dialog-overlay" onClick={onClose}>
        <div className="nb-dialog" style={{ width: '500px' }} onClick={(e) => e.stopPropagation()}>
          <div className="nb-dialog-header">
            <h3 className="nb-dialog-title"><Plus size={16} />{isZh ? '创建闪卡' : 'Create Flashcard'}</h3>
            <button className="nb-dialog-close" onClick={() => setMode('list')}><CloseIcon size={16} /></button>
          </div>
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', opacity: 0.6, marginBottom: '4px', display: 'block' }}>{isZh ? '正面（问题）' : 'Front (Question)'}</label>
              <textarea style={{ width: '100%', minHeight: '80px', padding: '8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} value={front} onChange={(e) => setFront(e.target.value)} placeholder={isZh ? '输入问题...' : 'Enter question...'} />
            </div>
            <div>
              <label style={{ fontSize: '12px', opacity: 0.6, marginBottom: '4px', display: 'block' }}>{isZh ? '背面（答案）' : 'Back (Answer)'}</label>
              <textarea style={{ width: '100%', minHeight: '80px', padding: '8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} value={back} onChange={(e) => setBack(e.target.value)} placeholder={isZh ? '输入答案...' : 'Enter answer...'} />
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button className="nb-btn-cancel" onClick={() => setMode('list')}>{isZh ? '取消' : 'Cancel'}</button>
              <button className="nb-btn-confirm" onClick={handleCreate} disabled={!front.trim() || !back.trim()}>{isZh ? '创建' : 'Create'}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ========== List Mode ==========
  return (
    <div className="nb-dialog-overlay" onClick={onClose}>
      <div className="nb-dialog" style={{ width: '700px', maxWidth: '90vw', maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="nb-dialog-header">
          <h3 className="nb-dialog-title">
            <Layers size={16} />
            {isZh ? (noteId ? '笔记闪卡' : '闪卡') : (noteId ? 'Note Flashcards' : 'Flashcards')}
            <span className="nb-count-badge">{cards.length}</span>
          </h3>
          <button className="nb-dialog-close" onClick={onClose}><CloseIcon size={16} /></button>
        </div>
        <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button className="nb-studio-btn" onClick={handleStartReview} disabled={cards.length === 0} style={{ fontSize: '12px', padding: '4px 12px' }}>
            <RotateCw size={14} />
            {isZh ? `复习 (${dueCards.length})` : `Review (${dueCards.length} due)`}
          </button>
          <button className="nb-studio-btn" onClick={() => setMode('create')} style={{ fontSize: '12px', padding: '4px 12px' }}>
            <Plus size={14} />
            {isZh ? '新建' : 'New'}
          </button>
          <button className="nb-studio-btn" onClick={handleAIGenerate} disabled={generating} style={{ fontSize: '12px', padding: '4px 12px' }}>
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {isZh ? (noteId ? '从笔记生成' : 'AI 生成') : (noteId ? 'From Note' : 'AI Generate')}
          </button>
        </div>
        <div style={{ overflow: 'auto', maxHeight: '50vh', padding: '12px 20px' }}>
          {cards.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <Layers size={32} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
              <p>{isZh ? '暂无闪卡，点击「新建」或「AI 生成」创建' : 'No flashcards yet. Click "New" or "AI Generate"'}</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {cards.map((card) => {
                const isDue = card.nextReview <= Date.now();
                return (
                  <div key={card.id} style={{ padding: '12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 4px' }}>{card.front}</p>
                        <p style={{ fontSize: '12px', opacity: 0.6, margin: 0 }}>{card.back}</p>
                      </div>
                      <button onClick={() => { deleteFlashcard(card.id); refresh(); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px', flexShrink: 0 }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '6px', fontSize: '10px', opacity: 0.5 }}>
                      {isDue && <span style={{ color: '#eab308' }}>● {isZh ? '待复习' : 'Due'}</span>}
                      {card.repetitions > 0 && <span>{isZh ? `复习 ${card.repetitions} 次` : `${card.repetitions} reps`}</span>}
                      <span>{isZh ? `间隔 ${card.intervalDays} 天` : `${card.intervalDays}d interval`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
