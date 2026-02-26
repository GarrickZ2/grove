import { useState, useEffect, useCallback, type ReactNode } from "react";
import {
  extractSkFromUrl,
  getSecretKey,
  setSecretKey,
  clearSecretKey,
  computeHmac,
} from "../api/client";

interface AuthGateProps {
  children: ReactNode;
}

type AuthState = "loading" | "authenticated" | "needs_auth";

export function AuthGate({ children }: AuthGateProps) {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [skInput, setSkInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  /** Verify the current SK by sending HMAC("grove-verify") to the server. */
  const verifySk = useCallback(async (): Promise<boolean> => {
    const proof = await computeHmac("grove-verify");
    if (!proof) return false;
    try {
      const resp = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      // Step 1: Try to extract SK from URL hash fragment
      const hashSk = extractSkFromUrl();
      if (hashSk) {
        setSecretKey(hashSk);
        // Clear hash from URL (keep path)
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }

      // Step 2: Check if auth is required
      try {
        const resp = await fetch("/api/v1/auth/info");
        if (!resp.ok) {
          // If auth/info fails, assume no auth needed (backwards compat)
          setAuthState("authenticated");
          return;
        }
        const info = await resp.json();
        if (!info.required) {
          setAuthState("authenticated");
          return;
        }
      } catch {
        // Network error — assume no auth needed
        setAuthState("authenticated");
        return;
      }

      // Step 3: Auth is required (HMAC mode). Check if we have a stored SK.
      const storedSk = getSecretKey();
      if (storedSk) {
        // Verify the stored SK
        if (await verifySk()) {
          setAuthState("authenticated");
          return;
        }
        // SK invalid, clear it
        clearSecretKey();
      }

      setAuthState("needs_auth");
    };

    init();
  }, [verifySk]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setVerifying(true);

      try {
        // Temporarily store the SK so computeHmac can use it
        setSecretKey(skInput);
        if (await verifySk()) {
          setAuthState("authenticated");
        } else {
          clearSecretKey();
          setError("Invalid secret key");
        }
      } catch {
        clearSecretKey();
        setError("Connection failed");
      } finally {
        setVerifying(false);
      }
    },
    [skInput, verifySk]
  );

  if (authState === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0a0a]">
        <div className="w-8 h-8 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === "authenticated") {
    return <>{children}</>;
  }

  // SK input page
  return (
    <div className="flex h-screen items-center justify-center bg-[#0a0a0a] p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Grove</h1>
          <p className="text-[#888] text-sm">Enter the secret key to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={skInput}
              onChange={(e) => setSkInput(e.target.value)}
              placeholder="Secret key"
              autoFocus
              className="w-full px-4 py-3 bg-[#1a1a1a] border border-[#333] rounded-lg text-white placeholder-[#666] focus:outline-none focus:border-[#3b82f6] focus:ring-1 focus:ring-[#3b82f6] font-mono text-sm"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={!skInput || verifying}
            className="w-full py-3 bg-[#3b82f6] hover:bg-[#2563eb] disabled:bg-[#333] disabled:text-[#666] text-white rounded-lg font-medium transition-colors text-sm"
          >
            {verifying ? "Verifying..." : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}
