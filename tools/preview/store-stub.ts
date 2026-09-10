/**
 * 预览构建用的项目 store 桩。
 *
 * 真 `core/store.ts` 会经 `storage/project`、`storage/session`、`environment`
 * 一路拉进 sql.js 与 node 内建模块（spill-store），浏览器预览构建不了。
 * 看板子视图只需要「当前项目 id」，这里给一个静态 store 即可。
 */

const state = {
  projects: [{ id: "preview-project", name: "预览项目", path: "C:/preview", createdAt: 0, lastAccessedAt: 0 }],
  sessions: [],
  currentProject: { id: "preview-project", name: "预览项目", path: "C:/preview", createdAt: 0, lastAccessedAt: 0 },
  currentSession: null,
};

function useProjectStore<T>(selector: (s: typeof state) => T): T {
  return selector(state);
}
useProjectStore.getState = () => state;
useProjectStore.setState = () => undefined;
useProjectStore.subscribe = () => () => undefined;

export { useProjectStore };
