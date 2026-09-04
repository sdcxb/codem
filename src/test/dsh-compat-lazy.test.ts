/**
 * dsh-compat 懒解析别名测试（插件市场"可适配"接入面）
 *
 * DC-1 别名在真实服务注册后可用（方法调用时懒解析）
 * DC-2 别名在 apply 时服务尚未注册也恒可用（先注册别名后注册服务 → 调用成功）
 * DC-3 dshTools.execute 转换到 Codem tools.execute
 * DC-4 dshLlm.generate 转换到 Codem llm.complete
 */
import { describe, it, expect, vi } from "vitest";
import { dshCompatPlugin } from "../core/dsh-compat/index";

interface FakeCtx {
  services: Record<string, any>;
  provide(name: string, value: any): () => void;
  get(name: string): any;
}

function makeCtx(): FakeCtx {
  const services: Record<string, any> = {};
  return {
    services,
    provide(name, value) {
      services[name] = value;
      return () => { delete services[name]; };
    },
    get(name) { return services[name]; },
  };
}

describe("dsh-compat 懒解析别名", () => {
  it("DC-1/DC-2: 别名恒可用（懒解析，不依赖 apply 时序）", async () => {
    const ctx = makeCtx();
    // 先加载 dsh-compat（此时真实服务尚未注册）
    const dispose = dshCompatPlugin(ctx as any);
    // 验证别名已注册
    expect(ctx.get('dshLlm')).toBeTruthy();
    expect(ctx.get('dshTools')).toBeTruthy();
    expect(ctx.get('dshShell')).toBeTruthy();
    expect(ctx.get('dshFs')).toBeTruthy();
    expect(ctx.get('dshSessions')).toBeTruthy();
    expect(ctx.get('dshCredentials')).toBeTruthy();
    // 调用时真实服务未就绪 → 访问方法即抛明确错误（而非静默缺方法）
    const llm = ctx.get('dshLlm');
    expect(() => llm.generate({ model: 'm' } as any)).toThrow(/llm.*not ready/);
    // 之后注册真实服务 → 别名立即可用（无需重新加载 compat）
    const complete = vi.fn().mockResolvedValue({ content: '你好' });
    ctx.provide('llm', { complete, listModels: vi.fn().mockResolvedValue([]), stream: vi.fn() });
    const out = await ctx.get('dshLlm').generate({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(complete).toHaveBeenCalled();
    expect(out.content).toBe('你好');
    dispose();
  });

  it("DC-3: dshTools.execute → Codem tools.execute", async () => {
    const ctx = makeCtx();
    const toolsExec = vi.fn().mockResolvedValue({ output: 'ok' });
    ctx.provide('tools', { execute: toolsExec, list: () => [], get: () => undefined });
    const dispose = dshCompatPlugin(ctx as any);
    const result = await ctx.get('dshTools').execute({ callId: 'c1', name: 'bash', arguments: { command: 'echo hi' } });
    expect(toolsExec).toHaveBeenCalledWith('bash', { command: 'echo hi' });
    expect(result.output).toBe('ok');
    dispose();
  });

  it("DC-4: dshLlm.generate → Codem llm.complete（消息格式转换）", async () => {
    const ctx = makeCtx();
    const complete = vi.fn().mockResolvedValue({ content: 'res' });
    ctx.provide('llm', { complete, listModels: vi.fn().mockResolvedValue([{ id: 'a' }]), stream: vi.fn() });
    const dispose = dshCompatPlugin(ctx as any);
    const gen = await ctx.get('dshLlm').generate({
      provider: 'x', model: 'm',
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'x', model: 'm', system: 'sys',
      messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'hi' })]),
    }));
    expect(gen.content).toBe('res');
    dispose();
  });
});
