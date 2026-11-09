import { isIosClient } from "./utils/platform"
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installExternalLinkInterceptor, installGlobalDragDropInterceptor } from './utils/openExternal'
import { commandRegistry, initUserKeymap } from './keyboard'
import { COMMAND_CATALOG } from './keyboard/catalog'
import { getVersion } from './api/version'
import { GlobalErrorBoundary } from './errors/GlobalErrorBoundary'
import {
  installGlobalErrorHandlers,
  reportClientError,
  setClientAppVersion,
} from './errors/clientErrorReport'

if (isIosClient) {
  document.documentElement.dataset.groveIos = 'true'

}

// On a touch screen the layout already fits the screen (and each half of a
// fold), so a pinch only scrambles it. iOS ignores user-scalable=no in the
// viewport tag; its gesture events are what start the zoom.
if (window.matchMedia?.('(pointer: coarse)').matches) {
  for (const type of ['gesturestart', 'gesturechange']) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
  }
}

installGlobalErrorHandlers()
void getVersion()
  .then(({ version }) => setClientAppVersion(version))
  .catch(() => {})

// Inject the static command catalog into the registry before any
// component mounts. Subsequent useDefineCommand / contribute calls add
// runtime entries on top.
commandRegistry.setStaticCatalog(COMMAND_CATALOG)

// Fetch user keymap from server in the background. The dispatcher
// already works against catalog defaults; the override layer takes
// effect as soon as the bundle lands.
// A share link opened in a browser has no Grove session to read a keymap from.
if (!/^\/s\//.test(window.location.pathname)) void initUserKeymap()

// devtools toggle is now wired via the keyboard catalog (debug.devtools.toggle)
// — see useCommand("debug.devtools.toggle") in App.tsx.
installExternalLinkInterceptor()
installGlobalDragDropInterceptor()

if (!isIosClient && typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[main] service worker registration failed", err);
    });
  });
}

if (import.meta.env.MODE === "perf") {
  void import("./perf").then(({ startPerfMonitor }) => startPerfMonitor())
}

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, errorInfo) => {
    reportClientError(error, {
      source: 'react-caught',
      componentStack: errorInfo.componentStack,
    })
  },
  onUncaughtError: (error, errorInfo) => {
    reportClientError(error, {
      source: 'react-uncaught',
      componentStack: errorInfo.componentStack,
    })
  },
  onRecoverableError: (error, errorInfo) => {
    reportClientError(error, {
      source: 'react-recoverable',
      componentStack: errorInfo.componentStack,
    })
  },
}).render(
  <GlobalErrorBoundary>
    <StrictMode>
      <App />
    </StrictMode>
  </GlobalErrorBoundary>,
)
