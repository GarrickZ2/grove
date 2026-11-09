import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import {
  joinPublicShare,
  publicShareInfo,
  publicShareSource,
  shareErrorCode,
  shareErrorMessage,
  type ShareInfo,
} from "../../api/shares";
import { SharedTaskView } from "./SharedTaskView";
import { copyText, initials, stateMessage, untilText } from "./shareFormat";
import "../../orbit/tokens.css";
import "../../orbit/ui/orbit-ui.css";
import "./share.css";

const NAME_KEY = "grove_share_name";

function rememberedName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ""; } catch { return ""; }
}

function rememberName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private window */ }
}

/** What a browser sees at `/s/<token>`: open it in Grove, or give a name and
 *  look (read only). */
export function PublicSharePage({ token }: { token: string }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    document.title = "Shared task · Grove";
    publicShareInfo(token)
      .then((value) => {
        setInfo(value);
        if (value.you && value.state === "active") setViewing(true);
      })
      .catch((error) => setFailure(shareErrorCode(error) ?? "not_found"));
  }, [token]);

  useEffect(() => {
    if (info?.title) document.title = `${info.title} · ${info.owner} · Grove`;
  }, [info]);

  const link = `${window.location.origin}/s/${token}`;
  const groveLink = `grove://open-share?url=${encodeURIComponent(link)}`;
  const source = useMemo(() => publicShareSource(token), [token]);

  let content;
  if (failure || (info && info.state !== "active" && !viewing)) {
    const message = stateMessage(failure ?? info?.state, info?.owner ?? "");
    content = (
      <div className="share-landing">
        <div className="share-landing-card shared-state">
          <b>{message?.title ?? "This link can't be opened"}</b>
          <p>{message?.body ?? ""}</p>
        </div>
      </div>
    );
  } else if (!info) {
    content = <div className="shared-loading">Opening…</div>;
  } else if (viewing) {
    content = (
      <SharedTaskView
        source={source}
        viewerCanComment={false}
        showComments={false}
        onInfo={setInfo}
        headerNote={info.you ? <span className="share-public-you">Viewing as {info.you.name}</span> : null}
        headerAside={
          <a className="oui-btn oui-btn-secondary oui-btn-sm" href={groveLink}>
            <ExternalLink aria-hidden="true" />Open in Grove
          </a>
        }
        footer={<div className="share-public-foot">Want to comment? Open this same link in Grove.</div>}
      />
    );
  } else {
    content = <Landing info={info} token={token} link={link} groveLink={groveLink} onJoined={(value) => { setInfo(value); setViewing(true); }} />;
  }

  return <div className="orbit-ui share-public">{content}</div>;
}

function Landing({ info, token, link, groveLink, onJoined }: {
  info: ShareInfo;
  token: string;
  link: string;
  groveLink: string;
  onJoined: (info: ShareInfo) => void;
}) {
  const [name, setName] = useState(rememberedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const facts = [
    info.project,
    info.canComment ? "Can comment in Grove" : "View only",
    info.expiresAt ? `Expires ${untilText(info.expiresAt)}` : null,
  ].filter(Boolean).join(" · ");

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const joined = await joinPublicShare(token, name.trim());
      rememberName(name.trim());
      onJoined(joined);
    } catch (err) {
      setError(stateMessage(shareErrorCode(err), info.owner)?.title ?? shareErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-landing">
      <div className="share-landing-card">
        <div className="share-landing-who">
          <span className="shared-owner-avatar" aria-hidden="true">{initials(info.owner)}</span>
          <div>
            <b>{info.owner} shared “{info.title}”</b>
            <span>{facts}</span>
          </div>
        </div>
        <a className="oui-btn oui-btn-primary" href={groveLink}>Open in Grove</a>
        <p className="share-landing-hint">
          Nothing happened? Copy the link and paste it into ⌘K in Grove.{" "}
          <button type="button" className="share-link-button" onClick={() => { void copyText(link); setCopied(true); }}>
            <Copy size={11} />{copied ? "Copied" : "Copy"}
          </button>
        </p>
        <div className="share-landing-divider">No Grove? View it in this browser</div>
        <form onSubmit={(event) => { event.preventDefault(); void join(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Your name
            <input className="oui-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" required />
          </label>
          <p className="share-landing-note">{info.owner} sees this name. This browser remembers it.</p>
          {error && <p className="share-notice is-error" role="alert">{error}</p>}
          <button type="submit" className="oui-btn oui-btn-secondary" disabled={busy || !name.trim()}>{busy ? "Opening…" : "View (read only)"}</button>
        </form>
      </div>
    </div>
  );
}
