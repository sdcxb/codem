/**
 * PhoneLinkSettings — 手机连接设置卡（① dsh-phone 对标）
 *
 * - LAN 服务启停（OS 随机端口）+ 配对二维码/链接（token 5min 轮换）
 * - 配对等待 → 批准/拒绝（对标 EAC phone-bridge decide）
 * - 已配对设备列表（secret sha256 落盘，重启保配对）+ 解除
 * - autoStart（启动自动开启）；合规提示（同一 Wi-Fi / 防火墙 / http 明文 / 能力范围）
 *
 * 事件订阅：桥（startPhoneLink）把 Rust phone-* 事件转成 window CustomEvent
 * （EVT_STATE/EVT_PAIRED）；组件另每 3s 轮询 phone_status 兜底（等待态变化来源手机侧）。
 */
import { useState, useEffect, useCallback } from "react";
import { useLang } from "../core/i18n/lang";
import qrcode from "qrcode-generator";
import {
  getPhoneStateCache,
  normalizeState,
  EVT_STATE,
  EVT_PAIRED,
  getPhoneSettings,
  savePhoneSettings,
  type PhoneStateView,
} from "../core/phone-link/phone-link";

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const { invoke } = (window as any).__TAURI__?.core || {};
  if (!invoke) throw new Error("not in tauri");
  return invoke(cmd, args);
}

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
  if (!svg) return <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>二维码渲染失败，请复制链接</div>;
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

const btnStyle: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  background: "var(--bg-secondary)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", fontSize: 'var(--fs-sm)',
};
const inputStyle: React.CSSProperties = {
  padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", borderRadius: 6, fontSize: 'var(--fs-sm)', boxSizing: "border-box",
};

