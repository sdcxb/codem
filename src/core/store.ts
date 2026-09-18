import { create } from "zustand";
import type { Project, Session, ProjectSkill, ProjectMemory, ProjectInstructions, ProjectConfig, Attachment } from "./types";
import * as ProjectStorage from "./storage/project";
import * as SessionStorage from "./storage/session";
import * as MessageStorage from "./storage/message";
import { getProjectExecutionMode, createWorktree, removeWorktree, getWorktreeRoot } from "./environment";
import { reportPersistFailure, reportActionFailure } from "./storage/persist-failure";

interface ProjectState {
  currentProject: Project | null;
  currentSession: Session | null;
  projects: Project[];
  /**
   * 第 47 轮补（UI/UX 审计 P1 第三处）：**"读不到项目"与"没有项目"是两件事**。
   *
   * `true` = 这次列项目**没有真的拿到数据**（端口未注册 / projects 镜像还没接手 / 读抛错）。
   * 界面必须说"暂时读不到你的项目列表"，**绝不能**渲染成「暂无项目，新建或导入一个」——
   * 冷启动或引擎起不来时，后者会让用户以为自己建过的项目全没了。
   */
  projectsReadUnavailable: boolean;
  sessions: Session[];
  skills: ProjectSkill[];
  memories: ProjectMemory[];
  instructions: ProjectInstructions;
  config: ProjectConfig;
  dbReady: boolean;

  createProject: (name: string, path: string, description?: string) => Project;
  openProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  setProjects: (projects: Project[]) => void;
  updateProject: (projectId: string, update: Partial<Project>) => void;
  getProjectSessions: (projectId: string) => Session[];

  createSession: (title?: string) => Session;
  forkSession: (sourceSessionId: string, messageIndex: number, title?: string) => Session;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setSessions: (sessions: Session[]) => void;
  updateSession: (sessionId: string, update: Partial<Session>) => void;
  renameSession: (sessionId: string, title: string) => void;

  addAttachment: (sessionId: string, attachment: Attachment) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;

  addSkill: (skill: ProjectSkill) => void;
  removeSkill: (name: string) => void;
  updateSkill: (name: string, update: Partial<ProjectSkill>) => void;
  setSkills: (skills: ProjectSkill[]) => void;

  addMemory: (memory: ProjectMemory) => void;
  removeMemory: (id: string) => void;
  updateMemory: (id: string, update: Partial<ProjectMemory>) => void;
  setMemories: (memories: ProjectMemory[]) => void;

  setInstructions: (instructions: ProjectInstructions) => void;
  updateInstructions: (content: string) => void;

  setProjectConfig: (config: Partial<ProjectConfig>) => void;
  loadFromDB: () => void;
}

