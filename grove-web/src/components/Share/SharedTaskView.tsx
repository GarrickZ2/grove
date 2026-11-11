import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Eye, FolderOpen, Frame, Pencil, RefreshCw } from "lucide-react";
import { DiffReviewPage } from "../Review/DiffReviewPage";
import { shareBackend } from "../Review/reviewBackend";
import { OrbitArtifactsPanel } from "../../orbit/workspace/artifacts/OrbitArtifactsPanel";
import type { SharedArtifacts } from "../Tasks/TaskInfoPanel/tabs/useArtifactsPanel";
import type { ArtifactFile, ReviewCommentEntry } from "../../api";
import type { SharedComment } from "../../api/shares";
import { shareDesignSource } from "../../api/designs";
import { BannerProvider, PreviewCommentProvider } from "../../context";
import { DesignPage } from "../Studio/DesignPage";
import { SharedSketchPage } from "../Studio/SketchPage";
import type { SharedSketches } from "../../api/sketches";
import type { Task } from "../../data/types";
import { OrbitInterfaceContext } from "../../orbit/ui/interfaceContext";
import { ProjectSwitcher } from "../Tasks/TaskView/ProjectSwitcher";
import { useProjectTarget, type ProjectTarget } from "../Tasks/TaskView/useProjectTarget";
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

