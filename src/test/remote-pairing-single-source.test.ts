/**
 * 配对单一来源判据（PAIR-1..PAIR-4）。
 *
 * 旧 phone-link 的 LAN 扫码配对（二维码 / 批准 / 设备列表 / cookie / 自签 CA /
 * 0.0.0.0 TLS / 中继）已删除。ADR-0005 M4 之后，**PC 远程只有一条用户可见路径**：
 * 桌面网关的 6 位一次性配对码（`gateway_pair_start` / Rust `phone::gateway`）。
 * 手机本机模式属于 Android 自己的 Host（`packages/host`），不在桌面设置里配置，
 * 也不再提供第二个“连电脑”的地址/配对码入口。
 *
 * 这组判据守三件事：
 * 1. 设置页只出现桌面网关 + AA，旧配对入口和桌面 Host sidecar 都不得回来；
 * 2. 后台没有第二条 pair/token 发放路径（旧命令、cookie 名、pair URL、TLS 边缘）；
 * 3. 桌面不再注册/启动 Host sidecar 命令。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(relDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, relDir))) {
    const rel = `${relDir}/${name}`;
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

/** 去掉注释，避免历史说明里的旧标识把判据误判成"代码还在"。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const PROD_TS = walk("src").filter(
  (p) => !p.startsWith("src/test/") && /\.(ts|tsx)$/.test(p),
);

const RUST_CODE = [
  "src-tauri/src/phone/mod.rs",
  "src-tauri/src/phone/guard.rs",
  "src-tauri/src/phone/http.rs",
  "src-tauri/src/phone/aa_connector.rs",
  "src-tauri/src/lib.rs",
].map((p) => stripComments(read(p))).join("\n");

describe("配对单一来源", () => {
  it("PAIR-1: 设置页只渲染桌面网关 + AA，没有第二个“连电脑”入口", () => {
    const panel = read("src/components/SettingsPanel.tsx");
    expect(panel).toContain("RemoteAccessSettings");
    expect(panel).not.toContain("PhoneLinkSettings");
    expect(panel).not.toContain("RemoteHostSection");

    const card = read("src/components/RemoteAccessSettings.tsx");
    expect(card).toContain("<RemoteGatewaySection");
    expect(card).toContain("<AaRemoteSection");
    expect(card).not.toContain("RemoteHostSection");
    expect(card, "旧二维码/配对链接/旧命令不得回到设置卡").not.toMatch(
      /qrcode|pair_url|phone_start|phone_stop|phone_decide|phone_unpair|phone_ca_|phone_relay/,
    );

    // 桌面不再自启/同步 Host sidecar（M4）
    expect(read("src/main.tsx")).not.toContain("bootstrapRemoteHost");
    expect(read("src/App.tsx")).not.toContain("syncRemoteHostWorkspace");
  });

  it("PAIR-2: 旧配对实现文件与桌面 Host sidecar 已删除（不是只删入口）", () => {
    for (const rel of [
      "src/components/PhoneLinkSettings.tsx",
      "src/core/phone-link",
      "src/core/provider/phone-link-provider.ts",
      "src-tauri/src/phone/tls.rs",
      "src-tauri/src/phone/lan.rs",
      "src-tauri/src/phone/edge_test.rs",
      "src-tauri/src/phone/connector.rs",
      "src-tauri/src/phone/ui/app.html",
      "src-tauri/src/phone/ui/pair.html",
      "tools/relay/codem-relay.mjs",
      // M4：桌面 Host sidecar 整块退役
      "src/components/RemoteHostSection.tsx",
      "src/core/remote/host-bootstrap.ts",
      "src/core/remote/host-workspace.ts",
      "src-tauri/src/host_cmd.rs",
    ]) {
      expect(existsSync(join(ROOT, rel)), `${rel} 应已删除`).toBe(false);
    }
  });

  it("PAIR-3: 仓库没有第二条旧 pair/token 发放路径，桌面只注册网关", () => {
    const ts = PROD_TS.map((p) => stripComments(read(p))).join("\n");
    const all = `${ts}\n${RUST_CODE}`;
    for (const forbidden of [
      "codem_phone",
      "pair_url",
      "x-codem-edge",
      "phone_start",
      "phone_stop",
      "phone_status",
      "phone_decide",
      "phone_unpair",
      "phone_ca_pem",
      "phone_ca_fingerprint",
      "phone_relay_start",
      "phone_relay_stop",
      "phone_relay_status",
    ]) {
      expect(all, `不得再出现旧配对路径标识 ${forbidden}`).not.toContain(forbidden);
    }

    // PC 远程只剩网关这一套配对命令；桌面 Host 的 6 条命令已随 sidecar 删除。
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).not.toContain("host_cmd");
    expect(lib).toContain("phone::gateway::gateway_pair_start");
    expect(lib).toContain("phone::remote_respond");
  });

  it("PAIR-4: 保留的桌面引擎桥只绑回环，且必须带每次运行的内部 token", () => {
    const mod = read("src-tauri/src/phone/mod.rs");
    expect(mod).toContain('TcpListener::bind("127.0.0.1:0")');
    expect(mod, "bridge 不得绑 0.0.0.0").not.toContain('TcpListener::bind("0.0.0.0');
    expect(mod).toContain("pub async fn start_bridge");
    expect(mod).toContain("pub async fn remote_respond");
    expect(mod).toContain('app.emit("remote-request"');
    expect(read("src-tauri/src/phone/guard.rs")).toContain("pub fn bridge_allowed");
  });
});
