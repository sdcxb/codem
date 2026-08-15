/**
 * P3-27: SkillAuditDialog — 技能安装安全审计对话框
 *
 * 在安装远程技能前显示安全审计结果：
 * - safe: 直接安装
 * - warning: 显示警告，用户确认后安装
 * - danger: 显示危险项，用户需明确接受风险
 *
 * 同时显示技能声明的权限列表。
 */

import { useState, useEffect } from "react";
import { useLang } from "../core/i18n/lang";
import type { SkillAuditResult, AuditFinding } from "../core/skill/sandbox";
import { getPermissionDescription, validatePermissions } from "../core/skill/sandbox";
import { Shield, AlertTriangle, ShieldAlert, FileWarning } from "lucide-react";
import { ActionIcons, StatusIcons } from "../core/icons/icon-map";

export interface SkillAuditDialogProps {
  /** 审计结果 */
  audit: SkillAuditResult;
  /** 技能名称 */
  skillName: string;
  /** 技能显示名 */
  skillDisplayName?: string;
  /** 是否显示 */
  open: boolean;
  /** 确认安装 */
  onConfirm: () => void;
  /** 取消安装 */
  onCancel: () => void;
}

export function SkillAuditDialog({
  audit,
  skillName,
  skillDisplayName,
  open,
  onConfirm,
  onCancel,
}: SkillAuditDialogProps) {
  const lang = useLang();
  const zh = lang === "zh";
  const [accepted, setAccepted] = useState(false);

  // Reset acceptance when dialog opens
  useEffect(() => {
    if (open) setAccepted(false);
  }, [open]);

  if (!open) return null;

  const dangerFindings = audit.findings.filter(f => f.level === "danger");
  const warningFindings = audit.findings.filter(f => f.level === "warning");
  const unknownPerms = validatePermissions(audit.declaredPermissions);

  const overallColor = audit.overall === "danger" ? "#ef4444"
    : audit.overall === "warning" ? "#f59e0b"
    : "#22c55e";

const overallIcon = audit.overall === "danger" ? <ShieldAlert size={24} />
: audit.overall === "warning" ? <StatusIcons.danger size={24} />
: <Shield size={24} />;

  const overallText = audit.overall === "danger"
    ? (zh ? "⚠ 高风险" : "⚠ High Risk")
    : audit.overall === "warning"
    ? (zh ? "⚠ 存在风险" : "⚠ Some Risk")
    : (zh ? "✓ 安全" : "✓ Safe");

  return (
    <div className="skill-audit-dialog-overlay" style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0, 0, 0, 0.6)",
      zIndex: 10000,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }} onClick={onCancel}>
      <div className="skill-audit-dialog" style={{
        background: "var(--bg-primary, #1a1a1f)",
        border: `1px solid var(--border-primary, #2a2a30)`,
        borderRadius: 12,
        maxWidth: 560,
        width: "90%",
        maxHeight: "80vh",
        overflowY: "auto",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 20px",
          borderBottom: `1px solid var(--border-primary, #2a2a30)`,
        }}>
          <div style={{ color: overallColor }}>{overallIcon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {zh ? "技能安全审计" : "Skill Security Audit"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {skillDisplayName || skillName}
            </div>
          </div>
          <span style={{
            fontSize: 12,
            fontWeight: 600,
            color: overallColor,
            padding: "4px 12px",
            borderRadius: 12,
            background: `${overallColor}20`,
          }}>
            {overallText}
          </span>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 20px" }}>
          {/* Permissions section */}
          {audit.declaredPermissions.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>
                {zh ? "声明的权限" : "Declared Permissions"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {audit.declaredPermissions.map(perm => {
                  const isUnknown = unknownPerms.includes(perm);
                  return (
                    <span key={perm} style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 10,
                      background: isUnknown ? "rgba(245, 158, 11, 0.15)" : "var(--bg-tertiary)",
                      border: `1px solid ${isUnknown ? "rgba(245, 158, 11, 0.3)" : "var(--border-primary)"}`,
                      color: isUnknown ? "#f59e0b" : "var(--text-secondary)",
                    }}>
                      {getPermissionDescription(perm, lang)}
                    </span>
                  );
                })}
              </div>
              {unknownPerms.length > 0 && (
                <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
                  {zh ? `⚠ ${unknownPerms.length} 个未知权限` : `⚠ ${unknownPerms.length} unknown permission(s)`}
                </div>
              )}
            </div>
          )}

          {/* Findings section */}
          {audit.findings.length > 0 ? (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: "var(--text-secondary)" }}>
                {zh ? `发现 ${audit.findings.length} 个问题` : `${audit.findings.length} findings`}
              </div>
              {dangerFindings.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {dangerFindings.map((finding, i) => (
                    <FindingItem key={`d-${i}`} finding={finding} />
                  ))}
                </div>
              )}
              {warningFindings.length > 0 && (
                <div>
                  {warningFindings.map((finding, i) => (
                    <FindingItem key={`w-${i}`} finding={finding} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 16px",
              background: "rgba(34, 197, 94, 0.08)",
              borderRadius: 8,
              color: "#22c55e",
              fontSize: 12,
            }}>
              <ActionIcons.confirm size={16} />
              {zh ? "未检测到安全问题" : "No security issues detected"}
            </div>
          )}

          {/* Accept risk checkbox for danger level */}
          {audit.overall === "danger" && (
            <label style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "12px",
              marginTop: 16,
              background: "rgba(239, 68, 68, 0.08)",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 12,
            }}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={e => setAccepted(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span style={{ color: "#ef4444" }}>
                {zh
                  ? "我理解安装此技能可能存在安全风险，确认继续安装。"
                  : "I understand this skill may pose security risks and wish to proceed."}
              </span>
            </label>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex",
          gap: 8,
          padding: "12px 20px",
          borderTop: `1px solid var(--border-primary, #2a2a30)`,
          justifyContent: "flex-end",
        }}>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: `1px solid var(--border-primary)`,
              background: "transparent",
              color: "var(--text-secondary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {zh ? "取消安装" : "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            disabled={audit.overall === "danger" && !accepted}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "none",
              background: audit.overall === "danger" && !accepted
                ? "var(--bg-tertiary)"
                : audit.overall === "danger" ? "#ef4444"
                : audit.overall === "warning" ? "#f59e0b"
                : "var(--accent)",
              color: "#fff",
              fontSize: 12,
              cursor: audit.overall === "danger" && !accepted ? "not-allowed" : "pointer",
              opacity: audit.overall === "danger" && !accepted ? 0.5 : 1,
            }}
          >
            {audit.overall === "danger"
              ? (zh ? "接受风险并安装" : "Accept & Install")
              : audit.overall === "warning"
              ? (zh ? "仍要安装" : "Install Anyway")
              : (zh ? "安装" : "Install")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ========== Finding Item ==========

function FindingItem({ finding }: { finding: AuditFinding }) {
  const lang = useLang();
  const zh = lang === "zh";
  const color = finding.level === "danger" ? "#ef4444" : "#f59e0b";
  const icon = finding.level === "danger" ? <ShieldAlert size={14} /> : <FileWarning size={14} />;

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      padding: "8px 12px",
      marginBottom: 6,
      background: `${color}10`,
      border: `1px solid ${color}30`,
      borderRadius: 6,
      fontSize: 12,
    }}>
      <span style={{ color, marginTop: 1, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ color: "var(--text-primary)", fontWeight: 500 }}>
          {finding.message}
        </div>
        {finding.filePath && (
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
            {finding.filePath}
          </div>
        )}
        {finding.snippet && (
          <pre style={{
            fontSize: 10,
            color: "var(--text-muted)",
            marginTop: 4,
            background: "var(--bg-tertiary)",
            padding: "4px 8px",
            borderRadius: 4,
            overflowX: "auto",
            maxWidth: "100%",
          }}>
            {finding.snippet}
          </pre>
        )}
      </div>
    </div>
  );
}
