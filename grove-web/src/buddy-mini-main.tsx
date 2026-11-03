import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./context";
import { BuddyMini } from "./components/Buddy/mini/BuddyMini";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <BuddyMini />
    </ThemeProvider>
  </StrictMode>,
);
