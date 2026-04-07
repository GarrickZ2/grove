import { useEffect, useState, useCallback } from "react";
import { Radio, X, Copy, Check, Loader2 } from "lucide-react";
import { DialogShell } from "../ui/DialogShell";
import { apiClient } from "../../api/client";

interface RadioConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onGoToSettings?: () => void;
}

interface RadioStartResult {
  url: string;
  port: number;
  token: string;
  host: string;
  qr_svg: string | null;
  error?: string;
  message?: string;
}

type ConnectState = "starting" | "ready" | "error";

export function RadioConnectDialog({ open, onClose, onGoToSettings }: RadioConnectDialogProps) {
  // Render inner content only when open — unmount resets all state naturally
  return (
    <DialogShell isOpen={open} onClose={onClose}>
      {open && (
        <RadioConnectDialogContent onClose={onClose} onGoToSettings={onGoToSettings} />
      )}
    </DialogShell>
  );
}

function RadioConnectDialogContent({
  onClose,
  onGoToSettings,
}: {
  onClose: () => void;
  onGoToSettings?: () => void;
}) {
  const [connectState, setConnectState] = useState<ConnectState>("starting");
  const [radioInfo, setRadioInfo] = useState<RadioStartResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start Radio server on mount
  useEffect(() => {
    let cancelled = false;
    apiClient
      .post<unknown, RadioStartResult>("/api/v1/radio/start")
      .then((info) => {
        if (cancelled) return;
        if (info.error) {
          setError(info.error);
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
  }, []);

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

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden w-[360px]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
            <Radio className="w-5 h-5 text-[var(--color-highlight)]" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text)]">Grove Radio</h2>
            <p className="text-[10px] text-[var(--color-text-muted)]">Walkie-Talkie Mode</p>
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
            <p className="text-sm text-[var(--color-text-muted)]">Starting Radio server...</p>
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
                  onClick={() => {
                    setConnectState("starting");
                    setError(null);
                    apiClient
                      .post<unknown, RadioStartResult>("/api/v1/radio/start")
                      .then((info) => {
                        if (info.error) {
                          setError(info.error);
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
                  }}
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
                {radioInfo.host}:{radioInfo.port}
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
