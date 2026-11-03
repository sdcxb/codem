package com.codem.remote;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API Key 的本机存储：**AndroidKeyStore + AES/GCM**，落盘只有密文。
 *
 * ## 为什么不用明文 prefs（旧实现）
 *
 * `shared_prefs/codem.xml` 是应用私有文件，但它**不是**加密的：root/备份/调试构建的
 * `run-as` 都能读；`allowBackup=true`（旧 manifest）还会把它带进系统云备份。
 * 这正是本轮要修的"Key 明文落盘"。
 *
 * ## 为什么失败时**不**回退明文
 *
 * 回退明文等于"这台设备上有 Key 的明文"，而用户不会知道。宁可保存失败并明确提示
 * （"本机无法安全存储 Key"），也不要静默降级 —— 安全属性不能取决于 ROM。
 *
 * ## 迁移（旧明文 → 密文）
 *
 * 只有一条路径：**先加密、再解密回读验证、最后删明文**。任何一步失败都保留旧明文
 * （那是用户唯一的一份 Key），把状态标成 `legacy` 并在设置页明确告警。
 *
 * ## 残余风险（如实记录）
 *
 * Java 的 `String` 不可擦除：从 `EditText` 取出的 Key 至少会以 String 形式存在过。
 * 我们能做的是：不进日志、不进 Intent、不进 WebView、不落明文、用完把 byte[]/char[] 清零。
 */
final class LlmSecretStore {
    private static final String TAG = "CodemSecret";

    /** 非秘密：服务地址与模型名（与 MainActivity 共用 `SharedPreferences("codem")`） */
    static final String KEY_BASE = "llm_base";
    static final String KEY_MODEL = "llm_model";

    /** 密文（Base64 NO_WRAP：`[1B version][12B IV][ciphertext||tag]`） */
    static final String KEY_ENC = "llm_key_enc";
    /** **只读**：旧版本的明文 Key，迁移成功后删除。除了 migrate() 不允许再读它 */
    static final String KEY_PLAIN_LEGACY = "llm_key";
    /** 非秘密：Key 的存储状态（给 UI 与判据看） */
    static final String KEY_STATE = "llm_key_state";
    static final String KEY_UPDATED_AT = "llm_key_updated_at";

    private static final String KEYSTORE = "AndroidKeyStore";
    /** 换别名 = 换密钥材料 = 旧密文永久不可解（"清除 Key" 用它兜底） */
    private static final String ALIAS = "codem.llm.key.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    /** AAD 绑定 App 与数据版本：把密文搬到别的 App/别的用途下解不开 */
    private static final byte[] AAD = "codem.llm.v1|com.codem.remote".getBytes(StandardCharsets.UTF_8);
    private static final int VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int KEY_BITS = 256;

    private LlmSecretStore() { }

    enum State {
        /** 密文可解 */
        KEYSTORE("keystore"),
        /** 仍是旧明文（迁移失败，UI 必须告警） */
        LEGACY("legacy"),
        /** 有密文但本机解不开（换机/恢复备份/Key 被删） */
        UNREADABLE("unreadable"),
        /** 没有 Key */
        NONE("none");

        final String wire;

        State(String wire) {
            this.wire = wire;
        }

        static State fromWire(String value) {
            if (value == null) return NONE;
            for (State s : values()) if (s.wire.equals(value)) return s;
            return NONE;
        }
    }

    /** 存储层的失败（消息**只写人话**，绝不带 Key） */
    static final class SecretException extends Exception {
        SecretException(String message) {
            super(message);
        }

        SecretException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    // ===== 读 =====

    static State state(SharedPreferences prefs) {
        return State.fromWire(prefs.getString(KEY_STATE, ""));
    }

    /**
     * 有没有一份"已保存"的 Key（密文或旧明文存在即算）。
     *
     * 注意语义：**能不能解开是 `state()` 的事**，不是这个函数的事。
     * 面板要同时显示"已保存"与"无法解密"才是真相（既不装作没有，也不假装能用）。
     */
    static boolean hasStoredKey(SharedPreferences prefs) {
        return !prefs.getString(KEY_ENC, "").isEmpty() || !prefs.getString(KEY_PLAIN_LEGACY, "").isEmpty();
    }

    /**
     * 读出 Key；没有或解不开返回 null（**不抛**：Host 应当照常以"无 Key"启动，
     * 由设置页提示重填）。
     */
    static String readKey(SharedPreferences prefs) {
        String enc = prefs.getString(KEY_ENC, "");
        if (!enc.isEmpty()) {
            try {
                return decrypt(enc);
            } catch (Throwable t) {
                // 不打印密文、不打印异常里的字节内容，只打类型
                Log.w(TAG, "llm key decrypt failed: " + t.getClass().getSimpleName());
            }
        }
        String legacy = prefs.getString(KEY_PLAIN_LEGACY, "");
        return legacy.isEmpty() ? null : legacy;
    }

