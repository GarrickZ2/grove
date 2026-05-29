import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installTauriDevtoolsShortcut } from './utils/tauriDevtools'
import { installExternalLinkInterceptor, installGlobalDragDropInterceptor } from './utils/openExternal'

installTauriDevtoolsShortcut()
installExternalLinkInterceptor()
installGlobalDragDropInterceptor()

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[main] service worker registration failed", err);
    });
  });
}

if (import.meta.env.MODE === "perf") {
  void import("./perf").then(({ startPerfMonitor }) => startPerfMonitor())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
