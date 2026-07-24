import { readFile as apiReadFile, writeFile as apiWriteFile, executeCommand, listDirectory } from "../file-api";

// ========== F2.3: AGENTS.md Fallback Filenames ==========

/** Fallback filenames for project instruction files (checked in order) */
const AGENTS_MD_FALLBACKS = [
  "AGENTS.override.md",
  "AGENTS.md",
  "TEAM_GUIDE.md",   // Team guide
  ".cursorrules",     // Cursor rules
  "CONTRIBUTING.md", // Contributing guide
];

// ========== F2.2: Project Root Auto-Detection ==========

/** Markers that indicate a project root directory */
const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  ".codem",
  "AGENTS.md",
];

/**
 * F2.2: Detect project root by walking up from a directory looking for markers.
 * Returns the first directory containing a known marker, or the input directory if none found.
 */
export async function detectProjectRoot(startDir: string): Promise<string> {
  const parts = startDir.replace(/\\/g, "/").split("/").filter(Boolean);
  let current = startDir;

  // Walk up the directory tree
  for (let i = parts.length; i >= 0; i--) {
    const testPath = i === 0
      ? (startDir.startsWith("/") ? "/" : startDir.substring(0, 2)) // root or drive letter
      : parts.slice(0, i).join("/");

    // Check for any marker
    for (const marker of PROJECT_ROOT_MARKERS) {
      try {
        await apiReadFile(`${testPath}/${marker}`);
        return testPath;
      } catch {
        // Not found — try next marker
      }
    }
    current = testPath;
  }

  // No marker found — return the original directory
  return startDir;
}

// ========== Project File Operations ==========

export async function createProjectFiles(projectPath: string): Promise<void> {
  // Create .codem directory structure
  await apiWriteFile(`${projectPath}\\.codem\\skills\\.gitkeep`, "");
  await apiWriteFile(`${projectPath}\\.codem\\rules\\.gitkeep`, "");
  await apiWriteFile(`${projectPath}\\.codem\\memory\\.gitkeep`, "");

  // Create default AGENTS.md
  await apiWriteFile(
    `${projectPath}\\AGENTS.md`,
    `# ${projectPath.split("\\").pop()} 项目指令\n\n在此定义项目级别的指令和规则。\n\n## 规则\n\n- 使用中文回复\n- 代码注释使用中文\n\n## 技术栈\n\n（在此描述项目使用的技术栈）\n\n## 代码规范\n\n（在此描述代码规范）\n`
  );

  // Create default MEMORY.md
  await apiWriteFile(
    `${projectPath}\\.codem\\memory\\MEMORY.md`,
    `# 项目记忆\n\n- [项目介绍](project-intro.md) -- 项目基本信息\n`
  );

  // Create memory entry
  await apiWriteFile(
    `${projectPath}\\.codem\\memory\\project-intro.md`,
    `---\nname: 项目介绍\n description: 项目基本信息\ntype: project\n---\n\n项目刚刚创建，等待填充信息。\n`
  );
}

export async function loadProjectInstructions(projectPath: string): Promise<string> {
  // Try project root AGENTS.md
  try {
    return await apiReadFile(`${projectPath}\\AGENTS.md`);
  } catch {}
  return "";
}

/**
 * F2.3: Try to read a file from a list of fallback filenames.
 * Returns the first successfully read file's content, or empty string.
 */
async function readWithFallbacks(dir: string, filenames: string[]): Promise<string> {
  for (const name of filenames) {
    try {
      const content = await apiReadFile(`${dir}\\${name}`);
      if (content.trim()) return content;
    } catch {}
  }
  return "";
}

