import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, CircleAlert, Link2, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { submitConnectRegistration, cancelConnectRegistration, beginConnectRegistration, createConnect, deleteConnect, finishConnectRegistration, getConnectRegistration, listConnectPlatforms, listConnects, listProjects, updateConnect, verifyConnect, verifyConnectCredentials, type ChatSessionResponse, type ConnectInput, type ConnectItem, type ConnectPlatform, type ConnectRegistration, type ProjectListItem, type TaskResponse } from '../../api';
import { useTheme } from '../../context';
import { useIsMobile } from '../../hooks/useIsMobile';
import { getProjectStyle } from '../../utils/projectStyle';
import { ConfirmDialog } from '../Dialogs';
import { Button, DialogShell, Input, Switch } from '../ui';
import { useConnectTargets } from './useConnectTargets';
import { getConnectFrontendAdapter } from './ConnectAdapters/registry';

type NewStep = 'platform' | 'qr' | 'manual';
const newDraft = (domain = 'feishu', platform = 'feishu'): ConnectInput => ({ name: `${platform} Connect`, platform, domain, enabled: true, adapter_config: {}, project_id: '', task_id: '', session_id: '' });

function draftFromItem(item: ConnectItem, fieldKeys: string[]): ConnectInput {
  const adapter_config = Object.fromEntries(fieldKeys.filter((key) => key in item.adapter_config).map((key) => [key, item.adapter_config[key]]));
  return { name: item.name, platform: item.platform, domain: item.domain, enabled: item.enabled, adapter_config, project_id: item.project_id, task_id: item.task_id, session_id: item.session_id };
}

function savedTarget(item: ConnectItem) { return { id: item.id, project_id: item.project_id, task_id: item.task_id, session_id: item.session_id }; }

export function ConnectDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [items, setItems] = useState<ConnectItem[] | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshRef = useRef({ active: false, request: 0 });
  const load = useCallback(async () => {
    const refresh = refreshRef.current;
    if (!refresh.active) return;
    const request = ++refresh.request;
    try {
      const nextItems = await listConnects();
      if (refresh.active && refreshRef.current === refresh && request === refresh.request) {
        setItems(nextItems);
        setRefreshError(null);
      }
    } catch (cause) {
      if (refresh.active && refreshRef.current === refresh && request === refresh.request) setRefreshError(messageOf(cause));
      throw cause;
    }
  }, []);
  useEffect(() => {
    if (!isOpen) return;
    const refresh = { active: true, request: 0 };
    refreshRef.current = refresh;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await load();
      } catch {
        // Keep the last known state and retry after a transient API failure.
      } finally {
        if (refresh.active) timer = window.setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      refresh.active = false;
      window.clearTimeout(timer);
    };
  }, [isOpen, load]);
  return <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-6xl">
    {refreshError && <div role="status" className="p-3 text-xs text-[var(--color-error)]">Could not refresh connection status: {refreshError}. Retrying automatically.</div>}
    {items ? <ConnectManager items={items} onItemsChange={load} onClose={onClose} /> : <div className="p-6 text-sm text-[var(--color-text-muted)]">Loading connections…</div>}
  </DialogShell>;
}

