import { useCallback, useEffect, useState } from "react";
import { Check, CircleStop, Copy, Link2, Share2, X } from "lucide-react";
import { Button, PanelMenuButton, Segmented, usePopover } from "../../orbit/ui";
import {
  createShareLink,
  listShareLinks,
  removeShareVisitor,
  revokeShareLink,
  shareErrorMessage,
  updateShareProfile,
  type ShareLink,
  type ShareLinks,
} from "../../api/shares";
import { copyText, initials, untilText } from "./shareFormat";
import "./share.css";

type Expiry = "1" | "7" | "30" | "never";
type Who = "one" | "anyone";

/** Title-bar "Share" for one Task: make a link (what people can do, for whom,
 *  for how long), see who opened each link, stop one. */
export function ShareButton({ projectId, taskId }: { projectId: string; taskId: string }) {
  const { open, toggle, rootRef } = usePopover();
  const [data, setData] = useState<(ShareLinks & { openComments?: number }) | null>(null);

  const refresh = useCallback(() => {
    listShareLinks(projectId, taskId).then(setData).catch(() => {});
  }, [projectId, taskId]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const unresolved = data?.openComments ?? 0;
  return (
    <span ref={rootRef} className="oui-pop-anchor">
      <Button variant="ghost" size="sm" onClick={toggle} aria-expanded={open} title="Share this task" className={open ? "is-pressed" : undefined}>
        <Share2 aria-hidden="true" />Share
        {unresolved > 0 && <span className="share-badge" aria-label={`${unresolved} open comments from people you shared with`}>{unresolved}</span>}
      </Button>
      {open && <SharePanel projectId={projectId} taskId={taskId} data={data} onChanged={refresh} />}
    </span>
  );
}

function SharePanel({ projectId, taskId, data, onChanged }: {
  projectId: string;
  taskId: string;
  data: ShareLinks | null;
  onChanged: () => void;
}) {
  const [canComment, setCanComment] = useState<"view" | "comment">("comment");
  const [who, setWho] = useState<Who>("one");
  const [expiry, setExpiry] = useState<Expiry>("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingAddress, setEditingAddress] = useState(false);

  const createLink = async () => {
    setBusy(true);
    setError(null);
    const created = createShareLink(projectId, taskId, {
      canComment: canComment === "comment",
      expiresInDays: expiry === "never" ? null : Number(expiry),
      maxPeople: who === "one" ? 1 : null,
    });
    // Claim the clipboard during the click; the link arrives a moment later.
    const clipboard = copyText(created.then((link) => link.url));
    try {
      await created;
      onChanged();
      if (await clipboard) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      } else {
        setError("Couldn't copy. Copy it from the list below.");
      }
    } catch (err) {
      setError(shareErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const links = data?.links ?? [];
  return (
    <div className="oui-pop share-pop" role="dialog" aria-label="Share this task">
      <div className="share-head">
        <b>Share this task</b>
      </div>
      <div className="share-form">
        <div className="share-row">
          <span>Can</span>
          <Segmented
            size="sm"
            ariaLabel="What people can do"
            value={canComment}
            onChange={setCanComment}
            options={[{ value: "view", label: "View" }, { value: "comment", label: "Comment" }]}
          />
        </div>
        <div className="share-row">
          <span>Who</span>
          <Segmented
            size="sm"
            ariaLabel="Who can open it"
            value={who}
            onChange={setWho}
            options={[{ value: "one", label: "One person" }, { value: "anyone", label: "Anyone" }]}
          />
        </div>
        <div className="share-row">
          <span>Expires</span>
          <Segmented
            size="sm"
            ariaLabel="Expires after"
            value={expiry}
            onChange={setExpiry}
            options={[
              { value: "1", label: "1 day" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
              { value: "never", label: "Never" },
            ]}
          />
        </div>
        <Button variant="primary" onClick={createLink} disabled={busy} className="share-copy" title="Makes a new link and copies it">
          {copied ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}{busy ? "Creating…" : copied ? "Link copied" : "Create link"}
        </Button>
        {error && <p className="share-notice is-error" role="alert">{error}</p>}
      </div>

      {links.length > 0 && (
        <div className="share-links">
          <div className="share-links-title">Links · {links.length}</div>
          <div className="share-links-list">
            {links.map((link) => <LinkRow key={link.token} link={link} onChanged={onChanged} />)}
          </div>
        </div>
      )}

      <AddressFooter data={data} editing={editingAddress} onEdit={setEditingAddress} onSaved={onChanged} />
    </div>
  );
}

function stateText(link: ShareLink): string | null {
  switch (link.state) {
    case "expired": return "Expired";
    case "revoked": return "Stopped";
    default: return null;
  }
}

function LinkRow({ link, onChanged }: { link: ShareLink; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const ended = stateText(link);
  // Used-up links still serve people who opened them in the last 30 minutes.
  const stoppable = link.state === "active" || link.state === "exhausted";
  const names = link.visitors.map((visitor) => visitor.name);
  const who = names.length === 0 ? "Not opened yet" : names.join(", ");
  const facts = [
    link.canComment ? "Can comment" : "Can view",
    link.maxPeople === 1 ? "One person" : null,
    link.comments > 0 ? `${link.comments} ${link.comments === 1 ? "comment" : "comments"}` : null,
    ended ?? (link.expiresAt ? `Expires ${untilText(link.expiresAt)}` : "Never expires"),
  ].filter(Boolean).join(" · ");

  const copy = async () => {
    if (!(await copyText(link.url))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={`share-link${ended ? " is-ended" : ""}`}>
      <div className="share-link-main">
        <button type="button" className="share-link-body" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} disabled={link.visitors.length === 0}>
          <span className="share-avatars" aria-hidden="true">
            {link.visitors.slice(0, 3).map((visitor) => <span key={visitor.id} className="share-avatar">{initials(visitor.name)}</span>)}
            {link.visitors.length === 0 && <span className="share-avatar is-empty">?</span>}
          </span>
          <span className="share-link-text">
            <b>{who}</b>
            <span>{facts}</span>
          </span>
        </button>
        {!ended && (
          <button type="button" className="share-icon" onClick={copy} title="Copy link" aria-label="Copy link">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        {stoppable && (
          <PanelMenuButton
            portal
            label="Link actions"
            items={[{ id: "stop", label: "Stop sharing", icon: CircleStop, danger: true, onSelect: () => { void revokeShareLink(link.token).then(onChanged); } }]}
          />
        )}
      </div>
      {expanded && link.visitors.length > 0 && (
        <ul className="share-visitors">
          {link.visitors.map((visitor) => (
            <li key={visitor.id} className="share-visitor">
              <span className="share-avatar">{initials(visitor.name)}</span>
              <span className="share-visitor-name">
                <b>{visitor.name}</b>
                <span>
                  {visitor.kind === "browser" ? "Browser" : visitor.device || "Grove"}
                  {visitor.rejoined && <em className="share-rejoined" title="You removed someone with this name before"> · rejoined</em>}
                </span>
              </span>
              {stoppable && (
                <button type="button" className="share-icon" title={`Remove ${visitor.name}`} aria-label={`Remove ${visitor.name}`} onClick={() => void removeShareVisitor(link.token, visitor.id).then(onChanged)}>
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddressFooter({ data, editing, onEdit, onSaved }: {
  data: ShareLinks | null;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const host = data.address.replace(/^https?:\/\//, "");

  const save = async () => {
    setError(null);
    try {
      await updateShareProfile({ address: value });
      onEdit(false);
      onSaved();
    } catch (err) {
      setError(shareErrorMessage(err));
    }
  };

  if (!editing) {
    return (
      <div className="share-foot">
        <span>Links use <b>{host}</b></span>
        <button type="button" className="share-link-button" onClick={() => { setValue(data.address); onEdit(true); }}>Change</button>
      </div>
    );
  }
  return (
    <form className="share-foot is-editing" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="share-address">
        <input className="oui-field" value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://grove.example.com" aria-label="Address other people use" autoComplete="off" spellCheck={false} />
        <Button variant="secondary" size="sm" type="submit" disabled={!value.trim() && data.addressSource !== "custom"}>Save</Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(false)}>Cancel</Button>
      </div>
      {error && <p className="share-notice is-error" role="alert">{error}</p>}
    </form>
  );
}
