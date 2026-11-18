import { createContext, useContext, useState, useEffect } from "react";
import { onFoldChange, readLaptopFold } from "./useBookFold";

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

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1200;
/** A touch screen whose short side is below this is a phone, turned sideways or not. */
const PHONE_SHORT_SIDE = 600;
const COARSE_QUERY = "(hover: none) and (pointer: coarse)";

function isPhoneSideways(width: number): boolean {
  if (width < MOBILE_BREAKPOINT || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COARSE_QUERY).matches && Math.min(width, window.innerHeight) < PHONE_SHORT_SIDE;
}

function getDeviceState(): DeviceState {
  const width = window.innerWidth;
  return {
    // isMobile includes tablet — anything below desktop breakpoint uses mobile layout
    isMobile: width < TABLET_BREAKPOINT,
    // The inner screen folded like a laptop is phone-narrow, but Orbit gives it
    // the desktop layout: that has the panel headers and toolbar it spreads
    // over the two screens.
    // A phone turned sideways is as wide as a tablet but has no height for one.
    isTablet: width < TABLET_BREAKPOINT && ((width >= MOBILE_BREAKPOINT && !isPhoneSideways(width)) || !!readLaptopFold()),
    isDesktop: width >= TABLET_BREAKPOINT,
    isTouchDevice:
      "ontouchstart" in window || navigator.maxTouchPoints > 0,
  };
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
