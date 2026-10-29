import "./grove-hero-bg.css";

/**
 * Decorative brand backdrop shared by the Welcome hero and the sign-in page.
 * Fills its nearest positioned ancestor; the host places the focal point by
 * overriding the `--hero-*` variables on `.grove-hero-bg` (see grove-hero-bg.css).
 */
export function GroveHeroBackground() {
  return (
    <div aria-hidden className="grove-hero-bg">
      <div className="grove-hero-bg__dots" />
      <div className="grove-hero-bg__sweep" />
      <div className="grove-hero-bg__glow" />
    </div>
  );
}
