import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { IosServerMenu } from './IosServerMenu';
import { LogoBrand } from './LogoBrand';

it('puts only a compact management entry beside a non-interactive mobile brand', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<><LogoBrand mode="zen" subtitle="Home Mac" /><IosServerMenu /></>));
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/_grove/');
  expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Manage servers');
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).toContain('Home Mac');
  expect(container.textContent).not.toMatch(/Sign out|Switch or add|Zen|Blitz/);
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
