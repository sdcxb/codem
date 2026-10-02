/**
 * 「手机远程」—— Agents Anywhere 登录入口（阶段 N1–N3）。
 *
 * ## 为什么单独一个组件
 *
 * 用户口径是**简单**：这一屏只做三件事 —— 选服务器、填账号密码、点连接。
 * 把它做成独立组件，是为了不把那些机制（PKCE、回环监听、connector 协议）
 * 混进已有的 LAN 面板里 —— 那些东西用户不需要知道。
 *
 * ## 默认连它的云（与 DSH 一致）
 *
 * `AA 默认 = https://web.agents-anywhere.com`（它的 `CLOUD_API_BASE_URL`）。
 * 所以默认**不填任何地址**就能用；"自建服务器"是一个可选开关。
 */
import { useState, useEffect, useCallback } from "react";

async function invokeCmd(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const w = window as any;
  if (!w.__TAURI__?.core?.invoke) throw new Error("no tauri");
  return w.__TAURI__.core.invoke(cmd, args);
}

interface AcctView {
  serverUrl?: string;
  signedIn?: boolean;
  tokenValid?: boolean;
  profile?: { userId?: string; displayName?: string; email?: string } | null;
  deviceId?: string | null;
  hasDeviceToken?: boolean;
}

interface ConnView {
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
  credentialsRevoked?: boolean;
  requestsServed?: number;
}

