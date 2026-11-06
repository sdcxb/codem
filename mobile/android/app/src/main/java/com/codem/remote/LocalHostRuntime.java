package com.codem.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.os.Build;
import android.os.Environment;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Flutter 客户端的**内置本机 Host**：解压 PRoot + Ubuntu rootfs + Node，起 `codem-host`，
 * 并把端口/令牌/工作区交给 Dart（MethodChannel `codem/local_host`，契约见
 * `mobile/LOCAL_HOST_CONTRACT.md` 与 `mobile/android/LOCAL_HOST_CONTRACT_ADDENDUM.md`）。
 *
 * ## 与 `mobile/lib/**` 的分工
 *
 * 这里**只做原生侧**：解压、可执行安装、工作区、进程管理、凭据存取、存储授权判定。
 * 页面/会话/模型 UI 全在 Dart，原生不认识 Host 的 HTTP 语义（除了 `/healthz` 探活）。
 *
 * ## 为什么要 targetSdk=28
 *
 * Android 10+ 对 targetSdk≥29 的应用禁止在应用数据目录 `exec()`、也禁止 ptrace 子进程；
 * PRoot 两者都要。代价是上不了 Google Play（本项目 sideload）。所以 `files/bin` 里的
 * proot/node 能被 `ProcessBuilder` 直接执行，是整套方案的前提。
 *
 * ## 存储权限（不能悄悄降级）
 *
 * 项目目录应当落在 `/storage/emulated/0/codem/workspace`（用户在文件管理器里看得见）。
 * Android 11+ 需要「所有文件访问」（MANAGE_EXTERNAL_STORAGE），Android 6..10 需要
 * WRITE_EXTERNAL_STORAGE。**没授权时本类不启动 Host、也不偷偷回退私有目录**：
 * `start()` 返回 `{needsPermission:true,...}` 让 Dart 引导用户授权；只有 Dart 显式传
 * `allowPrivateFallback:true` 才用应用私有目录，并在返回值里如实标 `shared:false`。
 *
 * ## 凭据纪律
 *
 * apiKey 只在 `LlmSecretStore`（AndroidKeyStore + AES/GCM）与本类之间传递：
 * 不打印、不进异常 message、不进返回值、不写日志。返回给 Dart 的只有端口和 Host 令牌。
 */
public final class LocalHostRuntime {
    private static final String TAG = "CodemLocalHost";

    /** MethodChannel 名（与 Dart 侧一致） */
    public static final String CHANNEL = "codem/local_host";

    /** 本机运行时自己的偏好（与 Dart 的 shared_preferences 无关） */
    static final String PREFS = "codem_local_host";
    static final String KEY_PROJECT = "project";

    /** 首次解压完成的标记；内容 = 构建指纹（升级后要重解压） */
    static final String MARKER = ".runtime-ready";
    static final String LOG_NAME = "host.log";

    /** 共享工作区：`/storage/emulated/0/codem/workspace` */
    public static final String PERM_MANAGE = "manage_external_storage";
    public static final String PERM_WRITE = "write_external_storage";
    public static final String PERM_NONE = "none";

    private static volatile LocalHostRuntime instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final Object lock = new Object();

    private HostSupervisor supervisor;
    /** 上次 start 用的工作区根（授权状态变化后要换掉 supervisor） */
    private File supervisorWorkspaceBase;
    /** 保存过新配置（Key / base / model），下次 start 要重启 Host 才生效 */
    private boolean configDirty;
    /** 切换过项目，下次 start 要重启 Host 才生效 */
    private boolean workspaceDirty;
    private boolean keepAliveRunning;

