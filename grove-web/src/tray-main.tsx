import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./context";
import { DesktopTrayPopover } from "./components/Tray/DesktopTrayPopover";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <DesktopTrayPopover />
    </ThemeProvider>
  </StrictMode>,
);
