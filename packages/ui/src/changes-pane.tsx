/**
 * 手机/远程的**只读变更列表**（`session.changes` + `session.change.diff`）。
 *
 * 取数只有两条 RPC：列表分页 + 单文件 diff。没有实时事件：`SessionTransport` 不提供
 * "工作区变更"事件，所以这里**不轮询、不假装实时**——打开页签取一次、`run.finished`
 * 后由宿主递增 `refreshKey` 再取一次、以及用户手动「刷新」。
 *
 * `onOpenFile` 走 `session.change.diff`，把统一 patch 交给 `ChangeDiffOverlay` 展示；
 * 不把 before/after 塞进共享 `DiffView`（那需要第二种输入，见 `diff-view.tsx` 文件头）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChangedFileView, TurnChangesView } from "../../protocol/src/index";
import { ChangeDiffOverlay, ChangesList, type ChangeDiffView } from "./changes-list";
import { appendPage } from "./changes-model";
import type { SessionTransport } from "./transport";

const PAGE_SIZE = 20;

function errorText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

export function SessionChangesPane(props: {
  transport: SessionTransport;
  sessionId: string;
  /** 宿主在运行结束后递增它 ⇒ 重新取第一页（不轮询） */
  refreshKey?: number;
}): React.ReactElement {
  const canList = typeof props.transport.sessionChanges === "function";
  const canDiff = typeof props.transport.sessionChangeDiff === "function";
  const [records, setRecords] = useState<TurnChangesView[]>([]);
  const [loading, setLoading] = useState(canList);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(canList);
  const [reason, setReason] = useState<string | undefined>(
    canList ? undefined : "当前连接不支持变更列表（只读/本地模式）",
  );
  const [hasMore, setHasMore] = useState(false);
  const [diff, setDiff] = useState<ChangeDiffView | null>(null);
  /** 请求代：换会话/刷新后旧响应不许覆盖新状态 */
  const generation = useRef(0);
  /**
   * 已从 Host 取回的**条数**（不是去重后的展示条数）。
   *
   * 分页键是 `offset`，必须按"引擎确实返回了多少条"推进；`appendPage` 会按
   * `changeId` 去重（两次请求之间可能插入新行），若用展示条数当 offset，
   * 一旦发生去重，下一页就会跳过记录。
   */
  const loadedCount = useRef(0);

  const load = useCallback(
    async (offset: number, append: boolean): Promise<void> => {
      const list = props.transport.sessionChanges;
      if (!list) return;
      const gen = ++generation.current;
      if (!append) loadedCount.current = 0;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const got = await list.call(props.transport, props.sessionId, offset, PAGE_SIZE);
        if (gen !== generation.current) return;
        setSupported(got.supported);
        setReason(got.reason);
        setHasMore(got.hasMore);
        const pageItems = got.items ?? [];
        loadedCount.current = append ? loadedCount.current + pageItems.length : pageItems.length;
        setRecords((prev) => (append ? appendPage(prev, pageItems) : pageItems));
      } catch (e) {
        if (gen !== generation.current) return;
        setError(errorText(e));
        // 第一页失败：保留空列表并显示错误；追加失败：保留已有记录 + 错误横幅
        if (!append) setRecords([]);
      } finally {
        if (gen === generation.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [props.transport, props.sessionId],
  );

  useEffect(() => {
    if (!canList) {
      generation.current += 1;
      setLoading(false);
      setSupported(false);
      return;
    }
    void load(0, false);
    return () => {
      generation.current += 1;
    };
  }, [canList, load, props.refreshKey]);

  const openFile = useCallback(
    async (change: TurnChangesView, file: ChangedFileView): Promise<void> => {
      const read = props.transport.sessionChangeDiff;
      if (!read) {
        setDiff({
          path: file.path,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "当前连接不支持单文件 diff（只读/本地模式）",
        });
        return;
      }
      try {
        const got = await read.call(props.transport, props.sessionId, change.changeId, file.path);
        setDiff({
          path: got.path || file.path,
          status: got.status || file.status,
          patch: got.patch ?? "",
          truncated: got.truncated === true,
          supported: got.supported === true,
          ...(got.reason ? { reason: got.reason } : {}),
        });
      } catch (e) {
        setDiff({
          path: file.path,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: errorText(e),
        });
      }
    },
    [props.transport, props.sessionId],
  );

  return (
    <>
      <ChangesList
        records={records}
        loading={loading}
        error={error}
        supported={supported}
        reason={reason}
        hasMore={hasMore}
        loadingMore={loadingMore}
        /* 手机首版：不回滚、不展示 checks（Host 没有按轮次的检查数据）。 */
        capabilities={{ revert: false, checks: false }}
        onOpenFile={canDiff ? (change, file) => void openFile(change, file) : undefined}
        onLoadMore={() => void load(loadedCount.current, true)}
        onRefresh={() => void load(0, false)}
      />
      <ChangeDiffOverlay view={diff} onClose={() => setDiff(null)} />
    </>
  );
}
