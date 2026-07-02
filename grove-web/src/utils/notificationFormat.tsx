import { Info, AlertTriangle, AlertCircle } from "lucide-react";

export function formatTimeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1d ago";
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

export function getLevelIcon(level: string) {
  switch (level) {
    case "critical":
      return <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-error)" }} />;
    case "warn":
      return <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-warning)" }} />;
    default:
      return <Info className="w-4 h-4 flex-shrink-0" style={{ color: "var(--color-info)" }} />;
  }
}
