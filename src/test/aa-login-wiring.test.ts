/**
 * 阶段 N1–N3 判据 —— 「登录一下就能用」这条路的接线：N-1..N-7。
 *
 * 这一层最容易出的错**不是崩溃，而是"用户要走的流程与 DSH 不一样"** ——
 * 我先前就是漏了"注册本机"，把 `connectorToken` 推给用户手工准备，
 * 于是用户问出"为什么我要买服务端？DSH 登录一下就能用啊"。
 * 所以这些判据盯的是**流程与默认值**，不只是"函数存在"。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | N-1 | 默认服务器 = 它的云（与 DSH 的默认一致），用户不填地址就能用 |
 * | N-2 | 地址规范化容错（只填域名 / 带 /api/v2 / 末尾斜杠），并拒绝内嵌账号密码 |
 * | N-3 | 走**邮箱+密码**（最简单），不用 OAuth/PKCE —— 后者要用它插件的身份 |
 * | N-4 | 命令齐全：status/login/logout/connect，且 connect **会先注册本机** |
 * | N-5 | 账号态落盘，且给界面的视图**不含令牌** |
 * | N-6 | 换服务器时**作废旧设备凭据**（否则带着旧凭据连新服务器只会 401） |
 * | N-7 | 界面：有服务器选择（默认官方）、邮箱密码、登录/注册/连接；自研中继不默认启用 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const ACCOUNT = "src-tauri/src/phone/aa_account.rs";
const MOD = "src-tauri/src/phone/mod.rs";
const UI = "src/components/AaRemoteSection.tsx";
const PANEL = "src/components/PhoneLinkSettings.tsx";

describe("阶段 N1–N3 · 登录 → 注册本机 → 连上", () => {
  it("N-1: 默认服务器是它的云（与 DSH 默认一致）", () => {
    const src = read(ACCOUNT);
    expect(src).toContain('pub const AA_CLOUD_BASE_URL: &str = "https://web.agents-anywhere.com"');
    // 命令层：没给地址就用云端（**不是**报错"请填地址"）
    const mod = read(MOD);
    expect(mod).toMatch(/None => aa_account::AA_CLOUD_BASE_URL\.to_string\(\)/);
    // 界面默认选"官方服务"
    const ui = read(UI);
    expect(ui).toMatch(/checked=\{!custom\}/);
    expect(ui).toMatch(/官方服务（默认）/);
    /**
     * ⚠️ 这条是补的：上面两条都**抓不到**"初始值被改成 true"
     * （`checked={!custom}` 与文案在任何初始值下都成立）。
     * 变异自证就是这么发现这个盲区的 —— 判据得盯**初始值本身**。
     */
    expect(ui, "自建开关的初值必须是 false（默认官方）").toContain(
      "const [custom, setCustom] = useState(false);",
    );
  });

  it("N-2: 地址规范化容错，并拒绝内嵌账号密码", () => {
    const src = read(ACCOUNT);
    expect(src).toContain("pub fn normalize_api_base");
    // 去掉 /api/v2（从文档抄来的地址就长这样）与末尾斜杠
    expect(src).toContain("trim_end_matches('/')");
    // 内嵌账号密码要拒（它会跟着错误信息/日志/界面一起显示出来）
    expect(src).toMatch(/服务器地址里不要带账号密码/);
    expect(src).toMatch(/!u\.username\(\)\.is_empty\(\)/);
  });

  it("N-3: 走邮箱+密码，不走 OAuth（OAuth 要用它插件的身份）", () => {
    const src = read(ACCOUNT);
    expect(src).toContain("pub async fn login_with_password");
    expect(src).toContain("pub async fn register_with_password");
    expect(src).toContain("/api/v2/auth/login");
    expect(src).toContain("/api/v2/auth/register");
    // PKCE 那套**保留但默认不走** —— 文件里要说清楚为什么
    expect(src).toMatch(/默认不走|保留.*备选|不用它插件那套 OAuth/);
    // 命令层不许去调 authorization_url（那意味着界面走的是 OAuth）
    const mod = read(MOD);
    expect(mod).not.toContain("authorization_url(");
  });

  it("N-4: 命令齐全，且 connect **会先注册本机**", () => {
    const mod = read(MOD);
    for (const c of ["aa_account_status", "aa_account_login", "aa_account_logout", "aa_connect"]) {
      expect(mod, `缺命令 ${c}`).toContain(`pub async fn ${c}(`);
    }
    // 关键：connect 里必须先确保有设备凭据（没有就注册），再启动 connector
    const i = mod.indexOf("pub async fn aa_connect(");
    const body = mod.slice(i, i + 2400);
    expect(body, "connect 必须先确保设备凭据").toContain("register_connector(");
    const regAt = body.indexOf("register_connector(");
    const startAt = body.indexOf("aa_connector::start(");
    expect(regAt, "注册本机必须在启动 connector **之前**").toBeLessThan(startAt);
    /**
     * 反向判据：没有设备凭据时**不许**直接失败。
     *
     * 只判"含有 `register_connector(`"是不够的 —— 变异自证证明过：
     * 把注册挪到一个永不执行的闭包里，字符串还在，判据照样绿。
     * 所以要同时钉"缺凭据的分支不是报错"。
     */
    const devBranch = body.slice(body.indexOf("let cred = match acct.device.clone()"), regAt);
    expect(devBranch, "缺凭据时必须去注册，而不是报错").not.toMatch(/return Err/);
  });

  it("N-5: 账号态落盘，且给界面的视图不含令牌", () => {
    const src = read(ACCOUNT);
    expect(src).toContain("pub fn save_account_state");
    expect(src).toContain("pub fn load_account_state");
    // 坏文件/不存在都当"首次运行"，不报错
    expect(src).toContain("serde_json::from_str(&raw).ok()");
    /**
     * 令牌不外泄这件事**只能靠行为判据**（Rust 侧
     * `account_state_redacts_secrets`：把视图序列化出来，断言里面
     * **找不到**令牌明文）。结构判据在这里是**不够的** ——
     * 变异自证证明过：往视图里加一个 `"accessToken": ...` 字段，
     * 结构判据照样绿。
     *
     * 所以这条只做"行为判据还在不在"的守卫，真正的判定在 Rust 那边。
     */
    expect(src, "必须有把视图序列化后断言不含令牌的行为判据").toContain(
      "fn account_state_redacts_secrets()",
    );
    expect(src).toContain('assert!(!v.contains("SECRET-TOKEN")');
    expect(src).toContain('assert!(!v.contains("SECRET-DEVICE")');
  });

  it("N-6: 换服务器时作废旧设备凭据", () => {
    const mod = read(MOD);
    const i = mod.indexOf("pub async fn aa_account_login(");
    const body = mod.slice(i, i + 2600);
    // 只在新旧 server_url **相同**时才保留设备凭据
    expect(body).toMatch(/server_url == base/);
    expect(body).toMatch(/keep_device/);
    /**
     * 反向判据：不许无条件保留旧设备。
     * 带着 A 服务器的 connectorToken 去连 B 服务器只会拿到 401，
     * 而用户看到的是莫名其妙的"凭据失效"。
     */
    expect(body).not.toMatch(/device:\s*prev\.as_ref\(\)\.and_then\(\|p\| p\.device\.clone\(\)\)/);
  });

  it("N-7: 界面接线（服务器选择 / 账号 / 三个动作），且自研中继不默认启用", () => {
    const ui = read(UI);
    for (const t of ['data-testid="aa-remote"', 'data-testid="aa-email"', 'data-testid="aa-password"',
                     'data-testid="aa-login"', 'data-testid="aa-register"', 'data-testid="aa-connect"',
                     'data-testid="aa-url"']) {
      expect(ui, `界面缺 ${t}`).toContain(t);
    }
    // 状态要用机器可读的属性暴露（判据/探针不许只靠文案）
    expect(ui).toContain('data-testid="aa-phase"');
    expect(ui).toContain("data-connected=");
    // 服务端返回的错误要**原样显示**（它比我们编的准确）
    expect(ui).toContain('data-testid="aa-login-error"');
    // 已挂进设置面板
    expect(read(PANEL)).toContain("<AaRemoteSection");
    /**
     * 自研中继**不默认启用**：界面里不许出现"自动启动中继"这类逻辑，
     * 它只能靠用户显式点（`relay-start`）。
     */
    const panel = read(PANEL);
    expect(panel).not.toMatch(/phone_relay_start"\s*\)/); // 不许无参调用（那等于自动启动）
    expect(panel).toContain('tauriInvoke("phone_relay_start"');
  });

  it("N-8: 自研中继收进「高级」折叠区，不摆在主路径上", () => {
    const panel = read(PANEL);
    /**
     * 用户口径是"不要太复杂、不要让用户面对看不懂的机制"。
     * 中继是我们自研的第二套传输 —— 它**不该和主路径并排摆着**，
     * 否则用户要在两条他都不懂的机制之间选。
     */
    expect(panel, "中继必须收进 details").toMatch(/<details[^>]*data-testid="advanced-relay"/);
    // 折叠区要有说明它"默认不用"
    expect(panel).toMatch(/高级：自研中继/);
    expect(panel).toMatch(/默认不用/);
    // 中继块必须在 details **内部**（在开标签之后、闭标签之前）
    const open = panel.indexOf('data-testid="advanced-relay"');
    const relayCard = panel.indexOf('className="setting-group relay-card"');
    const close = panel.indexOf("</details>", open);
    expect(open).toBeGreaterThan(0);
    expect(relayCard, "relay-card 应当被 details 包住").toBeGreaterThan(open);
    expect(close, "details 应当在 relay-card 之后闭合").toBeGreaterThan(relayCard);
    // 主路径（AA 登录入口）必须在 details **之前**（先看到主路径）
    const aaSection = panel.indexOf("<AaRemoteSection");
    expect(aaSection, "主路径应当在「高级」之前").toBeLessThan(open);
    // 且 details 默认**不展开**（不许写 open）
    expect(panel.slice(open - 60, open + 90)).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it("N-9: 注册必填项必须都有入口（displayName 那次事故）", () => {
    /**
     * 事故记录：用户点「注册并登录」拿到
     * `display name must be 1-64 characters (HTTP 422)` ——
     * 而**界面上根本没有输入昵称的地方**。
     *
     * 服务端 `normalize_display_name` 对注册是**必填**（1-64、不能空白、不能含控制字符），
     * 而 OpenAPI 上只写了 `required: ["email"]` —— 光看接口文档看不出来。
     */
    const ui = read(UI);
    expect(ui, "必须有昵称输入框").toContain('data-testid="aa-display-name"');
    // 没填昵称就不许点注册（别让用户去撞 422）
    expect(ui).toMatch(/disabled=\{busy \|\| !email\.trim\(\) \|\| !password \|\| !displayName\.trim\(\)\}/);
    // 昵称要被真的发出去
    expect(ui).toMatch(/displayName: displayName\.trim\(\) \|\| null/);

    // 命令层也要**在进门就拒**，并且说人话（不是转述英文校验错误）
    const mod = read(MOD);
    expect(mod).toMatch(/注册需要一个昵称/);
    // 长度/控制字符也要自己先挡（服务端的规则是 1-64 且无控制字符）
    expect(mod).toMatch(/昵称最长 64 个字符/);
    expect(mod).toMatch(/昵称不能包含控制字符/);
  });

  it("N-10: 需要邮箱验证码的服务端也要有入口（否则又卡在一个没入口的字段上）", () => {
    const ui = read(UI);
    // 验证码输入 + 发送按钮都要在（默认折叠，因为多数服务器不需要）
    expect(ui).toContain('data-testid="aa-code"');
    expect(ui).toContain('data-testid="aa-send-code"');
    expect(ui).toContain('data-testid="aa-toggle-code"');
    // 默认不展开（"不要太复杂"）
    expect(ui).toMatch(/const \[showCode, setShowCode\] = useState\(false\)/);
    // 命令存在
    expect(read(MOD)).toContain("pub async fn aa_account_send_code(");
    expect(read(ACCOUNT)).toContain("pub async fn send_email_code(");
    // purpose 用它的取值
    expect(read(MOD)).toContain('"register"');
  });
});
