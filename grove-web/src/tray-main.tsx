import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./context";
import { TrayPopover } from "./components/Tray/TrayPopover";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TrayPopover />
    </ThemeProvider>
  </StrictMode>,
);