    /** 装配 Host 用的配置（读失败 = 没有 Key，不是崩溃） */
    static LlmConfig loadConfig(SharedPreferences prefs) {
        String base = prefs.getString(KEY_BASE, "");
        String model = prefs.getString(KEY_MODEL, "");
        String key = readKey(prefs);
        return new LlmConfig(base, model, key == null ? "" : key);
    }

    // ===== 写 =====

    /**
     * 保存一份配置：Key（可选）+ base/model。
     *
     * 顺序：先 Key（加密+验证），再 base/model。任一步失败都抛 {@link SecretException}，
     * 调用方**不得**继续重启 Host（避免"旧配置已经停了、新配置没落盘"）。
     */
    static void saveConfig(SharedPreferences prefs, String baseUrl, String model, String apiKey, boolean clearKey)
            throws SecretException {
        String base = baseUrl == null ? "" : baseUrl.trim();
        String target = model == null ? "" : model.trim();
        String key = apiKey == null ? "" : apiKey.trim();
        if (clearKey) {
            clearKey(prefs);
            // 只清 Key、不动地址：此时没有地址可写是合法状态（不是错误）
            if (base.isEmpty() && target.isEmpty()) return;
        }
        if (base.isEmpty() || target.isEmpty()) throw new SecretException("服务地址和模型名都不能为空");
        if (!key.isEmpty()) saveKey(prefs, key);
        boolean ok = prefs.edit()
                .putString(KEY_BASE, base)
                .putString(KEY_MODEL, target)
                .commit();
        if (!ok) throw new SecretException("写入本机配置失败（磁盘可能已满）");
    }

    /**
     * 加密保存 Key：**先验证能解，再删明文**（顺序错了就会丢用户唯一的一份 Key）。
     */
    static void saveKey(SharedPreferences prefs, String plaintext) throws SecretException {
        String value = plaintext == null ? "" : plaintext.trim();
        if (value.isEmpty()) throw new SecretException("Key 不能为空（如需清除请点「清除 Key」）");
        String encrypted;
        try {
            encrypted = encrypt(value);
        } catch (Throwable t) {
            throw new SecretException("本机无法安全存储 Key（AndroidKeyStore 不可用），已取消保存", t);
        }
        // 回读验证：解不开的密文等于把 Key 弄丢了
        try {
            String round = decrypt(encrypted);
            if (round == null || !round.equals(value)) throw new IllegalStateException("round-trip mismatch");
        } catch (Throwable t) {
            throw new SecretException("Key 加密后回读失败，已取消保存", t);
        }
        boolean wrote = prefs.edit()
                .putString(KEY_ENC, encrypted)
                .putString(KEY_STATE, State.KEYSTORE.wire)
                .putLong(KEY_UPDATED_AT, System.currentTimeMillis())
                .commit();
        if (!wrote) throw new SecretException("写入加密后的 Key 失败（磁盘可能已满）");
        // 第二次 commit：先确保密文落盘，再删明文（顺序不能反）
        prefs.edit().remove(KEY_PLAIN_LEGACY).commit();
    }

    /** 清除 Key：删密文 + 尽力删掉 KeyStore 里的密钥材料 */
    static void clearKey(SharedPreferences prefs) {
        prefs.edit()
                .remove(KEY_ENC)
                .remove(KEY_PLAIN_LEGACY)
                .putString(KEY_STATE, State.NONE.wire)
                .commit();
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Throwable t) {
            // 尽力而为：prefs 里的密文已经删了；旧密钥残留不影响"没有 Key"
            Log.w(TAG, "keystore deleteEntry failed: " + t.getClass().getSimpleName());
        }
    }

    // ===== 迁移 =====

