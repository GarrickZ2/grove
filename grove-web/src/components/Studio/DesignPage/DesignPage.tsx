import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Download, Frame, Shapes, Upload } from "lucide-react";
import {
  createDesignComment,
  canReplyToDesignComments,
  createDesignPage,
  designExportUrl,
  designPageExportUrl,
  importDesigns,
  replyDesignComment,
  updateDesignMarks,
  getDesignGuide,
  updateDesignLayout,
  type Design,
  type DesignComment,
  type LabelChange,
  type PageChange,
} from "../../../api/designs";
import { updateCommentStatus } from "../../../api/review";
import { useBanner } from "../../../context";
import { useEscapeScope } from "../../../keyboard/useEscapeScope";
import { Button, PanelEmpty, PanelError, PanelLoading, usePopover } from "../../../orbit/ui";
import { downloadViaIframe } from "../../ui/filePreview";
import { targetChatId, useActiveChatTarget } from "../../Review/sendOpenComments";
import { SEND_COMMENT_TO_CHAT_EVENT, type ChatReviewComment } from "../../Tasks/TaskView/reviewCommentPrompt";
import { DesignBoard } from "./DesignBoard";
import { DesignCaptureHost } from "./DesignCaptureHost";
import type { PickedElement } from "./DesignFrame";
import { DesignThread } from "./DesignThread";
import { OPEN_DESIGN_EVENT, takePendingOpen, type OpenDesignDetail } from "./designModel";
import { useDesignData } from "./useDesignData";
import "./design.css";

interface Props {
  projectId: string;
  taskId: string;
  /** The task's agent is working: its file writes are picked up quickly. */
  isChatBusy?: boolean;
  /** Changes when the agent stops: one more look at the files. */
  lastChatIdleAt?: number;
  /**
   * Designs to look at, not this task's own: a share link's (`projectId` is
   * then the key `shareDesignSource` was given) or the Project's design system
   * on its own (`designSystemKey`).
   */
  shared?: { canComment: boolean };
  /** Shown in place of the board when there is nothing to show. */
  empty?: ReactNode;
  /** Leave out the row of design tabs: the panel shows one design only. */
  bare?: boolean;
  /** Told whether there is a design to show, each time that changes. */
  onHasDesign?: (has: boolean) => void;
}

/** What the panel shows, per task. */
interface Showing {
  scope: string;
  design: string | null;
  /** The page a link asked for: the board opens on it. */
  page: string | null;
}

type Thread =
  | { kind: "existing"; id: number; at: { x: number; y: number } }
  | { kind: "new"; design: string; page: string; element: PickedElement; at: { x: number; y: number }; done: () => void };

/** How an element reads in a thread's title and in the message to the agent. */
function elementLabel(element: { selector?: string; text?: string } | null): string {
  if (!element) return "the page";
  const text = element.text?.trim();
  if (text) return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
  return element.selector?.split(" > ").pop() ?? "an element";
}

