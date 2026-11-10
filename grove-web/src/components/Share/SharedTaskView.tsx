import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, FolderOpen, RefreshCw } from "lucide-react";
import { DiffReviewPage } from "../Review/DiffReviewPage";
import { shareBackend } from "../Review/reviewBackend";
import { OrbitArtifactsPanel } from "../../orbit/workspace/artifacts/OrbitArtifactsPanel";
import type { SharedArtifacts } from "../Tasks/TaskInfoPanel/tabs/useArtifactsPanel";
import type { ArtifactFile } from "../../api";
import type { Task } from "../../data/types";
import { OrbitInterfaceContext } from "../../orbit/ui/interfaceContext";
import { PanelShell, PANEL_HUES, Segmented } from "../../orbit/ui";
import {
  shareErrorCode,
  shareErrorMessage,
  shareErrorOwner,
  type ShareInfo,
  type ShareSource,
} from "../../api/shares";
import { initials, stateMessage, untilText } from "./shareFormat";
import "./share.css";

type Tab = "changes" | "files";

export interface SharedTaskViewProps {
  source: ShareSource;
  /** This share's own key (link token or received id), so the review keeps
   *  its view options per share. */
  shareKey: string;
  /** Shown on the right of the header. */
  headerAside?: ReactNode;
  onInfo?: (info: ShareInfo) => void;
}

/** One shared Task, in the same Code Review and Artifacts panels as the
 *  owner's own, minus what only the owner can do. */
export function SharedTaskView({ source, shareKey, headerAside, onInfo }: SharedTaskViewProps) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [failure, setFailure] = useState<{ code?: string; message: string; owner: string } | null>(null);
  const [counts, setCounts] = useState<{ changes: number; files: number } | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [attempt, setAttempt] = useState(0);
  const onInfoRef = useRef(onInfo);
  useEffect(() => { onInfoRef.current = onInfo; }, [onInfo]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await source.open();
        const [diff, output] = await Promise.all([
          source.diff().then((value) => value.files.length).catch(() => 0),
          source.files().then((value) => value.files.filter((file) => !file.is_dir).length).catch(() => 0),
        ]);
        if (cancelled) return;
        setInfo(opened);
        setFailure(null);
        setCounts({ changes: diff, files: output });
        if (diff === 0 && output > 0) setTab("files");
        onInfoRef.current?.(opened);
      } catch (error) {
        if (!cancelled) setFailure({ code: shareErrorCode(error), message: shareErrorMessage(error), owner: shareErrorOwner(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [source, attempt]);

  const canComment = !!info?.canComment;
  const backend = useMemo(() => shareBackend(source, { canComment }), [source, canComment]);
  const shared = useMemo<SharedArtifacts>(() => ({
    list: async () => (await source.files()).files as ArtifactFile[],
    preview: (path) => source.fileText(path),
    downloadUrl: (path) => source.fileUrl(path),
  }), [source]);
  const task = useMemo(() => ({ id: shareKey, name: info?.title ?? "" }) as Task, [shareKey, info?.title]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (failure) {
    const message = stateMessage(failure.code, info?.owner || failure.owner);
    return (
      <div className="shared-view">
        <div className="shared-state" role="alert">
          <b>{message?.title ?? "Couldn't open this share"}</b>
          <p>{message?.body ?? failure.message}</p>
          {failure.code === "offline" && (
            <button type="button" className="oui-btn oui-btn-secondary oui-btn-sm" onClick={retry}>
              <RefreshCw aria-hidden="true" />Try again
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!info || !counts) {
    return <div className="shared-view"><div className="shared-loading">Opening…</div></div>;
  }

  const hasFiles = counts.files > 0;
  const hasChanges = counts.changes > 0 || !hasFiles;
  const shown: Tab = hasChanges && hasFiles ? tab : hasFiles ? "files" : "changes";
  const facts = [info.owner, info.project, info.expiresAt ? `Expires ${untilText(info.expiresAt)}` : null]
    .filter(Boolean).join(" · ");

  return (
    <OrbitInterfaceContext.Provider value>
      <div className="shared-view">
        <header className="shared-head">
          <span className="shared-owner-avatar" aria-hidden="true">{initials(info.owner)}</span>
          <div className="shared-title">
            <b>{info.title}</b>
            <span>{facts}</span>
          </div>
          <span className="shared-head-sp" />
          {hasChanges && hasFiles ? (
            <Segmented
              size="sm"
              ariaLabel="Shared content"
              value={shown}
              onChange={setTab}
              options={[
                { value: "changes", label: `Changes ${counts.changes}` },
                { value: "files", label: `Files ${counts.files}` },
              ]}
            />
          ) : null}
          {headerAside}
        </header>
        <div className="shared-body">
          {shown === "changes" ? (
            <PanelShell glyph={Eye} hue={PANEL_HUES.violet} title="Code Review" body="fill">
              <DiffReviewPage projectId="share" taskId={shareKey} backend={backend} embedded />
            </PanelShell>
          ) : (
            <PanelShell glyph={FolderOpen} hue={PANEL_HUES.pink} title="Artifacts" body="fill">
              <OrbitArtifactsPanel task={task} shared={shared} />
            </PanelShell>
          )}
        </div>
      </div>
    </OrbitInterfaceContext.Provider>
  );
}
