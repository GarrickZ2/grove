/**
 * Install Chrome Companion — 2-step wizard.
 *
 * Step 1: "Choose Folder & Install". User picks a directory, backend
 *         unpacks the embedded companion into that path, then launches the
 *         user's default browser on chrome://extensions/ (Chromium browsers
 *         forward to their own protocol automatically).
 *
 *         The directory normally comes from the server's native OS folder
 *         picker. When that picker is merely unavailable (headless host, or
 *         DISPLAY pointing at a dead session) but the browser still shares a
 *         filesystem with Grove, install falls back to the in-app
 *         FolderTreePickerDialog, which browses the SERVER's filesystem.
 *         That fallback is wrong when the browser is on a different machine
 *         from Grove (remote/mobile mode) — a server-side path is
 *         unreachable from the client. In that case, skip the server-side
 *         install entirely and download the packaged extension straight to
 *         the client's browser instead, for manual extract + Load Unpacked.
 *
 * Step 2: "Load Unpacked" — always shows the chosen install path with
 *         click-to-copy and a "Reveal in Finder" button, plus three short
 *         lines explaining the Chrome flow. Footer reflects connection
 *         status independently — no main-content swap on connect, so the
 *         user can always see where the companion was installed.
 *
 * Backend pieces this depends on:
 *   - GET  /api/v1/extension/browse-install-folder → native folder picker
 *   - POST /api/v1/extension/install               → unpack to user path
 *   - POST /api/v1/extension/open-chrome           → default browser launch
 *   - POST /api/v1/extension/reveal-path           → file manager on dir
 *   - extension WS handshake (drives `useExtensionConnection`)
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  X,
  Puzzle,
  Check,
  Copy,
  FolderOpen,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import {
  installCompanion,
  openChromeExtensions,
  revealCompanionPath,
  browseInstallFolder,
  getExtensionStatus,
  getCompanionDownloadUrl,
} from "../../api/extension";
import { FolderTreePickerDialog } from "../Projects/FolderTreePickerDialog";

interface Props {
  /** Parent should mount with `{open && <InstallExtensionDialog ... />}`.
   *  Wizard state is owned by this component — close + reopen = fresh wizard.
   *  Re-installing is cheap (~30KB overwrite into ~/.grove/extension/). */
  onClose: () => void;
}

type StepKind = 1 | 2;