export function AaRemoteSection({ zh }: { zh: boolean }) {
  const [acct, setAcct] = useState<AcctView>({});
  const [conn, setConn] = useState<ConnView>({});
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const a = await invokeCmd("aa_account_status");
      setAcct(a || {});
      if (a?.serverUrl && a.serverUrl !== "https://web.agents-anywhere.com") {
        setCustom(true);
        setUrl((u) => u || String(a.serverUrl));
      }
      const c = await invokeCmd("aa_connector_status");
      setConn(c || {});
    } catch {
      /* 不在 Tauri 里（浏览器预览）：保持空态，不报错打扰 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      // 服务端的话**原样显示**（它比我们编的准确：密码错 / 未验证 / token 无效是三件事）
      setErr(typeof e === "string" ? e : e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const doLogin = (register: boolean) =>
    act(async () => {
      await invokeCmd("aa_account_login", {
        serverUrl: custom ? url.trim() : null,
        email: email.trim(),
        password,
        register,
        setupToken: setupToken.trim() || null,
      });
      setMsg(register ? (zh ? "已注册并登录" : "Registered and signed in") : (zh ? "已登录" : "Signed in"));
    });

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "7px 10px", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
    color: "var(--text-primary)", fontSize: 'var(--fs-sm)',
  };
  const btnStyle: React.CSSProperties = {
    padding: "7px 14px", borderRadius: "var(--radius-sm)",
    border: "1px solid var(--border-primary)", background: "var(--bg-secondary)",
    color: "var(--text-primary)", fontSize: 'var(--fs-sm)', cursor: busy ? "default" : "pointer",
  };

  // 状态一行说清：优先报"连上了没有"，其次"登录了没有"
  const phase = conn.credentialsRevoked
    ? (zh ? "凭据失效，请重新登录" : "Credentials revoked — sign in again")
    : conn.connected
      ? (zh ? "已连接" : "Connected")
      : conn.running
        ? (zh ? "正在连接…" : "Connecting…")
        : acct.signedIn
          ? (zh ? "已登录，未连接" : "Signed in, not connected")
          : (zh ? "未登录" : "Not signed in");

  return (
    <div className="setting-group" data-testid="aa-remote">
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 600, marginBottom: 6 }}>
        {zh ? "手机远程（Agents Anywhere）" : "Phone remote (Agents Anywhere)"}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", lineHeight: 1.7, marginBottom: 10 }}>
        {zh
          ? "登录 Agents Anywhere 后，这台电脑会注册成一台设备；手机用同一个账号登录官方 App/网页就能看到并操作它的会话。默认用官方服务，也可以填自己的服务器。"
          : "Sign in to Agents Anywhere and this computer registers as a device; sign in with the same account on your phone (official app/web) to see and drive its sessions. Official service by default; you can point it at your own server."}
      </div>

      {/* 状态 */}
      <div data-testid="aa-phase" data-connected={conn.connected ? "1" : "0"} data-running={conn.running ? "1" : "0"}
        style={{ fontSize: 'var(--fs-sm)', marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{phase}</span>
        {acct.profile?.displayName || acct.profile?.email ? (
          <span style={{ color: "var(--text-muted)" }}>
            {"　"}{acct.profile.displayName || acct.profile.email}
          </span>
        ) : null}
        {conn.requestsServed ? (
          <span style={{ color: "var(--text-muted)" }}>{"　"}{zh ? `已服务 ${conn.requestsServed} 次` : `${conn.requestsServed} served`}</span>
        ) : null}
      </div>
      {conn.lastError && !conn.connected ? (
        <div data-testid="aa-error" style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginBottom: 8, wordBreak: "break-all" }}>
          {conn.lastError}
        </div>
      ) : null}

      {/* 服务器：默认官方，可切自建 */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, fontSize: 'var(--fs-sm)' }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" name="aa-server" checked={!custom} onChange={() => setCustom(false)} />
          {zh ? "官方服务（默认）" : "Official (default)"}
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
          <input type="radio" name="aa-server" checked={custom} onChange={() => setCustom(true)} />
          {zh ? "自建服务器" : "Own server"}
        </label>
      </div>
      {custom && (
        <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
          <input data-testid="aa-url" style={inputStyle} placeholder={zh ? "服务器地址，例如 https://my-server.com" : "Server URL, e.g. https://my-server.com"}
            value={url} onChange={(e) => setUrl(e.target.value)} />
          <input data-testid="aa-setup-token" style={inputStyle} placeholder={zh ? "首次安装令牌（服务端日志里的 setup-token，可留空）" : "First-run setup token (from server log; optional)"}
            value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
        </div>
      )}

      {/* 账号 */}
      <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
        <input data-testid="aa-email" style={inputStyle} placeholder={zh ? "邮箱" : "Email"} value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <input data-testid="aa-password" style={inputStyle} type="password" placeholder={zh ? "密码" : "Password"} value={password}
          onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </div>

      {/* 动作 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!acct.signedIn ? (
          <>
            <button data-testid="aa-login" style={btnStyle} disabled={busy || !email.trim() || !password}
              onClick={() => doLogin(false)}>{zh ? "登录" : "Sign in"}</button>
            <button data-testid="aa-register" style={btnStyle} disabled={busy || !email.trim() || !password}
              onClick={() => doLogin(true)}>{zh ? "注册并登录" : "Register & sign in"}</button>
          </>
        ) : (
          <>
            <button data-testid="aa-connect" style={btnStyle} disabled={busy || Boolean(conn.connected)}
              onClick={() => act(async () => {
                await invokeCmd("aa_connect", {});
                setMsg(zh ? "已连接" : "Connected");
              })}>{conn.connected ? (zh ? "已连接" : "Connected") : (zh ? "连接" : "Connect")}</button>
            <button data-testid="aa-disconnect" style={btnStyle} disabled={busy}
              onClick={() => act(async () => { await invokeCmd("aa_connector_stop"); })}>
              {zh ? "断开" : "Disconnect"}
            </button>
            <button data-testid="aa-logout" style={btnStyle} disabled={busy}
              onClick={() => act(async () => { await invokeCmd("aa_account_logout"); setPassword(""); })}>
              {zh ? "退出登录" : "Sign out"}
            </button>
          </>
        )}
      </div>

      {msg && <div style={{ fontSize: 'var(--fs-xs)', color: "var(--success)", marginTop: 6 }}>{msg}</div>}
      {err && <div data-testid="aa-login-error" style={{ fontSize: 'var(--fs-xs)', color: "var(--error)", marginTop: 6, wordBreak: "break-all" }}>{err}</div>}
    </div>
  );
}