    /**
     * 幂等迁移：启动时（以及在保存前）跑一遍。
     *
     * 状态机（与 `docs/architecture/ADR-0004-android-llm-settings.md` 一致）：
     * - 有密文且能解 ⇒ KEYSTORE，顺手删掉残留明文；
     * - 有密文但解不开 ⇒ 若还有明文就重新加密（自救），否则 UNREADABLE（**不删密文**）；
     * - 只有明文 ⇒ 加密并删明文；加密失败 ⇒ LEGACY（保留明文，UI 告警）；
     * - 都没有 ⇒ NONE。
     */
    static void migrate(SharedPreferences prefs) {
        String enc = prefs.getString(KEY_ENC, "");
        String legacy = prefs.getString(KEY_PLAIN_LEGACY, "");
        if (!enc.isEmpty()) {
            try {
                decrypt(enc);
                prefs.edit().putString(KEY_STATE, State.KEYSTORE.wire).commit();
                if (!legacy.isEmpty()) prefs.edit().remove(KEY_PLAIN_LEGACY).commit();
                return;
            } catch (Throwable t) {
                Log.w(TAG, "existing ciphertext unreadable: " + t.getClass().getSimpleName());
                if (!legacy.isEmpty()) {
                    try {
                        saveKey(prefs, legacy);  // 用明文自救：重新加密 → 删明文
                        return;
                    } catch (Throwable e) {
                        Log.w(TAG, "self-heal from legacy failed: " + e.getClass().getSimpleName());
                    }
                }
                prefs.edit().putString(KEY_STATE, State.UNREADABLE.wire).commit();
                return;
            }
        }
        if (!legacy.isEmpty()) {
            try {
                saveKey(prefs, legacy);
            } catch (Throwable t) {
                Log.w(TAG, "legacy key migration failed: " + t.getClass().getSimpleName());
                prefs.edit().putString(KEY_STATE, State.LEGACY.wire).commit();
            }
            return;
        }
        prefs.edit().putString(KEY_STATE, State.NONE.wire).commit();
    }

    // ===== 给 WebView 的摘要（非秘密） =====

    /**
     * 面板摘要：**只有** baseUrl / model / hasKey / keyState / insecureHttp。
     * 没有 Key、没有长度、没有哈希、没有"最后 4 位"。
     */
    static String summaryJson(SharedPreferences prefs) {
        String base = prefs.getString(KEY_BASE, "");
        String model = prefs.getString(KEY_MODEL, "");
        return "{\"configured\":" + (!base.isEmpty() && !model.isEmpty())
                + ",\"baseUrl\":" + LlmConfig.jsonQuote(base)
                + ",\"model\":" + LlmConfig.jsonQuote(model)
                + ",\"hasKey\":" + hasStoredKey(prefs)
                + ",\"keyState\":" + LlmConfig.jsonQuote(state(prefs).wire)
                + ",\"insecureHttp\":" + base.startsWith("http://")
                + "}";
    }

    // ===== 加解密 =====

    private static String encrypt(String plaintext) throws GeneralSecurityException, IOException {
        SecretKey key = keyForEncrypt();
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        // setRandomizedEncryptionRequired(true)：IV 必须由 KeyStore 生成（不能自带）
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("unexpected iv length");
        cipher.updateAAD(AAD);
        byte[] raw = plaintext.getBytes(StandardCharsets.UTF_8);
        byte[] ciphertext;
        try {
            ciphertext = cipher.doFinal(raw);
        } finally {
            Arrays.fill(raw, (byte) 0);
        }
        byte[] packed = new byte[1 + IV_BYTES + ciphertext.length];
        packed[0] = (byte) VERSION;
        System.arraycopy(iv, 0, packed, 1, IV_BYTES);
        System.arraycopy(ciphertext, 0, packed, 1 + IV_BYTES, ciphertext.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    private static String decrypt(String packedBase64) throws GeneralSecurityException, IOException {
        byte[] packed = Base64.decode(packedBase64, Base64.NO_WRAP);
        if (packed.length <= 1 + IV_BYTES) throw new GeneralSecurityException("ciphertext too short");
        if (packed[0] != (byte) VERSION) throw new GeneralSecurityException("unsupported version");
        byte[] iv = Arrays.copyOfRange(packed, 1, 1 + IV_BYTES);
        byte[] ciphertext = Arrays.copyOfRange(packed, 1 + IV_BYTES, packed.length);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, keyForDecrypt(), new GCMParameterSpec(TAG_BITS, iv));
        cipher.updateAAD(AAD);
        byte[] raw = cipher.doFinal(ciphertext);
        try {
            return new String(raw, StandardCharsets.UTF_8);
        } finally {
            Arrays.fill(raw, (byte) 0);
        }
    }

    /** 加密时：密钥丢了就重建（用户正在写入新 Key，旧密文本来也用不上） */
    private static SecretKey keyForEncrypt() throws GeneralSecurityException, IOException {
        SecretKey existing = existingKey();
        if (existing != null) return existing;
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            // 存在但取不出来（被系统失效）：删掉重建。旧密文会变成 UNREADABLE，这是真实状态
            try { ks.deleteEntry(ALIAS); } catch (Throwable ignored) { }
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                // Host 可能在后台/锁屏后被拉起：不能要求生物识别，否则本机模式直接不可用
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    /** 解密时：**绝不重建**密钥 —— 重建只会让"解不开"变成"悄悄换了一把锁" */
    private static SecretKey keyForDecrypt() throws GeneralSecurityException, IOException {
        SecretKey key = existingKey();
        if (key == null) throw new GeneralSecurityException("keystore entry missing");
        return key;
    }

    private static SecretKey existingKey() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) return null;
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        return null;
    }
}
