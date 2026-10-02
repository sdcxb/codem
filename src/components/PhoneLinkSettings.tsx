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
import { useState, useEffect, useCallback, useRef } from "react";
import { useLang } from "../core/i18n/lang";
import qrcode from "qrcode-generator";
import {
  getPhoneStateCache, normalizeState,
  EVT_STATE,
  EVT_PAIRED,
  getPhoneSettings,
  savePhoneSettings,
  normalizeRelay,
  relayPhase,
  type PhoneStateView,
  type RelayStateView,
} from "../core/phone-link/phone-link";
/**
 * 阶段 4.3：桌面侧也要知道"谁正在看"。
 *
 * 审批是一张**共用**的表，所以桌面上那张卡片躺着时，用户应该能看到
 * "手机也在看" —— 否则他可能白等（以为只有自己能答），
 * 或者在手机上点完才发现桌面已经处理过了。
 *
 * 这里**直接读进程内状态**，不走 HTTP：桌面就是宿主，
 * 为了显示自己的状态去请求自己毫无意义（还多一次循环）。
 */
import { getPresence } from "../core/phone-link/presence";
// 阶段 N1–N3：Agents Anywhere 登录入口（默认官方服务、可填自建）
import { AaRemoteSection } from "./AaRemoteSection";

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
        width: 190, height: 190, background: "var(--text-on-accent)", borderRadius: "var(--radius-md)",
        padding: 6, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center",
      }}
    />
  );
}

const btnStyle: React.CSSProperties = {
  padding: "6px 12px", borderRadius: "var(--radius-sm)", cursor: "pointer",
  background: "var(--bg-secondary)", color: "var(--text-primary)",
  border: "1px solid var(--border-primary)", fontSize: 'var(--fs-sm)',
};
const inputStyle: React.CSSProperties = {
  padding: "6px 8px", background: "var(--bg-tertiary)", color: "var(--text-primary)",
  border: "1px solid var(--border-primary)", borderRadius: "var(--radius-sm)", fontSize: 'var(--fs-sm)', boxSizing: "border-box",
};

