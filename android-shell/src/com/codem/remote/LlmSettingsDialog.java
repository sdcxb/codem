package com.codem.remote;

import android.app.Activity;
import android.content.Intent;
import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 原生「本机模型设置」对话框：**base URL / API Key / model**。
 *
 * ## 为什么表单是原生的（而不是共享 UI 里的 React 表单）
 *
 * Key 一旦进了页面，就会经过：JS 字符串 → React state → DOM value → WebView 进程内存。
 * XSS（模型输出）、调试器、截图都能看到它。原生表单把 Key 限制在 Java 内存 → AndroidKeyStore，
 * 页面只知道"有没有 Key"。
 *
 * ## 输入约束
 *
 * - Key 输入框是密码型、**从不回填**（只提示"留空保持不变"）、禁止 autofill、不保存实例状态；
 * - 对话框窗口加 `FLAG_SECURE`：截图 / 最近任务预览里不会出现 Key（连掩码也不出现）。
 *
 * ## 责任边界
 *
 * 这个类**不读写存储、不重启 Host**：它只做"收集 + 校验"，把结果交给 `Listener`
 * （由 `MainActivity` 在后台线程里落盘并重启）。这样"校验失败"不会留下半套状态。
 */
final class LlmSettingsDialog {

    interface Listener {
        /**
         * @param apiKey   空字符串 = 保留已保存的 Key（不是"清空"）
         * @param clearKey true = 显式清除已保存的 Key
         * @param workspace 相对 `data/workspace` 的项目名；空 = 工作区根
         */
        void onSave(String baseUrl, String model, String apiKey, boolean clearKey, String workspace);
    }

    private LlmSettingsDialog() { }

    static AlertDialog show(
            Activity activity,
            String baseUrl,
            String model,
            boolean hasKey,
            LlmSecretStore.State state,
            String workspaceName,
            File workspaceRoot,
            Listener listener) {
        final LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad / 2, pad, 0);

        final TextView status = new TextView(activity);
        status.setText(stateHint(state, hasKey));
        status.setPadding(0, 0, 0, pad / 2);
        root.addView(status);

        final EditText base = field(activity, "服务地址（如 https://api.deepseek.com/v1）", baseUrl);
        base.setContentDescription("模型服务地址");
        root.addView(base);

        final EditText key = field(activity, "API Key（留空保持不变）", "");
        key.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setContentDescription("API Key");
        /*
         * Key 不进 instance state / 不进 autofill：旋转屏幕或系统保存表单时，
         * EditText 的文本默认会被序列化进 Bundle（可能落盘到 /data/system/…）。
         */
        key.setSaveEnabled(false);
        key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        root.addView(key);

        final EditText modelField = field(activity, "模型名（如 deepseek-chat）", model);
        modelField.setContentDescription("模型名");
        root.addView(modelField);

        final Button preset = new Button(activity);
        preset.setText("使用 AI Code With 预设");
        preset.setAllCaps(false);
        preset.setOnClickListener(v -> {
            base.setText("https://api.aicodewith.ai/v1");
            if (modelField.getText().toString().trim().isEmpty()) {
                modelField.setText("deepseek-v4-flash");
            }
            status.setText("AI Code With：填 sk-acw- 开头的 Key，再点「获取模型列表」选 Claude / GPT / Gemini / DeepSeek / GLM / Kimi 等。");
        });
        root.addView(preset);

        final Button fetchButton = new Button(activity);
        fetchButton.setText("获取模型列表");
        fetchButton.setAllCaps(false);
        fetchButton.setOnClickListener(v -> fetchModels(activity, base, key, fetchButton, status, modelField));
        root.addView(fetchButton);

        final String[] selectedWorkspace = { workspaceName == null ? "" : workspaceName };
        TextView workspaceTitle = new TextView(activity);
        workspaceTitle.setText("项目工作区（手机本机）");
        workspaceTitle.setPadding(0, pad / 2, 0, 0);
        root.addView(workspaceTitle);
        final TextView workspaceLabel = new TextView(activity);
        workspaceLabel.setText(workspaceSummary(workspaceRoot, selectedWorkspace[0]));
        workspaceLabel.setPadding(0, 0, 0, pad / 4);
        root.addView(workspaceLabel);

        Button chooseWorkspace = new Button(activity);
        chooseWorkspace.setText("选择项目工作区");
        chooseWorkspace.setAllCaps(false);
        chooseWorkspace.setOnClickListener(v -> {
            List<String> names = new ArrayList<>();
            names.add("工作区根");
            File[] dirs = workspaceRoot.listFiles(File::isDirectory);
            if (dirs != null) {
                for (File dir : dirs) names.add(dir.getName());
            }
            new AlertDialog.Builder(activity)
                    .setTitle("选择项目工作区")
                    .setItems(names.toArray(new String[0]), (d, which) -> {
                        selectedWorkspace[0] = which == 0 ? "" : names.get(which);
                        workspaceLabel.setText(workspaceSummary(workspaceRoot, selectedWorkspace[0]));
                    })
                    .setNegativeButton("取消", null)
                    .show();
        });
        root.addView(chooseWorkspace);

