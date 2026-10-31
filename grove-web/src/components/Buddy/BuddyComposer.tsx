import { useRef, useState } from "react";
import { Plus, Send, Square, X } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { useBuddyComposer } from "../../hooks/useBuddyComposer";
import { errorMessage } from "../../utils/errorMessage";
import { readBuddyPreference, writeBuddyPreference } from "./buddyStorage";

export function BuddyComposer({ buddy, onSent, initialText = "" }: { buddy: Buddy; onSent: () => void; initialText?: string }) {
  const draftKey = `draft-${buddy.id}-${buddy.active_session_id}`;
  const [text, setText] = useState(() => initialText || readBuddyPreference(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { send, stop, sending, connected } = useBuddyComposer(buddy, onSent);
  const hasContent = !!text.trim() || files.length > 0;
  const showStop = buddy.status !== "idle" && !hasContent;
  const changeText = (value: string) => { setText(value); writeBuddyPreference(draftKey, value); };
  const submit = async () => {
    if ((!text.trim() && !files.length) || sending || !connected) return;
    setError(null);
    try { await send(text.trim(), files); changeText(""); setFiles([]); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  const cancel = async () => {
    setError(null);
    try { await stop(); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  return <div className="buddy-composer-wrap">
    {files.length > 0 && <ul className="buddy-attachments">{files.map((file, index) => <li key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X size={14} /></button></li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    <form className="buddy-composer" aria-label={`Message ${buddy.name}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!sending) setFiles((current) => [...current, ...Array.from(event.dataTransfer.files)]); }}>
      <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" onChange={(event) => { setFiles((current) => [...current, ...Array.from(event.target.files ?? [])]); event.target.value = ""; }} />
      <button type="button" className="buddy-composer-circle" aria-label="Add attachment" disabled={sending} onClick={() => fileInput.current?.click()}><Plus size={18} /></button>
      <textarea rows={1} aria-label={`Message ${buddy.name}`} placeholder={`Message ${buddy.name}`} value={text} disabled={sending} onChange={(event) => changeText(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
      }} />

      {showStop ? <button type="button" className="buddy-composer-circle is-primary" aria-label="Stop response" title="Stop response" disabled={sending || !connected} onClick={() => void cancel()}><Square size={16} /></button>
        : <button type="submit" className="buddy-composer-circle is-primary" aria-label="Send message" disabled={sending || !connected || !hasContent}><Send size={17} /></button>}
    </form>
  </div>;
}
