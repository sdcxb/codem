/**
 * 第三列（宽屏）的页签容器 `WorkspaceDetail`：文件 / 差异 / 变更。
 *
 * 面板**常驻**（`hidden` 切换，不卸载）⇒ 切到差异再切回来，文件树的目录层级、
 * 搜索词与滚动位置都不丢；切到「变更」再切回来同理。这正是「不用条件渲染」的理由，
 * 不是顺手写法。
 *
 * 「变更」页签是**可选**的：`changes` 没注入就不渲染这颗页签（桌面第三列没有这页；
 * 手机连 Host 时才注入 `SessionChangesPane`）。不画一个空页签，也不按平台名判断。
 *
 * ⚠️ `hidden` 必须落在这一层包装 div 上：`.file-browser` 自带 `display: flex`，
 * 作者样式会压过 UA 的 `[hidden]`，所以 `ui.css` 里同时写了 `.detail-body[hidden]`。
 */
import * as React from "react";

export type DetailTab = "files" | "diff" | "changes";

export interface WorkspaceDetailProps {
  tab: DetailTab;
  onSelectTab: (tab: DetailTab) => void;
  /** 「文件」面板（手机壳注入 `<FileBrowser inline />`） */
  files: React.ReactNode;
  /** 「差异」面板（手机壳注入 `<WorkspaceDiffPane />`） */
  diff: React.ReactNode;
  /** 「变更」面板（手机壳注入 `<SessionChangesPane />`）；不传则没有这颗页签 */
  changes?: React.ReactNode;
}

export function WorkspaceDetail(props: WorkspaceDetailProps): React.ReactElement {
  return (
    <>
      <div className="detail-tabs" role="tablist" aria-label="工作区">
        <button
          type="button"
          role="tab"
          id="detail-tab-files"
          className="detail-tab"
          aria-selected={props.tab === "files"}
          aria-controls="detail-panel-files"
          onClick={() => props.onSelectTab("files")}
        >
          文件
        </button>
        <button
          type="button"
          role="tab"
          id="detail-tab-diff"
          className="detail-tab"
          aria-selected={props.tab === "diff"}
          aria-controls="detail-panel-diff"
          onClick={() => props.onSelectTab("diff")}
        >
          差异
        </button>
        {props.changes ? (
          <button
            type="button"
            role="tab"
            id="detail-tab-changes"
            className="detail-tab"
            aria-selected={props.tab === "changes"}
            aria-controls="detail-panel-changes"
            onClick={() => props.onSelectTab("changes")}
          >
            变更
          </button>
        ) : null}
      </div>
      <div
        className="detail-body"
        id="detail-panel-files"
        role="tabpanel"
        aria-labelledby="detail-tab-files"
        hidden={props.tab !== "files"}
      >
        {props.files}
      </div>
      <div
        className="detail-body"
        id="detail-panel-diff"
        role="tabpanel"
        aria-labelledby="detail-tab-diff"
        hidden={props.tab !== "diff"}
      >
        {props.diff}
      </div>
      {props.changes ? (
        <div
          className="detail-body"
          id="detail-panel-changes"
          role="tabpanel"
          aria-labelledby="detail-tab-changes"
          hidden={props.tab !== "changes"}
        >
          {props.changes}
        </div>
      ) : null}
    </>
  );
}
