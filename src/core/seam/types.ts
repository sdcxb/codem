/**
 * Capability Seam — 三角色抽象
 *
 * Design (对标 DeepSeek Harness capability seams):
 *
 * 每个 "seam" 是一个能力接口，有三个角色：
 * 1. ServiceDefinition: 接口定义（契约）
 * 2. Provider: 具体实现（可热切换）
 * 3. Consumer: 使用方（通过 seam 访问）
 *
 * Seams:
 * - FileSystemSeam: 文件读写操作
 * - ShellSeam: 命令执行
 * - LLMSeam: LLM 调用
 * - SubagentSeam: 子智能体管理
 * - WebSeam: 网络搜索/抓取
 *
 * 工具通过 seam 访问能力，而不是直接 import 底层实现。
 * 这使得切换实现（如从本地文件系统切换到沙箱化远程文件系统）
 * 只需要注册新的 Provider，无需修改工具代码。
 */

// ========== Seam Types ==========

export interface SeamServiceDefinition<T> {
  readonly name: string;
  /** Create a provider instance from configuration */
  createProvider(config?: Record<string, unknown>): T;
}

export interface SeamProvider {
  readonly id: string;
  /** Test if this provider is available/functional */
  isAvailable(): boolean;
}

export interface SeamConsumer {
  readonly seamName: string;
}

// ========== Seam Registry ==========

class SeamRegistry {
  private definitions = new Map<string, SeamServiceDefinition<any>>();
  private providers = new Map<string, any>();

  /**
   * Register a service definition (the contract).
   */
  registerDefinition<T>(def: SeamServiceDefinition<T>): void {
    this.definitions.set(def.name, def);
    console.log(`[SeamRegistry] Registered definition: ${def.name}`);
  }

  /**
   * Register a provider instance for a seam.
   */
  registerProvider<T>(seamName: string, provider: T): void {
    this.providers.set(seamName, provider);
    console.log(`[SeamRegistry] Registered provider for: ${seamName}`);
  }

  /**
   * Get the provider for a seam.
   * Throws if no provider is registered.
   */
  getProvider<T>(seamName: string): T {
    const provider = this.providers.get(seamName);
    if (!provider) {
      throw new Error(`No provider registered for seam: ${seamName}`);
    }
    return provider as T;
  }

  /**
   * Check if a provider is registered.
   */
  hasProvider(seamName: string): boolean {
    return this.providers.has(seamName);
  }

  /**
   * List all registered seams.
   */
  listSeams(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * Clear all providers (for testing).
   */
  clear(): void {
    this.providers.clear();
  }
}

// ========== Singleton ==========

let seamRegistry: SeamRegistry | null = null;

export function getSeamRegistry(): SeamRegistry {
  if (!seamRegistry) {
    seamRegistry = new SeamRegistry();
  }
  return seamRegistry;
}

// ========== FileSystem Seam ==========

export interface FileSystemSeam extends SeamProvider {
  readFile(path: string, cwd?: string): Promise<string>;
  writeFile(path: string, content: string, cwd?: string): Promise<void>;
  listDirectory(path: string): Promise<Array<{ name: string; isDir: boolean; size: number }>>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  glob(pattern: string, cwd?: string): Promise<string[]>;
  grep(pattern: string, cwd?: string, glob?: string): Promise<Array<{ file: string; line: number; content: string }>>;
}

export const FileSystemSeamDefinition: SeamServiceDefinition<FileSystemSeam> = {
  name: "filesystem",
  createProvider() {
    throw new Error("Use registerProvider to register a FileSystemSeam");
  },
};

// ========== Shell Seam ==========

export interface ShellSeam extends SeamProvider {
  execute(command: string, cwd: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const ShellSeamDefinition: SeamServiceDefinition<ShellSeam> = {
  name: "shell",
  createProvider() {
    throw new Error("Use registerProvider to register a ShellSeam");
  },
};

// ========== LLM Seam ==========

export interface LLMSeam extends SeamProvider {
  complete(request: {
    model: string;
    messages: any[];
    tools?: any[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<any>;
  stream(request: any): AsyncGenerator<any>;
}

export const LLMSeamDefinition: SeamServiceDefinition<LLMSeam> = {
  name: "llm",
  createProvider() {
    throw new Error("Use registerProvider to register an LLMSeam");
  },
};

// ========== Subagent Seam ==========

export interface SubagentSeam extends SeamProvider {
  spawn(parentSessionId: string, agentId: string, prompt: string, cwd: string, abort?: AbortSignal): Promise<{ id: string; name: string }>;
  getTask(taskId: string): any;
  waitForTask(taskId: string, abort?: AbortSignal): Promise<{ success: boolean; result?: string; error?: string }>;
}

export const SubagentSeamDefinition: SeamServiceDefinition<SubagentSeam> = {
  name: "subagent",
  createProvider() {
    throw new Error("Use registerProvider to register a SubagentSeam");
  },
};

// ========== Web Seam ==========

export interface WebSeam extends SeamProvider {
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
  fetch(url: string): Promise<string>;
}

export const WebSeamDefinition: SeamServiceDefinition<WebSeam> = {
  name: "web",
  createProvider() {
    throw new Error("Use registerProvider to register a WebSeam");
  },
};

// ========== Default Provider Registration ==========

/**
 * Initialize default providers for all seams.
 * Called once during application startup.
 *
 * S0-3: Uses extracted LocalFileSystemProvider and LocalShellProvider classes
 * instead of inline anonymous objects. This makes the providers testable and
 * allows them to be imported independently for unit tests.
 */
export async function initDefaultSeams(): Promise<void> {
  const registry = getSeamRegistry();

  // Register definitions
  registry.registerDefinition(FileSystemSeamDefinition);
  registry.registerDefinition(ShellSeamDefinition);
  registry.registerDefinition(LLMSeamDefinition);
  registry.registerDefinition(SubagentSeamDefinition);
  registry.registerDefinition(WebSeamDefinition);

  // Register default providers
  const { LocalFileSystemProvider } = await import("./local-fs-provider");
  const { LocalShellProvider } = await import("./local-shell-provider");

  registry.registerProvider<FileSystemSeam>("filesystem", new LocalFileSystemProvider());
  registry.registerProvider<ShellSeam>("shell", new LocalShellProvider());

  console.log("[SeamRegistry] Default providers registered for: filesystem, shell");
}
