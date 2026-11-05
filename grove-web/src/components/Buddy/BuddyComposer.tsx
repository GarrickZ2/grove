import { useCallback, useLayoutEffect, useRef, useState, type ClipboardEvent } from "react";
import { ArrowUp, File as FileIcon, Loader2, Paperclip, Plus, Square, X } from "lucide-react";
import type { BuddySummary } from "../../api/buddies";
import { BuddyAvatar } from "./BuddyAvatar";
import { EVERYONE_ID, mentionAtCaret, mentionCandidates, mentionRuns, withMentions } from "./buddyMentions";
import type { PromptCapabilities } from "../../api/buddySessionConnection";
import { useBuddyComposer, type ComposerTarget } from "../../hooks/useBuddyComposer";
import { errorMessage } from "../../utils/errorMessage";
import { readBuddyPreference, writeBuddyPreference } from "./buddyStorage";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { playTextareaSendOut } from "../Tasks/TaskView/composer/sendOut";

/** Pasted text longer than this becomes an attachment instead of filling the box. */
const LONG_PASTE_CHARS = 10 * 1024;

/** Files a paste carries: Finder copies expose `files`; screenshots often only a file item. */
function pastedFiles(event: ClipboardEvent): File[] {
  const files = Array.from(event.clipboardData.files);
  if (files.length) return files;
  return Array.from(event.clipboardData.items).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

/** Thumbnail for a picked image; the blob URL lives exactly as long as the <img>. */
function ImageThumb({ file }: { file: File }) {
  const attach = useCallback((element: HTMLImageElement | null) => {
    if (!element) return;
    const url = URL.createObjectURL(file);
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <img ref={attach} alt="" className="buddy-attachment-thumb" />;
}

/** Keeps the mention highlights exactly over the text they mark; a textarea can't style its own text. */
function alignMirror(source: HTMLTextAreaElement, mirror: HTMLElement | null) {
  if (!mirror) return;
  const style = window.getComputedStyle(source);
  for (const property of ["font", "letterSpacing", "lineHeight", "padding", "borderWidth"] as const) mirror.style[property] = style[property];
  mirror.style.left = `${source.offsetLeft}px`;
  mirror.style.top = `${source.offsetTop}px`;
  mirror.style.width = `${source.offsetWidth}px`;
  mirror.style.height = `${source.offsetHeight}px`;
  mirror.scrollTop = source.scrollTop;
}

export function BuddyComposer({ buddy, onSent, initialText = "", promptCaps, mentionable = [], transport }: { buddy: ComposerTarget; onSent: () => void; initialText?: string; promptCaps?: PromptCapabilities | null;
  /** Other Buddies the user can @-mention; the message then tells this Buddy who they are. */
  mentionable?: BuddySummary[];
  /** Sends somewhere other than the Buddy's Session; the text goes as typed. */
  transport?: ReturnType<typeof useBuddyComposer> }) {
  const draftKey = `draft-${buddy.id}-${buddy.active_session_id}`;
  const [text, setText] = useState(() => initialText || readBuddyPreference(draftKey));
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const orbit = useOrbitInterface();
  const [focused, setFocused] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  // Grow with the draft until the CSS max-height, then scroll inside (re-measured when the interface changes its padding).
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // scrollHeight leaves out borders; add them back so a bordered field does not scroll by a pixel or two.
    const fit = () => { element.style.height = "auto"; element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`; alignMirror(element, mirror.current); };
    fit();
    // Re-measure when the width changes (a window still settling its size would otherwise leave it tall).
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; fit(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, orbit]);
  const session = useBuddyComposer(buddy, onSent, promptCaps);
  const { send, stop, sending, connected } = transport ?? session;
  const addFiles = (added: File[]) => { if (added.length) setFiles((current) => [...current, ...added]); };
  const paste = (event: ClipboardEvent) => {
    const pasted = pastedFiles(event);
    if (pasted.length) {
      // Keep the file, not the filename text a Finder copy also carries.
      event.preventDefault();
      if (!sending) addFiles(pasted);
      return;
    }
    // Long pastes (logs, documents) go as a .txt file, as in TaskChat.
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText.length > LONG_PASTE_CHARS) {
      event.preventDefault();
      if (!sending) addFiles([new File([pastedText], `pasted-text-${Date.now()}.txt`, { type: "text/plain" })]);
    }
  };
  const hasContent = !!text.trim() || files.length > 0;
  const showStop = buddy.status !== "idle" && !hasContent;
  const changeText = (value: string) => { setText(value); writeBuddyPreference(draftKey, value); };
  // The @-mention picker: open while the caret follows "@query" and some Buddy matches.
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const candidates = mention && mentionable.length ? mentionCandidates(mentionable, mention.query) : [];
  const picking = candidates.length > 0;
  const trackMention = (element: HTMLTextAreaElement) => {
    const found = mentionAtCaret(element.value, element.selectionStart ?? element.value.length);
    setMention((current) => found ? { ...found, index: current && current.start === found.start ? current.index : 0 } : null);
  };
  const pick = (target: BuddySummary) => {
    const element = input.current;
    if (!mention || !element) return;
    const caret = element.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${target.name} ${text.slice(caret)}`;
    const at = mention.start + target.name.length + 2;
    changeText(next); setMention(null);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(at, at); });
  };
  const submit = async () => {
    if ((!text.trim() && !files.length) || sending || !connected) return;
    setError(null);
    // Orbit: the typed text leaves the box while the send goes out (visual only).
    const restore = orbit ? playTextareaSendOut(input.current) : () => {};
    try { await send(transport ? text.trim() : withMentions(text.trim(), mentionable), files); changeText(""); setFiles([]); setMention(null); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { restore(); }
  };
  const cancel = async () => {
    setError(null);
    try { await stop(); }
    catch (reason) { setError(errorMessage(reason)); }
  };
  return <div className="buddy-composer-wrap">
    {files.length > 0 && <ul className="buddy-attachments">{files.map((file, index) => <li key={`${file.name}-${index}`} className={file.type.startsWith("image/") ? "is-image" : undefined}>{file.type.startsWith("image/") ? <ImageThumb file={file} /> : <FileIcon size={14} aria-hidden="true" />}<span className="buddy-attachment-name">{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={sending} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X size={14} /></button></li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    {picking && <ul className="buddy-mention-menu" role="listbox" aria-label="Mention a Buddy">{candidates.map((candidate, index) => {
      const active = index === Math.min(mention!.index, candidates.length - 1);
      return <li key={candidate.id} role="option" aria-selected={active} className={active ? "is-active" : undefined}
        onMouseDown={(event) => { event.preventDefault(); pick(candidate); }} onMouseEnter={() => setMention((current) => current && { ...current, index })}>
        {candidate.id === EVERYONE_ID ? <span className="buddy-mention-everyone" aria-hidden="true">@</span> : <BuddyAvatar id={candidate.avatar_id ?? candidate.id} avatar={candidate.avatar} size={22} />}<span className="buddy-mention-name">{candidate.name}</span>{(candidate.machine || candidate.role) && <span className="buddy-mention-role">{[candidate.machine, candidate.role].filter(Boolean).join(" · ")}</span>}
      </li>;
    })}</ul>}
    <form className={orbit ? `buddy-composer is-orbit${buddy.status === "working" ? " is-running" : ""}` : "buddy-composer"} aria-label={`Message ${buddy.name}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!sending) addFiles(Array.from(event.dataTransfer.files)); }}>
      {orbit && buddy.status === "working" && <span className="buddy-oc-orbit" aria-hidden="true"><i /></span>}
      <input ref={fileInput} type="file" multiple hidden aria-label="Attach files" onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      <textarea ref={input} rows={1} aria-label={`Message ${buddy.name}`} placeholder={`Message ${buddy.name}`} value={text} disabled={sending} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setMention(null); }} onChange={(event) => { changeText(event.target.value); trackMention(event.target); }} onSelect={(event) => trackMention(event.currentTarget)} onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }} onPaste={paste} onKeyDown={(event) => {
        if (picking && !event.nativeEvent.isComposing) {
          const index = Math.min(mention!.index, candidates.length - 1);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const step = event.key === "ArrowDown" ? 1 : -1; setMention({ ...mention!, index: (index + step + candidates.length) % candidates.length }); return; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(candidates[index]); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
      }} />
      {mentionable.length > 0 && text.includes("@") && <div ref={mirror} className="buddy-composer-mirror" aria-hidden="true">{mentionRuns(text, mentionable).map((run, index) => "buddy" in run ? <mark key={index}>@{run.buddy.name}</mark> : <span key={index}>{run.text}</span>)}<br /></div>}
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
