import { useCallback, useMemo, useState } from "react";
import type { Buddy } from "../../../api/buddies";
import { buddyMemorySource, getBuddyMemoryCounts } from "../../../api/buddyResources";
import { useBuddyResource } from "../../../hooks/useBuddyResource";
import { MemoriesTab } from "../../Memory/MemoryBrowser";
import { LogsTab } from "../../Memory/MemoryPage";

export function BuddyMemory({ buddy }: { buddy: Buddy }) {
  const [tab, setTab] = useState<"memories" | "logs">("memories");
  const [revision, setRevision] = useState(0);
  const source = useMemo(() => buddyMemorySource(buddy), [buddy]);
  const load = useCallback(() => getBuddyMemoryCounts(buddy), [buddy]);
  const counts = useBuddyResource(load);
  const changed = () => { setRevision(value => value + 1); void counts.refresh(); };
  return <section className="buddy-panel-section buddy-memory" aria-label="Memory"><div className="buddy-memory-tabs" role="tablist" aria-label="Memory views"><button type="button" role="tab" aria-selected={tab === "memories"} onClick={() => setTab("memories")}>Memories · {counts.data?.entity_count ?? 0}</button><button type="button" role="tab" aria-selected={tab === "logs"} onClick={() => setTab("logs")}>Logs · {counts.data?.log_count ?? 0}</button></div>
    {counts.error && <p role="alert">{counts.error}<button type="button" onClick={() => void counts.refresh()}>Retry</button></p>}
    {tab === "memories" ? <MemoriesTab compact projectId={buddy.project_hash} source={source} refreshTick={revision} onChanged={changed} /> : <LogsTab compact projectId={buddy.project_hash} source={source} refreshTick={revision} onChanged={changed} />}
  </section>;
}
