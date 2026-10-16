import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForIosTransport } from './transport';

const state = window as Window & { __GROVE_TRANSPORT_READY__?: boolean };
afterEach(() => { delete state.__GROVE_TRANSPORT_READY__; vi.useRealTimers(); });

describe('native transport recovery gate', () => {
  it('does not block ordinary web requests', async () => {
    await expect(waitForIosTransport()).resolves.toBeUndefined();
  });
  it('holds requests until the native listener passes its health check', async () => {
    state.__GROVE_TRANSPORT_READY__ = false;
    const completed = vi.fn();
    const pending = waitForIosTransport().then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    state.__GROVE_TRANSPORT_READY__ = true;
    window.dispatchEvent(new Event('grove:transport-ready'));
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });
  it('fails boundedly instead of leaving requests pending forever', async () => {
    vi.useFakeTimers();
    state.__GROVE_TRANSPORT_READY__ = false;
    const pending = expect(waitForIosTransport()).rejects.toThrow('recovery failed');
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
  });
});
