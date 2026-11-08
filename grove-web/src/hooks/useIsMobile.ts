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

function getDeviceState(): DeviceState {
  const width = window.innerWidth;
  return {
    // isMobile includes tablet — anything below desktop breakpoint uses mobile layout
    isMobile: width < TABLET_BREAKPOINT,
    // The inner screen folded like a laptop is phone-narrow, but Orbit gives it
    // the desktop layout: that has the panel headers and toolbar it spreads
    // over the two screens.
    isTablet: width < TABLET_BREAKPOINT && (width >= MOBILE_BREAKPOINT || !!readLaptopFold()),
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

    mobileQuery.addEventListener("change", update);
    tabletQuery.addEventListener("change", update);
    const stopFold = onFoldChange(update);

    return () => {
      mobileQuery.removeEventListener("change", update);
      tabletQuery.removeEventListener("change", update);
      stopFold();
    };
  }, []);

  const tabletAsDesktop = useContext(TabletAsDesktopContext);
  return tabletAsDesktop && state.isTablet
    ? { ...state, isMobile: false, isTablet: false, isDesktop: true }
    : state;
}
