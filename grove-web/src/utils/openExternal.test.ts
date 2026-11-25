import { afterEach, expect, it, vi } from 'vitest';
import { installExternalLinkInterceptor } from './openExternal';

const nativeOpen = window.open;
afterEach(() => {
  window.open = nativeOpen;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

it('sends window.open to the OS browser in the desktop app, the URL unchanged', () => {
  const invoke = vi.fn(async () => undefined);
  const native = vi.fn(() => null);
  window.open = native;
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
  installExternalLinkInterceptor();

  const url = 'https://example.com/a?next=https%3A%2F%2Fb.com%26x=1';
  expect(window.open(url, '_blank', 'noopener')).toBeNull();
  expect(invoke).toHaveBeenCalledWith('open_external_url', { url });
  expect(native).not.toHaveBeenCalled();

  window.open('about:blank', '_blank');
  expect(native).toHaveBeenCalledWith('about:blank', '_blank');
});

it('leaves window.open alone in a browser', () => {
  const native = vi.fn(() => null);
  window.open = native;
  installExternalLinkInterceptor();
  expect(window.open).toBe(native);
});
