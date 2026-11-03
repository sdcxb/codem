/**
 * 「新建会话」面板（B1）：选项目 / 建项目 / 建会话。
 *
 * ## 为什么是独立组件而不是塞进 `MobileApp`
 *
 * `MobileApp` 一挂载就要连 Host（hello/SSE），整页很难在判据里挂。把这段交互
 * 拆成**只依赖 `SessionTransport` + 能力位**的组件后，判据可以直接挂它、注入假 transport，
 * 断言"失败会显示原因、成功后打开新会话、缺能力时不画按钮" —— 而不是照着 JSX 再写一份骨架。
 *
 * ## 三条产品约束
 *
 * 1. **不画假按钮**：能力位 `projects` 为假时不显示项目区；`createProject` 不可用时不显示「新建项目」。
 * 2. **失败原因可见**：桌面拒因（路径不存在 / 沙箱外 / 重复项目）经 `onError` 走顶部横幅，
 *    不许退化成"操作失败"。
 * 3. **数据只有桌面一份**：这里只调 `project.list/create`、`session.create`，没有本地缓存/影子库。
 */
import * as React from "react";
import { useEffect, useState } from "react";

import type { Capabilities, SessionTransport, TransportProjectSummary, TransportSessionSummary } from "./transport";

export interface CreateSessionSheetProps {
  transport: SessionTransport;
  caps: Capabilities;
  /** 创建成功：由外层把会话插进列表并打开它（面板不持有会话列表） */
  onCreated: (session: TransportSessionSummary) => void;
  onClose: () => void;
  /** 失败原因走顶部横幅（与页面其他错误同一条通道） */
  onError: (error: unknown) => void;
}

export function CreateSessionSheet(props: CreateSessionSheetProps): React.ReactElement {
  const { transport, caps } = props;
  const [projects, setProjects] = useState<TransportProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [creating, setCreating] = useState(false);

  /**
   * 打开时刷新项目列表：项目可能在桌面侧新建过。
   * 只在 `caps.projects` 为真时拉 —— 旧网关没有这两个方法，拉了就是一次必失败的请求。
   */
  useEffect(() => {
    let disposed = false;
    if (!caps.projects || !transport.listProjects) return;
    void (async () => {
      try {
        const items = await transport.listProjects!();
        if (!disposed) setProjects(items);
      } catch (e) {
        if (!disposed) props.onError(e);
      }
    })();
    return () => {
      disposed = true;
    };
    // 只在挂载时拉一次：面板是"打开一次 = 一次快照"，不在这里做轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doCreateSession(): Promise<void> {
    if (!transport.createSession) return;
    setCreating(true);
    try {
      const created = await transport.createSession(title.trim() || undefined, selectedProjectId || undefined);
      props.onCreated(created);
    } catch (e) {
      props.onError(e);
    } finally {
      setCreating(false);
    }
  }

  async function doCreateProject(): Promise<void> {
    if (!transport.createProject) return;
    setCreating(true);
    try {
      const project = await transport.createProject({ name: projectName.trim(), path: projectPath.trim() });
      setProjects((prev) => [project, ...prev]);
      setSelectedProjectId(project.id);
      setNewProjectOpen(false);
      setProjectName("");
      setProjectPath("");
    } catch (e) {
      // 失败时**保留**表单内容：用户改一下路径就能重试，不必重填
      props.onError(e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="pick-session" data-testid="create-session-sheet" style={{ display: "grid", gap: 8 }}>
      <strong>新建会话</strong>

      {caps.projects ? (
        <div style={{ display: "grid", gap: 4 }} data-testid="project-picker">
          <div style={{ fontSize: "var(--fs-sm)" }}>归属项目</div>
          <label>
            <input
              type="radio"
              name="codem-project"
              checked={selectedProjectId === ""}
              onChange={() => setSelectedProjectId("")}
            />{" "}
            全局（不属于任何项目）
          </label>
          {projects.map((p) => (
            <label key={p.id}>
              <input
                type="radio"
                name="codem-project"
                checked={selectedProjectId === p.id}
                onChange={() => setSelectedProjectId(p.id)}
              />{" "}
              {p.name} <span style={{ fontSize: "var(--fs-sm)" }}>{p.path}</span>
            </label>
          ))}
          {transport.createProject ? (
            <button
              className="session"
              data-testid="toggle-new-project"
              onClick={() => setNewProjectOpen((v) => !v)}
            >
              {newProjectOpen ? "取消新建项目" : "＋ 新建项目"}
            </button>
          ) : null}
        </div>
      ) : null}

      {newProjectOpen && caps.projects && transport.createProject ? (
        <div style={{ display: "grid", gap: 6 }} data-testid="new-project-form">
          <input
            placeholder="项目名"
            aria-label="项目名"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
          <input
            placeholder="绝对路径，例如 D:\\work\\repo"
            aria-label="项目路径"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
          />
          <button className="session" data-testid="create-project" disabled={creating} onClick={() => void doCreateProject()}>
            创建项目
          </button>
          <div style={{ fontSize: "var(--fs-sm)" }}>
            目录必须已在桌面存在；不在沙箱允许范围或已属于别的项目会被拒绝（原因会显示在上方横幅）。
          </div>
        </div>
      ) : null}

      <input
        placeholder="会话标题（可空）"
        aria-label="会话标题"
        data-testid="session-title-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button
        className="session"
        data-testid="confirm-create-session"
        disabled={creating || !transport.createSession}
        onClick={() => void doCreateSession()}
      >
        创建会话
      </button>
      <button className="session" onClick={props.onClose}>
        取消
      </button>
    </div>
  );
}
