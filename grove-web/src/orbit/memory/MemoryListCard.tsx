import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MemoryLog } from "../../api/memory";
import { formatNumber, humanize, plural } from "../../components/Memory/memoryFormat";
import type { MemoryEntitiesState } from "../../components/Memory/useMemoryEntities";
import type { MemoryLogsState } from "../../components/Memory/useMemoryLogs";
import { Button, Card, EmptyState, SearchField, Segmented, relativeText } from "../ui";
import { countLabel, sourceLabel, strengthPct } from "./memoryView";

export type ListMode = "memories" | "notes";

interface MemoryListCardProps {
  mode: ListMode;
  onModeChange: (mode: ListMode) => void;
  entities: MemoryEntitiesState;
  logs: MemoryLogsState;
  /** Pending notes, from the overview (the notes list is paged). */
  noteCount: number;
  /** Memories that appeared while this page was open. */
  fresh: ReadonlySet<string>;
  taskNames: ReadonlyMap<string, string>;
  /** A memory was picked in the list: show its document. */
  onOpenMemory: () => void;
  /** Empty-state call to action (organize pending notes), if any. */
  emptyAction?: { label: string; onClick: () => void; disabled: boolean } | null;
}

const ROW_STAGGER_MS = 30;
const STAGGER_CAP = 12;

