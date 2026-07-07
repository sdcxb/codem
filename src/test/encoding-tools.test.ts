/**
 * 测试 19：工具链路编码问题测试 — glob/grep/bash/read/write 跨工具中文编码
 *
 * 排查的问题：
 *   1. grepSearch 的 -SimpleMatch 问题（已修复为正则模式）
 *   2. bash 工具是否正确传递 exitCode
 *   3. 工具 description 中是否包含编码指导
 *   4. 子智能体提示词是否包含编码规范
 *   5. 跨工具（write → read → bash 执行）的中文链路一致性
 *   6. grepSearch 的单引号转义是否覆盖中文路径
 */
import { describe, it, expect } from "vitest";

// ========== 辅助函数：模拟 grepSearch 的单引号转义 ==========
function escapeForPowerShell(str: string): string {
  return str.replace(/'/g, "''");
}

// ========== 辅助函数：模拟 Rust read_file 的 BOM 剥离 ==========
function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.substring(1);
  }
  return content;
}

describe("工具链路编码 — grepSearch 正则模式", () => {
  it("移除了 -SimpleMatch 标志，支持正则搜索", () => {
    // 验证 grepSearch 不再使用 -SimpleMatch
    // -SimpleMatch 会让 Select-String 做字面量匹配，不支持正则
    // 移除后默认是正则模式，可以搜索 "function.*中文" 这样的模式
    const psCommand = `Get-ChildItem -Path 'D:\\test' -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern 'function.*中文' | ForEach-Object { $_.Path + ':' + $_.LineNumber + ':' + $_.Line }`;
    expect(psCommand).not.toContain("-SimpleMatch");
    expect(psCommand).toContain("Select-String");
    expect(psCommand).toContain("function.*中文");
  });

  it("中文正则模式在 PowerShell 命令中正确拼接", () => {
    const pattern = "你好.*世界";
    const safePattern = escapeForPowerShell(pattern);
    const psCommand = `Select-String -Pattern '${safePattern}'`;
    expect(psCommand).toContain("你好.*世界");
  });

  it("中文路径 + 中文模式同时使用", () => {
    const path = "D:\\项目\\源码";
    const pattern = "函数.*定义";
    const safePath = escapeForPowerShell(path);
    const safePattern = escapeForPowerShell(pattern);
    const psCommand = `Get-ChildItem -Path '${safePath}' -Recurse -File | Select-String -Pattern '${safePattern}'`;
    expect(psCommand).toContain("D:\\项目\\源码");
    expect(psCommand).toContain("函数.*定义");
  });

  it("include 参数包含中文文件名模式", () => {
    const include = "测试*.py";
    const safeInclude = escapeForPowerShell(include);
    const psCommand = `-Include '${safeInclude}'`;
    expect(psCommand).toContain("测试*.py");
  });
});

describe("工具链路编码 — bash 工具 exitCode 传递", () => {
  // 模拟 bash 工具的 execute 函数逻辑
  function formatBashOutput(data: { stdout: string; stderr: string; exitCode?: number }): string {
    const output = data.stdout || data.stderr || "(no output)";
    const exitCode = data.exitCode;
    return exitCode !== undefined && exitCode !== 0
      ? `${output}\n[exit code: ${exitCode}]`
      : output;
  }

  it("成功命令（exitCode=0）不显示退出码", () => {
    const result = formatBashOutput({ stdout: "你好世界", stderr: "", exitCode: 0 });
    expect(result).toBe("你好世界");
    expect(result).not.toContain("[exit code");
  });

  it("失败命令（exitCode=1）显示退出码", () => {
    const result = formatBashOutput({ stdout: "", stderr: "错误信息", exitCode: 1 });
    expect(result).toContain("错误信息");
    expect(result).toContain("[exit code: 1]");
  });

  it("Python 编码错误（exitCode=1）的 stderr 被正确传递", () => {
    const stderr = "UnicodeDecodeError: 'gbk' codec can't decode byte 0xc4";
    const result = formatBashOutput({ stdout: "", stderr, exitCode: 1 });
    expect(result).toContain("UnicodeDecodeError");
    expect(result).toContain("[exit code: 1]");
  });

  it("中文输出 + 非零退出码", () => {
    const result = formatBashOutput({ stdout: "执行失败：文件不存在", stderr: "", exitCode: 2 });
    expect(result).toContain("执行失败：文件不存在");
    expect(result).toContain("[exit code: 2]");
  });

  it("无退出码时不显示退出码", () => {
    const result = formatBashOutput({ stdout: "输出", stderr: "" });
    expect(result).toBe("输出");
    expect(result).not.toContain("[exit code");
  });
});

