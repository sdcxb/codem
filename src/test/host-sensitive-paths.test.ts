/**
 * 敏感路径规则的纯函数判据（SP-1..6）。
 *
 * 这一组只钉**判定**（命中/不命中/动作/文案），不涉及审批与 IO：
 * 规则漂移的症状是"同一个文件在 chat 里直接读出来、在文件浏览器里却弹卡"，
 * 而那种缺陷只能靠最底层的规则判据挡住。
 */
import { describe, expect, it } from "vitest";

import {
  APP_ATTACHMENT_DIR,
  SENSITIVE_RULES,
  classifySensitivePath,
  isSensitiveReadPath,
  normalizeWorkspacePath,
} from "../../packages/host/src/sensitive-paths";

function ruleOf(path: string): string | null {
  return classifySensitivePath(path)?.rule ?? null;
}

describe("SP-1 环境变量文件", () => {
  it(".env / .env.* / *.env / .envrc 命中；.environment.ts 不命中", () => {
    for (const path of [".env", ".env.local", "sub/.env.production", "prod.env", ".envrc", "config/.env"]) {
      expect(ruleOf(path), path).toBe("env");
    }
    for (const path of [".environment.ts", "src/env.ts", "environment.md", "src/.environment.ts"]) {
      expect(ruleOf(path), path).not.toBe("env");
    }
  });

  it("命中 env 时动作是 ask、风险是 high、原因非空", () => {
    const v = classifySensitivePath("sub/.env");
    expect(v).toMatchObject({ rule: "env", action: "ask", risk: "high", label: "环境变量文件" });
    expect(v!.reason.length).toBeGreaterThan(0);
  });
});

describe("SP-2 Git 元数据", () => {
  it(".git/** 命中；.gitignore 不命中", () => {
    for (const path of [".git/config", ".git/config.worktree", ".git/credentials", ".git/hooks/pre-commit"]) {
      expect(ruleOf(path), path).toBe("git-meta");
    }
    for (const path of [".gitignore", ".gitattributes", "docs/.gitkeep"]) {
      expect(ruleOf(path), path).not.toBe("git-meta");
    }
  });
});

describe("SP-3 SSH/私钥/证书", () => {
  it(".ssh/** 与常见私钥文件名命中；公钥不按私钥命中", () => {
    for (const path of [".ssh/id_rsa", ".ssh/id_ed25519", ".ssh/known_hosts", "keys/server.pem", "certs/a.key"]) {
      expect(ruleOf(path), path).toBeTruthy();
    }
    expect(ruleOf("keys/id_rsa.pub"), "公钥本身不是私钥").not.toBe("ssh-key");
    // `.ssh/**` 是整目录规则：公钥跟着私钥一起要审批（fail-closed，可接受）
    expect(ruleOf(".ssh/id_rsa.pub")).toBe("ssh-key");
    expect(isSensitiveReadPath(".ssh/id_rsa.pub"), ".pub 仍可能落在 .ssh 目录里").toBe(true);
    expect(ruleOf("keys/server.pem")).toBe("key-material");
    expect(ruleOf("certs/a.key")).toBe("key-material");
  });

  it("凭据文件：包管理器/云凭据与 tfvars", () => {
    for (const path of [
      ".npmrc",
      ".netrc",
      ".gitconfig",
      ".aws/credentials",
      ".kube/config",
      ".config/gcloud/application_default_credentials.json",
      ".config/gh/hosts.yml",
      "service-account-prod.json",
      "infra/terraform.tfvars",
      ".docker/config.json",
      ".github/credentials.json",
    ]) {
      expect(ruleOf(path), path).toBe("credential-file");
    }
  });
});

describe("SP-4 路径归一化", () => {
  it("Windows 分隔符 / 大小写 / ./ 前缀都能归一后判定", () => {
    expect(normalizeWorkspacePath(".\\SUB\\.ENV")).toBe("SUB/.ENV");
    expect(normalizeWorkspacePath("./.env")).toBe(".env");
    expect(normalizeWorkspacePath("a//b")).toBe("a/b");
    expect(ruleOf(".\\SUB\\.ENV")).toBe("env");
    expect(ruleOf("./keys/SERVER.PEM")).toBe("key-material");
  });

  it("空路径/根目录不命中", () => {
    expect(classifySensitivePath("")).toBeNull();
    expect(classifySensitivePath(".")).toBeNull();
    expect(classifySensitivePath("./")).toBeNull();
  });
});

describe("SP-5 应用内部产物与应用附件", () => {
  it(".codem-snapshots / .codem-tool-results = deny；.codem-attachments = allow", () => {
    expect(classifySensitivePath(".codem-snapshots/snap-1.json")).toMatchObject({
      rule: "app-internal",
      action: "deny",
    });
    expect(classifySensitivePath(".codem-tool-results/tool-1.json")).toMatchObject({
      rule: "app-internal",
      action: "deny",
    });
    expect(classifySensitivePath(`${APP_ATTACHMENT_DIR}/att-1__a.env`)).toMatchObject({
      rule: "app-attachment",
      action: "allow",
    });
    // allow 的附件不算"敏感读取"（否则模型永远读不到用户刚上传的文件）
    expect(isSensitiveReadPath(`${APP_ATTACHMENT_DIR}/att-1__a.env`)).toBe(false);
  });
});

describe("SP-6 规则文案稳定（UI 依赖）", () => {
  it("七个规则 ID 的 label/reason/risk 都是非空且固定的形状", () => {
    expect(Object.keys(SENSITIVE_RULES).sort()).toEqual([
      "app-attachment",
      "app-internal",
      "credential-file",
      "env",
      "git-meta",
      "key-material",
      "ssh-key",
    ]);
    for (const [id, meta] of Object.entries(SENSITIVE_RULES)) {
      expect(meta.label.length, id).toBeGreaterThan(0);
      expect(meta.reason.length, id).toBeGreaterThan(0);
      expect(["low", "medium", "high"]).toContain(meta.risk);
    }
    expect(SENSITIVE_RULES.env.label).toBe("环境变量文件");
    expect(SENSITIVE_RULES["git-meta"].label).toBe("Git 元数据");
    expect(SENSITIVE_RULES["app-internal"].label).toBe("应用内部产物");
  });
});
