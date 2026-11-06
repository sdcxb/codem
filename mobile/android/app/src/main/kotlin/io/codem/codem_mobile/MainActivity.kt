package io.codem.codem_mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.codem.remote.LlmSecretStore
import com.codem.remote.LocalHostRuntime
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val channelName = "codem/native"
    private val localHostChannelName = LocalHostRuntime.CHANNEL

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 仅调试构建：`adb shell am start ... --ez localHostAutostart true` 直接起本机 Host，
        // 用于没写 Dart UI 时验证原生侧（生产构建里这个 extra 被 isDebuggable 拦掉）。
        maybeDebugAutostart()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "startForeground" -> {
                    val label = call.argument<String>("label") ?: "已连接的 PC"
                    ensureNotificationPermission()
                    ContextCompat.startForegroundService(
                        this,
                        Intent(this, CodemForegroundService::class.java)
                            .putExtra(CodemForegroundService.EXTRA_LABEL, label)
                    )
                    result.success(true)
                }
                "stopForeground" -> {
                    stopService(Intent(this, CodemForegroundService::class.java))
                    result.success(true)
                }
                "shareText" -> {
                    val text = call.argument<String>("text") ?: ""
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                    }
                    startActivity(Intent.createChooser(send, "分享 Codem 会话"))
                    result.success(true)
                }
                "notify" -> {
                    ensureNotificationPermission()
                    postNotification(
                        call.argument<String>("title") ?: "Codem",
                        call.argument<String>("body") ?: ""
                    )
                    result.success(true)
                }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, localHostChannelName)
            .setMethodCallHandler { call, result -> handleLocalHost(call, result) }
    }

    // ===== codem/local_host（内置本机 Host，契约见 mobile/LOCAL_HOST_CONTRACT.md） =====

    private fun handleLocalHost(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                val baseUrl = call.argument<String>("baseUrl")
                val model = call.argument<String>("model")
                val apiKey = call.argument<String>("apiKey")
                val allowPrivateFallback = call.argument<Boolean>("allowPrivateFallback") ?: false
                runLocalHost(result) {
                    LocalHostRuntime.get(applicationContext)
                        .start(baseUrl, model, apiKey, allowPrivateFallback)
                }
            }
            "stop" -> runLocalHost(result) {
                LocalHostRuntime.get(applicationContext).stop()
            }
            "status" -> runLocalHost(result) {
                LocalHostRuntime.get(applicationContext).status()
            }
            "listProjects" -> runLocalHost(result) {
                LocalHostRuntime.get(applicationContext).listProjects()
            }
            "setProject" -> {
                val name = call.argument<String>("name") ?: ""
                runLocalHost(result) {
                    LocalHostRuntime.get(applicationContext).setProject(name)
                }
            }
            "saveModel" -> {
                val baseUrl = call.argument<String>("baseUrl")
                val model = call.argument<String>("model")
                val apiKey = call.argument<String>("apiKey")
                runLocalHost(result) {
                    LocalHostRuntime.get(applicationContext).saveModel(baseUrl, model, apiKey)
                    true
                }
            }
            "modelConfig" -> runLocalHost(result) {
                LocalHostRuntime.get(applicationContext).modelConfig()
            }
            // 扩展方法（契约 v1 之外）：存储授权状态 / 拉起系统授权页
            "storageAccess" -> runLocalHost(result) {
                LocalHostRuntime.get(applicationContext).storageState()
            }
            "requestStorageAccess" -> {
                val alreadyGranted = requestStorageAccess()
                result.success(alreadyGranted)
            }
            else -> result.notImplemented()
        }
    }

    /**
     * 本机 Host 的所有调用都在同一条后台线程上串行执行：
     * 解压 rootfs + 起 PRoot/Node 可能几十秒，而且不能与 stop 交错。
     * 结果统一回主线程再交给 Flutter（MethodChannel 的 Result 必须在平台线程调用）。
     */
    private fun runLocalHost(result: MethodChannel.Result, block: () -> Any?) {
        background.execute {
            try {
                val value = block()
                main.post { result.success(value) }
            } catch (e: LlmSecretStore.SecretException) {
                // message 是人话，绝不含 Key（见 LlmSecretStore 的纪律）
                main.post { result.error("config_error", e.message ?: "本机模型配置无法保存", null) }
            } catch (e: LocalHostRuntime.LocalHostException) {
                main.post { result.error(e.code, e.message ?: "本机 Host 操作失败", null) }
            } catch (e: Throwable) {
                // 未知异常只报类型，不把堆栈/路径里的内容拼进用户可见 message
                Log.e(TAG, "local host call failed: ${e.javaClass.simpleName}")
                main.post {
                    result.error("runtime_failed", "本机 Host 操作失败（${e.javaClass.simpleName}）", null)
                }
            }
        }
    }

    /**
     * 申请共享目录权限：Android 11+ 走「所有文件访问」，6..10 走运行时 WRITE。
     * 返回 true = 现在已经能写共享目录（不需要再跳设置页）。
     */
    private fun requestStorageAccess(): Boolean {
        val runtime = LocalHostRuntime.get(applicationContext)
        if (runtime.sharedWritable()) return true
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val appIntent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                try {
                    startActivity(appIntent)
                } catch (e: Exception) {
                    Log.w(TAG, "app all-files settings failed: ${e.javaClass.simpleName}")
                    startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                }
                return false
            }
            if (Build.VERSION.SDK_INT in Build.VERSION_CODES.M..32) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(
                        Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        Manifest.permission.READ_EXTERNAL_STORAGE
                    ),
                    REQUEST_LOCAL_STORAGE
                )
                return false
            }
        } catch (e: Exception) {
            // 设置页不存在/被 ROM 禁用：不要崩，让 Dart 显示「无法打开授权页」
            Log.w(TAG, "storage permission request failed: ${e.javaClass.simpleName}")
        }
        return runtime.sharedWritable()
    }

    /**
     * 仅 debuggable 构建生效的调试入口（没有任何 Key 参与，日志也不打印令牌）：
     *
     * - `--ez localHostAutostart true`：后台 `start()`；
     * - `--es localHostDebugAction stop|start|status|cycle`：分别演练 stop / start / status /
     *   （start→stop→start，验证「停干净后能用新端口重起」）。
     *
     * 存在理由：Flutter UI 未完成时，原生侧也要能被设备用例驱动（`adb shell am start`），
     * 否则「Host 能不能起来 / stop 能不能停干净」只能靠人点界面。release 构建直接忽略。
     */
    private fun maybeDebugAutostart() {
        val intent = intent ?: return
        val autostart = intent.getBooleanExtra(EXTRA_AUTOSTART, false)
        val action = intent.getStringExtra(EXTRA_DEBUG_ACTION)
        if (!autostart && action.isNullOrBlank()) return
        intent.removeExtra(EXTRA_AUTOSTART)
        intent.removeExtra(EXTRA_DEBUG_ACTION)
        val runtime = LocalHostRuntime.get(applicationContext)
        if (!runtime.isDebuggable()) {
            Log.w(TAG, "local host debug extras ignored: release build")
            return
        }
        val effective = if (!action.isNullOrBlank()) action.trim().lowercase() else "start"
        Thread({
            try {
                when (effective) {
                    "stop" -> {
                        val stopped = runtime.stop()
                        Log.i(TAG, "debugAction stop: stopped=$stopped running=${runtime.status()["running"]}")
                    }
                    "status" -> {
                        val st = runtime.status()
                        // 只记非秘密字段：令牌不进日志
                        Log.i(
                            TAG,
                            "debugAction status: running=${st["running"]} url=${st["url"]} " +
                                "workspace=${st["workspace"]} shared=${st["shared"]}"
                        )
                    }
                    "cycle" -> {
                        val first = runtime.start(null, null, null, false)
                        Log.i(TAG, "debugAction cycle start#1: url=${first["url"]} workspace=${first["workspace"]}")
                        runtime.stop()
                        Log.i(TAG, "debugAction cycle stop: running=${runtime.status()["running"]}")
                        val second = runtime.start(null, null, null, false)
                        Log.i(TAG, "debugAction cycle start#2: url=${second["url"]} workspace=${second["workspace"]}")
                    }
                    "netcheck" -> {
                        // PRoot 内 DNS + HTTPS（不带 Authorization，401/403 也算通）
                        Log.i(TAG, "debugAction netcheck: " + runtime.netCheck(null))
                    }
                    else -> {
                        val out = runtime.start(null, null, null, false)
                        // 只记端口/工作区：令牌与 Key 都不进日志
                        Log.i(
                            TAG,
                            "autostart: needsPermission=${out["needsPermission"]} url=${out["url"]} " +
                                "workspace=${out["workspace"]} shared=${out["shared"]}"
                        )
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "debugAction $effective failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }, "codem-localhost-debug").start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // singleTop：第二次 `am start` 走这里，调试 extra 必须在 onCreate 之外也认
        maybeDebugAutostart()
    }

    private fun postNotification(title: String, body: String) {
        val manager = getSystemService(NotificationManager::class.java)
        val channelId = "codem.events"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            manager.getNotificationChannel(channelId) == null
        ) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Codem 事件", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        val open = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        manager.notify(
            4102,
            builder
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build()
        )
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }

    private companion object {
        const val TAG = "CodemMain"
        const val EXTRA_AUTOSTART = "localHostAutostart"

        /** 仅调试：`--es localHostDebugAction stop|start|status|cycle`（见 maybeDebugAutostart） */
        const val EXTRA_DEBUG_ACTION = "localHostDebugAction"
        const val REQUEST_LOCAL_STORAGE = 42

        /** 进程级单线程：本机 Host 的解压/启动/停止必须串行（见 runLocalHost） */
        val background = Executors.newSingleThreadExecutor { r -> Thread(r, "codem-local-host") }
        val main = Handler(Looper.getMainLooper())
    }
}