const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  currentSession: null,
  projects: [],
  projectsReadUnavailable: false,
  sessions: [],
  skills: [],
  memories: [],
  instructions: { content: "", rules: [] },
  config: { allowedTools: [], autoApprove: false },
  dbReady: false,

  loadFromDB: () => {
    try {
      const projects = ProjectStorage.listProjects();
      console.log("[Store] loadFromDB: found", projects.length, "projects");
      /**
       * 第 47 轮补（UI/UX 审计 P1 的第三处同形）：**"读不到"与"没有项目"必须分开**。
       *
       * `listProjects()` 返回空有两种原因，而界面只看得到"空"：
       * ① 用户确实没有项目 → 「暂无项目，新建或导入一个」是对的；
       * ② **读没有真的发生**（端口未注册 / projects 镜像还没接手）→ 显示「暂无项目」是**错的**：
       *    冷启动或引擎起不来时，用户会以为自己建过的项目全没了。
       *
       * 判据取"读路径是否处于可用状态"（`isProjectsReadUnavailable`，与读路径同源），
       * 而不是"结果是不是空" —— 后者分不出这两种。
       */
      set({
        projects,
        dbReady: true,
        projectsReadUnavailable: projects.length === 0 && ProjectStorage.isProjectsReadUnavailable(),
      });
      console.log("[Store] dbReady set to true, projects:", get().projects.length);
    } catch (e) {
      console.error("[Store] loadFromDB failed:", e);
      // 抛错同样是"读不到"，不是一个空的项目列表
      set({ dbReady: true, projectsReadUnavailable: true });
    }
  },

  createProject: (name, path, description) => {
    const project: Project = { id: generateId(), name, path, createdAt: Date.now(), lastAccessedAt: Date.now(), description };
    try { ProjectStorage.createProject(project); } catch (e) { reportPersistFailure("store.createProject", e); }
    const updated = [...get().projects, project];
    set({ projects: updated, currentProject: project, sessions: [] });
    return project;
  },

  openProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    let sessions: Session[] = [];
    try { sessions = SessionStorage.listSessions(projectId); } catch (e) { console.warn('[store.ts]', e) }
    try { ProjectStorage.updateProject(projectId, { lastAccessedAt: Date.now() }); } catch (e) { console.warn('[store.ts]', e) }
    set({ currentProject: { ...project, lastAccessedAt: Date.now() }, currentSession: null, sessions });
  },

  deleteProject: (projectId) => {
    /*
     * 删项目是**级联删除的源头**：`projects` → `sessions`（外键 ON DELETE CASCADE）
     * → `messages` / `tool_calls` / `session_events`。也就是说 `written` 只显示 1 行，
     * 实际可能带走整个项目的语料。
     *
     * 第 44 轮给 `projects.delete` 补上了与 `crud.delete` **共用**的闸门
     * （按真实影响行数判定，含级联、已剔除审计行；见 `crud::measure_delete_impact`）：
     * 单次删除超过 50 行必须显式 `confirm_bulk`。用户点"删除项目"并在确认框里确认，
     * 就是明确的破坏性意图 —— 这里如实传达（与大项目一起失效的会是"删不掉"这个假象）。
     */
    try { ProjectStorage.deleteProject(projectId, { confirmBulk: true }); } catch (e) { reportPersistFailure("store.deleteProject", e); }
    /*
     * 删项目的会话：**显式表达"我在做批量删除"**。
     *
     * 第 32 轮加了批量删除闸门（`confirm_bulk`）：受保护表上单次删除超过 50 行
     * 必须显式确认 —— 因为事故形态正是"删 2 个会话却级联带走 821 条消息"，
     * 规模不体现在调用参数里。用户点"删除项目"是明确的破坏性意图，
     * 这里如实传达该意图（否则删一个大项目会被闸门拦下，看起来像"删不掉"）。
     */
    try {
      const sessions = SessionStorage.listSessions(projectId);
      for (const s of sessions) SessionStorage.deleteSession(s.id, { confirmBulk: true });
      /**
       * 第 47 轮补（只读审计 P1-3）：**级联删掉的会话也必须从"上次打开的会话"里摘掉**。
       *
       * `forgetLastSessionIfDeleted` 原来只有 `deleteSession` 一个调用点，而这条级联路径
       * 直接调 `SessionStorage.deleteSession` —— 于是"删项目"会留下一个指向已删除会话的键。
       * 目前它没有炸是因为**碰巧**：删项目会把 `currentProject` 置 null，而记录端
       * （App.tsx 的 recorder）随后把键写成 null，等于把整个指针清空。
       * 那是"靠副作用掩盖"，不是设计：一旦级联不再动 `currentProject`（或写入被排队/丢单），
       * 键就会存活，下次启动 `resolveRestoreTarget` 会去恢复一个**已被删除**的会话
       * （一次启动的空壳）。
       *
       * 这里显式按会话清；`forgetLastSessionIfDeleted` 自己就是"id 匹配才清"，
       * 所以级联删的是别人的会话时它是 no-op。`deleteProject` 是同步签名（返回 void），
       * 所以走**异步动态 import + 不等待**：清键是收尾动作，不该阻塞删除本身。
       */
      const cascadeIds = sessions.map((s) => s.id);
      void (async () => {
        try {
          const { forgetLastSessionIfDeleted } = await import("./session/preferences");
          for (const id of cascadeIds) forgetLastSessionIfDeleted(id);
        } catch (e) {
          console.warn("[store.deleteProject] 清理'上次打开的会话'键失败（不影响删除本身）:", e);
        }
      })();
    } catch (e) { console.warn('[store.ts]', e) }
    set({
      projects: get().projects.filter((p) => p.id !== projectId),
      currentProject: get().currentProject?.id === projectId ? null : get().currentProject,
    });
  },

  setProjects: (projects) => set({ projects }),

  updateProject: (projectId, update) => {
    try { ProjectStorage.updateProject(projectId, { ...update, lastAccessedAt: Date.now() }); } catch (e) { reportPersistFailure("store.updateProject", e); }
    const projects = get().projects.map((p) => p.id === projectId ? { ...p, ...update, lastAccessedAt: Date.now() } : p);
    set({ projects, currentProject: get().currentProject?.id === projectId ? { ...get().currentProject!, ...update } : get().currentProject });
  },

  getProjectSessions: (pid) => { try { return SessionStorage.listSessions(pid); } catch { return []; } },

  createSession: (title) => {
    const project = get().currentProject;
    const projectId = project?.id || "";
    const newId = generateId();
    console.log(`[createSession] Creating new session: ${newId}, project: ${projectId}`);
    // 从数据库查询实际会话数，避免内存中的 sessions 列表不同步导致编号错误
    let sessionNumber = 1;
    try {
      const existingSessions = SessionStorage.listSessions(projectId);
      sessionNumber = existingSessions.length + 1;
    } catch (e) {
      console.warn("[createSession] Failed to count existing sessions:", e);
    }
    // 如果内存中 sessions 更长，使用内存长度（防止重复编号）
    const memCount = get().sessions.length;
    if (memCount >= sessionNumber) sessionNumber = memCount + 1;
    const session: Session = {
      id: newId, projectId,
      title: title || `对话 ${sessionNumber}`,
      createdAt: Date.now(), lastMessageAt: Date.now(),
      messageCount: 0, attachments: [],
    };
    // Inherit execution mode from project preference
    if (project?.path) {
      try {
        const execMode = getProjectExecutionMode(project.path);
        session.executionMode = execMode;
      } catch (e) { console.warn('[store.ts]', e) }
    }
    // 第 84 波（B 类缺陷：假成功）：会话创建失败不能假装成功。
    // 原来异常只打一条 console.error，然后照样把该会话设为 currentSession ——
    // 用户在这个"数据库里不存在"的会话里聊天，重启后整段对话凭空消失。
    // 现在：瞬时失败重试一次；仍然失败则**明确上报**（事件 + 错误级别日志），
    // 让界面能提示用户，而不是安静地丢数据。
    let persistError: any = null;
    try {
      SessionStorage.createSession(session);
    } catch (e1) {
      console.error("[Store] createSession 写入失败，重试一次:", e1);
      try {
        SessionStorage.createSession(session);
      } catch (e2) {
        persistError = e2;
        console.error("[Store] createSession 重试仍失败（该会话只存在于内存）:", e2);
      }
    }
    if (persistError) {
      try {
        window.dispatchEvent(new CustomEvent("codem:session-persist-failed", {
          detail: { sessionId: session.id, projectId, error: persistError?.message || String(persistError) },
        }));
      } catch { /* 非浏览器环境（测试）忽略 */ }
    }
    const updated = [...get().sessions, session];
    set({ sessions: updated, currentSession: session });
    console.log(`[createSession] Set currentSession to: ${session.id}, title: ${session.title}`);
    return session;
  },

  /**
   * 从某个消息处分叉出一个新会话（UI 的「重新生成 / 分叉」入口）。
   *
   * ## 第 44 轮：这个方法原来是**没人调用的空壳**
   *
   * 它带 `messageIndex` 参数却**从不使用**、也不复制任何消息、也不写 `parent_id`；
   * 而 UI 的三处 `onFork` 各自内联实现了一遍（那三份实现同样不写 `parent_id`）。
   * 后果是一条能被实测验证的**功能空洞**：`parent_id` 全仓唯一写点在
   * `SessionStorage.forkSession` 里，而它零 UI 调用者 —— 于是 `session_trace`
   * （按 `parent_id` 追溯祖先/后代）在生产里永远只报 `Parent: (root)` / `Ancestors: []`，
   * 也就是说"完整谱系"这个能力从来没有数据。
   *
   * 现在把三份内联实现收敛到这里，并且：
   * ① 会话行走 `SessionStorage.forkSession`（**带 `parent_id`**）；
   * ② 真的按 `messageIndex` 复制消息（原实现的参数语义）；
   * ③ 消息 id、工具调用 id、**附件 id** 都重新生成（见下）。
   *
   * ## 第 45 轮修正一：项目归属按**源会话**解析（功能上下文审计 P1-D2）
   *
   * 原来 `projectId` 取 `get().currentProject`、worktree 也建在 `currentProject.path`。
   * 而"被分叉的源会话"是**参数**（`sourceSessionId`）——同一 store 里
   * `switchSession` 只改 `currentSession` 不改 `currentProject`，`openProject` 又会把
   * `currentSession` 置 null，任何"跨项目调用点"（面板、命令、恢复路径）都会静默产出
   * "挂在 A 项目下、内容是 B 项目对话"的会话，`parent_id` 还指向 B 项目的会话。
   * 更糟的是 worktree：`createWorktreeSync(project.path, child.id)` 会在**错误的仓库**里
   * `git worktree add`。
   *
   * 现在的规则：**源会话的项目是权威**（源会话 → 项目 → 路径），
   * 解析不到源项目时才回落到当前项目（并如实记录），两者都没有就拒绝分叉并上报 ——
   * 宁可"分叉失败（可见）"，也不要"在别人的仓库里建工作区（静默）"。
   *
   * ## 第 45 轮修正二：附件 id 必须换新（功能上下文审计 P1-D3）
   *
   * 附件的主键是 `attachments.message_id` + `attachments.id`，写入是
   * `crud.upsert mode:"replace"`。原来复制消息时**没换附件 id** ——
   * 同一次分叉会把那一行的 `message_id` 覆盖成子会话的新消息 id：
   * **源会话那条消息的附件被搬走**（源消息点开附件是空的），子会话带着同一批附件。
   * 现在整条消息的复制走 `MessageStorage.copyMessageToSession`（三者一起换新，
   * 附件正文按新 id 重新落库，源附件行不动）。
   */
  forkSession: (sourceSessionId, messageIndex, title) => {
    const source = get().sessions.find((s) => s.id === sourceSessionId);
    /**
     * 源会话的**项目归属**（权威）：内存列表 → 持久层。
     * `null` = 两级都解析不到（此时 `SessionStorage.forkSession` 也会返回 null，
     * 下面会抛可见错误），只有这种情况才回落到"当前项目"。
     */
    let sourceProjectId: string | null = source ? (source.projectId ?? "") : null;
    if (sourceProjectId === null) {
      try {
        const persisted = SessionStorage.getSession(sourceSessionId);
        if (persisted) sourceProjectId = persisted.projectId ?? "";
      } catch (e) { console.warn('[store.ts]', e) }
    }
    const projectId = sourceProjectId ?? (get().currentProject?.id || "");
    /** 目标项目路径（worktree 的根）：内存列表 → 持久层；空路径（如笔记本虚拟项目）按"没有"处理 */
    const projectPath = ((): string | undefined => {
      if (!projectId) return undefined;
      const inMemory = get().projects.find((p) => p.id === projectId);
      if (inMemory?.path) return inMemory.path;
      try {
        return ProjectStorage.getProject(projectId)?.path || undefined;
      } catch (e) { console.warn('[store.ts]', e); return undefined; }
    })();
    const newSessionId = generateId();
    /*
     * 会话行：走 forkSession 而不是 createSession —— 只有前者会写 `parent_id`
     * （谱系与"从这一条分叉"的语义同时成立）。事件日志**刻意不复制**：
     * 见 `SessionStorage.forkSession` 的说明（复制事件 + 复制消息各做一半会让主键完全脱钩）。
     */
    const child = SessionStorage.forkSession(
      sourceSessionId,
      newSessionId,
      projectId,
      title || (source ? `Fork: ${source.title}` : "分叉自对话"),
    );
    if (!child) {
      // 会话行没落地就返回：复制消息只会造出"有消息、没有会话行"的孤儿（外键也会拒绝）
      throw new Error("分叉失败：源会话不存在或写入未被接受");
    }
    // Inherit execution mode from **源会话所属项目**的偏好（与 createSession 同一条规则）
    if (projectPath) {
      try {
        child.executionMode = getProjectExecutionMode(projectPath);
      } catch (e) { console.warn('[store.ts]', e) }
    }
    if (child.executionMode === "git_worktree") {
      if (!projectPath) {
        /**
         * 拿不到源项目路径就**不要建 worktree**：`createWorktreeSync` 需要项目根，
         * 用当前项目的根去建 = 在错误的仓库里 `git worktree add`（审计点名的形态）。
         * 如实降级为共享工作区并告警，而不是默默写坏另一个仓库。
         */
        console.warn("[forkSession] 解析不到源会话所属项目的路径，worktree 未创建（降级为共享工作区）");
        child.executionMode = "current_workspace";
        child.worktreePath = undefined;
      } else {
        try {
          child.worktreePath = createWorktreeSync(projectPath, child.id);
        } catch (e) {
          console.error("[forkSession] Failed to create worktree:", e);
          child.executionMode = "current_workspace";
        }
      }
    }
    try {
      SessionStorage.updateSession(child.id, {
        executionMode: child.executionMode,
        worktreePath: child.worktreePath,
      });
    } catch (e) { console.warn('[store.ts]', e) }

    /*
     * 复制消息：从 0 到 `messageIndex` 所在的**这一轮**结束为止
     * （源实现按"下一个 user 消息"划边界，这里保持一致 —— 分叉点落在一轮中间时
     * 会把当轮答完再分叉，否则新会话里会出现"用户没说话、助手却回答了"）。
     */
    let copiedCount = 0;
    try {
      const sourceMessages = MessageStorage.listMessages(sourceSessionId);
      if (sourceMessages.length > 0) {
        let endIdx = Math.min(Math.max(messageIndex + 1, 0), sourceMessages.length);
        for (let i = Math.max(messageIndex + 1, 0); i < sourceMessages.length; i++) {
          if (sourceMessages[i].role === "user") { endIdx = i; break; }
          endIdx = i + 1;
        }
        const forkTs = Date.now();
        for (const msg of sourceMessages.slice(0, endIdx)) {
          const suffix = `${forkTs}-${Math.random().toString(36).slice(2, 7)}`;
          // 消息 id / 工具调用 id / 附件 id 一起换新（P1-D3），附件正文按新 id 落库
          MessageStorage.copyMessageToSession(msg, child.id, suffix);
          copiedCount += 1;
        }
      }
    } catch (e) { console.warn('[store.ts]', e) }

    /**
     * ## 第 47 轮（功能上下文审计 P2-D11）：`messageCount` 必须按**实际复制的条数**写
     *
     * 改前：子会话行是 `SessionStorage.forkSession` 建的，那一行**直接抄源会话的
     * `messageCount`**（`session.ts:401`）。而这里只复制 `endIdx` 条
     * （`endIdx ≤ messageIndex + 1 ≤ 源会话总条数`）—— 从会话中间分叉时，
     * 子会话一落地就带着一个**比实际条数大**的计数，并被侧边栏与 `session_trace`
     * 直接展示，直到 12 小时一次的启动维护对账才会被改回来。
     *
     * 现在的顺序（两段都要，缺一不可）：
     * 1. 复制循环**如实计数**（`copiedCount`），用它把会话行的 `message_count` 写成真值 ——
     *    这是**同步**可见的那一份（内存 + 域写的 `sessions.upsert`）；
     * 2. 再调 `reconcileSessionMessageCountById`（**已存在**的实现，`message.ts:2533`）
     *    用引擎的 `messages.count.total` 复核一次 —— 因为 `createMessage` 每条是否都被引擎
     *    计入 `message_count` 取决于引擎的 bump 语义，而"引擎侧真值"只能问引擎。
     *    这里**不再写第二份重算**（项目纪律：一个事实一个实现）。
     *    三态返回如实记录：`unavailable`（端口没有 `command` 能力）不是"对上了"。
     */
    try {
      SessionStorage.updateSession(child.id, { messageCount: copiedCount });
      child.messageCount = copiedCount;
    } catch (e) { reportPersistFailure("store.forkSession.messageCount", e, "分叉会话的消息计数未写入"); }

    void MessageStorage.reconcileSessionMessageCountById(
      child.id,
      "分叉后按索引真值复核",
    ).then((state) => {
      if (state === "unavailable") {
        console.warn("[forkSession] 索引真值读不到（端口无 command 能力），message_count 只写了复制条数");
      }
    }).catch((e) => reportPersistFailure("store.forkSession.reconcile", e, "分叉会话的消息计数未复核"));

    const updated = [...get().sessions, child];
    set({ sessions: updated, currentSession: child });
    return child;
  },

  switchSession: (sessionId) => { const s = get().sessions.find((s) => s.id === sessionId); if (s) set({ currentSession: s }); },

  deleteSession: (sessionId) => {
    // Clean up worktree if this session had one
    const session = get().sessions.find(s => s.id === sessionId);
    if (session?.worktreePath && session.executionMode === "git_worktree") {
      /**
       * worktree 的**根必须是"这个会话所属项目"**（第 45 轮功能上下文审计 I2/I19 同根）：
       * 用 `currentProject.path` 去 `removeWorktreeSync` 时，只要被删的会话属于别的项目，
       * 就会拿着错误的根去删（真机形态：命令落在别的仓库，或者整个清理静默失效）。
       */
      const sessionProject = get().projects.find((p) => p.id === session.projectId) ?? null;
      const projectPath = sessionProject?.path
        || (session.projectId && session.projectId === get().currentProject?.id ? get().currentProject?.path : undefined);
      if (projectPath) {
        removeWorktreeSync(projectPath, session.worktreePath);
      } else {
        console.warn(`[store.deleteSession] 解析不到会话 ${sessionId} 所属项目的路径，worktree 未清理: ${session.worktreePath}`);
      }
    }
    // Clean up the engine's per-session loop pool to free memory
    try {
      // ESM: dynamic import instead of require
      import("./llm").then(({ getLLMEngine }) => {
        const engine = getLLMEngine();
        engine.cleanupSessionLoop?.(sessionId);
      }).catch(() => {});
    } catch (e) { console.warn('[store.ts]', e) }
    // Clean up abort controller if present
    try {
      // useAppStore is in this module — no need to import from elsewhere
      // Abort controllers are managed in App.tsx's ref, not in store
    } catch (e) { console.warn('[store.ts]', e) }
    // 用户点"删除会话"是明确的破坏性意图 → 如实传达给存储层（见 deleteProject 的说明）
    try { SessionStorage.deleteSession(sessionId, { confirmBulk: true }); } catch (e) { console.warn('[store.ts]', e) }
    set({ sessions: get().sessions.filter((s) => s.id !== sessionId), currentSession: get().currentSession?.id === sessionId ? null : get().currentSession });
    /**
     * 第 47 轮（D-20）：被删掉的会话不该继续是"上次打开的会话"。
     *
     * 不清的话每次启动都会为一条**已删除**的会话白查一次库，再打一行
     * "上次打开的会话已不存在"——功能上无害（恢复端会安静回落），但那是
     * 一条永远读不到的键长期躺在 DB 里，且用户每次开机都看到一行"已不存在"的日志。
     * 只清 `codem-last-session`，**不动** `codem-last-project`：项目还在，
     * 下次打开仍然该落在那个项目上。
     */
    void (async () => {
      try {
        const { forgetLastSessionIfDeleted } = await import("./session/preferences");
        forgetLastSessionIfDeleted(sessionId);
      } catch (e) {
        console.warn("[store.deleteSession] 清理'上次打开的会话'键失败（不影响删除本身）:", e);
      }
      /**
       * 第 54 轮：**这个会话的输入草稿也要一起清掉**（同一个理由：删掉的会话不该在
       * `settings` 里留下一条永远读不到的行）。真机钻取实证过这种残留：
       * `composer-draft-<已删除的会话 id>` 一直躺在库里（值还是空串）。
       *
       * ⚠️ 为什么放在这一段的**末尾、且让出一个宏任务**：删的若是"当前会话"，
       * 输入框会在 React 提交那次 `set({currentSession: null})` 时卸载，
       * 卸载的冲刷（`useDraftPersistence` 的 cleanup）此刻才把**旧 key** 的草稿写回去
       * —— 先删后写就白删了。让出宏任务后冲刷已经落定，这次删除是最后动作。
       * （冲刷只写非空草稿；用户没打完的字仍会被写回，那是刻意的：字不能丢。
       *   但如果是空草稿，第 54 轮起 `persistDraft` 走的是 `removeSetting`，同样是删除。）
       */
      try {
        await new Promise((r) => setTimeout(r, 0));
        const { removeSetting } = await import("./storage/settings");
        removeSetting(`composer-draft-${sessionId}`);
      } catch (e) {
        console.warn("[store.deleteSession] 清理会话草稿键失败（不影响删除本身）:", e);
      }
    })();
  },

  setSessions: (sessions) => set({ sessions }),

  updateSession: (sessionId, update) => {
    try { SessionStorage.updateSession(sessionId, { ...update, lastMessageAt: Date.now() }); } catch (e) { reportPersistFailure("store.updateSession", e); }
    const updated = get().sessions.map((s) => s.id === sessionId ? { ...s, ...update, lastMessageAt: Date.now() } : s);
    set({ sessions: updated, currentSession: get().currentSession?.id === sessionId ? { ...get().currentSession!, ...update } : get().currentSession });
  },

  renameSession: (id, title) => { get().updateSession(id, { title }); },

  addAttachment: (sid, att) => { const s = get().sessions.find((s) => s.id === sid); if (s) get().updateSession(sid, { attachments: [...(s.attachments || []), att] }); },
  removeAttachment: (sid, aid) => { const s = get().sessions.find((s) => s.id === sid); if (s) get().updateSession(sid, { attachments: (s.attachments || []).filter((a) => a.id !== aid) }); },

  addSkill: (skill) => set((s) => ({ skills: [...s.skills, skill] })),
  removeSkill: (name) => set((s) => ({ skills: s.skills.filter((sk) => sk.name !== name) })),
  updateSkill: (name, u) => set((s) => ({ skills: s.skills.map((sk) => sk.name === name ? { ...sk, ...u } : sk) })),
  setSkills: (skills) => set({ skills }),

  addMemory: (m) => set((s) => ({ memories: [...s.memories, m] })),
  removeMemory: (id) => set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),
  updateMemory: (id, u) => set((s) => ({ memories: s.memories.map((m) => m.id === id ? { ...m, ...u } : m) })),
  setMemories: (memories) => set({ memories }),

  setInstructions: (instructions) => set({ instructions }),
  updateInstructions: (content) => set((s) => ({ instructions: { ...s.instructions, content } })),
  setProjectConfig: (config) => set((s) => ({ config: { ...s.config, ...config } })),
}));

