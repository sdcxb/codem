package com.codem.remote;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.URI;

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
         */
        void onSave(String baseUrl, String model, String apiKey, boolean clearKey);
    }

    private LlmSettingsDialog() { }

    static AlertDialog show(
            Activity activity,
            String baseUrl,
            String model,
            boolean hasKey,
            LlmSecretStore.State state,
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

        TextView hint = new TextView(activity);
        hint.setText("保存后会加密存储，并重启本机 Host（会话与工作区保留）。");
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
                listener.onSave(baseValue, modelValue, keyValue, false);
                dialog.dismiss();
            });
            Button neutral = dialog.getButton(AlertDialog.BUTTON_NEUTRAL);
            if (!hasKey) {
                neutral.setVisibility(View.GONE);
            } else {
                neutral.setOnClickListener(v -> confirmClear(activity, dialog, listener));
            }
            base.requestFocus();
        });
        dialog.show();
        return dialog;
    }

    /** 校验：返回 null = 通过；否则是一句**能照着改**的人话 */
    static String validate(String baseUrl, String model, String apiKey) {
        if (baseUrl.isEmpty()) return "请填写服务地址（形如 https://api.deepseek.com/v1）";
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

    private static void confirmClear(Activity activity, AlertDialog dialog, Listener listener) {
        new AlertDialog.Builder(activity)
                .setTitle("清除 API Key")
                .setMessage("清除后本机 Host 会以“无 Key”启动；模型服务若需要鉴权，请求会失败。")
                .setPositiveButton("清除", (d, w) -> {
                    listener.onSave("", "", "", true);
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
