/** Native recovery must finish before fresh request signatures are generated. */
export async function waitForIosTransport(): Promise<void> {
  if ((window as Window & { __GROVE_TRANSPORT_READY__?: boolean }).__GROVE_TRANSPORT_READY__ !== false) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      window.removeEventListener('grove:transport-ready', ready);
      window.removeEventListener('grove:transport-failed', failed);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('Grove connection recovery failed. Reopen the app to retry.'));
    const timer = setTimeout(failed, 10000);
    window.addEventListener('grove:transport-ready', ready);
    window.addEventListener('grove:transport-failed', failed);
  });
}