        Button createWorkspace = new Button(activity);
        createWorkspace.setText("新建项目目录");
        createWorkspace.setAllCaps(false);
        createWorkspace.setOnClickListener(v -> {
            final EditText nameField = field(activity, "项目名（如 my-app）", "");
            new AlertDialog.Builder(activity)
                    .setTitle("新建项目目录")
                    .setView(nameField)
                    .setPositiveButton("创建", (d, w) -> {
                        String name = safeProjectName(nameField.getText().toString());
                        if (name.isEmpty()) {
                            status.setText("项目名不能为空，也不能包含 / 或 ..");
                            return;
                        }
                        File dir = new File(workspaceRoot, name);
                        if (!dir.exists() && !dir.mkdirs()) {
                            status.setText("创建失败：目录不可写");
                            return;
                        }
                        selectedWorkspace[0] = name;
                        workspaceLabel.setText(workspaceSummary(workspaceRoot, name));
                    })
                    .setNegativeButton("取消", null)
                    .show();
        });
        root.addView(createWorkspace);

        Button importWorkspace = new Button(activity);
        importWorkspace.setText("从手机文件夹导入项目");
        importWorkspace.setAllCaps(false);
        importWorkspace.setOnClickListener(v -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                activity.startActivityForResult(pick, MainActivity.REQUEST_IMPORT_PROJECT);
            } catch (Throwable t) {
                status.setText("系统文件选择器不可用：" + t.getClass().getSimpleName());
            }
        });
        root.addView(importWorkspace);

        TextView hint = new TextView(activity);
        hint.setText("保存后会加密存储 Key，并重启本机 Host；项目文件保存在共享目录 codem/workspace。");
        hint.setPadding(0, pad / 2, 0, 0);
        root.addView(hint);

        final AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("本机模型设置")
                .setView(root)
                .setPositiveButton("保存", null)
                .setNegativeButton("取消", null)
                .setNeutralButton("清除 Key", null)
                .create();

        dialog.setOnShowListener(ignored -> {
            if (dialog.getWindow() != null) {
                // 截图/最近任务里不出现表单内容（Key 输入框即使是掩码也不该被抓）
                dialog.getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
                dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            }
            Button positive = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            positive.setOnClickListener(v -> {
                String baseValue = base.getText().toString().trim();
                String modelValue = modelField.getText().toString().trim();
                String keyValue = key.getText().toString().trim();
                String error = validate(baseValue, modelValue, keyValue);
                if (error != null) {
                    status.setText(error);
                    return;
                }
                listener.onSave(baseValue, modelValue, keyValue, false, selectedWorkspace[0]);
                dialog.dismiss();
            });
            Button neutral = dialog.getButton(AlertDialog.BUTTON_NEUTRAL);
            if (!hasKey) {
                neutral.setVisibility(View.GONE);
            } else {
                neutral.setOnClickListener(v -> confirmClear(activity, dialog, listener, selectedWorkspace[0]));
            }
            base.requestFocus();
        });
        dialog.show();
        return dialog;
    }

    private static String workspaceSummary(File root, String name) {
        File dir = name == null || name.isEmpty() ? root : new File(root, name);
        return "当前：" + (name == null || name.isEmpty() ? "工作区根" : name)
                + "\n" + dir.getAbsolutePath();
    }

    private static String safeProjectName(String raw) {
        String name = raw == null ? "" : raw.trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return "";
        if (!name.matches("[\\p{L}\\p{N}._-]{1,64}")) return "";
        return name;
    }

    /**
     * 从 `/models` 拉模型列表并让用户选一个（仅 Android 本机模式用）。
     *
     * Key 只在这次 HTTPS 请求的 Authorization 头里使用，不写日志、不进 UI 文案；
     * 已保存的 Key 不回显（设计如此），所以留空时明确提示重新输入一次。
     */
    private static void fetchModels(
            Activity activity,
            EditText base,
            EditText key,
            Button button,
            TextView status,
            EditText modelField) {
        String baseUrl = base.getText().toString().trim().replaceAll("/+$", "");
        String apiKey = key.getText().toString().trim();
        if (baseUrl.isEmpty()) {
            status.setText("请先填写服务地址");
            return;
        }
        if (apiKey.isEmpty()) {
            status.setText("请先填写一次 API Key（已保存的 Key 不回显，无法用于拉取列表）");
            return;
        }
        button.setEnabled(false);
        status.setText("正在获取模型列表…");
        new Thread(() -> {
            List<String> ids = new ArrayList<>();
            String error = null;
            HttpURLConnection conn = null;
            try {
                URL url = new URL(baseUrl + "/models");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(20_000);
                conn.setRequestProperty("Authorization", "Bearer " + apiKey);
                conn.setRequestProperty("Accept", "application/json");
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    error = "获取失败：HTTP " + code;
                } else {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                        String line;
                        while ((line = reader.readLine()) != null) sb.append(line);
                    }
                    JSONArray data = new JSONObject(sb.toString()).optJSONArray("data");
                    if (data == null) throw new IllegalStateException("响应里没有 data 数组");
                    for (int i = 0; i < data.length(); i++) {
                        JSONObject item = data.optJSONObject(i);
                        String id = item == null ? "" : item.optString("id", "").trim();
                        if (id.isEmpty() || isMediaModel(id) || ids.contains(id)) continue;
                        ids.add(id);
                    }
                }
            } catch (Throwable t) {
                error = "获取失败：" + t.getClass().getSimpleName();
            } finally {
                if (conn != null) conn.disconnect();
            }
            final String failure = error;
            activity.runOnUiThread(() -> {
                button.setEnabled(true);
                if (failure != null) {
                    status.setText(failure);
                    return;
                }
                if (ids.isEmpty()) {
                    status.setText("没有可用聊天模型（检查 Key / 服务地址）");
                    return;
                }
                status.setText("已获取 " + ids.size() + " 个模型，点一个填入模型名");
                new AlertDialog.Builder(activity)
                        .setTitle("选择模型（" + ids.size() + "）")
                        .setItems(ids.toArray(new String[0]), (d, which) -> modelField.setText(ids.get(which)))
                        .setNegativeButton("取消", null)
                        .show();
            });
        }, "codem-model-list").start();
    }

    /** 与桌面选择器同一口径：图像/视频生成模型不进入聊天模型列表。 */
    private static boolean isMediaModel(String id) {
        String s = id.toLowerCase();
        return s.startsWith("gpt-image") || s.startsWith("nano-banana") || s.startsWith("seedance")
                || s.startsWith("veo-") || s.startsWith("wan-") || s.startsWith("minimax-h3");
    }

    /** 校验：返回 null = 通过；否则是一句**能照着改**的人话 */
    static String validate(String baseUrl, String model, String apiKey) {        if (baseUrl.isEmpty()) return "请填写服务地址（形如 https://api.deepseek.com/v1）";
        if (baseUrl.length() > 2_000) return "服务地址太长";
        URI uri;
        try {
            uri = URI.create(baseUrl);
        } catch (Throwable t) {
            return "服务地址格式不对（形如 https://api.deepseek.com/v1）";
        }
        String scheme = uri.getScheme();
        if (scheme == null) return "服务地址要带 http:// 或 https://";
        if (!scheme.equals("http") && !scheme.equals("https")) return "服务地址只支持 http:// 或 https://";
        if (uri.getHost() == null || uri.getHost().isEmpty()) return "服务地址缺少主机名";
        if (uri.getQuery() != null || uri.getFragment() != null) return "服务地址不要带 ? 或 #（那部分不会被使用）";
        if (model.isEmpty()) return "请填写模型名（如 deepseek-chat）";
        if (model.length() > 200) return "模型名太长";
        if (model.indexOf('\n') >= 0 || model.indexOf('\r') >= 0) return "模型名不能换行";
        if (apiKey.length() > 4_096) return "Key 太长";
        for (int i = 0; i < apiKey.length(); i++) {
            if (Character.isWhitespace(apiKey.charAt(i))) return "Key 里不能有空格/换行（请检查粘贴）";
        }
        return null;
    }

    private static void confirmClear(Activity activity, AlertDialog dialog, Listener listener, String workspace) {
        new AlertDialog.Builder(activity)
                .setTitle("清除 API Key")
                .setMessage("清除后本机 Host 会以“无 Key”启动；模型服务若需要鉴权，请求会失败。")
                .setPositiveButton("清除", (d, w) -> {
                    listener.onSave("", "", "", true, workspace);
                    dialog.dismiss();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private static String stateHint(LlmSecretStore.State state, boolean hasKey) {
        if (state == LlmSecretStore.State.KEYSTORE) return "已保存的 Key：已加密保存（留空保持不变）";
        if (state == LlmSecretStore.State.LEGACY) return "⚠ 旧 Key 仍是明文（本机加密未成功），请重新输入并保存";
        if (state == LlmSecretStore.State.UNREADABLE) return "⚠ 已保存的 Key 在本机解不开，请重新输入";
        return hasKey ? "已保存 Key" : "尚未保存 API Key（本地免鉴权端点可留空）";
    }

    private static EditText field(Activity activity, String hintText, String value) {
        EditText e = new EditText(activity);
        e.setHint(hintText);
        e.setText(value == null ? "" : value);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        e.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return e;
    }
}
