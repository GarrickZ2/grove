import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { restartBuddyAgent } from "../../../api/buddySessionConnection";
import { exploreExtensions, listMcpInstallations } from "../../../api/extensions";
import type { Buddy } from "../../../api/buddies";
import { BUDDIES_MOCK_ENABLED } from "../../../api/buddies.mock";
import { useBuddyResource } from "../../../hooks/useBuddyResource";
import { errorMessage } from "../../../utils/errorMessage";

interface BuddyMcpServer { key: string; name: string; source: string }

/** Servers this Buddy receives on its next connection: Buddy-bound ones, plus
 *  All-projects ones bound to its current Agent. */
async function loadServers(buddy: Pick<Buddy, "id" | "agent">): Promise<BuddyMcpServer[]> {
  if (BUDDIES_MOCK_ENABLED) return [];
  const [installations, artifacts] = await Promise.all([listMcpInstallations(), exploreExtensions({ kind: "mcp" })]);
  const servers = new Map<string, BuddyMcpServer>();
  for (const item of installations) {
    const source = item.scope === "buddy" && item.agent_id === `buddy:${buddy.id}` ? "Only this Buddy"
      : item.scope === "global" && item.agent_id === buddy.agent ? "All projects" : null;
    const key = `${item.repo_key}/${item.repo_path}`;
    if (!source || servers.get(key)?.source === "Only this Buddy") continue;
    const name = artifacts.find((artifact) => artifact.repo_key === item.repo_key && artifact.repo_path === item.repo_path)?.name ?? item.repo_path;
    servers.set(key, { key, name, source });
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function BuddyMcpServers({ buddy }: { buddy: Buddy }) {
  const { id, agent } = buddy;
  // Status refreshes replace the Buddy object; reload only when bindings can differ.
  const load = useCallback(() => loadServers({ id, agent }), [id, agent]);
  const { data, error } = useBuddyResource(load);
  const [restarting, setRestarting] = useState(false);
  const [restarted, setRestarted] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!restarted) return;
    const timer = window.setTimeout(() => setRestarted(false), 2000);
    return () => window.clearTimeout(timer);
  }, [restarted]);
  const idle = buddy.status === "idle";
  const restart = async () => {
    if (restarting || !idle) return;
    setRestarting(true); setRestarted(false); setFailure(null);
    try { await restartBuddyAgent(buddy); setRestarted(true); }
    catch (reason) { setFailure(errorMessage(reason)); }
    finally { setRestarting(false); }
  };
  return <div className="buddy-settings-group" role="group" aria-labelledby="buddy-settings-tools">
    <div className="buddy-settings-heading">
      <h3 id="buddy-settings-tools" className="buddy-field-label">MCP servers</h3>
      <button type="button" className="buddy-text-button" title={idle ? "Restart the Agent to apply MCP changes. The conversation is kept." : "Stop the current turn first"} disabled={restarting || !idle || BUDDIES_MOCK_ENABLED} onClick={() => void restart()}><RotateCw size={13} className={restarting ? "is-spinning" : undefined} />{restarting ? "Restarting…" : restarted ? "Restarted" : "Restart Agent"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {data?.length === 0 && <p className="buddy-muted">None yet.</p>}
    {!!data?.length && <ul className="buddy-mcp-list">{data.map((server) => <li key={server.key}><span>{server.name}</span>{server.source === "All projects" && <small className="buddy-muted">All projects</small>}</li>)}</ul>}
    {failure && <p role="alert">{failure}</p>}
  </div>;
}
