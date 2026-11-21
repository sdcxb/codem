/**
 * 子进程环境分类（第 17 轮）。
 *
 * 执行在 Rust；这里守的是「TS 与共享 JSON 同源」以及设置默认值：
 * 默认不继承 = 剥离，名字分类与 Rust `secret_env::keep_in_strip_env` 同语义。
 */
import { describe, expect, it } from "vitest";
import {
  INHERIT_SECRET_ENV_KEY,
  classifySecretEnvName,
  isSecretEnvInheritEnabled,
} from "../core/security/secret-env";

describe("ENV-17：密钥环境变量分类/默认值", () => {
  it("默认不继承（没有设置时 = 剥离）", () => {
    localStorage.clear();
    expect(INHERIT_SECRET_ENV_KEY).toBe("codem-inherit-secret-env");
    expect(isSecretEnvInheritEnabled()).toBe(false);
  });

  it("密钥类名字剥，工具链/系统必需名字保留", () => {
    for (const name of ["OPENAI_API_KEY", "NPM_TOKEN", "DATABASE_URL", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SMTP_PASSWORD"]) {
      expect(classifySecretEnvName(name), name).toBe("drop");
    }
    for (const name of ["PATH", "USERPROFILE", "JAVA_HOME", "CARGO_HOME", "SystemRoot", "PATHEXT", "COMSPEC"]) {
      expect(classifySecretEnvName(name), name).toBe("keep");
    }
  });

  it("代理只在没有 userinfo 时保留", () => {
    expect(classifySecretEnvName("HTTPS_PROXY", "http://proxy.corp:8080")).toBe("keep");
    expect(classifySecretEnvName("HTTPS_PROXY", "http://user:pass@proxy.corp:8080")).toBe("drop");
  });
});
