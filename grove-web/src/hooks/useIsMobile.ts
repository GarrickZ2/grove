import { createContext, useContext, useState, useEffect } from "react";

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
    isTablet: width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT,
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

    const update = () => setState(getDeviceState());

    mobileQuery.addEventListener("change", update);
    tabletQuery.addEventListener("change", update);

    return () => {
      mobileQuery.removeEventListener("change", update);
      tabletQuery.removeEventListener("change", update);
    };
  }, []);

  const tabletAsDesktop = useContext(TabletAsDesktopContext);
  return tabletAsDesktop && state.isTablet
    ? { ...state, isMobile: false, isTablet: false, isDesktop: true }
    : state;
}
