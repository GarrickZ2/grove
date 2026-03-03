import { X, Download, ExternalLink, RefreshCw } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import {
  checkUpdate,
  startAppUpdate,
  getAppUpdateProgress,
  installAppUpdate,
  type UpdateCheckResponse,
  type AppUpdateProgress,
} from "../../api";
import { DialogShell } from "./DialogShell";

interface UpdateBannerProps {
  onClose?: () => void;
}

export function UpdateBanner({ onClose }: UpdateBannerProps) {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateProgress | null>(null);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  useEffect(() => {
    const dismissed = sessionStorage.getItem("update-banner-dismissed");
    if (dismissed === "true") {
      setIsDismissed(true);
      return;
    }

    checkUpdate()
      .then((info) => {
        setUpdateInfo(info);
        if (info.has_update) {
          setIsVisible(true);

          // Auto-dismiss after 10 seconds for CLI mode only
          if (info.install_method !== "AppBundle") {
            setTimeout(() => {
              setIsVisible(false);
              setIsDismissed(true);
              sessionStorage.setItem("update-banner-dismissed", "true");
            }, 10000);
          }
        }
      })
      .catch((err) => {
        console.error("Failed to check for updates:", err);
      });

    return () => stopPolling();
  }, []);

  const handleDismiss = () => {
    stopPolling();
    setIsVisible(false);
    setIsDismissed(true);
    sessionStorage.setItem("update-banner-dismissed", "true");
    onClose?.();
  };

  // ── CLI mode handlers ────────────────────────────────────────────────────

  const handleViewRelease = () => {
    window.open("https://github.com/GarrickZ2/grove/releases/latest", "_blank");
  };

  const handleCopyCommand = () => {
    const installCommand =
      "curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh";
    navigator.clipboard.writeText(installCommand);
  };

  // ── AppBundle mode handlers ──────────────────────────────────────────────

  const handleStartUpdate = async () => {
    try {
      await startAppUpdate();
      setDownloadProgress({ stage: "downloading", downloaded: 0, total: 0, version: null, error: null });

      pollIntervalRef.current = setInterval(async () => {
        try {
          const progress = await getAppUpdateProgress();
          setDownloadProgress(progress);
          if (progress.stage === "ready" || progress.stage === "error") {
            stopPolling();
            if (progress.stage === "ready") {
              setShowRestartDialog(true);
            }
          }
        } catch {
          // ignore transient errors
        }
      }, 500);
    } catch (err) {
      console.error("Failed to start update:", err);
    }
  };

  const handleRestartNow = async () => {
    setShowRestartDialog(false);
    try {
      await installAppUpdate();
    } catch {
      // The process will exit, connection will drop — ignore errors
    }
  };

  const handleRestartLater = () => {
    setShowRestartDialog(false);
  };

  // ─────────────────────────────────────────────────────────────────────────

  if (!isVisible || isDismissed || !updateInfo?.has_update) {
    return null;
  }

  const isAppBundle = updateInfo.install_method === "AppBundle";
  const isDownloading = downloadProgress?.stage === "downloading";
  const isReady = downloadProgress?.stage === "ready";
  const hasError = downloadProgress?.stage === "error";

  const formatBytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);

  return (
    <>
      <div
        className="fixed top-2 left-1/2 -translate-x-1/2 z-50 shadow-lg rounded-lg animate-[slideDown_0.3s_ease-out]"
        style={{
          backgroundColor: "var(--color-bg-secondary)",
          border: "1px solid var(--color-highlight)",
        }}
      >
        <div className="px-3 py-2 flex items-center justify-between gap-3">
          {/* Icon + Message */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Download
              className="w-3.5 h-3.5 flex-shrink-0"
              style={{ color: "var(--color-highlight)" }}
            />
            <div className="flex-1 min-w-0">
              <p
                className="text-xs font-medium whitespace-nowrap"
                style={{ color: "var(--color-text)" }}
              >
                {updateInfo.latest_version} available
              </p>
              {/* Download progress indicator */}
              {isDownloading && downloadProgress && (
                <p
                  className="text-xs mt-0.5"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {downloadProgress.total > 0
                    ? `${formatBytes(downloadProgress.downloaded)} / ${formatBytes(downloadProgress.total)} MB`
                    : "Downloading…"}
                </p>
              )}
              {isReady && (
                <p className="text-xs mt-0.5" style={{ color: "var(--color-highlight)" }}>
                  Ready to install
                </p>
              )}
              {hasError && (
                <p className="text-xs mt-0.5" style={{ color: "var(--color-error, #f87171)" }}>
                  {downloadProgress?.error ?? "Download failed"}
                </p>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isAppBundle ? (
              /* AppBundle: in-app update flow */
              <>
                {!isDownloading && !isReady && (
                  <button
                    onClick={handleStartUpdate}
                    className="px-2 py-0.5 text-xs rounded font-medium transition-all hover:opacity-80"
                    style={{
                      backgroundColor: "var(--color-highlight)",
                      color: "var(--color-bg-primary, #1a1a1a)",
                    }}
                    title="Download and install update"
                  >
                    Update
                  </button>
                )}
                {isDownloading && (
                  <RefreshCw
                    className="w-3.5 h-3.5 animate-spin"
                    style={{ color: "var(--color-text-muted)" }}
                  />
                )}
                {isReady && (
                  <button
                    onClick={() => setShowRestartDialog(true)}
                    className="px-2 py-0.5 text-xs rounded font-medium transition-all hover:opacity-80"
                    style={{
                      backgroundColor: "var(--color-highlight)",
                      color: "var(--color-bg-primary, #1a1a1a)",
                    }}
                    title="Restart to apply update"
                  >
                    Restart
                  </button>
                )}
              </>
            ) : (
              /* CLI mode: open release page + copy install command */
              <>
                <button
                  onClick={handleViewRelease}
                  className="p-1 rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
                  title="View Release"
                >
                  <ExternalLink
                    className="w-3.5 h-3.5"
                    style={{ color: "var(--color-text-muted)" }}
                  />
                </button>
                <button
                  onClick={handleCopyCommand}
                  className="p-1 rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
                  title="Copy Install Command"
                >
                  <Download
                    className="w-3.5 h-3.5"
                    style={{ color: "var(--color-text-muted)" }}
                  />
                </button>
              </>
            )}
            <button
              onClick={handleDismiss}
              className="p-1 rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
            </button>
          </div>
        </div>
      </div>

      {/* Restart confirmation dialog (AppBundle mode) */}
      <DialogShell
        isOpen={showRestartDialog}
        onClose={handleRestartLater}
        maxWidth="max-w-sm"
      >
        <div className="p-5">
          <h3
            className="text-sm font-semibold mb-2"
            style={{ color: "var(--color-text)" }}
          >
            Restart Now?
          </h3>
          <p
            className="text-xs mb-4"
            style={{ color: "var(--color-text-muted)" }}
          >
            Grove {downloadProgress?.version ?? updateInfo.latest_version} has been downloaded.
            Restart the app to apply the update.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={handleRestartLater}
              className="px-3 py-1.5 text-xs rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
              style={{ color: "var(--color-text-muted)" }}
            >
              Later
            </button>
            <button
              onClick={handleRestartNow}
              className="px-3 py-1.5 text-xs rounded font-medium transition-all hover:opacity-80"
              style={{
                backgroundColor: "var(--color-highlight)",
                color: "var(--color-bg-primary, #1a1a1a)",
              }}
            >
              Restart Now
            </button>
          </div>
        </div>
      </DialogShell>
    </>
  );
}

// Animation keyframes (add to global CSS or use Tailwind config)
// @keyframes slideDown {
//   from {
//     transform: translateY(-100%);
//     opacity: 0;
//   }
//   to {
//     transform: translateY(0);
//     opacity: 1;
//   }
// }
