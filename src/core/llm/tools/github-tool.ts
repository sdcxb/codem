/**
 * github_tool 工具 — GitHub API 集成。
 *
 * 功能：PR 审查、代码搜索、Issue 追踪、仓库信息获取、Diff 分析。
 * 用途：GitHub PR 自动审查、安全扫描、代码变更追踪、Bug triage。
 *
 * 设计原则：**使用 GitHub REST/GraphQL API，用户需配置 GitHub token。**
 * token 存储在 settings 中，零外部依赖。
 */

import type { ToolDef, ToolExecuteResult } from "../tools";
import { getSetting } from "../../storage/settings";
import { getLang } from "../../i18n/lang";

// ========== GitHub API ==========

const GITHUB_API = "https://api.github.com";

/** Get PR details + diff */
async function fetchPR(owner: string, repo: string, prNumber: number, token: string): Promise<any> {
  // Get PR metadata
  const prResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!prResp.ok) throw new Error(`GitHub API ${prResp.status}: ${prResp.statusText}`);
  const prData = await prResp.json();

  // Get PR diff
  const diffResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3.diff",
    },
  });
  const diffText = await diffResp.text();

  // Get PR files
  const filesResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  const filesData = await filesResp.json();

  // Get PR reviews
  const reviewsResp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  const reviewsData = await reviewsResp.json();

  return { pr: prData, diff: diffText, files: filesData, reviews: reviewsData };
}

