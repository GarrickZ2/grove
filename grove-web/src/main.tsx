import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installTauriDevtoolsShortcut } from './utils/tauriDevtools'
import { installExternalLinkInterceptor } from './utils/openExternal'

installTauriDevtoolsShortcut()
installExternalLinkInterceptor()

if (import.meta.env.MODE === "perf") {
  void import("./perf").then(({ startPerfMonitor }) => startPerfMonitor())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
