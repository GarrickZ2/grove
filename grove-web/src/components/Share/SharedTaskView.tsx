import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, File as FileIcon, FileCode2, FilePlus2, FileMinus2, MessageSquare, RefreshCw } from "lucide-react";
import { DiffFileView } from "../Review/DiffFileView";
import type { CommentAnchor } from "../Review/DiffReviewPage";
import type { DiffFile, DiffStatFile, DiffStatsResult } from "../../api/review";
import type { ReviewCommentEntry } from "../../api/tasks";
import {
  shareErrorCode,
  shareErrorMessage,
  shareErrorOwner,
  type ShareInfo,
  type ShareSource,
  type SharedComment,
  type SharedFile,
} from "../../api/shares";
import { agoText, useNow } from "../../orbit/ui";
import { initials, stateMessage, untilText } from "./shareFormat";
import "./share.css";

type Tab = "changes" | "files";

/** Show the review-comment shape the diff view knows. */
function toReviewComment(comment: SharedComment): ReviewCommentEntry {
  return {
    id: comment.id,
    comment_type: comment.commentType,
    file_path: comment.filePath ?? undefined,
    side: comment.side ?? undefined,
    start_line: comment.startLine ?? undefined,
    end_line: comment.endLine ?? undefined,
    content: comment.content,
    agent: comment.author,
    model: "",
    role: "",
    timestamp: comment.timestamp,
    status: comment.status,
    replies: comment.replies.map((reply, index) => ({
      id: index + 1,
      content: reply.content,
      agent: reply.author,
      model: "",
      role: "",
      timestamp: reply.timestamp,
    })),
  };
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const TEXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|html?|css|js|jsx|ts|tsx|py|rs|go|rb|java|kt|swift|c|h|cpp|sh|excalidraw|xml|ini|log)$/i;

export interface SharedTaskViewProps {
  source: ShareSource;
  /** Whether this kind of viewer may comment at all (Grove yes, a browser no);
   *  the link itself must allow it too. */
  viewerCanComment: boolean;
  /** Shown on the right of the header (e.g. "Open in Grove"). */
  headerAside?: ReactNode;
  /** Shown under the owner line (e.g. "You are 王磊 · Change"). */
  headerNote?: ReactNode;
  /** A browser only views: no comments panel. */
  showComments: boolean;
  footer?: ReactNode;
  onInfo?: (info: ShareInfo) => void;
}

