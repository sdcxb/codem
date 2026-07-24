import { useState, useEffect } from "react";
import { useLang } from "../core/i18n/lang";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import type { GitConfig, EnvironmentConfig, CustomOperation } from "../core/settings/settings";
import { runCustomOperation } from "../core/environment";

// ========== G Series: Git Configuration Section ==========

export function GitConfigSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [gitConfig, setGitConfig] = useState<GitConfig>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = getSettingJSON<GitConfig | null>("codem-git-config", null);
    if (stored) setGitConfig(stored);
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-git-config", gitConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (upd: Partial<GitConfig>) => setGitConfig(prev => ({ ...prev, ...upd }));

  return (
    <div className="setting-group">
      <div className="settings-section-title">{zh ? "🌿 Git 偏好配置" : "🌿 Git Preferences"}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh ? "配置 Git 操作偏好。AI 执行 Git 命令时会遵循这些规则。" : "Configure Git preferences. The AI follows these rules for Git operations."}
      </div>

      {/* Branch prefix */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "分支前缀" : "Branch Prefix"}
        </label>
        <input
          type="text"
          value={gitConfig.branchPrefix || ""}
          onChange={(e) => update({ branchPrefix: e.target.value })}
          placeholder={zh ? "如 feature/ 或 feat/" : "e.g. feature/ or feat/"}
          style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {zh ? "创建新分支时自动添加此前缀" : "Prepended to new branch names"}
        </div>
      </div>

      {/* Merge method */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "PR 合并方法" : "PR Merge Method"}
        </label>
        <select
          value={gitConfig.mergeMethod || ""}
          onChange={(e) => update({ mergeMethod: (e.target.value || undefined) as GitConfig["mergeMethod"] })}
          style={{ width: "100%", fontSize: 12 }}
        >
          <option value="">{zh ? "默认（不指定）" : "Default"}</option>
          <option value="merge">Merge commit</option>
          <option value="squash">Squash and merge</option>
          <option value="rebase">Rebase and merge</option>
        </select>
      </div>

      {/* Force push */}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          id="git-force-push"
          checked={gitConfig.forcePush === true}
          onChange={(e) => update({ forcePush: e.target.checked })}
        />
        <label htmlFor="git-force-push" style={{ fontSize: 12, cursor: "pointer" }}>
          {zh ? "允许强制推送 (force push)" : "Allow force push"}
        </label>
      </div>

      {/* Draft PR */}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          id="git-draft-pr"
          checked={gitConfig.draftPR === true}
          onChange={(e) => update({ draftPR: e.target.checked })}
        />
        <label htmlFor="git-draft-pr" style={{ fontSize: 12, cursor: "pointer" }}>
          {zh ? "默认创建草稿 PR" : "Default to draft PR"}
        </label>
      </div>

      {/* GitHub Token */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "GitHub Token（用于 API 操作）" : "GitHub Token (for API operations)"}
        </label>
        <input
          type="password"
          value={gitConfig.githubToken || ""}
          onChange={(e) => update({ githubToken: e.target.value })}
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
        />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {zh ? "用于创建远程仓库等操作。需要 repo 权限。" : "Used for creating repositories etc. Requires repo scope."}
        </div>
      </div>

      {/* Commit message instructions */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "提交信息风格指令" : "Commit Message Instructions"}
        </label>
        <textarea
          value={gitConfig.commitMessageInstructions || ""}
          onChange={(e) => update({ commitMessageInstructions: e.target.value })}
          placeholder={zh ? "如：conventional commits 格式" : "e.g. conventional commits"}
          rows={2}
          style={{ width: "100%", fontSize: 12, resize: "vertical" }}
        />
      </div>

      {/* PR title instructions */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "PR 标题风格指令" : "PR Title Instructions"}
        </label>
        <input
          type="text"
          value={gitConfig.prTitleInstructions || ""}
          onChange={(e) => update({ prTitleInstructions: e.target.value })}
          placeholder={zh ? "如：[模块] 简短描述" : "e.g. [Module] Brief"}
          style={{ width: "100%", fontSize: 12 }}
        />
      </div>

      {/* PR description instructions */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "PR 描述风格指令" : "PR Description Instructions"}
        </label>
        <textarea
          value={gitConfig.prDescriptionInstructions || ""}
          onChange={(e) => update({ prDescriptionInstructions: e.target.value })}
          placeholder={zh ? "如：包含改动原因、测试方案" : "e.g. Include rationale and tests"}
          rows={2}
          style={{ width: "100%", fontSize: 12, resize: "vertical" }}
        />
      </div>

      <button
        onClick={handleSave}
        style={{
          padding: "6px 16px",
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          border: "none",
          borderRadius: 4,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {saved ? (zh ? "✅ 已保存" : "✅ Saved") : (zh ? "保存 Git 配置" : "Save Git Config")}
      </button>
    </div>
  );
}

// ========== ENV Series: Environment Scripts Section ==========

