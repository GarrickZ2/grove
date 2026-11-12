import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Eye, FileText, Folder, Frame, Layers, ListChecks, Minus, Pencil, type LucideIcon } from "lucide-react";
import { Button, DialogFoot, DialogHead, DialogPanel, SearchField } from "../../orbit/ui";
import { DialogShell } from "../ui/DialogShell";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import type { ShareItems, ShareScope, ShareScopeKind } from "../../api/shares";
import { SCOPE_KINDS, chosenCount, finishScope, scopeItemsOf, scopeKindsText, scopeSummary, type ScopeItem } from "./scopeItems";

const ICONS: Record<ShareScopeKind, LucideIcon> = {
  reviews: Eye,
  designs: Frame,
  sketches: Pencil,
  files: FileText,
};

/** A list long enough to want a search box. */
const SEARCH_FROM = 8;

/** What a new link shows, as a full-width row that opens the chooser. */
export function ScopeButton({ items, value, onClick }: {
  items: ShareItems | null;
  value: ShareScope | null;
  onClick: () => void;
}) {
  const Icon = value ? ListChecks : Layers;
  const detail = value ? scopeSummary(value, items) : scopeKindsText(items);
  return (
    <button type="button" className="share-scope-card" onClick={onClick} aria-haspopup="dialog">
      <span className={`share-scope-card-ic${value ? " is-part" : ""}`} aria-hidden="true"><Icon /></span>
      <span className="share-scope-card-text">
        <b>{value ? "Part of the task" : "Whole task"}</b>
        {detail && <span>{detail}</span>}
      </span>
      <ChevronRight className="share-scope-card-go" aria-hidden="true" />
    </button>
  );
}

