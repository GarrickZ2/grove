import { Segmented } from "../../orbit/ui";
import {
  type ShareItems,
  type ShareScope,
  type ShareScopeKind,
} from "../../api/shares";

const KINDS: { kind: ShareScopeKind; label: string }[] = [
  { kind: "reviews", label: "Code review" },
  { kind: "designs", label: "Designs" },
  { kind: "sketches", label: "Sketches" },
  { kind: "files", label: "Files" },
];

type Item = { id: string; name: string; folder?: string };

function itemsOf(items: ShareItems, kind: ShareScopeKind): Item[] {
  if (kind === "files") {
    return items.files.map((path) => {
      const cut = path.lastIndexOf("/");
      return { id: path, name: path.slice(cut + 1), folder: cut >= 0 ? path.slice(0, cut + 1) : undefined };
    });
  }
  return items[kind];
}

/** A first choice: everything there is now, and later additions too; kinds
 *  with nothing in them yet stay out. */
function startScope(items: ShareItems): ShareScope {
  const scope: ShareScope = {};
  for (const { kind } of KINDS) if (itemsOf(items, kind).length === 0) scope[kind] = [];
  return scope;
}

/** What a link shows: the whole task, or chosen items of each kind. `null`
 *  is the whole task. */
export function ScopeEditor({ items, value, onChange }: {
  items: ShareItems | null;
  value: ShareScope | null;
  onChange: (scope: ShareScope | null) => void;
}) {
  return (
    <div className="share-scope">
      <div className="share-row">
        <span>Shows</span>
        <Segmented
          size="sm"
          ariaLabel="What the link shows"
          value={value ? "choose" : "all"}
          onChange={(mode) => onChange(mode === "all" ? null : items ? startScope(items) : {})}
          options={[{ value: "all", label: "Whole task" }, { value: "choose", label: "Choose" }]}
        />
      </div>
      {value && (items ? <ScopeList items={items} value={value} onChange={onChange} /> : <div className="share-scope-empty">Loading…</div>)}
    </div>
  );
}

function ScopeList({ items, value, onChange }: { items: ShareItems; value: ShareScope; onChange: (scope: ShareScope) => void }) {
  const groups = KINDS.map((entry) => ({ ...entry, items: itemsOf(items, entry.kind) })).filter((group) => group.items.length > 0);
  if (groups.length === 0) return <div className="share-scope-empty">Nothing to choose yet</div>;

  const set = (kind: ShareScopeKind, ids: string[] | undefined, all: Item[]) => {
    const next = { ...value };
    // Every item ticked is the whole kind, later additions included.
    if (ids === undefined || (all.length > 0 && all.every((item) => ids.includes(item.id)))) delete next[kind];
    else next[kind] = ids;
    onChange(next);
  };

  return (
    <div className="share-scope-list">
      {groups.map(({ kind, label, items: all }) => {
        const chosen = value[kind];
        const whole = chosen === undefined;
        const ticked = (id: string) => whole || chosen.includes(id);
        const count = whole ? all.length : all.filter((item) => chosen.includes(item.id)).length;
        return (
          <div key={kind} className="share-scope-group" role="group" aria-label={label}>
            <label className="share-scope-head">
              <input
                type="checkbox"
                checked={whole}
                ref={(box) => { if (box) box.indeterminate = !whole && count > 0; }}
                onChange={() => set(kind, whole ? [] : undefined, all)}
              />
              <b>{label}</b>
              <span>{whole ? "All" : `${count} of ${all.length}`}</span>
            </label>
            {all.map((item) => (
              <label key={item.id} className="share-scope-item">
                <input
                  type="checkbox"
                  checked={ticked(item.id)}
                  onChange={() => {
                    const current = whole ? all.map((entry) => entry.id) : chosen;
                    set(kind, ticked(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id], all);
                  }}
                />
                <span title={item.folder ? `${item.folder}${item.name}` : item.name}>
                  {item.folder && <em>{item.folder}</em>}{item.name}
                </span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}
