import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTML_FILE_NAVIGATION_MESSAGE, injectHtmlFileNavigation } from './htmlFileNavigation';

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

function setup(body: string, enabled = true) {
  // Run the actual injected script, not a duplicate of its click handler.
  const html = injectHtmlFileNavigation(`<html><head></head><body>${body}</body></html>`, 'frame', enabled);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const script = parsed.querySelector('script')!.textContent!;
  parsed.querySelector('script')!.remove();
  const container = document.createElement('div');
  container.innerHTML = parsed.body.innerHTML;
  const isolatedDocument = document.implementation.createHTMLDocument();
  isolatedDocument.body.append(container);
  isolatedDocument.head.innerHTML = parsed.head.innerHTML;
  const postMessage = vi.fn();
  new Function('document', 'window', script)(isolatedDocument, { parent: { postMessage } });
  return { container, postMessage };
}

describe('HTML preview file links', () => {
  it('intercepts clicks on nested link content and forwards the original relative path', () => {
    const { container, postMessage } = setup('<a href="stocks/TEM/card.html"><span>持仓卡</span></a>');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    container.querySelector('span')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({
      type: HTML_FILE_NAVIGATION_MESSAGE, frameId: 'frame', reference: 'stocks/TEM/card.html',
    }, '*');
  });

  it.each(['https://example.com/card.html', '//example.com/card.html', '#section', '?theme=dark', '/app', 'mailto:a@example.com', 'javascript:void(0)'])(
    'keeps native behavior for %s', (href) => {
      const { container, postMessage } = setup(`<a href="${href}">link</a>`);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      container.querySelector('a')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(postMessage).not.toHaveBeenCalled();
    },
  );

  it('respects page click handlers that prevent default navigation', () => {
    const { container, postMessage } = setup('<a href="card.html">link</a>');
    const link = container.querySelector('a')!;
    link.addEventListener('click', (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not install file navigation without a source location', () => {
    const { container, postMessage } = setup('<a href="card.html">link</a>', false);
    container.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('does not allow frame identifiers or fragments to terminate the injected script', () => {
    expect(injectHtmlFileNavigation('', '</script>', true, '#</script>')).not.toContain('"</script>"');
  });
});