export function InstallExtensionDialog({ onClose }: Props) {
  const [step, setStep] = useState<StepKind>(1);
  const [installing, setInstalling] = useState(false);
  const [installPath, setInstallPath] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [chromeWarning, setChromeWarning] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  // In-app folder browser, used when the native picker cannot be shown but
  // the browser still shares a filesystem with Grove (same-host headless).
  const [pickerOpen, setPickerOpen] = useState(false);
  // True once the remote-mode download flow has produced a file — Step 2
  // then shows client-side instructions instead of a server install path.
  const [remoteMode, setRemoteMode] = useState(false);
  // Extension connection — fetched on dialog mount only. No polling. If the
  // user plugs in the extension AFTER opening this dialog, closing + reopening
  // the dialog refreshes the badge (the parent conditionally mounts us).
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getExtensionStatus().then((c) => { if (!cancelled) setConnected(c); });
    return () => { cancelled = true; };
  }, []);

  // `window.__GROVE_REMOTE__` is set by AuthGate when `/api/v1/auth/info`
  // reports either `remote: true` or `required: true`.
  const isRemoteMode = (): boolean =>
    (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ === true;

  // Unpack the companion into `dir`, then best-effort launch the user's
  // default browser on chrome://extensions/. All Chromium browsers forward
  // to their own protocol; non-Chromium browsers surface a non-fatal warning
  // so the user can paste the URL by hand.
  const installAt = async (dir: string) => {
    setInstalling(true);
    setInstallError(null);
    setChromeWarning(null);
    try {
      const result = await installCompanion(dir);
      setInstallPath(result.path);
      setStep(2);
      try {
        await openChromeExtensions();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setChromeWarning(msg);
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  // Remote mode: the browser is on a different machine than Grove, so
  // neither the native picker nor the in-app FolderTreePickerDialog (both of
  // which resolve a SERVER-side path) can produce anywhere the client could
  // actually use — `installCompanion()` would unpack the extension onto a
  // filesystem the browser can never load unpacked from. Download the
  // packaged extension straight to the client's own Downloads folder
  // instead; Step 2 then walks through manual extract + Load Unpacked.
  const handleRemoteDownload = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const url = await getCompanionDownloadUrl();
      const link = document.createElement("a");
      link.href = url;
      link.download = "grove-companion.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setRemoteMode(true);
      setStep(2);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleInstall = async () => {
    // Browsing from another machine: the native dialog would open on the
    // server's desktop where the user cannot reach it, and the in-app
    // FolderTreePickerDialog would only resolve a server-side path — go
    // straight to the client-side download instead.
    if (isRemoteMode()) {
      await handleRemoteDownload();
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const picked = await browseInstallFolder();
      if (picked.path) {
        await installAt(picked.path);
        return;
      }
      if (!picked.cancelled) {
        // Native dialog unavailable (headless host, or DISPLAY pointing at a
        // dead session) but the browser still shares Grove's filesystem —
        // open the server-side web picker instead of dead-ending.
        setPickerOpen(true);
      }
      // cancelled === true → user dismissed the native dialog; do nothing.
    } catch (err) {
      console.error("Failed to browse install folder:", err);
      setPickerOpen(true);
    } finally {
      setInstalling(false);
    }
  };

  const handleCopyPath = async () => {
    if (!installPath) return;
    try {
      await navigator.clipboard.writeText(installPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Insecure context — the path is visible in plain text below the
      // button, so no-op is acceptable.
    }
  };

  const handleReveal = async () => {
    if (!installPath) return;
    setRevealError(null);
    try {
      await revealCompanionPath(installPath);
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : String(err));
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="relative flex w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <Puzzle className="h-5 w-5 text-[var(--color-highlight)]" />
          <div className="flex-1">
            <div className="text-base font-semibold text-[var(--color-text)]">
              Install Chrome Companion
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {step === 1 ? "One-click install — about 30 seconds" : "Last step: Load Unpacked in Chrome"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3">
          <StepDot id={1} active={step === 1} done={step > 1 || connected} label="Install" />
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          <StepDot id={2} active={step === 2} done={connected} label="Load Unpacked" />
        </div>

        {/* Body */}
        <div className="min-h-[260px] px-5 py-6">
          {step === 1 && (
            <Step1Install
              installing={installing}
              error={installError}
              onInstall={handleInstall}
            />
          )}
          {step === 2 && remoteMode && (
            <Step2RemoteDownload
              downloading={installing}
              error={installError}
              onRedownload={handleRemoteDownload}
            />
          )}
          {step === 2 && !remoteMode && installPath && (
            <Step2LoadUnpacked
              path={installPath}
              connected={connected}
              copied={copied}
              chromeWarning={chromeWarning}
              revealError={revealError}
              onCopy={handleCopyPath}
              onReveal={handleReveal}
              onReopenChrome={async () => {
                setChromeWarning(null);
                try {
                  await openChromeExtensions();
                } catch (err) {
                  setChromeWarning(err instanceof Error ? err.message : String(err));
                }
              }}
            />
          )}
        </div>

        {/* Footer status */}
        <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-5 py-3">
          <div className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${connected ? "animate-pulse" : ""}`}
              style={{
                background: `var(--color-${connected ? "success" : "error"})`,
                boxShadow: `0 0 8px color-mix(in srgb, var(--color-${
                  connected ? "success" : "error"
                }) 50%, transparent)`,
              }}
            />
            <span className="text-xs font-medium text-[var(--color-text)]">
              {connected ? "Companion connected" : "Waiting for companion…"}
            </span>
          </div>
          {connected ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-[var(--color-success)] px-4 py-1.5 text-xs font-semibold text-white hover:brightness-110"
            >
              Done
            </button>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
              Auto-detects on connect
            </span>
          )}
        </div>
      </motion.div>
      {/* The picker portals to document.body, but a portal's events still
          bubble through the React tree. Without this stopPropagation wrapper
          a click on the picker (its backdrop especially) would reach the
          overlay's onClick and close the whole wizard underneath it. */}
      {pickerOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <FolderTreePickerDialog
            isOpen={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelect={(dir) => {
              setPickerOpen(false);
              void installAt(dir);
            }}
            title="Where to install Grove Companion?"
            zIndex={210}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}

function StepDot({
  id,
  active,
  done,
  label,
}: {
  id: number;
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold transition-colors ${
          done
            ? "bg-[var(--color-success)] text-white"
            : active
            ? "bg-[var(--color-highlight)] text-white"
            : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
        }`}
      >
        {done ? <Check className="h-3 w-3" /> : id}
      </div>
      <span
        className={`text-[11px] font-medium ${
          active ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function Step1Install({
  installing,
  error,
  onInstall,
}: {
  installing: boolean;
  error: string | null;
  onInstall: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <FolderOpen className="h-10 w-10 text-[var(--color-highlight)]" />
      <div>
        <div className="text-sm font-semibold text-[var(--color-text)]">
          Choose a parent folder
        </div>
        <div className="mx-auto mt-2 max-w-[340px] text-xs leading-relaxed text-[var(--color-text-muted)]">
          Grove will create a{" "}
          <span className="font-mono text-[var(--color-text)]">grove-companion</span>{" "}
          subfolder inside the folder you pick and unpack the companion
          there — your folder stays clean. Then it launches your default
          browser to{" "}
          <span className="font-mono text-[var(--color-text)]">
            chrome://extensions/
          </span>
          . Pick something visible (e.g. <span className="font-mono text-[var(--color-text)]">~/Documents</span>).
        </div>
      </div>
      <button
        type="button"
        onClick={onInstall}
        disabled={installing}
        className={`inline-flex items-center gap-2 rounded-lg px-6 py-2.5 text-sm font-semibold transition-colors ${
          installing
            ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
            : "bg-[var(--color-highlight)] text-white hover:brightness-110"
        }`}
      >
        {installing ? (
          <>
            <RefreshCw className="h-4 w-4 animate-spin" /> Installing…
          </>
        ) : (
          <>
            <FolderOpen className="h-4 w-4" /> Choose Folder & Install
          </>
        )}
      </button>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

function Step2LoadUnpacked({
  path,
  connected,
  copied,
  chromeWarning,
  revealError,
  onCopy,
  onReveal,
  onReopenChrome,
}: {
  path: string;
  connected: boolean;
  copied: boolean;
  chromeWarning: string | null;
  revealError: string | null;
  onCopy: () => void;
  onReveal: () => void;
  onReopenChrome: () => void;
}) {
  // Always show the install path + instructions, even when connected — the
  // user needs to know where the files went so they can find them again
  // (reload extension, uninstall, debug). Connection status lives in the
  // footer; here we only add a small green inline badge when connected.
  return (
    <div className="flex flex-col gap-4">
      {/* Path block */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Installed at
          </span>
          {connected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-success)]">
              <Check className="h-2.5 w-2.5" /> Loaded in Chrome
            </span>
          )}
        </div>
        <div className="flex items-stretch gap-2">
          <div className="flex flex-1 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 font-mono text-xs text-[var(--color-text)]">
            <span className="truncate">{path}</span>
          </div>
          <button
            type="button"
            onClick={onCopy}
            title="Copy path"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onReveal}
            title="Reveal in file manager"
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Reveal
          </button>
        </div>
        {revealError && <div className="mt-2"><ErrorBanner message={revealError} /></div>}
      </div>

      {/* Instructions */}
      <ol className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-xs">
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            1
          </span>
          <span className="text-[var(--color-text)]">
            In <span className="font-mono font-semibold">chrome://extensions/</span>,
            toggle <span className="font-mono font-semibold">Developer mode</span>{" "}
            (top-right).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            2
          </span>
          <span className="text-[var(--color-text)]">
            Click <span className="font-mono font-semibold">Load unpacked</span>.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            3
          </span>
          <span className="text-[var(--color-text)]">
            Paste the path above (Cmd/Ctrl + Shift + G in macOS file picker).
          </span>
        </li>
      </ol>

      {chromeWarning && (
        <div className="flex flex-col gap-2">
          <ErrorBanner
            message={`Couldn't launch Chrome automatically: ${chromeWarning}`}
          />
          <button
            type="button"
            onClick={onReopenChrome}
            className="self-start text-[11px] text-[var(--color-highlight)] hover:underline"
          >
            Try opening Chrome again
          </button>
        </div>
      )}
    </div>
  );
}

function Step2RemoteDownload({
  downloading,
  error,
  onRedownload,
}: {
  downloading: boolean;
  error: string | null;
  onRedownload: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Check className="h-8 w-8 text-[var(--color-success)]" />
        <div className="text-sm font-semibold text-[var(--color-text)]">
          grove-companion.zip downloaded
        </div>
        <div className="mx-auto max-w-[360px] text-xs leading-relaxed text-[var(--color-text-muted)]">
          Grove and this browser are on different machines, so the extension
          was downloaded to your own Downloads folder instead of installed on
          the server. Extract the zip, then load the extracted folder below.
        </div>
      </div>

      <ol className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 text-xs">
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            1
          </span>
          <span className="text-[var(--color-text)]">
            Extract <span className="font-mono font-semibold">grove-companion.zip</span> anywhere on this computer.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            2
          </span>
          <span className="text-[var(--color-text)]">
            Open a new tab to <span className="font-mono font-semibold">chrome://extensions/</span> and
            toggle <span className="font-mono font-semibold">Developer mode</span> (top-right).
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[10px] font-bold text-[var(--color-text)]">
            3
          </span>
          <span className="text-[var(--color-text)]">
            Click <span className="font-mono font-semibold">Load unpacked</span> and
            select the extracted folder.
          </span>
        </li>
      </ol>

      {error && <ErrorBanner message={error} />}

      <button
        type="button"
        onClick={onRedownload}
        disabled={downloading}
        className="self-center text-[11px] text-[var(--color-highlight)] hover:underline disabled:opacity-50"
      >
        {downloading ? "Downloading…" : "Download again"}
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_8%,transparent)] px-3 py-2 text-left">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-error)]" />
      <span className="text-[11px] leading-relaxed text-[var(--color-text)]">{message}</span>
    </div>
  );
}
