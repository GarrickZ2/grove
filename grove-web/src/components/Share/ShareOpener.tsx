import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Button, DialogBody, DialogField, DialogFoot, DialogHead, DialogPanel, OrbitDialogLayer } from "../../orbit/ui";
import {
  addReceivedShare,
  getShareProfile,
  previewShareLink,
  shareErrorCode,
  shareErrorMessage,
  shareErrorOwner,
  updateShareProfile,
  type ShareInfo,
} from "../../api/shares";
import { isTauriShell } from "../../utils/tauriShell";
import { stateMessage, untilText } from "./shareFormat";
import { sharedListChanged } from "./shareEvents";

type Step =
  | { kind: "name"; url: string; info: ShareInfo; suggested: string; device: string; host: string; saved: string | null }
  | { kind: "error"; title: string; body: string };

/** Opens share links. The first link from a Grove it hasn't opened before
 *  asks first (and the first link ever also asks the name other people see);
 *  after that, links from the same Grove go straight to the shared Task. */
export function ShareOpener({ onOpened }: { onOpened: (receivedId: string) => void }) {
  const [step, setStep] = useState<Step | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async (url: string) => {
    const received = await addReceivedShare(url);
    sharedListChanged();
    onOpened(received.id);
  }, [onOpened]);

  const begin = useCallback(async (url: string) => {
    setError(null);
    try {
      const info = await previewShareLink(url);
      if (info.receivedId) {
        onOpened(info.receivedId);
        return;
      }
      const ended = info.state !== "active" ? stateMessage(info.state, info.owner) : null;
      if (ended) {
        setStep({ kind: "error", ...ended });
        return;
      }
      const host = new URL(info.url).host;
      const profile = await getShareProfile();
      const knownHost = info.knownHost === true;
      if (profile.name && knownHost) {
        await add(info.url);
        return;
      }
      setName(profile.name ?? profile.suggestedName);
      setStep({ kind: "name", url: info.url, info, suggested: profile.suggestedName, device: profile.device, host, saved: profile.name ?? null });
    } catch (err) {
      const message = stateMessage(shareErrorCode(err), shareErrorOwner(err));
      setStep({ kind: "error", title: message?.title ?? "Couldn't open this link", body: message?.body ?? shareErrorMessage(err) });
    }
  }, [add, onOpened]);

  useEffect(() => {
    const onEvent = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url ?? "";
      if (url) void begin(url);
      else setStep({ kind: "error", title: "No share link to open", body: "Copy a Grove share link first, or paste it into ⌘K." });
    };
    window.addEventListener("grove:open-share", onEvent);
    return () => window.removeEventListener("grove:open-share", onEvent);
  }, [begin]);

  // `grove://open-share?url=…` lands in the desktop shell.
  useEffect(() => {
    if (!isTauriShell) return;
    const take = () => {
      void invoke<string | null>("take_pending_share_link").then((url) => { if (url) void begin(url); }).catch(() => {});
    };
    take();
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("grove:open-share", () => take())
      .then((unlisten) => { if (cancelled) unlisten(); else stop = unlisten; })
      .catch(() => {});
    return () => { cancelled = true; stop?.(); };
  }, [begin]);

  if (!step) return null;
  const close = () => { setStep(null); setError(null); };

  if (step.kind === "error") {
    return (
      <OrbitDialogLayer open onClose={close} label={step.title}>
        <DialogPanel>
          <DialogHead title={step.title} description={step.body} tone="warning" />
          <DialogFoot><Button variant="primary" onClick={close}>OK</Button></DialogFoot>
        </DialogPanel>
      </OrbitDialogLayer>
    );
  }

  const { info } = step;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (name.trim() !== step.saved) await updateShareProfile({ name: name.trim() });
      await add(step.url);
      close();
    } catch (err) {
      setError(shareErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const facts = [
    info.project,
    info.canComment ? "Can comment" : "View only",
    info.expiresAt ? `Expires ${untilText(info.expiresAt)}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <OrbitDialogLayer open onClose={close} label={`Open ${info.owner}'s share`}>
      <DialogPanel onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <DialogHead
          title={`Open ${info.owner}'s share`}
          description={<><b>{info.title}</b>{facts ? ` · ${facts}` : ""}<br />From {step.host}. It's the first link you open from this Grove.</>}
        />
        <DialogBody>
          <DialogField
            label="Your name"
            note={`${info.owner} will see “${name.trim() || step.suggested}${step.device ? ` · ${step.device}` : ""}”. Other shares you open use this name too; change it in Settings › General.`}
          >
            <input className="oui-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus autoComplete="off" />
          </DialogField>
          {error && <p className="share-notice is-error" role="alert">{error}</p>}
        </DialogBody>
        <DialogFoot>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>{busy ? "Opening…" : "Open"}</Button>
        </DialogFoot>
      </DialogPanel>
    </OrbitDialogLayer>
  );
}
