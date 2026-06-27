import { useRef, useState } from "react";
import { MessageAttachment } from "../store";

interface FileUploadProps {
  onUpload: (attachments: MessageAttachment[]) => void;
}

export function FileUpload({ onUpload }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const attachments: MessageAttachment[] = [];

    for (const file of Array.from(files)) {
      try {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("http://localhost:3002/api/upload", {
          method: "POST",
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          if (data.files && data.files.length > 0) {
            const uploaded = data.files[0];

            // Generate preview for text files
            let preview: string | undefined;
            if (isTextFile(file.name)) {
              const text = await readFileAsText(file);
              preview = text.length > 2000 ? text.substring(0, 2000) + "\n..." : text;
            } else if (isImageFile(file.name)) {
              preview = await readFileAsDataURL(file);
            }

            attachments.push({
              id: uploaded.id,
              name: file.name,
              type: isImageFile(file.name) ? "image" : "file",
              content: preview,
              mimeType: uploaded.mimeType,
              size: file.size,
            });
          }
        }
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }

    if (attachments.length > 0) {
      onUpload(attachments);
    }

    setUploading(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
      <button
        className="upload-btn"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        title="上传文件"
      >
        {uploading ? "⏳" : "📎"}
      </button>
    </>
  );
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["txt", "md", "json", "js", "ts", "jsx", "tsx", "css", "html", "py", "rs", "go", "java", "c", "cpp", "h", "yaml", "yml", "toml", "xml", "csv", "sql", "sh", "bat", "log", "ini", "cfg", "conf"].includes(ext);
}

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
