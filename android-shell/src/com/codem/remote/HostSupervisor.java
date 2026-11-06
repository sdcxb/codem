package com.codem.remote;

import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * 本机 Host 的进程管理：**启动 / 停止 / 重启**（设置保存后要用）。
 *
 * ## 为什么不用 `am force-stop`
 *
 * force-stop 会连 Activity、WebView、CookieManager 一起杀掉：`onPause` 里的 cookie 落盘
 * 不保证被回调（`MainActivity.onPause` 的注释写了这条），⇒ 可能掉配对；还要重新解压/探活。
 * **只重启 Node Host** 就够：会话数据在 `files/data`（库 + JSONL）不动，配对 cookie 不动，
 * PRoot/rootfs 不动。
 *
 * ## 停的纪律
 *
 * 1. 先 `SIGTERM` 给找到的 Host 进程（Host 自己会 `server.close → pairing.close → runtime.close`，
 *    即中断在飞回合 + 关 DB）；
 * 2. 等端口不再应答、/proc 里也没有 host.mjs；
 * 3. 还不死 ⇒ `SIGKILL`（深→浅）+ `destroyForcibly()`；
 * 4. **仍不干净就报错，绝不启动第二个 Host**：两个 Host 抢同一个库/`pairing.json.lock`
 *    比"设置没生效"严重得多。
 *
 * 进程发现不依赖 `Process` 句柄：Activity 被系统回收后句柄会丢，但 Host 还活着
 * （前台服务）。所以按 `/proc/<pid>/cmdline` + 同 UID 过滤来找 —— 只能看到自己 UID 的进程，
 * 不会误杀别人的同名进程。
 */
final class HostSupervisor {
    private static final String TAG = "CodemHost";

    private static final int SIGTERM = 15;
    private static final int SIGKILL = 9;
    /** host.mjs 的 guest 路径：proot 包装与 node 的 argv 里都会出现 */
    private static final String HOST_MARKER = "/opt/app/host.mjs";
    /** codem-db 的 guest 路径（`CODEM_DB_BIN` 也会出现在 proot 的 argv 里，一并算进来） */
    private static final String DB_MARKER = "/opt/bin/codem_db";

    /**
     * 每次启动的端点：随机端口 + 随机本机凭据。
     *
     * 为什么端口随机：固定 8787 让"同机的任意进程"不用猜就能找到 Host；
     * 真正的安全边界是 256 位凭据，端口随机只抬高盲扫成本（两者分开验证）。
     */
    static final class Endpoint {
        final int port;
        /** 64 位小写 hex；只在内存/环境变量里，绝不进 argv、日志、prefs、URL 查询串 */
        final String token;

        Endpoint(int port, String token) {
            this.port = port;
            this.token = token;
        }
    }

    /**
     * 当前端点。**进程级（static）**：Activity 被重建后新实例仍要能用同一个 Host，
     * 否则会以为"Host 没起来"再起第二个（两个 Host 抢 pairing.json.lock ⇒ 双失败）。
     * 进程死亡时 Host 子进程一起死 ⇒ 天然轮换端口与凭据。
     */
    private static volatile Endpoint endpoint;

    /** 启动失败（端口/绑定/配置）时的重试次数：每次新端口 + 新凭据 */
    private static final int MAX_START_ATTEMPTS = 3;
    /** 单次启动的健康等待（每次重试都等它；总预算仍在外层的 120s 内） */
    private static final long START_HEALTH_TIMEOUT_MS = 30_000;

    private static final SecureRandom RANDOM = new SecureRandom();

    private final File root;
    private final File app;
    private final File data;
    private final File libs;
    private final File bin;
    private final File tmp;
    private final Object lock = new Object();
    private Process process;
    private boolean restarting;
    /** 当前项目工作区名（相对 `data/workspace`；空 = 工作区根） */
    private volatile String workspaceName = "";

    HostSupervisor(File files, File root, File app, File data, File libs, File bin) {
        this.root = root;
        this.app = app;
        this.data = data;
        this.libs = libs;
        this.bin = bin;
        this.tmp = new File(files, "tmp");
    }

    /** 当前端点（没有 = 还没起过 / 已停干净）。Activity 用它在 UI 线程拼页面 URL。 */
    static Endpoint endpoint() {
        return endpoint;
    }

