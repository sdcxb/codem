/**
 * Host 鉴权配置（DPAIR-CFG-*，D-7）：
 * - 默认 `local`（开发机 / Android PRoot 本机）；
 * - 有控制令牌或允许远程 ⇒ 自动 `paired`（桌面形态）；
 * - `paired` 既无控制令牌也无静态令牌时**启动失败**（否则没人能生成配对码、也没人能认证）；
 * - 控制令牌最短 16 字符；配对文件在 `host/` 下。
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hostStateDir, pairingFile, resolveHostConfig } from "../../packages/host/src/config";

function base(env: NodeJS.ProcessEnv = {}) {
  return resolveHostConfig({
    env,
    overrides: { dataHome: join("C:", "tmp", "codem-cfg"), dbBin: "node", workspaceRoot: "C:\\work", port: 0 },
  });
}

describe("DPAIR-CFG-1 默认与推导", () => {
  it("没有 token/控制令牌/allowRemote ⇒ local", () => {
    const config = base();
    expect(config.authMode).toBe("local");
    expect(config.controlToken).toBe("");
  });

  it("控制令牌（≥16）⇒ paired", () => {
    const config = base({ CODEM_HOST_CONTROL_TOKEN: "0123456789abcdef" });
    expect(config.authMode).toBe("paired");
    expect(config.controlToken).toBe("0123456789abcdef");
  });

  it("显式 CODEM_HOST_AUTH 优先于推导", () => {
    expect(base({ CODEM_HOST_AUTH: "paired", CODEM_HOST_TOKEN: "static-secret" }).authMode).toBe("paired");
    expect(base({ CODEM_HOST_AUTH: "local" }).authMode).toBe("local");
    expect(() => base({ CODEM_HOST_AUTH: "public" })).toThrow(/local、local-auth 或 paired/);
  });
});

describe("DPAIR-CFG-2 paired 必须有凭据", () => {
  it("paired 且既无 control 也无 static ⇒ 启动失败且信息可行动", () => {
    expect(() => base({ CODEM_HOST_AUTH: "paired" })).toThrow(/配对码|CODEM_HOST_CONTROL_TOKEN/);
  });

  it("paired + 静态令牌可用（CLI/break-glass）", () => {
    const config = base({ CODEM_HOST_AUTH: "paired", CODEM_HOST_TOKEN: "static-secret" });
    expect(config.authMode).toBe("paired");
    expect(config.token).toBe("static-secret");
  });

  it("控制令牌过短直接拒绝", () => {
    expect(() => base({ CODEM_HOST_CONTROL_TOKEN: "short" })).toThrow(/至少 16/);
  });
});

describe("DPAIR-CFG-3 远程监听", () => {
  it("allowRemote + 无 token 时即使显式 local 也拒绝", () => {
    expect(() =>
      resolveHostConfig({
        env: { CODEM_HOST_ALLOW_REMOTE: "1", CODEM_HOST_AUTH: "local" },
        overrides: { dataHome: "C:\\tmp\\d", dbBin: "node", workspaceRoot: "C:\\w", host: "0.0.0.0", port: 0 },
      }),
    ).toThrow(/CODEM_HOST_TOKEN/);
  });

  it("allowRemote + token ⇒ paired（不需要显式 control）", () => {
    const config = resolveHostConfig({
      env: { CODEM_HOST_ALLOW_REMOTE: "1", CODEM_HOST_TOKEN: "static-secret" },
      overrides: { dataHome: "C:\\tmp\\d", dbBin: "node", workspaceRoot: "C:\\w", host: "0.0.0.0", port: 0 },
    });
    expect(config.authMode).toBe("paired");
  });
});

describe("DPAIR-CFG-4 配对文件位置", () => {
  it("在 hostStateDir 下的 pairing.json（与 tool-names.json 同目录）", () => {
    const home = join("C:", "data", "com.codem.app");
    expect(hostStateDir(home)).toBe(join(home, "host"));
    expect(pairingFile(home)).toBe(join(home, "host", "pairing.json"));
  });
});