export function EnvironmentConfigSection() {
  const lang = useLang();
  const zh = lang === "zh";
  const [envConfig, setEnvConfig] = useState<EnvironmentConfig>({});
  const [saved, setSaved] = useState(false);
  const [runResult, setRunResult] = useState("");
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    const stored = getSettingJSON<EnvironmentConfig | null>("codem-env-config", null);
    if (stored) setEnvConfig(stored);
  }, []);

  const handleSave = () => {
    setSettingJSON("codem-env-config", envConfig);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const update = (upd: Partial<EnvironmentConfig>) => setEnvConfig(prev => ({ ...prev, ...upd }));

  const addCustomOperation = () => {
    const newOp: CustomOperation = {
      id: `op-${Date.now()}`,
      name: zh ? "新操作" : "New Operation",
      command: "",
      icon: "🔧",
    };
    update({ customOperations: [...(envConfig.customOperations || []), newOp] });
  };

  const updateOp = (id: string, upd: Partial<CustomOperation>) => {
    update({
      customOperations: (envConfig.customOperations || []).map(op =>
        op.id === id ? { ...op, ...upd } : op
      ),
    });
  };

  const removeOp = (id: string) => {
    update({
      customOperations: (envConfig.customOperations || []).filter(op => op.id !== id),
    });
  };

  const handleRun = async (opId: string) => {
    const op = (envConfig.customOperations || []).find(o => o.id === opId);
    if (!op || !op.command.trim()) return;
    setRunning(opId);
    setRunResult("");
    try {
      const { useProjectStore } = await import("../core/store");
      const cwd = useProjectStore.getState().currentProject?.path;
      if (!cwd) {
        setRunResult(zh ? "❌ 未打开项目" : "❌ No project open");
        return;
      }
      const result = await runCustomOperation(opId, cwd);
      if (result) {
        const lines: string[] = [
          `${zh ? "操作" : "Operation"}: ${op.name}`,
          `${zh ? "命令" : "Command"}: ${op.command}`,
          `${zh ? "耗时" : "Duration"}: ${result.duration}ms`,
          `${zh ? "退出码" : "Exit"}: ${result.exitCode}`,
        ];
        if (result.stdout) lines.push(`\nstdout:\n${result.stdout}`);
        if (result.stderr) lines.push(`\nstderr:\n${result.stderr}`);
        lines.push(result.success ? "✅ " + (zh ? "成功" : "Success") : "❌ " + (zh ? "失败" : "Failed"));
        setRunResult(lines.join("\n"));
      }
    } catch (e: any) {
      setRunResult(`❌ ${e?.message || e}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="setting-group">
      <div className="settings-section-title">{zh ? "🏗️ 环境脚本配置" : "🏗️ Environment Scripts"}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        {zh
          ? "配置项目环境脚本。打开/切换项目时自动执行设置和清理脚本，还可以定义一键操作。"
          : "Setup/cleanup scripts run automatically on project switch. Custom operations are one-click actions."}
      </div>

      {/* Setup script */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "设置脚本（打开项目时自动执行）" : "Setup Script (on project open)"}
        </label>
        <input
          type="text"
          value={envConfig.setupScript || ""}
          onChange={(e) => update({ setupScript: e.target.value })}
          placeholder={zh ? "如 npm install" : "e.g. npm install"}
          style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
        />
      </div>

      {/* Cleanup script */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          {zh ? "清理脚本（切换/关闭项目时执行）" : "Cleanup Script (on project close)"}
        </label>
        <input
          type="text"
          value={envConfig.cleanupScript || ""}
          onChange={(e) => update({ cleanupScript: e.target.value })}
          placeholder={zh ? "如 docker compose down" : "e.g. docker compose down"}
          style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
        />
      </div>

      {/* Custom operations */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {zh ? "自定义操作" : "Custom Operations"}
          </label>
          <button
            onClick={addCustomOperation}
            style={{
              padding: "3px 10px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-primary)",
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            + {zh ? "添加" : "Add"}
          </button>
        </div>

        {(envConfig.customOperations || []).length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
            {zh ? "暂无自定义操作。点击\"添加\"创建一键构建/启动/测试等操作。" : "No custom operations yet."}
          </div>
        )}

        {(envConfig.customOperations || []).map((op) => (
          <div
            key={op.id}
            style={{
              display: "flex",
              gap: 6,
              alignItems: "flex-end",
              padding: 8,
              background: "var(--bg-secondary)",
              borderRadius: 6,
              border: "1px solid var(--border-primary)",
              marginBottom: 6,
            }}
          >
            <input
              type="text"
              value={op.icon || ""}
              onChange={(e) => updateOp(op.id, { icon: e.target.value })}
              placeholder="🔧"
              style={{ width: 36, fontSize: 12, textAlign: "center" }}
            />
            <div style={{ flex: 1 }}>
              <input
                type="text"
                value={op.name}
                onChange={(e) => updateOp(op.id, { name: e.target.value })}
                placeholder={zh ? "操作名称" : "Name"}
                style={{ width: "100%", fontSize: 12, marginBottom: 4 }}
              />
              <input
                type="text"
                value={op.command}
                onChange={(e) => updateOp(op.id, { command: e.target.value })}
                placeholder={zh ? "如 npm run build" : "e.g. npm run build"}
                style={{ width: "100%", fontSize: 12, fontFamily: "monospace" }}
              />
            </div>
            <button
              onClick={() => handleRun(op.id)}
              disabled={running === op.id || !op.command.trim()}
              style={{
                padding: "4px 10px",
                background: running === op.id ? "var(--bg-tertiary)" : "var(--accent)",
                color: "var(--text-on-accent)",
                border: "none",
                borderRadius: 4,
                fontSize: 11,
                cursor: running === op.id ? "wait" : "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {running === op.id ? "⏳" : "▶"}
            </button>
            <button
              onClick={() => removeOp(op.id)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 14,
                padding: "0 4px",
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {runResult && (
        <pre
          style={{
            marginTop: 8,
            padding: 8,
            background: "var(--bg-primary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 4,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {runResult}
        </pre>
      )}

      <button
        onClick={handleSave}
        style={{
          padding: "6px 16px",
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          border: "none",
          borderRadius: 4,
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {saved ? (zh ? "✅ 已保存" : "✅ Saved") : (zh ? "保存环境配置" : "Save Environment Config")}
      </button>
    </div>
  );
}
