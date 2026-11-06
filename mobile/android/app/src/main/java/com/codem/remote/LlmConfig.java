package com.codem.remote;

/**
 * 本机模型配置（不可变值对象）。
 *
 * 纪律：`apiKey` 只在这里与 `LlmSecretStore` / `HostSupervisor` 之间传递，
 * **不打印、不进 Intent、不进报告、不拼进任何日志**。
 * `toString()` 因此是手写的：默认实现会把 Key 原样带进任何一次字符串拼接。
 */
public final class LlmConfig {
    public final String baseUrl;
    public final String model;
    /** 可能为空：本地/免鉴权端点不需要 Key */
    public final String apiKey;

    public LlmConfig(String baseUrl, String model, String apiKey) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim();
        this.model = model == null ? "" : model.trim();
        this.apiKey = apiKey == null ? "" : apiKey.trim();
    }

    /** base + model 都齐了才算"配好了"（半套配置比没配置更难解释） */
    public boolean usable() {
        return baseUrl.length() > 0 && model.length() > 0;
    }

    public boolean hasKey() {
        return apiKey.length() > 0;
    }

    @Override
    public String toString() {
        // 只给日志/异常用：Key 永远只报"有没有"
        return "LlmConfig{baseUrl=" + baseUrl + ", model=" + model + ", key=" + (hasKey() ? "***" : "<none>") + "}";
    }

    /**
     * 最小 JSON 字符串转义（只用于写 stdin 的那一行配置）。
     *
     * 为什么不用 `JSONObject`：Key 会经过它的内部字符串缓冲，而我们只需要最朴素的两个转义；
     * 引入额外缓冲只会让"哪里曾经有一份明文"变多。
     */
    public static String jsonQuote(String value) {
        if (value == null) return "\"\"";
        StringBuilder sb = new StringBuilder(value.length() + 2);
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