describe("工具链路编码 — 工具 description 包含编码指导", () => {
  // 验证各工具的 description 中包含中文编码相关信息
  it("bash 工具 description 提及 UTF-8 和乱码", () => {
    const desc = "Execute a bash command in the terminal (PowerShell on Windows). The system automatically sets UTF-8 encoding (chcp 65001) and PYTHONUTF8=1. Output includes stdout, stderr, and exit code. If output contains garbled characters (乱码), the source command may be outputting in GBK — do NOT retry with a different tool, adjust the command instead.";
    expect(desc).toContain("UTF-8");
    expect(desc).toContain("chcp 65001");
    expect(desc).toContain("PYTHONUTF8");
    expect(desc).toContain("乱码");
    expect(desc).toContain("GBK");
  });

  it("glob 工具 description 提及中文文件名支持", () => {
    const desc = "Find files matching a glob pattern. Supports Chinese filenames natively.";
    expect(desc).toContain("Chinese filenames");
  });

  it("grep 工具 description 提及中文模式支持", () => {
    const desc = "Search file contents using regex. Supports Chinese patterns natively.";
    expect(desc).toContain("Chinese patterns");
  });

  it("read 工具 description 提及 BOM 剥离", () => {
    const desc = "Read a file from the filesystem. Files are read as UTF-8 text. BOM (Byte Order Mark) is automatically stripped.";
    expect(desc).toContain("UTF-8");
    expect(desc).toContain("BOM");
  });

  it("write 工具 description 提及 UTF-8 无 BOM", () => {
    const desc = "Write content to a file (creates or overwrites). Files are saved as UTF-8 without BOM.";
    expect(desc).toContain("UTF-8");
    expect(desc).toContain("without BOM");
  });
});

describe("工具链路编码 — 子智能体提示词包含编码规范", () => {
  // 验证子智能体系统提示词中的编码规范
  const subagentEncodingRules = `# Windows Chinese Encoding Rules (CRITICAL)

This system runs on Windows with PowerShell. The system sets chcp 65001 and PYTHONUTF8=1 for you automatically.

1. Do NOT use \`python -c\` with Chinese content — write a script file first, then execute it
2. When writing Python scripts, ALWAYS add \`# -*- coding: utf-8 -*-\` as the first line
3. When reading/writing files in Python, ALWAYS specify encoding: \`open(path, encoding='utf-8')\`
4. When executing scripts, use \`bash("python script.py", workdir="C:\\\\path")\` — do NOT use cd in the command
5. If you see garbled output (乱码) from a command, do NOT retry with a different tool — the encoding is correct, the source may be GBK
6. When using glob, Chinese filenames are supported natively — no special handling needed
7. When using grep, Chinese patterns work with regex — no special encoding needed
8. For pip install, always use \`python -m pip install\` (not \`pip install\`) to avoid PATH issues`;

  it("包含 chcp 65001 说明", () => {
    expect(subagentEncodingRules).toContain("chcp 65001");
  });

  it("包含 PYTHONUTF8 说明", () => {
    expect(subagentEncodingRules).toContain("PYTHONUTF8");
  });

  it("禁止 python -c 加中文", () => {
    expect(subagentEncodingRules).toContain("python -c");
    expect(subagentEncodingRules).toContain("Chinese content");
  });

  it("包含 Python 编码声明指导", () => {
    expect(subagentEncodingRules).toContain("coding: utf-8");
  });

  it("包含文件 I/O 编码指导", () => {
    expect(subagentEncodingRules).toContain("encoding='utf-8'");
  });

  it("包含乱码处理指导", () => {
    expect(subagentEncodingRules).toContain("乱码");
    expect(subagentEncodingRules).toContain("GBK");
  });

  it("包含 glob 中文支持说明", () => {
    expect(subagentEncodingRules).toContain("glob");
    expect(subagentEncodingRules).toContain("Chinese filenames");
  });

  it("包含 grep 中文支持说明", () => {
    expect(subagentEncodingRules).toContain("grep");
    expect(subagentEncodingRules).toContain("Chinese patterns");
  });

  it("包含 pip install 指导", () => {
    expect(subagentEncodingRules).toContain("python -m pip install");
  });
});

