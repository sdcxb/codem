/**
 * Android 本机模型设置的**源码不变量**（ANDROID-LLM-1..10）。
 *
 * 真机行为（Keystore / 进程信号 / WebView 桥）在 vitest 里跑不了；这里钉住那些
 * "靠人工记不住"的规则：
 * - Key 只有密文落盘（明文只允许"读后删"，且删除必须在解密验证之后）；
 * - 任何日志行都不许碰 Key 变量；
 * - 配置类 intent extras 只在 debuggable 构建生效（否则任意 App 能把 Key 送去自己的地址）；
 * - 原生桥只在 loopback 页面注入，且每个方法内部再复核 origin；
 * - 重启是"先停干净再起"，停不干净就报错（绝不出现两个 Host）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const JAVA_DIR = join(ROOT, "android-shell", "src", "com", "codem", "remote");
const read = (name: string) => readFileSync(join(JAVA_DIR, name), "utf8");
const readRepo = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MAIN = read("MainActivity.java");
const SECRET = read("LlmSecretStore.java");
const SUPERVISOR = read("HostSupervisor.java");
const DIALOG = read("LlmSettingsDialog.java");
const MANIFEST = readRepo("android-shell/AndroidManifest.xml");
const ALL_JAVA = readdirSync(JAVA_DIR)
  .filter((f) => f.endsWith(".java"))
  .map((f) => ({ name: f, src: read(f) }));

/** 取一个方法/类的方法体（从标记到下一个标记之前） */
function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `找不到起点：${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `找不到终点：${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ANDROID-LLM-1 Key 不许明文落盘", () => {
  it("没有任何 putString(\"llm_key\")；明文只有迁移时的 get/remove", () => {
    for (const { name, src } of ALL_JAVA) {
      expect(src, `${name} 不许写明文 Key`).not.toContain('putString("llm_key"');
      expect(src, `${name} 不许写明文 Key`).not.toContain("putString(KEY_PLAIN_LEGACY");
    }
    // 明文键只允许在 LlmSecretStore 里被"读后删"；MainActivity 不许直接碰
    expect(MAIN).not.toContain('"llm_key"');
    expect(MAIN).not.toContain("KEY_PLAIN_LEGACY");
    expect(SECRET).toContain('String KEY_PLAIN_LEGACY = "llm_key"');
    expect(SECRET).toContain("remove(KEY_PLAIN_LEGACY)");
  });

  it("密文键与状态键存在，且状态机有 4 个态", () => {
    expect(SECRET).toContain('String KEY_ENC = "llm_key_enc"');
    for (const wire of ['"keystore"', '"legacy"', '"unreadable"', '"none"']) {
      expect(SECRET).toContain(wire);
    }
  });

  it("迁移顺序：加密 → 解密回读验证 → 删明文（顺序反了会丢 Key）", () => {
    const saveKey = slice(SECRET, "static void saveKey(", "static void clearKey(");
    const encryptAt = saveKey.indexOf("encrypt(value)");
    const decryptAt = saveKey.indexOf("decrypt(encrypted)");
    const removeAt = saveKey.indexOf("remove(KEY_PLAIN_LEGACY)");
    expect(encryptAt).toBeGreaterThanOrEqual(0);
    expect(decryptAt, "必须先回读验证").toBeGreaterThan(encryptAt);
    expect(removeAt, "验证通过后才删明文").toBeGreaterThan(decryptAt);
  });

  it("启动时先迁移，再启动 Host", () => {
    expect(MAIN).toContain("LlmSecretStore.migrate(prefs())");
    const migrateAt = MAIN.indexOf("LlmSecretStore.migrate(prefs())");
    const startAt = MAIN.indexOf("supervisor.ensureStarted(");
    expect(startAt).toBeGreaterThan(migrateAt);
  });
});

