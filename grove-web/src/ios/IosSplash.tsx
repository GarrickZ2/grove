import "./ios-splash.css";

type IosServerMeta = { name?: string | null };

/**
 * The iOS app's one loading screen. The app's own launcher draws the same
 * screen while it reaches the server (grove-ios/launcher/index.html), and the
 * page shows it from its first byte (grove-ios/src/server.rs puts it in #root),
 * so opening Grove reads as one wait, not three. Keep the three in step.
 */
export function IosSplash() {
  const name = (window as Window & { __GROVE_IOS_SERVER__?: IosServerMeta }).__GROVE_IOS_SERVER__?.name || "Grove";
  return (
    <div className="ios-splash" role="status" aria-live="polite">
      <main>
        <a className="ios-splash__pill" href="/_grove/?pick=1">
          <i className="ios-splash__dot" />
          <span>{name}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </a>
        <div className="ios-splash__stage">
          <div className="ios-splash__mark" role="img" aria-label="Grove" />
          <div>
            <div className="ios-splash__bar"><i /></div>
            <p className="ios-splash__label">Connecting to {name}</p>
          </div>
        </div>
      </main>
    </div>
  );
}
