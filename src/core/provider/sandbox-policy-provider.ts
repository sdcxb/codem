// @ts-nocheck
/**
 * @codem/sandbox-policy — 沙箱策略插件 (P1-7.7)
 *
 * 定义沙箱安全策略：文件系统访问控制、命令白名单等。
 *
 * 功能链路融入（文档 6.2 链路 B: 工具执行链 Layer 2: 沙箱检查）：
 * - 启动时：注册沙箱策略，工具执行前检查策略
 * - 停止时：策略不可用 → 默认拒绝危险操作
 */
import type { Plugin } from '../cordis/src/index.ts'

interface SandboxPolicy {
  allowedPaths: string[]
  blockedCommands: string[]
  maxExecutionTime: number
  allowNetwork: boolean
}

class SandboxPolicyManager {
  private policy: SandboxPolicy = {
    allowedPaths: [],
    blockedCommands: ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:'],
    maxExecutionTime: 30000,
    allowNetwork: true,
  }

  setPolicy(policy: Partial<SandboxPolicy>) {
    this.policy = { ...this.policy, ...policy }
  }

  getPolicy(): Readonly<SandboxPolicy> {
    return this.policy
  }

  isCommandAllowed(command: string): boolean {
    const lower = command.toLowerCase()
    return !this.policy.blockedCommands.some(blocked => lower.includes(blocked))
  }

  isPathAllowed(filePath: string): boolean {
    if (this.policy.allowedPaths.length === 0) return true
    return this.policy.allowedPaths.some(allowed => filePath.startsWith(allowed))
  }

  isNetworkAllowed(): boolean {
    return this.policy.allowNetwork
  }

  getMaxExecutionTime(): number {
    return this.policy.maxExecutionTime
  }
}

export const sandboxPolicyProvider: Plugin = (ctx: any) => {
  const manager = new SandboxPolicyManager()

  const dispose = ctx.provide('sandboxPolicy', {
    setPolicy(policy: Partial<SandboxPolicy>) { manager.setPolicy(policy) },
    getPolicy() { return manager.getPolicy() },
    isCommandAllowed(command: string) { return manager.isCommandAllowed(command) },
    isPathAllowed(filePath: string) { return manager.isPathAllowed(filePath) },
    isNetworkAllowed() { return manager.isNetworkAllowed() },
    getMaxExecutionTime() { return manager.getMaxExecutionTime() },
  })

  return dispose
}
