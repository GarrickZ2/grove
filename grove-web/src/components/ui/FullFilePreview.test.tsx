import { renderToStaticMarkup } from "react-dom/server";
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from '../../api/client';
import { HTML_FILE_NAVIGATION_MESSAGE } from '../Review/htmlFileNavigation';
import { getPreviewRenderer } from "../Review/previewRenderers";
import {
  FullFilePreview,
} from "./FullFilePreview";
import {
  LARGE_MARKDOWN_PREVIEW_THRESHOLD,
  isVirtualizedMarkdownPreview,
} from "./filePreviewPolicy";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("FullFilePreview", () => {
  it("keeps the large-markdown threshold in one shared policy", () => {
    expect(isVirtualizedMarkdownPreview(
      "design.md",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD),
    )).toBe(false);
    expect(isVirtualizedMarkdownPreview(
      "design.MARKDOWN",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD + 1),
    )).toBe(true);
    expect(isVirtualizedMarkdownPreview(
      "design.txt",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD + 1),
    )).toBe(false);
  });

  it("owns the ordinary full-file renderer layout", () => {
    const html = renderToStaticMarkup(
      <FullFilePreview fileName="notes.md" content="# Notes" />,
    );

    expect(html).toContain('data-file-preview-renderer="markdown"');
    expect(html).toContain('data-file-preview-virtualized="false"');
    expect(html).toContain("p-5");
  });

  it("keeps the virtualized markdown viewport height through the comment host", () => {
    const html = renderToStaticMarkup(
      <FullFilePreview
        fileName="large.md"
        content={`# Large\n\n${"body\n\n".repeat(6_000)}`}
        previewComment={{ previewId: "large-preview" }}
      />,
    );

    expect(html).toContain('data-file-preview-virtualized="true"');
    expect(html.match(/h-full min-h-0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("marks bounded renderers as fill-layout capabilities", () => {
    expect(getPreviewRenderer("diagram.png", "full")?.layout).toBe("fill");
    expect(getPreviewRenderer("report.xlsx", "full")?.layout).toBe("fill");
    expect(getPreviewRenderer("notes.md", "full")?.layout).toBe("document");
  });

  it.each(['task', 'project', 'resource'] as const)('opens successive relative HTML links in the %s namespace and returns through history', async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const getBlob = vi.spyOn(apiClient, 'getBlob').mockImplementation(async () => ({ text: async () => '<html><body>Linked</body></html>' }) as Blob);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const prefix = `/api/v1/projects/p/${kind === 'task' ? 'tasks/t/' : kind === 'resource' ? 'resource/' : ''}files/raw?path=`;
    const navigate = async (reference: string, foreignSource = false) => {
      const iframe = host.querySelector('iframe')!;
      const frameId = iframe.srcdoc.match(/var frameId=("[^"]+")/)![1];
      await act(async () => window.dispatchEvent(new MessageEvent('message', {
        source: foreignSource ? window : iframe.contentWindow,
        data: { type: HTML_FILE_NAVIGATION_MESSAGE, frameId: JSON.parse(frameId), reference },
      })));
    };
    try {
      await act(async () => root.render(<FullFilePreview
        fileName="dashboard.html" content="<html><body>Dashboard</body></html>"
        location={{ projectId: 'p', root: kind === 'task' ? { kind, taskId: 't' } : { kind }, path: 'output/dashboard.html' }}
      />));
      await navigate('stocks/TEM/card.html', true);
      expect(getBlob).not.toHaveBeenCalled();
      await navigate('stocks/TEM/card.html');
      expect(getBlob).toHaveBeenLastCalledWith(`${prefix}output%2Fstocks%2FTEM%2Fcard.html`, expect.any(AbortSignal));
      expect(host.textContent).toContain('output/stocks/TEM/card.html');
      await navigate('../FIG/持仓%20卡.html?v=2#metrics');
      expect(getBlob).toHaveBeenLastCalledWith(`${prefix}output%2Fstocks%2FFIG%2F%E6%8C%81%E4%BB%93%20%E5%8D%A1.html&v=2`, expect.any(AbortSignal));
      expect(host.querySelector('iframe')!.srcdoc).toContain('fragment="#metrics"');
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(host.textContent).toContain('output/stocks/TEM/card.html');
      await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
      expect(host.querySelector('button')).toBeNull();
      expect(host.querySelector('iframe')!.srcdoc).toContain('Dashboard');
      getBlob.mockRejectedValueOnce(new Error('File not found'));
      await navigate('missing.html');
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('File not found');
      expect(host.querySelector('iframe')!.srcdoc).toContain('Dashboard');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
