import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { getApiBaseUrl } from "../../api/client";
import { GroveIcon } from "../../components/Layout/GroveIcon";
import "../tokens.css";
import "./auth.css";

/**
 * Orbit sign-in and loading share one frame: the logo sits at the same spot
 * in both, so "Connect" hands off to loading (and loading to the app) without
 * the logo moving.
 */
function OrbitAuthFrame({ loading = false, children }: { loading?: boolean; children: ReactNode }) {
  return (
    <div className="orbit-ui oas">
      <div className="oas-backdrop" aria-hidden="true" />
      <div className="oas-card">
        <div className={`oas-mark${loading ? " is-loading" : ""}`}>
          <GroveIcon size={84} />
        </div>
        {children}
      </div>
    </div>
  );
}

/** Orbit's full-screen loading state (connecting, loading the workspace). */
export function OrbitSplash({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <OrbitAuthFrame loading>
      <div role="status" aria-live="polite" className="oas-swap">
        <p className="oas-loading-label">{label}</p>
        <div className="oas-bar" aria-hidden="true"><i /></div>
        {children ? <div className="oas-foot">{children}</div> : null}
      </div>
    </OrbitAuthFrame>
  );
}

const SHAKE: Keyframe[] = [0, -1, 3, -6, 6, -6, 6, -6, 3, -1, 0].map((x) => ({ transform: `translateX(${x}px)` }));

function serverLabel(): string {
  try {
    return new URL(getApiBaseUrl() || window.location.origin, window.location.origin).host;
  } catch {
    return window.location.host;
  }
}

interface OrbitSignInProps {
  /** `form`: ask for the key; `connection_error`: the server could not be reached. */
  mode: "form" | "connection_error";
  secret: string;
  onSecretChange: (value: string) => void;
  /** Show the "Remember this device" switch. */
  showTrust: boolean;
  trusted: boolean;
  onTrustedChange: (value: boolean) => void;
  verifying: boolean;
  /** The key was accepted: the button turns green before loading takes over. */
  succeeded: boolean;
  error: string | null;
  /** Bumped on every rejected attempt, so the field shakes again each time. */
  errorTick: number;
  onSubmit: (event: FormEvent) => void;
  onRetry: () => void;
  /** iOS shell: link back to the server list. */
  switchServerHref?: string;
}

/** Orbit presentation of the sign-in page; AuthGate keeps all the logic. */
export function OrbitSignIn({
  mode, secret, onSecretChange, showTrust, trusted, onTrustedChange, verifying, succeeded,
  error, errorTick, onSubmit, onRetry, switchServerHref,
}: OrbitSignInProps) {
  const [reveal, setReveal] = useState(false);
  const rejected = !!error && !verifying && !succeeded;
  const [host] = useState(serverLabel);
  const fieldRef = useRef<HTMLLabelElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Each rejected attempt shakes the field and puts the caret back in it.
  useEffect(() => {
    if (errorTick === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    fieldRef.current?.animate?.(SHAKE, { duration: 420, easing: "cubic-bezier(.36,.07,.19,.97)" });
  }, [errorTick]);

  return (
    <OrbitAuthFrame>
      <div className="oas-swap">
        <h1 className="oas-title">Welcome back</h1>
        <span className="oas-server"><i aria-hidden="true" />{host}</span>
        {mode === "connection_error" ? (
          <div className="oas-form">
            <p role="alert" className="oas-msg">{error}</p>
            <button type="button" className="oas-go" onClick={onRetry}>Retry connection</button>
          </div>
        ) : (
          <form className="oas-form" onSubmit={onSubmit}>
            <label ref={fieldRef} className={`oas-field${rejected && errorTick > 0 ? " is-bad" : succeeded ? " is-ok" : ""}`}>
              <KeyRound className="oas-field-icon" size={16} aria-hidden="true" />
              <input
                ref={inputRef}
                type={reveal ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                value={secret}
                onChange={(event) => onSecretChange(event.target.value)}
                placeholder="Secret key"
                aria-label="Secret key"
                aria-invalid={rejected || undefined}
                readOnly={succeeded}
                autoFocus
              />
              <button type="button" className="oas-eye" aria-label={reveal ? "Hide key" : "Show key"} onClick={() => setReveal(!reveal)}>
                {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </label>
            {rejected
              ? <p role="alert" className="oas-msg is-bad">{error}</p>
              : <p className="oas-msg">Enter the secret key to continue</p>}
            {showTrust && (
              // Native checkbox (as a switch) inside a label, so the whole row toggles it.
              <label className="oas-remember">
                <span>Remember this device</span>
                <input type="checkbox" role="switch" checked={trusted} disabled={succeeded} onChange={(event) => onTrustedChange(event.target.checked)} className="oas-remember-input" />
                <span aria-hidden="true" className="oas-tg"><span /></span>
              </label>
            )}
            <button type="submit" className={`oas-go${succeeded ? " is-ok" : ""}`} disabled={!secret || verifying || succeeded} aria-live="polite">
              {succeeded ? (
                <><Check className="oas-go-check" size={15} strokeWidth={2.6} aria-hidden="true" />Connected</>
              ) : verifying ? (
                <><Loader2 className="oas-spin" size={15} aria-hidden="true" />Checking…</>
              ) : "Connect"}
            </button>
          </form>
        )}
        {switchServerHref && <a href={switchServerHref} className="oas-link">Switch or add server</a>}
      </div>
    </OrbitAuthFrame>
  );
}
