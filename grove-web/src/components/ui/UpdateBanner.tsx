import { X, Download, ExternalLink } from "lucide-react";
import { useState, useEffect } from "react";
import { checkUpdate, type UpdateCheckResponse } from "../../api";

interface UpdateBannerProps {
  onClose?: () => void;
}

export function UpdateBanner({ onClose }: UpdateBannerProps) {
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    // Check if the banner was dismissed in this session
    const dismissed = sessionStorage.getItem("update-banner-dismissed");
    if (dismissed === "true") {
      setIsDismissed(true);
      return;
    }

    // Fetch update info on mount
    checkUpdate()
      .then((info) => {
        setUpdateInfo(info);
        if (info.has_update) {
          setIsVisible(true);

          // Auto-dismiss after 10 seconds
          setTimeout(() => {
            setIsVisible(false);
            setIsDismissed(true);
            sessionStorage.setItem("update-banner-dismissed", "true");
          }, 10000);
        }
      })
      .catch((err) => {
        console.error("Failed to check for updates:", err);
      });
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setIsDismissed(true);
    sessionStorage.setItem("update-banner-dismissed", "true");
    onClose?.();
  };

  const handleViewRelease = () => {
    window.open("https://github.com/GarrickZ2/grove/releases/latest", "_blank");
  };

  const handleCopyCommand = () => {
    const installCommand = "curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh";
    navigator.clipboard.writeText(installCommand);
    // Could add a toast notification here
  };

  if (!isVisible || isDismissed || !updateInfo?.has_update) {
    return null;
  }

  return (
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
            <p className="text-xs font-medium whitespace-nowrap" style={{ color: "var(--color-text)" }}>
              {updateInfo.latest_version} available
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={handleViewRelease}
            className="p-1 rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
            title="View Release"
          >
            <ExternalLink className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
          </button>
          <button
            onClick={handleCopyCommand}
            className="p-1 rounded transition-all hover:bg-[var(--color-bg-tertiary)]"
            title="Copy Install Command"
          >
            <Download className="w-3.5 h-3.5" style={{ color: "var(--color-text-muted)" }} />
          </button>
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
