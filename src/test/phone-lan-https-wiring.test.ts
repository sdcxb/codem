/**
 * 第 122 轮阶段 1（安全对齐）**接线**判据 —— LNX-1..LNX-8。
 *
 * ## 为什么安全相关的接线也要有判据
 *
 * 阶段 1 的核心性质（"局域网上没有明文监听""上游只认边缘来的请求"）
 * 在 Rust 侧已经有**真套接字**集成判据（`src-tauri/src/phone/edge_test.rs`，
 * E1–E6）。但那些判据保护不到两类退化：
 *
 * 1. **有人把绑定改回去**（`127.0.0.1:0` → `0.0.0.0:0`）——
 *    Rust 集成判据是在**测试自己绑的**监听上跑的，改生产绑定它不会红；
 * 2. **界面开始撒谎**（仍然写"明文 HTTP"、或者干脆不显示指纹）——
 *    这是产品承诺层面的退化，只有静态判据能钉住。
 *
 * 所以这个文件不重复 Rust 已经证明的行为，只盯**接线与承诺**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeState } from "../core/phone-link/phone-link";

const read = (p: string) => readFileSync(p, "utf8");
const PHONE_RS = "src-tauri/src/phone/mod.rs";
const GUARD_RS = "src-tauri/src/phone/guard.rs";
const TLS_RS = "src-tauri/src/phone/tls.rs";
const SETTINGS_TSX = "src/components/PhoneLinkSettings.tsx";

describe("第 122 轮阶段 1 · LAN HTTPS 与边缘准入接线", () => {
  it("LNX-1: 状态透传三个新字段，且**不编造**默认值", () => {
    // 原样透传
    const s = normalizeState({
      running: true,
      port: 8443,
      lan_ip: "192.168.1.20",
      url: "https://192.168.1.20:8443/",
      https: true,
      ca_fingerprint: "AB:CD",
      ca_url: "https://192.168.1.20:8443/ca.crt",
      devices: [],
    });
    expect(s.https).toBe(true);
    expect(s.ca_fingerprint).toBe("AB:CD");
    expect(s.ca_url).toBe("https://192.168.1.20:8443/ca.crt");

    /**
     * 缺字段时必须**保持缺失的样子**：`https` 为 false、指纹为空串。
     * 不能给一个"看起来合理"的默认（比如 https:true）——
     * 那会让界面在一个拿不到指纹的状态下依然显示成"一切正常"，
     * 而用户核对指纹是自签方案里唯一的防线。
     */
    const bare = normalizeState({ running: true, port: 1, lan_ip: "x", devices: [] });
    expect(bare.https).toBe(false);
    expect(bare.ca_fingerprint).toBe("");
    expect(bare.ca_url).toBeNull();
  });

  it("LNX-2: 上游**只绑回环**，边缘才是 0.0.0.0（改回去必须变红）", () => {
    const src = read(PHONE_RS);
    expect(src, "上游必须绑 127.0.0.1").toContain('TcpListener::bind("127.0.0.1:0")');
    // 边缘绑 0.0.0.0（手机要连它）
    expect(src, "边缘必须绑 0.0.0.0").toContain('TcpListener::bind("0.0.0.0:0")');
    /**
     * 关键：0.0.0.0 的绑定必须**只出现一次**且属于边缘。
     * 如果谁把它加回上游，这里会出现第二次匹配 ⇒ 判据变红。
     */
    expect(
      src.match(/TcpListener::bind\("0\.0\.0\.0:0"\)/g)?.length ?? 0,
      "0.0.0.0 的绑定只应有边缘一处；上游绝不能再绑它",
    ).toBe(1);
    // 上游监听变量的赋值形态（改绑地址会同时改掉这一行）
    expect(src).toMatch(/let upstream_listener = TcpListener::bind\("127\.0\.0\.1:0"\)/);
  });

  it("LNX-3: 上游**真的**调用了准入判定（不是写着不用）", () => {
    const src = read(PHONE_RS);
    // handle_conn 里必须调用 upstream_admit
    const hn = src.indexOf("async fn handle_conn");
    expect(hn).toBeGreaterThan(0);
    const body = src.slice(hn, hn + 2600);
    expect(body, "handle_conn 必须调用 upstream_admit").toContain("upstream_admit(");
    // 且拒绝分支存在（403）
    expect(body).toMatch(/403/);
    // 纯函数本身也在
    expect(src).toMatch(/pub fn upstream_admit\(/);
  });

  it("LNX-4: 边缘注入了标记，且注入函数会**删掉**客户端自带的同名头", () => {
    const src = read(PHONE_RS);
    expect(src, "边缘必须调用 inject_edge_header").toContain("guard::inject_edge_header(");
    const g = read(GUARD_RS);
    // 注入实现必须包含"删除同名头"这一步（只追加 = 可被伪造头覆盖）
    expect(g).toMatch(/== EDGE_HEADER => continue/);
  });

  it("LNX-5: 边缘**真的**做了 Host/跨站准入判定", () => {
    const src = read(PHONE_RS);
    expect(src).toContain("guard::edge_verdict(");
    // 三种判定结果都要有分支（Allow / BadHost / CrossSite）
    expect(src).toContain("guard::EdgeVerdict::Allow");
    expect(src).toContain("guard::EdgeVerdict::BadHost");
    expect(src).toContain("guard::EdgeVerdict::CrossSite");
  });

  it("LNX-6: 证书失败时**拒绝启动**（fail-closed，绝不退化为明文）", () => {
    const src = read(PHONE_RS);
    // tls::ensure 失败必须 return Err，而不是继续
    expect(src).toMatch(/无法准备 TLS 证书（已拒绝启动局域网服务，绝不退化为明文）/);
    expect(src).toContain("tls::server_config(");
    // 证书模块自己的性质：CA 长期 / 叶子短期 / SAN 规范化
    const t = read(TLS_RS);
    expect(t).toMatch(/CA_VALID_DAYS: i64 = 3650/);
    expect(t).toMatch(/LEAF_VALID_DAYS: i64 = 30/);
    expect(t).toContain("normalize_san_ips");
  });

  it("LNX-7: cookie 有 Secure，且寿命不再是 1 年", () => {
    const src = read(PHONE_RS);
    const m = src.match(/COOKIE_MAX_AGE_SECS: i64 = ([0-9_ *]+);/);
    expect(m, "必须有一个具名的 cookie 寿命常量").toBeTruthy();
    expect(src, "cookie 必须带 Secure").toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=\{\}/);
    expect(src, "旧的 1 年硬编码必须消失").not.toContain("Max-Age=31536000");
    expect(src).toContain("Max-Age={}", );
    // 具体数值：30 天
    expect(m![1].replace(/[_\s]/g, "")).toBe("30*24*3600");
  });

  it("LNX-8: 界面显示指纹与 HTTPS 来源，且不再声称自己是明文 HTTP", () => {
    const ui = read(SETTINGS_TSX);
    // 指纹必须显示出来（带 testid，便于真机验证脚本定位）
    expect(ui).toContain('data-testid="phone-ca-fingerprint"');
    expect(ui).toContain("ca_fingerprint");
    // 协议取真值而不是硬编码 http://
    expect(ui).toContain("status.https ? \"https\" : \"http\"");
    // 旧文案描述的已经不是事实，必须消失（否则界面在撒谎）
    expect(ui).not.toContain("本服务为明文 HTTP");
    expect(ui).not.toContain("plain HTTP with cookie auth");
    // 必须明确要求"核对指纹"——这是自签方案唯一挡中间人的一步
    expect(ui).toMatch(/核对指纹|Verify the fingerprint/);
  });
});