/**
 * Discover project instruction files in a hierarchical manner:
 * 1. Global: ~/.codem/AGENTS.md (or fallbacks)
 * 2. Project root: {projectPath}/AGENTS.md (or fallbacks)
 * 3. Current working directory: walk from project root to cwd, checking each level
 *
 * F2.3: Now supports fallback filenames (TEAM_GUIDE.md, .cursorrules, etc.)
 *
 * @param projectPath - The project root directory
 * @param cwd - The current working directory (optional, defaults to projectPath)
 * @param maxBytes - Maximum combined bytes (default 32KB)
 */
export async function loadHierarchicalProjectInstructions(
  projectPath: string,
  cwd?: string,
  maxBytes: number = 32768,
): Promise<string> {
  const sections: string[] = [];
  let totalBytes = 0;

  // Layer 1: Global instructions (~/.codem/AGENTS.md or fallbacks)
  try {
    const homeDir = await executeCommand("echo %USERPROFILE%", undefined)
      .then(r => r.stdout.trim())
      .catch(() => "");
    if (homeDir) {
      const globalContent = await readWithFallbacks(`${homeDir}\\.codem`, AGENTS_MD_FALLBACKS);
      if (globalContent.trim()) {
        const bytes = Buffer.byteLength(globalContent, "utf-8");
        if (totalBytes + bytes <= maxBytes) {
          sections.push(`<!-- Global Instructions -->\n${globalContent}`);
          totalBytes += bytes;
        }
      }
    }
  } catch {}

  // Layer 2: Project root AGENTS.md (with fallbacks)
  {
    const projectContent = await readWithFallbacks(projectPath, AGENTS_MD_FALLBACKS);
    if (projectContent.trim()) {
      const bytes = Buffer.byteLength(projectContent, "utf-8");
      if (totalBytes + bytes <= maxBytes) {
        sections.push(`<!-- Project Instructions -->\n${projectContent}`);
        totalBytes += bytes;
      }
    }
  }

  // Layer 3: Nested directory instructions (from project root to cwd)
  const targetDir = cwd || projectPath;
  if (targetDir !== projectPath && targetDir.startsWith(projectPath)) {
    const relativePath = targetDir.substring(projectPath.length).split("\\").filter(Boolean);
    let currentPath = projectPath;

    for (const dir of relativePath) {
      currentPath = `${currentPath}\\${dir}`;
      const nestedContent = await readWithFallbacks(currentPath, AGENTS_MD_FALLBACKS);
      if (nestedContent.trim()) {
        const bytes = Buffer.byteLength(nestedContent, "utf-8");
        if (totalBytes + bytes <= maxBytes) {
          sections.push(`<!-- ${dir} Instructions -->\n${nestedContent}`);
          totalBytes += bytes;
        }
      }
    }
  }

  return sections.join("\n\n---\n\n");
}

export async function loadProjectSkills(projectPath: string): Promise<Array<{ name: string; content: string }>> {
  try {
    const entries = await listDirectory(`${projectPath}\\.codem\\skills`);
    const skills = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        try {
          const content = await apiReadFile(`${entry.path}\\SKILL.md`);
          skills.push({ name: entry.name, content });
        } catch {}
      }
    }
    return skills;
  } catch {
    return [];
  }
}

export async function loadProjectMemory(projectPath: string): Promise<Array<{ name: string; content: string }>> {
  try {
    const entries = await listDirectory(`${projectPath}\\.codem\\memory`);
    const memories = [];
    for (const entry of entries) {
      if (!entry.isDirectory && entry.name.endsWith(".md")) {
        try {
          const content = await apiReadFile(entry.path);
          memories.push({ name: entry.name, content });
        } catch {}
      }
    }
    return memories;
  } catch {
    return [];
  }
}

export async function saveProjectInstructions(projectPath: string, content: string): Promise<void> {
  await apiWriteFile(`${projectPath}\\AGENTS.md`, content);
}

// ========== F3.3: AGENTS.md Auto-Generation ==========

interface ProjectAnalysis {
  name: string;
  techStack: string[];
  languages: string[];
  frameworks: string[];
  buildTool: string | null;
  packageManager: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  formatCommand: string | null;
  keyDirectories: { name: string; description: string }[];
  conventions: string[];
}

