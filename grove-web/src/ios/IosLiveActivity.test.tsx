import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RadioEventCallbacks } from '../hooks/useRadioEvents';
const mocks = vi.hoisted(() => ({ callbacks: {} as RadioEventCallbacks, get: vi.fn() }));
vi.mock('../hooks/useRadioEvents', () => ({ useRadioEvents: (callbacks: RadioEventCallbacks) => { mocks.callbacks = callbacks; }, refreshRadioActivity: vi.fn() }));
vi.mock('./activitySnapshot', () => ({ loadActivitySnapshot: mocks.get }));
vi.mock('../api/tasks', () => ({ getTask: vi.fn().mockResolvedValue({name:'Existing task'}), listChats: vi.fn().mockResolvedValue([]) }));
import { IosLiveActivity } from './IosLiveActivity';
let root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  (window as Window & { __GROVE_IOS_SERVER__?: unknown }).__GROVE_IOS_SERVER__ = { token: 'test' };
  fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => { root.render(<IosLiveActivity />); }); };
const event = async (value: unknown) => { await act(async () => { mocks.callbacks.onEvent?.(value); }); };
const lastState = () => fetchMock.mock.calls.map(c => JSON.parse(c[1].body)).filter(b => b.content).at(-1)?.content;
const busy = { type: 'chat_status', project_id: 'p', task_id: 't', chat_id: 'c', status: 'busy', task_name: 'Existing task', chat_title:'Main' };
it('creates from live status even if the old server has no snapshot route', async () => {
  mocks.get.mockRejectedValue({status:404}); await render();
  await event(busy);
  expect(lastState()).toMatchObject({ title:'Existing task · Main', status:'running', running:1 });
});
it('does not block live events on a pending snapshot, or regress to idle when it resolves', async () => {
  let resolve!: (v: unknown) => void;
  mocks.get.mockImplementation(() => new Promise(r => { resolve = r; })); await render();
  await event(busy); expect(lastState()?.running).toBe(1);
  await act(async () => resolve({chats:[]}));
  expect(lastState()?.running).toBe(1);
});
it('never infers running from streamed history after snapshot failure', async () => {
  mocks.get.mockRejectedValue({status:404}); await render();
  await event({...busy, type:'turn', event:{state:'message_chunk', text:'not copied to native'}});
  expect(lastState()).toBeUndefined();
  expect(JSON.stringify(lastState() ?? null)).not.toContain('not copied to native');
});
it('keeps failure semantics after a snapshot failure', async () => {
  mocks.get.mockRejectedValue({status:404}); await render(); await event(busy);
  await event({...busy, type:'turn', event:{state:'failed'}});
  expect(lastState()?.status).toBe('failed');
});

it('starts from all server sessions without mounting a task page', async () => {
  mocks.get.mockResolvedValue({chats:[busy,{...busy,chat_id:'second',chat_title:'Second'}]});
  await render(); expect(lastState()).toMatchObject({running:2,sessionCount:2});
  await event({...busy,status:'idle'});
  expect(lastState()).toMatchObject({running:1,title:'Existing task · Second'});
});
it('consumes the same completion event as TaskChat', async () => {
  mocks.get.mockResolvedValue({chats:[busy]}); await render();
  await act(async () => { window.dispatchEvent(new CustomEvent('grove:ios-chat-runtime',{detail:{...busy,type:'chat_runtime',event:{type:'complete'}}})); });
  expect(lastState()).toMatchObject({running:0,status:'completed'});
});

it('a stream snapshot supersedes an older failing HTTP request', async () => {
  let reject!: (error: unknown) => void;
  mocks.get.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await render();
  await event({type:'activity_snapshot',chats:[busy,{...busy,chat_id:'second'}]});
  await act(async () => reject({status:500}));
  const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
  expect(body).toMatchObject({stale:false,content:{running:2}});
});
