/**
 * NeedsYouPanel — Precise question dialog for Agent→Human
 *
 * When Agent encounters a decision point it can't resolve, it pauses
 * and shows this panel with:
 *   - Current work context
 *   - Confirmed facts
 *   - Specific question
 *   - Candidate options
 *
 * This is NOT a vague "what should I do?" — it's a precise, bounded question
 * with clear options and a resume path.
 */

import { useState, useEffect } from "react";
import { AlertCircle, ArrowRight } from "lucide-react";
import { getNeedsYouQueue, type NeedsYouItem } from "../core/llm/needs-you-queue";

interface NeedsYouPanelProps {
  sessionId: string;
  onAnswer: (itemId: string, answer: string) => void;
  onSkip: (sessionId: string) => void;
}

export function NeedsYouPanel({ sessionId, onAnswer, onSkip }: NeedsYouPanelProps) {
  const [currentItem, setCurrentItem] = useState<NeedsYouItem | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState("");

  useEffect(() => {
    const check = () => {
      const queue = getNeedsYouQueue();
      const pending = queue.getPending(sessionId);
      if (pending.length > 0 && !currentItem) {
        setCurrentItem(pending[0]);
        setSelectedOption(null);
        setCustomInput("");
      }
    };
    check();
    const interval = setInterval(check, 500);
    return () => clearInterval(interval);
  }, [sessionId, currentItem]);

  if (!currentItem) return null;

  const handleAnswer = () => {
    const answer = selectedOption || customInput.trim();
    if (!answer) return;
    onAnswer(currentItem.id, answer);
    setCurrentItem(null);
  };

  const handleSkip = () => {
    onSkip(sessionId);
    setCurrentItem(null);
  };

  return (
    <div className="needs-you-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleSkip(); }}>
      <div className="needs-you-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="needs-you-header">
          <AlertCircle size={18} className="needs-you-icon" />
          <span className="needs-you-title">需要你的判断</span>
          <button className="needs-you-skip" onClick={handleSkip}>跳过并继续</button>
        </div>

        {/* Context */}
        {currentItem.context && (
          <div className="needs-you-section">
            <div className="needs-you-section-label">当前工作</div>
            <div className="needs-you-section-content">{currentItem.context}</div>
          </div>
        )}

        {/* Confirmed facts */}
        {currentItem.confirmedFacts && (
          <div className="needs-you-section">
            <div className="needs-you-section-label">已确认的事实</div>
            <div className="needs-you-section-content">{currentItem.confirmedFacts}</div>
          </div>
        )}

        {/* Question */}
        <div className="needs-you-section needs-you-question">
          <div className="needs-you-section-label">问题</div>
          <div className="needs-you-section-content needs-you-question-text">{currentItem.question}</div>
        </div>

        {/* Options */}
        {currentItem.options.length > 0 && (
          <div className="needs-you-section">
            <div className="needs-you-section-label">选项</div>
            <div className="needs-you-options">
              {currentItem.options.map((opt) => (
                <button
                  key={opt.id}
                  className={"needs-you-option " + selectedOption === opt.id ? "selected" : ""}
                  onClick={() => setSelectedOption(opt.id)}
                >
                  <ArrowRight size={12} />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Custom input */}
        <div className="needs-you-section">
          <div className="needs-you-section-label">自定义回答</div>
          <textarea
            className="needs-you-input"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            placeholder="或输入自定义回答..."
            rows={2}
          />
        </div>

        {/* Actions */}
        <div className="needs-you-actions">
          <button
            className="needs-you-submit"
            onClick={handleAnswer}
            disabled={!selectedOption && !customInput.trim()}
          >
            确认回答
          </button>
        </div>
      </div>
    </div>
  );
}
