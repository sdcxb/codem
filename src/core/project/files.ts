import { readFile as apiReadFile, writeFile as apiWriteFile, executeCommand, listDirectory } from "../file-api";

// ========== Project File Operations ==========

export async function createProjectFiles(projectPath: string): Promise<void> {
  // Create .mimo directory structure
  await apiWriteFile(`${projectPath}\\.mimo\\skills\\.gitkeep`, "");
  await apiWriteFile(`${projectPath}\\.mimo\\rules\\.gitkeep`, "");
  await apiWriteFile(`${projectPath}\\.mimo\\memory\\.gitkeep`, "");

  // Create default AGENTS.md
  await apiWriteFile(
    `${projectPath}\\AGENTS.md`,
    `# ${projectPath.split("\\").pop()} 项目指令\n\n在此定义项目级别的指令和规则。\n\n## 规则\n\n- 使用中文回复\n- 代码注释使用中文\n\n## 技术栈\n\n（在此描述项目使用的技术栈）\n\n## 代码规范\n\n（在此描述代码规范）\n`
  );

  // Create default MEMORY.md
  await apiWriteFile(
    `${projectPath}\\.mimo\\memory\\MEMORY.md`,
    `# 项目记忆\n\n- [项目介绍](project-intro.md) -- 项目基本信息\n`
  );

  // Create memory entry
  await apiWriteFile(
    `${projectPath}\\.mimo\\memory\\project-intro.md`,
    `---\nname: 项目介绍\n description: 项目基本信息\ntype: project\n---\n\n项目刚刚创建，等待填充信息。\n`
  );
}

export async function loadProjectInstructions(projectPath: string): Promise<string> {
  try {
    return await apiReadFile(`${projectPath}\\AGENTS.md`);
  } catch {}
  return "";
}

export async function loadProjectSkills(projectPath: string): Promise<Array<{ name: string; content: string }>> {
  try {
    const entries = await listDirectory(`${projectPath}\\.mimo\\skills`);
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
    const entries = await listDirectory(`${projectPath}\\.mimo\\memory`);
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

export async function saveProjectSkill(projectPath: string, skillName: string, content: string): Promise<void> {
  await apiWriteFile(`${projectPath}\\.mimo\\skills\\${skillName}\\SKILL.md`, content);
}

export async function saveProjectMemory(projectPath: string, fileName: string, content: string): Promise<void> {
  await apiWriteFile(`${projectPath}\\.mimo\\memory\\${fileName}`, content);
}
