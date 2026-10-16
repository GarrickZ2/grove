/** Server session facts only. Streamed text/tool output is never a running signal. */
export type Phase = 'connecting' | 'running' | 'waiting' | 'idle' | 'disconnected' | 'failed' | 'completed' | 'cancelled' | 'finished';
export interface ChatState {
  project: string; task: string; chat: string; taskName: string; sessionName: string;
  phase: Phase; changedAt: number;
}
export type ActivityState = Map<string, ChatState>;
type Data = Record<string, unknown>;
const object = (v: unknown): v is Data => !!v && typeof v === 'object';
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
export const sessionKey = (p: string, t: string, c: string) => JSON.stringify([p, t, c]);
const active = (p: Phase) => ['running', 'waiting', 'connecting'].includes(p);
const terminal = (p: Phase) => ['failed', 'completed', 'cancelled', 'finished'].includes(p);
const statusPhase: Record<string, Phase> = { busy: 'running', running: 'running', connecting: 'connecting', permission_required: 'waiting', permission: 'waiting', idle: 'idle', disconnected: 'disconnected' };

export function reduceActivity(previous: ActivityState, raw: unknown, now = Date.now()): ActivityState {
  if (!object(raw)) return previous;
  if (raw.type === 'activity_snapshot' && Array.isArray(raw.chats)) {
    const result: ActivityState = new Map();
    for (const item of raw.chats) {
      if (!object(item)) continue;
      const id = sessionKey(text(item.project_id), text(item.task_id), text(item.chat_id));
      const old = previous.get(id);
      const seeded = reduceActivity(old ? new Map([[id, old]]) : new Map(), { ...item, type: 'chat_status' }, now);
      const chat = seeded.get(id);
      if (chat) result.set(id, chat);
    }
    // Preserve recent explicit outcomes, but never retain an absent running session.
    for (const [id, chat] of previous) {
      if (!result.has(id) && terminal(chat.phase) && now - chat.changedAt < 30000) result.set(id, chat);
    }
    return result;
  }
  const project = text(raw.project_id), task = text(raw.task_id), chat = text(raw.chat_id);
  if (!project || !task || !chat) return previous;
  const id = sessionKey(project, task, chat), old = previous.get(id);
  let phase: Phase | undefined;
  if (raw.type === 'chat_status' || raw.type === 'chat_view') phase = statusPhase[text(raw.status)];
  if (raw.type === 'chat_runtime' && object(raw.event)) {
    const e = raw.event;
    if (e.type === 'prompt_started' || (e.type === 'busy' && e.value === true)) phase = 'running';
    if (e.type === 'busy' && e.value === false) phase = 'idle';
    if (e.type === 'complete' || e.type === 'prompt_completed' || e.type === 'terminal_complete') phase = /cancel|kill|stop/i.test(text(e.stop_reason)) ? 'cancelled' : 'completed';
    if (e.type === 'prompt_failed' || e.type === 'auth_failed') phase = 'failed';
    if (e.type === 'permission_request' || e.type === 'elicitation_request' || e.type === 'auth_required') phase = 'waiting';
    if (e.type === 'permission_response' || e.type === 'elicitation_complete') phase = 'running';
    if (e.type === 'session_ended') phase = 'disconnected';
  }
  if (raw.type === 'turn' && object(raw.event)) {
    const e = raw.event;
    if (e.state === 'started') phase = 'running';
    if (['permission_required', 'form_required'].includes(text(e.state))) phase = 'waiting';
    if (e.state === 'failed') phase = 'failed';
    if (e.state === 'completed') phase = /cancel|kill|stop/i.test(text(e.stop_reason)) ? 'cancelled' : 'completed';
    if (e.state === 'session_ended') phase = 'disconnected';
  }
  if (raw.type === 'activity_metadata' && old) phase = old.phase;
  if (!phase) return previous;
  // Not busy is authoritative, but isn't proof of success. Keep explicit outcomes.
  if (phase === 'idle' || phase === 'disconnected') {
    if (old && terminal(old.phase)) phase = old.phase;
    else if (phase === 'idle' && old && (old.phase === 'running' || old.phase === 'waiting')) phase = 'finished';
  }
  const result = new Map(previous);
  result.set(id, { project, task, chat, taskName: text(raw.task_name) || old?.taskName || '',
    sessionName: text(raw.chat_title) || old?.sessionName || '', phase,
    changedAt: old?.phase === phase ? old.changedAt : now });
  return result;
}

export function activityContent(state: ActivityState, origin: string, now = Date.now()) {
  const live = [...state.values()].filter(c => active(c.phase));
  const recent = [...state.values()].filter(c => terminal(c.phase) && now - c.changedAt < 30000);
  const values = live.length ? live : recent;
  if (!values.length) return null;
  const count = (p: Phase) => values.filter(c => c.phase === p).length;
  const running = count('running'), connecting = count('connecting'), waiting = count('waiting'), failed = count('failed'), completed = count('completed');
  const status: Phase = waiting ? 'waiting' : running ? 'running' : connecting ? 'connecting' : failed ? 'failed' : count('cancelled') ? 'cancelled' : count('finished') ? 'finished' : 'completed';
  const names = (c: ChatState) => [c.taskName, c.sessionName].filter(Boolean).join(' · ');
  // No invented placeholder title. Metadata fetch will fill missing names.
  if (values.length === 1 && !names(values[0])) return null;
  const labels: Record<Phase, string> = { running:'Running', connecting:'Connecting', waiting:'Needs attention', idle:'Idle', disconnected:'Disconnected', completed:'Completed', cancelled:'Stopped', failed:'Failed', finished:'Finished' };
  const summary = values.length === 1 ? labels[status] : [
    running && `${running} running`, connecting && `${connecting} connecting`, waiting && `${waiting} need attention`,
    failed && `${failed} failed`, completed && `${completed} completed`, count('finished') && `${count('finished')} finished`, count('cancelled') && `${count('cancelled')} stopped`,
  ].filter(Boolean).join(' · ');
  const params = new URLSearchParams({ origin });
  if (values.length === 1) { params.set('project', values[0].project); params.set('task', values[0].task); params.set('chat', values[0].chat); }
  return { title: values.length === 1 ? names(values[0]).slice(0, 100) : `${values.length} sessions`,
    summary, status, running, connecting, waiting, failed, completed, sessionCount: values.length,
    sessions: values.slice(0, 3).filter(c => names(c)).map(c => ({ name: names(c).slice(0, 100), status: labels[c.phase] })),
    link: `grove://activity?${params}` };
}
