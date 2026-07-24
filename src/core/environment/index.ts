export {
  runSetupScript,
  runCleanupScript,
  runCustomOperation,
  getCustomOperations,
  getEnvironmentConfig,
  type ScriptRunResult,
} from "./environment-runner";

export {
  createWorktree,
  removeWorktree,
  scanWorktrees,
  hasUncommittedChanges,
  getCurrentBranch,
  listBranches,
  isGitRepo,
  enforceMaxWorktrees,
  getWorktreeCount,
  getWorktreeRoot,
  getWorktreeSettings,
  setWorktreeSettings,
  getProjectExecutionMode,
  setProjectExecutionMode,
  type ExecutionMode,
  type WorktreeInfo,
  type WorktreeSettings,
} from "./worktree-manager";
