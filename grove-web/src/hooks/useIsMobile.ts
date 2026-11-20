import { createContext, useContext, useState, useEffect } from "react";
import { onFoldChange } from "./useBookFold";

/**
 * Orbit keeps its desktop layout on tablets: only phones get the mobile
 * layout. App provides `true` here while Orbit is on, so every component
 * below sees a tablet as a desktop.
 */
export const TabletAsDesktopContext = createContext(false);

interface DeviceState {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isTouchDevice: boolean;
}

const MOBILE_BREAKPOINT = 860;
const TABLET_BREAKPOINT = 1200;
const COARSE_QUERY = "(pointer: coarse)";

/**
 * Touch or mouse decides the interaction model, never the window's width: a
 * phone, iPhone Duo or iPad keeps touch interactions at any size, and a
 * computer keeps the desktop ones even in a narrow window. The iOS app is
 * always touch.
 */
export function isTouchClient(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as Window & { __GROVE_IOS__?: boolean }).__GROVE_IOS__ === true) return true;
  return typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches;
}

function getDeviceState(): DeviceState {
  const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  if (isTouchClient()) return { isMobile: true, isTablet: false, isDesktop: false, isTouchDevice: true };
  return { isMobile: false, isTablet: false, isDesktop: true, isTouchDevice };
}

export function useIsMobile(): DeviceState {
  const [state, setState] = useState<DeviceState>(getDeviceState);

  useEffect(() => {
    const mobileQuery = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
    );
    const tabletQuery = window.matchMedia(
      `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`
    );

    const update = () => setState((prev) => {
      const next = getDeviceState();
      return prev.isMobile === next.isMobile && prev.isTablet === next.isTablet && prev.isDesktop === next.isDesktop && prev.isTouchDevice === next.isTouchDevice ? prev : next;
    });

    // Turning a phone changes its short side's direction, not only its width.
    const orientationQuery = window.matchMedia("(orientation: portrait)");

    mobileQuery.addEventListener("change", update);
    tabletQuery.addEventListener("change", update);
    orientationQuery.addEventListener("change", update);
    const stopFold = onFoldChange(update);

    return () => {
      mobileQuery.removeEventListener("change", update);
      tabletQuery.removeEventListener("change", update);
      orientationQuery.removeEventListener("change", update);
      stopFold();
    };
  }, []);

  const tabletAsDesktop = useContext(TabletAsDesktopContext);
  return tabletAsDesktop && state.isTablet
    ? { ...state, isMobile: false, isTablet: false, isDesktop: true }
    : state;
}
