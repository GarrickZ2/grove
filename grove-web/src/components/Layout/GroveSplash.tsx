import type { ReactNode } from "react";
import { GroveHeroBackground } from "./GroveHeroBackground";
import { GroveIcon } from "./GroveIcon";
import "./grove-splash.css";

/**
 * Full-screen loading state shared by the auth gate and the app shell. It mirrors the
 * sign-in page's layout (same backdrop, same header metrics, and a spacer the height of
 * the sign-in form) so the logo stays put when "Connect" hands off to loading.
 */
export function GroveSplash({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[var(--color-bg)] p-4">
      <GroveHeroBackground />
      <div role="status" aria-live="polite" className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="grove-splash__mark">
            <div aria-hidden className="grove-splash__halo" />
            <GroveIcon size={96} className="grove-splash__icon" />
          </div>
          <p className="grove-splash__fade mt-5 flex h-8 items-center text-sm text-[var(--color-text-muted)]">{label}</p>
          <div aria-hidden className="grove-splash__fade mt-2 flex h-5 items-center" style={{ animationDelay: "0.15s" }}>
            <div className="grove-splash__track">
              <div className="grove-splash__bar" />
            </div>
          </div>
        </div>
        {/* Matches the sign-in form (key input + remember switch + button). */}
        <div className="flex h-[168px] justify-center">{children}</div>
      </div>
    </div>
  );
}
