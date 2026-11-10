import { useEffect, useState } from "react";
import { getComputerPermissions, type ComputerPermissions } from "../../../api/browser";

export function errorText(cause: unknown): string {
  return (cause as { message?: string } | null)?.message || "That did not work. Try again.";
}

/**
 * macOS permissions Computer Use needs, read again whenever Grove comes back
 * to the front, as after granting them in System Settings.
 */
export function useComputerPermissions(enabled: boolean) {
  const [permissions, setPermissions] = useState<ComputerPermissions | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () => {
      getComputerPermissions()
        .then((next) => {
          if (!current) return;
          setPermissions(next);
          setError("");
        })
        .catch((cause) => {
          if (current) setError(errorText(cause));
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      current = false;
      window.removeEventListener("focus", load);
    };
  }, [enabled]);
  return { permissions, error, setError };
}