    private LocalHostRuntime(Context appContext) {
        this.context = appContext;
        this.prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 进程级单例：Activity 重建后仍是同一份（Host 是进程级资源，见 HostSupervisor） */
    public static LocalHostRuntime get(Context context) {
        LocalHostRuntime local = instance;
        if (local != null) return local;
        synchronized (LocalHostRuntime.class) {
            local = instance;
            if (local == null) {
                local = new LocalHostRuntime(context.getApplicationContext());
                instance = local;
            }
            return local;
        }
    }

    /** 原生侧异常：`code` 直接映射成 Dart 的 `PlatformException.code`（message 里绝无 Key） */
    public static final class LocalHostException extends Exception {
        public final String code;

        public LocalHostException(String code, String message) {
            super(message);
            this.code = code;
        }

        public LocalHostException(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    // ===== 存储权限 / 工作区 =====

    public boolean hasManageAllFiles() {
        if (Build.VERSION.SDK_INT < 30) return false;
        try {
            return Environment.isExternalStorageManager();
        } catch (Throwable t) {
            return false;
        }
    }

    public boolean hasWritePermission() {
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Dart 引导授权时该走哪个入口（真的能不能写仍以 {@link #sharedWritable()} 为准） */
    public String requiredPermission() {
        if (Build.VERSION.SDK_INT >= 30) return PERM_MANAGE;
        if (Build.VERSION.SDK_INT >= 23 && Build.VERSION.SDK_INT <= 32) return PERM_WRITE;
        return PERM_NONE;
    }

    /**
     * 共享工作区现在**真的**可写吗：建目录 + 写探针文件 + 删除。
     *
     * 为什么不用 `isExternalStorageManager()` 单独判断：Android 11+ 对 targetSdk≤29 的
     * 应用仍保留 legacy 外部存储行为，此时只有 WRITE_EXTERNAL_STORAGE 也能写；反过来
     * 权限被厂商 ROM 改坏时标志会骗人。**实际写一次**才是真相。
     */
    public boolean sharedWritable() {
        File dir = WorkspacePaths.sharedRoot();
        if (dir == null) return false;
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) return false;
            File probe = new File(dir, ".codem-write-probe");
            if (!probe.createNewFile() && !probe.exists()) return false;
            boolean deleted = probe.delete();
            if (!deleted) Log.w(TAG, "workspace probe could not be removed");
            return dir.canWrite();
        } catch (Throwable t) {
            Log.w(TAG, "shared workspace not writable: " + t.getClass().getSimpleName());
            return false;
        }
    }

    private File privateWorkspace() {
        File dir = new File(new File(context.getFilesDir(), "data"), "workspace");
        mkdirs(dir);
        return dir;
    }

    private File workspaceBase(boolean shared) {
        if (shared) {
            File dir = WorkspacePaths.sharedRoot();
            if (dir != null) {
                mkdirs(dir);
                return dir;
            }
        }
        return privateWorkspace();
    }

    public String projectName() {
        return sanitizeProject(prefs.getString(KEY_PROJECT, ""));
    }

    /** 现在（或下次 start）会用的工作区绝对路径；已授权时为共享目录。 */
    public String workspacePath() {
        HostSupervisor current = supervisor;
        File base = current != null ? current.workspaceBase() : workspaceBase(sharedWritable());
        String name = current != null ? current.workspaceName() : projectName();
        return name.isEmpty() ? base.getAbsolutePath() : new File(base, name).getAbsolutePath();
    }

    /** 给 Dart 的存储状态（非秘密）：用来决定显示「去授权」还是正常工作。 */
    public Map<String, Object> storageState() {
        boolean shared = sharedWritable();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("granted", shared);
        out.put("permission", requiredPermission());
        out.put("manageAllFiles", hasManageAllFiles());
        out.put("writeGranted", hasWritePermission());
        out.put("shared", shared);
        out.put("apiLevel", Build.VERSION.SDK_INT);
        File sharedDir = WorkspacePaths.sharedRoot();
        out.put("sharedWorkspace", sharedDir == null ? "" : sharedDir.getAbsolutePath());
        out.put("privateWorkspace", privateWorkspace().getAbsolutePath());
        // 授权后**会**用的路径（Dart 在「去授权」提示里显示它，不能显示私有目录）
        out.put("intendedWorkspace", intendedWorkspacePath());
        out.put("workspace", shared
                ? joinPath(sharedDir != null ? sharedDir : privateWorkspace(), projectName())
                : joinPath(privateWorkspace(), projectName()));
        return out;
    }

    /** 有共享存储时是共享路径，否则是私有路径：给「授权后会用哪个目录」用。 */
    private String intendedWorkspacePath() {
        File sharedDir = WorkspacePaths.sharedRoot();
        File base = sharedDir != null ? sharedDir : privateWorkspace();
        return joinPath(base, projectName());
    }

    // ===== 模型配置 =====

    /** 保存模型配置（不启动 Host）。Key 走 Keystore 密文；异常 message 里不含 Key。 */
    public void saveModel(String baseUrl, String model, String apiKey) throws LlmSecretStore.SecretException {
        String base = trim(baseUrl);
        String name = trim(model);
        String key = trim(apiKey);
        if (base.isEmpty() && name.isEmpty() && key.isEmpty()) {
            throw new LlmSecretStore.SecretException("服务地址和模型名都不能为空");
        }
        if (!key.isEmpty()) LlmSecretStore.saveKey(prefs, key);
        if (!base.isEmpty() || !name.isEmpty()) {
            String nextBase = base.isEmpty() ? prefs.getString(LlmSecretStore.KEY_BASE, "") : base;
            String nextModel = name.isEmpty() ? prefs.getString(LlmSecretStore.KEY_MODEL, "") : name;
            if (!prefs.edit()
                    .putString(LlmSecretStore.KEY_BASE, nextBase)
                    .putString(LlmSecretStore.KEY_MODEL, nextModel)
                    .commit()) {
                throw new LlmSecretStore.SecretException("写入本机配置失败（磁盘可能已满）");
            }
        }
        LlmSecretStore.migrate(prefs);
        configDirty = true;
    }

    /** 摘要：**没有 Key 明文、没有长度、没有末四位**。 */
    public Map<String, Object> modelConfig() {
        String base = prefs.getString(LlmSecretStore.KEY_BASE, "");
        String model = prefs.getString(LlmSecretStore.KEY_MODEL, "");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("baseUrl", base);
        out.put("model", model);
        out.put("hasKey", LlmSecretStore.hasStoredKey(prefs));
        out.put("configured", !base.isEmpty() && !model.isEmpty());
        out.put("keyState", LlmSecretStore.state(prefs).wire);
        out.put("insecureHttp", base.startsWith("http://"));
        return out;
    }

    /** 把本次 start 传来的参数落盘；全空时用已保存的配置。 */
    private LlmConfig applyModel(String baseUrl, String model, String apiKey)
            throws LlmSecretStore.SecretException {
        String base = trim(baseUrl);
        String name = trim(model);
        String key = trim(apiKey);
        if (base.isEmpty() && name.isEmpty() && key.isEmpty()) {
            return LlmSecretStore.loadConfig(prefs);
        }
        if (!key.isEmpty()) LlmSecretStore.saveKey(prefs, key);
        if (!base.isEmpty() || !name.isEmpty()) {
            String nextBase = base.isEmpty() ? prefs.getString(LlmSecretStore.KEY_BASE, "") : base;
            String nextModel = name.isEmpty() ? prefs.getString(LlmSecretStore.KEY_MODEL, "") : name;
            prefs.edit()
                    .putString(LlmSecretStore.KEY_BASE, nextBase)
                    .putString(LlmSecretStore.KEY_MODEL, nextModel)
                    .commit();
        }
        configDirty = true;
        return LlmSecretStore.loadConfig(prefs);
    }

    // ===== 启动 / 停止 =====

    /**
     * 启动（或复用）本机 Host。
     *
     * @param allowPrivateFallback true = 用户已明确接受应用私有目录（文件管理器看不到项目）
     * @return 成功：`{url, token, workspace, project, shared, needsPermission:false}`；
     *         未授权且不允许回退：`{needsPermission:true, permission, workspace, storage}`
     */
    public Map<String, Object> start(String baseUrl, String model, String apiKey, boolean allowPrivateFallback)
            throws LlmSecretStore.SecretException, LocalHostException {
        synchronized (lock) {
            boolean shared = sharedWritable();
            if (!shared && !allowPrivateFallback) {
                Map<String, Object> denied = new LinkedHashMap<>();
                denied.put("needsPermission", true);
                denied.put("permission", requiredPermission());
                // 授权后会用到的共享路径（不是回退私有目录：Dart 要照着它提示用户）
                denied.put("workspace", intendedWorkspacePath());
                denied.put("project", projectName());
                denied.put("storage", storageState());
                Log.i(TAG, "start deferred: storage permission missing (" + requiredPermission() + ")");
                return denied;
            }

            LlmConfig config = applyModel(baseUrl, model, apiKey);
            ensureRuntimeInstalled();

            File workspaceBase = workspaceBase(shared);
            HostSupervisor sup;
            if (supervisor == null || supervisorWorkspaceBase == null
                    || !supervisorWorkspaceBase.getAbsolutePath().equals(workspaceBase.getAbsolutePath())) {
                if (supervisor != null) supervisor.stop(5_000);
                supervisor = new HostSupervisor(
                        context.getFilesDir(),
                        new File(context.getFilesDir(), "rootfs"),
                        new File(context.getFilesDir(), "app"),
                        new File(context.getFilesDir(), "data"),
                        workspaceBase,
                        new File(context.getFilesDir(), "libs"),
                        new File(context.getFilesDir(), "bin"));
                supervisorWorkspaceBase = workspaceBase;
            }
            sup = supervisor;
            sup.setWorkspace(projectName());
            startKeepAlive();

            File log = hostLog();
            try {
                if (HostSupervisor.healthy() && (configDirty || workspaceDirty)) {
                    // 配置/项目变了：只重启 Node Host（会话数据、rootfs、配对状态都不动）
                    sup.restart(config, log);
                    configDirty = false;
                    workspaceDirty = false;
                } else {
                    sup.ensureStarted(config, log);
                }
            } catch (IOException e) {
                // HostSupervisor 的消息本身是人话（不含 Key）；附上原因便于用户处理
                String reason = e.getMessage() == null ? "未知原因" : e.getMessage();
                throw new LocalHostException("host_failed",
                        "本机 Host 启动失败：" + reason + "（日志：files/host.log）", e);
            }
            if (!sup.waitHealthy(120_000)) {
                throw new LocalHostException("host_failed",
                        "本机 Host 未在 120 秒内就绪。日志：files/host.log");
            }
            HostSupervisor.Endpoint endpoint = HostSupervisor.endpoint();
            if (endpoint == null) {
                throw new LocalHostException("host_failed", "本机 Host 没有可用端点，请重试");
            }
            configDirty = false;
            workspaceDirty = false;

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("needsPermission", false);
            out.put("url", "http://127.0.0.1:" + endpoint.port);
            out.put("token", endpoint.token);
            out.put("workspace", workspacePath());
            out.put("project", sup.workspaceName());
            out.put("shared", shared);
            out.put("logPath", log.getAbsolutePath());
            return out;
        }
    }

    /** 停止本机 Host（连同它拉起的 codem-db）。返回 true = 已停干净。 */
    public boolean stop() throws LocalHostException {
        synchronized (lock) {
            boolean stopped = true;
            if (supervisor != null) stopped = supervisor.stop(8_000);
            stopKeepAlive();
            configDirty = false;
            workspaceDirty = false;
            if (!stopped) {
                throw new LocalHostException("host_failed",
                        "本机 Host 未能完全停止（端口仍在监听），请关闭应用后重新打开再试");
            }
            return true;
        }
    }

    public Map<String, Object> status() {
        synchronized (lock) {
            HostSupervisor.Endpoint endpoint = HostSupervisor.endpoint();
            boolean running = endpoint != null && HostSupervisor.healthy();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("running", running);
            if (running) {
                HostSupervisor current = supervisor;
                File base = current != null ? current.workspaceBase() : workspaceBase(sharedWritable());
                String name = current != null ? current.workspaceName() : projectName();
                out.put("url", "http://127.0.0.1:" + endpoint.port);
                out.put("token", endpoint.token);
                out.put("workspace", name.isEmpty()
                        ? base.getAbsolutePath()
                        : new File(base, name).getAbsolutePath());
                out.put("project", name);
                out.put("shared", WorkspacePaths.isShared(base));
            }
            out.put("storage", storageState());
            return out;
        }
    }

    // ===== 项目 =====

    /** 工作区下的目录名（含根 ""）。只读，不创建项目。 */
    public List<String> listProjects() {
        List<String> names = new ArrayList<>();
        File base = workspaceBase(sharedWritable());
        mkdirs(base);
        File[] children = base.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child == null || !child.isDirectory()) continue;
                String name = child.getName();
                if (name.startsWith(".")) continue;
                names.add(name);
            }
        }
        Collections.sort(names, String.CASE_INSENSITIVE_ORDER);
        List<String> out = new ArrayList<>(names.size() + 1);
        out.add("");
        out.addAll(names);
        return out;
    }

