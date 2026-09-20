import type { VersionResponse } from "../api/version";

/**
 * Select the transient notification owner from the backend capability.
 *
 * The explicit owner is authoritative for new backends. The boolean fallback
 * keeps older Grove servers working while they are being upgraded.
 */
export function clientOwnsNotifications(version: VersionResponse): boolean {
  if (version.notification_owner) {
    return version.notification_owner === "client";
  }
  return version.renders_os_notifications === false;
}

/** `grove web --remote-url` injects this value into the locally-served page. */
export function hasInjectedRemoteBackend(
  globals: Record<string, unknown> | undefined =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as Record<string, unknown>),
): boolean {
  return (
    typeof globals?.__GROVE_API_BASE__ === "string" &&
    globals.__GROVE_API_BASE__.length > 0
  );
}

/**
 * A non-loopback browser is normally viewing `grove mobile` directly. This
 * is used only for user-gesture actions (permission request / sound preview);
 * event routing still honors the backend's explicit owner capability.
 */
export function isLikelyRemoteBrowser(
  hostname: string | undefined =
    typeof window === "undefined" ? undefined : window.location.hostname,
  globals?: Record<string, unknown>,
): boolean {
  if (hasInjectedRemoteBackend(globals)) return true;
  if (!hostname) return false;
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return !["localhost", "127.0.0.1", "::1"].includes(normalized);
}
