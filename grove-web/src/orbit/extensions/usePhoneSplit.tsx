import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Button } from "../ui";

/**
 * Master / detail on a phone: the list first, then the picked item on its
 * own with Back. `split` is the Card class; desktop keeps both side by side.
 */
export function usePhoneSplit(startOpen = false) {
  const { isMobile, isTablet } = useIsMobile();
  const phone = isMobile && !isTablet;
  const [open, setOpen] = useState(startOpen);
  return {
    phone,
    open: () => setOpen(true),
    split: `oex-split${phone ? (open ? " is-phone-detail" : " is-phone-list") : ""}`,
    back: (label: string) => (phone && open ? (
      <div className="oex-phone-back">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}><ChevronLeft />{label}</Button>
      </div>
    ) : null),
  };
}
