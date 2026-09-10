/**
 * WechatSettings — 微信 ClawBot 设置卡（对标 EAC/OpenClaw 微信通道 settings）
 *
 * - 扫码绑定（QR 渲染 + 链接兜底）、配对码输入、断开/重连、24h 过期提醒
 * - 默认模型 / 默认工作区
 * - 准入管理（待批准 / 白名单 / 黑名单）——Bot 主人(ilink_user_id)自动放行
 * - 合规提示：24h token + 10条/24h 配额为社区实测（软记账），腾讯条款风险
 *
 * 事件订阅：桥（startWechatBridge）把 Rust ilink-* 事件转成 window CustomEvent
 * （EVT_STATE/EVT_QR/EVT_NEED_VERIFY/EVT_EXPIRED），本组件监听 + 主动 invoke
 * ilink_status 刷新（挂载/动作后）。
 */
import { useState, useEffect, useCallback } from "react";
import { useLang } from "../core/i18n/lang";
import qrcode from "qrcode-generator";
import {
  getStateCache,
  normalizeStatus,
  EVT_STATE,
  EVT_QR,
  EVT_NEED_VERIFY,
  EVT_EXPIRED,
  loadAccess,
  saveAccess,
  approvePendingPeer,
  ignorePeer,
  allowPeerByInput,
  getSettings,
  saveSettings,
  type WechatStatus,
  type WechatLinkState,
} from "../core/wechat-bridge/wechat-bridge";

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) throw new Error("not in tauri");
  return invoke(cmd, args);
}

const STATE_LABEL: Record<WechatLinkState, [string, string]> = {
  disconnected: ["未连接", "Disconnected"],
  waiting_qr: ["获取二维码…", "Fetching QR…"],
  waiting_scan: ["等待扫码", "Waiting for scan"],
  need_verify_code: ["需要配对码", "Verify code required"],
  connected: ["已连接", "Connected"],
  expired: ["会话已过期", "Expired"],
};

