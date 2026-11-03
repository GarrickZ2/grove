import { useEffect, useState, useCallback } from "react";
import { Radio, X, Copy, Check, Loader2, Smartphone } from "lucide-react";
import { DialogShell } from "../ui/DialogShell";
import { apiClient, getApiBaseUrl } from "../../api/client";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { Button as OrbitButton } from "../../orbit/ui/Button";
import { DialogBody, DialogHead, DialogPanel } from "../../orbit/ui/Dialog";

/** Which mobile surface the QR points at. `"radio"` = walkie-talkie (default),
 *  `"tray"` = the menubar task panel (served at /phone-tray). */
type RadioPage = "radio" | "tray";

interface RadioConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onGoToSettings?: () => void;
  page?: RadioPage;
}

interface RadioStartResult {
  url: string;
  /** Absent under `grove mobile`, where the phone uses Grove's own address. */
  port?: number;
  token?: string;
  host: string;
  qr_svg: string | null;
  error?: string;
  message?: string;
}

type ConnectState = "starting" | "ready" | "error";

// Under `grove mobile` the server cannot know its public address (for example
// a Cloudflare Tunnel hostname), so the browser supplies the origin it used.
function startRadio(page: RadioPage) {
  return apiClient.post<{ page: RadioPage; origin: string }, RadioStartResult>(
    "/api/v1/radio/start",
    { page, origin: new URL(getApiBaseUrl() || window.location.origin, window.location.origin).origin },
  );
}

// The settings shortcut keys off the code; other failures show their message.
function startError(info: RadioStartResult) {
  return info.error === "transcribe_not_configured" ? info.error : info.message ?? info.error ?? null;
}

function radioAddress(info: RadioStartResult) {
  return info.port === undefined ? info.host : `${info.host}:${info.port}`;
}

export function RadioConnectDialog({ open, onClose, onGoToSettings, page = "radio" }: RadioConnectDialogProps) {
  // Render inner content only when open — unmount resets all state naturally
  return (
    <DialogShell
      isOpen={open}
      onClose={onClose}
      variant={page === "tray" ? "centered" : "responsive"}
    >
      {open && (
        <RadioConnectDialogContent onClose={onClose} onGoToSettings={onGoToSettings} page={page} />
      )}
    </DialogShell>
  );
}