    /** 选择项目（空 = 工作区根）。只记录，下一次 start 生效。 */
    public boolean setProject(String name) {
        String value = sanitizeProject(name);
        prefs.edit().putString(KEY_PROJECT, value).commit();
        HostSupervisor current = supervisor;
        if (current != null && !current.workspaceName().equals(value)) workspaceDirty = true;
        return true;
    }

    // ===== 运行时安装 =====

    private File hostLog() {
        return new File(context.getFilesDir(), LOG_NAME);
    }

    private void startKeepAlive() {
        try {
            context.startForegroundService(
                    new android.content.Intent(context, io.codem.codem_mobile.LocalHostKeepAliveService.class));
            keepAliveRunning = true;
        } catch (Throwable t) {
            // 通知权限/厂商限制不该阻断 Host 启动；只记录类型
            Log.w(TAG, "keep-alive service failed: " + t.getClass().getSimpleName());
        }
    }

    private void stopKeepAlive() {
        if (!keepAliveRunning) return;
        try {
            context.stopService(
                    new android.content.Intent(context, io.codem.codem_mobile.LocalHostKeepAliveService.class));
        } catch (Throwable t) {
            Log.w(TAG, "keep-alive stop failed: " + t.getClass().getSimpleName());
        }
        keepAliveRunning = false;
    }

