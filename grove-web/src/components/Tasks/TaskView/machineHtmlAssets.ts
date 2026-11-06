import { useEffect, useState } from "react";
import { apiClient, getMachineApiBase } from "../../../api/client";

const RAW_ASSET = /\b(src|href)(\s*=\s*)(['"])(\/api\/v1\/[^'"]+\/file\/raw\?path=[^'"]+)\3/gi;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
}

/** Writes a preview's worktree assets into the HTML itself; one that can't load keeps its URL. */
export async function inlineRawAssets(html: string, load: (path: string) => Promise<Blob>): Promise<string> {
  const paths = [...new Set([...html.matchAll(RAW_ASSET)].map((match) => match[4]))];
  const loaded = await Promise.all(paths.map(async (path) => {
    try {
      return [path, await toDataUrl(await load(path))] as const;
    } catch {
      return [path, null] as const;
    }
  }));
  const dataUrls = new Map(loaded);
  return html.replace(RAW_ASSET, (match, attr: string, equals: string, quote: string, path: string) => {
    const dataUrl = dataUrls.get(path);
    return dataUrl ? `${attr}${equals}${quote}${dataUrl}${quote}` : match;
  });
}

/**
 * An HTML preview's assets can't load from a paired machine's port: frames send
 * no Origin, and that port only answers the home window. They come along in the
 * document there. At home the HTML passes through.
 */
export function useMachineHtmlAssets(html: string): string {
  const [inlined, setInlined] = useState<{ source: string; html: string } | null>(null);
  useEffect(() => {
    if (!html || !getMachineApiBase()) return;
    let alive = true;
    void inlineRawAssets(html, (path) => apiClient.getBlob(path)).then((result) => {
      if (alive) setInlined({ source: html, html: result });
    });
    return () => { alive = false; };
  }, [html]);
  return inlined?.source === html ? inlined.html : html;
}