// ========== Worktree sync wrappers ==========
// These wrap async worktree operations for use in sync store actions.
// The async creation runs in the background; runAgenticLoop will create
// the worktree if session.worktreePath is still empty when sending a message.

function createWorktreeSync(projectPath: string, sessionId: string, branch?: string): string {
  const worktreeRoot = getWorktreeRoot(projectPath);
  const worktreePath = `${worktreeRoot}/${sessionId}`;
  // Fire async creation — persist to session on success
  createWorktree(projectPath, sessionId, branch).then((actualPath) => {
    // Persist the worktree path once creation succeeds
    try {
      const store = useProjectStore.getState();
      store.updateSession(sessionId, { worktreePath: actualPath });
    } catch (e) {
      reportPersistFailure("store.persistWorktreePath", e, "会话 worktree 路径未保存");
    }
  }).catch(e => {
    // 第 87 波：worktree 创建失败后已悄悄回退到主工作区 —— 用户必须在改动文件前知道这件事
    reportActionFailure("store.createWorktree", e, "会话已回退为在主工作区运行");
    // Mark session as fallback to local mode
    try {
      const store = useProjectStore.getState();
      store.updateSession(sessionId, { executionMode: "current_workspace" });
    } catch (e) { reportPersistFailure("store.fallbackExecutionMode", e); }
  });
  // Return predicted path immediately (will be confirmed by async callback)
  return worktreePath;
}

function removeWorktreeSync(projectPath: string, worktreePath: string): void {
  // Fire-and-forget async removal
  removeWorktree(projectPath, worktreePath).catch(e => {
    reportActionFailure("store.removeWorktree", e, "worktree 目录未清理（磁盘上会残留）");
  });
}
