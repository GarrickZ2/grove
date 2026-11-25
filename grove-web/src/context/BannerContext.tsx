import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { PopBanner, type BannerType } from "../components/ui/PopBanner";

interface BannerMessage {
  id: string;
  message: string;
  type: BannerType;
  duration?: number;
}

interface BannerContextType {
  showBanner: (message: string, type?: BannerType, duration?: number) => void;
}

const BannerContext = createContext<BannerContextType | undefined>(undefined);

export function BannerProvider({ children }: { children: ReactNode }) {
  const [banners, setBanners] = useState<BannerMessage[]>([]);

  const showBanner = useCallback((message: string, type: BannerType = "info", duration = 3000) => {
    // crypto.randomUUID is supported in all Tauri webviews (Wry / WebKit / WebView2).
    // Prevents the previous Date.now()-collision issue when several banners fire
    // within the same millisecond (e.g. batch theme imports).
    const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setBanners((prev) => [...prev, { id, message, type, duration }]);
  }, []);

  const removeBanner = useCallback((id: string) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  return (
    <BannerContext.Provider value={{ showBanner }}>
      {children}
      {/* Single fixed anchor for the banner stack; individual PopBanners are
          flow children so they truly stack instead of overlapping on the same
          fixed coordinates. AnimatePresence reads exit props off the direct
          PopBanner (motion.div), so exit animations fire correctly. */}
      <div className="fixed top-[calc(env(safe-area-inset-top)+1rem)] left-1/2 -translate-x-1/2 z-[10001] flex flex-col items-center gap-2 pointer-events-none">
        <AnimatePresence>
          {banners.map((b) => (
            <PopBanner
              key={b.id}
              message={b.message}
              type={b.type}
              duration={b.duration}
              onClose={() => removeBanner(b.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </BannerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBanner() {
  const context = useContext(BannerContext);
  if (!context) {
    throw new Error("useBanner must be used within a BannerProvider");
  }
  return context;
}