function ConnectManager({ items, onItemsChange, onClose }: { items: ConnectItem[]; onItemsChange: () => Promise<void>; onClose: () => void }) {
  const { isMobile } = useIsMobile();
  const [platforms, setPlatforms] = useState<ConnectPlatform[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new'>(items[0]?.id ?? 'new');
  const [sourceTarget, setSourceTarget] = useState(() => items[0] ? savedTarget(items[0]) : null);
  const [step, setStep] = useState<NewStep>('platform');
  const [draft, setDraft] = useState<ConnectInput>(() => items[0]
    ? draftFromItem(items[0], Object.keys(items[0].adapter_config))
    : newDraft());
  const [flow, setFlow] = useState<ConnectRegistration | null>(null);
  const targetOptions = useConnectTargets(draft.project_id, draft.task_id, draft.session_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishingFlowRef = useRef<string | null>(null);
  const registrationEpoch = useRef(0);
  const activeFlowId = useRef<string | null>(null);
  const registrationTarget = useRef<ConnectItem | null>(null);
  const registrationName = useRef('');
  const selectedIdRef = useRef<string | 'new'>(selectedId);
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);

  // Polling can discover an IM-created session or another target update. Sync
  // only when the user hasn't changed the target since that stored snapshot.
  if (selected && (sourceTarget?.id !== selected.id || sourceTarget.project_id !== selected.project_id || sourceTarget.task_id !== selected.task_id || sourceTarget.session_id !== selected.session_id)) {
    setSourceTarget(savedTarget(selected));
    if (sourceTarget?.id === selected.id && draft.project_id === sourceTarget.project_id && draft.task_id === sourceTarget.task_id && draft.session_id === sourceTarget.session_id) {
      setDraft({ ...draft, project_id: selected.project_id, task_id: selected.task_id, session_id: selected.session_id });
    }
  }

  useEffect(() => { void Promise.all([listConnectPlatforms(), listProjects()]).then(([defs, list]) => { setPlatforms(defs); setProjects(list.projects); }); }, []);

  const cancelRegistration = useCallback(() => {
    registrationEpoch.current += 1;
    const id = activeFlowId.current;
    activeFlowId.current = null;
    registrationTarget.current = null;
    if (id) void cancelConnectRegistration(id).catch(() => {});
    setFlow(null);
    setBusy(false);
  }, []);
  useEffect(() => () => {
    registrationEpoch.current += 1;
    const id = activeFlowId.current;
    activeFlowId.current = null;
    if (id) void cancelConnectRegistration(id).catch(() => {});
  }, []);
  const chooseNew = () => { cancelRegistration(); selectedIdRef.current = 'new'; setSelectedId('new'); setStep('platform'); setDraft(newDraft()); setError(null); };
  const chooseExisting = (item: ConnectItem) => {
    cancelRegistration();
    setStep('platform');
    setSourceTarget(savedTarget(item));
    selectedIdRef.current = item.id;
    setSelectedId(item.id);
    const adapterFields = platforms.find((platform) => platform.id === item.platform)?.config_fields ?? [];
    const advancedKeys = getConnectFrontendAdapter(item.platform).extraConfigKeys;
    setDraft(draftFromItem(item, [...Object.keys(item.adapter_config), ...adapterFields.map((field) => field.key), ...advancedKeys]));
    if (platforms.length === 0) {
      void listConnectPlatforms().then((definitions) => {
        setPlatforms(definitions);
        if (selectedIdRef.current !== item.id) return;
        const fields = definitions.find((platform) => platform.id === item.platform)?.config_fields ?? [];
        setDraft((current) => ({ ...current, adapter_config: draftFromItem(item, [...Object.keys(item.adapter_config), ...fields.map((field) => field.key), ...advancedKeys]).adapter_config }));
      });
    }
    setError(null);
  };
  // Authorization is the moment the connection is persisted — target binding
  // is configuration, done afterwards on the detail page.
  const saveAuthorized = async (authorized: ConnectRegistration, connectionName = draft.name) => {
    if (activeFlowId.current !== authorized.id || finishingFlowRef.current === authorized.id) return;
    const epoch = registrationEpoch.current;
    finishingFlowRef.current = authorized.id;
    setBusy(true);
    setError(null);
    try {
      const created = await finishConnectRegistration({ flow_id: authorized.id, name: connectionName || `${authorized.platform} Connect`, enabled: true, connection_id: registrationTarget.current?.id });
      await onItemsChange();
      if (epoch === registrationEpoch.current) chooseExisting(created);
    } catch (cause) {
      if (epoch === registrationEpoch.current) { finishingFlowRef.current = null; setError(messageOf(cause)); }
    } finally {
      if (epoch === registrationEpoch.current) setBusy(false);
    }
  };
  const startQr = async (domain: string = draft.domain, platform: string = draft.platform, connectionName = draft.name, target = registrationTarget.current) => {
    const oldId = activeFlowId.current;
    const epoch = ++registrationEpoch.current;
    activeFlowId.current = null;
    registrationTarget.current = target;
    registrationName.current = connectionName;
    if (oldId) void cancelConnectRegistration(oldId).catch(() => {});
    finishingFlowRef.current = null;
    setBusy(true);
    setError(null);
    setStep('qr');
    setFlow(null);
    try {
      const begun = await beginConnectRegistration(domain, platform);
      if (epoch !== registrationEpoch.current) { void cancelConnectRegistration(begun.id).catch(() => {}); return; }
      activeFlowId.current = begun.id;
      setFlow(begun);
      if (begun.state === 'authorized') await saveAuthorized(begun, connectionName);
    } catch (cause) {
      if (epoch === registrationEpoch.current) setError(messageOf(cause));
    } finally {
      if (epoch === registrationEpoch.current) setBusy(false);
    }
  };
  const submitRegistration = async (input: Record<string, unknown>) => {
    const id = activeFlowId.current;
    if (!id) throw new Error('Authorization flow is no longer active');
    const epoch = registrationEpoch.current;
    const next = await submitConnectRegistration(id, input);
    if (epoch !== registrationEpoch.current || activeFlowId.current !== id) return;
    setFlow(next);
    if (next.state === 'authorized') await saveAuthorized(next, registrationName.current);
  };
  const verifyManual = async () => {
    cancelRegistration();
    setBusy(true);
    setError(null);
    try {
      await verifyConnectCredentials({ platform: draft.platform, domain: draft.domain, adapter_config: draft.adapter_config });
      const created = await createConnect({ ...draft, project_id: '', task_id: '', session_id: '' });
      await onItemsChange();
      chooseExisting(created);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!flow || !['waiting_for_scan', 'waiting_for_input'].includes(flow.state)) return;
    let active = true;
    let timer: number | undefined;
    const epoch = registrationEpoch.current;
    const poll = async () => {
      try {
        const next = await getConnectRegistration(flow.id);
        if (!active || epoch !== registrationEpoch.current || activeFlowId.current !== flow.id) return;
        setFlow(next);
        if (next.state === 'authorized') await saveAuthorized(next, registrationName.current);
      } catch { /* A transient status failure retries without consuming the flow. */ }
      finally { if (active) timer = window.setTimeout(() => void poll(), 1500); }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { active = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  useEffect(() => {
    if (!flow || !['waiting_for_scan', 'waiting_for_input'].includes(flow.state)) return;
    const refreshIn = Math.max(0, flow.expires_at * 1000 - Date.now() - 30_000);
    const timer = window.setTimeout(() => {
      void startQr(flow.domain, flow.platform, registrationName.current);
    }, refreshIn);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  return <div className={`flex min-h-0 flex-col overflow-hidden bg-[var(--color-bg)] ${isMobile ? 'h-[min(780px,calc(100dvh-5rem))]' : 'h-[min(780px,calc(100vh-3rem))] min-h-[560px] rounded-2xl border border-[var(--color-border)] shadow-2xl'}`}>
    <header className={`flex h-16 shrink-0 items-center gap-3 border-b border-[var(--color-border)] ${isMobile ? 'px-4' : 'px-5'}`}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#3370ff] to-[#5ed3ff]/80 shadow-sm shadow-[#3370ff]/30"><Link2 className="h-4 w-4 text-white" /></div>
      <div className="min-w-0 flex-1"><h1 className="text-base font-semibold text-[var(--color-text)]">IM Connect</h1><p className="truncate text-xs text-[var(--color-text-muted)]">External messages, native Grove Sessions</p></div>
      <button type="button" aria-label="Close IM Connect" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"><X className="h-4 w-4" /></button>
    </header>
    <div className={`flex min-h-0 flex-1 ${isMobile ? 'flex-col' : 'flex-row'}`}>
      <aside className={`shrink-0 bg-[var(--color-bg-secondary)]/60 p-3 ${isMobile ? 'border-b border-[var(--color-border)]' : 'w-[300px] overflow-y-auto border-r border-[var(--color-border)]'}`}>
        <nav aria-label="Connections" className={isMobile ? 'flex items-center gap-2 overflow-x-auto overscroll-x-contain' : 'space-y-1'}>
          <button type="button" onClick={chooseNew} aria-label="New connection" aria-pressed={selectedId === 'new'} className={`flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${isMobile ? '' : 'mb-3 w-full py-3'} ${selectedId === 'new' ? 'border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]' : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]'}`}><Plus className="h-4 w-4" />{isMobile ? 'New' : 'New connection'}</button>
          {items.map((item) => <button type="button" key={item.id} onClick={() => chooseExisting(item)} aria-pressed={selectedId === item.id} className={`group relative flex min-h-11 items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-3 text-left transition-colors ${isMobile ? 'max-w-[240px] shrink-0 border' : 'w-full border border-transparent'} ${selectedId === item.id ? 'border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10' : 'border-transparent hover:bg-[var(--color-bg-tertiary)]/60'}`}>
            <PlatformMark id={item.platform} size={isMobile ? 18 : 26} />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-[var(--color-text)]">{item.name}</div>{!isMobile && <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{item.session_id ? item.target.agent || 'Grove Session' : item.task_id ? 'New session on first message' : 'Not configured'}</div>}</div>
            <StatusDot state={item.runtime.state} />
          </button>)}
        </nav>
      </aside>
      <main className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain ${isMobile ? 'p-4 pb-[max(1rem,env(safe-area-inset-bottom))]' : 'p-6'}`}>{selected && step !== 'qr' ? <ExistingDetail item={selected} draft={draft} setDraft={setDraft} projects={projects} {...targetOptions} busy={busy} setBusy={setBusy} error={error} setError={setError} onChanged={onItemsChange} onDeleted={chooseNew} reauthorize={() => startQr(selected.domain, selected.platform, selected.name, selected)} /> : <NewConnection isMobile={isMobile} step={step} setStep={setStep} platforms={platforms} draft={draft} setDraft={setDraft} flow={flow} busy={busy} error={error} startQr={startQr} verifyManual={verifyManual} submitRegistration={submitRegistration} cancelRegistration={cancelRegistration} />}</main>
    </div>
  </div>;
}

interface NewProps { isMobile: boolean; step: NewStep; setStep: (step: NewStep) => void; platforms: ConnectPlatform[]; draft: ConnectInput; setDraft: React.Dispatch<React.SetStateAction<ConnectInput>>; flow: ConnectRegistration | null; busy: boolean; error: string | null; startQr: (domain?: string, platform?: string, connectionName?: string) => Promise<void>; verifyManual: () => Promise<void>; submitRegistration: (input: Record<string, unknown>) => Promise<void>; cancelRegistration: () => void }
function NewConnection(props: NewProps) {
  const { isMobile, step, setStep, platforms, draft, setDraft, flow, busy, error } = props;
  const selectedPlatform = platforms.find((platform) => platform.id === draft.platform);
  const patchConfig = (key: string, value: string) => setDraft((current) => ({ ...current, adapter_config: { ...current.adapter_config, [key]: value } }));
  if (step === 'platform') {
    const available = platforms.filter((platform) => platform.available);
    const upcoming = platforms.filter((platform) => !platform.available);
    return <Page title="New connection" description="Choose where you want to talk to Grove.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">{available.map((platform) => <button type="button" key={platform.id} disabled={busy} onClick={() => { const domain = platform.id; const name = `${platform.name} Connect`; setDraft({ ...newDraft(domain, platform.id), name }); if (platform.setup_modes.some((mode) => mode === 'qr' || mode === 'oauth')) void props.startQr(domain, platform.id, name); else setStep('manual'); }} className={`group relative flex items-center overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-left transition-all enabled:hover:border-[var(--color-highlight)]/40 ${isMobile ? 'min-h-[84px] gap-3 p-4' : 'min-h-[104px] gap-4 p-5 enabled:hover:-translate-y-0.5 enabled:hover:shadow-lg enabled:hover:shadow-black/20'}`}>
        <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-[#3370ff]/10 blur-2xl" />
        <PlatformMark id={platform.id} size={isMobile ? 32 : 48} />
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-semibold text-[var(--color-text)]">{platform.name}</div><div className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{platform.description}</div></div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors group-hover:border-[var(--color-highlight)]/40 group-hover:text-[var(--color-highlight)]"><ArrowRight className="h-3.5 w-3.5" /></div>
      </button>)}</div>
      {upcoming.length > 0 && <div className={isMobile ? 'mt-5' : 'mt-8'}><div className="mb-3 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"><span>More platforms</span><span className="h-px flex-1 bg-[var(--color-border)]" /></div><div className={isMobile ? 'grid grid-cols-3 gap-2' : 'flex flex-wrap gap-2'}>{upcoming.map((platform) => <div key={platform.id} title={platform.description} className={`flex min-w-0 items-center border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 opacity-70 ${isMobile ? 'flex-col gap-1.5 rounded-xl px-2 py-3' : 'gap-2.5 rounded-full py-1.5 pl-2 pr-3'}`}><PlatformMark id={platform.id} size={isMobile ? 16 : 20} /><span className="max-w-full truncate text-xs text-[var(--color-text-muted)]">{platform.name}</span><span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Soon</span></div>)}</div></div>}
      {error && <ErrorText>{error}</ErrorText>}
    </Page>;
  }
  if (step === 'qr') {
    const label = selectedPlatform?.name ?? draft.platform;
    const adapter = getConnectFrontendAdapter(draft.platform);
    const Authorization = adapter.Authorization;
    return <Page title={`Connect ${label}`} description={adapter.description(label)} back={() => { props.cancelRegistration(); setStep('platform'); }}>
      <div className="mx-auto max-w-2xl space-y-5">
        <Authorization key={flow?.id ?? draft.platform} platform={selectedPlatform} draft={draft} setDraft={setDraft} flow={flow} busy={busy} refresh={() => props.startQr()} verifyManual={props.verifyManual} submit={props.submitRegistration} />
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Page>;
  }
  if (step === 'manual') {
    const label = selectedPlatform?.name ?? 'provider';
    return <Page title={`Connect ${label}`} description={`Enter the configuration required by the ${label} provider.`} back={() => setStep('platform')}>
      <div className="mx-auto max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5">
        <div className="grid gap-4 sm:grid-cols-2">{(selectedPlatform?.config_fields ?? []).map((field) => <Input key={field.key} label={field.label} type={field.secret ? 'password' : 'text'} value={String(draft.adapter_config[field.key] ?? '')} onChange={(event) => patchConfig(field.key, event.target.value)} placeholder={field.placeholder} />)}</div>
        <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">Configuration is stored on this Connect record and passed only to this provider. Fields marked secret are masked in settings.</p><Button size="sm" className="min-h-11 w-full shrink-0 sm:min-h-0 sm:w-auto" disabled={busy || !(selectedPlatform?.config_fields ?? []).filter((field) => field.required).every((field) => draft.adapter_config[field.key])} onClick={() => void props.verifyManual()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Verify and continue</Button></div>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Page>;
  }
}

interface ExistingProps { item: ConnectItem; draft: ConnectInput; setDraft: React.Dispatch<React.SetStateAction<ConnectInput>>; projects: ProjectListItem[]; tasks: TaskResponse[]; sessions: ChatSessionResponse[]; tasksLoading: boolean; sessionsLoading: boolean; targetError: string | null; reloadTargets: () => void; busy: boolean; setBusy: (value: boolean) => void; error: string | null; setError: (value: string | null) => void; onChanged: () => Promise<void>; onDeleted: () => void; reauthorize: () => Promise<void> }
function ExistingDetail({ item, draft, setDraft, projects, tasks, sessions, tasksLoading, sessionsLoading, targetError, reloadTargets, busy, setBusy, error, setError, onChanged, onDeleted, reauthorize }: ExistingProps) {
  const adapter = getConnectFrontendAdapter(item.platform);
  const AdapterSettings = adapter.Settings;
  const connectionDetail = adapter.connectionDetail?.(item);
  const [editingName, setEditingName] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const patch = <K extends keyof ConnectInput>(key: K, value: ConnectInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (next: ConnectInput) => {
    setDraft(next);
    setBusy(true);
    setError(null);
    try { await updateConnect(item.id, next); await onChanged(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const target = item.target;
  const projectId = draft.project_id;
  const taskId = draft.task_id;
  const sessionId = draft.session_id;
  const routedDraft = { ...draft, project_id: projectId, task_id: taskId, session_id: sessionId };
  const toggle = (enabled: boolean) => void save({ ...routedDraft, enabled });
  const pickProject = (nextProjectId: string) => void save({ ...routedDraft, project_id: nextProjectId, task_id: '', session_id: '' });
  const pickTask = (nextTaskId: string) => void save({ ...routedDraft, task_id: nextTaskId, session_id: '' });
  const pickSession = (nextSessionId: string) => void save({ ...routedDraft, session_id: nextSessionId === '__new__' ? '' : nextSessionId });
  const commitName = () => { setEditingName(false); const name = draft.name.trim(); if (name && name !== item.name) void save({ ...routedDraft, name }); };
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyConnect(item.id);
      await onChanged();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteConnect(item.id);
      setDeleteConfirmOpen(false);
      await onChanged();
      onDeleted();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return <>
  <Page
    title={<span className="flex min-w-0 items-center gap-2.5"><PlatformMark id={item.platform} size={26} />{editingName ? <span className="min-w-0 max-w-64 flex-1"><Input autoFocus value={draft.name} onChange={(event) => patch('name', event.target.value)} onBlur={commitName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft((current) => ({ ...current, name: item.name })); setEditingName(false); } }} /></span> : <button type="button" className="group flex min-w-0 items-center gap-1.5 text-left" onClick={() => setEditingName(true)}><span className="truncate">{item.name}</span><Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 max-[1199px]:opacity-100" /></button>}</span>}
    description={<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-text-muted)]"><StatusLabel state={item.runtime.state} detail={item.runtime.detail} /><span>·</span><RegionBadge domain={item.domain} label={adapter.regionLabel} />{connectionDetail !== undefined && <><span>·</span><span className="font-mono text-xs">{connectionDetail}</span></>}{item.bound_chat_id && <span className="rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-xs text-[var(--color-success)]">Chat bound</span>}</span>}
    trailing={<Switch checked={draft.enabled} onChange={toggle} label="Enable connection" />}
    ><div className="space-y-4">
    <section className={`space-y-3 rounded-xl border p-4 ${item.project_id && item.task_id ? 'border-[var(--color-border)]' : 'border-[var(--color-highlight)]/40 bg-[var(--color-highlight)]/5'}`}>
      <div>
        <div className="text-sm font-medium text-[var(--color-text)]">Messages route to</div>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">Incoming IM messages enter this session and reuse its queue and agent. Changes apply immediately.</p>
      </div>
      <TargetSelect value={projectId} placeholder="Select project" disabled={busy} options={projects.map((entry) => ({ id: entry.id, title: entry.name, subtitle: entry.path, icon: <ProjectGlyph id={entry.id} /> }))} onSelect={(id) => void pickProject(id)} />
      <TargetSelect value={taskId} placeholder={tasksLoading ? 'Loading tasks…' : taskId ? 'Saved task unavailable' : projectId ? 'Select task' : 'Pick a project first'} disabled={!projectId || busy || tasksLoading} options={tasks.map((entry) => ({ id: entry.id, title: entry.name, subtitle: entry.status, icon: <LetterGlyph id={entry.id} label={entry.name} /> }))} onSelect={(id) => void pickTask(id)} />
      <TargetSelect value={sessionId || (taskId ? '__new__' : '')} placeholder={sessionsLoading ? 'Loading sessions…' : sessionId ? 'Saved session unavailable' : taskId ? 'New session (created on first message)' : 'Pick a task first'} disabled={!taskId || busy || sessionsLoading} options={[{ id: '__new__', title: 'New session', subtitle: 'Created when the first message arrives', badge: 'Auto', icon: <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]"><Plus className="h-3.5 w-3.5" /></span> }, ...sessions.map((entry) => ({ id: entry.id, title: entry.title, subtitle: entry.agent, icon: <LetterGlyph id={entry.id} label={entry.title} /> }))]} onSelect={pickSession} />
      {targetError && <div className="text-xs text-[var(--color-error)]">{targetError}<Button variant="ghost" size="sm" onClick={reloadTargets}>Reload targets</Button></div>}
      {item.session_id && <p className="text-xs text-[var(--color-text-muted)]">Agent {target.agent || 'unknown'} · {target.queue_mode === 'compact' ? 'Compact queue' : 'Separate queue'} · {target.model ?? 'session default model'}{target.mode ? ` · ${target.mode}${target.thought_level ? `/${target.thought_level}` : ''}` : ''}</p>}
      {!item.session_id && item.task_id && <p className="text-xs text-[var(--color-text-muted)]">A new session is created with the task's default agent when the first IM message arrives.</p>}
    </section>
    {AdapterSettings && <AdapterSettings key={item.id} item={item} draft={routedDraft} busy={busy} save={save} reauthorize={reauthorize} />}
    {item.runtime.detail && <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-xs text-[var(--color-text-muted)]">
      <div className="whitespace-pre-wrap break-words">{item.runtime.detail}</div>
      <p>Connection logs: .grove/logs/connect.log in your user folder.</p>
      <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(`Connection: ${item.id}\nPlatform: ${item.platform} (${item.domain})\nStatus: ${item.runtime.state}\n${item.runtime.detail}`).catch((cause) => setError(messageOf(cause)))}>Copy diagnostics</Button>
    </div>}
    {error && <ErrorText onDismiss={() => setError(null)}>{error}</ErrorText>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-4">
      <Button variant="secondary" size="sm" onClick={() => void verify()} disabled={busy}>
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
        {busy ? 'Verifying…' : item.runtime.state === 'error' ? 'Retry connection' : 'Verify connection'}
      </Button>
      <Button variant="ghost" size="sm" className="!text-[var(--color-text-muted)] hover:!text-[var(--color-error)]" onClick={() => setDeleteConfirmOpen(true)} disabled={busy}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete connection</Button>
    </div>
  </div></Page>
  <ConfirmDialog
    isOpen={deleteConfirmOpen}
    title="Delete connection"
    variant="danger"
    confirmLabel="Delete connection"
    cancelLabel="Keep connection"
    actionsDisabled={busy}
    onConfirm={() => void confirmDelete()}
    onCancel={() => { if (!busy) setDeleteConfirmOpen(false); }}
    message={<div className="space-y-2">
      <p>Are you sure you want to delete <strong className="text-[var(--color-text)]">{item.name}</strong>?</p>
      <p>This removes the IM Connect configuration and stops its connection. Your Grove projects, tasks, and sessions are not deleted.</p>
    </div>}
  />
  </>;
}

function Page({ title, description, back, trailing, children }: { title: React.ReactNode; description: React.ReactNode; back?: () => void; trailing?: React.ReactNode; children: React.ReactNode }) { return <div className="mx-auto max-w-2xl"><div className="mb-6 flex items-start gap-3 max-[1199px]:mb-4">{back && <Button variant="ghost" size="sm" className="min-h-11 min-w-11 shrink-0" title="Back" onClick={back}><ArrowLeft className="h-4 w-4" /></Button>}<div className="min-w-0 flex-1"><h3 className="break-words text-lg font-semibold text-[var(--color-text)] max-[1199px]:text-base">{title}</h3><p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">{description}</p></div>{trailing}</div>{children}</div>; }

function RegionBadge({ domain, label }: { domain: string; label?: string }) { return <span className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">{label ?? domain.split('/').at(-1)}</span>; }

function ProjectGlyph({ id }: { id: string }) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(id, theme.accentPalette);
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: color.bg }}><Icon className="h-3.5 w-3.5" style={{ color: color.fg }} /></span>;
}

// Colored letter tile for tasks and sessions: hue derived from the id via
// FNV-1a (same scheme as getProjectStyle), letter from the display name —
// works for both latin and CJK titles.
function LetterGlyph({ id, label }: { id: string; label: string }) {
  const { theme } = useTheme();
  const palette = theme.accentPalette;
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const color = palette && palette.length > 0 ? palette[(hash >>> 0) % palette.length] : '#3b82f6';
  const letter = (label.trim()[0] ?? '?').toUpperCase();
  return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold leading-none" style={{ backgroundColor: `${color}26`, color }}>{letter}</span>;
}

interface TargetOption { id: string; title: string; subtitle?: string; icon?: React.ReactNode; badge?: string }
function TargetSelect({ value, placeholder, disabled, options, onSelect }: { value: string; placeholder: string; disabled?: boolean; options: TargetOption[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.id === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => option.title.toLocaleLowerCase().includes(normalized) || (option.subtitle ?? '').toLocaleLowerCase().includes(normalized));
  }, [options, query]);
  const close = useCallback(() => { setOpen(false); setQuery(''); setHighlight(0); }, []);
  const update = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const gap = 6;
    const padding = 12;
    const headerHeight = 49;
    const availableBelow = window.innerHeight - box.bottom - gap - padding;
    const availableAbove = box.top - gap - padding;
    const openAbove = availableBelow < 220 && availableAbove > availableBelow;
    const maxListHeight = Math.max(0, Math.min(280, (openAbove ? availableAbove : availableBelow) - headerHeight));
    const top = openAbove ? box.top - gap - headerHeight - maxListHeight : box.bottom + gap;
    setRect({ top: Math.max(padding, top), left: box.left, width: box.width, maxHeight: maxListHeight });
  }, []);
  useEffect(() => {
    if (!open) return;
    update();
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (event: MouseEvent) => { if (!triggerRef.current?.contains(event.target as Node) && !popRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [close, open, update]);
  const pick = (option: TargetOption) => { if (disabled) return; onSelect(option.id); close(); };
  const search = (next: string) => { setQuery(next); setHighlight(0); };
  return <>
    <button type="button" ref={triggerRef} disabled={disabled} onClick={() => { if (open) close(); else { setOpen(true); setQuery(''); setHighlight(0); } }} aria-haspopup="listbox" aria-expanded={open} className={`flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-left text-sm transition-colors hover:border-[var(--color-highlight)]/40 disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>
      {selected ? <span className="flex min-w-0 flex-1 items-center gap-2.5">{selected.icon}<span className="min-w-0 flex-1"><span className="block truncate">{selected.title}</span></span>{selected.badge && <span className="shrink-0 rounded-full bg-[var(--color-highlight)]/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-highlight)]">{selected.badge}</span>}</span> : <span className="flex-1">{placeholder}</span>}
      <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && rect && typeof document !== 'undefined' && createPortal(
      <div ref={popRef} role="dialog" onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length)); } else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((index) => (filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length)); } else if (event.key === 'Enter') { event.preventDefault(); const option = filtered[highlight]; if (option) pick(option); } else if (event.key === 'Escape') { event.preventDefault(); close(); triggerRef.current?.focus(); } }} style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 9999 }} className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5"><Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" /><input ref={inputRef} value={query} onChange={(event) => search(event.target.value)} placeholder="Search…" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]" /></div>
        <div role="listbox" style={{ maxHeight: rect.maxHeight }} className="overflow-y-auto overscroll-contain py-1">
          {filtered.length === 0 ? <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">No matches</div> : filtered.map((option, index) => <button type="button" key={option.id} role="option" aria-selected={index === highlight} onMouseEnter={() => setHighlight(index)} onClick={() => pick(option)} className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${index === highlight ? 'bg-[var(--color-highlight)]/10' : 'hover:bg-[var(--color-bg-tertiary)]'}`}>
            {option.icon ?? <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-tertiary)] text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">{option.title.slice(0, 2)}</span>}
            <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-sm font-medium text-[var(--color-text)]">{option.title}</span>{option.badge && <span className="shrink-0 rounded-full bg-[var(--color-highlight)]/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-highlight)]">{option.badge}</span>}</span>{option.subtitle && <span className="block truncate text-xs text-[var(--color-text-muted)]">{option.subtitle}</span>}</span>
            {option.id === value && <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--color-highlight)]" />}
          </button>)}
        </div>
      </div>,
      document.body,
    )}
  </>;
}