export function PhoneLinkSettings() {
  const lang = useLang();
  const zh = lang === "zh";
  const [status, setStatus] = useState<PhoneStateView>(() => getPhoneStateCache());
  const [autoStart, setAutoStart] = useState(() => getPhoneSettings().autoStart !== false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /**
   * 第 122 轮 §11D：出站 connector（远程中继）。
   *
   * 输入框的值**独立于** relay.serverUrl 保存：用户正在改地址时不该被
   * 每 2 秒一次的轮询覆盖回去（那是"输入框自己跳字"的经典成因）。
   * 判断"用户有没有动过"用的是 **ref 而不是 state**：它是在异步回调里读的，
   * 用 state 会读到闭包里的旧值。只用一处真相，不要既存 state 又存 ref。
   */
  const [relay, setRelay] = useState<RelayStateView>(() => normalizeRelay(null));
  const [relayUrl, setRelayUrl] = useState("");
  const relayTouchedRef = useRef(false);

  const refreshRelay = useCallback(async () => {
    try {
      const raw = await tauriInvoke("phone_relay_status");
      const next = normalizeRelay(raw);
      setRelay(next);
      // 用户没动过输入框 ⇒ 跟着服务端走（首次进页面能看到已配置的地址）
      setRelayUrl((cur) => (relayTouchedRef.current ? cur : next.serverUrl || cur));
    } catch { /* 非 tauri */ }
  }, []);

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
    refreshRelay();
    const timer = setInterval(refresh, 3000); // 等待态/过期兜底
    // 中继状态刷新得快一点：断线重连是 3 秒一次，界面要能跟上
    const relayTimer = setInterval(refreshRelay, 2000);
    return () => {
      offs.forEach((f) => f());
      clearInterval(timer);
      clearInterval(relayTimer);
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
  /**
   * 第 122 轮阶段 1：协议取 Rust 侧真值，**不拼字符串猜**。
   * 局域网侧现在只有 HTTPS（明文监听已从 LAN 撤掉），所以这里显示 https。
   */
  const scheme = status.https ? "https" : "http";
  const origin = `${scheme}://${status.lan_ip}:${status.port}`;
  const caUrl = status.ca_url || `${origin}/ca.crt`;
  const fingerprint = status.ca_fingerprint || "";
  /**
   * 阶段 4.3：在场（谁正在看）。
   *
   * 不需要额外的定时器：这个组件本来就有 3 秒一次的 `refresh`，
   * 而 `setStatus(新对象)` 每次都触发重渲染 —— 于是 `getPresence()`
   * 会跟着重算。它自己会清理过期项，所以"关掉手机页面后这里会自己消失"。
   */
  const presence = getPresence();
  // §11D：中继连接的阶段（互斥四态；没连上就绝不说"已连接"）
  // 颜色不在这里算 —— 交给 CSS 的 `.relay-phase[data-phase=...]`，
  // 这样"什么阶段什么颜色"是声明式的，不会漏掉一处。
  const rPhase = relayPhase(relay);
  const rLabel =
    rPhase === "connected"
      ? (zh ? "已连接" : "Connected")
      : rPhase === "connecting"
        ? (zh ? `正在连接（每 ${relay.reconnectSeconds} 秒重试）` : `Connecting (retry every ${relay.reconnectSeconds}s)`)
        : rPhase === "error"
          ? (zh ? "连接失败（正在重试）" : "Failed (retrying)")
          : (zh ? "未启用" : "Disabled");

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

      {/* 阶段 N1–N3：主路径 —— 登录 Agents Anywhere 就能用（与 DSH 一致） */}
      <AaRemoteSection zh={zh} />

      {/* ---- 服务启停 + 状态 ---- */}
      <div className="setting-group">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              padding: "3px 10px", borderRadius: "var(--radius-full)", fontSize: 'var(--fs-xs)', fontWeight: 600,
              background: status.running ? "color-mix(in srgb, var(--success) 18%, transparent)" : "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: status.running ? "var(--success)" : "var(--text-primary)",
              border: "1px solid var(--border-primary)",
            }}
          >
            {status.running ? (zh ? "监听中" : "Running") : (zh ? "未启动" : "Stopped")}
          </span>
          {status.running && status.port > 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
              {zh ? `${origin} · 已配对设备 ${status.devices.length}` : `${origin} · devices ${status.devices.length}`}
            </span>
          )}
        </div>
        {notice && <div style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6 }}>{notice}</div>}

        {/* 阶段 4.3：谁正在看（桌面自己永远在场，所以只列远端） */}
        <div className="relay-stats" data-testid="phone-presence" data-count={presence.remoteCount} style={{ marginTop: 6 }}>
          {presence.remoteCount === 0
            ? (zh ? "当前没有远端设备在查看" : "No remote device is viewing right now")
            : (zh
              ? `${presence.remoteCount} 台远端设备正在查看：${presence.remotes.map((r) => `${r.ip || r.deviceId}${r.sessionId ? `（会话 ${r.sessionId.slice(0, 12)}…）` : ""}`).join("、")}`
              : `${presence.remoteCount} remote device(s) viewing: ${presence.remotes.map((r) => r.ip || r.deviceId).join(", ")}`)}
        </div>

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

      {/* ---- 第 122 轮 §11D：远程中继（出站长连，手机在外网也能用）---- */}
      <div className="setting-group relay-card">
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
          {zh ? "远程中继（手机不在同一 Wi-Fi 时用这条）" : "Remote relay (use this when the phone is not on the same Wi-Fi)"}
        </div>
        <div className="relay-desc">
          {zh
            ? "这是一条**出站长连**：电脑主动连到你自己跑的中继，手机再连中继。电脑**不为此开任何局域网端口**（这与 DSH 的做法是同一条策略）。中继是一段零依赖的 Node 程序：在中继机器上运行 node tools/relay/codem-relay.mjs --port 8787 即可。公网部署请放在 HTTPS 反代之后，或用 --tls-cert/--tls-key 提供证书，否则流量是明文的。"
            : "This is an OUTBOUND long connection: the desktop dials out to a relay you run, and the phone talks to that relay. The desktop opens NO LAN port for this path (same strategy as DSH). The relay is a zero-dependency Node script: run node tools/relay/codem-relay.mjs --port 8787 on the relay machine. For public deployment put it behind an HTTPS reverse proxy or pass --tls-cert/--tls-key, otherwise traffic is plaintext."}
        </div>

        <div className="relay-row">
          <input
            data-testid="relay-url"
            className="relay-url"
            style={inputStyle}
            placeholder="https://relay.example.com"
            value={relayUrl}
            disabled={relay.running}
            onChange={(e) => {
              relayTouchedRef.current = true;
              setRelayUrl(e.target.value);
            }}
          />
          {!relay.running ? (
            <button
              data-testid="relay-start"
              disabled={busy || !relayUrl.trim()}
              onClick={() =>
                act(async () => {
                  await tauriInvoke("phone_relay_start", { serverUrl: relayUrl.trim() });
                  relayTouchedRef.current = false;
                  await refreshRelay();
                })
              }
              style={{ ...btnStyle, background: "var(--accent)", color: "var(--text-on-accent)", fontWeight: 600 }}
            >
              {zh ? "连接中继" : "Connect"}
            </button>
          ) : (
            <button
              data-testid="relay-stop"
              disabled={busy}
              onClick={() => act(async () => { await tauriInvoke("phone_relay_stop"); await refreshRelay(); })}
              style={btnStyle}
            >
              {zh ? "断开中继" : "Disconnect"}
            </button>
          )}
        </div>

        {/* 状态：**没连上就绝不显示"已连接"**（措辞与颜色都由 data-phase 驱动） */}
        <div className="relay-status">
          <span data-testid="relay-phase" className="relay-phase" data-phase={rPhase}>
            {rLabel}
          </span>
          {relay.connectorId && (
            <span className="relay-id">
              {zh ? "本机标识" : "device id"}：<code>{relay.connectorId}</code>
            </span>
          )}
        </div>
        {relay.running && (
          <div className="relay-stats">
            {zh
              ? `已服务 ${relay.requestsServed} 个请求 · 重连 ${relay.reconnects} 次 · 错误 ${relay.errors} 次`
              : `${relay.requestsServed} requests · ${relay.reconnects} reconnects · ${relay.errors} errors`}
          </div>
        )}
        {rPhase === "error" && relay.lastError && (
          <div data-testid="relay-error" className="relay-error">
            {zh ? "失败原因" : "Reason"}：{relay.lastError}
          </div>
        )}
      </div>

      {/* ---- 第 122 轮阶段 1：HTTPS 证书与指纹核对 ---- */}
      {status.running && (
        <div className="setting-group">
          <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 6 }}>
            {zh ? "① 先让手机信任这台电脑的证书" : "① First let your phone trust this computer"}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)", lineHeight: 1.8 }}>
            {zh
              ? "局域网走的是 HTTPS 自签证书。手机第一次访问会提示「不安全 / 证书无效」——这是自签证书的正常表现，选择继续即可。"
              : "LAN traffic uses a self-signed HTTPS certificate. The phone will warn about an invalid certificate on first visit — that is expected for a self-signed certificate; choose to continue."}
          </div>
          {fingerprint ? (
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: "var(--text-muted)" }}>
                {zh
                  ? "② 核对指纹（自签方案里**唯一**能挡住中间人的一步）：手机浏览器里展开证书详情，逐段比对下面这串。对不上就不要继续。"
                  : "② Verify the fingerprint (the ONLY step that defeats a man-in-the-middle with self-signed certs): expand the certificate details in the phone browser and compare segment by segment. If it differs, stop."}
              </div>
              <code
                data-testid="phone-ca-fingerprint"
                style={{
                  fontSize: 'var(--fs-xs)', wordBreak: "break-all", lineHeight: 1.7,
                  background: "var(--bg-secondary)", border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-sm)", padding: "8px 10px", display: "block",
                }}
              >
                {fingerprint}
              </code>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  style={btnStyle}
                  onClick={() => navigator.clipboard?.writeText(fingerprint).then(() => setNotice(zh ? "指纹已复制" : "Fingerprint copied"))}
                >
                  {zh ? "复制指纹" : "Copy fingerprint"}
                </button>
                <button
                  style={btnStyle}
                  onClick={() =>
                    act(async () => {
                      /**
                       * 存到用户选的位置：手机装证书最靠谱的路径是"把文件传过去"
                       * （USB / 隔空投送 / 网盘）—— 而不是让手机去下载一个
                       * 它此刻还不信任的 HTTPS 站点上的证书。
                       */
                      const pem = await tauriInvoke("phone_ca_pem");
                      if (!pem) throw new Error(zh ? "证书尚未就绪（先启动服务）" : "Certificate not ready (start the service first)");
                      const path = await tauriInvoke("dialog_save", {
                        title: zh ? "保存 Codem CA 证书" : "Save Codem CA certificate",
                        defaultPath: "codem-ca.crt",
                        filters: [{ name: "Certificate", extensions: ["crt", "pem"] }],
                      });
                      if (!path) return;
                      await tauriInvoke("write_text_file", { path, content: pem });
                      setNotice(zh ? `证书已保存到 ${path}` : `Saved to ${path}`);
                    })
                  }
                >
                  {zh ? "保存证书文件…" : "Save certificate…"}
                </button>
                <button
                  style={btnStyle}
                  onClick={() => navigator.clipboard?.writeText(caUrl).then(() => setNotice(zh ? "证书地址已复制" : "Certificate URL copied"))}
                >
                  {zh ? "复制证书地址" : "Copy certificate URL"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6 }}>
              {zh ? "拿不到证书指纹 —— 界面上没有可核对的信息，请不要在此状态下配对。" : "No certificate fingerprint available — do not pair in this state."}
            </div>
          )}
        </div>
      )}

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
                    style={{ ...btnStyle, color: "var(--success)", borderColor: "color-mix(in srgb, var(--success) 50%, transparent)" }}>
                    {zh ? "批准" : "Allow"}
                  </button>
                  <button disabled={busy} onClick={() => act(() => tauriInvoke("phone_decide", { approved: false }))}
                    style={{ ...btnStyle, color: "var(--error)", borderColor: "color-mix(in srgb, var(--error) 50%, transparent)" }}>
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
          ? "须知：① 需手机与电脑在同一 Wi-Fi（可能被防火墙拦截，需放行随机端口）；② 局域网走 HTTPS 自签证书 —— 首次访问浏览器会警告，这是自签证书的正常表现，**但请务必核对上面的指纹**；③ 配对 token 5 分钟有效，设备 secret 以 sha256 哈希落盘（app-data/phone/devices.json），会话 cookie 30 天有效、桌面端可随时取消配对；④ 手机端可浏览/续聊/新建会话，还能**代替你批准敏感操作**——等于把桌面 agent 能力暴露给配对设备，请勿把二维码发给他人；⑤ 本服务随桌面应用运行（引擎在桌面端），关闭应用即不可用；⑥ 关闭可在插件管理器禁用 @codem/phone-link。"
          : "Notes: ① phone must be on the same Wi-Fi (allow the random port in firewall); ② LAN uses a self-signed HTTPS certificate — the browser warns on first visit (expected for self-signed), but you MUST verify the fingerprint above; ③ pairing token valid 5 min; device secrets stored as sha256 (app-data/phone/devices.json); session cookie valid 30 days and can be revoked from the desktop at any time; ④ a paired device can browse/continue/create sessions and also APPROVE sensitive operations on your behalf = full agent access — never share the QR; ⑤ service runs with the desktop app; ⑥ disable via Plugin Manager (@codem/phone-link)."}
      </div>
    </div>
  );
}