    /** `/healthz` 探活：连接被拒/非 200 都算没起来（没有端点时直接 false） */
    static boolean healthy() {
        Endpoint ep = endpoint;
        if (ep == null) return false;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + ep.port + "/healthz").openConnection();
            c.setConnectTimeout(600);
            c.setReadTimeout(600);
            c.setRequestMethod("GET");
            return c.getResponseCode() == 200;
        } catch (Throwable t) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    boolean waitHealthy(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (healthy()) return true;
            sleep(500);
        }
        return false;
    }

    /** 切换项目工作区（下次 start/restart 生效）。非法名回落到根工作区。 */
    void setWorkspace(String name) {
        String value = name == null ? "" : name.trim();
        this.workspaceName = value.matches("[\\p{L}\\p{N}._-]{1,64}") ? value : "";
    }

    private String workspaceGuestPath() {
        return workspaceName.isEmpty()
                ? "/opt/data/workspace"
                : "/opt/data/workspace/" + workspaceName;
    }

    private File workspacePhoneDir() {
        return workspaceName.isEmpty()
                ? new File(data, "workspace")
                : new File(new File(data, "workspace"), workspaceName);
    }

    /** 已经在跑就直接返回；否则拉起一个新 Host（单飞：并发调用只有一个会真的 start） */
    void ensureStarted(LlmConfig config, File log) throws IOException {
        synchronized (lock) {
            if (healthy()) return;
            // 已经有个进程在起（还没健康）：不要起第二个，让上层的 waitHealthy 去判定
            if (process != null && process.isAlive()) return;
            startLocked(config, log);
        }
    }

    /**
     * 停止本机 Host（含它拉起的 codem-db）。
     *
     * @return true = 端口已关闭且找不到 Host 进程（可以安全地起新的）
     */
    boolean stop(long graceMs) {
        synchronized (lock) {
            List<Integer> pids = findOwnPids();
            Process current = process;
            process = null;
            if (pids.isEmpty() && current == null && !healthy()) {
                // 已经没在跑：端点也必须清掉（否则下一次 ensureStarted 会以为还活着）
                endpoint = null;
                return true;
            }

            // 1) 先礼：SIGTERM 所有 Host 进程（node 会走优雅关闭，连带关掉 DB）
            for (int pid : pids) signal(pid, SIGTERM);
            if (current != null) current.destroy();
            if (waitStopped(graceMs)) {
                endpoint = null;
                return true;
            }

            // 2) 后兵：SIGKILL（先杀子进程：DB 先走，避免它继续占着库）
            for (int pid : killOrder(pids)) signal(pid, SIGKILL);
            if (current != null) current.destroyForcibly();
            boolean stopped = waitStopped(2_000);
            // 没停干净时**保留**端点：旧的 Host 可能仍在旧端口上服务，报"已停"会把后续判断带偏
            if (stopped) endpoint = null;
            return stopped;
        }
    }

    /**
     * 重启：停干净 → 用新配置起。
     *
     * 单飞：`restarting` 期间重复调用直接抛错（UI 会看到明确提示），而不是排队起第二个。
     * 停不干净时抛 {@link IOException}，调用方**必须**把这句话原样显示给用户。
     */
    void restart(LlmConfig config, File log) throws IOException {
        synchronized (lock) {
            if (restarting) throw new IOException("正在重启中，请稍候");
            restarting = true;
            try {
                if (!stop(5_000)) {
                    throw new IOException("旧的本机 Host 未能停止（端口仍在监听），请关闭应用后重新打开再试");
                }
                startLocked(config, log);
            } finally {
                restarting = false;
            }
        }
    }

    // ===== 启动 =====

    private void startLocked(LlmConfig config, File log) throws IOException {
        mkdirs(tmp);
        /*
         * 端点未知但仍有本 App 的 Host 进程（Activity 被回收后端点丢失的最坏形态）：
         * 先停干净再起。否则两个 Host 会抢同一个库与 `pairing.json.lock`，
         * 症状是"设置保存后 Host 再也起不来"，而日志里只有一句锁失败。
         */
        if (endpoint == null && !findOwnPids().isEmpty()) {
            if (!stop(3_000)) {
                throw new IOException("检测到上一轮的本机 Host 仍在运行且无法停止，请重新打开应用后再试");
            }
        }
        IOException last = null;
        for (int attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
            int port = pickFreePort();
            String token = newLocalAuthToken();
            endpoint = new Endpoint(port, token);
            Process started;
            try {
                started = launch(config, log, port, token);
            } catch (IOException e) {
                // 起不来（proot/node 缺失等）：端点不能留下，否则后续会以为"有 Host 但探活失败"
                endpoint = null;
                throw e;
            }
            process = started;
            if (waitHealthy(START_HEALTH_TIMEOUT_MS)) {
                // 只报端口：它不秘密，且设备用例要靠它建立 adb forward
                Log.i(TAG, "host ready port=" + port);
                return;
            }
            last = new IOException("本机 Host 第 " + attempt + " 次启动未就绪（端口 " + port + "，查看 filesDir/host.log）");
            Log.w(TAG, "host start attempt " + attempt + " failed (port=" + port + ")");
            stop(2_000);
            endpoint = null;
            process = null;
        }
        throw last == null ? new IOException("本机 Host 未能启动") : last;
    }

    /** 内核分配一个 loopback 空闲端口（读完立刻关：Host 自己去 bind 同一个端口）。 */
    private static int pickFreePort() throws IOException {
        ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        try {
            return socket.getLocalPort();
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                /* 已经读到了端口，关失败不影响 */
            }
        }
    }

    /** 32 字节 SecureRandom → 64 位小写 hex（与 Host 的 local-auth 校验同形）。 */
    private static String newLocalAuthToken() {
        byte[] raw = new byte[32];
        RANDOM.nextBytes(raw);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : raw) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16));
            sb.append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    private Process launch(LlmConfig config, File log, int port, String token) throws IOException {
        /*
         * 本机项目工作区必须是**持久数据目录**，不能再用打包的 web 资源目录：
         * 后者是 Host 自己服务的页面，用户项目写进去会被升级/重建覆盖，也不是"手机本地项目"。
         */
        File workspace = workspacePhoneDir();
        if (!workspace.exists() && !workspace.mkdirs()) {
            throw new IOException("无法创建本机工作区：" + workspace.getAbsolutePath());
        }
        List<String> cmd = new ArrayList<>(Arrays.asList(
                new File(bin, "proot").getAbsolutePath(),
                "-0",
                "-r", root.getAbsolutePath(),
                "-b", "/dev", "-b", "/proc", "-b", "/sys",
                "-b", bin.getAbsolutePath() + ":/opt/bin",
                "-b", app.getAbsolutePath() + ":/opt/app",
                "-b", data.getAbsolutePath() + ":/opt/data",
                "-w", "/root",
                "--link2symlink",
                "-L",
                "/usr/bin/env",
                "PATH=/usr/bin:/bin",
                "CODEM_DB_BIN=/opt/bin/codem_db",
                "/opt/bin/node",
                "/opt/app/host.mjs", "serve",
                "--data-home", "/opt/data",
                "--workspace", workspaceGuestPath(),
                "--web", "/opt/app/web",
                "--port", String.valueOf(port)));
        boolean viaStdin = config != null && config.usable();
        if (viaStdin) {
            // Key 走 stdin：进程环境里没有 CODEM_LLM_*，`/proc/<pid>/environ` 与工具子进程都拿不到
            cmd.add("--llm-stdin");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.environment().put("PROOT_LOADER", new File(bin, "proot_loader").getAbsolutePath());
        pb.environment().put("PROOT_TMP_DIR", tmp.getAbsolutePath());
        pb.environment().put("LD_LIBRARY_PATH", libs.getAbsolutePath() + ":" + bin.getAbsolutePath());
        /*
         * 本机凭据经**环境变量**交给 Host，不进 argv（`/proc/<pid>/cmdline` 是同 UID 可读的）。
         * Host 解析完会立刻 `delete process.env.CODEM_HOST_LOCAL_AUTH`，避免工具子进程继承。
         * 残余面：`/proc/<pid>/environ` 仍能看到 execve 初始块（与桌面控制令牌同一现状）。
         */
        pb.environment().put("CODEM_HOST_AUTH", "local-auth");
        pb.environment().put("CODEM_HOST_LOCAL_AUTH", token);
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log));
        Process started = pb.start();
        if (viaStdin) {
            try {
                writeConfigLine(started, config);
            } catch (IOException e) {
                // 配置没送进去 ⇒ 这个进程只会以"无模型"起（或者已经死了）：杀掉，别留半套
                try { started.destroyForcibly(); } catch (Throwable ignored) { }
                throw e;
            }
        } else {
            closeQuietly(started.getOutputStream());
        }
        Log.i(TAG, "host started (llm=" + (viaStdin ? "stdin" : "none") + ", port=" + port + ")");
        return started;
    }

    /**
     * 向 Host 的 stdin 写**一行** JSON 后关闭。
     *
     * 写完立刻关：Host 读到行就 `rl.close()`，之后 stdin 不再被使用；不关会让
     * `process.getOutputStream()` 一直挂着（进程退出时才释放）。
     */
    private static void writeConfigLine(Process target, LlmConfig config) throws IOException {
        String line = "{\"baseUrl\":" + LlmConfig.jsonQuote(config.baseUrl)
                + ",\"model\":" + LlmConfig.jsonQuote(config.model)
                + ",\"apiKey\":" + LlmConfig.jsonQuote(config.apiKey) + "}\n";
        try (OutputStream stdin = target.getOutputStream()) {
            stdin.write(line.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        } catch (IOException e) {
            // 配置没送进去 = Host 起不来或起在无模型状态；必须让调用方知道（不打印内容）
            throw new IOException("无法把模型配置交给本机 Host", e);
        }
    }

    // ===== 停止 =====

    private boolean waitStopped(long graceMs) {
        long deadline = System.currentTimeMillis() + Math.max(200, graceMs);
        while (System.currentTimeMillis() < deadline) {
            boolean alive = healthy() || !findOwnPids().isEmpty();
            Process current = process;
            if (current != null && current.isAlive()) alive = true;
            if (!alive) return true;
            sleep(150);
        }
        return !healthy() && findOwnPids().isEmpty();
    }

    /** 深→浅：pid 越大越可能是后来 fork 的（DB 通常比 node 晚起） */
    private static List<Integer> killOrder(List<Integer> pids) {
        List<Integer> ordered = new ArrayList<>(pids);
        ordered.sort(Comparator.reverseOrder());
        return ordered;
    }

    private static void signal(int pid, int sig) {
        try {
            android.os.Process.sendSignal(pid, sig);
        } catch (Throwable t) {
            Log.w(TAG, "signal " + sig + " failed for pid " + pid + ": " + t.getClass().getSimpleName());
        }
    }

    /**
     * 找到本 App 的 Host/DB 进程（只读 /proc）。
     *
     * 过滤三件事：
     * - **同 UID**（读不到别的 App 的 cmdline，也绝不误杀）；
     * - 起点是我们自己的 `bin/proot`（不能只匹配 "proot"：模型跑一条 `ls …/proot`
     *   的 bash 命令也会出现在 /proc 里）；
     * - 或者 node 跑的是 `/opt/app/host.mjs`、或者是 `codem_db`。
     *
     * 读不到 /proc（部分 ROM 收紧）时返回空 —— 上层会退回 `Process.destroy()` + 端口探活。
     */
    private List<Integer> findOwnPids() {
        List<Integer> found = new ArrayList<>();
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return found;
        int myUid = android.os.Process.myUid();
        String prootPath = new File(bin, "proot").getAbsolutePath();
        for (File entry : entries) {
            String name = entry.getName();
            if (!isNumeric(name)) continue;
            int pid;
            try {
                pid = Integer.parseInt(name);
            } catch (NumberFormatException e) {
                continue;
            }
            if (pid == android.os.Process.myPid()) continue;
            if (uidOf(entry) != myUid) continue;
            String cmdline = readSmall(new File(entry, "cmdline"), 2_048);
            if (cmdline.isEmpty()) continue;
            boolean isProotWrapper = cmdline.startsWith(prootPath);
            boolean isHostNode = cmdline.contains("/opt/bin/node") && cmdline.contains(HOST_MARKER);
            boolean isDb = cmdline.contains(DB_MARKER);
            if (isProotWrapper || isHostNode || isDb) found.add(pid);
        }
        return found;
    }

    /** `/proc/<pid>/status` 的 `Uid:` 第一列；读不到返回 -1（= 不匹配） */
    private static int uidOf(File procDir) {
        String status = readSmall(new File(procDir, "status"), 4_096);
        for (String line : status.split("\n")) {
            if (!line.startsWith("Uid:")) continue;
            String[] parts = line.trim().split("\\s+");
            if (parts.length < 2) return -1;
            try {
                return Integer.parseInt(parts[1]);
            } catch (NumberFormatException e) {
                return -1;
            }
        }
        return -1;
    }

    /**
     * 读一小段文件内容。
     *
     * `/proc/<pid>/cmdline` 是 **NUL 分隔**的 argv：不能在第一枚 NUL 处截断（那只会读到
     * argv[0]），必须把 NUL 换成空格后再找 guest 路径标记。
     */
    private static String readSmall(File file, int cap) {
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[Math.min(cap, 4_096)];
            int total = 0;
            while (total < buf.length) {
                int n = in.read(buf, total, buf.length - total);
                if (n <= 0) break;
                total += n;
            }
            if (total <= 0) return "";
            for (int i = 0; i < total; i++) {
                if (buf[i] == 0) buf[i] = ' ';
            }
            return new String(buf, 0, total, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return "";
        }
    }

    private static boolean isNumeric(String value) {
        if (value == null || value.isEmpty() || value.length() > 10) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private static void closeQuietly(OutputStream out) {
        try {
            out.close();
        } catch (IOException ignored) {
            /* 进程可能已经退出 */
        }
    }

    private static void mkdirs(File dir) {
        if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            Log.w(TAG, "mkdirs failed: " + dir);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
