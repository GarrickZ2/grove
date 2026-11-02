import { FirstLaunch } from "./FirstLaunch";
import { FirstTurnHints } from "./FirstTurnHints";

/** App-wide first-run overlays; each gates itself (Orbit, once, persisted). */
export function OrbitFirstRun() {
  return (
    <>
      <FirstLaunch />
      <FirstTurnHints />
    </>
  );
}