export function PhoneLinkSettings() {
  const lang = useLang();
  const zh = lang === "zh";
  const [status, setStatus] = useState<PhoneStateView>(() => getPhoneStateCache());
  const [autoStart, setAutoStart] = useState(() => getPhoneSettings().autoStart !== false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const raw = await tauriInvoke("phone_status");
      setStatus(normalizeState(raw));
    } catch { /* 非 tauri */ }
  }, []);

  useEffect(() => {
    const on = (name: string, h: (e: any) => void) => {
      window.addEventListener(name, h as EventListener);
      return () => window.removeEventListener(name, h as EventListener);
    };
    const offs = [
      on(EVT_STATE, (e) => setStatus(e.detail as PhoneStateView)),
      on(EVT_PAIRED, () => refresh()),
    ];
    refresh();
    const timer = setInterval(refresh, 3000); // 等待态/过期兜底
    return () => {
      offs.forEach((f) => f());
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = useCallback(async (fn: () => Promise<any>) => {
    setBusy(true);
    setNotice("");
    try {
      const r = await fn();
      if (r && typeof r === "object" && !Array.isArray(r)) setStatus(normalizeState(r));
      return r;
    } catch (e: any) {
      setNotice(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, []);

  const pairUrl = status.pair_url || "";
  const pairingWaiting = !!status.pairing?.active && !status.pairing?.decided;
  const pairing = status.pairing;
  const leftSec = pairing?.active && pairing.expires_at_ms
    ? Math.max(0, Math.round((pairing.expires_at_ms - Date.now()) / 1000))
    : 0;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>
        {zh ? "连接手机（LAN）" : "Phone Link (LAN)"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7 }}>
        {zh
          ? "把桌面端 Codem 变成手机可访问的会话助手（对标 dsh-phone）：手机在同一 Wi-Fi 下扫码配对后，可浏览全部会话、继续桌面对话、发起新对话（真机执行在桌面端）。数据由桌面引擎提供，不编造。"
          : "Expose this desktop Codem to your phone on the same LAN (dsh-phone parity): after QR pairing you can browse sessions, continue desktop chats and start new ones (execution happens here on desktop)."}
      </div>

      {/* ---- 服务启停 + 状态 ---- */}
      <div className="setting-group">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              padding: "3px 10px", borderRadius: 999, fontSize: 'var(--fs-xs)', fontWeight: 600,
              background: status.running ? "color-mix(in srgb, var(--success) 18%, transparent)" : "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: status.running ? "var(--success)" : "var(--text-primary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            {status.running ? (zh ? "监听中" : "Running") : (zh ? "未启动" : "Stopped")}
          </span>
          {status.running && status.port > 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
              {zh ? `http://${status.lan_ip}:${status.port} · 已配对设备 ${status.devices.length}` : `http://${status.lan_ip}:${status.port} · devices ${status.devices.length}`}
            </span>
          )}
        </div>
        {notice && <div style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6 }}>{notice}</div>}

        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!status.running ? (
            <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_start"))}
              style={{ ...btnStyle, background: "var(--accent)", color: "var(--text-on-accent)", fontWeight: 600 }}>
              {zh ? "开始配对（启动 LAN 服务）" : "Start pairing (start LAN)"}
            </button>
          ) : (
            <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_stop"))} style={btnStyle}>
              {zh ? "停止服务" : "Stop"}
            </button>
          )}
          {status.running && (
            <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_start"))} style={btnStyle}>
              {zh ? "刷新配对二维码" : "Rotate pairing QR"}
            </button>
          )}
        </div>
      </div>

      {/* ---- 配对区 ---- */}
      {status.running && pairUrl && (
        <div className="setting-group">
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <QrSvg text={pairUrl} />
            <div style={{ display: "grid", gap: 6, maxWidth: 340 }}>
              <div style={{ fontSize: 'var(--fs-sm)' }}>
                {pairingWaiting
                  ? (zh ? "手机浏览器扫一扫此二维码（或复制链接发给手机）" : "Scan with phone browser (or copy the link to your phone)")
                  : (zh ? "手机浏览器扫一扫以配对（新二维码可随时刷新）" : "Scan with a phone browser to pair")}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", wordBreak: "break-all" }}>{pairUrl}</div>
              <button onClick={() => navigator.clipboard?.writeText(pairUrl).then(() => setNotice(zh ? "链接已复制" : "Copied"))} style={{ ...btnStyle, justifySelf: "start" }}>
                {zh ? "复制配对链接" : "Copy pairing link"}
              </button>

              {pairingWaiting && (
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: "var(--warning)" }}>
                    {zh ? `有手机等待配对（${leftSec}s 内有效）…` : `A phone is waiting (${leftSec}s)…`}
                  </span>
                  <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_decide", { approved: true }))}
                    style={{ ...btnStyle, color: "var(--success)", borderColor: "color-mix(in srgb, #22c55e 50%, transparent)" }}>
                    {zh ? "批准" : "Allow"}
                  </button>
                  <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_decide", { approved: false }))}
                    style={{ ...btnStyle, color: "var(--error)", borderColor: "color-mix(in srgb, #ef4444 50%, transparent)" }}>
                    {zh ? "拒绝" : "Deny"}
                  </button>
                </div>
              )}
              {!pairingWaiting && pairing?.decided === true && (
                <div style={{ fontSize: 'var(--fs-xs)', color: "var(--success)" }}>
                  {zh ? "配对已完成（手机端将自动进入）" : "Paired — the phone will enter automatically"}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---- 已配对设备 ---- */}
      {status.devices.length > 0 && (
        <div className="setting-group">
          <label>{zh ? "已配对设备（重启保持；secret 仅存 sha256）" : "Paired devices (persist across restarts; secret stored hashed)"}</label>
          {status.devices.map((d) => (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 'var(--fs-xs)', flex: 1 }}>
                {d.ip || "(ip 未知)"}
                <span style={{ color: "var(--text-muted)" }}>
                  {" "}· {new Date(d.paired_at_ms).toLocaleString()}
                  {d.last_seen_ms ? ` · 最近 ${new Date(d.last_seen_ms).toLocaleTimeString()}` : ""}
                </span>
              </span>
              <button onClick={() => act(() => tauriInvoke("phone_unpair", { deviceId: d.id }))}
                style={{ ...btnStyle, color: "var(--error)" }}>
                {zh ? "解除" : "Unpair"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ---- 设置 ---- */}
      <div className="setting-group">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={autoStart}
            onChange={(e) => { const v = e.target.checked; setAutoStart(v); savePhoneSettings({ autoStart: v }); }}
            style={{ accentColor: "var(--accent)" }} />
          {zh ? "启动应用时自动开启 LAN 服务" : "Auto-start LAN service on app launch"}
        </label>
      </div>

      {/* ---- 合规 ---- */}
      <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", lineHeight: 1.7, borderTop: "1px solid var(--border-primary)", paddingTop: 8 }}>
        {zh
          ? "须知：① 需手机与电脑在同一 Wi-Fi（可能被防火墙拦截，需放行随机端口）；② 本服务为明文 HTTP（含 cookie 会话），请仅在可信网络使用，配对应在桌面端手动批准；③ 配对 token 5 分钟有效，设备 secret 以 sha256 哈希落盘（app-data/phone/devices.json）；④ 手机端可浏览/续聊/新建会话——等于把桌面 agent 能力暴露给配对设备，请勿把二维码发给他人；⑤ 本服务随桌面应用运行（引擎在桌面端），关闭应用即不可用；⑥ 关闭可在插件管理器禁用 @codem/phone-link。"
          : "Notes: ① phone must be on the same Wi-Fi (allow the random port in firewall); ② plain HTTP with cookie auth — trusted networks only; approve pairing on desktop; ③ token valid 5 min; device secrets stored as sha256 (app-data/phone/devices.json); ④ paired device can browse/continue/create sessions = full agent access — never share the QR; ⑤ service runs with the desktop app; ⑥ disable via Plugin Manager (@codem/phone-link)."}
      </div>
    </div>
  );
}
