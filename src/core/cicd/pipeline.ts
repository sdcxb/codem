/**
 * P3-29: CI/CD Integration — GitHub Actions pipeline 生成和监控
 *
 * 功能：
 * 1. 生成 GitHub Actions workflow YAML — 根据项目类型自动生成 CI 模板
 * 2. 监控 CI/CD 运行状态 — 通过 GitHub API 获取 workflow runs
 * 3. 触发 workflow — 通过 API 触发手动 dispatch
 * 4. 重试失败的 workflow
 *
 * 依赖：GitHub Personal Access Token（存储在 settings 中）
 */

import { getSettingJSON } from "../storage/settings";
import type { GitConfig } from "../settings/settings";
import { getLang } from "../i18n/lang";

const GITHUB_API = "https://api.github.com";

/** GitHub API fetch with timeout — 防慢 API 挂起（对标 dsh deadline） */
async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ========== Types ==========

export interface WorkflowFile {
  /** 相对路径，如 .github/workflows/ci.yml */
  path: string;
  /** 文件内容（YAML） */
  content: string;
  /** Workflow 名称 */
  name: string;
  /** 触发条件描述 */
  triggers: string[];
}

export interface WorkflowRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | "waiting" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "neutral" | "skipped" | "timed_out" | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  headSha: string;
  event: string;
  runNumber: number;
  /** 各 job 的状态（需要单独 API 调用） */
  jobs?: WorkflowJob[];
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
  startedAt: string;
  completedAt: string;
  steps: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "cancelled" | "skipped" | null;
    number: number;
  }>;
}

export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "generic";

export interface PipelineTemplate {
  type: ProjectType;
  name: string;
  description: string;
}

// ========== Token Helper ==========

/** 从 codem-git-config 读取用户配置的 GitHub Token */
function getGithubToken(): string {
  try {
    const gitConfig = getSettingJSON<GitConfig | null>("codem-git-config", null);
    return gitConfig?.githubToken || "";
  } catch {
    return "";
  }
}

function githubHeaders(token: string, accept = "application/vnd.github.v3+json"): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
  };
}

// ========== Workflow Generation ==========

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  { type: "node", name: "Node.js CI", description: "Install, lint, test, build for Node.js projects" },
  { type: "python", name: "Python CI", description: "Install, lint, test for Python projects" },
  { type: "rust", name: "Rust CI", description: "Build, test, clippy for Rust projects" },
  { type: "go", name: "Go CI", description: "Build, test, vet for Go projects" },
  { type: "java", name: "Java CI", description: "Build, test with Maven/Gradle for Java projects" },
  { type: "generic", name: "Generic CI", description: "Basic CI for any project type" },
];

/**
 * 根据项目类型生成 GitHub Actions workflow YAML。
 */
export function generateWorkflow(type: ProjectType, options?: {
  nodeVersions?: string[];
  pythonVersions?: string[];
  branches?: string[];
}): WorkflowFile {
  const branches = options?.branches || ["main", "master"];
  const branchFilter = branches.map(b => `"${b}"`).join(", ");

  switch (type) {
    case "node":
      return generateNodeWorkflow(options?.nodeVersions || ["18", "20", "22"], branchFilter);
    case "python":
      return generatePythonWorkflow(options?.pythonVersions || ["3.10", "3.11", "3.12"], branchFilter);
    case "rust":
      return generateRustWorkflow(branchFilter);
    case "go":
      return generateGoWorkflow(branchFilter);
    case "java":
      return generateJavaWorkflow(branchFilter);
    case "generic":
    default:
      return generateGenericWorkflow(branchFilter);
  }
}

function generateNodeWorkflow(nodeVersions: string[], branchFilter: string): WorkflowFile {
  const versionsYaml = nodeVersions.map(v => `          - "${v}"`).join("\n");
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [${nodeVersions.map(v => `"${v}"`).join(", ")}]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run lint --if-present
      - run: npm run build --if-present
      - run: npm test
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Node.js CI",
    triggers: ["push", "pull_request"],
  };
}

function generatePythonWorkflow(pythonVersions: string[], branchFilter: string): WorkflowFile {
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: [${pythonVersions.map(v => `"${v}"`).join(", ")}]
    steps:
      - uses: actions/checkout@v4
      - name: Set up Python \${{ matrix.python-version }}
        uses: actions/setup-python@v5
        with:
          python-version: \${{ matrix.python-version }}
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install flake8 pytest mypy
          if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
      - name: Lint with flake8
        run: |
          flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics
      - name: Type check with mypy
        run: mypy . --ignore-missing-imports || true
      - name: Test with pytest
        run: pytest
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Python CI",
    triggers: ["push", "pull_request"],
  };
}

function generateRustWorkflow(branchFilter: string): WorkflowFile {
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - name: Build
        run: cargo build --verbose
      - name: Run tests
        run: cargo test --verbose
      - name: Clippy
        run: cargo clippy -- -D warnings
      - name: Format check
        run: cargo fmt --all -- --check
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Rust CI",
    triggers: ["push", "pull_request"],
  };
}

function generateGoWorkflow(branchFilter: string): WorkflowFile {
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Build
        run: go build -v ./...
      - name: Test
        run: go test -v ./...
      - name: Vet
        run: go vet ./...
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Go CI",
    triggers: ["push", "pull_request"],
  };
}

function generateJavaWorkflow(branchFilter: string): WorkflowFile {
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        java: ['17', '21']
    steps:
      - uses: actions/checkout@v4
      - name: Set up JDK \${{ matrix.java }}
        uses: actions/setup-java@v4
        with:
          java-version: \${{ matrix.java }}
          distribution: 'temurin'
      - name: Build with Maven
        run: mvn -B package --file pom.xml
      - name: Build with Gradle
        run: ./gradlew build
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Java CI",
    triggers: ["push", "pull_request"],
  };
}

