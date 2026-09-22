import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, CircleAlert, ExternalLink, Link2, Loader2, Pencil, Plus, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import { beginConnectRegistration, createConnect, deleteConnect, finishConnectRegistration, getConnectRegistration, getProject, listChats, listConnectPlatforms, listConnects, listProjects, listTasks, updateConnect, verifyConnect, verifyConnectCredentials, type ChatSessionResponse, type ConnectInput, type ConnectItem, type ConnectPlatform, type ConnectRegistration, type ProjectListItem, type TaskResponse } from '../../api';
import { useTheme } from '../../context';
import { getProjectStyle } from '../../utils/projectStyle';
import { ConfirmDialog } from '../Dialogs';
import { Button, DialogShell, Input, Switch } from '../ui';

type NewStep = 'platform' | 'qr' | 'manual';
const newDraft = (domain = 'feishu', platform = 'feishu'): ConnectInput => ({ name: domain === 'lark' ? 'Lark Connect' : `${platform} Connect`, platform, domain, enabled: true, adapter_config: {}, project_id: '', task_id: '', session_id: '' });

const ADVANCED_CONFIG_FIELDS = [
  { key: 'reconnect_count', label: 'Reconnect attempts', placeholder: 'Feishu default (unlimited)', min: '-1', description: '-1 uses the official unlimited reconnect behavior.' },
  { key: 'reconnect_interval_secs', label: 'Reconnect interval (seconds)', placeholder: 'Feishu default (120)', min: '1', description: 'Leave blank to use the interval returned by Feishu.' },
  { key: 'heartbeat_timeout_secs', label: 'Heartbeat timeout (seconds)', placeholder: 'Disabled by default', min: '1', description: 'Optional local liveness guard; leave blank for SDK behavior.' },
] as const;
type AdvancedConfigKey = typeof ADVANCED_CONFIG_FIELDS[number]['key'];
type AdvancedDraft = Record<AdvancedConfigKey, string>;

function readAdvancedConfig(config: Record<string, unknown>): AdvancedDraft {
  return Object.fromEntries(ADVANCED_CONFIG_FIELDS.map(({ key }) => [key, String(config[key] ?? '')])) as AdvancedDraft;
}

function draftFromItem(item: ConnectItem, fieldKeys: string[]): ConnectInput {
  const adapter_config = Object.fromEntries(fieldKeys.filter((key) => key in item.adapter_config).map((key) => [key, item.adapter_config[key]]));
  return { name: item.name, platform: item.platform, domain: item.domain, enabled: item.enabled, adapter_config, project_id: item.project_id, task_id: item.task_id, session_id: item.session_id };
}

export function ConnectDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [items, setItems] = useState<ConnectItem[]>([]);
  const load = useCallback(async () => { setItems(await listConnects()); }, []);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    listConnects().then((nextItems) => {
      if (!cancelled) setItems(nextItems);
    }).catch(() => {
      // The manager can still render its empty state; the next open retries.
    });
    return () => { cancelled = true; };
  }, [isOpen]);
  return <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-6xl">
    <ConnectManager items={items} onItemsChange={load} onClose={onClose} />
  </DialogShell>;
}

