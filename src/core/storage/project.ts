import { getDatabase, persistDatabase } from "./database";
import type { Project } from "../types";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  description: string | null;
  created_at: number;
  last_accessed_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

export function listProjects(): Project[] {
  const db = getDatabase();
  const result = db.exec("SELECT * FROM projects ORDER BY last_accessed_at DESC");
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) =>
    rowToProject({
      id: row[0] as string,
      name: row[1] as string,
      path: row[2] as string,
      description: row[3] as string | null,
      created_at: row[4] as number,
      last_accessed_at: row[5] as number,
    })
  );
}

export function getProject(id: string): Project | null {
  const db = getDatabase();
  const result = db.exec("SELECT * FROM projects WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const row = result[0].values[0];
  return rowToProject({
    id: row[0] as string,
    name: row[1] as string,
    path: row[2] as string,
    description: row[3] as string | null,
    created_at: row[4] as number,
    last_accessed_at: row[5] as number,
  });
}

export function createProject(project: Project): void {
  const db = getDatabase();
  db.run(
    "INSERT INTO projects (id, name, path, description, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
    [project.id, project.name, project.path, project.description ?? null, project.createdAt, project.lastAccessedAt]
  );
  persistDatabase();
}

export function updateProject(id: string, update: Partial<Project>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.name !== undefined) { fields.push("name = ?"); values.push(update.name); }
  if (update.path !== undefined) { fields.push("path = ?"); values.push(update.path); }
  if (update.description !== undefined) { fields.push("description = ?"); values.push(update.description ?? null); }
  if (update.lastAccessedAt !== undefined) { fields.push("last_accessed_at = ?"); values.push(update.lastAccessedAt); }

  if (fields.length === 0) return;
  values.push(id);
  db.run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
  persistDatabase();
}

export function deleteProject(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM projects WHERE id = ?", [id]);
  persistDatabase();
}
