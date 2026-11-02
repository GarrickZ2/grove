import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { AgentDef } from "../../api";
import { catalogRecordKey, type CatalogRecord } from "../../components/Skills/useExtensionCatalog";
import type { McpBuddyTarget } from "../../components/Skills/useMcpBuddyTargets";
import { Button, Card, EmptyState, SearchField, Segmented, StatusDot } from "../ui";
import {
  KIND_LABEL, KIND_NOUN, accessText, attentionText, filterRecords, groupRecords, resolveSelection,
  splitMcpTargets, versionText, type KindFilter,
} from "./catalogModel";
import { ExtensionDetail, type DetailContext } from "./ExtensionDetail";
import { AgentMark, ExtIcon, type MarkTarget } from "./parts";
import { usePhoneSplit } from "./usePhoneSplit";

interface CatalogViewProps {
  records: CatalogRecord[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  agents: AgentDef[];
  buddies: McpBuddyTarget[];
  context: DetailContext;
  initialSearch: string;
  /** Record to select on mount (e.g. opened from a source). */
  initialSelectedKey?: string | null;
  onAddSource: () => void;
}

const KINDS: KindFilter[] = ["all", "mcp", "skill", "plugin"];
const KIND_TAB: Record<KindFilter, string> = { all: "All", mcp: "MCP", skill: "Skills", plugin: "Plugins" };
const STACK_MAX = 3;

/** Master / detail: grouped list on the left, the selection on the right. */
export function CatalogView({ records, loading, error, onRetry, agents, buddies, context, initialSearch, initialSelectedKey = null, onAddSource }: CatalogViewProps) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState(initialSearch);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialSelectedKey);
  const phoneSplit = usePhoneSplit(initialSelectedKey !== null);

  const visible = useMemo(() => filterRecords(records, kind, search), [records, kind, search]);
  const groups = useMemo(() => groupRecords(visible), [visible]);
  const ordered = useMemo(() => [...groups.attention, ...groups.installed, ...groups.available], [groups]);
  const selected = resolveSelection(ordered, selectedKey, catalogRecordKey);
  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = { all: records.length, mcp: 0, skill: 0, plugin: 0 };
    for (const { item } of records) counts[item.kind] += 1;
    return counts;
  }, [records]);

  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const buddiesById = useMemo(() => new Map(buddies.map((buddy) => [buddy.id, buddy])), [buddies]);
  const agentOptionsById = useMemo(() => new Map(context.agentOptions.map((agent) => [agent.id, agent])), [context.agentOptions]);

  /** Who it's installed for, as marks: Buddies by avatar, agents by icon. */
  const marksFor = ({ item }: CatalogRecord): MarkTarget[] => {
    if (item.kind === "plugin") return [];
    if (item.kind === "skill") {
      return item.installed_agents.map((id) => {
        const agent = agentsById.get(id);
        return { id, name: agent?.display_name ?? id, iconId: agent?.icon_id ?? id };
      });
    }
    const { agents: agentIds, buddies: buddyIds } = splitMcpTargets(item.installed_agents);
    return [
      ...agentIds.map((id) => ({ id, name: agentOptionsById.get(id)?.name ?? id })),
      ...buddyIds.map((id) => {
        const buddy = buddiesById.get(id);
        return { id, name: buddy?.name ?? "Buddy", buddy: { buddyId: buddy?.buddyId ?? id.slice("buddy:".length), avatar: buddy?.avatar ?? null } };
      }),
    ];
  };

  let rowIndex = 0;
  const renderRow = (record: CatalogRecord, attention: boolean) => {
    const { item, plugin } = record;
    const key = catalogRecordKey(record);
    const isSelected = selected ? catalogRecordKey(selected) === key : false;
    const version = versionText(item, plugin);
    const marks = attention ? [] : marksFor(record);
    const delay = Math.min(rowIndex++, 12) * 30 + 60;
    return (
      <button
        key={key}
        type="button"
        className={`oex-ext${isSelected ? " is-sel" : ""}`}
        aria-current={isSelected || undefined}
        style={{ animationDelay: `${delay}ms` }}
        onClick={() => { setSelectedKey(key); phoneSplit.open(); }}
      >
        <ExtIcon kind={item.kind} name={item.name} manifest={item.manifest} plugin={plugin} />
        <span className="oex-ecopy">
          <b><span className="oui-truncate">{plugin?.name || item.name}</span><span className="oex-type">{KIND_LABEL[item.kind]}</span></b>
          <small>{attention ? attentionText(record) : [version, accessText(record)].filter(Boolean).join(" · ")}</small>
        </span>
        {attention ? <StatusDot tone="warn" ring label="Needs attention" /> : marks.length ? (
          <span className="oex-stack" aria-label={marks.map((mark) => mark.name).join(", ")}>
            {marks.slice(0, STACK_MAX).map((mark) => <AgentMark key={mark.id} target={mark} />)}
            {marks.length > STACK_MAX ? <span className="oex-amark oex-more">+{marks.length - STACK_MAX}</span> : null}
          </span>
        ) : null}
      </button>
    );
  };

  const noun = KIND_NOUN[kind];
  const listEmpty = !loading && ordered.length === 0;

  return (
    <Card className={`${phoneSplit.split} oui-rise`} style={{ animationDelay: "60ms" }} aria-label="Catalog">
      <div className="oex-master">
        <div className="oex-mtools">
          <SearchField value={search} onChange={setSearch} label="Search extensions" />
          <Segmented
            size="sm"
            block
            ariaLabel="Type"
            value={kind}
            onChange={setKind}
            options={KINDS.map((value) => ({ value, label: KIND_TAB[value], count: value === "all" ? undefined : kindCounts[value] }))}
          />
        </div>
        <div className="oui-card-list oui-scroll" key={kind}>
          {error ? (
            <div className="oex-inline-err" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span><Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button></div>
          ) : null}
          {loading ? (
            <div aria-hidden="true">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="oex-ext is-skel"><span className="oex-eicon is-skel" /><span className="oex-ecopy"><span className="oui-skel" style={{ width: "60%" }} /><span className="oui-skel" style={{ width: "40%", marginTop: 8 }} /></span></div>)}</div>
          ) : (
            <>
              {groups.attention.length ? <><div className="oex-glabel"><span className="oex-gdot" />Needs attention</div>{groups.attention.map((record) => renderRow(record, true))}</> : null}
              {groups.installed.length ? <><div className="oex-glabel">Installed</div>{groups.installed.map((record) => renderRow(record, false))}</> : null}
              {groups.available.length ? <><div className="oex-glabel">Available</div>{groups.available.map((record) => renderRow(record, false))}</> : null}
              {listEmpty ? (
                search.trim() ? (
                  <EmptyState title={<>No {noun} match “{search.trim()}”</>} action={<Button variant="secondary" size="sm" onClick={() => setSearch("")}>Clear search</Button>}>Try another name, or clear the search.</EmptyState>
                ) : (
                  <EmptyState title={`No ${noun} yet`} action={<Button variant="secondary" size="sm" onClick={onAddSource}>Add source</Button>}>Add a source — a Git repo or folder — and Grove finds the {noun} inside it.</EmptyState>
                )
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="oex-detail">
        {phoneSplit.back("Catalog")}
        {selected ? (
          <ExtensionDetail key={`${catalogRecordKey(selected)}:${context.revision}`} record={selected} context={context} />
        ) : loading ? (
          <div className="oex-detail-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
        ) : (
          <EmptyState>{!records.length ? "Extensions you add show up here: what they do, who can use them, and where they come from." : search.trim() ? "Nothing matches the search." : "Pick another type to see its details."}</EmptyState>
        )}
      </div>
    </Card>
  );
}
