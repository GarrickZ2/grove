import { isIosClient } from "../../utils/platform";

/**
 * The macOS desktop window draws its traffic lights over the top-left corner
 * of the page. A narrowed window gets the phone layout, so full-screen phone
 * surfaces (sheets, the palette, first run) inset their top-left by this.
 */
export const hasMacWindowControls = !isIosClient && typeof window !== "undefined"
  && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  && /Mac/i.test(navigator.platform || "");