function ConnectManager({ items, onItemsChange, onClose }: { items: ConnectItem[]; onItemsChange: () => Promise<void>; onClose: () => void }) {
  const [platforms, setPlatforms] = useState<ConnectPlatform[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'new'>(items[0]?.id ?? 'new');
  const [step, setStep] = useState<NewStep>('platform');
  const [draft, setDraft] = useState<ConnectInput>(() => items[0]
    ? draftFromItem(items[0], ['app_id', 'app_secret', ...ADVANCED_CONFIG_FIELDS.map((field) => field.key)])
    : newDraft());
  const [flow, setFlow] = useState<ConnectRegistration | null>(null);
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishingFlowRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | 'new'>(selectedId);
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);

  useEffect(() => { void Promise.all([listConnectPlatforms(), listProjects()]).then(([defs, list]) => { setPlatforms(defs); setProjects(list.projects); }); }, []);

  // listTasks deliberately omits the synthetic Local Task; Connect can route
  // to it like any other task, so merge it back in from the project detail.
  const fetchTaskOptions = async (projectId: string): Promise<TaskResponse[]> => {
    const [tasks, detail] = await Promise.all([listTasks(projectId), getProject(projectId).catch(() => null)]);
    return detail?.local_task ? [detail.local_task, ...tasks] : tasks;
  };

  const chooseNew = () => { selectedIdRef.current = 'new'; setSelectedId('new'); setStep('platform'); setDraft(newDraft()); setFlow(null); setError(null); };
  const chooseExisting = (item: ConnectItem) => {
    selectedIdRef.current = item.id;
    setSelectedId(item.id);
    const adapterFields = platforms.find((platform) => platform.id === item.platform)?.config_fields ?? [];
    const advancedKeys = item.platform === 'feishu' || item.platform === 'lark' ? ADVANCED_CONFIG_FIELDS.map((field) => field.key) : [];
    setDraft(draftFromItem(item, [...adapterFields.map((field) => field.key), ...advancedKeys]));
    if (platforms.length === 0) {
      void listConnectPlatforms().then((definitions) => {
        setPlatforms(definitions);
        if (selectedIdRef.current !== item.id) return;
        const fields = definitions.find((platform) => platform.id === item.platform)?.config_fields ?? [];
        setDraft(draftFromItem(item, [...fields.map((field) => field.key), ...advancedKeys]));
      });
    }
    setError(null);
    if (item.project_id) void fetchTaskOptions(item.project_id).then(setTasks);
    if (item.project_id && item.task_id) void listChats(item.project_id, item.task_id).then(setSessions);
  };
  // Authorization is the moment the connection is persisted — target binding
  // is configuration, done afterwards on the detail page.
  const saveAuthorized = async (authorized: ConnectRegistration, connectionName = draft.name) => {
    if (finishingFlowRef.current === authorized.id) return;
    finishingFlowRef.current = authorized.id;
    setBusy(true);
    setError(null);
    try {
      const created = await finishConnectRegistration({ flow_id: authorized.id, name: connectionName || (authorized.domain === 'lark' ? 'Lark Connect' : 'Feishu Connect'), enabled: true });
      await onItemsChange();
      chooseExisting(created);
    } catch (cause) {
      finishingFlowRef.current = null;
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const startQr = async (domain: string = draft.domain, platform: string = draft.platform, connectionName = draft.name) => {
    finishingFlowRef.current = null;
    setBusy(true);
    setError(null);
    setStep('qr');
    setFlow(null);
    try {
      const begun = await beginConnectRegistration(domain, platform);
      setFlow(begun);
      if (begun.state === 'authorized') await saveAuthorized(begun, connectionName);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const verifyManual = async () => {
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
  const loadTasks = async (projectId: string) => { setTasks(projectId ? await fetchTaskOptions(projectId) : []); setSessions([]); setDraft((current) => ({ ...current, project_id: projectId, task_id: '', session_id: '' })); };
  const loadSessions = async (taskId: string) => { setSessions(taskId ? await listChats(draft.project_id, taskId) : []); setDraft((current) => ({ ...current, task_id: taskId, session_id: '' })); };
  useEffect(() => {
    if (!flow || flow.state !== 'waiting_for_scan') return;
    const timer = window.setInterval(() => void getConnectRegistration(flow.id).then((next) => { setFlow(next); if (next.state === 'authorized') void saveAuthorized(next); }).catch(() => {}), 1500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);
  useEffect(() => {
    if (!flow || flow.state !== 'waiting_for_scan') return;
    const refreshIn = Math.max(0, flow.expires_at * 1000 - Date.now() - 30_000);
    const timer = window.setTimeout(() => {
      void beginConnectRegistration(flow.domain, flow.platform).then((next) => { setFlow(next); if (next.state === 'authorized') void saveAuthorized(next); }).catch((cause) => setError(messageOf(cause)));
    }, refreshIn);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  return <div className="flex h-[min(780px,calc(100vh-3rem))] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl">
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#3370ff] to-[#5ed3ff]/80 shadow-sm shadow-[#3370ff]/30"><Link2 className="h-4 w-4 text-white" /></div><div className="flex-1"><h1 className="text-base font-semibold text-[var(--color-text)]">IM Connect</h1><p className="text-xs text-[var(--color-text-muted)]">External messages, native Grove Sessions</p></div><Button variant="ghost" size="sm" aria-label="Close IM Connect" onClick={onClose}><X className="h-4 w-4" /></Button></header>
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]"><aside className="max-h-44 overflow-y-auto border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 p-3 md:max-h-none md:border-b-0 md:border-r"><Button variant="secondary" size="md" className="mb-3 w-full !justify-start !py-3" onClick={chooseNew}><Plus className="mr-2 h-4 w-4" />New connection</Button><div className="space-y-1">{items.map((item) => <button type="button" key={item.id} onClick={() => chooseExisting(item)} className={`group relative flex w-full items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-3 text-left transition-colors ${selectedId === item.id ? 'bg-[var(--color-bg-tertiary)]' : 'hover:bg-[var(--color-bg-tertiary)]/60'}`}><PlatformMark id={item.platform} size={26} /><div className="min-w-0 flex-1"><div className={`truncate text-sm font-medium ${selectedId === item.id ? 'text-[var(--color-text)]' : 'text-[var(--color-text)]/90'}`}>{item.name}</div><div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{item.session_id ? item.target.agent || 'Grove Session' : item.task_id ? 'New session on first message' : 'Not configured'}</div></div><StatusDot state={item.runtime.state} /></button>)}</div></aside>
      <main className="min-w-0 overflow-y-auto p-4 md:p-6">{selected ? <ExistingDetail item={selected} draft={draft} setDraft={setDraft} projects={projects} tasks={tasks} sessions={sessions} loadTasks={loadTasks} loadSessions={loadSessions} busy={busy} setBusy={setBusy} error={error} setError={setError} onChanged={onItemsChange} onDeleted={chooseNew} /> : <NewConnection step={step} setStep={setStep} platforms={platforms} draft={draft} setDraft={setDraft} flow={flow} busy={busy} error={error} startQr={startQr} verifyManual={verifyManual} />}</main></div>
  </div>;
}

interface NewProps { step: NewStep; setStep: (step: NewStep) => void; platforms: ConnectPlatform[]; draft: ConnectInput; setDraft: React.Dispatch<React.SetStateAction<ConnectInput>>; flow: ConnectRegistration | null; busy: boolean; error: string | null; startQr: (domain?: string, platform?: string, connectionName?: string) => Promise<void>; verifyManual: () => Promise<void> }
function NewConnection(props: NewProps) {
  const { step, setStep, platforms, draft, setDraft, flow, busy, error } = props;
  const selectedPlatform = platforms.find((platform) => platform.id === draft.platform);
  const patchConfig = (key: string, value: string) => setDraft((current) => ({ ...current, adapter_config: { ...current.adapter_config, [key]: value } }));
  if (step === 'platform') {
    const available = platforms.filter((platform) => platform.available);
    const upcoming = platforms.filter((platform) => !platform.available);
    return <Page title="New connection" description="Choose where you want to talk to Grove.">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{available.map((platform) => <button type="button" key={platform.id} disabled={busy} onClick={() => { const domain = platform.id === 'lark' ? 'lark' : platform.id === 'feishu' ? 'feishu' : platform.id; const name = `${platform.name} Connect`; setDraft({ ...newDraft(domain, platform.id), name }); if (platform.setup_modes.some((mode) => mode === 'qr' || mode === 'oauth')) void props.startQr(domain, platform.id, name); else setStep('manual'); }} className="group relative flex min-h-[104px] items-center gap-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-left transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-[var(--color-highlight)]/40 enabled:hover:shadow-lg enabled:hover:shadow-black/20">
        <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-[#3370ff]/10 blur-2xl" />
        <PlatformMark id={platform.id} size={48} />
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2 font-semibold text-[var(--color-text)]">{platform.name}</div><div className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{platform.description}</div></div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors group-hover:border-[var(--color-highlight)]/40 group-hover:text-[var(--color-highlight)]"><ArrowRight className="h-3.5 w-3.5" /></div>
      </button>)}</div>
      {upcoming.length > 0 && <div className="mt-8"><div className="mb-3 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"><span>More platforms</span><span className="h-px flex-1 bg-[var(--color-border)]" /></div><div className="flex flex-wrap gap-2">{upcoming.map((platform) => <div key={platform.id} title={platform.description} className="flex items-center gap-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/60 py-1.5 pl-2 pr-3 opacity-70"><PlatformMark id={platform.id} size={20} /><span className="text-xs text-[var(--color-text-muted)]">{platform.name}</span><span className="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Soon</span></div>)}</div></div>}
      {error && <ErrorText>{error}</ErrorText>}
    </Page>;
  }
  if (step === 'qr') {
    const label = selectedPlatform?.name ?? (draft.domain === 'lark' ? 'Lark' : 'Feishu');
    const isBuiltIn = draft.platform === 'feishu' || draft.platform === 'lark';
    return <Page title={`Connect ${label}`} description={isBuiltIn ? `Scan with ${label} to create and authorize the Grove bot, or connect an existing app with its credentials.` : `Authorize Grove with ${label}. The provider controls the external authorization flow.`} back={() => setStep('platform')}>
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex flex-col gap-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-6 sm:flex-row">
          <div className="relative mx-auto shrink-0 self-start sm:mx-0"><div className="absolute -inset-1.5 rounded-2xl bg-gradient-to-br from-[#3370ff]/25 to-[#5ed3ff]/10" /><div className="relative flex h-[200px] w-[200px] items-center justify-center rounded-xl bg-white p-3 shadow-inner [&_svg]:h-full [&_svg]:w-full">{flow?.qr_svg ? <div className="h-full w-full" dangerouslySetInnerHTML={{ __html: flow.qr_svg }} /> : <Loader2 className="h-6 w-6 animate-spin text-[#3370ff]" />}</div></div>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 text-center sm:text-left">
            <div className="flex items-center justify-center gap-2 text-sm font-medium sm:justify-start"><PlatformMark id={draft.domain} size={20} />{flow?.state === 'error' ? <span className="text-[var(--color-error)]">{flow.error ?? 'Registration failed'}</span> : <><Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-highlight)]" /><span className="text-[var(--color-text-muted)]">{flow?.state === 'authorized' ? 'Saving connection…' : 'Waiting for authorization…'}</span></>}</div>
            <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">{isBuiltIn ? `Open ${label} on your phone, scan the code, and confirm to create the Grove bot app.` : `Scan the code or open the authorization page, then approve access in ${label}.`} Grove saves the Provider configuration returned after authorization.</p>
            <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">{flow && <a href={flow.verification_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-highlight)] hover:underline">Open in browser <ExternalLink className="h-3 w-3" /></a>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => void props.startQr()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh QR</Button></div>
            <p className="text-[11px] text-[var(--color-text-muted)]">Refreshes automatically before it expires</p>
          </div>
        </div>
        {selectedPlatform?.setup_modes.includes('manual') && <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5">
          <div className="mb-4 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"><span>Already have an app?</span><span className="h-px flex-1 bg-[var(--color-border)]" /></div>
          <div className="grid gap-4 sm:grid-cols-2">{(selectedPlatform?.config_fields ?? []).map((field) => <Input key={field.key} label={field.label} type={field.secret ? 'password' : 'text'} value={String(draft.adapter_config[field.key] ?? '')} onChange={(event) => patchConfig(field.key, event.target.value)} placeholder={field.placeholder} />)}</div>
          <div className="mt-4 flex items-center justify-between gap-4"><p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">Credentials are verified by the {label} adapter before the connection is created. QR authorization binds the authorizer automatically.</p><Button size="sm" disabled={busy || !(selectedPlatform?.config_fields ?? []).filter((field) => field.required).every((field) => draft.adapter_config[field.key])} onClick={() => void props.verifyManual()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Verify and continue</Button></div>
        </div>}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Page>;
  }
  if (step === 'manual') {
    const label = selectedPlatform?.name ?? 'provider';
    return <Page title={`Connect ${label}`} description={`Enter the configuration required by the ${label} provider.`} back={() => setStep('platform')}>
      <div className="mx-auto max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5">
        <div className="grid gap-4 sm:grid-cols-2">{(selectedPlatform?.config_fields ?? []).map((field) => <Input key={field.key} label={field.label} type={field.secret ? 'password' : 'text'} value={String(draft.adapter_config[field.key] ?? '')} onChange={(event) => patchConfig(field.key, event.target.value)} placeholder={field.placeholder} />)}</div>
        <div className="mt-5 flex items-center justify-between gap-4"><p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">Configuration is stored on this Connect record and passed only to this provider. Fields marked secret are masked in settings.</p><Button size="sm" disabled={busy || !(selectedPlatform?.config_fields ?? []).filter((field) => field.required).every((field) => draft.adapter_config[field.key])} onClick={() => void props.verifyManual()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}Verify and continue</Button></div>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Page>;
  }
}

interface ExistingProps { item: ConnectItem; draft: ConnectInput; setDraft: React.Dispatch<React.SetStateAction<ConnectInput>>; projects: ProjectListItem[]; tasks: TaskResponse[]; sessions: ChatSessionResponse[]; loadTasks: (id: string) => Promise<void>; loadSessions: (id: string) => Promise<void>; busy: boolean; setBusy: (value: boolean) => void; error: string | null; setError: (value: string | null) => void; onChanged: () => Promise<void>; onDeleted: () => void }
function ExistingDetail({ item, draft, setDraft, projects, tasks, sessions, loadTasks, loadSessions, busy, setBusy, error, setError, onChanged, onDeleted }: ExistingProps) {
  const [editingName, setEditingName] = useState(false);
  const [advancedState, setAdvancedState] = useState<{ itemId: string; values: AdvancedDraft }>({ itemId: item.id, values: readAdvancedConfig(item.adapter_config) });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const advancedDraft = advancedState.itemId === item.id ? advancedState.values : readAdvancedConfig(item.adapter_config);
  const patch = <K extends keyof ConnectInput>(key: K, value: ConnectInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const patchAdvanced = (key: AdvancedConfigKey, value: string) => setAdvancedState({ itemId: item.id, values: { ...advancedDraft, [key]: value } });
  const save = async (next: ConnectInput) => {
    setDraft(next);
    setBusy(true);
    setError(null);
    try { await updateConnect(item.id, next); await onChanged(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  const target = item.target;
  const projectId = draft.project_id || item.project_id;
  const taskId = draft.task_id || item.task_id;
  const sessionId = draft.session_id || item.session_id;
  // The detail draft can briefly lag behind a refreshed item. Keep the
  // persisted target in every write so a transport error never clears it.
  const routedDraft = { ...draft, project_id: projectId, task_id: taskId, session_id: sessionId };
  const toggle = (enabled: boolean) => void save({ ...routedDraft, enabled });
  const pickProject = async (nextProjectId: string) => { await loadTasks(nextProjectId); void save({ ...routedDraft, project_id: nextProjectId, task_id: '', session_id: '' }); };
  const pickTask = async (nextTaskId: string) => { await loadSessions(nextTaskId); void save({ ...routedDraft, task_id: nextTaskId, session_id: '' }); };
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
  const saveAdvanced = () => {
    const adapter_config = { ...draft.adapter_config };
    for (const { key } of ADVANCED_CONFIG_FIELDS) adapter_config[key] = advancedDraft[key].trim();
    void save({ ...routedDraft, adapter_config });
  };
  const resetAdvanced = () => setAdvancedState({ itemId: item.id, values: readAdvancedConfig({}) });
  const hasAdvancedOverrides = ADVANCED_CONFIG_FIELDS.some(({ key }) => advancedDraft[key].trim() !== '');
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
    title={<span className="flex items-center gap-2.5"><PlatformMark id={item.platform} size={26} />{editingName ? <span className="w-64"><Input autoFocus value={draft.name} onChange={(event) => patch('name', event.target.value)} onBlur={commitName} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft((current) => ({ ...current, name: item.name })); setEditingName(false); } }} /></span> : <button type="button" className="group flex min-w-0 items-center gap-1.5 text-left" onClick={() => setEditingName(true)}><span className="truncate">{item.name}</span><Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100" /></button>}</span>}
    description={<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-text-muted)]"><StatusLabel state={item.runtime.state} detail={item.runtime.detail} /><span>·</span><RegionBadge domain={item.domain} />{item.adapter_config.app_id !== undefined && <><span>·</span><span className="font-mono text-xs">{String(item.adapter_config.app_id)}</span></>}{item.bound_chat_id && <span className="rounded-full bg-[var(--color-success)]/10 px-2 py-0.5 text-xs text-[var(--color-success)]">Chat bound</span>}</span>}
    trailing={<Switch checked={draft.enabled} onChange={toggle} label="Enable connection" />}
    ><div className="space-y-4">
    <section className={`space-y-3 rounded-xl border p-4 ${item.project_id && item.task_id ? 'border-[var(--color-border)]' : 'border-[var(--color-highlight)]/40 bg-[var(--color-highlight)]/5'}`}>
      <div>
        <div className="text-sm font-medium text-[var(--color-text)]">Messages route to</div>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-muted)]">Incoming IM messages enter this session and reuse its queue and agent. Changes apply immediately.</p>
      </div>
      <TargetSelect value={projectId} placeholder="Select project" options={projects.map((entry) => ({ id: entry.id, title: entry.name, subtitle: entry.path, icon: <ProjectGlyph id={entry.id} /> }))} onSelect={(id) => void pickProject(id)} />
      <TargetSelect value={taskId} placeholder={projectId ? 'Select task' : 'Pick a project first'} disabled={!projectId} options={tasks.map((entry) => ({ id: entry.id, title: entry.name, subtitle: entry.status, icon: <LetterGlyph id={entry.id} label={entry.name} /> }))} onSelect={(id) => void pickTask(id)} />
      <TargetSelect value={sessionId || (taskId ? '__new__' : '')} placeholder={taskId ? 'New session (created on first message)' : 'Pick a task first'} disabled={!taskId} options={[{ id: '__new__', title: 'New session', subtitle: 'Created when the first message arrives', badge: 'Auto', icon: <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]"><Plus className="h-3.5 w-3.5" /></span> }, ...sessions.map((entry) => ({ id: entry.id, title: entry.title, subtitle: entry.agent, icon: <LetterGlyph id={entry.id} label={entry.title} /> }))]} onSelect={pickSession} />
      {item.session_id && <p className="text-xs text-[var(--color-text-muted)]">Agent {target.agent || 'unknown'} · {target.queue_mode === 'compact' ? 'Compact queue' : 'Separate queue'} · {target.model ?? 'session default model'}{target.mode ? ` · ${target.mode}${target.thought_level ? `/${target.thought_level}` : ''}` : ''}</p>}
      {!item.session_id && item.task_id && <p className="text-xs text-[var(--color-text-muted)]">A new session is created with the task's default agent when the first IM message arrives.</p>}
    </section>
    {(item.platform === 'feishu' || item.platform === 'lark') && <section className="rounded-xl border border-[var(--color-border)]">
      <button type="button" onClick={() => setAdvancedOpen((open) => !open)} className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left hover:bg-[var(--color-bg-secondary)]/40">
        <Settings2 className="h-4 w-4 text-[var(--color-text-muted)]" />
        <span className="flex-1 text-sm font-medium text-[var(--color-text)]">Advanced connection settings</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${hasAdvancedOverrides ? 'bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'}`}>{hasAdvancedOverrides ? 'Custom' : 'Feishu defaults'}</span>
        <ChevronDown className={`h-4 w-4 text-[var(--color-text-muted)] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
      </button>
      {advancedOpen && <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3.5">
        <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">Leave every field blank to use Feishu’s server-provided SDK defaults. Saving custom values restarts this connection.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {ADVANCED_CONFIG_FIELDS.map(({ key, label, placeholder, min, description }) => <div key={key}>
            <Input type="number" min={min} step="1" className="appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" label={label} value={advancedDraft[key]} placeholder={placeholder} onChange={(event) => patchAdvanced(key, event.target.value)} />
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
          </div>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">Official defaults are applied when a field is empty.</p>
          <div className="flex items-center gap-2">
            {hasAdvancedOverrides && <Button variant="ghost" size="sm" onClick={resetAdvanced} disabled={busy}>Reset</Button>}
            <Button size="sm" onClick={saveAdvanced} disabled={busy}>{busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}Save settings</Button>
          </div>
        </div>
      </div>}
    </section>}
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

function Page({ title, description, back, trailing, children }: { title: React.ReactNode; description: React.ReactNode; back?: () => void; trailing?: React.ReactNode; children: React.ReactNode }) { return <div className="mx-auto max-w-2xl"><div className="mb-6 flex items-start gap-3">{back && <Button variant="ghost" size="sm" onClick={back}><ArrowLeft className="h-4 w-4" /></Button>}<div className="min-w-0 flex-1"><h3 className="text-lg font-semibold text-[var(--color-text)]">{title}</h3><p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)]">{description}</p></div>{trailing}</div>{children}</div>; }

function RegionBadge({ domain }: { domain: string }) { return <span className="inline-flex items-center rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">{domain === 'lark' ? 'Global' : domain === 'feishu' ? 'China' : domain.split('/').at(-1)}</span>; }

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
  if (id === 'telegram') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#26a5e4]/12" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={TELEGRAM_PATH} fill="#26A5E4" /></svg></div>;
  if (id === 'slack') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#e01e5a]/10" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={SLACK_PATH} fill="#E01E5A" /></svg></div>;
  if (id === 'discord') return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[#5865f2]/12" style={{ width: size + 12, height: size + 12 }}><svg width={size} height={size} viewBox="0 0 24 24"><path d={DISCORD_PATH} fill="#5865F2" /></svg></div>;
  if (id.startsWith('plugin:')) return <div className="flex shrink-0 items-center justify-center rounded-xl bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]" style={{ width: size + 12, height: size + 12 }}><Link2 style={{ width: size, height: size }} /></div>;
  return <div className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size + 12, height: size + 12, background: 'linear-gradient(135deg, rgba(94,211,255,0.16), rgba(51,112,255,0.12))' }}><LarkMark size={size} /></div>;
}

// Official Lark/Feishu mark (teal + blue + navy, identical for both regions)
const LARK_PATHS = [
  { d: 'M274.18 264.785q.515-.517 1.03-1.027c.685-.688 1.372-1.258 2.056-1.945l1.37-1.372 4.118-4.113 5.598-5.601 4.8-4.797 4.575-4.457 4.796-4.688 4.344-4.344 6.059-6.054c1.14-1.145 2.285-2.29 3.543-3.317 2.168-2.054 4.457-4 6.855-5.828 2.172-1.715 4.344-3.312 6.516-4.914 3.082-2.172 6.398-4.344 9.71-6.285 3.204-1.941 6.63-3.656 10.06-5.371 3.199-1.602 6.515-2.973 9.827-4.23 1.829-.684 3.774-1.372 5.602-2.055.914-.344 1.941-.688 2.856-.914-8.57-33.715-24.227-64.575-45.258-90.86-4.114-5.14-10.399-8.113-17.028-8.113H130.754c-3.203 0-4.457 4-1.945 5.941 59.543 43.66 109.144 99.887 145.03 164.801 0-.226.227-.34.34-.457m0 0', fill: '#00D6B9' },
  { d: 'M204.79 418.691c90.288 0 169.03-49.828 210.058-123.543 1.488-2.628 2.859-5.257 4.23-7.882q-3.087 6-6.86 11.312l-2.741 3.77c-1.141 1.488-2.399 2.972-3.657 4.457-1.03 1.144-2.058 2.285-3.086 3.316-2.058 2.172-4.343 4.227-6.629 6.172a53 53 0 0 1-3.886 3.2c-1.598 1.144-3.086 2.284-4.684 3.429-1.031.683-2.058 1.371-3.086 1.941-1.144.684-2.172 1.258-3.316 1.942a131 131 0 0 1-6.969 3.543c-2.059.918-4.117 1.828-6.289 2.515-2.285.801-4.57 1.602-6.969 2.285-3.543.914-7.086 1.715-10.742 2.286-2.629.457-5.258.687-8 .914-2.86.23-5.601.23-8.457.23-3.086 0-6.289-.23-9.488-.57a83 83 0 0 1-7.086-1.031c-2.055-.34-4.113-.801-6.168-1.258-1.031-.227-2.176-.57-3.203-.797-2.973-.8-6.055-1.602-9.028-2.516-1.488-.457-2.972-.914-4.457-1.258-2.172-.683-4.457-1.37-6.629-2.058-1.828-.57-3.656-1.14-5.37-1.711q-2.573-.86-5.145-1.715c-1.14-.344-2.285-.8-3.543-1.144-1.371-.457-2.856-1.028-4.227-1.485-1.027-.344-2.058-.687-2.972-1.027-1.942-.688-4-1.488-5.942-2.172-1.144-.457-2.285-.914-3.43-1.258-1.484-.57-3.085-1.144-4.57-1.828-1.601-.687-3.203-1.258-4.8-1.945-1.028-.457-2.06-.797-3.087-1.258-1.257-.57-2.628-1.027-3.886-1.598-1.028-.457-1.942-.8-2.969-1.258l-3.086-1.37c-.914-.344-1.832-.801-2.746-1.145a44 44 0 0 1-2.512-1.14c-.8-.345-1.715-.802-2.515-1.145-.914-.344-1.715-.801-2.512-1.141-1.031-.457-2.172-1.031-3.203-1.484-1.14-.575-2.285-1.032-3.426-1.602-1.258-.574-2.402-1.144-3.66-1.715-1.027-.457-2.055-1.027-3.082-1.484-54.172-26.973-102.172-63.086-143.09-106.746-2.055-2.172-5.71-.684-5.71 2.289l.112 154.398v12.57c0 7.317 3.543 14.06 9.598 18.172 38.172 24.801 83.773 39.543 132.914 39.543m0 0', fill: '#3370FF' },
  { d: 'M414.84 295.188c0 .113-.113.113-.113.226zl.8-1.489c-.343.457-.574 1.028-.8 1.488m3.793-7.05.226-.457.114-.23q-.17.513-.34.687m0 0', fill: '#133C9A' },
  { d: 'M470.035 201.121c-18.285-9.031-38.86-14.059-60.687-14.059-12.914 0-25.485 1.829-37.371 5.141-1.372.344-2.743.8-4.114 1.258-.914.344-1.941.574-2.855.914-1.945.688-3.774 1.375-5.602 2.059-3.316 1.257-6.629 2.742-9.828 4.23-3.43 1.598-6.742 3.426-10.058 5.371a128 128 0 0 0-9.715 6.285c-2.285 1.602-4.457 3.2-6.512 4.914a154 154 0 0 0-6.86 5.828c-1.14 1.141-2.398 2.172-3.542 3.313l-6.055 6.059-4.344 4.343-4.8 4.684-4.57 4.46-4.802 4.798-11.086 11.086c-.687.687-1.37 1.37-2.058 1.945l-1.028 1.027c-.457.457-1.027 1.028-1.601 1.485-.57.57-1.14 1.031-1.711 1.601a244.4 244.4 0 0 1-49.828 35.313c1.027.457 2.168 1.027 3.199 1.488.8.34 1.715.797 2.512 1.14.8.344 1.715.801 2.515 1.145.801.344 1.602.684 2.516 1.14.914.345 1.828.802 2.742 1.145l3.086 1.371c1.027.457 1.942.801 2.969 1.258 1.258.57 2.629 1.028 3.887 1.598 1.03.46 2.058.8 3.086 1.258 1.601.687 3.199 1.258 4.8 1.945 1.485.57 3.086 1.14 4.57 1.828 1.145.457 2.286.914 3.43 1.258 1.946.684 4 1.484 5.946 2.172a81 81 0 0 1 2.968 1.027c1.371.457 2.856 1.028 4.23 1.485 1.141.343 2.286.8 3.544 1.14q2.567.86 5.14 1.719c1.829.57 3.657 1.14 5.372 1.71 2.171.688 4.457 1.376 6.628 2.06 1.489.457 2.973.914 4.457 1.257 2.973.914 5.942 1.715 9.032 2.512 1.027.344 2.168.574 3.199.8 2.055.458 4.113.915 6.172 1.259 2.398.457 4.683.8 7.082 1.03 3.203.34 6.402.571 9.488.571 2.856 0 5.715 0 8.457-.23 2.63-.227 5.371-.457 8-.914 3.656-.57 7.2-1.371 10.742-2.286 2.399-.683 4.688-1.37 6.973-2.285 2.172-.8 4.227-1.601 6.285-2.515 2.399-1.028 4.684-2.285 6.973-3.543 1.14-.57 2.168-1.258 3.312-1.942 1.028-.687 2.059-1.257 3.086-1.945 1.602-1.027 3.2-2.168 4.684-3.426a52 52 0 0 0 3.887-3.203c2.289-1.941 4.457-4 6.628-6.168 1.032-1.031 2.06-2.172 3.086-3.316 1.258-1.485 2.516-2.969 3.657-4.457.918-1.258 1.828-2.512 2.742-3.77 2.515-3.543 4.8-7.316 6.86-11.199l2.284-4.688 21.145-42.171v.113c6.742-14.742 16.226-28.113 27.656-39.426m0 0', fill: '#133C9A' },
];

function LarkMark({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="62.16 94.5 407.87 324.19" fill="none">{LARK_PATHS.map((path, index) => <path key={index} d={path.d} fill={path.fill} />)}</svg>;
}


function StatusDot({ state }: { state: string }) { return <span className={`h-2 w-2 shrink-0 rounded-full ${state === 'online' ? 'bg-[var(--color-success)] shadow-[0_0_4px_var(--color-success)]' : state === 'error' ? 'bg-[var(--color-error)] shadow-[0_0_4px_var(--color-error)]' : 'bg-[var(--color-text-muted)]'}`} />; }
function StatusLabel({ state, detail }: { state: string; detail?: string }) { return <span title={detail} className="inline-flex items-center gap-2"><StatusDot state={state} /><span className="capitalize">{state}</span></span>; }
function ErrorText({ children, onDismiss }: { children: React.ReactNode; onDismiss?: () => void }) { return <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">{children}</span>{onDismiss && <button type="button" onClick={onDismiss} className="shrink-0 text-[var(--color-error)]/70 hover:text-[var(--color-error)]" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>}</div>; }
function messageOf(cause: unknown) { return (cause as { message?: string })?.message ?? String(cause); }
