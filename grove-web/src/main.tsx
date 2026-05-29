import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installExternalLinkInterceptor, installGlobalDragDropInterceptor } from './utils/openExternal'
import { commandRegistry, initUserKeymap } from './keyboard'
import { COMMAND_CATALOG } from './keyboard/catalog'

// Inject the static command catalog into the registry before any
// component mounts. Subsequent useDefineCommand / contribute calls add
// runtime entries on top.
commandRegistry.setStaticCatalog(COMMAND_CATALOG)

// Fetch user keymap from server in the background. The dispatcher
// already works against catalog defaults; the override layer takes
// effect as soon as the bundle lands.
void initUserKeymap()

// devtools toggle is now wired via the keyboard catalog (debug.devtools.toggle)
// — see useCommand("debug.devtools.toggle") in App.tsx.
installExternalLinkInterceptor()
installGlobalDragDropInterceptor()

if (import.meta.env.MODE === "perf") {
  void import("./perf").then(({ startPerfMonitor }) => startPerfMonitor())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