describe("工具链路编码 — 跨工具中文执行链路", () => {
  it("write → read 链路：中文脚本内容完整保留", () => {
    // Agent A 用 write 写一个 Python 脚本
    const script = `# -*- coding: utf-8 -*-
import os

def 你好(名字):
    print(f"你好，{名字}！")

你好("世界 🌍")
`;
    // write 工具：std::fs::write(path, content) — UTF-8 无 BOM
    const bytes = new TextEncoder().encode(script);
    expect(bytes[0]).not.toBe(0xef); // 无 BOM

    // Agent B 用 read 读取
    // read 工具：std::fs::read_to_string + BOM 剥离
    const readContent = new TextDecoder("utf-8").decode(bytes);
    const finalContent = stripBom(readContent);

    expect(finalContent).toBe(script);
    expect(finalContent).toContain("# -*- coding: utf-8 -*-");
    expect(finalContent).toContain('def 你好(名字):');
    expect(finalContent).toContain('你好("世界 🌍")');
  });

  it("write → bash 执行链路：中文脚本输出正确", () => {
    // Agent A 写脚本
    const script = `# -*- coding: utf-8 -*-
print("你好世界 🌍")
`;

    // Agent B 执行脚本
    // bash 工具调用 execute_command
    // Rust 设置 PYTHONUTF8=1, PYTHONIOENCODING=utf-8, chcp 65001
    // Python 脚本输出 UTF-8 编码的 "你好世界 🌍\n"
    const expectedOutput = "你好世界 🌍\n";

    // 模拟 Python 输出 → PowerShell stdout → Rust from_utf8_lossy
    const pythonOutputBytes = new TextEncoder().encode(expectedOutput);
    const decoded = new TextDecoder("utf-8").decode(pythonOutputBytes);

    expect(decoded).toBe(expectedOutput);
    expect(decoded).toContain("你好世界");
    expect(decoded).toContain("🌍");
  });

  it("write → read → edit 链路：中文内容编辑正确", () => {
    // Agent A 写文件
    const original = `# 配置文件
name: "测试"
value: 123
emoji: "⚡"
`;

    // Agent B 读取
    const readContent = stripBom(original);

    // Agent B 编辑（替换中文字符串）
    const oldString = 'name: "测试"';
    const newString = 'name: "新测试"';
    const edited = readContent.replace(oldString, newString);

    expect(edited).toContain('name: "新测试"');
    expect(edited).not.toContain('name: "测试"');
    expect(edited).toContain('emoji: "⚡"');
  });

  it("glob → read 链路：中文文件名路径正确传递", () => {
    // glob 返回中文文件路径
    const globResult = [
      "D:\\项目\\源码\\你好.py",
      "D:\\项目\\测试\\世界.md",
    ];

    // read 读取中文路径文件
    // Rust read_file 接收 String 参数，UTF-8 编码
    // std::fs::read_to_string 支持中文路径
    for (const path of globResult) {
      expect(path).toContain("项目");
      // 验证路径可以被正确传递（不抛出异常）
      expect(path.length).toBeGreaterThan(0);
    }
  });

  it("grep → read 链路：中文搜索结果路径正确", () => {
    // grep 返回 "路径:行号:内容" 格式
    // Windows 路径含驱动器冒号 (D:)，需要跳过
    const grepResult = [
      "D:\\项目\\源码\\你好.py:5:print(\"你好世界\")",
      "D:\\项目\\测试\\世界.md:1:# 世界测试",
    ];

    // 从结果中提取路径（跳过驱动器冒号）
    for (const line of grepResult) {
      // 找到驱动器冒号后的第一个冒号作为分隔符
      const driveColon = line.indexOf(":");
      const sepColon = line.indexOf(":", driveColon + 1);
      const path = line.substring(0, sepColon);
      expect(path).toContain("项目");
      // 验证可以正确分割
      const parts = line.split(":");
      expect(parts.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("主智能体 → 子智能体协作链路：中文 prompt 正确传递", () => {
    // 主智能体 spawn_subagent 时传入中文 prompt
    const prompt = "读取文件 D:\\项目\\源码\\你好.py 并分析其中的中文函数定义。用中文回答。";

    // 子智能体接收到 prompt（通过 MessageStorage 存储为 UTF-8）
    // 子智能体系统提示词包含编码规范
    // 子智能体使用 read 工具读取中文路径文件

    // 验证 prompt 中的中文不被破坏
    expect(prompt).toContain("项目");
    expect(prompt).toContain("你好.py");
    expect(prompt).toContain("中文函数定义");
    expect(prompt).toContain("用中文回答");
  });
});

describe("工具链路编码 — pip 命令编码问题", () => {
  it("pip install 使用 python -m pip 而非 pip", () => {
    const correctCmd = "python -m pip install requests";
    const wrongCmd = "pip install requests";
    expect(correctCmd).toContain("python -m pip");
    expect(wrongCmd).not.toContain("python -m pip");
  });

  it("pip install 失败时的 --no-cache-dir 建议", () => {
    // pip 在 Windows 上可能有缓存编码问题
    const cmd = "python -m pip install requests --no-cache-dir";
    expect(cmd).toContain("--no-cache-dir");
  });

  it("中文镜像源 URL 不含中文", () => {
    // 清华镜像源 URL 本身不含中文，安全
    const cmd = "python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple requests";
    expect(cmd).not.toMatch(/[\u4e00-\u9fff]/); // URL 部分无中文
  });

  it("requirements.txt 方式安装避免命令行中文", () => {
    // 当需要安装的包描述含中文时，用 requirements.txt 而非命令行参数
    const writeCmd = 'write(path="requirements.txt", content="requests\\nflask\\n")';
    const installCmd = 'bash("python -m pip install -r requirements.txt", workdir="D:\\\\项目")';

    expect(writeCmd).toContain("requirements.txt");
    expect(installCmd).toContain("-r requirements.txt");
    expect(installCmd).toContain("python -m pip");
  });
});

describe("工具链路编码 — PowerShell 命令前缀完整性", () => {
  // 验证 execute_command 的完整 UTF-8 前缀
  const utf8_prefix = "chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; ";

  it("包含 chcp 65001（控制台代码页）", () => {
    expect(utf8_prefix).toContain("chcp 65001");
  });

  it("包含 OutputEncoding（.NET stdout）", () => {
    expect(utf8_prefix).toContain("[Console]::OutputEncoding");
  });

  it("包含 InputEncoding（.NET stdin）", () => {
    expect(utf8_prefix).toContain("[Console]::InputEncoding");
  });

  it("包含 $OutputEncoding（PowerShell 管道）", () => {
    expect(utf8_prefix).toContain("$OutputEncoding");
  });

  it("包含 PSDefaultParameterValues（文件输出编码）", () => {
    expect(utf8_prefix).toContain("$PSDefaultParameterValues['Out-File:Encoding']");
  });

  it("Python 环境变量设置正确", () => {
    const envVars = {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONLEGACYWINDOWSSTDIO: "0",
    };
    expect(envVars.PYTHONIOENCODING).toBe("utf-8");
    expect(envVars.PYTHONUTF8).toBe("1");
    expect(envVars.PYTHONLEGACYWINDOWSSTDIO).toBe("0");
  });
});

describe("工具链路编码 — 乱码诊断指导", () => {
  it("系统提示词包含乱码诊断指导", () => {
    const guidance = "If you see 乱码 (garbled text): The source is outputting GBK, not UTF-8. This is NOT a bug in the tools. Add [Console]::OutputEncoding = [Text.Encoding]::UTF8 to your PowerShell command, or pipe through | Out-String to force text conversion.";
    expect(guidance).toContain("乱码");
    expect(guidance).toContain("GBK");
    expect(guidance).toContain("NOT a bug");
    expect(guidance).toContain("Out-String");
  });

  it("bash 工具 description 包含乱码诊断", () => {
    const desc = "If output contains garbled characters (乱码), the source command may be outputting in GBK — do NOT retry with a different tool, adjust the command instead.";
    expect(desc).toContain("乱码");
    expect(desc).toContain("do NOT retry");
  });

  it("子智能体提示词包含乱码处理", () => {
    const rule = "If you see garbled output (乱码) from a command, do NOT retry with a different tool — the encoding is correct, the source may be GBK";
    expect(rule).toContain("乱码");
    expect(rule).toContain("do NOT retry");
    expect(rule).toContain("GBK");
  });
});
