import { describe, expect, it } from 'vitest';
import type { PreviewCommentLocator } from '../../context';
import { describeAnchor } from '../../utils/commentAnchor';
import { locateComment } from './previewAnchor';

function content(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function on(element: Element, root: Element, more: Partial<PreviewCommentLocator> = {}) {
  const { selector, xpath, text } = describeAnchor(element, root);
  const locator: PreviewCommentLocator = { type: 'dom', selector, xpath, text, tagName: element.tagName.toLowerCase(), ...more };
  return { selector, xpath, extraBlocks: locator.extraBlocks, locator };
}

function selecting(element: Element, root: Element, quote: string, nth = 0) {
  const text = element.textContent!;
  let start = -1;
  for (let i = 0; i <= nth; i += 1) start = text.indexOf(quote, start + 1);
  return on(element, root, {
    text: quote,
    blockText: text,
    textRange: { start, end: start + quote.length, quote, before: text.slice(Math.max(0, start - 40), start), after: text.slice(start + quote.length, start + quote.length + 40) },
  });
}

const TENANT = 'One tenant has one JSON configuration, edited and published online.';
const PROMPT = 'The example uses a Fornax reference, and the workspace id is only illustrative.';

describe('a preview comment after the file was rewritten', () => {
  const before = content(`<h2>Config</h2><p>${TENANT}</p><p>${PROMPT}</p>`);

  it('goes with its paragraph when one is put in front, rewritten or not', () => {
    const marker = on(before.querySelectorAll('p')[0], before);
    const same = content(`<h2>Config</h2><p>New.</p><p>${TENANT}</p><p>${PROMPT}</p>`);
    expect(locateComment(marker, same)).toMatchObject({ elements: [same.querySelectorAll('p')[1]], stale: false });
    const reworded = content(`<h2>Config</h2><p>New.</p><p>One tenant has one JSON configuration in TCC, edited and published online.</p><p>${PROMPT}</p>`);
    expect(locateComment(marker, reworded)).toMatchObject({ elements: [reworded.querySelectorAll('p')[1]], stale: true });
  });

  it('is not drawn on what took its place', () => {
    const marker = on(before.querySelectorAll('p')[0], before);
    expect(locateComment(marker, content(`<h2>Config</h2><p>${PROMPT}</p>`))).toBeNull();
  });

  it('keeps a selection to its own word among several', () => {
    const code = content('<pre>"prompt": 1, "model": 2, "prompt": 3</pre>');
    const marker = selecting(code.querySelector('pre')!, code, 'prompt', 1);
    const after = content('<pre>"prompt": 1, "prompt": 9, "model": 2, "prompt": 3</pre>');
    const range = locateComment(marker, after)!.range!;
    expect(range.startOffset).toBe(after.textContent!.lastIndexOf('prompt'));
  });

  it('marks the block when the selected words are gone from it, and nothing when the block is too', () => {
    const marker = selecting(before.querySelectorAll('p')[1], before, 'Fornax');
    const reworded = content(`<p>${TENANT}</p><p>The example uses a TCC reference, and the workspace id is only illustrative.</p>`);
    expect(locateComment(marker, reworded)).toMatchObject({ elements: [reworded.querySelectorAll('p')[1]], range: null, stale: true });
    expect(locateComment(marker, content(`<p>${TENANT}</p><p>Unrelated words here.</p>`))).toBeNull();
  });

  it('does not follow a selection to the same word in another block', () => {
    const marker = selecting(before.querySelectorAll('p')[1], before, 'Fornax');
    expect(locateComment(marker, content(`<p>${TENANT}</p><pre>{ "Fornax": 1 }</pre>`))).toBeNull();
    const split = content('<p>Alpha</p><ul><li>The example uses a Fornax reference</li></ul>');
    expect(locateComment(marker, split)?.range?.toString()).toBe('Fornax');
  });

  it('does not take the first of several for an old selection whose block moved away', () => {
    const marker = { ...on(before.querySelectorAll('p')[1], before, { text: 'prompt', textRange: { start: 0, end: 6, quote: 'prompt' } }) };
    expect(locateComment(marker, content('<p>prompt a</p><p>nothing</p><p>prompt b</p>'))).toBeNull();
  });

  it('finds several blocks by how each read', () => {
    const [first, second] = before.querySelectorAll('p');
    const marker = on(first, before, { text: `${TENANT}\n${PROMPT}`, blockText: TENANT, extraBlocks: [{ ...describeAnchor(second, before) }] });
    const after = content(`<p>New.</p><p>${TENANT}</p><p>Between.</p><p>${PROMPT}</p>`);
    expect(locateComment(marker, after)).toMatchObject({ elements: [after.querySelectorAll('p')[1], after.querySelectorAll('p')[3]], stale: false });
    // An old comment kept only the joined text.
    const old = on(first, before, { text: `${TENANT}\n${PROMPT}`, extraBlocks: [{ selector: 'p:nth-of-type(2)', xpath: '/p[2]' }] });
    expect(locateComment(old, before)?.elements).toEqual([first, second]);
    expect(locateComment(old, after)).toBeNull();
  });
});