    // ===== 调试：PRoot 内的 DNS / HTTPS 探针（仅 debuggable 构建由 Kotlin 侧调用） =====

    /**
     * 在 PRoot 里跑一段 Node 脚本，验证 **rootfs 内的 DNS 与出网**是否真的可用。
     *
     * 为什么需要它：手机里模型请求由 PRoot 里的 Node 发出，DNS 读的是 rootfs 的
     * `/etc/resolv.conf`（Ubuntu base 默认指向 systemd-resolved，不存在 ⇒ 必须覆写）。
     * Host `/healthz` 只证明 Node 起来了，**不证明能出网**；这条探针补上那段证据。
     *
     * 不发送任何凭据：只请求 `https://<host>/v1/models` 且不带 Authorization，
     * 401/403 也算「DNS+TCP+TLS 通」。
     *
     * @return 可读的多行结果（失败也返回诊断，不抛异常：设备用例要看输出）
     */
    public String netCheck(String host) {
        String target = host == null || host.trim().isEmpty() ? "api.aicodewith.ai" : host.trim();
        StringBuilder result = new StringBuilder();
        File files = context.getFilesDir();
        File root = new File(files, "rootfs");
        File bin = new File(files, "bin");
        File libs = new File(files, "libs");
        File tmp = new File(files, "tmp");
        if (!new File(bin, "node").isFile() || !new File(bin, "proot").isFile()) {
            return "netcheck=SKIP runtime-not-installed";
        }
        String js = "const dns=require('dns');"
                + "const host='" + target + "';"
                + "dns.lookup(host,(e,a)=>{"
                + "if(e){console.log('dns=FAIL '+e.code);process.exit(2);}"
                + "console.log('dns=OK '+a);"
                + "const t=Date.now();"
                + "fetch('https://'+host+'/v1/models',{method:'GET'})"
                + ".then(r=>{console.log('https=OK status='+r.status+' ms='+(Date.now()-t));process.exit(0);},"
                + "x=>{console.log('https=FAIL '+x.message+' ms='+(Date.now()-t));process.exit(3);});});";
        java.util.List<String> cmd = new java.util.ArrayList<>();
        cmd.add(new File(bin, "proot").getAbsolutePath());
        cmd.add("-0");
        cmd.add("-r");
        cmd.add(root.getAbsolutePath());
        cmd.add("-b");
        cmd.add("/dev");
        cmd.add("-b");
        cmd.add("/proc");
        cmd.add("-b");
        cmd.add("/sys");
        cmd.add("-b");
        cmd.add(bin.getAbsolutePath() + ":/opt/bin");
        cmd.add("-b");
        cmd.add(new File(files, "data").getAbsolutePath() + ":/opt/data");
        cmd.add("-w");
        cmd.add("/");
        cmd.add("--link2symlink");
        cmd.add("-L");
        cmd.add("/usr/bin/env");
        cmd.add("PATH=/usr/bin:/bin");
        cmd.add("/opt/bin/node");
        cmd.add("-e");
        cmd.add(js);
        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.environment().put("PROOT_LOADER", new File(bin, "proot_loader").getAbsolutePath());
            pb.environment().put("PROOT_TMP_DIR", tmp.getAbsolutePath());
            pb.environment().put("LD_LIBRARY_PATH", libs.getAbsolutePath() + ":" + bin.getAbsolutePath());
            pb.redirectErrorStream(true);
            process = pb.start();
            final Process target2 = process;
            final StringBuilder out = new StringBuilder();
            Thread reader = new Thread(() -> {
                try (InputStream in = target2.getInputStream()) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) > 0) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                } catch (IOException ignored) {
                    /* 进程结束 */
                }
            }, "codem-netcheck-reader");
            reader.start();
            boolean done = process.waitFor(60, TimeUnit.SECONDS);
            if (!done) process.destroyForcibly();
            reader.join(3_000);
            result.append("netcheck host=").append(target)
                    .append(" exit=").append(done ? process.exitValue() : "timeout")
                    .append(" output=").append(out.toString().trim().replace('\n', ' '));
        } catch (Throwable t) {
            result.append("netcheck=ERROR ").append(t.getClass().getSimpleName());
            if (process != null) process.destroyForcibly();
        }
        return result.toString();
    }

    /** 首次（或 APK 升级后）解压 rootfs、装 Host/UI/共享库、装可执行文件。 */
    private void ensureRuntimeInstalled() throws LocalHostException {
        File files = context.getFilesDir();
        File root = new File(files, "rootfs");
        File app = new File(files, "app");
        File libs = new File(files, "libs");
        File bin = new File(files, "bin");
        mkdirs(new File(files, "tmp"));
        mkdirs(new File(files, "data"));

        String stamp = buildStamp();
        File marker = new File(files, MARKER);
        boolean installed = marker.isFile() && stamp.equals(readMarker(marker));
        try {
            if (!installed) {
                Log.i(TAG, "installing local runtime (stamp=" + stamp + ")");
                if (!hasRootfsAsset() || !assetExists("host.mjs")) {
                    throw new LocalHostException("runtime_failed",
                            "APK 内缺少本机运行时资产（rootfs.tar.gz / host.mjs），请重新安装应用");
                }
                mkdirs(root);
                extractRootfs(root);
                mkdirs(app);
                mkdirs(new File(app, "web"));
                copyAsset("host.mjs", new File(app, "host.mjs"));
                if (assetExists("web/index.html")) copyAsset("web/index.html", new File(app, "web/index.html"));
                if (assetExists("web/ui.js")) copyAsset("web/ui.js", new File(app, "web/ui.js"));
                if (assetExists("web/ui.css")) copyAsset("web/ui.css", new File(app, "web/ui.css"));
                mkdirs(libs);
                copyAssetIfPresent("libtalloc.so.2", new File(libs, "libtalloc.so.2"));
                copyAssetIfPresent("libandroid-shmem.so", new File(libs, "libandroid-shmem.so"));
                if (!marker.createNewFile() && !marker.isFile()) {
                    throw new IOException("无法写入运行时标记：" + marker.getAbsolutePath());
                }
                writeMarker(marker, stamp);
            }

            // rootfs 之外的共享库（每次启动都补齐：文件可能被清理/升级换过）
            copyGuestLib(root, "libstdc++.so.6",
                    "usr/lib/x86_64-linux-gnu/libstdc++.so.6",
                    "usr/lib/aarch64-linux-gnu/libstdc++.so.6");
            copyGuestLib(root, "libtinfo.so.6",
                    "usr/lib/x86_64-linux-gnu/libtinfo.so.6",
                    "usr/lib/aarch64-linux-gnu/libtinfo.so.6");
            copyGuestLib(root, "ca-certificates.crt", "etc/ssl/certs/ca-certificates.crt");
            writeDnsConfig(root);
            installExes(bin);
            seedWelcome(root, bin, libs);
        } catch (LocalHostException e) {
            throw e;
        } catch (Exception e) {
            // 不把异常里的路径细节当"用户可读原因"；日志留类型 + 简短原因
            Log.e(TAG, "runtime install failed: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            throw new LocalHostException("runtime_failed",
                    "本机运行时解压失败，请重新打开应用重试", e);
        }
    }

    /** 构建指纹：版本 + ABI + host.mjs 大小。变化 ⇒ 重解压（保留 data 目录）。 */
    private String buildStamp() {
        long hostLength = -1;
        try (InputStream in = context.getAssets().open("host.mjs")) {
            hostLength = in.available();
        } catch (Throwable ignored) {
            /* 资产缺失时 ensureRuntimeInstalled 会明确报错 */
        }
        String version = "?";
        try {
            version = String.valueOf(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionCode);
        } catch (Throwable ignored) {
            /* 拿不到版本号不影响解压 */
        }
        return version + ":" + primaryAbi() + ":" + hostLength;
    }

    private static String readMarker(File marker) {
        try {
            byte[] raw = Files.readAllBytes(marker.toPath());
            return new String(raw, StandardCharsets.UTF_8).trim();
        } catch (Throwable t) {
            return "";
        }
    }

    private static void writeMarker(File marker, String stamp) {
        try {
            Files.write(marker.toPath(), stamp.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            Log.w(TAG, "write runtime marker failed: " + t.getClass().getSimpleName());
        }
    }

    /** 设备主 ABI（x86_64 / arm64-v8a ...），日志与打包自检用。 */
    private static String primaryAbi() {
        String[] abis = Build.SUPPORTED_ABIS;
        return abis != null && abis.length > 0 ? abis[0] : "unknown";
    }

    /**
     * 可执行文件：从 `nativeLibraryDir`（安装时由系统解出，**可执行**）复制到 `files/bin`。
     *
     * 为什么必须走 `lib/<abi>/lib*.so` 而不是 assets：AGP 只保证 nativeLibraryDir 里的
     * 文件有可执行位；assets 解出来的文件在 targetSdk≥29 上根本不能让内核 exec（我们的
     * targetSdk=28 虽然允许，但保持与 android-shell 同一条已验证路径更稳）。
     */
    private void installExes(File bin) throws LocalHostException {
        mkdirs(bin);
        String nativeDir = context.getApplicationInfo().nativeLibraryDir;
        String[] names = {"libproot.so", "libproot_loader.so", "libcodem_db.so", "libnode.so"};
        for (String name : names) {
            File src = new File(nativeDir, name);
            if (!src.isFile()) {
                throw new LocalHostException("runtime_failed",
                        "APK 未包含 " + name + "（设备 ABI：" + primaryAbi() + "），请安装匹配 ABI 的安装包");
            }
            File dst = new File(bin, name.substring("lib".length(), name.length() - ".so".length()));
            try {
                if (!dst.isFile() || dst.length() != src.length()) {
                    copyFile(src, dst);
                }
                if (!dst.setExecutable(true, false) && !dst.canExecute()) {
                    throw new IOException("chmod failed: " + dst.getAbsolutePath());
                }
            } catch (IOException e) {
                throw new LocalHostException("runtime_failed",
                        "无法安装本机运行时可执行文件（存储空间不足？）", e);
            }
        }
    }

    /**
     * 首次写一个欢迎会话（库为空时才写）。**走 proot**：静态 musl 的 codem_db 在 app 进程
     * 的原生 exec 会 SIGSYS（seccomp）。
     *
     * 失败只告警不阻断：欢迎会话不是启动前提。
     */
    private void seedWelcome(File root, File bin, File libs) {
        File db = new File(new File(context.getFilesDir(), "data"), "codem-db-rust.bin");
        if (db.exists()) return;
        try {
            prootDb(root, bin, libs, "sessions.upsert",
                    "{\"id\":\"welcome\",\"project_id\":\"\",\"title\":\"欢迎使用 Codem\",\"created_at\":"
                            + System.currentTimeMillis() + "}");
            prootDb(root, bin, libs, "messages.create",
                    "{\"id\":\"welcome-m1\",\"session_id\":\"welcome\",\"role\":\"assistant\",\"content\":"
                            + "\"这是手机本机上的 Codem。模型与凭据在设置里配置；项目文件放在本机工作区。\","
                            + "\"timestamp\":" + (System.currentTimeMillis() + 1) + "}");
        } catch (Throwable t) {
            Log.w(TAG, "seed welcome failed: " + t.getClass().getSimpleName());
        }
    }

    private void prootDb(File root, File bin, File libs, String command, String json) throws IOException {
        File data = new File(context.getFilesDir(), "data");
        ProcessBuilder pb = new ProcessBuilder(
                new File(bin, "proot").getAbsolutePath(), "-0",
                "-r", root.getAbsolutePath(),
                "-b", "/dev", "-b", "/proc", "-b", "/sys",
                "-b", bin.getAbsolutePath() + ":/opt/bin",
                "-b", data.getAbsolutePath() + ":/opt/data",
                "-w", "/", "--link2symlink", "-L",
                "/opt/bin/codem_db", "--db", "/opt/data/codem-db-rust.bin", "invoke", command, "-");
        pb.environment().put("PROOT_LOADER", new File(bin, "proot_loader").getAbsolutePath());
        pb.environment().put("PROOT_TMP_DIR", new File(context.getFilesDir(), "tmp").getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", libs.getAbsolutePath() + ":" + bin.getAbsolutePath());
        pb.redirectErrorStream(true);
        Process process = pb.start();
        StringBuilder out = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (InputStream stdout = process.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = stdout.read(buf)) > 0) out.append(new String(buf, 0, n, StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                /* 进程结束 */
            }
        }, "codem-seed-reader");
        reader.start();
        try (OutputStream stdin = process.getOutputStream()) {
            stdin.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "seed stdin failed: " + e.getMessage());
        }
        try {
            boolean finished = process.waitFor(60, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                Log.w(TAG, "seed " + command + " timeout");
            }
            reader.join(3_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        Log.i(TAG, "seed " + command + " done");
    }

    private static void copyFile(File src, File dst) throws IOException {
        File parent = dst.getParentFile();
        if (parent != null) mkdirs(parent);
        try (InputStream in = new BufferedInputStream(new java.io.FileInputStream(src));
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    // ===== assets / tar =====

    private boolean assetExists(String name) {
        try (InputStream in = context.getAssets().open(name)) {
            return in != null;
        } catch (IOException e) {
            return false;
        }
    }

    private void copyAssetIfPresent(String name, File dst) throws IOException {
        if (assetExists(name)) copyAsset(name, dst);
    }

    private void copyGuestLib(File root, String assetName, String... relativePaths) throws IOException {
        if (!assetExists(assetName)) return;
        for (String rel : relativePaths) {
            File dst = new File(root, rel);
            if (dst.exists()) continue;
            File parent = dst.getParentFile();
            if (parent == null) continue;
            mkdirs(parent);
            try (InputStream in = new BufferedInputStream(context.getAssets().open(assetName));
                 OutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
    }

    /**
     * rootfs 的 resolv.conf 指向 systemd-resolved（不存在）⇒ 用 Android 当前网络的 DNS 覆写。
     *
     * 两件事必须**分开**做：
     * 1. 写文件：Go/Node 的 DNS 解析都读它，写失败 = 手机里访问不了模型 API；
     * 2. 读当前网络 DNS：`getActiveNetwork()` 需要 `ACCESS_NETWORK_STATE`，缺权限会抛
     *    `SecurityException`（实测：早期版本把它和写文件放进同一个 try，结果文件根本没写成）。
     *    ⇒ 写在前面，读 DNS 单独 try，读不到就用公共 DNS 兜底。
     */
    private void writeDnsConfig(File root) {
        File etc = new File(root, "etc");
        mkdirs(etc);
        File resolv = new File(etc, "resolv.conf");
        String dns = "";
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network net = cm != null ? cm.getActiveNetwork() : null;
            LinkProperties lp = net != null && cm != null ? cm.getLinkProperties(net) : null;
            if (lp != null) {
                StringBuilder sb = new StringBuilder();
                for (java.net.InetAddress d : lp.getDnsServers()) {
                    if (d != null && d.getHostAddress() != null) {
                        sb.append("nameserver ").append(d.getHostAddress()).append("\n");
                    }
                }
                dns = sb.toString();
            }
        } catch (Throwable t) {
            // 缺 ACCESS_NETWORK_STATE / 无活动网络：不致命，下面用公共 DNS 兜底
            Log.w(TAG, "read network dns failed: " + t.getClass().getSimpleName());
        }
        if (dns.isEmpty()) dns = "nameserver 8.8.8.8\nnameserver 1.1.1.1\n";
        try (OutputStream out = new FileOutputStream(resolv, false)) {
            out.write(dns.getBytes(StandardCharsets.UTF_8));
        } catch (Throwable t) {
            // 只记类型：路径与内容是设备信息，不进用户可见文案
            Log.w(TAG, "write resolv.conf failed: " + t.getClass().getSimpleName());
        }
    }

    private void copyAsset(String name, File dst) throws IOException {
        File parent = dst.getParentFile();
        if (parent != null) mkdirs(parent);
        try (InputStream in = new BufferedInputStream(context.getAssets().open(name), 64 * 1024);
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /**
     * AGP 的 `mergeDebugAssets` 会把**以 `.gz` 结尾**的资产**解压并改名**（`rootfs.tar.gz`
     * 会变成 `rootfs.tar`，实测 AGP 9.1）。所以这里两个名字都认，并按魔数判断是不是 gzip，
     * 不能假设资产在 APK 里仍是压缩的。
     */
    private boolean hasRootfsAsset() {
        return assetExists("rootfs.tar.gz") || assetExists("rootfs.tar");
    }

    private void extractRootfs(File dest) throws IOException {
        mkdirs(dest);
        String chosen = assetExists("rootfs.tar.gz") ? "rootfs.tar.gz" : "rootfs.tar";
        try (java.io.PushbackInputStream probe = new java.io.PushbackInputStream(
                new BufferedInputStream(context.getAssets().open(chosen), 64 * 1024), 2)) {
            int b1 = probe.read();
            int b2 = probe.read();
            if (b2 >= 0) probe.unread(b2);
            if (b1 >= 0) probe.unread(b1);
            InputStream tar = (b1 == 0x1f && b2 == 0x8b)
                    ? new java.util.zip.GZIPInputStream(probe, 64 * 1024)
                    : probe;
            untar(tar, dest.toPath());
        }
    }

    /** 极简 tar 解析：普通文件 / 目录 / 符号链接 / 硬链接 / PAX 扩展头（path= / linkpath=） */
    private void untar(InputStream in, Path dest) throws IOException {
        byte[] header = new byte[512];
        long total = 0;
        long lastLog = 0;
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
            long now = System.currentTimeMillis();
            if (now - lastLog > 5_000) {
                lastLog = now;
                Log.i(TAG, "extracting rootfs: " + (total / (1024 * 1024)) + " MB");
            }

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

            if (paxPath != null) {
                name = paxPath;
                paxPath = null;
            }
            if (paxLink != null) {
                link = paxLink;
                paxLink = null;
            }

            Path target = dest.resolve(name).normalize();
            if (!target.startsWith(dest)) {
                skip(in, size);
                continue;
            }

            switch (type) {
                case '5':
                    Files.createDirectories(target);
                    break;
                case '2':
                    mkdirs(target.getParent().toFile());
                    try { Files.deleteIfExists(target); } catch (IOException ignored) { }
                    // tar 里的相对链接相对于条目所在目录；绝对链接映射进 rootfs
                    Path linkPath = Paths.get(link);
                    Path linkTarget = linkPath.isAbsolute()
                            ? dest.resolve(link.substring(1)).normalize()
                            : target.getParent().resolve(link).normalize();
                    if (!linkTarget.startsWith(dest)) {
                        Log.w(TAG, "symlink escapes rootfs: " + name);
                        break;
                    }
                    try {
                        Files.createSymbolicLink(target, linkTarget);
                    } catch (Exception e) {
                        Log.w(TAG, "symlink failed: " + name);
                    }
                    break;
                case '1':
                    mkdirs(target.getParent().toFile());
                    try {
                        Files.createLink(target, dest.resolve(link));
                    } catch (Exception e) {
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
            // 权限位失败不影响使用（PRoot 用 -0 伪装 root）
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
            if (n <= 0) {
                in.read();
                n = 1;
            }
            pad -= n;
        }
    }

    private static void skip(InputStream in, long size) throws IOException {
        long left = size;
        while (left > 0) {
            long n = in.skip(left);
            if (n <= 0) {
                in.read();
                n = 1;
            }
            left -= n;
        }
        skipPadding(in, size);
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
        try {
            return Long.parseLong(s, 8);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static boolean allZero(byte[] b) {
        for (byte x : b) if (x != 0) return false;
        return true;
    }

    // ===== 小工具 =====

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    /** 项目名白名单：与 HostSupervisor.setWorkspace 的正则一致；非法/缺省 = 根工作区。 */
    private static String sanitizeProject(String name) {
        String value = trim(name);
        return value.matches("[\\p{L}\\p{N}._-]{1,64}") ? value : "";
    }

    private static String joinPath(File base, String name) {
        return name.isEmpty() ? base.getAbsolutePath() : new File(base, name).getAbsolutePath();
    }

    private static void mkdirs(File dir) {
        if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "mkdirs failed: " + dir);
        }
    }

    /** 仅调试：是否 debuggable 构建（生产路径不依赖它） */
    public boolean isDebuggable() {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
