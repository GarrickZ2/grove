import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
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
        shareKey={token}
        onInfo={setInfo}
        headerAside={<CopyForGrove link={link} />}
      />
    );
  } else {
    content = <Landing info={info} token={token} link={link} onJoined={(value) => { setInfo(value); setViewing(true); }} />;
  }

  return <div className="orbit-ui share-public">{content}</div>;
}

/** Grove opens a link pasted into ⌘K; there is no way to hand it over from
 *  a browser page. */
function CopyForGrove({ link, wide = false }: { link: string; wide?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(link))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      className={`oui-btn oui-btn-sm ${wide ? "oui-btn-primary" : "oui-btn-secondary"}`}
      title="Paste it into ⌘K in Grove"
      onClick={() => void copy()}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy link for Grove"}
    </button>
  );
}

function Landing({ info, token, link, onJoined }: {
  info: ShareInfo;
  token: string;
  link: string;
  onJoined: (info: ShareInfo) => void;
}) {
  const [name, setName] = useState(rememberedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const facts = [
    info.project,
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
        <CopyForGrove link={link} wide />
        <p className="share-landing-hint">Then paste it into ⌘K in Grove.</p>
        <div className="share-landing-divider">or</div>
        <form onSubmit={(event) => { event.preventDefault(); void join(); }} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Your name
            <input className="oui-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" required />
          </label>
          {error && <p className="share-notice is-error" role="alert">{error}</p>}
          <button type="submit" className="oui-btn oui-btn-secondary" disabled={busy || !name.trim()}>{busy ? "Opening…" : "View in browser"}</button>
        </form>
      </div>
    </div>
  );
}
