import { useState } from "react";
import { AppWindow } from "lucide-react";
import { getAppIconUrl } from "../../api";
import type { AppInfo } from "../../api";
import { useAuthenticatedFileUrl } from "../../hooks/useAuthenticatedFileUrl";

interface AppIconProps {
  app: AppInfo;
  className?: string;
}

export function AppIcon({ app, className = "w-5 h-5" }: AppIconProps) {
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const { url, error } = useAuthenticatedFileUrl(getAppIconUrl(app));

  if (loadState === "error" || error) {
    return (
      <AppWindow
        className={`${className} flex-shrink-0 text-[var(--color-text-muted)]`}
      />
    );
  }

  return (
    <>
      {loadState === "loading" && (
        <div
          className={`${className} flex-shrink-0 rounded-sm bg-[var(--color-bg-tertiary)] animate-pulse`}
        />
      )}
      {url && <img
        src={url}
        alt={`${app.name} icon`}
        className={`${className} flex-shrink-0 rounded-sm object-contain ${loadState === "loading" ? "hidden" : ""}`}
        onLoad={() => setLoadState("loaded")}
        onError={() => setLoadState("error")}
        loading="eager"
      />}
    </>
  );
}
