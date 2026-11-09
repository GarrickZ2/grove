import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, MoreHorizontal, Share2, X } from "lucide-react";
import { Button, Segmented, usePopover } from "../../orbit/ui";
import {
  createShareLink,
  listShareLinks,
  removeShareVisitor,
  revokeShareLink,
  shareErrorCode,
  shareErrorMessage,
  updateShareProfile,
  type ShareLink,
  type ShareLinks,
} from "../../api/shares";
import { copyText, initials, untilText } from "./shareFormat";
import "./share.css";

const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "never", label: "Never" },
] as const;
const OPENS = [
  { value: "any", label: "Any number of opens" },
  { value: "10", label: "10 opens" },
  { value: "50", label: "50 opens" },
  { value: "100", label: "100 opens" },
] as const;

/** Title-bar "Share" for one Task: pick who may comment and for how long, copy
 *  a link, see who opened each link, stop one. */
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
  const [expiry, setExpiry] = useState<string>("7");
  const [opens, setOpens] = useState<string>("any");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);

  const noAddress = data !== null && !data.address;

  const copyLink = async () => {
    setBusy(true);
    setNotice(null);
    const comment = canComment === "comment";
    const created = createShareLink(projectId, taskId, {
      canComment: comment,
      expiresInDays: expiry === "never" ? null : Number(expiry),
      maxOpens: opens === "any" ? null : Number(opens),
    });
    // Claim the clipboard during the click; the link arrives a moment later.
    const copied = copyText(created.then((link) => link.url ?? Promise.reject(new Error("no link"))));
    try {
      await created;
      const ok = await copied;
      const what = comment
        ? "Anyone with it can view; people who open it in Grove can also comment."
        : "Anyone with it can view.";
      setNotice({ tone: "ok", text: ok ? `Link copied. ${what}` : `Link created, but it couldn't be copied. Copy it from the list below. ${what}` });
      onChanged();
    } catch (error) {
      if (shareErrorCode(error) === "no_address") setEditingAddress(true);
      setNotice({ tone: "error", text: shareErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const links = data?.links ?? [];
  return (
    <div className="oui-pop share-pop" role="dialog" aria-label="Share this task">
      <div className="share-head">
        <b>Share this task</b>
        <span>Changes + output files</span>
      </div>
      <div className="share-form">
        <label className="share-row">
          <span>People can</span>
          <Segmented
            size="sm"
            ariaLabel="What people can do"
            value={canComment}
            onChange={setCanComment}
            options={[{ value: "view", label: "View" }, { value: "comment", label: "Comment" }]}
          />
        </label>
        <div className="share-row">
          <span>Expires</span>
          <div className="share-selects">
            <select className="oui-field share-select" value={expiry} onChange={(event) => setExpiry(event.target.value)} aria-label="Expires after">
              {EXPIRY.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select className="oui-field share-select" value={opens} onChange={(event) => setOpens(event.target.value)} aria-label="How many opens">
              {OPENS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
        </div>
        <Button variant="primary" onClick={copyLink} disabled={busy || noAddress} className="share-copy">
          <Link2 aria-hidden="true" />{busy ? "Creating…" : "Copy link"}
        </Button>
        {notice && <p className={`share-notice is-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
      </div>

      {links.length > 0 && (
        <div className="share-links">
          <div className="share-links-title">Shared links · {links.length}</div>
          <div className="share-links-list">
            {links.map((link) => <LinkRow key={link.token} link={link} onChanged={onChanged} />)}
          </div>
        </div>
      )}

      <AddressFooter data={data} editing={editingAddress || noAddress} onEdit={setEditingAddress} onSaved={onChanged} />
    </div>
  );
}

function stateText(link: ShareLink): string | null {
  switch (link.state) {
    case "expired": return "Expired";
    case "exhausted": return "Opens used up";
    case "revoked": return "Stopped";
    default: return null;
  }
}

function LinkRow({ link, onChanged }: { link: ShareLink; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const ended = stateText(link);
  // Used-up links still serve people who opened them in the last 30 minutes.
  const stoppable = link.state === "active" || link.state === "exhausted";
  const names = link.visitors.map((visitor) => visitor.name);
  const who = names.length === 0 ? "No one has opened it" : names.join(", ");
  const opens = link.maxOpens ? `${link.opens} / ${link.maxOpens} opens` : `Opened ${link.opens} ${link.opens === 1 ? "time" : "times"}`;
  const facts = [
    opens,
    link.comments > 0 ? `${link.comments} ${link.comments === 1 ? "comment" : "comments"}` : null,
    ended ?? (link.expiresAt ? `Expires ${untilText(link.expiresAt)}` : "Never expires"),
  ].filter(Boolean).join(" · ");

  const copy = async () => {
    if (!link.url) return;
    if (!(await copyText(link.url))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={`share-link${ended ? " is-ended" : ""}`}>
      <div className="share-link-main">
        <button type="button" className="share-link-body" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="share-avatars" aria-hidden="true">
            {link.visitors.slice(0, 3).map((visitor) => <span key={visitor.id} className="share-avatar">{initials(visitor.name)}</span>)}
            {link.visitors.length === 0 && <span className="share-avatar is-empty">?</span>}
          </span>
          <span className="share-link-text">
            <b>{link.canComment ? "Can comment" : "Can view"} · {who}</b>
            <span>{facts}</span>
          </span>
        </button>
        {!ended && link.url && (
          <button type="button" className="share-icon" onClick={copy} title="Copy link" aria-label="Copy link">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        )}
        {stoppable && (
          <span className="share-menu-anchor">
            <button type="button" className="share-icon" onClick={() => setMenu((value) => !value)} title="More" aria-label="More" aria-expanded={menu}>
              <MoreHorizontal size={14} />
            </button>
            {menu && (
              <div className="share-menu" role="menu">
                <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(false); void revokeShareLink(link.token).then(onChanged); }}>
                  Stop sharing
                </button>
              </div>
            )}
          </span>
        )}
      </div>
      {expanded && (
        <ul className="share-visitors">
          {link.visitors.length === 0 && <li className="share-visitor is-empty">No one has opened this link yet.</li>}
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
  const host = data.address?.replace(/^https?:\/\//, "");

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

  if (!editing && host) {
    return (
      <div className="share-foot">
        <span>People reach you at <b>{host}</b></span>
        <button type="button" className="share-link-button" onClick={() => { setValue(data.address ?? ""); onEdit(true); }}>Change</button>
      </div>
    );
  }
  return (
    <form className="share-foot is-editing" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {!host && <p>Other people can't reach this Grove yet. Run <code>grove remote</code> on this machine, or enter the address they use.</p>}
      <div className="share-address">
        <input className="oui-field" value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://grove.example.com" aria-label="Address other people use" autoComplete="off" spellCheck={false} />
        <Button variant="secondary" size="sm" type="submit" disabled={!value.trim() && !data.address}>Save</Button>
        {host && <Button variant="ghost" size="sm" onClick={() => onEdit(false)}>Cancel</Button>}
      </div>
      {error && <p className="share-notice is-error" role="alert">{error}</p>}
    </form>
  );
}
