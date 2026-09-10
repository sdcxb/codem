/**
 * useCurrentProjectId — 任务管理各页签共用的「当前项目」读取
 *
 * P2-12：任务管理内的 Issue / 看板 / 收件箱 / 概览都必须以「当前项目」为边界。
 * 宿主 storage 层的 `listAll`/`getStats` 在 projectId 为空时会返回**全部项目**的数据
 * （甚至跨项目串数据），所以各页签不能直接传 `undefined`，必须先判断有没有项目：
 *   - 没有项目 → 列表空、禁止新建、给出「请先选择项目」提示；
 *   - 有项目 → 正常查询。
 */

import { useProjectStore } from "../../core/store";

/** 当前项目 id；无项目时返回 null（不要用 undefined 去查库，会跨项目串数据） */
export function useCurrentProjectId(): string | null {
  const projectId = useProjectStore((s) => s.currentProject?.id);
  return projectId || null;
}

/** 非 hook 版本，供事件回调 / 一次性读取使用 */
export function getCurrentProjectId(): string | null {
  return useProjectStore.getState().currentProject?.id || null;
}
