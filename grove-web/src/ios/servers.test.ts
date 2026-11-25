import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iosServerOrigin, openIosServer, probeIosServer, signInToIosServer } from './servers';

const answers: Record<string, unknown[]> = {};
const asked: { path: string; body: unknown }[] = [];
const reply = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });

beforeEach(() => {
  vi.useFakeTimers();
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: { body: string }) => {
    asked.push({ path, body: JSON.parse(init.body) });
    const next = answers[path]?.shift();
    if (next instanceof Error) throw next;
    return next ?? reply(500, {});
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('servers behind a sign-in page', () => {
  it('signs in and connects, over calls that fail while the app is away', async () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });
    answers['/_grove/connect'] = [
      reply(401, { error: 'x', sign_in: true, server: 'https://grove.example.com/' }),
      reply(200, { location: 'http://127.0.0.1:5000/' }),
    ];
    answers['/_grove/sign-in'] = [reply(200, { id: 4 })];
    answers['/_grove/sign-in/state'] = [reply(200, { id: 4, state: 'open' }), new Error('offline'), reply(200, { id: 4, state: 'done' })];
    const opening = openIosServer('http://grove.example.com', 'Home');
    await vi.advanceTimersByTimeAsync(3000);
    await opening;
    expect(replace).toHaveBeenCalledWith('http://127.0.0.1:5000/');
    expect(asked.filter((call) => call.path === '/_grove/connect').map((call) => (call.body as { server: string }).server))
      .toEqual(['http://grove.example.com', 'https://grove.example.com/']);
  });

  it('says why a sign-in ended, and stops when another took its place', async () => {
    answers['/_grove/sign-in'] = [reply(200, { id: 1 }), reply(200, { id: 2 })];
    answers['/_grove/sign-in/state'] = [reply(200, { id: 1, state: 'failed', error: 'Sign-in timed out' }), reply(200, { id: 3, state: 'open' })];
    const first = expect(signInToIosServer('https://a')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(700);
    await first;
    const second = expect(signInToIosServer('https://a')).rejects.toThrow('closed');
    await vi.advanceTimersByTimeAsync(700);
    await second;
  });

  it('tells a sign-in page from nothing there', async () => {
    answers['/_grove/probe'] = [reply(200, { reachable: true }), reply(200, { reachable: false, sign_in: true }), reply(200, { reachable: false })];
    expect([await probeIosServer('a'), await probeIosServer('b'), await probeIosServer('c')]).toEqual(['grove', 'sign_in', 'none']);
  });
});

it('reads a short address the way it is meant', () => {
  expect(iosServerOrigin('192.168.1.10')).toBe('http://192.168.1.10:3001');
  expect(iosServerOrigin('mac-studio.local')).toBe('http://mac-studio.local:3001');
  expect(iosServerOrigin('studio')).toBe('http://studio:3001');
  expect(iosServerOrigin('mac.tail1.ts.net')).toBe('http://mac.tail1.ts.net:3001');
  expect(iosServerOrigin('grove.example.com')).toBe('https://grove.example.com');
  expect(iosServerOrigin('grove.example.com:8080')).toBe('http://grove.example.com:8080');
  expect(iosServerOrigin('http://grove.example.com')).toBe('http://grove.example.com');
});
