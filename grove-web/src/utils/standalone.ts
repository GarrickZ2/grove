/** True when running as an installed app instead of a browser tab. */
export function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