function RadioConnectDialogContent({
  onClose,
  onGoToSettings,
  page,
}: {
  onClose: () => void;
  onGoToSettings?: () => void;
  page: RadioPage;
}) {
  const isTray = page === "tray";
  const orbit = useOrbitInterface();
  const [connectState, setConnectState] = useState<ConnectState>("starting");
  const [radioInfo, setRadioInfo] = useState<RadioStartResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start Radio server on mount
  useEffect(() => {
    let cancelled = false;
    startRadio(page)
      .then((info) => {
        if (cancelled) return;
        if (info.error) {
          setError(startError(info));
          setConnectState("error");
        } else {
          setRadioInfo(info);
          setConnectState("ready");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err?.message ?? "Failed to start Radio server"));
        setConnectState("error");
      });

    return () => { cancelled = true; };
  }, [page]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleCopy = useCallback(async () => {
    if (!radioInfo) return;
    try {
      await navigator.clipboard.writeText(radioInfo.url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = radioInfo.url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
  }, [radioInfo]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const retry = () => {
    setConnectState("starting");
    setError(null);
    startRadio(page)
      .then((info) => {
        if (info.error) {
          setError(startError(info));
          setConnectState("error");
        } else {
          setRadioInfo(info);
          setConnectState("ready");
        }
      })
      .catch((err) => {
        setError(String(err?.message ?? "Failed"));
        setConnectState("error");
      });
  };

  if (orbit) {
    return (
      <DialogPanel size="sm" className="oui-dlg-radio">
        <DialogHead
          title={isTray ? "Sync to phone" : "Grove Radio"}
          description={isTray ? "Task Panel" : "Walkie-Talkie Mode"}
          aside={<OrbitButton variant="ghost" iconOnly size="sm" aria-label="Close" onClick={handleClose}><X /></OrbitButton>}
        />
        <DialogBody className="oui-dlg-center">
          {connectState === "starting" && (
            <div className="oui-dlg-state">
              <Loader2 className="oui-spin" aria-hidden="true" />
              <p>{isTray ? "Starting server..." : "Starting Radio server..."}</p>
            </div>
          )}
          {connectState === "error" && (
            error === "transcribe_not_configured" ? (
              <div className="oui-dlg-state">
                <span className="oui-dlg-ic is-warning"><Radio aria-hidden="true" /></span>
                <b>Audio transcription not configured</b>
                <p>Radio requires an AI provider for audio transcription. Please configure it in AI settings first.</p>
                <OrbitButton variant="primary" onClick={() => { handleClose(); onGoToSettings?.(); }}>Go to AI Settings</OrbitButton>
              </div>
            ) : (
              <div className="oui-dlg-state">
                <p className="oui-dlg-error" role="alert">{error}</p>
                <OrbitButton variant="secondary" size="sm" onClick={retry}>Retry</OrbitButton>
              </div>
            )
          )}
          {connectState === "ready" && radioInfo && (
            <div className="oui-dlg-state">
              {radioInfo.qr_svg && (
                <div className="oui-dlg-qr" dangerouslySetInnerHTML={{ __html: radioInfo.qr_svg }} />
              )}
              <p>Scan with your phone to connect</p>
              <div className="oui-dlg-flow oui-dlg-host">
                <span className="oui-dot is-ok has-ring" aria-hidden="true" />
                <span className="oui-mono oui-truncate">{radioAddress(radioInfo)}</span>
                <OrbitButton variant="ghost" iconOnly size="sm" onClick={() => void handleCopy()} title="Copy URL" aria-label="Copy URL">
                  {copied ? <Check /> : <Copy />}
                </OrbitButton>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogPanel>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden w-[360px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
            {isTray ? (
              <Smartphone className="w-5 h-5 text-[var(--color-highlight)]" />
            ) : (
              <Radio className="w-5 h-5 text-[var(--color-highlight)]" />
            )}
          </div>
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)]">
              {isTray ? "Sync to Phone" : "Grove Radio"}
            </h2>
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {isTray ? "Task Panel" : "Walkie-Talkie Mode"}
            </p>
          </div>
        </div>
        <button
          onClick={handleClose}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="px-5 py-5">
        {connectState === "starting" && (
          <div className="flex flex-col items-center gap-4 py-10">
            <Loader2 className="w-8 h-8 text-[var(--color-highlight)] animate-spin" />
            <p className="text-sm text-[var(--color-text-muted)]">
              {isTray ? "Starting server..." : "Starting Radio server..."}
            </p>
          </div>
        )}

        {connectState === "error" && (
          <div className="flex flex-col items-center gap-4 py-8">
            {error === "transcribe_not_configured" ? (
              <>
                <div className="w-12 h-12 rounded-full flex items-center justify-center bg-[var(--color-warning)]/10">
                  <Radio className="w-6 h-6 text-[var(--color-warning)]" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-[var(--color-text)] mb-1">Audio Transcription Not Configured</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Radio requires an AI provider for audio transcription. Please configure it in AI settings first.
                  </p>
                </div>
                <button
                  onClick={() => {
                    handleClose();
                    onGoToSettings?.();
                  }}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] border border-[var(--color-highlight)]/30 hover:bg-[var(--color-highlight)]/20 transition-colors"
                >
                  Go to AI Settings
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-[var(--color-error)] text-center">{error}</p>
                <button
                  onClick={retry}
                  className="text-xs text-[var(--color-highlight)] hover:underline"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}

        {connectState === "ready" && radioInfo && (
          <div className="flex flex-col items-center gap-4">
            {/* QR Code */}
            {radioInfo.qr_svg && (
              <div
                className="bg-white rounded-lg p-1 w-3/5 aspect-square [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: radioInfo.qr_svg }}
              />
            )}

            <p className="text-sm text-[var(--color-text-muted)] text-center">
              Scan with your phone to connect
            </p>

            {/* Connection info */}
            <div className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)]">
              <span className="w-2 h-2 rounded-full bg-[var(--color-success)] flex-shrink-0" />
              <span className="text-xs font-mono text-[var(--color-text-muted)] flex-1 truncate">
                {radioAddress(radioInfo)}
              </span>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                title="Copy URL"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[var(--color-success)]" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
