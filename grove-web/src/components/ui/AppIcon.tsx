import { useState } from "react";
import { AppWindow } from "lucide-react";
import { getAppIconUrl } from "../../api";
import type { AppInfo } from "../../api";

interface AppIconProps {
  app: AppInfo;
  className?: string;
}

export function AppIcon({ app, className = "w-5 h-5" }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <AppWindow
        className={`${className} flex-shrink-0 text-[var(--color-text-muted)]`}
      />
    );
  }

  return (
    <img
      src={getAppIconUrl(app)}
      alt={`${app.name} icon`}
      className={`${className} flex-shrink-0 rounded-sm object-contain`}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}
