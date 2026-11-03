/**
 * Android 本机 Host 鉴权的**源码不变量**（ALA-*）。
 *
 * 真机行为（随机端口 / 随机凭据 / WebView 加载）在设备用例里；这里钉住那些
 * "改一行就会悄悄失效、而且失效后看不出来"的规则：
 * - 端口与凭据每次启动都随机（不再有固定 8787 / 常量 PORT）；
 * - 凭据只经 `ProcessBuilder.environment()` 交给 Host，**不进 argv**、不进日志、不进 prefs；
 * - 页面 URL 用当前端口 + `#token=` 引导；只有 loopback 深链才被重写（远程页面不追加 fragment）；
 * - 重启后必须换 URL 整页重载（只改 hash 不会重载）；
 * - `safeUrlForLog` 继续剥掉 query / fragment（日志里永远没有凭据）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const JAVA_DIR = join(ROOT, "android-shell", "src", "com", "codem", "remote");
const read = (name: string): string => readFileSync(join(JAVA_DIR, name), "utf8");

const MAIN = read("MainActivity.java");
const SUPERVISOR = read("HostSupervisor.java");

function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `找不到起点：${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到终点：${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ALA-1 随机端口 + 随机凭据（不再有固定 8787）", () => {
  it("HostSupervisor 没有 PORT 常量；用内核分配端口", () => {
    expect(SUPERVISOR).not.toMatch(/\bPORT\s*=\s*8787/);
    expect(SUPERVISOR).not.toContain("static final int PORT");
    expect(SUPERVISOR).toContain("new ServerSocket(0, 1, InetAddress.getByName(\"127.0.0.1\"))");
    expect(SUPERVISOR).toContain("pickFreePort()");
  });

  it("凭据由 SecureRandom 生成 64 位 hex", () => {
    expect(SUPERVISOR).toContain("import java.security.SecureRandom;");
    expect(SUPERVISOR).toContain("RANDOM.nextBytes(raw)");
    expect(SUPERVISOR).toContain("Character.forDigit(");
    const tokenFn = slice(SUPERVISOR, "private static String newLocalAuthToken()", "private Process launch(");
    expect(tokenFn).toContain("new byte[32]");
    expect(tokenFn).toContain("StringBuilder(64)");
  });

  it("凭据只进 ProcessBuilder.environment()，**不进 argv**", () => {
    expect(SUPERVISOR).toContain('pb.environment().put("CODEM_HOST_LOCAL_AUTH", token)');
    expect(SUPERVISOR).toContain('pb.environment().put("CODEM_HOST_AUTH", "local-auth")');
    // argv 里只允许端口（String.valueOf(port)），不允许出现凭据/令牌变量
    const argv = slice(SUPERVISOR, "List<String> cmd = new ArrayList<>(Arrays.asList(", "--llm-stdin");
    expect(argv).toContain('"--port", String.valueOf(port)');
    expect(argv.toLowerCase()).not.toContain("token");
    expect(argv).not.toContain("CODEM_HOST_LOCAL_AUTH");
  });

  it("启动日志只报端口（不报凭据）", () => {
    expect(SUPERVISOR).toContain('Log.i(TAG, "host ready port=" + port)');
    const logLines = SUPERVISOR.split("\n").filter((line) => /^\s*Log\.[a-z]\(/.test(line));
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line.toLowerCase(), `日志行不许出现凭据变量：${line.trim()}`).not.toContain("token");
      expect(line).not.toContain("LOCAL_AUTH");
    }
  });
});

describe("ALA-2 页面加载：当前端口 + fragment 引导，远程页面不追加", () => {
  it("URL 由 localUrl() 拼：当前端口 + #token=<凭据>，且 fragment 常量存在", () => {
    expect(MAIN).toContain('private static final String LOCAL_AUTH_FRAGMENT = "#token=";');
    const localUrl = slice(MAIN, "private String localUrl(String pathAndQuery)", "private void openLocalTarget(");
    expect(localUrl).toContain("HostSupervisor.endpoint()");
    expect(localUrl).toContain('"http://127.0.0.1:" + ep.port');
    expect(localUrl).toContain("LOCAL_AUTH_FRAGMENT + ep.token");
  });

  it("没有固定端口：本机页面/重启都走当前端点", () => {
    expect(MAIN).not.toContain("private static final int PORT");
    // 只允许注释里提到旧地址；代码里不许再出现写死的 8787 URL
    expect(MAIN).not.toContain('"http://127.0.0.1:8787');
    const prepare = slice(MAIN, "private void prepareAndLaunch()", "private void installExes(");
    expect(prepare).toContain("openLocalTarget(localPathAndQuery(target))");
    expect(prepare).toContain('openLocalTarget("/")');
  });

  it("深链重写保留 path/query（旧 8787 被换掉），远程 URL 不追加 fragment", () => {
    const rewrite = slice(MAIN, "private static String localPathAndQuery(String url)", "private void reloadLocalPage()");
    expect(rewrite).toContain("u.getRawPath()");
    expect(rewrite).toContain("u.getRawQuery()");
    // 远程分支仍旧走 openOnlyWebView（里面不拼 fragment）
    const openOnly = slice(MAIN, "private void openOnlyWebView(String url)", "private static String safeUrlForLog");
    expect(openOnly).not.toContain("LOCAL_AUTH_FRAGMENT");
    expect(openOnly).not.toContain("#token=");
  });

  it("onNewIntent / onResume 的本机分支都重写端口", () => {
    for (const marker of ["onNewIntent", "onResume"]) {
      const start = MAIN.indexOf(`protected void ${marker}(`);
      expect(start).toBeGreaterThan(0);
      const body = MAIN.slice(start, start + 900);
      expect(body).toContain("openLocalTarget(localPathAndQuery(url))");
    }
  });

  it("重启后整页重载（新 URL + 非秘密 _r 参数），不是 webView.reload()", () => {
    const reload = slice(MAIN, "private void reloadLocalPage()", "/** 桥是否可用");
    expect(reload).toContain("openLocalTarget(");
    expect(reload).toContain('"_r=" + System.currentTimeMillis()');
    expect(reload).not.toContain("LOCAL_AUTH_FRAGMENT");
  });
});

describe("ALA-3 日志与原生桥边界", () => {
  it("safeUrlForLog 仍然只保留 scheme/host/port/path", () => {
    const body = slice(MAIN, "private static String safeUrlForLog(String url)", "private static void mkdirs(File dir)");
    expect(body).not.toContain("getQuery");
    expect(body).not.toContain("getFragment");
    expect(body).toContain("u.getPath()");
  });

  it("任何日志行都不拼 fragment/凭据", () => {
    for (const [name, src] of [
      ["MainActivity", MAIN],
      ["HostSupervisor", SUPERVISOR],
    ] as const) {
      for (const line of src.split("\n")) {
        if (!/^\s*Log\.[a-z]\(/.test(line)) continue;
        expect(line, `${name} 的日志行泄漏了 fragment：${line.trim()}`).not.toContain("LOCAL_AUTH_FRAGMENT");
        expect(line.toLowerCase(), `${name} 的日志行出现 token：${line.trim()}`).not.toContain("token");
      }
    }
  });

  it("原生桥按**当前端点端口**精确授予（端口随机后 loopback 不再等于本机 Host）", () => {
    const pageGate = slice(MAIN, "private static boolean isLocalHostPage(String url)", "private String takeUrlIntent()");
    expect(pageGate).toContain('"127.0.0.1".equals(host)');
    expect(pageGate).toContain("u.getPort() == ep.port");
    expect(pageGate).toContain("HostSupervisor.endpoint()");
    // 注入路径与运行期复核都用精确判定，不用宽松的 isLoopback
    const prepare = slice(MAIN, "private void prepareBridgeForLoad(String url)", "/** 打开本机（loopback）页面");
    expect(prepare).toContain("isLocalHostPage(currentPageUrl)");
    expect(prepare).not.toContain("isLoopback(currentPageUrl)");
    const allowed = slice(MAIN, "private boolean bridgeAllowed()", "private final class NativeBridge");
    expect(allowed).toContain("isLocalHostPage(currentPageUrl)");
  });

  it("凭据不写 prefs（只可能经环境变量/内存）", () => {
    expect(SUPERVISOR).not.toContain("SharedPreferences");
    expect(MAIN).not.toContain("CODEM_HOST_LOCAL_AUTH");
    // 页面 URL 会带 fragment，但绝不允许落进 prefs（升级/重启会读回旧值）
    expect(MAIN).not.toContain('putString("local_auth');
    expect(MAIN).not.toContain('putString("host_url"');
  });
});
