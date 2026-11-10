import { ChevronLeft, CircleAlert } from "lucide-react";
import { StarfieldGraph } from "../../components/Memory/starfield/StarfieldGraph";
import { formatNumber, humanize, plural } from "../../components/Memory/memoryFormat";
import type { MemoryEntitiesState } from "../../components/Memory/useMemoryEntities";
import { MarkdownRenderer } from "../../components/ui/MarkdownRenderer";
import { useTheme } from "../../context/ThemeContext";
import { Button, Card, EmptyState, Segmented, formatDateTime, relativeText } from "../ui";
import { countLabel, strengthPct } from "./memoryView";

export type DetailPane = "memory" | "graph";

interface MemoryDetailCardProps {
  pane: DetailPane;
  onPaneChange: (pane: DetailPane) => void;
  entities: MemoryEntitiesState;
  /** Shown when the project has no memories yet. */
  emptyHint?: string;
  /** Phone: the page switches panes itself, so the card drops its switch and offers Back from a memory. */
  onBack?: () => void;
  /** Notes waiting to be organized; the mind map shows them as faint glimmers. */
  pendingNotes?: number;
}

const RELATED_LIMIT = 6;

function DocumentPane({ entities }: { entities: MemoryEntitiesState }) {
  const { detail, detailError, selectedId, relations, relatedNames } = entities;
  if (detailError) {
    return (
      <EmptyState
        role="alert"
        icon={CircleAlert}
        tone="error"
        title="Couldn’t open this memory"
        action={<Button variant="secondary" size="sm" onClick={entities.retryDetail}>Try again</Button>}
      >
        {detailError}
      </EmptyState>
    );
  }
  if (!detail || detail.entity_id !== selectedId) {
    return <div className="omd-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>;
  }
  const strength = strengthPct(detail.score);
  return (
    <>
      {/* Keyed by memory so each opened document settles in again. */}
      <div key={detail.entity_id} className="omd-doc oui-scroll">
        <div className="omd-sec">
          <h2>{detail.title}</h2>
          <div className="omd-meta">
            <span className="omd-meter" title={`Strength ${strength} / 100`}>Strength<span><i style={{ width: `${strength}%` }} /></span><b>{strength}</b></span>
            <span>Read by agents {formatNumber(detail.access_count)} {plural(detail.access_count, "time", "times")}</span>
            <span title={formatDateTime(detail.updated_at)}>Updated {relativeText(detail.updated_at)}</span>
          </div>
          {detail.tags.length > 0 ? (
            <div className="oml-tags omd-tags">
              {detail.tags.map((tag) => <span key={`${tag.key}:${tag.value}`} className="oml-tag">{tag.icon ? `${tag.icon} ` : ""}<small>{humanize(tag.key)}</small> {tag.value}</span>)}
            </div>
          ) : null}
        </div>
        <div className="omd-sec omd-body">
          {detail.description ? <p className="omd-lead">{detail.description}</p> : null}
          <MarkdownRenderer content={detail.body || "_This memory has no body yet._"} />
        </div>
        {relations.length > 0 ? (
          <div className="omd-sec">
            <div className="omd-rel-title">Related</div>
            <div className="omd-rels">
              {relations.slice(0, RELATED_LIMIT).map((relation) => {
                const otherId = relation.source_entity_id === detail.entity_id ? relation.target_entity_id : relation.source_entity_id;
                return (
                  <button key={relation.id} type="button" className="omd-rel" title={relation.description || undefined} onClick={() => entities.setSelectedId(otherId)}>
                    <em>{humanize(relation.relation_type)}</em>
                    <span>{relatedNames[otherId] ?? otherId}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <div className="omd-foot">
        <span className="oui-mono" title={detail.file_path}>{detail.file_path}</span>
      </div>
    </>
  );
}

/** The open memory as a document, or the whole Memory as a relation graph. */
export function MemoryDetailCard({ pane, onPaneChange, entities, emptyHint, onBack, pendingNotes = 0 }: MemoryDetailCardProps) {
  const { theme } = useTheme();
  const empty = !entities.loading && entities.items.length === 0;
  // A category filter dims the rest of the graph, so the title says how many of all are lit.
  const memoryCount = entities.category
    ? `${formatNumber(entities.visibleItems.length)} of ${countLabel(entities.items.length, "memory", "memories")}`
    : countLabel(entities.visibleItems.length, "memory", "memories");
  const title = pane === "memory"
    ? "Memory"
    : `${memoryCount} · ${countLabel(entities.allRelations.length, "link", "links")}${entities.hasMore ? "+" : ""}`;
  return (
    <Card
      className="omd"
      aria-label={pane === "memory" ? "Memory document" : "Memory mind map"}
      title={<span className="oui-truncate">{title}</span>}
      head={onBack && pane === "memory" ? (
        <>
          <Button variant="ghost" iconOnly size="sm" className="omd-back" aria-label="Back" title="Back" onClick={onBack}><ChevronLeft /></Button>
          <h2><span className="oui-truncate">{title}</span></h2>
        </>
      ) : undefined}
      actions={onBack ? undefined : (
        <Segmented<DetailPane>
          ariaLabel="Right pane"
          value={pane}
          onChange={onPaneChange}
          options={[{ value: "graph", label: "Mind map" }, { value: "memory", label: "Memory" }]}
        />
      )}
    >
      {empty ? (
        <EmptyState title={entities.submitted ? "No memories match" : "Nothing remembered yet"}>
          {entities.submitted ? null : emptyHint}
        </EmptyState>
      ) : pane === "graph" ? (
        <div className="omd-graph">
          {/* All memories keep their places; a category filter only dims the others. */}
          <StarfieldGraph
            entities={entities.items}
            relations={entities.allRelations}
            onOpen={(id) => { entities.setSelectedId(id); onPaneChange("memory"); }}
            look={theme.isLight ? "light" : "dark"}
            activeCategory={entities.category}
            pendingCount={pendingNotes}
          />
        </div>
      ) : entities.selectedId ? (
        <DocumentPane entities={entities} />
      ) : (
        <EmptyState title="Pick a memory" />
      )}
    </Card>
  );
}
