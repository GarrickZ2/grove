import { useEffect, useState } from 'react';
import { signInToIosServer, thisIosServer } from './servers';
import { SIGN_IN_EVENT } from './signInWatch';
import './ios-sign-in-notice.css';

/** The session at the server's front door ran out: sign in again without leaving the page. */
export function IosSignInNotice() {
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const show = () => setNeeded(true);
    window.addEventListener(SIGN_IN_EVENT, show);
    return () => window.removeEventListener(SIGN_IN_EVENT, show);
  }, []);
  if (!needed) return null;
  const { name, server } = thisIosServer();
  const signIn = async () => {
    setBusy(true);
    try {
      await signInToIosServer(server);
      setNeeded(false);
      // The same as coming back to the app: everything reconnects.
      window.dispatchEvent(new Event('grove:transport-ready'));
      window.dispatchEvent(new Event('online'));
    } catch { /* closed: the notice stays */ } finally { setBusy(false); }
  };
  return (
    <div className="ios-sign-in-notice" role="alert">
      <span>Sign in to {name} again</span>
      <button type="button" disabled={busy} onClick={() => { void signIn(); }}>Sign in</button>
    </div>
  );
}