describe("ANDROID-LLM-2 Keystore AES/GCM 参数", () => {
  it("AndroidKeyStore + AES/GCM/NoPadding + 12B IV + AAD + 不强求生物识别", () => {
    expect(SECRET).toContain('"AndroidKeyStore"');
    expect(SECRET).toContain("AES/GCM/NoPadding");
    expect(SECRET).toContain('"codem.llm.key.v1"');
    expect(SECRET).toContain("IV_BYTES = 12");
    expect(SECRET).toContain("TAG_BITS = 128");
    expect(SECRET).toContain("AAD");
    expect(SECRET).toContain("setUserAuthenticationRequired(false)");
    expect(SECRET).toContain("setRandomizedEncryptionRequired(true)");
    expect(SECRET).toContain("BLOCK_MODE_GCM");
    expect(SECRET).toContain("ENCRYPTION_PADDING_NONE");
  });

  it("解密失败**不重建**密钥（重建等于悄悄换锁，旧密文永久废掉）", () => {
    const decryptKey = slice(SECRET, "private static SecretKey keyForDecrypt()", "private static SecretKey existingKey()");
    expect(decryptKey).toContain("existingKey()");
    expect(decryptKey, "解密路径不许生成新密钥").not.toContain("KeyGenerator");
  });

  it("解不开时保留密文（状态置 unreadable，不删）", () => {
    const migrate = slice(SECRET, "static void migrate(", "// ===== 给 WebView 的摘要");
    expect(migrate).toContain("State.UNREADABLE.wire");
    expect(migrate, "UNREADABLE 分支不许删密文").not.toContain("remove(KEY_ENC)");
  });
});

describe("ANDROID-LLM-3 Manifest 关闭备份", () => {
  it("allowBackup / fullBackupContent 都是 false", () => {
    expect(MANIFEST).toContain('android:allowBackup="false"');
    expect(MANIFEST).toContain('android:fullBackupContent="false"');
  });
});

describe("ANDROID-LLM-4 重启 Host：先停干净，再起", () => {
  it("stop 先 SIGTERM、再 SIGKILL；restart 是 stop → start 的顺序", () => {
    const stop = slice(SUPERVISOR, "boolean stop(long graceMs)", "void restart(LlmConfig config, File log)");
    const termAt = stop.indexOf("signal(pid, SIGTERM)");
    const killAt = stop.indexOf("signal(pid, SIGKILL)");
    expect(termAt).toBeGreaterThanOrEqual(0);
    expect(killAt).toBeGreaterThan(termAt);

    const restart = slice(SUPERVISOR, "void restart(LlmConfig config, File log)", "// ===== 启动 =====");
    const stopAt = restart.indexOf("stop(5_000)");
    const startAt = restart.indexOf("startLocked(config, log)");
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(stopAt);
  });

  it("停不干净就报错，绝不启动第二个 Host", () => {
    const restart = slice(SUPERVISOR, "void restart(LlmConfig config, File log)", "// ===== 启动 =====");
    expect(restart).toContain("if (!stop(5_000))");
    expect(restart).toContain("throw new IOException");
    expect(restart).toContain("restarting = true");
  });

  it("Key 走 stdin，进程环境里没有 CODEM_LLM_*", () => {
    expect(SUPERVISOR).not.toContain("CODEM_LLM_API_KEY");
    expect(SUPERVISOR).not.toContain("CODEM_LLM_BASE_URL");
    expect(SUPERVISOR).not.toContain("CODEM_LLM_MODEL");
    expect(SUPERVISOR).toContain('cmd.add("--llm-stdin")');
    expect(SUPERVISOR).toContain("writeConfigLine");
    expect(SUPERVISOR, "旧实现把 Key 塞进 env —— 这是本轮要修的泄漏链").not.toContain('put("CODEM_LLM');
    expect(MAIN).not.toContain("CODEM_LLM_");
  });

  it("重启后只刷新 loopback 页面（远程 PC 页面不打断），且用新端口/新凭据整页重载", () => {
    const restartAsync = slice(MAIN, "private void restartHostAsync(", "private void showBusy(");
    expect(restartAsync).toContain("supervisor.restart(config, hostLog())");
    expect(restartAsync).toContain("isLoopback(currentPageUrl)");
    /*
     * 端口与凭据每次启动都会变：`webView.reload()` 会用旧 URL（旧端口 + 旧 fragment），
     * 而"只改 hash"通常不会重载文档 ⇒ 页面拿着失效凭据一直断线。
     */
    expect(restartAsync).not.toContain("webView.reload()");
    expect(restartAsync).toContain("reloadLocalPage()");
  });
});

