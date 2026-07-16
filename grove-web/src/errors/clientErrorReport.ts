export type ClientErrorSource =
  | "react-caught"
  | "react-uncaught"
  | "react-recoverable"
  | "window-error"
  | "unhandled-rejection";

export interface ClientErrorDetails {
  source: ClientErrorSource;
  componentStack?: string;
}

export interface ClientErrorReport {
  timestamp: string;
  source: ClientErrorSource;
  version: string;
  url: string;
  documentTitle: string;
  userAgent: string;
  errorName: string;
  errorMessage: string;
  stack?: string;
  componentStack?: string;
}

let appVersion = "unknown";
let lastFingerprint = "";
let lastReportedAt = 0;

export function setClientAppVersion(version: string): void {
  appVersion = version || "unknown";
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      stack: error.stack,
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: error };
  }
  try {
    return { name: "UnknownError", message: JSON.stringify(error) };
  } catch {
    return { name: "UnknownError", message: String(error) };
  }
}

export function createClientErrorReport(
  error: unknown,
  details: ClientErrorDetails,
): ClientErrorReport {
  const normalized = normalizeError(error);
  return {
    timestamp: new Date().toISOString(),
    source: details.source,
    version: appVersion,
    url: typeof window === "undefined" ? "unknown" : window.location.href,
    documentTitle: typeof document === "undefined" ? "unknown" : document.title,
    userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    errorName: normalized.name,
    errorMessage: normalized.message,
    stack: normalized.stack,
    componentStack: details.componentStack,
  };
}

export function formatClientErrorReport(report: ClientErrorReport): string {
  return [
    "Grove crash report",
    `Time: ${report.timestamp}`,
    `Source: ${report.source}`,
    `Version: ${report.version}`,
    `URL: ${report.url}`,
    `Document: ${report.documentTitle}`,
    `User agent: ${report.userAgent}`,
    `Error: ${report.errorName}: ${report.errorMessage}`,
    "",
    "JavaScript stack:",
    report.stack || "Unavailable",
    "",
    "React component stack:",
    report.componentStack || "Unavailable",
  ].join("\n");
}

export function reportClientError(
  error: unknown,
  details: ClientErrorDetails,
): ClientErrorReport {
  const report = createClientErrorReport(error, details);
  const fingerprint = [
    report.errorName,
    report.errorMessage,
    report.stack,
  ].join("|");
  const now = Date.now();
  const isDuplicate = fingerprint === lastFingerprint && now - lastReportedAt < 1_000;
  if (!isDuplicate) {
    lastFingerprint = fingerprint;
    lastReportedAt = now;
    if (details.source === "react-recoverable") {
      console.warn("[GroveError] React recovered from an error", report);
    } else {
      console.error("[GroveError] Unhandled application error", report);
    }
  }
  return report;
}

export function installGlobalErrorHandlers(): () => void {
  const handleError = (event: ErrorEvent) => {
    reportClientError(event.error ?? event.message, { source: "window-error" });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, { source: "unhandled-rejection" });
  };
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  return () => {
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