type Tab = "changes" | "files" | "designs" | "sketches";

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
  const [counts, setCounts] = useState<{ changes: number; files: number; designs: number; sketches: number } | null>(null);
  const [tab, setTab] = useState<Tab>("changes");
  const [attempt, setAttempt] = useState(0);
  const onInfoRef = useRef(onInfo);
  useEffect(() => { onInfoRef.current = onInfo; }, [onInfo]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opened = await source.open();
        const changed = (from: ShareSource) => from.diff().then((value) => value.files.length).catch(() => 0);
        const [diff, output, pages, drawn] = await Promise.all([
          // The Task's own changes and those of the Projects it links.
          Promise.all([changed(source), ...(opened.reviews ?? []).map((review) => changed(source.review(review.id)))])
            .then((all) => all.reduce((sum, n) => sum + n, 0)),
          source.files().then((value) => value.files.filter((file) => !file.is_dir).length).catch(() => 0),
          source.designs()
            .then((value) => value.designs.filter((design) => !design.is_system).reduce((sum, design) => sum + design.pages.length, 0))
            .catch(() => 0),
          source.sketches().then((value) => value.sketches.length).catch(() => 0),
        ]);
        if (cancelled) return;
        setInfo(opened);
        setFailure(null);
        setCounts({ changes: diff, files: output, designs: pages, sketches: drawn });
        if (diff === 0 && pages > 0) setTab("designs");
        else if (diff === 0 && output > 0) setTab("files");
        else if (diff === 0 && drawn > 0) setTab("sketches");
        onInfoRef.current?.(opened);
      } catch (error) {
        if (!cancelled) setFailure({ code: shareErrorCode(error), message: shareErrorMessage(error), owner: shareErrorOwner(error) });
      }
    })();
    return () => { cancelled = true; };
  }, [source, attempt]);

  const canComment = !!info?.canComment;
  const shared = useMemo<SharedArtifacts>(() => {
    // The link's comments in the shape the Artifacts panel reads its own in.
    const entries = (list: SharedComment[]): ReviewCommentEntry[] => list.map((comment) => ({
      id: comment.id,
      comment_type: comment.commentType,
      file_path: comment.filePath ?? undefined,
      content: comment.content,
      agent: comment.author,
      model: "",
      role: "",
      timestamp: comment.timestamp,
      status: comment.status,
      replies: comment.replies.map((reply) => ({ id: reply.id, content: reply.content, agent: reply.author, model: "", role: "", timestamp: reply.timestamp })),
      anchor: comment.anchor ?? undefined,
    }));
    return {
      list: async () => (await source.files()).files as ArtifactFile[],
      preview: (path) => source.fileText(path),
      downloadUrl: (path) => source.fileUrl(path),
      comments: {
        canComment,
        list: async () => entries((await source.comments()).comments),
        add: async (path, content, anchor) => entries((await source.addComment({ commentType: "file", filePath: path, content, anchor })).comments),
        reply: async (id, content) => entries((await source.addReply(id, content)).comments),
      },
    };
  }, [source, canComment]);
  const task = useMemo(() => ({ id: shareKey, name: info?.title ?? "" }) as Task, [shareKey, info?.title]);
  // The Design panel reads this share as if it were a task of its own.
  const designKey = `share:${shareKey}`;
  useEffect(() => {
    shareDesignSource(designKey, {
      list: () => source.designs(),
      page: (design, file) => source.designPage(design, file),
      addComment: async (comment) => {
        await source.addComment({ commentType: "file", filePath: `design/${comment.design}/${comment.page}`, anchor: comment.anchor, content: comment.content });
      },
      reply: canComment ? async (id, content) => { await source.addReply(id, content); } : undefined,
    });
  }, [designKey, source, canComment]);
  // Taken away only when the view closes: the panel inside reads through it
  // in its own effects, which run before this one is set up again.
  useEffect(() => () => shareDesignSource(designKey, null), [designKey]);
  const sketches = useMemo<SharedSketches>(() => ({
    list: () => source.sketches(),
    scene: (sketchId) => source.sketchScene(sketchId),
    addComment: canComment
      ? async ({ sketch, anchor, content }) => {
        await source.addComment({ commentType: "file", filePath: `sketch/${sketch}`, anchor, content });
      }
      : undefined,
    reply: canComment ? async (id, content) => { await source.addReply(id, content); } : undefined,
  }), [source, canComment]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The reviews the Code Review tab switches between: the Task's own (Studio
  // Tasks have none), and those of the Projects it links, as in the owner's
  // Review panel.
  const linkedReviews = info?.reviews;
  const ownReview = info?.ownReview ?? true;
  const targets = useMemo<ProjectTarget[]>(() => {
    const linked = (linkedReviews ?? []).map((review) => ({ projectId: review.id, taskId: shareKey, name: review.name, linked: true }));
    const own = { projectId: "", taskId: shareKey, name: info?.project || "This task", linked: false };
    return ownReview || linked.length === 0 ? [own, ...linked] : linked;
  }, [linkedReviews, ownReview, shareKey, info?.project]);
  const { active: reviewTarget, select: selectReview } = useProjectTarget(`grove:share-review:${shareKey}`, targets);
  const linkedReview = reviewTarget?.linked ? reviewTarget.projectId : null;
  const reviewSource = useMemo(
    () => (linkedReview ? source.review(linkedReview) : source),
    [source, linkedReview],
  );
  const backend = useMemo(() => shareBackend(reviewSource, { canComment }), [reviewSource, canComment]);

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
  const hasDesigns = counts.designs > 0;
  const hasSketches = counts.sketches > 0;
  const hasChanges = counts.changes > 0 || (info.reviews?.length ?? 0) > 0 || (!hasFiles && !hasDesigns && !hasSketches);
  const tabs = [
    hasChanges ? { value: "changes" as const, label: `Changes ${counts.changes}` } : null,
    hasDesigns ? { value: "designs" as const, label: `Designs ${counts.designs}` } : null,
    hasSketches ? { value: "sketches" as const, label: `Sketches ${counts.sketches}` } : null,
    hasFiles ? { value: "files" as const, label: `Files ${counts.files}` } : null,
  ].filter((entry) => entry !== null);
  const shown: Tab = tabs.some((entry) => entry.value === tab) ? tab : tabs[0].value;
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
          {tabs.length > 1 ? <Segmented size="sm" ariaLabel="Shared content" value={shown} onChange={setTab} options={tabs} /> : null}
          {headerAside}
        </header>
        <div className="shared-body">
          {shown === "changes" ? (
            <PanelShell glyph={Eye} hue={PANEL_HUES.violet} title="Code Review" body="fill">
              <DiffReviewPage
                key={reviewTarget?.projectId ?? ""}
                projectId="share"
                taskId={reviewTarget?.linked ? `${shareKey}:${reviewTarget.projectId}` : shareKey}
                backend={backend}
                embedded
                title={(linkedReviews?.length ?? 0) > 0 && reviewTarget ? (
                  <ProjectSwitcher targets={targets} active={reviewTarget} onSelect={selectReview} verb="Reviewing" />
                ) : undefined}
              />
            </PanelShell>
          ) : shown === "designs" ? (
            <PanelShell glyph={Frame} hue={PANEL_HUES.indigo} title="Design" body="fill">
              <BannerProvider>
                <PreviewCommentProvider>
                  <DesignPage projectId={designKey} taskId="shared" shared={{ canComment }} />
                </PreviewCommentProvider>
              </BannerProvider>
            </PanelShell>
          ) : shown === "sketches" ? (
            <PanelShell glyph={Pencil} hue={PANEL_HUES.teal} title="Sketch" body="fill">
              <SharedSketchPage source={sketches} />
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
