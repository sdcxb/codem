/**
 * 测试 6：项目删除不依赖 localStorage
 *
 * 改动影响：
 *   - App.tsx 删除项目时删除了 localStorage.setItem("mimo-projects", ...) 调用
 *   - ProjectManager.tsx 删除了 localStorage 读写 mimo-projects 的所有调用
 *   - 项目数据完全由 SQLite projects 表管理
 *   - 如果有误，删除项目后侧边栏仍显示已删除项目，或项目列表不一致
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase } from "../core/storage/database";
import * as ProjectStorage from "../core/storage/project";

describe("项目删除不依赖 localStorage", () => {
  beforeEach(async () => {
    await initDatabase();
    localStorage.clear();
  });

  it("创建项目后能从 SQLite 读取", () => {
    ProjectStorage.createProject({
      id: "proj-1",
      name: "Test Project",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    const projects = ProjectStorage.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("Test Project");
  });

  it("删除项目后 SQLite 中不再存在", () => {
    ProjectStorage.createProject({
      id: "proj-1",
      name: "Test Project",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.deleteProject("proj-1");

    const projects = ProjectStorage.listProjects();
    expect(projects).toHaveLength(0);
  });

  it("删除项目不触发 localStorage.setItem", () => {
    const setItemSpy = vi.spyOn(localStorage, "setItem");

    ProjectStorage.createProject({
      id: "proj-1",
      name: "Test Project",
      path: "D:\\test",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.deleteProject("proj-1");

    // 验证 localStorage.setItem 没有被调用
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it("删除项目不影响其他项目", () => {
    ProjectStorage.createProject({
      id: "proj-1",
      name: "Project A",
      path: "D:\\a",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.createProject({
      id: "proj-2",
      name: "Project B",
      path: "D:\\b",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    ProjectStorage.deleteProject("proj-1");

    const projects = ProjectStorage.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("proj-2");
    expect(projects[0].name).toBe("Project B");
  });

  it("项目列表完全从 SQLite 读取，不依赖 localStorage", () => {
    // 不在 localStorage 中写入任何内容
    ProjectStorage.createProject({
      id: "proj-1",
      name: "SQLite Project",
      path: "D:\\sqlite",
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    // localStorage 中没有 mimo-projects
    expect(localStorage.getItem("mimo-projects")).toBeNull();
    expect(localStorage.getItem("codem-projects")).toBeNull();

    // 但能从 SQLite 读取
    const projects = ProjectStorage.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("SQLite Project");
  });
});
