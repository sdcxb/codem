package com.codem.remote;

import android.content.Context;
import android.os.Environment;

import java.io.File;

/**
 * 手机本机项目目录：
 * - 优先 `/storage/emulated/0/codem/workspace`（用户文件管理器可见，和大多数安卓应用一致）；
 * - 没有外部存储权限/不可写时回退应用私有 `files/data/workspace`，不阻塞启动。
 */
final class WorkspacePaths {
    private WorkspacePaths() { }

    static File root(Context context) {
        try {
            File external = Environment.getExternalStorageDirectory();
            if (external != null) {
                File dir = new File(new File(external, "codem"), "workspace");
                if ((dir.exists() || dir.mkdirs()) && dir.isDirectory() && dir.canWrite()) {
                    return dir;
                }
            }
        } catch (Throwable ignored) {
            // 回退私有目录
        }
        File fallback = new File(new File(context.getFilesDir(), "data"), "workspace");
        //noinspection ResultOfMethodCallIgnored
        fallback.mkdirs();
        return fallback;
    }

    /** 在 PRoot 里看到的绝对路径；外部存储直接同路径，私有目录走 /opt/data 绑定。 */
    static String guestRoot(File root) {
        String path = root.getAbsolutePath();
        try {
            String external = Environment.getExternalStorageDirectory().getAbsolutePath();
            if (path.equals(external) || path.startsWith(external + "/")) return path;
        } catch (Throwable ignored) {
            // fall through
        }
        return "/opt/data/workspace";
    }

    static boolean isShared(File root) {
        try {
            String external = Environment.getExternalStorageDirectory().getAbsolutePath();
            String path = root.getAbsolutePath();
            return path.equals(external) || path.startsWith(external + "/");
        } catch (Throwable ignored) {
            return false;
        }
    }
}