/** One shared Task: its changes and output files, always as they are now. */
export function SharedTaskView({ source, viewerCanComment, headerAside, headerNote, showComments, footer, onInfo }: SharedTaskViewProps) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [failure, setFailure] = useState<{ code?: string; message: string; owner: string } | null>(null);
  const [stats, setStats] = useState<DiffStatsResult | null>(null);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [comments, setComments] = useState<SharedComment[]>([]);
  const [tab, setTab] = useState<Tab>("changes");
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedKey, setLoadedKey] = useState(-1);
  const reloading = loadedKey !== reloadKey;
  const onInfoRef = useRef(onInfo);
  useEffect(() => { onInfoRef.current = onInfo; }, [onInfo]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const opened = await source.open();
        const [diff, output, thread] = await Promise.all([
          source.diff().catch(() => ({ files: [], total_additions: 0, total_deletions: 0 }) as DiffStatsResult),
          source.files().catch(() => ({ files: [] as SharedFile[] })),
          showComments ? source.comments().catch(() => ({ comments: [] as SharedComment[] })) : Promise.resolve({ comments: [] as SharedComment[] }),
        ]);
        if (cancelled) return;
        setInfo(opened);
        setFailure(null);
        onInfoRef.current?.(opened);
        setStats(diff);
        const outputFiles = output.files.filter((file) => !file.is_dir);
        setFiles(outputFiles);
        setComments(thread.comments);
        if (diff.files.length === 0 && outputFiles.length > 0) setTab("files");
      } catch (error) {
        if (!cancelled) setFailure({ code: shareErrorCode(error), message: shareErrorMessage(error), owner: shareErrorOwner(error) });
      } finally {
        if (!cancelled) setLoadedKey(reloadKey);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [source, showComments, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  if (failure) {
    const message = stateMessage(failure.code, info?.owner || failure.owner);
    return (
      <div className="shared-view">
        <div className="shared-state" role="alert">
          <b>{message?.title ?? "Couldn't open this share"}</b>
          <p>{message?.body ?? failure.message}</p>
          {failure.code === "offline" && (
            <button type="button" className="oui-btn oui-btn-secondary oui-btn-sm" onClick={reload}>
              <RefreshCw aria-hidden="true" />Try again
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!info || !stats) {
    return <div className="shared-view"><div className="shared-loading">Opening…</div></div>;
  }

  const changeCount = stats.files.length;
  const allowComments = viewerCanComment && info.canComment;
  return (
    <div className="shared-view">
      <header className="shared-head">
        <span className="shared-owner-avatar" aria-hidden="true">{initials(info.owner)}</span>
        <div className="shared-title">
          <b>{info.title}</b>
          <span>{info.owner}{info.project ? ` · ${info.project}` : ""}</span>
          {headerNote}
        </div>
        <span className={`shared-chip${allowComments ? " is-accent" : ""}`}>{allowComments ? "Can comment" : "View only"}</span>
        <span className="shared-chip">{info.expiresAt ? `Expires ${untilText(info.expiresAt)}` : "Never expires"}</span>
        <div className="shared-tabs" role="tablist" aria-label="Shared content">
          <button type="button" role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "is-on" : ""} onClick={() => setTab("changes")}>
            Changes <span>{changeCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "files"} className={tab === "files" ? "is-on" : ""} onClick={() => setTab("files")}>
            Files <span>{files.length}</span>
          </button>
        </div>
        <button type="button" className="share-icon" title="Refresh" aria-label="Refresh" onClick={reload} disabled={reloading}>
          <RefreshCw size={14} className={reloading ? "is-spinning" : ""} />
        </button>
        {headerAside}
      </header>
      <div className={`shared-body${showComments ? " has-comments" : ""}`}>
        {tab === "changes" ? (
          <ChangesPane
            source={source}
            stats={stats}
            selected={selected}
            onSelect={setSelected}
            comments={comments}
            allowComments={allowComments}
            onComments={setComments}
          />
        ) : (
          <FilesPane source={source} files={files} />
        )}
        {showComments && (
          <CommentsPane
            owner={info.owner}
            comments={comments}
            canComment={allowComments}
            onOpen={(comment) => {
              if (comment.filePath) {
                setTab("changes");
                setSelected(comment.filePath);
              }
            }}
          />
        )}
      </div>
      {footer}
    </div>
  );
}

function statusIcon(file: DiffStatFile) {
  if (file.status === "A" || file.status === "U") return <FilePlus2 size={14} className="is-add" />;
  if (file.status === "D") return <FileMinus2 size={14} className="is-del" />;
  return <FileCode2 size={14} />;
}

function ChangesPane({ source, stats, selected, onSelect, comments, allowComments, onComments }: {
  source: ShareSource;
  stats: DiffStatsResult;
  selected: string | null;
  onSelect: (path: string) => void;
  comments: SharedComment[];
  allowComments: boolean;
  onComments: (comments: SharedComment[]) => void;
}) {
  const current = stats.files.find((file) => file.path === selected) ?? stats.files[0] ?? null;
  const [loaded, setLoaded] = useState<{ path: string; diff?: DiffFile; error?: string } | null>(null);
  const [anchor, setAnchor] = useState<CommentAnchor | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const diff = loaded && loaded.path === current?.path ? loaded.diff ?? null : null;
  const diffError = loaded && loaded.path === current?.path ? loaded.error ?? null : null;

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    source.fileDiff(current.path, current.old_path)
      .then((file) => { if (!cancelled) setLoaded({ path: current.path, diff: file }); })
      .catch((error) => { if (!cancelled) setLoaded({ path: current.path, error: shareErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [source, current]);

  const fileComments = useMemo(
    () => comments.filter((comment) => comment.filePath === current?.path).map(toReviewComment),
    [comments, current?.path],
  );
  const countByFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments) {
      if (comment.filePath) counts.set(comment.filePath, (counts.get(comment.filePath) ?? 0) + 1);
    }
    return counts;
  }, [comments]);

  const gutter = useCallback((filePath: string, side: "ADD" | "DELETE", line: number, shiftKey: boolean) => {
    setAnchor((prev) => {
      if (shiftKey && prev && prev.filePath === filePath && prev.side === side) {
        return { filePath, side, startLine: Math.min(prev.startLine, line), endLine: Math.max(prev.endLine, line) };
      }
      if (prev && prev.filePath === filePath && prev.side === side && prev.startLine === line && prev.endLine === line) return null;
      return { filePath, side, startLine: line, endLine: line };
    });
  }, []);

  const send = useCallback(async (at: CommentAnchor, content: string) => {
    setSendError(null);
    try {
      const result = await source.addComment({
        commentType: "inline",
        filePath: at.filePath,
        side: at.side,
        startLine: at.startLine,
        endLine: at.endLine,
        content,
      });
      onComments(result.comments);
      setAnchor(null);
    } catch (error) {
      setSendError(shareErrorMessage(error));
    }
  }, [source, onComments]);

  if (stats.files.length === 0) {
    return <div className="shared-empty">No code changes in this task.</div>;
  }
  return (
    <>
      <nav className="shared-tree" aria-label="Changed files">
        {stats.files.map((file) => {
          const count = countByFile.get(file.path);
          return (
            <button key={file.path} type="button" className={file.path === current?.path ? "is-on" : ""} onClick={() => onSelect(file.path)} title={file.path}>
              {statusIcon(file)}
              <span className="shared-tree-name">{file.path.split("/").pop()}</span>
              {count ? <span className="shared-tree-count"><MessageSquare size={11} />{count}</span> : null}
              <span className="shared-tree-stat"><i className="is-add">+{file.additions}</i> <i className="is-del">−{file.deletions}</i></span>
            </button>
          );
        })}
      </nav>
      <div className="shared-diff">
        {sendError && <p className="share-notice is-error" role="alert">{sendError}</p>}
        {diffError && <div className="shared-empty">{diffError}</div>}
        {!diff && !diffError && <div className="shared-loading">Loading changes…</div>}
        {diff && (
          <DiffFileView
            key={diff.new_path}
            file={diff}
            viewType="unified"
            isActive
            defaultExpanded
            comments={fileComments}
            commentFormAnchor={allowComments ? anchor : null}
            onGutterClick={allowComments ? gutter : undefined}
            onAddComment={allowComments ? send : undefined}
            onCancelComment={() => setAnchor(null)}
          />
        )}
      </div>
    </>
  );
}

function FilesPane({ source, files }: { source: ShareSource; files: SharedFile[] }) {
  const now = useNow(60_000);
  const [selected, setSelected] = useState<string | null>(files[0]?.path ?? null);
  const current = files.find((file) => file.path === selected) ?? files[0] ?? null;
  const [preview, setPreview] = useState<{ path: string; text?: string; image?: string; error?: string } | null>(null);
  const shown = preview && preview.path === current?.path ? preview : null;
  const text = shown?.text ?? null;
  const image = shown?.image ?? null;
  const error = shown?.error ?? null;

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const path = current.path;
    if (IMAGE.test(current.name)) {
      source.fileBlob(path).then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ path, image: objectUrl });
      }).catch((err) => { if (!cancelled) setPreview({ path, error: shareErrorMessage(err) }); });
    } else if (TEXT.test(current.name)) {
      source.fileText(path)
        .then((value) => { if (!cancelled) setPreview({ path, text: value }); })
        .catch((err) => { if (!cancelled) setPreview({ path, error: shareErrorMessage(err) }); });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, current]);

  const download = async () => {
    if (!current) return;
    const blob = await source.fileBlob(current.path);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = current.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (files.length === 0) return <div className="shared-empty">No output files in this task.</div>;
  return (
    <>
      <nav className="shared-tree" aria-label="Output files">
        {files.map((file) => (
          <button key={file.path} type="button" className={file.path === current?.path ? "is-on" : ""} onClick={() => setSelected(file.path)} title={file.path}>
            <FileIcon size={14} />
            <span className="shared-tree-name">{file.name}</span>
            <span className="shared-tree-stat">{agoText(new Date(file.modified_at).getTime(), now)}</span>
          </button>
        ))}
      </nav>
      <div className="shared-diff shared-file">
        {current && (
          <div className="shared-file-head">
            <b>{current.path}</b>
            <span>{formatSize(current.size)}</span>
            <button type="button" className="oui-btn oui-btn-secondary oui-btn-sm" onClick={() => void download()}>
              <Download aria-hidden="true" />Download
            </button>
          </div>
        )}
        {error && <div className="shared-empty">{error}</div>}
        {image && <div className="shared-image"><img src={image} alt={current?.name} /></div>}
        {text !== null && <pre className="shared-text">{text}</pre>}
        {current && !image && text === null && !error && !IMAGE.test(current.name) && !TEXT.test(current.name) && (
          <div className="shared-empty">No preview for this file. Download it to open.</div>
        )}
      </div>
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CommentsPane({ owner, comments, canComment, onOpen }: {
  owner: string;
  comments: SharedComment[];
  canComment: boolean;
  onOpen: (comment: SharedComment) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const now = useNow(60_000);
  const authors = useMemo(() => {
    const names = new Map<string, number>();
    for (const comment of comments) if (!comment.mine) names.set(comment.author, (names.get(comment.author) ?? 0) + 1);
    return [...names.entries()];
  }, [comments]);
  const mine = comments.filter((comment) => comment.mine).length;
  const shown = comments.filter((comment) =>
    filter === "all" ? true : filter === "mine" ? comment.mine : !comment.mine && comment.author === filter,
  );

  return (
    <aside className="shared-comments" aria-label="Comments">
      <div className="shared-comments-head">
        <b>Comments</b><span>{comments.length}</span>
      </div>
      {comments.length > 0 && (
        <div className="shared-chips" role="radiogroup" aria-label="Show comments from">
          <button type="button" role="radio" aria-checked={filter === "all"} className={filter === "all" ? "is-on" : ""} onClick={() => setFilter("all")}>All {comments.length}</button>
          {mine > 0 && <button type="button" role="radio" aria-checked={filter === "mine"} className={filter === "mine" ? "is-on" : ""} onClick={() => setFilter("mine")}>Mine {mine}</button>}
          {authors.map(([name, count]) => (
            <button key={name} type="button" role="radio" aria-checked={filter === name} className={filter === name ? "is-on" : ""} onClick={() => setFilter(name)}>{name} {count}</button>
          ))}
        </div>
      )}
      <div className="shared-comments-list">
        {comments.length === 0 && (
          <p className="shared-comments-empty">
            {canComment ? "No comments yet. Click a line number in the changes to comment." : "No comments yet."}
          </p>
        )}
        {shown.map((comment) => (
          <button key={comment.id} type="button" className={`shared-comment${comment.status === "resolved" ? " is-resolved" : ""}`} onClick={() => onOpen(comment)}>
            <span className="shared-comment-top">
              <span className="share-avatar">{initials(comment.author)}</span>
              <b>{comment.mine ? "You" : comment.author}</b>
              <span>· {agoText(new Date(comment.timestamp).getTime(), now)}</span>
              {comment.status === "resolved" && <span className="shared-comment-tag">Resolved</span>}
            </span>
            {comment.filePath && (
              <code className="shared-comment-place">{comment.filePath.split("/").pop()}{comment.startLine ? `:${comment.startLine}` : ""}</code>
            )}
            <span className="shared-comment-text">{comment.content}</span>
            {comment.replies.map((reply, index) => (
              <span key={index} className="shared-comment-reply"><b>{reply.author === owner ? owner : reply.author}:</b> {reply.content}</span>
            ))}
          </button>
        ))}
      </div>
      {canComment && <p className="shared-comments-foot">Comments you send are seen by {owner} and everyone else this task is shared with.</p>}
    </aside>
  );
}