const TELEGRAM_PATH = 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z';
const SLACK_PATH = 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z';
const DISCORD_PATH = 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z';

function PlatformMark({ id, size }: { id: string; size: number }) {
  const Mark = getConnectFrontendAdapter(id).Mark;
  if (Mark) return <Mark size={size} />;
  if (id === 'telegram') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#26a5e4]/12" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={TELEGRAM_PATH} fill="#26A5E4" /></svg></div>;
  if (id === 'slack') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#e01e5a]/10" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={SLACK_PATH} fill="#E01E5A" /></svg></div>;
  if (id === 'discord') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#5865f2]/12" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={DISCORD_PATH} fill="#5865F2" /></svg></div>;
  if (id.startsWith('plugin:')) return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]" style={{ width: size + 12, height: size + 12 }}><Link2 style={{ width: size, height: size }} /></div>;
  return <div className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size + 12, height: size + 12, background: 'linear-gradient(135deg, rgba(94,211,255,0.16), rgba(51,112,255,0.12))' }}><Link2 size={size} /></div>;
}

function StatusDot({ state }: { state: string }) { return <span className={`h-2 w-2 shrink-0 rounded-full ${state === 'online' ? 'bg-[var(--color-success)] shadow-[0_0_4px_var(--color-success)]' : state === 'error' ? 'bg-[var(--color-error)] shadow-[0_0_4px_var(--color-error)]' : 'bg-[var(--color-text-muted)]'}`} />; }
function StatusLabel({ state, detail }: { state: string; detail?: string }) { return <span title={detail} className="inline-flex items-center gap-2"><StatusDot state={state} /><span className="capitalize">{state}</span></span>; }
function ErrorText({ children, onDismiss }: { children: React.ReactNode; onDismiss?: () => void }) { return <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{children}</span>{onDismiss && <button type="button" onClick={onDismiss} className="shrink-0 text-[var(--color-error)]/70 hover:text-[var(--color-error)]" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>}</div>; }
function messageOf(cause: unknown) { return (cause as { message?: string })?.message ?? String(cause); }
