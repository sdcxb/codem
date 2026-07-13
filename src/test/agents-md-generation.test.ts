/**
 * 测试：F3.3 AGENTS.md 自动生成
 *
 * 改动影响：
 *   - files.ts 新增 generateAgentsMd() / analyzeProject() / buildAgentsMdFromAnalysis()
 *   - App.tsx 新增 /generate-agents 命令处理（已删除，改为自然语言意图检测）
 *   - generateAgentsMd 读取 package.json / Cargo.toml / pyproject.toml / go.mod
 *   - 扫描项目目录结构，识别关键目录
 *   - 根据技术栈生成代码规范
 *
 * 测试范围：
 *   1. 模板生成内容验证（标题、段落结构）
 *   2. 技术栈检测（Node.js/TS、Rust、Python、Go）
 *   3. 关键目录识别
 *   4. 构建命令推断
 *   5. 代码规范生成
 *   6. 多技术栈混合项目
 *   7. 空项目/未知技术栈
 *   8. buildAgentsMdFromAnalysis 纯函数测试
 *
 * 注意：generateAgentsMd 依赖 file-api.ts 的 readFile/listDirectory（Tauri IPC）
 *       在测试环境中 Tauri 不可用，所以主要测试 buildAgentsMdFromAnalysis 的纯逻辑。
 *       analyzeProject 的检测逻辑通过 mock 验证。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateAgentsMd } from "../core/project/files";

// Mock file-api
vi.mock("../core/file-api", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  executeCommand: vi.fn(),
  listDirectory: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn(),
  deletePath: vi.fn(),
}));

import { readFile, listDirectory } from "../core/file-api";

describe("F3.3 AGENTS.md 自动生成", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(listDirectory).mockReset();
  });

  // ===== 1. 模板生成内容验证 =====
  describe("模板生成内容验证", () => {
    it("生成的 AGENTS.md 包含项目名作为标题", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\my-project");
      expect(content).toContain("# my-project 项目指令");
    });

    it("包含自动生成说明", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\test");
      expect(content).toContain("此文件由 Codem 自动生成");
    });

    it("包含 AI 助手规则段落", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\test");
      expect(content).toContain("## AI 助手规则");
      expect(content).toContain("使用中文回复");
    });

    it("包含常见陷阱段落（占位符）", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\test");
      expect(content).toContain("## 常见陷阱");
    });

    it("包含构建与开发命令段落", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\test");
      expect(content).toContain("## 构建与开发命令");
    });
  });

  // ===== 2. 技术栈检测 — Node.js / TypeScript =====
  describe("技术栈检测 — Node.js / TypeScript", () => {
    it("检测到 package.json 中的 TypeScript", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "test-project",
            dependencies: { typescript: "^5.0.0", react: "^18.0.0" },
            devDependencies: { vite: "^5.0.0", eslint: "^8.0.0" },
            scripts: { build: "vite build", test: "vitest", lint: "eslint ." },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\test-project");
      expect(content).toContain("TypeScript");
      expect(content).toContain("React");
    });

    it("检测到 Vite 构建工具", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "vite-app",
            dependencies: {},
            devDependencies: { vite: "^5.0.0" },
            scripts: { build: "vite build" },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\vite-app");
      expect(content).toContain("Vite");
    });

    it("检测到 Tauri 框架", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "tauri-app",
            dependencies: { "@tauri-apps/api": "^2.0.0" },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\tauri-app");
      expect(content).toContain("Tauri");
    });

    it("检测到 npm scripts 中的构建/测试/lint 命令", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "app",
            dependencies: {},
            scripts: { build: "tsc", test: "jest", lint: "eslint ." },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("npm run build");
      expect(content).toContain("npm test");
      expect(content).toContain("npm run lint");
    });

    it("检测到 pnpm 包管理器", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "app", dependencies: {} });
        }
        if (path.includes("pnpm-lock.yaml")) return "";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("pnpm");
    });

    it("检测到 yarn 包管理器", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "app", dependencies: {} });
        }
        if (path.includes("yarn.lock")) return "";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("yarn");
    });
  });

  // ===== 3. 技术栈检测 — Rust =====
  describe("技术栈检测 — Rust", () => {
    it("检测到 Cargo.toml 和 Rust", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("Cargo.toml")) {
          return '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n';
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\rust-app");
      expect(content).toContain("Rust");
      expect(content).toContain("cargo build");
      expect(content).toContain("cargo test");
      expect(content).toContain("cargo clippy");
      expect(content).toContain("cargo fmt");
      expect(content).toContain("my-rust-app");
    });
  });

  // ===== 4. 技术栈检测 — Python =====
  describe("技术栈检测 — Python", () => {
    it("检测到 pyproject.toml 和 Python", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("pyproject.toml")) return "[project]\nname = 'py-app'\n";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\py-app");
      expect(content).toContain("Python");
      expect(content).toContain("pytest");
      expect(content).toContain("ruff");
    });

    it("检测到 setup.py", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("setup.py")) return "from setuptools import setup\n";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\py-app");
      expect(content).toContain("Python");
    });
  });

  // ===== 5. 技术栈检测 — Go =====
  describe("技术栈检测 — Go", () => {
    it("检测到 go.mod 和 Go", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("go.mod")) {
          return "module github.com/user/my-go-app\n\ngo 1.21\n";
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\go-app");
      expect(content).toContain("Go");
      expect(content).toContain("go build");
      expect(content).toContain("go test");
      expect(content).toContain("my-go-app");
    });
  });

  // ===== 6. 关键目录识别 =====
  describe("关键目录识别", () => {
    it("识别 src 目录", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "src", path: "D:\\app\\src", isDirectory: true },
        { name: "README.md", path: "D:\\app\\README.md", isDirectory: false },
      ]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("src/");
      expect(content).toContain("源代码目录");
    });

    it("识别多个关键目录", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "src", path: "D:\\app\\src", isDirectory: true },
        { name: "tests", path: "D:\\app\\tests", isDirectory: true },
        { name: "docs", path: "D:\\app\\docs", isDirectory: true },
        { name: "config", path: "D:\\app\\config", isDirectory: true },
      ]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("src/");
      expect(content).toContain("tests/");
      expect(content).toContain("docs/");
      expect(content).toContain("config/");
    });

    it("识别 src-tauri 目录", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "src-tauri", path: "D:\\app\\src-tauri", isDirectory: true },
      ]);

      const content = await generateAgentsMd("D:\\app");
      expect(content).toContain("src-tauri/");
      expect(content).toContain("Tauri Rust 后端");
    });

    it("非关键目录不被识别", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "random-folder", path: "D:\\app\\random-folder", isDirectory: true },
      ]);

      const content = await generateAgentsMd("D:\\app");
      // random-folder 不在 knownDirs 中，不出现在项目结构中
      expect(content).not.toContain("random-folder/");
    });
  });

  // ===== 7. 代码规范生成 =====
  describe("代码规范生成", () => {
    it("TypeScript 项目生成 TS 相关规范", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "ts-app",
            dependencies: { typescript: "^5.0.0" },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\ts-app");
      expect(content).toContain("TypeScript 严格模式");
      expect(content).toContain("camelCase");
      expect(content).toContain("PascalCase");
    });

    it("React 项目生成 React 相关规范", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "react-app",
            dependencies: { react: "^18.0.0", typescript: "^5.0.0" },
          });
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\react-app");
      expect(content).toContain("函数式组件");
      expect(content).toContain("Hooks");
    });

    it("Rust 项目生成 Rust 相关规范", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("Cargo.toml")) return '[package]\nname = "app"\n';
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\rust-app");
      expect(content).toContain("snake_case");
      expect(content).toContain("unwrap()");
    });

    it("Python 项目生成 Python 相关规范", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("pyproject.toml")) return "[project]\nname = 'app'\n";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\py-app");
      expect(content).toContain("type hints");
    });

    it("Go 项目生成 Go 相关规范", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("go.mod")) return "module app\n\ngo 1.21\n";
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\go-app");
      expect(content).toContain("error");
      expect(content).toContain("PascalCase");
    });

    it("所有项目都包含中文注释和提交信息规范", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\empty");
      expect(content).toContain("代码注释使用中文");
      expect(content).toContain("提交信息使用中文");
    });
  });

  // ===== 8. 空项目/未知技术栈 =====
  describe("空项目/未知技术栈", () => {
    it("无任何配置文件时仍能生成模板", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\empty-project");
      expect(content).toContain("# empty-project 项目指令");
      expect(content).toContain("AI 助手规则");
      expect(content).toContain("（未检测到构建工具，请手动补充）");
    });

    it("无配置文件时不包含技术栈段落", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:\\empty");
      expect(content).not.toContain("## 技术栈");
      expect(content).not.toContain("## 框架");
    });

    it("项目名从路径末尾提取", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("C:\\Users\\dev\\projects\\awesome-app");
      expect(content).toContain("# awesome-app 项目指令");
    });

    it("反斜杠和正斜杠混合路径", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("not found"));
      vi.mocked(listDirectory).mockResolvedValue([]);

      const content = await generateAgentsMd("D:/projects/my-app");
      expect(content).toContain("my-app");
    });
  });

  // ===== 9. 混合技术栈 =====
  describe("混合技术栈", () => {
    it("Tauri 项目同时检测到 TypeScript 和 Rust", async () => {
      vi.mocked(readFile).mockImplementation(async (path: string) => {
        if (path.includes("package.json")) {
          return JSON.stringify({
            name: "tauri-fullstack",
            dependencies: { typescript: "^5.0.0", react: "^18.0.0", "@tauri-apps/api": "^2.0.0" },
            scripts: { build: "vite build", test: "vitest" },
          });
        }
        if (path.includes("Cargo.toml")) {
          return '[package]\nname = "tauri-fullstack"\nversion = "0.1.0"\n';
        }
        throw new Error("not found");
      });
      vi.mocked(listDirectory).mockResolvedValue([
        { name: "src", path: "D:\\app\\src", isDirectory: true },
        { name: "src-tauri", path: "D:\\app\\src-tauri", isDirectory: true },
      ]);

      const content = await generateAgentsMd("D:\\tauri-fullstack");
      expect(content).toContain("TypeScript");
      expect(content).toContain("React");
      expect(content).toContain("Tauri");
      expect(content).toContain("Rust");
      // TypeScript 和 Rust 规范都应该出现
      expect(content).toContain("camelCase");
      expect(content).toContain("snake_case");
    });
  });
});