/**
 * F3.3: Scan project structure and generate an initial AGENTS.md template.
 *
 * Detects:
 * - Project name from package.json / Cargo.toml / pyproject.toml / go.mod
 * - Tech stack from config files
 * - Key directories (src, tests, docs, etc.)
 * - Build/test/lint commands
 * - Language and framework conventions
 *
 * Returns the generated AGENTS.md content string.
 */
export async function generateAgentsMd(projectPath: string): Promise<string> {
  const analysis = await analyzeProject(projectPath);
  return buildAgentsMdFromAnalysis(analysis);
}

/**
 * Analyze project structure by reading config files and directory listing.
 */
async function analyzeProject(projectPath: string): Promise<ProjectAnalysis> {
  const analysis: ProjectAnalysis = {
    name: projectPath.split(/[\\/]/).pop() || "project",
    techStack: [],
    languages: [],
    frameworks: [],
    buildTool: null,
    packageManager: null,
    testCommand: null,
    lintCommand: null,
    formatCommand: null,
    keyDirectories: [],
    conventions: [],
  };

  // --- Detect from package.json (Node.js / TypeScript) ---
  try {
    const pkgContent = await apiReadFile(`${projectPath}\\package.json`);
    const pkg = JSON.parse(pkgContent);
    analysis.name = pkg.name || analysis.name;

    if (pkg.scripts) {
      if (pkg.scripts.build) analysis.buildTool = `npm run build`;
      if (pkg.scripts.test) analysis.testCommand = `npm test`;
      if (pkg.scripts.lint) analysis.lintCommand = `npm run lint`;
      if (pkg.scripts.format) analysis.formatCommand = `npm run format`;
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.typescript) { analysis.languages.push("TypeScript"); analysis.techStack.push("TypeScript"); }
    if (deps.react) { analysis.frameworks.push("React"); analysis.techStack.push("React"); }
    if (deps.vue) { analysis.frameworks.push("Vue"); analysis.techStack.push("Vue"); }
    if (deps.next) { analysis.frameworks.push("Next.js"); analysis.techStack.push("Next.js"); }
    if (deps.express) { analysis.frameworks.push("Express"); analysis.techStack.push("Express"); }
    if (deps.tauri || deps["@tauri-apps/api"]) { analysis.frameworks.push("Tauri"); analysis.techStack.push("Tauri (Rust backend)"); }
    if (deps.vite) { analysis.buildTool = `npm run build (Vite)`; }
    if (deps.eslint) { analysis.lintCommand = analysis.lintCommand || "npx eslint"; }
    if (deps.prettier) { analysis.formatCommand = analysis.formatCommand || "npx prettier"; }
    if (deps.jest || deps.vitest) { analysis.testCommand = analysis.testCommand || "npm test"; }

    analysis.packageManager = "npm";
    // Check for lock files
    try { await apiReadFile(`${projectPath}\\pnpm-lock.yaml`); analysis.packageManager = "pnpm"; } catch {}
    try { await apiReadFile(`${projectPath}\\yarn.lock`); analysis.packageManager = "yarn"; } catch {}
    try { await apiReadFile(`${projectPath}\\bun.lockb`); analysis.packageManager = "bun"; } catch {}
  } catch {}

  // --- Detect from Cargo.toml (Rust) ---
  try {
    const cargoContent = await apiReadFile(`${projectPath}\\Cargo.toml`);
    analysis.languages.push("Rust");
    analysis.techStack.push("Rust");
    analysis.buildTool = analysis.buildTool || "cargo build";
    analysis.testCommand = analysis.testCommand || "cargo test";
    analysis.lintCommand = analysis.lintCommand || "cargo clippy";
    analysis.formatCommand = analysis.formatCommand || "cargo fmt";
    analysis.packageManager = "cargo";

    // Extract crate name
    const nameMatch = cargoContent.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) analysis.name = nameMatch[1];
  } catch {}

  // --- Detect from pyproject.toml / setup.py (Python) ---
  try {
    await apiReadFile(`${projectPath}\\pyproject.toml`);
    analysis.languages.push("Python");
    analysis.techStack.push("Python");
    analysis.packageManager = analysis.packageManager || "pip";
    analysis.testCommand = analysis.testCommand || "pytest";
    analysis.lintCommand = analysis.lintCommand || "ruff check";
    analysis.formatCommand = analysis.formatCommand || "ruff format";
  } catch {}

  try {
    await apiReadFile(`${projectPath}\\setup.py`);
    analysis.languages.push("Python");
    analysis.techStack.push("Python");
    analysis.packageManager = analysis.packageManager || "pip";
  } catch {}

  // --- Detect from go.mod (Go) ---
  try {
    const goMod = await apiReadFile(`${projectPath}\\go.mod`);
    analysis.languages.push("Go");
    analysis.techStack.push("Go");
    analysis.packageManager = "go";
    analysis.buildTool = analysis.buildTool || "go build";
    analysis.testCommand = analysis.testCommand || "go test ./...";
    const modMatch = goMod.match(/^module\s+(\S+)/m);
    if (modMatch) analysis.name = modMatch[1].split("/").pop() || analysis.name;
  } catch {}

  // --- Detect key directories ---
  const knownDirs: Record<string, string> = {
    src: "源代码目录",
    lib: "库代码目录",
    components: "组件目录",
    pages: "页面目录",
    app: "应用入口目录",
    api: "API 接口目录",
    routes: "路由定义目录",
    services: "服务层目录",
    utils: "工具函数目录",
    tests: "测试目录",
    test: "测试目录",
    __tests__: "测试目录",
    docs: "文档目录",
    doc: "文档目录",
    scripts: "脚本目录",
    config: "配置目录",
    public: "静态资源目录",
    static: "静态资源目录",
    assets: "资源目录",
    styles: "样式目录",
    types: "类型定义目录",
    models: "数据模型目录",
    store: "状态管理目录",
    hooks: "自定义 Hook 目录",
    middleware: "中间件目录",
    plugins: "插件目录",
    migrations: "数据库迁移目录",
    "src-tauri": "Tauri Rust 后端目录",
  };

  try {
    const entries = await listDirectory(projectPath);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const desc = knownDirs[entry.name];
      if (desc) {
        analysis.keyDirectories.push({ name: entry.name, description: desc });
      }
    }
  } catch {}

  // --- Generate conventions based on detected stack ---
  if (analysis.languages.includes("TypeScript")) {
    analysis.conventions.push("使用 TypeScript 严格模式，避免 any 类型");
    analysis.conventions.push("函数和变量使用 camelCase，类型和接口使用 PascalCase");
  }
  if (analysis.frameworks.includes("React")) {
    analysis.conventions.push("React 组件使用函数式组件和 Hooks");
    analysis.conventions.push("组件文件名使用 PascalCase（如 MyComponent.tsx）");
  }
  if (analysis.languages.includes("Rust")) {
    analysis.conventions.push("Rust 代码使用 snake_case 命名函数和变量");
    analysis.conventions.push("避免 unwrap()，使用 ? 运算符或 match 处理错误");
  }
  if (analysis.languages.includes("Python")) {
    analysis.conventions.push("Python 代码使用 snake_case 命名函数和变量");
    analysis.conventions.push("使用 type hints 标注函数参数和返回值");
  }
  if (analysis.languages.includes("Go")) {
    analysis.conventions.push("Go 代码使用 camelCase 命名（导出用 PascalCase）");
    analysis.conventions.push("错误必须检查，不要忽略 error 返回值");
  }
  analysis.conventions.push("代码注释使用中文");
  analysis.conventions.push("提交信息使用中文，格式：类型: 简述（如 修复: 登录页面样式问题）");

  return analysis;
}

