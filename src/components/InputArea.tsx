import { useState, useRef, useEffect } from "react";
import { MessageAttachment } from "../store";
import { FileUpload } from "./FileUpload";

interface InputAreaProps {
  onSend: (message: string, attachments?: MessageAttachment[]) => void;
  onCancel: () => void;
  disabled: boolean;
  isStreaming: boolean;
}

export function InputArea({ onSend, onCancel, disabled, isStreaming }: InputAreaProps) {
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSubmit = () => {
    if ((!input.trim() && pendingAttachments.length === 0) || disabled) return;
    onSend(input.trim(), pendingAttachments.length > 0 ? pendingAttachments : undefined);
    setInput("");
    setPendingAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
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
          name,
          type: "image",
          content: dataUrl,
          mimeType: file.type,
          size: file.size,
        };
        setPendingAttachments((prev) => [...prev, attachment]);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = (attachments: MessageAttachment[]) => {
    setPendingAttachments((prev) => [...prev, ...attachments]);
  };

  const removeAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="input-area">
      {/* Pending Attachments */}
      {pendingAttachments.length > 0 && (
        <div className="pending-attachments">
          {pendingAttachments.map((att) => (
            <div key={att.id} className="pending-attachment">
              <span className="attachment-icon">
                {att.type === "image" ? "🖼️" : "📄"}
              </span>
              <span className="attachment-name">{att.name}</span>
              {att.size && (
                <span className="attachment-size">{formatSize(att.size)}</span>
              )}
              <button className="attachment-remove" onClick={() => removeAttachment(att.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="input-wrapper">
        <FileUpload onUpload={handleUpload} />
        <textarea
          ref={textareaRef}
          className="message-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? "AI 正在思考..." : "输入消息... (Enter 发送, Ctrl+V 粘贴图片)"}
          disabled={disabled}
          rows={1}
        />
        {isStreaming ? (
          <button className="send-btn cancel-btn" onClick={onCancel} title="取消">
            ■
          </button>
        ) : (
          <button
            className={`send-btn ${disabled ? "disabled" : ""}`}
            onClick={handleSubmit}
            disabled={disabled || (!input.trim() && pendingAttachments.length === 0)}
          >
            →
          </button>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
