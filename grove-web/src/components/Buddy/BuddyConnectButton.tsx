import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import type { Buddy } from "../../api/buddies";
import { listBuddyConnects } from "../../api/buddyResources";
import { useBuddyResource } from "../../hooks/useBuddyResource";

// The dialog carries the QR authorization flows; load it only when opened.
const ConnectDialog = lazy(() => import("../Config/ConnectSettings").then((module) => ({ default: module.ConnectDialog })));

type Tone = "online" | "pending" | "error" | "off";
const TONE_LABEL: Record<Tone, string> = { online: "connected", pending: "connecting", error: "connection error", off: "paused" };

/** IM Connect for one Buddy: a link icon whose dot summarizes its connections (green, amber, red). */
export function BuddyConnectButton({ buddy }: { buddy: Pick<Buddy, "id" | "name" | "project_hash"> }) {
  const load = useCallback(() => listBuddyConnects(buddy as Buddy), [buddy]);
  const { data, refresh } = useBuddyResource(load);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const has = !!data?.length;
  useEffect(() => {
    if (!has || open) return;
    const timer = window.setInterval(() => { void refresh(); }, 15000);
    return () => window.clearInterval(timer);
  }, [has, open, refresh]);
  const enabled = (data ?? []).filter((item) => item.enabled).map((item) => item.runtime.state);
  const tone: Tone | null = !has ? null : !enabled.length ? "off" : enabled.includes("error") ? "error" : enabled.every((state) => state === "online") ? "online" : "pending";
  const label = tone ? `IM Connect · ${data!.length} ${data!.length === 1 ? "connection" : "connections"}, ${TONE_LABEL[tone]}` : "IM Connect";
  return <>
    <button type="button" className="orbit-icon-button buddy-icon-button buddy-connect-button" aria-label={label} title={label} aria-haspopup="dialog" onClick={() => { setMounted(true); setOpen(true); }}>
      <Link2 />{tone && <span className={`buddy-connect-status is-${tone}`} aria-hidden="true" />}
    </button>
    {mounted && <Suspense fallback={null}><ConnectDialog isOpen={open} onClose={() => { setOpen(false); void refresh(); }} lock={{ buddyId: buddy.id, name: buddy.name }} /></Suspense>}
  </>;
}
