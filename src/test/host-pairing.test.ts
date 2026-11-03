/**
 * 一次性配对 + 设备令牌（DPAIR-*，D-7）。
 *
 * 这一组守的是**凭据语义**，不是 HTTP：
 * - 码 6 位、5 分钟、单次、单活动码；
 * - 错码不建设备；错误次数/限速会挡住正确码；
 * - token 只以 sha256 落盘；撤销后立即失效；
 * - 写失败绝不假成功（token / 撤销）；
 * - 文件损坏 fail-closed（清空设备 + warning，不是"放开"）；
 * - 同目录第二个实例 BUSY（多进程不互相覆盖撤销）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PAIRED_DEVICES,
  PAIR_CODE_TTL_MS,
  PairingBusyError,
  PairingError,
  PairingService,
  normalizePairCode,
  sanitizeDeviceName,
  type PairingServiceOptions,
} from "../../packages/host/src/pairing";

const workDirs: string[] = [];
const services: PairingService[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codem-pairing-"));
  workDirs.push(dir);
  return dir;
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function open(opts: Partial<PairingServiceOptions> & { filePath: string }): Promise<PairingService> {
  const service = await PairingService.open(opts);
  services.push(service);
  return service;
}

async function rejectsWithReason(p: Promise<unknown>, reason: string): Promise<PairingError> {
  const err = await p.then(
    () => {
      throw new Error(`应当失败（${reason}）但成功了`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PairingError);
  expect((err as PairingError).reason).toBe(reason);
  return err as PairingError;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DPAIR-1 配对码形状与生命周期", () => {
  it("生成 6 位数字码、TTL 5 分钟、单活动码", async () => {
    const c = clock();
    const svc = await open({ filePath: join(tempDir(), "pairing.json"), now: c.now });
    const first = await svc.newCode();
    expect(first.code).toMatch(/^[0-9]{6}$/);
    expect(first.expiresAt - first.ttlMs).toBe(c.now());
    expect(first.ttlMs).toBe(PAIR_CODE_TTL_MS);

    const second = await svc.newCode();
    await rejectsWithReason(svc.claim(first.code), "invalid");
    const claimed = await svc.claim(second.code);
    expect(claimed.device.id).toMatch(/^dev-[0-9a-f]{8}$/);
  });

  it("接受空格/连字符归一化；拒绝非 6 位数字", () => {
    expect(normalizePairCode("123 456")).toBe("123456");
    expect(normalizePairCode("123-456")).toBe("123456");
    expect(normalizePairCode("12345")).toBeNull();
    expect(normalizePairCode("12345a")).toBeNull();
    expect(normalizePairCode("１２３４５６")).toBeNull();
  });
});

describe("DPAIR-2 兑换与落盘", () => {
  it("正确码兑换出设备；文件里只有 token 的 sha256，没有明文", async () => {
    const file = join(tempDir(), "pairing.json");
    const svc = await open({ filePath: file });
    const { code } = await svc.newCode();
    const claimed = await svc.claim(code, "Pixel 8", "android");

    expect(claimed.device).toMatchObject({ name: "Pixel 8", platform: "android" });
    expect(claimed.token).toMatch(/^[0-9a-f]{64}$/);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(claimed.token);
    expect(raw).not.toContain(code);
    const parsed = JSON.parse(raw) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("设备名清洗：默认值、去控制字符、最长 64", async () => {
    expect(sanitizeDeviceName(undefined)).toBe("我的手机");
    expect(sanitizeDeviceName("   ")).toBe("我的手机");
    expect(sanitizeDeviceName("  Pixel\n\t8  ")).toBe("Pixel 8");
    expect(sanitizeDeviceName("x".repeat(100))).toHaveLength(64);
  });
});

describe("DPAIR-3 错误与锁定", () => {
  it("错码不建设备；达到每码上限后正确码也 locked；新码恢复", async () => {
    const svc = await open({ filePath: join(tempDir(), "pairing.json"), maxAttemptsPerCode: 3, maxAttemptsPerWindow: 100 });
    const { code } = await svc.newCode();
    const wrong = code === "000000" ? "000001" : "000000";
    await rejectsWithReason(svc.claim(wrong), "invalid");
    await rejectsWithReason(svc.claim(wrong), "invalid");
    await rejectsWithReason(svc.claim(wrong), "locked");
    // 已锁定：即使码正确也不放行
    await rejectsWithReason(svc.claim(code), "locked");
    expect(svc.list().devices).toHaveLength(0);

    const fresh = await svc.newCode();
    await expect(svc.claim(fresh.code)).resolves.toBeTruthy();
  });

  it("过期后正确码 expired", async () => {
    const c = clock();
    const svc = await open({ filePath: join(tempDir(), "pairing.json"), now: c.now });
    const { code } = await svc.newCode();
    c.advance(PAIR_CODE_TTL_MS + 1);
    await rejectsWithReason(svc.claim(code), "expired");
    expect(svc.list().devices).toHaveLength(0);
  });
});

describe("DPAIR-4 单次使用与并发", () => {
  it("同一码第二次兑换失败，只产生一台设备", async () => {
    const svc = await open({ filePath: join(tempDir(), "pairing.json") });
    const { code } = await svc.newCode();
    await svc.claim(code);
    await rejectsWithReason(svc.claim(code), "invalid");
    expect(svc.list().devices).toHaveLength(1);
  });

  it("并发兑换同一码只有一个成功", async () => {
    const svc = await open({ filePath: join(tempDir(), "pairing.json") });
    const { code } = await svc.newCode();
    const results = await Promise.allSettled([svc.claim(code), svc.claim(code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(svc.list().devices).toHaveLength(1);
  });

  it("限速：窗口内 rate_limited 且不建设备；窗口过后可兑换", async () => {
    const c = clock();
    const svc = await open({
      filePath: join(tempDir(), "pairing.json"),
      now: c.now,
      maxAttemptsPerWindow: 2,
      maxAttemptsPerCode: 100,
    });
    const { code } = await svc.newCode();
    await rejectsWithReason(svc.claim("000000"), "invalid");
    await rejectsWithReason(svc.claim("000001"), "invalid");
    const limited = await rejectsWithReason(svc.claim(code), "rate_limited");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(svc.list().devices).toHaveLength(0);

    c.advance(61_000);
    await expect(svc.claim(code)).resolves.toBeTruthy();
  });
});

describe("DPAIR-5 设备上限与撤销", () => {
  it("设备上限 8；第 9 台 device_limit；撤销后可再配", async () => {
    const svc = await open({ filePath: join(tempDir(), "pairing.json"), maxDevices: 2 });
    const a = await svc.claim((await svc.newCode()).code, "A");
    await svc.claim((await svc.newCode()).code, "B");
    const third = await svc.newCode();
    await rejectsWithReason(svc.claim(third.code), "device_limit");
    expect(MAX_PAIRED_DEVICES).toBe(8);

    await svc.revoke(a.device.id);
    await expect(svc.claim(third.code, "C")).resolves.toBeTruthy();
  });

  it("撤销后 authenticate=false，列表不含；未知 id 幂等 false", async () => {
    const svc = await open({ filePath: join(tempDir(), "pairing.json") });
    const claimed = await svc.claim((await svc.newCode()).code);
    expect(svc.authenticate(claimed.token)?.id).toBe(claimed.device.id);
    expect(svc.authenticate("deadbeef")).toBeNull();

    expect(await svc.revoke(claimed.device.id)).toBe(true);
    expect(svc.authenticate(claimed.token)).toBeNull();
    expect(svc.list().devices).toHaveLength(0);
    expect(await svc.revoke("dev-00000000")).toBe(false);
  });
});

describe("DPAIR-6 持久化与损坏", () => {
  it("重新打开后设备仍可认证；撤销保持；配对码不持久", async () => {
    const dir = tempDir();
    const file = join(dir, "pairing.json");
    const first = await open({ filePath: file });
    const claimed = await first.claim((await first.newCode()).code);
    const pending = (await first.newCode()).code;
    await first.close();

    const second = await open({ filePath: file });
    expect(second.authenticate(claimed.token)?.id).toBe(claimed.device.id);
    // 内存里的码不落盘：重启后旧码无效
    await rejectsWithReason(second.claim(pending), "invalid");
    await second.revoke(claimed.device.id);
    await second.close();

    const third = await open({ filePath: file });
    expect(third.authenticate(claimed.token)).toBeNull();
  });

  it("文件损坏被隔离、设备清空，并给出非秘密 warning", async () => {
    const dir = tempDir();
    const file = join(dir, "pairing.json");
    writeFileSync(file, "{ not json");
    const svc = await open({ filePath: file });
    const listed = svc.list();
    expect(listed.devices).toHaveLength(0);
    expect(listed.warning).toBeTruthy();
    expect(JSON.stringify(listed)).not.toContain("not json");
    expect(readdirSync(dir).some((name) => name.startsWith("pairing.json.corrupt-"))).toBe(true);
    expect(svc.authenticate("whatever")).toBeNull();
  });

  it("写失败不返回成功：redeem 不返回 token，码也未被消费", async () => {
    const file = join(tempDir(), "pairing.json");
    const svc = await open({ filePath: file });
    const { code } = await svc.newCode();
    // 用一个目录占住目标路径，让 rename 失败
    mkdirSync(file);
    await expect(svc.claim(code)).rejects.toBeTruthy();
    rmSync(file, { recursive: true, force: true });
    await expect(svc.claim(code)).resolves.toBeTruthy();
  });

  it("写失败不返回成功：revoke 失败时内存里设备仍在", async () => {
    const file = join(tempDir(), "pairing.json");
    const svc = await open({ filePath: file });
    const claimed = await svc.claim((await svc.newCode()).code);
    rmSync(file, { force: true });
    mkdirSync(file);
    await expect(svc.revoke(claimed.device.id)).rejects.toBeTruthy();
    expect(svc.authenticate(claimed.token)?.id).toBe(claimed.device.id);
    // 恢复现场，让 afterEach 的 close() 能正常刷盘
    rmSync(file, { recursive: true, force: true });
  });
});

describe("DPAIR-7 多进程锁", () => {
  it("同目录第二实例 BUSY；close 后可开", async () => {
    const file = join(tempDir(), "pairing.json");
    const first = await open({ filePath: file });
    await expect(PairingService.open({ filePath: file })).rejects.toBeInstanceOf(PairingBusyError);
    await first.close();
    const again = await PairingService.open({ filePath: file });
    services.push(again);
    expect(existsSync(file)).toBe(false);
  });

  it("死 pid 的锁会被回收", async () => {
    const dir = tempDir();
    const file = join(dir, "pairing.json");
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2147483647, startedAt: 0 }));
    const svc = await open({ filePath: file });
    await expect(svc.newCode()).resolves.toBeTruthy();
  });
});

describe("DPAIR-8 常数时间", () => {
  it("配对码/令牌比较走 sha256 + timingSafeEqual，没有明文相等比较", () => {
    const src = readFileSync("packages/host/src/pairing.ts", "utf8");
    expect(src).toContain("timingSafeEqual");
    expect(src).toContain("createHash(\"sha256\")");
    // 不允许把码或 token 直接 === 比较
    expect(src).not.toMatch(/(code|token)\s*===\s*(code|token|this\.code)/);
  });
});
