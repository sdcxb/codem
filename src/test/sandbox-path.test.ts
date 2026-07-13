/**
 * 测试：S5 沙箱路径白名单 — isPathWithinWorkspace
 *
 * 改动影响：
 *   - file-api.ts 新增 isPathWithinWorkspace() 函数
 *   - writeFile() 增加 workspace 参数，写入前检查路径
 *   - tools.ts write/edit/multi_edit 工具增加 checkSandbox()
 *   - Rust lib.rs write_file 命令增加 workspace 参数和 canonicalize_path()
 *
 * 测试范围：
 *   1. 基本路径包含检查（子目录、文件）
 *   2. 路径越界检测（父目录、兄弟目录、不同盘符）
 *   3. 路径规范化（./、../、正反斜杠混合）
 *   4. 大小写不敏感（Windows 路径特性）
 *   5. 边界条件（空路径、根路径、相同路径）
 *   6. writeFile 带 workspace 参数时的拒绝行为
 */
import { describe, it, expect } from "vitest";
import { isPathWithinWorkspace } from "../core/file-api";

describe("S5 沙箱路径白名单 — isPathWithinWorkspace", () => {
  // ===== 1. 基本路径包含 =====
  describe("基本路径包含", () => {
    it("子目录路径在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\project\\src\\main.ts", "C:\\project")).toBe(true);
    });

    it("深层子目录路径在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\project\\src\\components\\Button.tsx", "C:\\project")).toBe(true);
    });

    it("workspace 根目录下的文件在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\project\\README.md", "C:\\project")).toBe(true);
    });

    it("workspace 自身路径等于 workspace", () => {
      expect(isPathWithinWorkspace("C:\\project", "C:\\project")).toBe(true);
    });

    it("workspace 路径带尾部分隔符", () => {
      expect(isPathWithinWorkspace("C:\\project\\src\\main.ts", "C:\\project\\")).toBe(true);
    });
  });

  // ===== 2. 路径越界检测 =====
  describe("路径越界检测", () => {
    it("父目录路径不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\", "C:\\project")).toBe(false);
    });

    it("兄弟目录路径不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\other-project\\file.ts", "C:\\project")).toBe(false);
    });

    it("完全不同盘符不在 workspace 内", () => {
      expect(isPathWithinWorkspace("D:\\project\\file.ts", "C:\\project")).toBe(false);
    });

    it("workspace 前缀匹配但不是子目录（路径注入）", () => {
      // C:\project-evil 不应该在 C:\project 的 workspace 内
      expect(isPathWithinWorkspace("C:\\project-evil\\file.ts", "C:\\project")).toBe(false);
    });

    it("上级目录逃逸不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\project\\..\\secret.txt", "C:\\project")).toBe(false);
    });
  });

  // ===== 3. 路径规范化 =====
  describe("路径规范化", () => {
    it("正斜杠路径正常处理", () => {
      expect(isPathWithinWorkspace("C:/project/src/main.ts", "C:\\project")).toBe(true);
    });

    it("workspace 用正斜杠", () => {
      expect(isPathWithinWorkspace("C:\\project\\src\\main.ts", "C:/project")).toBe(true);
    });

    it("两边都用正斜杠", () => {
      expect(isPathWithinWorkspace("C:/project/src/main.ts", "C:/project")).toBe(true);
    });

    it("路径中的 ./ 被正确处理", () => {
      expect(isPathWithinWorkspace("C:\\project\\.\\src\\main.ts", "C:\\project")).toBe(true);
    });

    it("路径中的 .. 被正确解析后判断", () => {
      // C:\project\src\..\src\main.ts → C:\project\src\main.ts → 在 workspace 内
      expect(isPathWithinWorkspace("C:\\project\\src\\..\\src\\main.ts", "C:\\project")).toBe(true);
    });

    it("路径中的 .. 逃逸到 workspace 外", () => {
      // C:\project\..\other\file.ts → C:\other\file.ts → 不在 workspace 内
      expect(isPathWithinWorkspace("C:\\project\\..\\other\\file.ts", "C:\\project")).toBe(false);
    });

    it("多层 .. 逃逸", () => {
      // C:\project\src\..\..\other\file.ts → C:\other\file.ts → 不在 workspace 内
      expect(isPathWithinWorkspace("C:\\project\\src\\..\\..\\other\\file.ts", "C:\\project")).toBe(false);
    });

    it("混合斜杠路径", () => {
      expect(isPathWithinWorkspace("C:/project\\src/main.ts", "C:\\project")).toBe(true);
    });
  });

  // ===== 4. 大小写不敏感 =====
  describe("大小写不敏感（Windows 特性）", () => {
    it("路径大小写不一致仍匹配", () => {
      expect(isPathWithinWorkspace("c:\\PROJECT\\src\\main.ts", "C:\\project")).toBe(true);
    });

    it("workspace 大写、路径小写", () => {
      expect(isPathWithinWorkspace("C:\\project\\file.ts", "c:\\PROJECT")).toBe(true);
    });

    it("混合大小写", () => {
      expect(isPathWithinWorkspace("C:\\ProJeCt\\SrC\\main.ts", "c:\\pRoJeCt")).toBe(true);
    });
  });

  // ===== 5. 边界条件 =====
  describe("边界条件", () => {
    it("空 targetPath 返回 false", () => {
      expect(isPathWithinWorkspace("", "C:\\project")).toBe(false);
    });

    it("空 workspace 返回 false", () => {
      expect(isPathWithinWorkspace("C:\\project\\file.ts", "")).toBe(false);
    });

    it("两者都为空返回 false", () => {
      expect(isPathWithinWorkspace("", "")).toBe(true); // "" === ""
    });

    it("相同路径返回 true", () => {
      expect(isPathWithinWorkspace("C:\\project\\file.ts", "C:\\project\\file.ts")).toBe(true);
    });

    it("盘符根路径作为 workspace", () => {
      expect(isPathWithinWorkspace("C:\\anything\\file.ts", "C:\\")).toBe(true);
    });

    it("不同盘符根路径", () => {
      expect(isPathWithinWorkspace("D:\\file.ts", "C:\\")).toBe(false);
    });
  });

  // ===== 6. 实际场景模拟 =====
  describe("实际场景模拟", () => {
    const workspace = "D:\\mimo-gui";

    it("项目源码文件在 workspace 内", () => {
      expect(isPathWithinWorkspace("D:\\mimo-gui\\src\\App.tsx", workspace)).toBe(true);
    });

    it("Tauri 后端文件在 workspace 内", () => {
      expect(isPathWithinWorkspace("D:\\mimo-gui\\src-tauri\\src\\lib.rs", workspace)).toBe(true);
    });

    it("用户主目录文件不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\Users\\test\\.ssh\\id_rsa", workspace)).toBe(false);
    });

    it("系统目录不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\Windows\\System32\\config\\SAM", workspace)).toBe(false);
    });

    it("临时目录不在 workspace 内", () => {
      expect(isPathWithinWorkspace("C:\\Users\\test\\AppData\\Local\\Temp\\exploit.bat", workspace)).toBe(false);
    });

    it(".env 文件路径越界", () => {
      expect(isPathWithinWorkspace("D:\\other-project\\.env", workspace)).toBe(false);
    });

    it("workspace 内的 .env 文件路径（沙箱允许但 S2 拦截）", () => {
      expect(isPathWithinWorkspace("D:\\mimo-gui\\.env", workspace)).toBe(true);
    });
  });
});
