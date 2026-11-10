import anchorSource from "../../../utils/commentAnchor.js?raw";
import bridgeSource from "./bridge.js?raw";

// The anchor code is a module for the app; a frame gets it as plain script
// under one name, ahead of the bridge that uses it.
const ANCHOR_SCRIPT = `window.__groveAnchor=(function(){${anchorSource.replace(/^export /gm, "")}
return{selectorOf:selectorOf,xpathOf:xpathOf,anchorText:anchorText,locateAnchor:locateAnchor};})();`;

/**
 * A design page as the document of its sandboxed frame: the page's own HTML
 * with a `<base>` so its relative files load, and the bridge script ahead of
 * everything the page runs.
 */
export function buildDesignDocument(html: string, options: { frameId: string; filesBase: string; accent: string; version: string }): string {
  const config = JSON.stringify(options).replace(/</g, "\\u003c");
  const head = [
    /<base[\s>]/i.test(html) ? "" : `<base href="${options.filesBase.replace(/"/g, "&quot;")}">`,
    `<script>window.__groveDesign=${config};</script>`,
    `<script>${ANCHOR_SCRIPT}${bridgeSource}</script>`,
  ].join("");
  // `<head>` and `<html>` only: `<header>` starts the same way.
  if (HEAD_TAG.test(html)) return html.replace(HEAD_TAG, (tag) => `${tag}${head}`);
  if (HTML_TAG.test(html)) return html.replace(HTML_TAG, (tag) => `${tag}<head>${head}</head>`);
  return `${head}${html}`;
}

const HEAD_TAG = /<head(\s[^>]*)?>/i;
const HTML_TAG = /<html(\s[^>]*)?>/i;

let library: Promise<string> | null = null;

/** The screenshot library's source, sent into a frame the first time it draws. */
export function screenshotLibrary(): Promise<string> {
  library ??= import("modern-screenshot/dist/index.js?raw").then((module) => module.default);
  return library;
}
