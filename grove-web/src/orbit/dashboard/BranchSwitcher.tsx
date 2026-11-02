import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, History, Plus, Search, Split } from "lucide-react";
import { usePopover } from "../ui";
import type { Branch, Commit, Task } from "../../data/types";

interface BranchSwitcherProps {
  current: string;
  branches: Branch[];
  commits: Commit[];
  tasks: Task[];
  loading: boolean;
  disabled: boolean;
  onCheckout: (branch: Branch) => void;
  onNewBranch: () => void;
  onAllBranches: () => void;
}

const MAX_ROWS = 40;

/** Branch pill + popover: filter and switch branches, recent history, and the full drawer. */
export function BranchSwitcher({ current, branches, commits, tasks, loading, disabled, onCheckout, onNewBranch, onAllBranches }: BranchSwitcherProps) {
  const { open, setOpen, close, rootRef } = usePopover();
  const [view, setView] = useState<"branches" | "history">("branches");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const taskBranches = useMemo(() => new Set(tasks.filter((task) => task.status !== "archived").map((task) => task.branch)), [tasks]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The branch list can omit the checked-out branch; it still belongs on top.
    const all = branches.some((branch) => branch.name === current)
      ? branches
      : [{ name: current, isLocal: true, isCurrent: true }, ...branches];
    // Local first, then remotes; current always on top.
    return all
      .filter((branch) => !q || branch.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name === current) - Number(a.name === current) || Number(b.isLocal) - Number(a.isLocal))
      .slice(0, MAX_ROWS);
  }, [branches, query, current]);
  const activeCursor = Math.min(cursor, Math.max(0, rows.length - 1));

  const toggle = () => {
    if (open) return close();
    setView("branches");
    setQuery("");
    setCursor(0);
    setOpen(true);
  };

  const pick = (branch: Branch) => {
    close();
    if (branch.name !== current) onCheckout(branch);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((activeCursor + step + rows.length) % Math.max(1, rows.length));
    } else if (event.key === "Enter" && rows[activeCursor]) {
      event.preventDefault();
      pick(rows[activeCursor]);
    }
  };

  const note = (branch: Branch) => (branch.name === current ? null : taskBranches.has(branch.name) ? "task" : branch.isLocal ? null : "remote");

  return (
    <span ref={rootRef} className="odb-anchor">
      <button type="button" className="odb-branch" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={toggle} title="Switch branch">
        <GitBranch aria-hidden="true" />
        <span className="oui-mono oui-truncate">{current}</span>
        <ChevronDown aria-hidden="true" className={open ? "is-flipped" : undefined} />
      </button>
      {open ? (
        <div className="oui-pop is-start odb-pop" role="dialog" aria-label={view === "branches" ? "Switch branch" : "Recent commits"}>
          {view === "branches" ? (
            <>
              <label className="odb-pop-search">
                <Search aria-hidden="true" />
                <input
                  ref={inputRef}
                  autoFocus
                  type="text"
                  value={query}
                  placeholder="Switch branch…"
                  aria-label="Filter branches"
                  onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
                  onKeyDown={onKeyDown}
                />
              </label>
              <div className="odb-pop-list oui-scroll" role="listbox" aria-label="Branches">
                {loading && rows.length === 0 ? <div className="odb-pop-empty"><span className="oui-skel" /></div> : null}
                {!loading && rows.length === 0 ? <div className="odb-pop-empty">No matching branch</div> : null}
                {rows.map((branch, index) => (
                  <button
                    key={`${branch.isLocal ? "l" : "r"}:${branch.name}`}
                    type="button"
                    role="option"
                    aria-selected={branch.name === current}
                    className={`odb-pop-item${index === activeCursor ? " is-cursor" : ""}`}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => pick(branch)}
                  >
                    <span className="oui-mono oui-truncate">{branch.name}</span>
                    {note(branch) ? <small>{note(branch)}</small> : null}
                    {branch.name === current ? <Check className="odb-pop-check" aria-label="Current branch" /> : null}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="odb-pop-list oui-scroll is-history" aria-label="Recent commits">
              {commits.length === 0 ? <div className="odb-pop-empty">No commits</div> : commits.slice(0, 20).map((commit) => (
                <div key={commit.hash} className="odb-commit">
                  <GitCommitHorizontal aria-hidden="true" />
                  <span className="odb-commit-msg">{commit.message}</span>
                  <code className="oui-mono">{commit.hash.slice(0, 7)}</code>
                  <small>{commit.timeAgo ?? ""}</small>
                </div>
              ))}
            </div>
          )}
          <div className="odb-pop-foot">
            <button type="button" onClick={() => { close(); onNewBranch(); }}><Plus aria-hidden="true" />New branch</button>
            <button type="button" aria-pressed={view === "history"} className={view === "history" ? "is-on" : undefined} onClick={() => { setView(view === "history" ? "branches" : "history"); window.requestAnimationFrame(() => inputRef.current?.focus()); }}><History aria-hidden="true" />History</button>
            <button type="button" onClick={() => { close(); onAllBranches(); }}><Split aria-hidden="true" />All branches</button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