/** Which design the board shows, chosen from the board's top left corner; a zip comes in and goes out from here too. */
function DesignPicker({ designs, current, onShow, onImport, importing, onExport }: {
  designs: Design[];
  current: Design;
  onShow: (slug: string) => void;
  onImport?: () => void;
  importing: boolean;
  onExport?: () => void;
}) {
  const { open, close, toggle, rootRef } = usePopover<HTMLDivElement>();
  return (
    <div ref={rootRef} className="design-picker" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className="design-picker-btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        {current.is_system ? <Shapes size={13} /> : <Frame size={13} />}
        <span>{current.name}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="design-menu" role="menu" aria-label="Designs">
          {designs.map((entry) => (
            <button key={entry.slug} type="button" role="menuitemradio" aria-checked={entry.slug === current.slug} onClick={() => { close(); onShow(entry.slug); }}>
              {entry.is_system ? <Shapes size={13} /> : <Frame size={13} />}
              <span>{entry.name}</span>
              {entry.slug === current.slug ? <Check size={14} className="design-menu-check" /> : null}
            </button>
          ))}
          {onImport || onExport ? <span className="design-menu-rule" /> : null}
          {onImport ? (
            <button type="button" role="menuitem" disabled={importing} onClick={() => { close(); onImport(); }}>
              <Upload size={13} />
              <span>Import a zip</span>
            </button>
          ) : null}
          {onExport ? (
            <button type="button" role="menuitem" onClick={() => { close(); onExport(); }}>
              <Download size={13} />
              <span>Export as a zip</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Design panel of a Studio task: the agent's HTML pages as artboards on a
 * board, the Project's design system beside them, and comments on elements.
 */
export function DesignPage({ projectId, taskId, isChatBusy, lastChatIdleAt, shared, empty, bare, onHasDesign }: Props) {
  const scope = `${projectId}/${taskId}`;
  const { designs, comments, token, error, reload, patch } = useDesignData(projectId, taskId, { isChatBusy, lastChatIdleAt });
  const [showing, setShowing] = useState<Showing>(() => {
    const asked = takePendingOpen(projectId, taskId);
    return { scope, design: asked?.design ?? null, page: asked?.page ?? null };
  });
  const [thread, setThread] = useState<Thread | null>(null);
  const [guide, setGuide] = useState<{ scope: string; text: string | null } | null>(null);
  const chat = useActiveChatTarget();
  const { showBanner } = useBanner();

  const here = showing.scope === scope ? showing : { scope, design: null, page: null };
  const design = designs?.find((entry) => entry.slug === here.design)
    ?? designs?.find((entry) => !entry.is_system)
    ?? designs?.[0]
    ?? null;

  const hasDesign = designs ? design !== null : null;
  useEffect(() => {
    if (hasDesign !== null) onHasDesign?.(hasDesign);
  }, [hasDesign, onHasDesign]);

  const show = useCallback((slug: string, file: string | null = null) => {
    setThread(null);
    setShowing({ scope: `${projectId}/${taskId}`, design: slug, page: file });
  }, [projectId, taskId]);

  // A design:// chip in the chat opens its design here.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenDesignDetail>).detail;
      if (detail.projectId !== projectId || detail.taskId !== taskId) return;
      takePendingOpen(projectId, taskId);
      show(detail.design, detail.page ?? null);
    };
    window.addEventListener(OPEN_DESIGN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DESIGN_EVENT, onOpen);
  }, [projectId, taskId, show]);

  // DESIGN.md of the design system; read again whenever the designs change.
  const wantsGuide = Boolean(design?.is_system && design.has_guide);
  useEffect(() => {
    if (!wantsGuide) return;
    let cancelled = false;
    getDesignGuide(projectId, taskId).then((text) => {
      if (!cancelled) setGuide({ scope: `${projectId}/${taskId}`, text });
    });
    return () => { cancelled = true; };
  }, [wantsGuide, designs, projectId, taskId]);

  const move = useCallback((slug: string, changes: { pages?: PageChange[]; labels?: LabelChange[] }) => {
    patch(({ designs: list }) => ({
      designs: list.map((entry) => entry.slug !== slug ? entry : {
        ...entry,
        pages: entry.pages.map((item) => {
          const change = changes.pages?.find((moved) => moved.file === item.file);
          return change ? { ...item, x: change.x ?? item.x, y: change.y ?? item.y, placed: true } : item;
        }),
        labels: entry.labels.map((label, index) => {
          const change = changes.labels?.find((moved) => moved.index === index && moved.text === label.text);
          return change ? { ...label, x: change.x, y: change.y } : label;
        }),
      }),
    }));
    updateDesignLayout(projectId, taskId, slug, changes)
      .catch(() => showBanner("Couldn't save the new position", "error"))
      // A poll that was already on its way may have put the old position back.
      .finally(() => void reload());
  }, [patch, projectId, taskId, reload, showBanner]);

  const captured = useCallback((slug: string, file: string, version: string, height: number) => {
    patch(({ designs: list }) => ({
      designs: list.map((entry) => entry.slug !== slug ? entry : {
        ...entry,
        pages: entry.pages.map((item) => item.file === file && item.version === version
          ? { ...item, capture_version: version, rendered_height: height > 0 ? height : item.rendered_height }
          : item),
      }),
    }));
    // The agent lays the board out from real heights, so they go into design.json.
    if (height > 0) void updateDesignLayout(projectId, taskId, slug, { pages: [{ file, rendered_height: height }] }).catch(() => {});
  }, [patch, projectId, taskId]);

  // A zip chosen to import. `asking` holds one whose design system the
  // Project already has, until the user says which to keep.
  const picker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [asking, setAsking] = useState<File | null>(null);
  useEscapeScope(asking !== null, () => setAsking(null));
  const bringIn = useCallback(async (file: File, system?: "skip" | "overwrite") => {
    setAsking(null);
    setImporting(true);
    try {
      const result = await importDesigns(projectId, taskId, file, system);
      if (result === "system-exists") {
        setAsking(file);
        return;
      }
      await reload();
      const opened = result.designs[0] ?? (result.system === "installed" || result.system === "replaced" ? "system" : null);
      if (opened) show(opened);
      showBanner(opened ? `Imported ${file.name}` : "Nothing was imported", opened ? "success" : "error");
    } catch (cause) {
      showBanner((cause as { message?: string } | null)?.message || "Couldn't import the zip", "error");
    } finally {
      setImporting(false);
    }
  }, [projectId, taskId, reload, show, showBanner]);
  const importer = shared ? null : (
    <input
      ref={picker}
      type="file"
      accept=".zip,application/zip"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void bringIn(file);
      }}
    />
  );
  const systemPrompt = asking ? (
    <div className="design-ask" role="dialog" aria-modal="true" aria-label="Design system" onPointerDown={(event) => { if (event.target === event.currentTarget) setAsking(null); }}>
      <div className="design-ask-card">
        <b>This Project already has a design system</b>
        <span>{asking.name} brings its own.</span>
        <div className="design-ask-acts">
          <Button variant="ghost" size="sm" onClick={() => void bringIn(asking, "skip")}>Skip</Button>
          <Button variant="primary" size="sm" onClick={() => void bringIn(asking, "overwrite")}>Overwrite</Button>
        </div>
      </div>
    </div>
  ) : null;

  // Comments wait on the board until they are sent: one thread, or every
  // open one of a design as a single message.
  const sendToAgent = useCallback((list: DesignComment[]) => {
    const details: ChatReviewComment[] = list.map((comment) => ({
      id: comment.id,
      comment_type: "file",
      file_path: `design/${comment.design}/${comment.page}`,
      content: comment.content,
      agent: comment.author,
      status: comment.status,
      design: {
        name: comment.design,
        page: comment.page,
        selector: comment.anchor?.selector,
        text: comment.anchor?.text,
        replies: comment.replies.map((reply) => `${reply.author}: ${reply.content}`),
      },
    }));
    if (details.length === 0) return;
    const chatId = targetChatId();
    window.dispatchEvent(new CustomEvent(SEND_COMMENT_TO_CHAT_EVENT, { detail: details.length === 1 ? { ...details[0], chatId } : { comments: details, chatId } }));
  }, []);

  const openThread = useCallback((comment: DesignComment, at: { x: number; y: number }) => {
    setThread({ kind: "existing", id: comment.id, at });
  }, []);

  if (error && !designs) return <PanelError title="Couldn't load designs" onRetry={() => void reload()}>{error}</PanelError>;
  if (!designs || !token) return <PanelLoading />;
  if (!design) {
    return empty ?? (
      <div className="design-panel">
        {importer}
        {systemPrompt}
        <PanelEmpty
          icon={Frame}
          title="No designs yet"
          action={<Button variant="ghost" size="sm" disabled={importing} onClick={() => picker.current?.click()}><Upload />Import a zip</Button>}
        >
          Ask the agent for a UI design, a prototype or a design system. The pages it builds appear here as artboards you can open, click through and comment on.
        </PanelEmpty>
      </div>
    );
  }

  const existing = thread?.kind === "existing" ? comments.find((comment) => comment.id === thread.id) : undefined;
  const titleOf = (slug: string, file: string) =>
    designs.find((entry) => entry.slug === slug)?.pages.find((entry) => entry.file === file)?.title ?? file;

  return (
    <div className="design-panel">
      {shared ? null : <DesignCaptureHost projectId={projectId} taskId={taskId} token={token} designs={designs} onCaptured={captured} />}
      {importer}
      {systemPrompt}
      <div className="design-stage">
        {bare ? null : (
          <DesignPicker
            designs={designs}
            current={design}
            onShow={show}
            onImport={shared ? undefined : () => picker.current?.click()}
            importing={importing}
            onExport={shared ? undefined : () => downloadViaIframe(designExportUrl(projectId, taskId, design.slug), `${design.is_system ? "design-system" : design.slug}.zip`)}
          />
        )}
        {(
          <DesignBoard
            key={`${design.slug}:${here.page ?? ""}`}
            focusPage={here.page}
            projectId={projectId}
            taskId={taskId}
            token={token}
            design={design}
            guide={design.is_system && guide?.scope === scope ? guide.text : null}
            comments={comments}
            onMove={(changes) => move(design.slug, changes)}
            onOpenThread={openThread}
            onOpenDesign={(slug) => show(slug)}
            onComment={(file, element, at, done) => setThread({ kind: "new", design: design.slug, page: file, element, at, done })}
            readOnly={Boolean(isChatBusy) || Boolean(shared)}
            viewer={shared}
            agent={chat.agent}
            canSend={Boolean(chat.chatId)}
            onSendComments={sendToAgent}
            onExportPage={shared ? undefined : (file, format) => {
              const stem = file.replace(/\.html?$/i, "");
              downloadViaIframe(designPageExportUrl(projectId, taskId, design.slug, file, format), `${design.slug}-${stem}.${format}`);
            }}
            onSaved={() => void reload()}
            onNotice={(message) => showBanner(message, "error")}
            onMarks={(marks) => {
              patch(({ designs: list }) => ({ designs: list.map((entry) => (entry.slug === design.slug ? { ...entry, marks } : entry)) }));
              updateDesignMarks(projectId, taskId, design.slug, marks)
                .catch(() => showBanner("Couldn't save the board", "error"))
                .finally(() => void reload());
            }}
            onFrame={(frame) => {
              createDesignPage(projectId, taskId, design.slug, frame)
                .catch(() => showBanner("Couldn't add the frame", "error"))
                .finally(() => void reload());
            }}
          />
        )}
      </div>
      {thread?.kind === "new" ? (
        <DesignThread
          at={thread.at}
          target={`${titleOf(thread.design, thread.page)} · ${elementLabel(thread.element)}`}
          agent={chat.agent}
          canSend={Boolean(chat.chatId)}
          onClose={() => setThread(null)}
          onSubmit={async (text) => {
            const { element } = thread;
            const result = await createDesignComment(projectId, taskId, {
              design: thread.design,
              page: thread.page,
              content: text,
              anchor: { selector: element.selector, xpath: element.xpath, text: element.text, x: element.x, y: element.y, width: element.width, height: element.height },
            });
            patch(() => ({ comments: result.comments }));
            thread.done();
            setThread(null);
          }}
        />
      ) : null}
      {thread?.kind === "existing" && existing ? (
        <DesignThread
          at={thread.at}
          comment={existing}
          target={`${titleOf(existing.design, existing.page)} · ${elementLabel(existing.anchor)}`}
          agent={chat.agent}
          canSend={Boolean(chat.chatId)}
          compose={shared ? shared.canComment && canReplyToDesignComments(projectId) : true}
          onClose={() => setThread(null)}
          onResolve={shared ? undefined : () => {
            const status = existing.status === "open" ? "resolved" : "open";
            patch(({ comments: list }) => ({ comments: list.map((comment) => comment.id === existing.id ? { ...comment, status } : comment) }));
            if (status === "resolved") setThread(null);
            updateCommentStatus(projectId, taskId, existing.id, status).catch(() => void reload());
          }}
          onSend={shared ? undefined : () => {
            sendToAgent([existing]);
            setThread(null);
          }}
          onSubmit={async (text) => {
            await replyDesignComment(projectId, taskId, existing.id, text);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}