/** Notes search only on submit in the shared hook; Orbit searches as you type. */
function useDebouncedSubmit(value: string, submit: (value: string) => void) {
  useEffect(() => {
    const timer = window.setTimeout(() => submit(value.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [value, submit]);
}

// Notes are read-only here: curating them is the organizer agent's job.
function NoteRow({ log, index, taskNames }: { log: MemoryLog; index: number; taskNames: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`oml-note${open ? " is-open" : ""}`} style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * ROW_STAGGER_MS}ms` }}>
      <span className="oml-check" aria-hidden="true"><span className="oml-dot" /></span>
      <button type="button" className="oml-note-main" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="oml-copy">
          <b><span>{log.title}</span></b>
          <small>{sourceLabel(log.task_id, taskNames)}{log.agent ? ` · ${log.agent}` : ""} · {relativeText(log.created_at)}</small>
          {open ? (
            <span className="oml-note-body">
              {log.description ? <span className="oml-note-desc">{log.description}</span> : null}
              {log.tags.length > 0 ? <span className="oml-tags">{log.tags.map((tag) => <span key={tag} className="oml-tag">#{tag}</span>)}</span> : null}
            </span>
          ) : null}
        </span>
        <ChevronDown className={`oml-caret${open ? " is-flipped" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
}

export function MemoryListCard({ mode, onModeChange, entities, logs, noteCount, fresh, taskNames, onOpenMemory, emptyAction }: MemoryListCardProps) {
  const notes = mode === "notes";
  useDebouncedSubmit(logs.query, logs.setSubmitted);
  const query = notes ? logs.query : entities.query;
  const setQuery = notes ? logs.setQuery : entities.setQuery;

  return (
    <Card
      className="oml"
      aria-label={notes ? "Notes" : "Memories"}
      head={(
        <SearchField
          className="oml-search"
          value={query}
          onChange={setQuery}
          label={notes ? "Search notes" : "Search memories"}
          placeholder={notes ? "Search notes" : "Search memories, descriptions, or tags"}
        />
      )}
      actions={(
        <Segmented<ListMode>
          ariaLabel="List"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "memories", label: "Memories" },
            { value: "notes", label: "Notes", count: noteCount > 0 ? noteCount : undefined },
          ]}
        />
      )}
    >

      {notes ? (
        <>
          {logs.error ? <p className="oml-error" role="alert">{logs.error}<button type="button" onClick={() => logs.setError(null)}>Dismiss</button></p> : null}
          <div className="oui-card-list oui-scroll">
            {logs.loading && logs.items.length === 0 ? (
              <div className="oml-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
            ) : logs.items.length === 0 ? (
              <EmptyState title={logs.submitted ? "No notes match" : "No notes waiting"} />
            ) : (
              <>
                {logs.items.map((log, index) => (
                  <NoteRow
                    key={log.id}
                    log={log}
                    index={index}
                    taskNames={taskNames}
                  />
                ))}
                {logs.cursor ? (
                  <div className="oml-more">
                    <span>{countLabel(logs.items.length, "note", "notes")} loaded</span>
                    <Button variant="secondary" size="sm" disabled={logs.loading} onClick={() => void logs.load(true)}>{logs.loading ? "Loading…" : "Load more"}</Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          {entities.categories.length > 0 ? (
            <div className="oml-chips" role="radiogroup" aria-label="Tag category">
              <button type="button" role="radio" aria-checked={entities.category === null} className={`oml-chip${entities.category === null ? " is-on" : ""}`} onClick={() => entities.setCategory(null)}>
                All<small>{formatNumber(entities.items.length)}</small>
              </button>
              {entities.categories.map(([name, count]) => (
                <button key={name} type="button" role="radio" aria-checked={entities.category === name} className={`oml-chip${entities.category === name ? " is-on" : ""}`} onClick={() => entities.setCategory(entities.category === name ? null : name)}>
                  {humanize(name)}<small>{formatNumber(count)}</small>
                </button>
              ))}
            </div>
          ) : null}
          {entities.error ? <p className="oml-error" role="alert">{entities.error}<button type="button" onClick={() => entities.setError(null)}>Dismiss</button></p> : null}
          <div className="oui-card-list oui-scroll">
            {entities.loading && entities.items.length === 0 ? (
              <div className="oml-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
            ) : entities.visibleItems.length === 0 ? (
              <EmptyState
                title={entities.submitted ? "No memories match" : "No memories yet"}
                action={!entities.submitted && emptyAction ? <Button variant="secondary" size="sm" disabled={emptyAction.disabled} onClick={emptyAction.onClick}>{emptyAction.label}</Button> : null}
              />
            ) : (
              <>
                {entities.visibleItems.map((entity, index) => {
                  const selected = entity.entity_id === entities.selectedId;
                  const isFresh = fresh.has(entity.entity_id);
                  return (
                    <button
                      key={entity.entity_id}
                      type="button"
                      aria-pressed={selected}
                      className={`oml-mem${selected ? " is-sel" : ""}${isFresh ? " is-new" : ""}`}
                      style={{ animationDelay: `${Math.min(index, STAGGER_CAP) * ROW_STAGGER_MS}ms` }}
                      onClick={() => { entities.setSelectedId(entity.entity_id); onOpenMemory(); }}
                    >
                      <span className="oml-strength" title={`Strength ${strengthPct(entity.score)} / 100`}><i style={{ height: `${strengthPct(entity.score)}%` }} /></span>
                      <span className="oml-copy">
                        <b><span>{entity.title}</span>{isFresh ? <em className="oml-new">New</em> : null}</b>
                        {entity.description ? <small>{entity.description}</small> : null}
                        {entity.tags.length > 0 ? (
                          <span className="oml-tags">
                            {entity.tags.slice(0, 3).map((tag) => <span key={`${tag.key}:${tag.value}`} className="oml-tag" title={`${humanize(tag.key)} · ${tag.value}`}>{tag.icon ? `${tag.icon} ` : ""}{tag.value}</span>)}
                            {entity.tags.length > 3 ? <span className="oml-tag">+{entity.tags.length - 3}</span> : null}
                          </span>
                        ) : null}
                      </span>
                      <span className="oml-uses" title={`Read by agents ${formatNumber(entity.access_count)} ${plural(entity.access_count, "time", "times")}`}>{formatNumber(entity.access_count)}×</span>
                    </button>
                  );
                })}
                {entities.hasMore ? <p className="oml-foot">Showing the {formatNumber(entities.items.length)} strongest{entities.submitted ? " matches" : " memories"}</p> : null}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