/** Search code across repos */
async function searchCode(query: string, token: string): Promise<any> {
  const resp = await fetch(`${GITHUB_API}/search/code?q=${encodeURIComponent(query)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Search issues/PRs */
async function searchIssues(query: string, token: string): Promise<any> {
  const resp = await fetch(`${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Get repo info */
async function fetchRepo(owner: string, repo: string, token: string): Promise<any> {
  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Get commit list */
async function fetchCommits(owner: string, repo: string, token: string, perPage = 10): Promise<any> {
  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=${perPage}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

/** Get vulnerability alerts */
async function fetchVulnerabilityAlerts(owner: string, repo: string, token: string): Promise<any> {
  const query = `query { repository(owner: "${owner}", name: "${repo}") { vulnerabilityAlerts(first: 50, states: [OPEN]) { nodes { securityVulnerability { severity package { name ecosystem } summary vulnerableVersionRange } vulnerableManifestPath advisory { summary severity publishedAt } } } } }`;
  const resp = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`GitHub GraphQL API ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

// ========== 工具实现 ==========

export function createGitHubTool(): ToolDef {
  return {
    id: "github_tool",
    guidance: "Use github_tool to interact with GitHub: PR reviews, code search, issue tracking, repository info. Requires a GitHub token in settings.",
    description:
      "Interact with GitHub using the REST/GraphQL API. " +
      "Actions: 'pr_review' (get PR details + diff + files + reviews), 'search_code' (search code across repos), 'search_issues' (search issues/PRs), 'repo_info' (get repository metadata), 'commits' (get recent commits), 'vulnerability_scan' (check dependency vulnerabilities). " +
      "Requires GitHub personal access token configured in Settings. " +
      "Use for: automated code review, security scanning, bug triage, code change tracking, PR review before merge.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["pr_review", "search_code", "search_issues", "repo_info", "commits", "vulnerability_scan"],
          description: "The GitHub API action to perform",
        },
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        prNumber: {
          type: "number",
          description: "PR number (for 'pr_review' action)",
        },
        query: {
          type: "string",
          description: "Search query (for 'search_code' and 'search_issues' actions)",
        },
        perPage: {
          type: "number",
          description: "Number of results per page (default 10, for 'commits' action)",
        },
      },
      required: ["action"],
    },
    async execute(args, ctx) {
      const zh = getLang() === "zh";
      const action = args.action as string;

      // Get GitHub token from settings
      const token = getSetting("codem-github-token") || "";
      if (!token) {
        return {
          title: "github_tool",
          output: zh
            ? "错误：未配置 GitHub token。请在设置面板中配置 GitHub Personal Access Token。\n获取方式：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens\n所需权限：repo, read:user, security_events"
            : "Error: GitHub token not configured. Please configure GitHub Personal Access Token in Settings.\nGet it from: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens\nRequired scopes: repo, read:user, security_events",
        };
      }

      try {
        const label = `github_tool (${action})`;
        const owner = args.owner as string;
        const repo = args.repo as string;

        switch (action) {
          case "pr_review": {
            const prNumber = args.prNumber as number;
            if (!owner || !repo || !prNumber) {
              return { title: label, output: "Error: owner, repo, and prNumber are required for 'pr_review' action" };
            }
            const data = await fetchPR(owner, repo, prNumber, token);
            const pr = data.pr;
            const files = data.files;
            const reviews = data.reviews;
            const diff = data.diff;

            const fileSummaries = files.map((f: any) =>
              `  ${f.status === "added" ? "➕" : f.status === "removed" ? "➖" : "📝"} ${f.filename} (+${f.additions} -${f.deletions})`
            ).join("\n");

            const reviewSummaries = reviews.map((r: any) =>
              `  ${r.user?.login}: ${r.state}${r.body ? ` — ${r.body.substring(0, 100)}` : ""}`
            ).join("\n");

            return {
              title: label,
              output: `PR #${pr.number}: ${pr.title}\nState: ${pr.state} | ${pr.user?.login} | ${new Date(pr.created_at).toLocaleDateString()}\n\nFiles changed (${files.length}):\n${fileSummaries}\n\nReviews (${reviews.length}):\n${reviewSummaries || "(none)"}\n\nDiff (truncated to 5000 chars):\n${diff.substring(0, 5000)}${diff.length > 5000 ? "\n... (truncated)" : ""}`,
            };
          }

          case "search_code": {
            const query = args.query as string;
            if (!query) {
              return { title: label, output: "Error: query is required for 'search_code' action" };
            }
            const data = await searchCode(query, token);
            const items = data.items || [];
            const results = items.slice(0, 20).map((item: any) => {
              return `📄 ${item.repository?.full_name}/${item.path}\n  ${item.html_url}\n`;
            }).join("\n");
            return {
              title: label,
              output: `${data.total_count} results found (showing ${Math.min(items.length, 20)}):\n\n${results}`,
            };
          }

          case "search_issues": {
            const query = args.query as string;
            if (!query) {
              return { title: label, output: "Error: query is required for 'search_issues' action" };
            }
            const data = await searchIssues(query, token);
            const items = data.items || [];
            const results = items.slice(0, 20).map((item: any) => {
              return `#${item.number}: ${item.title}\n  State: ${item.state} | ${item.html_url}\n`;
            }).join("\n");
            return {
              title: label,
              output: `${data.total_count} issues/PRs found (showing ${Math.min(items.length, 20)}):\n\n${results}`,
            };
          }

          case "repo_info": {
            if (!owner || !repo) {
              return { title: label, output: "Error: owner and repo are required for 'repo_info' action" };
            }
            const data = await fetchRepo(owner, repo, token);
            return {
              title: label,
              output: `Repository: ${data.full_name}\nDescription: ${data.description || "(none)"}\nStars: ${data.stargazers_count} | Forks: ${data.forks_count}\nDefault branch: ${data.default_branch}\nLanguage: ${data.language || "(none)"}\nTopics: ${(data.topics || []).join(", ") || "(none)"}\nCreated: ${data.created_at}\nUpdated: ${data.updated_at}\nURL: ${data.html_url}`,
            };
          }

          case "commits": {
            if (!owner || !repo) {
              return { title: label, output: "Error: owner and repo are required for 'commits' action" };
            }
            const data = await fetchCommits(owner, repo, token, (args.perPage as number) || 10);
            const commits = data.map((c: any) => {
              const msg = c.commit.message.split("\n")[0];
              return `${c.sha?.substring(0, 7)} ${msg}\n  Author: ${c.commit.author?.name} | ${c.commit.author?.date}\n`;
            }).join("\n");
            return {
              title: label,
              output: `Recent commits (${data.length}):\n\n${commits}`,
            };
          }

          case "vulnerability_scan": {
            if (!owner || !repo) {
              return { title: label, output: "Error: owner and repo are required for 'vulnerability_scan' action" };
            }
            const data = await fetchVulnerabilityAlerts(owner, repo, token);
            const alerts = data.data?.repository?.vulnerabilityAlerts?.nodes || [];
            if (alerts.length === 0) {
              return {
                title: label,
                output: `✅ No open vulnerability alerts found for ${owner}/${repo}`,
              };
            }
            const alertList = alerts.map((a: any) => {
              const sv = a.securityVulnerability;
              return `🔴 ${sv?.severity || "UNKNOWN"}: ${sv?.package?.name || "unknown"} (${sv?.package?.ecosystem || "unknown"})\n  ${sv?.summary || a.advisory?.summary || "(no summary)"}\n  Vulnerable range: ${sv?.vulnerableVersionRange || "unknown"}\n  Manifest: ${a.vulnerableManifestPath || "(unknown)"}\n`;
            }).join("\n");
            return {
              title: label,
              output: `${alerts.length} open vulnerability alerts found:\n\n${alertList}`,
            };
          }

          default:
            return { title: label, output: `Unknown action: ${action}` };
        }
      } catch (error: any) {
        return {
          title: "github_tool",
          output: zh ? `GitHub API 请求失败: ${error.message}` : `GitHub API request failed: ${error.message}`,
        };
      }
    },
  };
}
