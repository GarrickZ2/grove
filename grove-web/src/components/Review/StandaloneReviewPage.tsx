import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { getConfig } from '../../api/config';
import { useTheme } from '../../context';
import { readCachedOrbit, writeCachedInterface } from '../../orbit/firstrun/storage';
import { OrbitInterfaceContext, OrbitInterfaceKnownContext } from '../../orbit/ui/interfaceContext';
import { PanelShell } from '../../orbit/ui/PanelShell';
import { PANEL_HUES } from '../../orbit/ui/panelSlots';
import { DiffReviewPage } from './DiffReviewPage';

/**
 * The standalone `/review/:project/:task` page. It sits outside the app's
 * providers, so it reads `config.web.interface` itself (as
 * OrbitInterfaceProvider does), starting from the cached choice so it
 * doesn't flash the other look. Orbit frames the review in a PanelShell, so
 * it gets the same Orbit Review UI as the workspace panel; Workbench keeps
 * the legacy full page.
 *
 * Colours come from the app's ThemeProvider (the saved `config.theme`, as in
 * the main app). It starts from the system scheme until that loads, so the
 * review waits until the provider shows the saved mode and themes rather
 * than painting once in the wrong theme (with a short fallback).
 */
const THEME_WAIT_MS = 1500;
export function StandaloneReviewPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [orbit, setOrbit] = useState(readCachedOrbit);
  const [known, setKnown] = useState(false);
  const [expected, setExpected] = useState<{ mode?: string; light?: string; dark?: string } | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    const ac = new AbortController();
    getConfig(ac.signal)
      .then((config) => {
        const next = config.web.interface === 'orbit';
        setOrbit(next);
        setKnown(true);
        setExpected({ mode: config.theme?.mode, light: config.theme?.light_theme, dark: config.theme?.dark_theme });
        writeCachedInterface(next ? 'orbit' : 'workbench');
      })
      .catch(() => {
        // Keep the cached look; the review itself reports its own load errors.
        if (!ac.signal.aborted) setGaveUp(true);
      });
    const timer = setTimeout(() => setGaveUp(true), THEME_WAIT_MS);
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, []);

  const themeApplied = !!expected
    && (!expected.mode || theme.mode === expected.mode)
    && (!expected.light || theme.lightThemeId === expected.light)
    && (!expected.dark || theme.darkThemeId === expected.dark);
  if (!themeApplied && !gaveUp) return <div className="orv-standalone-wait" aria-busy="true" />;

  return (
    <OrbitInterfaceKnownContext.Provider value={known}>
      <OrbitInterfaceContext.Provider value={orbit}>
        {orbit ? (
          <div className="orv-standalone">
            <PanelShell glyph={Eye} hue={PANEL_HUES.violet} title="Code Review" body="fill">
              <DiffReviewPage projectId={projectId} taskId={taskId} embedded />
            </PanelShell>
          </div>
        ) : (
          <DiffReviewPage projectId={projectId} taskId={taskId} />
        )}
      </OrbitInterfaceContext.Provider>
    </OrbitInterfaceKnownContext.Provider>
  );
}
