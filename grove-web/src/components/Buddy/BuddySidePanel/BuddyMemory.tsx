import { useCallback, useMemo, useState } from "react";
import { Maximize2, X } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import { buddyMemorySource, getBuddyMemoryCounts } from "../../../api/buddyResources";
import { useBuddyResource } from "../../../hooks/useBuddyResource";
import { MemoriesTab } from "../../Memory/MemoryBrowser";
import { LogsTab, MemoryPage } from "../../Memory/MemoryPage";
import { DialogShell } from "../../ui/DialogShell";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import { OrbitMemoryPage } from "../../../orbit/memory/OrbitMemoryPage";

export function BuddyMemory({ buddy }: { buddy: Buddy }) {
  const [tab, setTab] = useState<"memories" | "logs">("memories");
  const [revision, setRevision] = useState(0);
  const source = useMemo(() => buddyMemorySource(buddy), [buddy]);
  const load = useCallback(() => getBuddyMemoryCounts(buddy), [buddy]);
  const counts = useBuddyResource(load);
  // The full page (overview, configuration, runs) opens over Buddy; the Buddy's Project never enters the shell.
  const [expanded, setExpanded] = useState(false);
  const orbit = useOrbitInterface();
  const changed = () => { setRevision(value => value + 1); void counts.refresh(); };
  return <section className="buddy-panel-section buddy-memory" aria-label="Memory"><div className="buddy-memory-tabs" role="tablist" aria-label="Memory views"><button type="button" role="tab" aria-selected={tab === "memories"} onClick={() => setTab("memories")}>Memories · {counts.data?.entity_count ?? 0}</button><button type="button" role="tab" aria-selected={tab === "logs"} onClick={() => setTab("logs")}>Logs · {counts.data?.log_count ?? 0}</button></div>
    {counts.error && <p role="alert">{counts.error}<button type="button" onClick={() => void counts.refresh()}>Retry</button></p>}
    {tab === "memories" ? <MemoriesTab compact projectId={buddy.project_hash} source={source} refreshTick={revision} onChanged={changed} /> : <LogsTab compact projectId={buddy.project_hash} source={source} refreshTick={revision} onChanged={changed} />}
    <button type="button" className="buddy-button" onClick={() => setExpanded(true)}><Maximize2 size={14} />Memory settings and runs</button>
    <DialogShell isOpen={expanded} onClose={() => { setExpanded(false); changed(); }} maxWidth="max-w-7xl">
      <div className={orbit ? "buddy-memory-modal is-orbit" : "buddy-memory-modal"}><button type="button" className="buddy-icon-button buddy-memory-modal-close" aria-label="Close Memory" onClick={() => { setExpanded(false); changed(); }}><X /></button>{orbit ? <OrbitMemoryPage projectId={buddy.project_hash} projectName={buddy.name} /> : <MemoryPage projectId={buddy.project_hash} />}</div>
    </DialogShell>
  </section>;
}
