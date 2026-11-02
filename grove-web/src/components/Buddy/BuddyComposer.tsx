import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Paperclip, Plus, Square, X } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { useBuddyComposer } from "../../hooks/useBuddyComposer";
import { errorMessage } from "../../utils/errorMessage";
import { readBuddyPreference, writeBuddyPreference } from "./buddyStorage";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { playTextareaSendOut } from "../Tasks/TaskView/composer/sendOut";

export function BuddyComposer({ buddy, onSent, initialText = "" }: { buddy: Buddy; onSent: () => void; initialText?: string }) {
  const draftKey = `draft-${buddy.id}-${buddy.active_session_id}`;
  const [text, setText] = useState(() => initialText || readBuddyPreference(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const orbit = useOrbitInterface();
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Grow with the draft until the CSS max-height, then scroll inside (re-measured when the interface changes its padding).
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [text, orbit]);
  const { send, stop, sending, connected } = useBuddyComposer(buddy, onSent);
  const hasContent = !!text.trim() || files.length > 0;
  const showStop = buddy.status !== "idle" && !hasContent;
  const changeText = (value: string) => { setText(value); writeBuddyPreference(draftKey, value); };
  const submit = async () => {
    if ((!text.trim() && !files.length) || sending || !connected) return;
    setError(null);
    // Orbit: the typed text leaves the box while the send goes out (visual only).
    const restore = orbit ? playTextareaSendOut(input.current) : () => {};
    try { await send(text.trim(), files); changeText(""); setFiles([]); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { restore(); }
  };
  const cancel = async () => {
    setError(null);
    try { await stop(); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  return <div className="buddy-composer-wrap">
    {files.length > 0 && <ul className="buddy-attachments">{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X size={14} /></button></li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    <form className={orbit ? `buddy-composer is-orbit${buddy.status === "working" ? " is-running" : ""}` : "buddy-composer"} aria-label={`Message ${buddy.name}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!sending) setFiles((current) => [...current, ...Array.from(event.dataTransfer.files)]); }}>
      {orbit && buddy.status === "working" && <span className="buddy-oc-orbit" aria-hidden="true"><i /></span>}
      <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" onChange={(event) => { setFiles((current) => [...current, ...Array.from(event.target.files ?? [])]); event.target.value = ""; }} />
      <textarea ref={input} rows={1} aria-label={`Message ${buddy.name}`} placeholder={`Message ${buddy.name}`} value={text} disabled={sending} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => changeText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
      }} />
      {orbit ? <div className="buddy-composer-toolbar">
        {/* Orbit composer look: a quiet attach tool, the typing hint and one send/stop orb whose icon morphs. */}
        <div className="buddy-oc-tools">
          <button type="button" className="buddy-oc-tool" aria-label="Add attachment" title="Add attachment" disabled={sending} onClick={() => fileInput.current?.click()}><Paperclip /></button>
          {focused && text.trim() && <span className="buddy-oc-hint" aria-live="polite">{"\u23CE send \u00b7 \u21E7\u23CE newline"}</span>}
        </div>
        <button type={showStop ? "button" : "submit"} className="buddy-oc-orb" data-icon={sending ? "spin" : showStop ? "stop" : "arrow"} aria-label={showStop ? "Stop response" : "Send message"} title={showStop ? "Stop response" : "Send (Enter)"} disabled={showStop ? sending || !connected : sending || !connected || !hasContent} onClick={showStop ? () => void cancel() : undefined}>
          <span className="buddy-oc-orb-ic is-arrow"><ArrowUp /></span>
          <span className="buddy-oc-orb-ic is-stop"><Square /></span>
          <span className="buddy-oc-orb-ic is-spin"><Loader2 /></span>
        </button>
      </div> : <div className="buddy-composer-toolbar">
        <button type="button" className="buddy-composer-circle" aria-label="Add attachment" title="Add attachment" disabled={sending} onClick={() => fileInput.current?.click()}><Plus size={18} /></button>
        {showStop ? <button type="button" className="buddy-composer-circle is-primary" aria-label="Stop response" title="Stop response" disabled={sending || !connected} onClick={() => void cancel()}><Square size={12} fill="currentColor" /></button>
          : <button type="submit" className="buddy-composer-circle is-primary" aria-label="Send message" disabled={sending || !connected || !hasContent}><ArrowUp size={17} strokeWidth={2.25} /></button>}
      </div>}
    </form>
  </div>;
}
