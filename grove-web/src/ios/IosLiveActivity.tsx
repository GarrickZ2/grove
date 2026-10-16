import { useEffect, useEffectEvent, useRef } from 'react';
import { useRadioEvents, refreshRadioActivity } from '../hooks/useRadioEvents';
import { getTask, listChats } from '../api/tasks';
import { loadActivitySnapshot } from './activitySnapshot';
import { activityContent, reduceActivity, type ActivityState } from './activityState';

/** One controller for the authenticated server, independent of the current page. */
export function IosLiveActivity() {
  const state = useRef<ActivityState>(new Map());
  const generation = useRef(0);
  const buffered = useRef<unknown[] | null>(null);
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const disconnected = useRef(false);
  const snapshotUnavailable = useRef(false);
  const metadataRequests = useRef(new Set<string>());
  const send = (stale = disconnected.current, diagnostic?: string) => {
    const metadata = (window as Window & { __GROVE_IOS_SERVER__?: { token?: string } }).__GROVE_IOS_SERVER__;
    if (!metadata?.token || !alive.current) return;
    const content = activityContent(state.current, window.location.origin);
    const body = JSON.stringify({ clear: diagnostic ? false : !content, stale: stale || snapshotUnavailable.current, content: diagnostic ? null : content, diagnostic });
    queue.current = queue.current.then(async () => {
      if (!alive.current) return;
      const response = await fetch('/_grove/activity', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Grove-Setup': metadata.token! }, body, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Live Activity bridge: ${response.status}`);
    }).catch(error => console.warn(error));
  };
  const enrich = () => {
    for (const chat of state.current.values()) {
      if (chat.taskName && chat.sessionName) continue;
      const key = JSON.stringify([chat.project, chat.task]);
      if (metadataRequests.current.has(key)) continue;
      metadataRequests.current.add(key);
      void Promise.all([getTask(chat.project, chat.task), listChats(chat.project, chat.task)]).then(([task, chats]) => {
        if (!alive.current) return;
        for (const session of chats) state.current = reduceActivity(state.current, {type:'activity_metadata',
          project_id:chat.project, task_id:chat.task, chat_id:session.id, task_name:task.name, chat_title:session.title});
        send();
      }).catch(error => console.warn('Live Activity names unavailable', error))
        .finally(() => metadataRequests.current.delete(key));
    }
  };
  const receive = (event: unknown) => {
    if ((event as {type?:string}).type === "activity_snapshot") {
      // A stream snapshot supersedes any older HTTP request still in flight.
      ++generation.current; buffered.current = null; snapshotUnavailable.current = false;
    }
    if (buffered.current) buffered.current.push(event);
    const next = reduceActivity(state.current, event);
    if (next !== state.current) { state.current = next; enrich(); send(); }
    else if ((event as {type?:string}).type === 'activity_heartbeat') send();
  };
  const seed = () => {
    if (buffered.current) return;
    buffered.current = [];
    const version = ++generation.current;
    void loadActivitySnapshot().then(snapshot => {
      if (!alive.current || generation.current !== version) return;
      let next = reduceActivity(state.current, { type: 'activity_snapshot', chats: snapshot.chats });
      for (const event of buffered.current ?? []) next = reduceActivity(next, event);
      state.current = next; buffered.current = null; snapshotUnavailable.current = false; enrich(); send();
    }).catch(error => {
      if (!alive.current || generation.current !== version) return;
      buffered.current = null; snapshotUnavailable.current = true;
      send(true); send(false, 'snapshot_unavailable');
      console.warn('Live Activity snapshot unavailable', error);
    });
  };
  useRadioEvents({
    onEvent: receive,
    onConnected: () => { disconnected.current = false; seed(); },
    onDisconnected: () => { disconnected.current = true; ++generation.current; buffered.current = null; send(true); },
  });
  const restore = useEffectEvent(() => {
    if (document.visibilityState === 'visible') { seed(); refreshRadioActivity(); }
    else send();
  });
  const reconcile = useEffectEvent(() => { if (document.visibilityState === 'visible') seed(); });
  const runtime = useEffectEvent((event: Event) => receive((event as CustomEvent).detail));
  const expire = useEffectEvent(() => send());
  const invalidate = useEffectEvent(() => { alive.current = false; ++generation.current; buffered.current = null; });
  useEffect(() => {
    alive.current = true;
    restore();
    document.addEventListener('visibilitychange', restore);
    window.addEventListener('grove:ios-chat-runtime', runtime);
    const poll = window.setInterval(reconcile, 15000);
    const expiry = window.setInterval(expire, 10000);
    return () => {
      invalidate();
      document.removeEventListener('visibilitychange', restore);
      window.removeEventListener('grove:ios-chat-runtime', runtime);
      window.clearInterval(poll); window.clearInterval(expiry);
    };
  }, []);
  return null;
}
