import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./context";
import { PhoneTrayPanel } from "./components/Tray/PhoneTrayPanel";
import { extractRadioTokenFromUrl, setRadioToken } from "./api/client";

// Extract the session token from the hash before rendering (e.g.
// /phone-tray#token=xxx), then strip it from the URL so a refresh / share
// doesn't leak it.
const token = extractRadioTokenFromUrl();
if (token) {
  setRadioToken(token);
  window.history.replaceState(null, "", window.location.pathname);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <PhoneTrayPanel />
    </ThemeProvider>
  </StrictMode>,
);