/** Choose what one link shows. Saves `null` for the whole task. */
export function ScopeDialog({ open, items, value, title, saving, onClose, onSave }: {
  open: boolean;
  items: ShareItems | null;
  value: ShareScope | null;
  title: string;
  saving?: boolean;
  onClose: () => void;
  onSave: (scope: ShareScope | null) => void;
}) {
  // Opened from a popover that closes on a click outside it; the dialog's
  // clicks are its own.
  return (
    <span className="share-scope-host" onPointerDown={(event) => event.nativeEvent.stopImmediatePropagation()}>
    <DialogShell isOpen={open} onClose={onClose} maxWidth="max-w-2xl" variant="centered">
      {open && (
        <ScopeChooser
          items={items}
          initial={value}
          title={title}
          saving={!!saving}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </DialogShell>
    </span>
  );
}

function ScopeChooser({ items, initial, title, saving, onClose, onSave }: {
  items: ShareItems | null;
  initial: ShareScope | null;
  title: string;
  saving: boolean;
  onClose: () => void;
  onSave: (scope: ShareScope | null) => void;
}) {
  useEscapeScope(true, onClose);
  const [draft, setDraft] = useState<ShareScope>(() => initial ?? {});
  const kinds = useMemo(
    () => (items ? SCOPE_KINDS.filter(({ kind }) => scopeItemsOf(items, kind).length > 0) : []),
    [items],
  );
  const [picked, setPicked] = useState<ShareScopeKind | null>(null);
  const active = kinds.find(({ kind }) => kind === picked) ?? kinds[0];

  const setKind = (kind: ShareScopeKind, ids: string[] | undefined) => {
    if (!items) return;
    const all = scopeItemsOf(items, kind);
    setDraft((current) => {
      const next = { ...current };
      // Every item ticked is the whole kind, later additions included.
      if (ids === undefined || all.every((item) => ids.includes(item.id))) delete next[kind];
      else next[kind] = ids;
      return next;
    });
  };

  const save = () => { if (items) onSave(finishScope(draft, items)); };
  const whole = items ? finishScope(draft, items) === null : true;

  return (
    <DialogPanel className="share-scope-dlg">
      <DialogHead title={title} />
      <div className="share-scope-body">
        {!items ? (
          <div className="share-scope-empty">Loading…</div>
        ) : kinds.length === 0 ? (
          <div className="share-scope-empty">Nothing in this task to choose yet</div>
        ) : (
          <>
            <nav className="share-scope-rail" aria-label="Kinds">
              {kinds.map(({ kind, label }) => {
                const Icon = ICONS[kind];
                const total = scopeItemsOf(items, kind).length;
                const count = chosenCount(draft, items, kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`share-scope-kind${active?.kind === kind ? " is-active" : ""}`}
                    onClick={() => setPicked(kind)}
                    aria-current={active?.kind === kind}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                    <em className={count === 0 ? "is-none" : undefined}>
                      {draft[kind] === undefined ? "All" : `${count}/${total}`}
                    </em>
                  </button>
                );
              })}
            </nav>
            {active && (
              <KindList
                key={active.kind}
                kind={active.kind}
                label={active.label}
                all={scopeItemsOf(items, active.kind)}
                chosen={draft[active.kind]}
                onChange={(ids) => setKind(active.kind, ids)}
              />
            )}
          </>
        )}
      </div>
      <DialogFoot
        lead={whole ? undefined : (
          <button type="button" className="share-scope-reset" onClick={() => setDraft({})}>
            Share the whole task
          </button>
        )}
      >
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={!items || saving}>Save</Button>
      </DialogFoot>
    </DialogPanel>
  );
}

function KindList({ kind, label, all, chosen, onChange }: {
  kind: ShareScopeKind;
  label: string;
  all: ScopeItem[];
  /** `undefined`: the whole kind. */
  chosen: string[] | undefined;
  onChange: (ids: string[] | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const ticked = (id: string) => chosen === undefined || chosen.includes(id);
  const current = chosen ?? all.map((item) => item.id);
  const toggle = (ids: string[], on: boolean) => {
    const rest = current.filter((id) => !ids.includes(id));
    onChange(on ? [...rest, ...ids] : rest);
  };
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? all.filter((item) => `${item.folder ?? ""}${item.name}`.toLowerCase().includes(needle))
    : all;
  const count = all.filter((item) => ticked(item.id)).length;

  // Files sit under their folder; a folder ticks every file in it.
  const groups: { folder: string | null; items: ScopeItem[] }[] = kind === "files"
    ? [...new Set(shown.map((item) => item.folder ?? ""))]
      .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
      .map((folder) => ({ folder, items: shown.filter((item) => (item.folder ?? "") === folder) }))
    : [{ folder: null, items: shown }];

  return (
    <section className="share-scope-pane" aria-label={label}>
      <header className="share-scope-pane-head">
        <Tick
          state={count === all.length ? "on" : count === 0 ? "off" : "some"}
          onClick={() => onChange(count === all.length ? [] : undefined)}
          label={count === all.length ? `Clear ${label}` : `Select all ${label}`}
        />
        <b>{label}</b>
        <span>{chosen === undefined ? "All" : `${count} of ${all.length}`}</span>
      </header>
      {all.length >= SEARCH_FROM && (
        <SearchField className="share-scope-search" value={query} onChange={setQuery} label={`Search ${label.toLowerCase()}`} />
      )}
      <div className="share-scope-items">
        {shown.length === 0 && <div className="share-scope-empty">No matches</div>}
        {groups.map(({ folder, items }) => {
          const on = items.filter((item) => ticked(item.id)).length;
          return (
            <div key={folder ?? "all"} className="share-scope-group">
              {folder ? (
                <Row
                  icon={Folder}
                  state={on === items.length ? "on" : on === 0 ? "off" : "some"}
                  onClick={() => toggle(items.map((item) => item.id), on !== items.length)}
                  folder
                >
                  {folder.slice(0, -1)}
                </Row>
              ) : null}
              {items.map((item) => (
                <Row
                  key={item.id}
                  icon={ICONS[kind]}
                  state={ticked(item.id) ? "on" : "off"}
                  onClick={() => toggle([item.id], !ticked(item.id))}
                  nested={!!folder}
                >
                  {item.name}
                </Row>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

type TickState = "on" | "off" | "some";

function Tick({ state, onClick, label }: { state: TickState; onClick?: () => void; label?: string }) {
  const box = (
    <span className={`share-tick is-${state}`} aria-hidden="true">
      {state === "on" ? <Check /> : state === "some" ? <Minus /> : null}
    </span>
  );
  if (!onClick) return box;
  return (
    <button type="button" className="share-tick-button" onClick={onClick} aria-label={label} title={label}>
      {box}
    </button>
  );
}

function Row({ icon: Icon, state, onClick, children, folder, nested }: {
  icon: LucideIcon;
  state: TickState;
  onClick: () => void;
  children: ReactNode;
  folder?: boolean;
  nested?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "on"}
      className={`share-scope-row${folder ? " is-folder" : ""}${nested ? " is-nested" : ""}${state !== "off" ? " is-on" : ""}`}
      onClick={onClick}
    >
      <Tick state={state} />
      <Icon className="share-scope-row-ic" aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}
