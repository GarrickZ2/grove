import { describe, expect, it } from 'vitest';
import type { PreviewCommentLocator } from '../../context';
import { textSelectionAnchor } from './PreviewCommentHost';
import { textRangeForLocator } from './previewAnchor';
import { rectInViewport, rectRelativeTo } from './previewCommentGeometry';

describe('PreviewCommentHost text marker anchoring', () => {
  it('anchors an inline selection to its stable paragraph', () => {
    const content = document.createElement('div');
    content.innerHTML = '<p><span>Integration Issue Insights</span> 是平台。<span>服务渠道、Oncall</span></p>';
    const text = content.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent!.length);

    expect(textSelectionAnchor(range, content)).toBe(content.querySelector('p'));
  });

  it('repairs a legacy inline selector by matching the saved quote in its ancestor', () => {
    const content = document.createElement('div');
    content.innerHTML = '<p><span>Integration Issue Insights</span> 是平台。<span>服务渠道、Oncall</span></p>';
    const wrongInline = content.querySelectorAll('span')[1];
    const locator: PreviewCommentLocator = {
      type: 'dom',
      selector: 'span',
      tagName: 'span',
      textRange: {
        start: 0,
        end: 'Integration Issue Insights'.length,
        quote: 'Integration Issue Insights',
      },
    };

    expect(textRangeForLocator(wrongInline, locator, content)?.toString())
      .toBe('Integration Issue Insights');
  });
});

describe('PreviewCommentHost marker geometry', () => {
  it('cancels a shared drawer translation in a single layout snapshot', () => {
    const markerDuringEntry = new DOMRect(1040, 220, 180, 30);
    const hostDuringEntry = new DOMRect(900, 100, 780, 900);
    const local = rectRelativeTo(markerDuringEntry, hostDuringEntry);

    expect({ left: local.left, top: local.top }).toEqual({ left: 140, top: 120 });

    const hostAfterEntry = new DOMRect(300, 100, 780, 900);
    const finalViewport = rectInViewport(local, hostAfterEntry);
    expect({ left: finalViewport.left, top: finalViewport.top }).toEqual({ left: 440, top: 220 });
  });
});