/**
 * Build the AGENTS.md markdown content from project analysis.
 */
function buildAgentsMdFromAnalysis(a: ProjectAnalysis): string {
  const lines: string[] = [];

  lines.push(`# ${a.name} 项目指令`);
  lines.push("");
  lines.push("> 此文件由 Codem 自动生成，用于指导 AI 助手理解和操作本项目。");
  lines.push("> 请根据项目实际情况修改和补充。");
  lines.push("");

  // Tech stack
  if (a.techStack.length > 0) {
    lines.push("## 技术栈");
    lines.push("");
    for (const tech of a.techStack) {
      lines.push(`- ${tech}`);
    }
    lines.push("");
  }

  // Languages
  if (a.languages.length > 0) {
    lines.push("## 编程语言");
    lines.push("");
    lines.push(a.languages.join(" / "));
    lines.push("");
  }

  // Frameworks
  if (a.frameworks.length > 0) {
    lines.push("## 框架");
    lines.push("");
    for (const fw of a.frameworks) {
      lines.push(`- ${fw}`);
    }
    lines.push("");
  }

  // Key directories
  if (a.keyDirectories.length > 0) {
    lines.push("## 项目结构");
    lines.push("");
    lines.push("```");
    lines.push(`${a.name}/`);
    for (const dir of a.keyDirectories) {
      lines.push(`├── ${dir.name}/  # ${dir.description}`);
    }
    lines.push("```");
    lines.push("");
  }

  // Build & Development commands
  lines.push("## 构建与开发命令");
  lines.push("");
  if (a.packageManager) {
    lines.push(`- 包管理器: \`${a.packageManager}\``);
  }
  if (a.buildTool) {
    lines.push(`- 构建: \`${a.buildTool}\``);
  }
  if (a.testCommand) {
    lines.push(`- 测试: \`${a.testCommand}\``);
  }
  if (a.lintCommand) {
    lines.push(`- Lint: \`${a.lintCommand}\``);
  }
  if (a.formatCommand) {
    lines.push(`- 格式化: \`${a.formatCommand}\``);
  }
  if (!a.buildTool && !a.testCommand && !a.lintCommand) {
    lines.push("- （未检测到构建工具，请手动补充）");
  }
  lines.push("");

  // Conventions
  if (a.conventions.length > 0) {
    lines.push("## 代码规范");
    lines.push("");
    for (const conv of a.conventions) {
      lines.push(`- ${conv}`);
    }
    lines.push("");
  }

  // Rules for AI
  lines.push("## AI 助手规则");
  lines.push("");
  lines.push("- 使用中文回复");
  lines.push("- 修改代码前先阅读相关文件，理解上下文");
  lines.push("- 优先使用 `edit` 或 `multi_edit` 工具修改文件，避免全量覆写");
  lines.push("- 不要修改 `.git`、`.env`、`node_modules` 等受保护路径");
  lines.push("- 运行测试验证修改后的代码是否正确");
  lines.push("- 提交前运行 lint 检查代码风格");
  lines.push("");

  // Common pitfalls (placeholder for user to fill)
  lines.push("## 常见陷阱");
  lines.push("");
  lines.push("<!-- 在此记录项目中常见的陷阱和注意事项 -->");
  lines.push("<!-- 例如：Windows 下路径使用反斜杠，Python 脚本需要指定 UTF-8 编码等 -->");
  lines.push("");

  return lines.join("\n");
}

export async function saveProjectSkill(projectPath: string, skillName: string, content: string): Promise<void> {
  await apiWriteFile(`${projectPath}\\.codem\\skills\\${skillName}\\SKILL.md`, content);
}

export async function saveProjectMemory(projectPath: string, fileName: string, content: string): Promise<void> {
  await apiWriteFile(`${projectPath}\\.codem\\memory\\${fileName}`, content);
}
