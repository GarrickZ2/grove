import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowLeft, ArrowDownWideNarrow, ChevronDown, ChevronRight, Cpu, Database, File, Folder, HardDrive, Layers, Loader2, MemoryStick, RefreshCw, Search, X } from 'lucide-react';
import { useTheme } from '../../context';
import { getResourceProcesses, getResourceStorage, getStorageChildren, refreshResourceStorage, type ProcessNode, type ProcessSnapshot, type StorageNode, type StoragePage, type StorageStatus } from '../../api/resourceMonitor';

type Metric = 'cpu' | 'memory' | 'storage';
type Sample = { at: string; cpu: number | null; memory: number | null };
const muted = 'text-[var(--color-text-muted)]';
const surface = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]';
const control = 'rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 transition-colors';

function bytes(value: number): string {
  if (value === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

function memoryValue(value: number, unavailable = 0): string {
  return unavailable ? value > 0 ? `${bytes(value)} (partial)` : 'Unavailable' : bytes(value);
}
function memoryLabel(processes: ProcessSnapshot | null): string {
  return processes?.memory_basis === 'physical_footprint' ? 'Memory footprint' : 'Memory (RSS sum)';
}

function percent(value: number): string { return `${value.toFixed(1)}%`; }

function ChartTooltip({ id, x, y, children }: { id: string; x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(12, Math.min(x + 14, window.innerWidth - width - 12))}px`;
    element.style.top = `${Math.max(12, y + height + 14 > window.innerHeight - 12 ? y - height - 14 : y + 14)}px`;
  }, [x, y, children]);
  return createPortal(<div ref={ref} id={id} role="tooltip" className="pointer-events-none fixed z-[120] w-60 max-w-[calc(100vw-24px)] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text)] shadow-xl">{children}</div>, document.body);
}
function message(error: unknown): string { return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Could not load resource usage. Try again.'; }
function valueOf(node: ProcessNode, metric: Metric) { return metric === 'cpu' ? node.cpu_percent ?? 0 : node.memory_bytes; }
function storageKey(node: StorageNode) { return `${node.kind}:${node.detail}`; }
function groupColor(key: string, palette: string[]) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
function processMatches(node: ProcessNode, query: string): boolean {
  return `${node.name} ${node.detail}`.toLowerCase().includes(query) || node.children.some(child => processMatches(child, query));
}

// Rank once when a level first appears. Live samples update values in place;
// new rows append and exited rows disappear without shuffling surviving rows.
function orderProcesses(nodes: ProcessNode[], previous: ProcessNode[], metric: Metric): ProcessNode[] {
  const ranks = new Map(previous.map((node, index) => [node.id, index]));
  const oldNodes = new Map(previous.map(node => [node.id, node]));
  return [...nodes].sort((a, b) => {
    const aRank = ranks.get(a.id), bRank = ranks.get(b.id);
    if (aRank !== undefined || bRank !== undefined) return (aRank ?? Infinity) - (bRank ?? Infinity);
    return valueOf(b, metric) - valueOf(a, metric) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }).map(node => ({ ...node, children: orderProcesses(node.children, oldNodes.get(node.id)?.children ?? [], metric) }));
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values, 1);
  const points = values.map((value, i) => `${i / Math.max(values.length - 1, 1) * 160},${32 - value / max * 26}`).join(' ');
  return <svg viewBox="0 0 160 36" className="mt-3 h-9 w-full" aria-hidden="true" preserveAspectRatio="none">
    <path d="M0 33H160" stroke="var(--color-border)" strokeDasharray="3 4" />
    {values.length > 1 && <><polygon points={`0,36 ${points} 160,36`} fill={color} opacity="0.08" /><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></>}
  </svg>;
}

function MetricCard({ active, onClick, label, value, subtitle, icon, children }: { active: boolean; onClick: () => void; label: string; value: string; subtitle: string; icon: ReactNode; children: ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={active} className={`${surface} min-w-0 p-3 text-left transition-colors sm:p-4 ${active ? '!border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]/20' : 'hover:border-[var(--color-text-muted)]'}`}>
    <span className={`flex items-center gap-2 text-xs font-medium ${active ? 'text-[var(--color-highlight)]' : muted}`}>{icon}{label}</span>
    <span className="mt-3 block truncate text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">{value}</span>
    <span className={`mt-1 block truncate text-[10px] sm:text-xs ${muted}`} title={subtitle}>{subtitle}</span>
    {children}
  </button>;
}

function UsageRow({ name, detail, kind, value, share, color, depth, expandable, expanded, onToggle, onDrill, note }: {
  name: string; detail: string; kind: string; value: string; share: number | null; color: string; depth: number; expandable: boolean; expanded: boolean; onToggle: () => void; onDrill?: () => void; note?: string;
}) {
  const Icon = kind === 'process' ? Activity : kind === 'file' || kind === 'symlink' ? File : kind === 'shared' || kind === 'database' ? Database : kind === 'task' ? Layers : Folder;
  return <div className="group flex min-w-0 items-center gap-2 border-b border-[var(--color-border)]/60 py-2.5 pr-3 hover:bg-[var(--color-bg-secondary)]" style={{ paddingLeft: 8 + Math.min(depth, 8) * 16 }}>
    <button type="button" disabled={!expandable} onClick={onToggle} onDoubleClick={onDrill} aria-expanded={expandable ? expanded : undefined} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`} className="flex min-w-0 flex-1 select-none items-center gap-2 text-left disabled:cursor-default">
      <span className={`w-3 shrink-0 ${muted}`}>{expandable ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
      <Icon size={15} className="shrink-0" style={{ color }} />
      <span className="min-w-0"><span className="block truncate text-xs font-medium" title={name}>{name}</span><span className={`block truncate text-[10px] ${muted}`} title={detail}>{note || detail || kind}</span></span>
    </button>
    <div className="w-20 shrink-0 text-right sm:w-28"><div className="text-xs font-medium tabular-nums">{value}</div><div className={`text-[10px] tabular-nums ${muted}`}>{share === null ? 'Share unavailable' : `${percent(share)} of total`}</div></div>
    <div className="hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-[var(--color-border)] sm:block"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, share ?? 0)}%`, backgroundColor: color }} /></div>
  </div>;
}

function ProcessBranch({ node, metric, total, color, depth, query, onDrill }: { node: ProcessNode; metric: Metric; total: number; color: string; depth: number; query: string; onDrill: (nodes: ProcessNode[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (query && !processMatches(node, query)) return null;
  const value = valueOf(node, metric);
  const children = node.children;
  return <>
    <UsageRow name={node.name} detail={node.detail} kind={node.kind} value={metric === 'cpu' ? node.cpu_percent === null ? 'Sampling…' : percent(value) : memoryValue(value, node.memory_unavailable_count)} share={metric === 'memory' && node.memory_unavailable_count > 0 && value === 0 ? null : total > 0 ? value / total * 100 : 0} color={color} depth={depth} expandable={children.length > 0} expanded={expanded} onToggle={() => setExpanded(!expanded)} onDrill={() => { if (children.length) onDrill([node]); }} />
    {expanded && children.map(child => <ProcessBranch key={child.id} node={child} metric={metric} total={total} color={color} depth={depth + 1} query={query} onDrill={nodes => onDrill([node, ...nodes])} />)}
  </>;
}

// Each expanded directory requests a bounded page from the immutable scan.
// Requests are aborted on collapse, search changes, and snapshot replacement.
function StorageChildren({ scanId, nodeId, totalBytes, depth, color, query, palette, expanded, toggle, onDrill }: {
  scanId: string; nodeId: number; totalBytes: number; depth: number; color?: string; query: string; palette: string[]; expanded: Set<string>; toggle: (key: string) => void; onDrill: (nodes: StorageNode[]) => void;
}) {
  const [result, setResult] = useState<{ key: string; page: StoragePage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState({ key: '', value: 100 });
  const requestKey = `${scanId}:${nodeId}:${query}`;
  const count = limit.key === requestKey ? limit.value : 100;
  const current = result?.key === requestKey ? result.page : null;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const nodes: StorageNode[] = [];
        let total = 0;
        for (let offset = 0; offset < count; offset += 100) {
          const page = await getStorageChildren(scanId, nodeId, offset, query, controller.signal);
          nodes.push(...page.nodes);
          total = page.total;
          if (nodes.length >= total) break;
        }
        if (!controller.signal.aborted) setResult({ key: requestKey, page: { nodes, total } });
      } catch (error) { if (!controller.signal.aborted) setError(message(error)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [scanId, nodeId, query, requestKey, count, retry]);
  return <>
    {current?.nodes.map(node => {
      const key = storageKey(node);
      const rowColor = color || groupColor(key, palette);
      const isExpanded = expanded.has(key);
      return <div key={key}>
        <UsageRow name={node.name} detail={node.detail} kind={node.kind} value={bytes(node.bytes)} share={totalBytes > 0 ? node.bytes / totalBytes * 100 : 0} color={rowColor} depth={depth} expandable={node.child_count > 0} expanded={isExpanded} onToggle={() => toggle(key)} onDrill={() => { if (node.child_count) onDrill([node]); }} note={node.unreadable ? 'Partially unreadable' : node.shared ? 'Hard link · counted elsewhere' : node.kind === 'symlink' ? 'Symbolic link · target excluded' : undefined} />
        {isExpanded && node.child_count > 0 && <StorageChildren scanId={scanId} nodeId={node.id} totalBytes={totalBytes} depth={depth + 1} color={rowColor} query={query} palette={palette} expanded={expanded} toggle={toggle} onDrill={nodes => onDrill([node, ...nodes])} />}
      </div>;
    })}
    {error && <div className="flex items-center gap-2 p-3 text-xs text-[var(--color-warning)]" role="alert">{error}<button type="button" className={control} onClick={() => setRetry(v => v + 1)}>Retry</button></div>}
    {loading && <div className={`flex items-center gap-2 p-3 text-xs ${muted}`}><Loader2 size={13} className="animate-spin" />Loading details…</div>}
    {!loading && !error && current && current.nodes.length === 0 && <p className={`p-4 text-xs ${muted}`}>No matching files or groups.</p>}
    {!loading && current && current.nodes.length < current.total && <button type="button" className={`${control} m-3`} onClick={() => setLimit({ key: requestKey, value: count + 100 })}>Show more · {current.total - current.nodes.length} remaining</button>}
  </>;
}

type Crumb = { key: string; name: string };
type ResourceGroup = Crumb & { value: number; hasChildren: boolean; storage?: StorageNode; process?: ProcessNode };
const storageGroup = (node: StorageNode): ResourceGroup => ({ key: storageKey(node), name: node.name, value: node.bytes, hasChildren: node.child_count > 0, storage: node });
const processGroup = (node: ProcessNode, metric: Metric): ResourceGroup => ({ key: node.id, name: node.name, value: valueOf(node, metric), hasChildren: node.children.length > 0, process: node });

// IDs belong to a scan, while navigation uses stable identities. Resolve each
// ancestor again after a rescan, including ancestors past the first page.
function useStorageLevel(scanId: string | null, path: Crumb[]) {
  const route = JSON.stringify(path.map(crumb => crumb.key));
  const requestKey = `${scanId}:${route}`;
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; trail: StorageNode[]; nodes: StorageNode[]; missing: boolean; error?: string } | null>(null);
  useEffect(() => {
    if (!scanId) return;
    const controller = new AbortController();
    async function load() {
      try {
        const trail: StorageNode[] = [];
        const keys: string[] = JSON.parse(route);
        let parent = 0;
        let page = await getStorageChildren(scanId!, parent, 0, '', controller.signal);
        for (const key of keys) {
          let match = page.nodes.find(node => storageKey(node) === key);
          let offset = page.nodes.length;
          while (!match && offset < page.total) {
            const next = await getStorageChildren(scanId!, parent, offset, '', controller.signal);
            match = next.nodes.find(node => storageKey(node) === key);
            if (!next.nodes.length) break;
            offset += next.nodes.length;
          }
          if (!match) break;
          trail.push(match);
          parent = match.id;
          page = await getStorageChildren(scanId!, parent, 0, '', controller.signal);
        }
        if (!controller.signal.aborted) setResult({ key: requestKey, trail, nodes: page.nodes, missing: trail.length !== keys.length });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: requestKey, trail: [], nodes: [], missing: false, error: message(error) });
      }
    }
    void load();
    return () => controller.abort();
  }, [scanId, route, requestKey, retry]);
  return { data: result?.key === requestKey ? result : null, retry: () => setRetry(value => value + 1) };
}

function ResourceExplorer({ metric, processes, storage, palette, refreshing, onRefresh, processError, storageError }: {
  metric: Metric; processes: ProcessSnapshot | null; storage: StorageStatus | null; palette: string[];
  refreshing: boolean; onRefresh: () => void; processError: string | null; storageError: string | null;
}) {
  const [ordered, setOrdered] = useState(() => ({ source: processes, groups: orderProcesses(processes?.groups ?? [], [], metric) }));
  if (ordered.source !== processes) {
    const previous = metric === 'cpu' && ordered.source?.cpu_percent == null ? [] : ordered.groups;
    setOrdered({ source: processes, groups: orderProcesses(processes?.groups ?? [], previous, metric) });
  }
  const [path, setPath] = useState<Crumb[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const tooltipId = useId();
  const [hovered, setHovered] = useState<{ key: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!hovered) return;
    const dismiss = () => setHovered(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, [hovered]);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim().toLowerCase()), 250); return () => clearTimeout(timer); }, [search]);
  const level = useStorageLevel(metric === 'storage' && path.length ? storage?.scan_id ?? null : null, path);
  const processTrail: ResourceGroup[] = [];
  let processNodes = ordered.groups;
  if (metric !== 'storage') {
    for (const crumb of path) {
      const node = processNodes.find(node => node.id === crumb.key);
      if (!node?.children.length) break;
      processTrail.push(processGroup(node, metric));
      processNodes = node.children;
    }
  }
  const waiting = metric === 'storage' && path.length > 0 && !level.data;
  const trail = metric === 'storage' ? (path.length ? level.data?.trail ?? [] : []).map(storageGroup) : processTrail;
  const effectivePath = waiting || level.data?.error ? path : trail;
  const scope = trail.at(-1);
  const scopeName = scope?.name ?? 'Grove total';
  const total = scope?.value ?? (metric === 'storage' ? storage?.root?.bytes ?? 0 : metric === 'cpu' ? processes?.cpu_percent ?? 0 : processes?.memory_bytes ?? 0);
  const groups = (metric === 'storage'
    ? (path.length ? level.data?.nodes ?? [] : storage?.groups ?? []).map(storageGroup)
    : processNodes.map(node => processGroup(node, metric)))
    .map(group => ({ ...group, color: groupColor(group.key, palette) }))
    .sort((a, b) => metric === 'storage' ? b.value - a.value || a.name.localeCompare(b.name) || a.key.localeCompare(b.key) : 0);
  const selection = groups.find(group => group.key === selected);
  const detailScope = selection ?? scope;
  const detailTotal = detailScope?.value ?? total;
  const detailTrail = selection?.hasChildren ? [...trail, selection] : trail;
  const details = selection?.process ? selection.process.children.length ? selection.process.children : [selection.process] : processNodes;
  const format = (value: number, unavailable = 0) => metric === 'cpu' ? percent(value) : metric === 'memory' ? memoryValue(value, unavailable) : bytes(value);
  const top = groups.slice(0, 5);
  // The directory endpoint is paginated. The remainder includes children that
  // haven't been fetched, so the ring still accounts for the entire scope.
  const rest = Math.max(0, total - top.reduce((sum, group) => sum + group.value, 0));
  const chart = rest > 0 ? [...top, { key: 'other', name: 'Other groups', value: rest, color: 'var(--color-text-muted)', hasChildren: false, process: undefined }] : top;
  const arcs = chart.map((group, index) => ({ ...group,
    offset: total ? chart.slice(0, index).reduce((sum, previous) => sum + previous.value, 0) / total * 100 : 0,
    share: total ? group.value / total * 100 : 0,
  }));
  const largest = groups.reduce<typeof groups[number] | undefined>((largest, group) => !largest || group.value > largest.value ? group : largest, undefined);
  const hoveredGroup = arcs.find(group => group.key === hovered?.key);
  const loading = waiting || (metric === 'storage' ? !storage?.root : !processes || metric === 'cpu' && processes.cpu_percent === null);
  const missing = metric === 'storage' ? path.length > 0 && level.data?.missing : trail.length < path.length;
  function navigate(next: Crumb[]) { setPath(next); setSelected(null); setSearch(''); setQuery(''); setHovered(null); }
  function select(key: string) { setSelected(previous => previous === key ? null : key); }
  function enter(group: Crumb & { hasChildren: boolean }) { if (group.hasChildren) navigate([...trail, { key: group.key, name: group.name }]); }
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  return <>
    <div className={`${surface} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div><h3 className="text-sm font-medium">Where resources go</h3><p className={`mt-0.5 text-xs ${muted}`}>Click to see contents · double-click to drill down</p></div>
        {metric === 'storage' && <button type="button" className={`${control} flex items-center gap-1.5`} disabled={refreshing || storage?.scanning} onClick={onRefresh}><RefreshCw size={12} className={refreshing || storage?.scanning ? 'animate-spin' : ''} />{storage?.scanning ? 'Scanning…' : 'Refresh scan'}</button>}
      </div>
      <nav aria-label="Resource location" className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-3 py-2 text-xs">
        <button type="button" aria-label="Back to parent" disabled={!effectivePath.length} onClick={() => navigate(effectivePath.slice(0, -1))} className={`${control} mr-1 !border-0 !p-1.5`}><ArrowLeft size={14} /></button>
        <button type="button" onClick={() => navigate([])} aria-current={!effectivePath.length ? 'location' : undefined} className="rounded px-1.5 py-1 hover:bg-[var(--color-bg-tertiary)]">All resources</button>
        {effectivePath.map((crumb, index) => <span key={crumb.key} className="flex min-w-0 items-center gap-1"><ChevronRight size={12} className={muted} /><button type="button" onClick={() => navigate(effectivePath.slice(0, index + 1))} aria-current={index === effectivePath.length - 1 ? 'location' : undefined} className="max-w-48 truncate rounded px-1.5 py-1 hover:bg-[var(--color-bg-tertiary)]" title={crumb.name}>{crumb.name}</button></span>)}
      </nav>
      {missing && <p role="status" className={`px-4 pt-3 text-xs ${muted}`}>This resource is no longer available. Showing its nearest available parent.</p>}
      {level.data?.error && path.length > 0 ? <div role="alert" className="flex items-center gap-2 p-4 text-xs text-[var(--color-warning)]">{level.data.error}<button type="button" className={control} onClick={level.retry}>Retry</button></div>
        : loading ? <div className={`flex min-h-40 items-center justify-center gap-2 text-xs ${muted}`}><Loader2 size={15} className="animate-spin" />{metric === 'storage' ? storageError || storage?.error ? 'Storage is unavailable. Retry the scan above.' : 'Loading resource breakdown…' : processError ? 'Process metrics are unavailable. Retrying…' : 'Collecting resource samples…'}</div>
          : <div className="flex flex-col gap-6 p-4 sm:flex-row sm:items-center sm:p-5">
            <div className="flex shrink-0 items-center justify-center gap-4 sm:block">
              <div className="relative h-32 w-32">
                <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90" aria-label={`${metric} distribution for ${scopeName}`}>
                  <circle cx="64" cy="64" r="56" fill="none" stroke="var(--color-border)" strokeWidth="12" />
                  {arcs.filter(group => group.share > 0).map(group => <circle key={group.key} cx="64" cy="64" r="56" fill="none" stroke={group.color} strokeWidth="12" pathLength="100" strokeDasharray={`${group.share} ${100 - group.share}`} strokeDashoffset={-group.offset} opacity={selection && selection.key !== group.key ? 0.35 : 1}
                    role={group.key === 'other' ? 'img' : 'button'} tabIndex={0} aria-label={group.key === 'other' ? group.name : `Select ${group.name}`} aria-pressed={group.key === 'other' ? undefined : selection?.key === group.key} aria-describedby={hoveredGroup?.key === group.key ? tooltipId : undefined}
                    className={group.key === 'other' ? '' : 'cursor-pointer transition-opacity hover:opacity-75'}
                    onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered({ key: group.key, x: event.clientX, y: event.clientY }); }} onPointerLeave={() => setHovered(null)}
                    onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered({ key: group.key, x: rect.right, y: rect.top + rect.height / 2 }); }} onBlur={() => setHovered(null)}
                    onClick={() => { if (group.key !== 'other') select(group.key); }} onDoubleClick={() => enter(group)}
                    onKeyDown={event => { if (event.key === 'Escape') setHovered(null); if (group.key !== 'other' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (event.key === 'Enter' && event.shiftKey) enter(group); else select(group.key); } }} />)}
                </svg>
                <div className="pointer-events-none absolute inset-4 flex flex-col items-center justify-center"><span className={`max-w-full truncate px-1 text-[10px] ${muted}`} title={scopeName}>{scopeName}</span><span className="mt-1 text-lg font-semibold tabular-nums">{format(total, scope?.process?.memory_unavailable_count ?? processes?.memory_unavailable_count)}</span></div>
              </div>
              <p className={`max-w-36 text-xs sm:mt-3 sm:text-center ${muted}`}>{largest && total > 0 ? <><span className="font-medium text-[var(--color-text)]">{largest.name}</span> leads at {percent(largest.value / total * 100)}</> : 'No measurable usage in this sample'}</p>
            </div>
            <div className="min-w-0 flex-1 space-y-1">{chart.map(group => <div key={group.key} className={`flex items-center rounded-lg ${selection?.key === group.key ? 'bg-[var(--color-bg-tertiary)]' : ''}`}>
              <button type="button" aria-label={`Select ${group.name}`} disabled={group.key === 'other'} aria-pressed={selection?.key === group.key} onClick={() => select(group.key)} onDoubleClick={() => enter(group)} className="flex min-w-0 flex-1 select-none items-center gap-2 rounded-lg p-2 text-left transition-colors hover:bg-[var(--color-bg-tertiary)] disabled:cursor-default">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: group.color }} /><span className="min-w-0 flex-1 truncate text-xs" title={group.name}>{group.name}</span><span className="text-xs font-medium tabular-nums">{format(group.value, group.process?.memory_unavailable_count)}</span><span className={`w-12 text-right text-[10px] tabular-nums ${muted}`}>{metric === 'memory' && group.process?.memory_unavailable_count && group.value === 0 ? '—' : percent(total > 0 ? group.value / total * 100 : 0)}</span>
              </button>
              {group.hasChildren ? <button type="button" aria-label={`Explore ${group.name}`} title={`Explore ${group.name}`} onClick={() => enter(group)} className="rounded-lg p-2 hover:bg-[var(--color-bg-tertiary)]"><ChevronRight size={14} /></button> : <span className="w-[30px]" />}
            </div>)}</div>
          </div>}
    </div>

    {!loading && hovered && hoveredGroup && <ChartTooltip id={tooltipId} x={hovered.x} y={hovered.y}>
      <div className="flex items-start gap-2"><span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: hoveredGroup.color }} /><span className="break-words font-medium">{hoveredGroup.name}</span></div>
      <div className="mt-3 flex items-baseline justify-between gap-3"><span className={muted}>{metric === 'cpu' ? 'CPU' : metric === 'memory' ? memoryLabel(processes) : 'Storage'}</span><span className="text-sm font-semibold tabular-nums">{format(hoveredGroup.value, hoveredGroup.process?.memory_unavailable_count)}</span></div>
      {'process' in hoveredGroup && hoveredGroup.process?.detail && <p className={`mt-2 break-words ${muted}`}>{hoveredGroup.process.detail}</p>}
      <div className={`mt-1 flex justify-between gap-3 ${muted}`}><span className="min-w-0 break-words">Share of {scopeName}</span><span className="shrink-0 tabular-nums">{percent(hoveredGroup.share)}</span></div>
    </ChartTooltip>}

    <div className={`${surface} overflow-hidden !bg-[var(--color-bg)]`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] p-3"><div className="mr-auto flex min-w-0 items-center gap-2"><Layers size={14} className={muted} /><h3 className="truncate text-sm font-medium">Resource details{detailScope ? ` · ${detailScope.name}` : ''}</h3></div><label className={`flex items-center gap-2 rounded-lg bg-[var(--color-bg-secondary)] px-2.5 py-1.5 ${muted}`}><Search size={13} /><input aria-label="Search resources" placeholder="Search resources…" value={search} onChange={event => setSearch(event.target.value)} className="w-32 bg-transparent text-xs text-[var(--color-text)] outline-none sm:w-40" />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X size={12} /></button>}</label></div>
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2 text-[10px] ${muted}`}><span>Shares of {detailScope?.name ?? 'Grove total'} · double-click to drill down</span>{metric === 'storage' ? <span className="flex items-center gap-1"><ArrowDownWideNarrow size={12} />Largest first</span> : <button type="button" className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-[var(--color-bg-tertiary)]" onClick={() => setOrdered({ source: processes, groups: orderProcesses(processes?.groups ?? [], [], metric) })}><ArrowDownWideNarrow size={12} />Sort by usage</button>}</div>
      {selection && <div className="flex items-center gap-3 px-3 py-2 text-xs"><span className={muted}>{selection.hasChildren ? `Contents of ${selection.name}` : selection.name}</span><button type="button" onClick={() => setSelected(null)} className="text-[var(--color-highlight)]">Show all in this level</button>{selection.hasChildren && <button type="button" aria-label={`Drill into ${selection.name}`} onClick={() => enter(selection)} className="ml-auto flex items-center gap-1 text-[var(--color-highlight)]">Explore<ChevronRight size={12} /></button>}</div>}
      <div className="max-h-[520px] overflow-auto" aria-label="Resource detail rows">
        {waiting || level.data?.error && path.length > 0 ? <p className={`p-4 text-xs ${muted}`}>Waiting for this level’s breakdown.</p>
          : metric === 'storage' ? storage?.scan_id && storage.root ? selection?.storage && !selection.hasChildren
            ? <UsageRow name={selection.name} detail={selection.storage.detail} kind={selection.storage.kind} value={bytes(selection.value)} share={selection.value > 0 ? 100 : 0} color={groupColor(selection.key, palette)} depth={0} expandable={false} expanded={false} onToggle={() => {}} />
            : <StorageChildren scanId={storage.scan_id} nodeId={detailScope?.storage?.id ?? 0} totalBytes={detailTotal} depth={0} query={query} palette={palette} expanded={expanded} toggle={toggle} onDrill={nodes => navigate([...detailTrail, ...nodes.map(storageGroup)])} />
            : <p className={`p-4 text-xs ${muted}`}>Details appear when the scan completes.</p>
            : <>{details.map(node => <ProcessBranch key={node.id} node={node} metric={metric} total={detailTotal} color={groupColor(node.id, palette)} depth={0} query={query} onDrill={nodes => navigate([...detailTrail, ...nodes.map(node => processGroup(node, metric))])} />)}
              {!details.length ? <p className={`p-4 text-xs ${muted}`}>No process measurements available in this level.</p> : query && !details.some(node => processMatches(node, query)) ? <p className={`p-4 text-xs ${muted}`}>No matching processes or groups.</p> : null}</>}
      </div>
    </div>
  </>;
}

export function ResourceMonitor() {
  const { theme } = useTheme();
  const palette = theme.accentPalette.length ? theme.accentPalette : ['var(--color-highlight)'];
  const [metric, setMetric] = useState<Metric>('storage');
  const [processes, setProcesses] = useState<ProcessSnapshot | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [processError, setProcessError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(false);
  const storageGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let processTimer: ReturnType<typeof setTimeout>;
    let storageTimer: ReturnType<typeof setTimeout>;
    async function pollProcesses() {
      try {
        if (document.visibilityState !== 'hidden') {
          const data = await getResourceProcesses(controller.signal);
          if (controller.signal.aborted) return;
          setProcesses(data); setProcessError(null);
          setSamples(previous => previous.at(-1)?.at === data.sampled_at ? previous : [...previous.slice(-59), { at: data.sampled_at, cpu: data.cpu_percent, memory: data.memory_unavailable_count ? null : data.memory_bytes }]);
        }
      } catch (error) { if (!controller.signal.aborted) setProcessError(message(error)); }
      if (!controller.signal.aborted) processTimer = setTimeout(pollProcesses, 10000);
    }
    async function pollStorage() {
      const generation = storageGeneration.current;
      let scanning = true;
      try {
        if (document.visibilityState !== 'hidden') {
          const data = await getResourceStorage(controller.signal);
          if (controller.signal.aborted) return;
          if (generation === storageGeneration.current) { setStorage(data); setStorageError(null); }
          scanning = data.scanning;
        }
      } catch (error) { if (!controller.signal.aborted && generation === storageGeneration.current) setStorageError(message(error)); }
      if (!controller.signal.aborted) storageTimer = setTimeout(pollStorage, scanning ? 2000 : 5000);
    }
    void pollProcesses(); void pollStorage();
    return () => { mounted.current = false; controller.abort(); clearTimeout(processTimer); clearTimeout(storageTimer); };
  }, []);

  async function refreshStorage() {
    setRefreshing(true);
    storageGeneration.current++;
    try { const data = await refreshResourceStorage(); if (mounted.current) { setStorage(data); setStorageError(null); } }
    catch (error) { if (mounted.current) setStorageError(message(error)); }
    finally { if (mounted.current) setRefreshing(false); }
  }

  const chooseMetric = (next: Metric) => setMetric(next);

  return <div className="space-y-5 text-[var(--color-text)]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className={`flex items-center gap-2 text-xs ${muted}`}><span className="h-1.5 w-1.5 rounded-full bg-[var(--color-highlight)]" />Connected Grove host<span className="opacity-40">/</span>Managed resources</div>
      <span className={`text-[10px] ${muted}`}>{processes ? `${processes.process_count} processes · ${processError ? 'last successful sample' : 'updates every 10s'}` : 'Connecting…'}</span>
    </div>
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      <MetricCard active={metric === 'cpu'} onClick={() => chooseMetric('cpu')} label="CPU" icon={<Cpu size={15} />} value={processes?.cpu_percent == null ? '—' : percent(processes.cpu_percent)} subtitle={processes?.cpu_percent == null ? 'Collecting samples' : `Across ${processes.logical_cpus} logical cores`}><Sparkline values={samples.flatMap(s => s.cpu === null ? [] : [s.cpu])} color="var(--color-highlight)" /></MetricCard>
      <MetricCard active={metric === 'memory'} onClick={() => chooseMetric('memory')} label={processes ? memoryLabel(processes) : 'Memory'} icon={<MemoryStick size={15} />} value={processes ? memoryValue(processes.memory_bytes, processes.memory_unavailable_count) : '—'} subtitle={processes?.memory_basis === 'physical_footprint' ? 'Process charges · includes compressed / swapped' : 'Shared pages may be counted repeatedly'}><Sparkline values={samples.flatMap(s => s.memory === null ? [] : [s.memory])} color="var(--color-info)" /></MetricCard>
      <MetricCard active={metric === 'storage'} onClick={() => chooseMetric('storage')} label="Storage" icon={<HardDrive size={15} />} value={storage?.root ? bytes(storage.root.bytes) : '—'} subtitle={storage?.scanning ? 'Scanning .grove…' : 'All files in .grove'}><div className="mt-3 flex h-9 items-center"><div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]">{storage?.groups.map(g => <span key={g.id} style={{ width: `${storage.root?.bytes ? g.bytes / storage.root.bytes * 100 : 0}%`, backgroundColor: groupColor(storageKey(g), palette) }} />)}</div></div></MetricCard>
    </div>

    {(processError || storageError || storage?.error) && <div role="alert" className="rounded-lg bg-[var(--color-warning)]/10 p-3 text-xs text-[var(--color-warning)]">{[processError && `Processes: ${processError}`, (storageError || storage?.error) && `Storage: ${storageError || storage?.error}`].filter(Boolean).join(' · ')} Previous measurements remain visible where available.</div>}

    <ResourceExplorer key={metric} metric={metric} processes={processes} storage={storage} palette={palette}
      refreshing={refreshing} onRefresh={() => void refreshStorage()} processError={processError} storageError={storageError} />
    <p className={`text-[10px] leading-relaxed ${muted}`}>{metric === 'storage' ? <>{storage?.scanned_at ? `Scanned ${new Date(storage.scanned_at).toLocaleString()}. ` : ''}{storage?.root?.files.toLocaleString() ?? 'All'} file entries · {storage?.size_basis === 'allocated' ? 'Allocated file bytes' : 'Logical file sizes'} · worktrees included. Hard links count once; symbolic-link targets and original repositories outside .grove are excluded. Filesystem metadata and shared copy-on-write blocks may differ from disk free space.{!!storage?.read_errors && ` ${storage.read_errors} entries could not be read; totals are partial.`}</> : <>Local Grove runtime, recognized task processes and their descendants. CPU is a share of the host’s total capacity; new processes need two samples. {processes?.memory_basis === 'physical_footprint' ? 'Memory footprint sums macOS process charges, including compressed and swapped memory; it is not current physical RAM usage and may exceed installed RAM.' : 'Memory is a sum of process RSS, not host RAM usage. Shared pages can be counted repeatedly, so the sum may exceed installed RAM.'}{!!processes?.memory_unavailable_count && ` Memory unavailable for ${processes.memory_unavailable_count} ${processes.memory_unavailable_count === 1 ? 'process' : 'processes'}; totals and shares include measured processes only.`} Remote agents and processes the OS cannot attribute are unavailable.{processes && ` Sampled ${new Date(processes.sampled_at).toLocaleTimeString()}.`}</>}</p>
  </div>;
}