describe("ANDROID-LLM-5 日志里不许出现 Key", () => {
  it("任何 Log.* 行都不含 key 变量/字段", () => {
    const forbidden = ["apiKey", "llm_key", "llmKey", "KEY_ENC", "KEY_PLAIN", "config.apiKey", "getLlmSettingsSummary"];
    for (const { name, src } of ALL_JAVA) {
      for (const line of src.split("\n")) {
        if (!/^\s*Log\.[a-z]\(/.test(line)) continue;
        for (const token of forbidden) {
          expect(line, `${name} 的日志行泄露了 ${token}：${line.trim()}`).not.toContain(token);
        }
      }
    }
  });

  it("碰凭据的类里，日志只允许打异常类型（不打值）", () => {
    // `LlmSecretStore` 是唯一接触明文/密文的类：它的每条日志都必须只带 getClass().getSimpleName()
    const concat = /\+\s*(value|plaintext|encrypted|round|raw|apiKey|key|legacy|config|password)\b/;
    for (const line of SECRET.split("\n")) {
      if (!/^\s*Log\.[a-z]\(/.test(line)) continue;
      expect(line, `日志行不许拼接秘密变量：${line.trim()}`).not.toMatch(concat);
      expect(line, "只打异常类型").toContain("getClass().getSimpleName()");
    }
    // 设置对话框根本不写日志（它持有 Key 的 EditText）
    expect(DIALOG).not.toMatch(/^\s*Log\./m);
  });

  it("Key 不经过 Intent / Toast / 报告文本", () => {
    for (const { name, src } of ALL_JAVA) {
      expect(src, `${name} 不许把 Key 放进 Intent`).not.toMatch(/putExtra\([^)]*[Kk]ey/);
      expect(src, `${name} 不许把 Key 放进 Toast`).not.toMatch(/Toast[^;]*[Kk]ey/);
    }
  });
});

describe("ANDROID-LLM-6 配置类 extras 只在 debuggable 构建生效", () => {
  it("applyConfigExtrasIfDebuggable 有 FLAG_DEBUGGABLE 门禁，且 llmKey 只出现在这个方法里", () => {
    const body = slice(MAIN, "private void applyConfigExtrasIfDebuggable()", "private boolean isDebuggable()");
    expect(body).toContain("if (!isDebuggable()) return;");
    expect(body).toContain('"llmBase"');
    expect(body).toContain('"llmModel"');
    expect(body).toContain('"llmKey"');
    // 除了这个方法，文件里不许再出现 llmKey（release 路径上连字符串都不该有）
    expect(MAIN.split('"llmKey"').length - 1, "方法内：读一次 + 清一次").toBe(2);
    expect(MAIN.replace(body, "")).not.toContain('"llmKey"');
    expect(MAIN).toContain("ApplicationInfo.FLAG_DEBUGGABLE");
    // extra 用完要清掉（否则留在 dumpsys 的 intent 里）
    expect(body).toContain('intent.removeExtra("llmKey")');
  });
});

describe("ANDROID-LLM-7 原生桥只在 loopback 页面", () => {
  it("addJavascriptInterface 只有一处，且在 loopback 分支里先判后加", () => {
    // 只数真正的调用（注释里提到方法名不算）
    const occurrences = MAIN.split("webView.addJavascriptInterface(").length - 1;
    expect(occurrences).toBe(1);
    const prepare = slice(MAIN, "private void prepareBridgeForLoad(String url)", "/** 打开本机（loopback）页面");
    const gateAt = prepare.indexOf("if (loopbackPage)");
    const addAt = prepare.indexOf("addJavascriptInterface");
    const removeAt = prepare.indexOf("removeJavascriptInterface");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(addAt).toBeGreaterThan(gateAt);
    expect(removeAt).toBeGreaterThan(addAt);
  });

  it("桥的每个方法都复核 bridgeAllowed()，且没有 getKey 之类的能力", () => {
    const bridge = slice(MAIN, "private final class NativeBridge", "private static boolean isHttpUrl");
    expect(bridge.split("@JavascriptInterface").length - 1).toBe(3);
    expect(bridge.split("bridgeAllowed()").length - 1).toBeGreaterThanOrEqual(2);
    expect(bridge).toContain("openLlmSettings");
    expect(bridge).toContain("getLlmSettingsSummary");
    for (const forbidden of ["getKey", "saveKey", "openUrl", "loadUrl", "evalJs"]) {
      expect(bridge, `桥不许暴露 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("页面只能在 http(s) 内导航（file:/intent:/javascript: 一律拦掉）", () => {
    expect(MAIN).toContain("shouldOverrideUrlLoading");
    expect(MAIN).toContain("isHttpUrl(url)");
    expect(MAIN).toContain("setAllowFileAccess(false)");
    expect(MAIN).toContain("setAllowContentAccess(false)");
    expect(MAIN).toContain("setAllowFileAccessFromFileURLs(false)");
    expect(MAIN).toContain("setAllowUniversalAccessFromFileURLs(false)");
  });

  it("离开 loopback 会移除接口（加载前 + 页面回调里各一次）", () => {
    const client = slice(MAIN, "private final class ShellClient", "private void flushCookies");
    expect(client.split("removeJavascriptInterface").length - 1).toBeGreaterThanOrEqual(2);
    expect(client).toContain("onPageStarted");
    expect(client).toContain("onPageFinished");
  });
});

describe("ANDROID-LLM-8 设置对话框：密码输入、不回填、禁 autofill、挡截图", () => {
  it("Key 是密码框，且创建时不预填任何值", () => {
    expect(DIALOG).toContain("TYPE_TEXT_VARIATION_PASSWORD");
    expect(DIALOG).toContain('"API Key（留空保持不变）", ""');
    expect(DIALOG).toContain("setSaveEnabled(false)");
    expect(DIALOG).toContain("IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS");
    expect(DIALOG).toContain("FLAG_SECURE");
  });

  it("表单不读写存储、不重启 Host（只回传字段）", () => {
    expect(DIALOG).not.toContain("SharedPreferences");
    expect(DIALOG).not.toContain("LlmSecretStore.saveKey");
    expect(DIALOG).not.toContain("HostSupervisor");
    expect(DIALOG).toContain("interface Listener");
  });

  it("启动页不再回填 Key", () => {
    expect(MAIN).not.toContain('prefs().getString("llm_key"');
    expect(MAIN).not.toContain("prefs().getString(LlmSecretStore.KEY_PLAIN_LEGACY");
    const startScreen = slice(MAIN, "private void showStartScreen()", "private EditText field(");
    expect(startScreen).toContain('field("API Key（留空沿用已保存的 Key）", "")');
  });

  it("校验拒绝非 http(s)、带 query 的地址", () => {
    const validate = slice(DIALOG, "static String validate(", "private static void confirmClear(");
    expect(validate).toContain('scheme.equals("http")');
    expect(validate).toContain('scheme.equals("https")');
    expect(validate).toContain("getQuery()");
    expect(validate).toContain("getFragment()");
    expect(validate).toContain("isWhitespace");
  });
});

describe("ANDROID-LLM-9 保存失败不重启 Host", () => {
  it("persistConfig 失败只回人话；重启只在 onSaved 之后发生", () => {
    const apply = slice(MAIN, "private void applyLlmSettings(", "private void restartHostAsync(");
    expect(apply).toContain("persistConfig(");
    const savedAt = apply.indexOf("public void onSaved(LlmConfig config)");
    const restartAt = apply.indexOf("restartHostAsync(config)");
    const failedAt = apply.indexOf("public void onFailed(String message)");
    expect(savedAt).toBeGreaterThanOrEqual(0);
    expect(restartAt).toBeGreaterThan(savedAt);
    expect(failedAt).toBeGreaterThan(restartAt);
    // onFailed 分支里不许重启（否则"新配置没落盘、旧 Host 已经停了"）
    const failedBranch = apply.slice(failedAt);
    expect(failedBranch).not.toContain("restartHostAsync");
    expect(failedBranch).toContain("showSettingsError");
  });
});

describe("ANDROID-LLM-10 设置入口可发现（错误页也有）", () => {
  it("showError 里有「设置」按钮", () => {
    const showError = slice(MAIN, "private void showError(Exception e)", "private void openOnlyWebView(");
    expect(showError).toContain("settings.setOnClickListener(v -> showLlmSettings())");
    expect(showError).toContain('settings.setText("设置")');
    expect(showError).toContain('settings.setContentDescription("本机模型设置")');
  });

  it("重试走单飞 startLocal，不会并发解压/起 Host", () => {
    const showError = slice(MAIN, "private void showError(Exception e)", "private void openOnlyWebView(");
    expect(showError).toContain("startLocal()");
    expect(showError).toContain("webView = newWebView()");
    expect(MAIN).toContain("setupRunning.compareAndSet(false, true)");
  });
});