/** 二维码（SVG 直出，无需 canvas） */
function QrSvg({ text }: { text: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const cell = Math.max(2, Math.floor(190 / (count + 8)));
      setSvg(qr.createSvgTag(cell, 4));
    } catch {
      setSvg("");
    }
  }, [text]);
  if (!svg) {
    return <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>二维码渲染失败，请用下方链接打开</div>;
  }
  return (
    <div
      dangerouslySetInnerHTML={{ __html: svg }}
      style={{
        width: 190, height: 190, background: "var(--text-on-accent)", borderRadius: 10,
        padding: 6, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    />
  );
}

export function WechatSettings() {
  const lang = useLang();
  const zh = lang === "zh";
  const [status, setStatus] = useState<WechatStatus>(() => getStateCache());
  const [access, setAccess] = useState(() => loadAccess());
  const [verifyCode, setVerifyCode] = useState("");
  const [enabled, setEnabled] = useState(() => getSettings().enabled !== false);
  const [model, setModel] = useState(() => getSettings().model || "");
  const [workspace, setWorkspace] = useState(() => getSettings().workspacePath || "");
  const [newPeer, setNewPeer] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      const raw = await tauriInvoke("ilink_status");
      setStatus(normalizeStatus(raw));
    } catch {
      /* 非 tauri 环境 */
    }
  }, []);

  const refreshAccess = useCallback(() => setAccess(loadAccess()), []);

  useEffect(() => {
    const on = (name: string, h: (e: any) => void) => {
      window.addEventListener(name, h as EventListener);
      return () => window.removeEventListener(name, h as EventListener);
    };
    const offs = [
      on(EVT_STATE, (e) => { setStatus(e.detail as WechatStatus); refreshAccess(); }),
      on(EVT_QR, () => { refreshStatus(); }),
      on(EVT_NEED_VERIFY, () => { refreshStatus(); }),
      on(EVT_EXPIRED, () => { refreshStatus(); }),
    ];
    refreshStatus();
    return () => offs.forEach((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = useCallback(async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try { await fn(); } catch (e: any) { setNotice(String(e?.message || e)); }
    setBusy(false);
    await refreshStatus();
  }, [refreshStatus]);

  const connected = status.state === "connected";
  const qrUrl = status.qrcode_url || "";
  const expiresH = status.expires_at_ms
    ? Math.max(0, Math.round((status.expires_at_ms - Date.now()) / 3600000))
    : 0;
  const [sLabel, eLabel] = STATE_LABEL[status.state] || ["", ""];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>
        {zh ? "微信 ClawBot（iLink）" : "WeChat ClawBot (iLink)"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7 }}>
        {zh
          ? "扫码把你的微信绑成 Bot：之后在微信里直接发消息，就能驱动 Codem 助手干活（任务在桌面端执行）。传输层常驻 Rust 进程——主窗口最小化/刷新也不中断收消息。陌生人消息默认进入「待批准」，防止远程误用你的文件与工具。"
          : "Scan to bind your WeChat as a Bot: messages sent to it in WeChat drive the Codem assistant (work runs on this desktop). Transport lives in the Rust process — minimized/refreshed windows keep receiving. Stranger messages go to \"pending approval\" to prevent remote misuse of your files and tools."}
      </div>

      {/* ---- 连接状态区 ---- */}
      <div className="setting-group">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              padding: "3px 10px", borderRadius: 999, fontSize: 'var(--fs-xs)', fontWeight: 600,
              background: connected ? "color-mix(in srgb, var(--success) 18%, transparent)" : "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: connected ? "var(--success)" : "var(--text-primary)",
              border: connected ? "1px solid color-mix(in srgb, var(--success) 40%, transparent)" : "1px solid var(--border-primary)",
            }}
          >
            {zh ? sLabel : eLabel}
          </span>
          {connected && (
            <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
              {zh
                ? `Bot ${status.bot_id || ""} · 剩余 ${expiresH} 小时 · 收 ${status.inbound_count} / 发 ${status.outbound_count}`
                : `Bot ${status.bot_id || ""} · ~${expiresH}h left · in ${status.inbound_count} / out ${status.outbound_count}`}
            </span>
          )}
          {!connected && status.last_error && (
            <span style={{ fontSize: 'var(--fs-xs)', color: "var(--warning)" }}>{status.last_error}</span>
          )}
        </div>

        {notice && (
          <div style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6 }}>{notice}</div>
        )}

        {/* 未连接 / 过期 → 扫码按钮 */}
        {(status.state === "disconnected" || status.state === "expired") && (
          <div style={{ marginTop: 10 }}>
            <button
              disabled={busy}
              onClick={() => act(async () => { setNotice(""); await tauriInvoke("ilink_start_login"); await refreshStatus(); })}
              style={{ ...btnStyle, background: "var(--accent)", color: "var(--text-on-accent)", fontWeight: 600 }}
            >
              {zh ? "扫码登录微信" : "Scan to login"}
            </button>
          </div>
        )}

        {/* 等待扫码 / 取码中 → QR */}
        {(status.state === "waiting_qr" || status.state === "waiting_scan") && (
          <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            {qrUrl ? (
              <>
                <QrSvg text={qrUrl} />
                <div style={{ display: "grid", gap: 6, maxWidth: 300 }}>
                  <div style={{ fontSize: 'var(--fs-sm)' }}>
                    {zh ? "用微信「扫一扫」扫描，在手机上确认绑定" : "Scan with WeChat to confirm binding"}
                  </div>
                  {status.state === "waiting_scan" && !status.last_error && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>二维码已就绪…</div>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => act(async () => { await tauriInvoke("ilink_start_login"); await refreshStatus(); })}
                    style={{ ...btnStyle, justifySelf: "start" }}
                  >
                    {zh ? "刷新二维码" : "Refresh QR"}
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(qrUrl).then(
                        () => setNotice(zh ? "绑定链接已复制" : "Link copied"),
                        () => setNotice(qrUrl),
                      );
                    }}
                    style={{ ...btnStyle, justifySelf: "start" }}
                  >
                    {zh ? "复制绑定链接" : "Copy link"}
                  </button>
                  <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", wordBreak: "break-all" }}>{qrUrl}</div>
                </div>
              </>
            ) : (
              <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                {zh ? "正在获取二维码…" : "Fetching QR…"}
              </div>
            )}
          </div>
        )}

        {/* 配对码 */}
        {status.state === "need_verify_code" && (
          <div style={{ marginTop: 10, display: "grid", gap: 8, maxWidth: 360 }}>
            <div style={{ fontSize: 'var(--fs-sm)' }}>
              {zh
                ? "手机微信上会显示一组数字配对码（也可能已显示）："
                : "Your phone shows a numeric pairing code (or already did):"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/[^0-9]/g, ""))}
                placeholder={zh ? "输入配对码" : "Enter code"}
                style={{ ...inputStyle, flex: 1, letterSpacing: 2 }}
              />
              <button
                disabled={busy || !verifyCode}
                onClick={() => act(async () => {
                  await tauriInvoke("ilink_login_submit_verify", { code: verifyCode });
                  setVerifyCode("");
                })}
                style={{ ...btnStyle, background: "var(--accent)", color: "var(--text-on-accent)" }}
              >
                {zh ? "提交" : "Submit"}
              </button>
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
              {zh ? "码错误会被提示重新输入；多次错误会暂时受限并自动刷新二维码。" : "Wrong codes are rejected; repeated failures refresh the QR."}
            </div>
          </div>
        )}

        {/* 已连接 → 断开/重登 */}
        {connected && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              disabled={busy}
              onClick={() => act(async () => { setNotice(""); await tauriInvoke("ilink_logout"); })}
              style={btnStyle}
            >
              {zh ? "断开" : "Logout"}
            </button>
            <button
              disabled={busy}
              onClick={() => act(async () => { await tauriInvoke("ilink_start_login"); })}
              style={btnStyle}
            >
              {zh ? "重新扫码（换 24h token）" : "Re-scan (new 24h token)"}
            </button>
          </div>
        )}
      </div>

      {/* ---- 主开关 ---- */}
      <div className="setting-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => { const v = e.target.checked; setEnabled(v); saveSettings({ enabled: v }); }}
            style={{ accentColor: "var(--accent)" }}
          />
          {zh ? "启用微信桥（响应微信消息）" : "Enable WeChat bridge (respond to messages)"}
        </label>
        {!enabled && (
          <div style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 4 }}>
            {zh ? "已停用：微信消息不会被处理，也不会回复（含白名单账号）。可随时在此重新开启。" : "Disabled: inbound messages are ignored entirely. Re-enable anytime."}
          </div>
        )}
      </div>

      {/* ---- 默认设置 ---- */}
      <div className="setting-group">
        <label>{zh ? "默认模型（空 = 引擎默认）" : "Default model (empty = engine default)"}</label>
        <input
          value={model}
          onChange={(e) => { setModel(e.target.value); saveSettings({ model: e.target.value }); }}
          placeholder={zh ? "如 gpt-5（微信内可用 /model 切换）" : "e.g. gpt-5 (/model in chat)"}
          style={{ ...inputStyle, width: "100%" }}
        />
      </div>
      <div className="setting-group">
        <label>{zh ? "默认工作区目录（空 = 应用默认工作区）" : "Default workspace dir (empty = app workspace)"}</label>
        <input
          value={workspace}
          onChange={(e) => { setWorkspace(e.target.value); saveSettings({ workspacePath: e.target.value }); }}
          placeholder={zh ? "如 D:/codem-workspace（微信内可用 /attach <目录> 切换）" : "e.g. D:/codem-workspace (/attach <dir> in chat)"}
          style={{ ...inputStyle, width: "100%" }}
        />
      </div>

      {/* ---- 准入管理 ---- */}
      <div className="setting-group">
        <label>{zh ? "准入管理（Bot 主人自动放行）" : "Access control (owner auto-approved)"}</label>

        {access.pending.length > 0 && (
          <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: "var(--warning)" }}>
              {zh ? `待批准（${access.pending.length}）：首次发消息即可触发 Agent，请审慎` : `Pending (${access.pending.length}):`}
            </div>
            {access.pending.map((p) => (
              <div key={p.peer} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "var(--bg-secondary)", border: "1px solid var(--border-primary)", borderRadius: 8, padding: "6px 10px" }}>
                <div style={{ fontSize: 'var(--fs-xs)', flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 600 }}>{p.peer}</div>
                  <div style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>{p.text}</div>
                </div>
                <button onClick={() => act(async () => { approvePendingPeer(p.peer); refreshAccess(); setNotice(zh ? "已批准" : "Approved"); })} style={{ ...miniBtn, color: "var(--success)", borderColor: "color-mix(in srgb, #22c55e 50%, transparent)" }}>
                  {zh ? "批准" : "Allow"}
                </button>
                <button onClick={() => act(async () => { ignorePeer(p.peer); refreshAccess(); })} style={{ ...miniBtn, color: "var(--error)", borderColor: "color-mix(in srgb, #ef4444 50%, transparent)" }}>
                  {zh ? "拉黑" : "Block"}
                </button>
              </div>
            ))}
          </div>
        )}

        {access.allow.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600 }}>{zh ? "白名单" : "Allowlist"}</div>
            {access.allow.map((p) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 'var(--fs-xs)', flex: 1 }}>{p}</span>
                <button onClick={() => act(async () => { ignorePeer(p); refreshAccess(); })} style={{ ...miniBtn, color: "var(--error)" }}>
                  {zh ? "移除" : "Remove"}
                </button>
              </div>
            ))}
          </div>
        )}

        {access.block.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 'var(--fs-xs)', fontWeight: 600, color: "var(--error)" }}>{zh ? "黑名单" : "Blocklist"}</div>
            {access.block.map((p) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span style={{ fontSize: 'var(--fs-xs)', flex: 1, textDecoration: "line-through" }}>{p}</span>
                <button onClick={() => act(async () => { const a = { ...loadAccess(), block: loadAccess().block.filter((x) => x !== p) }; saveAccess(a); refreshAccess(); })} style={{ ...miniBtn, color: "var(--success)" }}>
                  {zh ? "解除" : "Unblock"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <input
            value={newPeer}
            onChange={(e) => setNewPeer(e.target.value)}
            placeholder={zh ? "手动添加白名单 peer（xxx@im.wechat）" : "Manually allow peer (xxx@im.wechat)"}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={() => act(async () => { allowPeerByInput(newPeer); setNewPeer(""); refreshAccess(); setNotice(zh ? "已添加" : "Added"); })}
            style={btnStyle}
          >
            {zh ? "添加" : "Add"}
          </button>
        </div>
      </div>

      {/* ---- 合规提示 ---- */}
      <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", lineHeight: 1.7, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
        {zh
          ? "须知：① 绑定 token 约 24h 过期，需重新扫码；② 主动消息约 10 条/24h 配额（含回复），为社区实测、非官方承诺，本端按真实发送记账；③ 请勿用于垃圾/营销消息——可能触发腾讯限制；④ 图片/文件/语音等媒体暂不支持（二期）；⑤ 群消息不支持。关闭请到插件管理器禁用 @codem/wechat-bridge。"
          : "Notes: ① binding token expires ~24h (re-scan needed); ② ~10 proactive msgs/24h incl. replies (community-measured, not official — soft accounting here); ③ no spam/marketing — may trigger Tencent limits; ④ media (image/file/voice) unsupported (phase 2); ⑤ group chat unsupported. Disable via Plugin Manager (@codem/wechat-bridge)."}
      </div>
    </div>
  );
}

// 轻量样式（与 ComputerUseSettings 一致的内联风格）
const btnStyle: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  background: "var(--bg-secondary)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", fontSize: 'var(--fs-sm)',
};
const miniBtn: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 6, cursor: "pointer", fontSize: 'var(--fs-xs)',
  background: "transparent", border: "1px solid var(--border-color)",
};
const inputStyle: React.CSSProperties = {
  padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", borderRadius: 6,
  fontSize: 'var(--fs-sm)', boxSizing: "border-box",
};
