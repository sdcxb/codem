/**
 * 桌面远程网关（ADR-0005）设置卡 —— M2：读 + 写 + 审批 + 事件流。
 *
 * M4 起这是**PC 远程唯一入口**：手机浏览器连的是桌面自己的项目/会话/历史，
 * 数据由桌面 WebView 回答，网关不建库。桌面 Host sidecar 已退役，这里不再有
 * “第二套连电脑”的地址/配对码入口。
 *
 * 配对码只在内存里（React state），不写 localStorage、不 console、不拼 URL。
 * 网关停止后 Rust 会清空配对状态，所以停止也等于撤销所有已配对设备。
 */
import { useCallback, useEffect, useState } from "react";
import { showToast } from "./ToastNotification";

interface GatewayStatus {
  running: boolean;
  port: number;
  url: string | null;
  pairedDevices: number;
}

interface PairCode {
  code: string;
  expiresAt: number;
  ttlMs: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = (window as any).__TAURI__?.core?.invoke;
  if (!fn) throw new Error("not in tauri");
  return fn(cmd, args) as Promise<T>;
}

function grouped(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function countdown(expiresAt: number, now: number): string {
  const remain = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")}`;
}

export function RemoteGatewaySection({ zh }: { zh: boolean }): React.ReactElement {
  const [status, setStatus] = useState<GatewayStatus>({
    running: false,
    port: 0,
    url: null,
    pairedDevices: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<GatewayStatus>("gateway_status"));
      setError("");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!status.running) setPairCode(null);
  }, [status.running]);

  useEffect(() => {
    if (!pairCode) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairCode]);

  useEffect(() => {
    if (pairCode && now >= pairCode.expiresAt) setPairCode(null);
  }, [now, pairCode]);

  async function start(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      setStatus(await invoke<GatewayStatus>("gateway_start"));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    setBusy(true);
    setError("");
    // 停止会清空 Rust 内存里的配对状态：界面上不能继续显示旧码/旧设备数。
    setPairCode(null);
    try {
      setStatus(await invoke<GatewayStatus>("gateway_stop"));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function newPairCode(): Promise<void> {
    setPairBusy(true);
    setError("");
    try {
      const got = await invoke<PairCode>("gateway_pair_start");
      setPairCode(got);
      setNow(Date.now());
      await refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setPairBusy(false);
    }
  }

  const url = status.url ?? "";
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 600 }}>
          {zh ? "桌面远程网关（PC 远程唯一入口）" : "Desktop gateway (the only PC remote entry)"}
        </div>
        <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
          {status.running ? (zh ? "运行中" : "Running") : zh ? "已停止" : "Stopped"}
        </span>
      </div>
      <div style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", lineHeight: 1.7 }}>
        {zh
          ? "手机/浏览器连的是这台电脑的桌面数据：项目、会话、历史都来自桌面现有存储，不另建库。可以在已有会话里发送消息、回答审批、停止运行、查看文件与变更；暂不支持在手机上新建会话或上传附件。网关不会自动启动。"
          : "Phones/browsers reach this PC's desktop data: projects, sessions and history come from the existing desktop storage, not a second database. Send messages in existing sessions, answer approvals, stop runs, and view files/changes; creating sessions or uploading attachments from the phone is not supported yet. The gateway does not start automatically."}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {status.running ? (
          <button data-testid="gateway-stop" disabled={busy} onClick={() => void stop()}>
            {zh ? "停止网关" : "Stop gateway"}
          </button>
        ) : (
          <button data-testid="gateway-start" disabled={busy} onClick={() => void start()}>
            {zh ? "启动网关" : "Start gateway"}
          </button>
        )}
        {status.running ? (
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-muted)", alignSelf: "center" }}>
            {zh ? `已配对设备：${status.pairedDevices}` : `Paired devices: ${status.pairedDevices}`}
          </span>
        ) : null}
      </div>

      {status.running && url ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-sm)", flexWrap: "wrap" }}>
            <code data-testid="gateway-url" style={{ padding: "2px 6px" }}>{url}</code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                showToast("info", zh ? "地址已复制" : "Address copied", 2500);
              }}
            >
              {zh ? "复制" : "Copy"}
            </button>
          </div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.7 }}>
            {zh ? (
              <>
                只绑 127.0.0.1。Android 模拟器/真机可先执行{" "}
                <code>{`adb reverse tcp:${status.port} tcp:${status.port}`}</code>，再用手机浏览器打开上面的地址。
                真机不接 USB 时需要 Tailscale/Cloudflare 等隧道。
              </>
            ) : (
              <>
                Loopback only. For an Android emulator/device run{" "}
                <code>{`adb reverse tcp:${status.port} tcp:${status.port}`}</code>, then open the URL above in the
                phone browser. A physical device without USB needs a tunnel such as Tailscale/Cloudflare.
              </>
            )}
          </div>
        </div>
      ) : null}

      {status.running ? (
        <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border-primary)", paddingTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button data-testid="gateway-pair-generate" disabled={pairBusy} onClick={() => void newPairCode()}>
              {zh ? "生成配对码" : "Generate pairing code"}
            </button>
            {pairCode ? (
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <code data-testid="gateway-pair-code" style={{ fontSize: "var(--fs-lg, 18px)", letterSpacing: 2 }}>
                  {grouped(pairCode.code)}
                </code>
                <span style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
                  {zh ? `剩余 ${countdown(pairCode.expiresAt, now)}` : `expires in ${countdown(pairCode.expiresAt, now)}`}
                </span>
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)", lineHeight: 1.6 }}>
            {zh
              ? "手机第一次打开页面会要求 6 位配对码。配对码 5 分钟内有效、只能用一次；配对成功后浏览器拿到的 HttpOnly cookie 在停止网关或桌面进程重启后失效，需要重新配对。"
              : "The phone asks for a 6-digit code on first open. It is valid for 5 minutes and single use. The HttpOnly cookie expires when the gateway stops or the desktop process restarts, so pair again after a restart."}
          </div>
        </div>
      ) : null}

      {error ? <div style={{ fontSize: "var(--fs-sm)", color: "var(--error, #c33)" }}>{error}</div> : null}
    </div>
  );
}
