import { useState, useEffect } from "react";

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

  return state;
}
