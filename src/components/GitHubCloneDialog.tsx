/**
 * GitHub Clone Dialog
 * 输入 GitHub 项目地址，自动 git clone 到本地并创建项目
 */

import { useState } from "react";
import { useLang } from "../core/i18n/lang";
import { useProjectStore } from "../core/store";

interface GitHubCloneDialogProps {
  onClose: () => void;
}

export function GitHubCloneDialog({ onClose }: GitHubCloneDialogProps) {
  const lang = useLang();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "cloning" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [projectName, setProjectName] = useState("");

  // 从 GitHub URL 中提取项目名
  function extractRepoName(gitUrl: string): string {
    // 移除 .git 后缀
    const cleanUrl = gitUrl.trim().replace(/\.git$/, "");
    // 取最后一段
    const parts = cleanUrl.split("/");
    return parts[parts.length - 1] || "github-project";
  }

  async function handleClone() {
    if (!url.trim()) return;

    const name = extractRepoName(url);
    setProjectName(name);
    setStatus("cloning");

    try {
      const isTauri = !!(window as any).__TAURI__;
      if (!isTauri) {
        throw new Error(lang === "zh" ? "需要在桌面应用中使用此功能" : "This feature requires the desktop app");
      }

      const { invoke } = (window as any).__TAURI__.core;

      // 获取用户主目录
      const home = await invoke("get_default_cwd");

      // 创建项目目录
      const projectDir = `${home}\\${name}`;

      // 先检查 git 是否可用
      try {
        await invoke("execute_command", { command: "git --version" });
      } catch {
        throw new Error(lang === "zh" ? "未找到 git，请先安装 Git" : "Git not found. Please install Git first.");
      }

      // 执行 git clone
      const result = await invoke("execute_command", {
        command: `git clone "${url.trim()}" "${projectDir}"`,
      });

      // 检查 clone 是否成功（git clone 失败时 stderr 不为空但 exitCode 可能非0）
      const stderr = (result as any)?.stderr || "";
      if (stderr.includes("fatal") || stderr.includes("error")) {
        throw new Error(stderr);
      }

      // 创建项目
      const { createProject } = useProjectStore.getState();
      createProject(name, projectDir, `Cloned from ${url.trim()}`);

      setStatus("done");
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (e: any) {
      setStatus("error");
      setErrorMsg(e?.message || String(e));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-editor"
        style={{ maxWidth: "500px", padding: "24px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ marginBottom: "16px", fontSize: "18px", fontWeight: 600 }}>
          <i className="fab fa-github" style={{ marginRight: "8px" }} />
          {lang === "zh" ? "从 GitHub 拉取项目" : "Clone from GitHub"}
        </h2>

        {status === "idle" && (
          <>
            <p style={{ marginBottom: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
              {lang === "zh"
                ? "输入 GitHub 仓库地址，将自动克隆到本地并创建项目。"
                : "Enter a GitHub repository URL. It will be cloned locally and a project will be created."}
            </p>
            <input
              type="text"
              className="github-clone-input"
              placeholder="https://github.com/user/repo.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleClone()}
              autoFocus
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid var(--border-primary, #333)",
                background: "var(--input-bg, #1e1e2e)",
                color: "var(--text-primary, #e0e0e0)",
                fontSize: "14px",
                outline: "none",
                marginBottom: "16px",
              }}
            />
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                onClick={onClose}
                style={{
                  padding: "8px 20px",
                  borderRadius: "8px",
                  border: "none",
                  background: "var(--bg-hover, #2a2a3a)",
                  color: "var(--text-secondary, #888)",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                {lang === "zh" ? "取消" : "Cancel"}
              </button>
              <button
                onClick={handleClone}
                disabled={!url.trim()}
                style={{
                  padding: "8px 20px",
                  borderRadius: "8px",
                  border: "none",
                  background: url.trim() ? "var(--accent, #ff6b35)" : "var(--bg-hover, #2a2a3a)",
                  color: "#fff",
                  cursor: url.trim() ? "pointer" : "not-allowed",
                  fontSize: "14px",
                  fontWeight: 500,
                }}
              >
                <i className="fas fa-download" style={{ marginRight: "6px" }} />
                {lang === "zh" ? "拉取" : "Clone"}
              </button>
            </div>
          </>
        )}

        {status === "cloning" && (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <i className="fas fa-spinner fa-spin" style={{ fontSize: "32px", color: "var(--accent, #ff6b35)", marginBottom: "16px" }} />
            <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
              {lang === "zh" ? `正在克隆 ${projectName}...` : `Cloning ${projectName}...`}
            </p>
          </div>
        )}

        {status === "done" && (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <i className="fas fa-check-circle" style={{ fontSize: "32px", color: "#22c55e", marginBottom: "16px" }} />
            <p style={{ color: "var(--text-primary)", fontSize: "14px", fontWeight: 500 }}>
              {lang === "zh" ? `项目 ${projectName} 创建成功！` : `Project ${projectName} created successfully!`}
            </p>
          </div>
        )}

        {status === "error" && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ color: "#ef4444", fontSize: "14px", marginBottom: "12px" }}>
              <i className="fas fa-exclamation-circle" style={{ marginRight: "6px" }} />
              {lang === "zh" ? "克隆失败" : "Clone failed"}
            </div>
            <pre style={{
              background: "var(--bg-hover, #2a2a3a)",
              padding: "12px",
              borderRadius: "8px",
              fontSize: "12px",
              color: "#ef4444",
              maxHeight: "150px",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}>
              {errorMsg}
            </pre>
            <button
              onClick={() => { setStatus("idle"); setErrorMsg(""); }}
              style={{
                marginTop: "12px",
                padding: "8px 20px",
                borderRadius: "8px",
                border: "none",
                background: "var(--accent, #ff6b35)",
                color: "#fff",
                cursor: "pointer",
                fontSize: "14px",
                width: "100%",
              }}
            >
              {lang === "zh" ? "重试" : "Try Again"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
