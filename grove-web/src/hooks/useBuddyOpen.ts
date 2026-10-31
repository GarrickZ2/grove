import { useCallback, useEffect, useState } from "react";
import { readBuddyPreference, writeBuddyPreference } from "../components/Buddy/buddyStorage";

export function useBuddyOpen() {
  const [open, setOpen] = useState(() => readBuddyPreference("open") === "true");
  useEffect(() => writeBuddyPreference("open", String(open)), [open]);
  return { open, enter: useCallback(() => setOpen(true), []), exit: useCallback(() => setOpen(false), []) };
}