function generateGenericWorkflow(branchFilter: string): WorkflowFile {
  const content = `name: CI

on:
  push:
    branches: [${branchFilter}]
  pull_request:
    branches: [${branchFilter}]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run build script
        run: |
          if [ -f Makefile ]; then make; fi
          if [ -f build.sh ]; then ./build.sh; fi
      - name: Run tests
        run: |
          if [ -f Makefile ]; then make test; fi
          if [ -f test.sh ]; then ./test.sh; fi
`;

  return {
    path: ".github/workflows/ci.yml",
    content,
    name: "Generic CI",
    triggers: ["push", "pull_request"],
  };
}

// ========== Workflow Monitoring ==========

/**
 * 获取仓库的 GitHub Actions workflow 列表。
 */
export async function listWorkflows(owner: string, repo: string): Promise<{
  workflows: Array<{ id: number; name: string; path: string; state: string; created_at: string; updated_at: string }>;
  error?: string;
}> {
  const token = getGithubToken();
  if (!token) return { workflows: [], error: "GitHub token not configured" };

  try {
    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/workflows`, {
      headers: githubHeaders(token),
    });
    if (!resp.ok) {
      return { workflows: [], error: `GitHub API ${resp.status}: ${resp.statusText}` };
    }
    const data = await resp.json();
    return { workflows: data.workflows || [] };
  } catch (err: any) {
    return { workflows: [], error: err.message || String(err) };
  }
}

/**
 * 获取最近的 workflow runs。
 */
export async function listWorkflowRuns(
  owner: string,
  repo: string,
  options?: { perPage?: number; branch?: string; status?: string; actor?: string },
): Promise<{ runs: WorkflowRun[]; error?: string }> {
  const token = getGithubToken();
  if (!token) return { runs: [], error: "GitHub token not configured" };

  try {
    const params = new URLSearchParams();
    params.set("per_page", String(options?.perPage || 10));
    if (options?.branch) params.set("branch", options.branch);
    if (options?.status) params.set("status", options.status);
    if (options?.actor) params.set("actor", options.actor);

    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs?${params}`, {
      headers: githubHeaders(token),
    });
    if (!resp.ok) {
      return { runs: [], error: `GitHub API ${resp.status}: ${resp.statusText}` };
    }
    const data = await resp.json();
    const runs: WorkflowRun[] = (data.workflow_runs || []).map((r: any) => ({
      id: r.id,
      name: r.name || r.workflow_id,
      status: r.status,
      conclusion: r.conclusion,
      htmlUrl: r.html_url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      headBranch: r.head_branch,
      headSha: r.head_sha,
      event: r.event,
      runNumber: r.run_number,
    }));
    return { runs };
  } catch (err: any) {
    return { runs: [], error: err.message || String(err) };
  }
}

/**
 * 获取 workflow run 的 job 详情。
 */
export async function getWorkflowJobs(
  owner: string,
  repo: string,
  runId: number,
): Promise<{ jobs: WorkflowJob[]; error?: string }> {
  const token = getGithubToken();
  if (!token) return { jobs: [], error: "GitHub token not configured" };

  try {
    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
      headers: githubHeaders(token),
    });
    if (!resp.ok) {
      return { jobs: [], error: `GitHub API ${resp.status}: ${resp.statusText}` };
    }
    const data = await resp.json();
    const jobs: WorkflowJob[] = (data.jobs || []).map((j: any) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      steps: (j.steps || []).map((s: any) => ({
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
        number: s.number,
      })),
    }));
    return { jobs };
  } catch (err: any) {
    return { jobs: [], error: err.message || String(err) };
  }
}

/**
 * 重试失败的 workflow run。
 */
export async function retryWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
): Promise<{ success: boolean; error?: string }> {
  const token = getGithubToken();
  if (!token) return { success: false, error: "GitHub token not configured" };

  try {
    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {
      method: "POST",
      headers: githubHeaders(token),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `GitHub API ${resp.status}: ${text}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * 触发 workflow dispatch（手动触发）。
 */
export async function triggerWorkflowDispatch(
  owner: string,
  repo: string,
  workflowId: string | number,
  ref: string,
  inputs?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const token = getGithubToken();
  if (!token) return { success: false, error: "GitHub token not configured" };

  try {
    const body: any = { ref };
    if (inputs) body.inputs = inputs;

    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
      method: "POST",
      headers: {
        ...githubHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `GitHub API ${resp.status}: ${text}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * 取消正在运行的 workflow。
 */
export async function cancelWorkflowRun(
  owner: string,
  repo: string,
  runId: number,
): Promise<{ success: boolean; error?: string }> {
  const token = getGithubToken();
  if (!token) return { success: false, error: "GitHub token not configured" };

  try {
    const resp = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {
      method: "POST",
      headers: githubHeaders(token),
    });
    if (!resp.ok) {
      return { success: false, error: `GitHub API ${resp.status}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// ========== Helpers ==========

/**
 * 从 GitHub 仓库 URL 解析 owner/repo。
 */
export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/**
 * 获取 CI/CD 状态摘要。
 */
export function getCiStatusSummary(runs: WorkflowRun[]): {
  total: number;
  success: number;
  failure: number;
  running: number;
  cancelled: number;
} {
  return {
    total: runs.length,
    success: runs.filter(r => r.conclusion === "success").length,
    failure: runs.filter(r => r.conclusion === "failure").length,
    running: runs.filter(r => r.status === "in_progress" || r.status === "queued").length,
    cancelled: runs.filter(r => r.conclusion === "cancelled").length,
  };
}

