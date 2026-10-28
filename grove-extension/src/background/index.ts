/// <reference types="vite/client" />
// Grove Companion Background Script
// Maintains WebSocket connection to Grove Local App and listens for commands.

console.log('[Grove Background] Started.');

const COMPANION_PROTOCOL_VERSION = 2;
const COMPANION_CAPABILITIES = [
  'browser.open.wait',
  'browser.snapshot.scoped_refs',
  'browser.interact.wait',
  'browser.extract',
  'browser.screenshot.viewport',
  'browser.reload',
  'browser.navigate',
  'browser.close',
  'browser.wait',
] as const;

// ==========================================
// ⚡ Development Auto-Reload Protocol
// ==========================================
// In development mode, standard Vite dev watches for changes, and our custom
// WebSocket server on ws://localhost:8080 triggers a hard extension reload.
if (import.meta.env.DEV) {
  console.log('[Grove Background] Dev Mode active. Connecting to auto-reloader...');
  const reloadWs = new WebSocket('ws://localhost:8080');
  
  reloadWs.onopen = () => {
    console.log('[Grove Background] Connected to auto-reloader WebSocket.');
  };

  reloadWs.onmessage = (event) => {
    if (event.data === 'reload') {
      console.log('[Grove Background] Reload signal received. Restarting extension...');
      chrome.runtime.reload();
    }
  };

  reloadWs.onerror = (err) => {
    console.warn('[Grove Background] Auto-reloader error:', err);
  };
}

// ==========================================
// 🧪 Injected functions for chrome.scripting.executeScript
// ==========================================
// These run inside the target tab, not the service worker. They must be
// self-contained — closures over module-level state will not survive the
// serialize-and-eval boundary. Helper functions live as `const` inside the
// outer function so the engine ships them all together.

function a11yTreeInjected(): { success: boolean; a11yTree?: string; snapshotId?: string; error?: string } {
  try {
    const snapshotId = `s${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    document.documentElement.dataset.groveSnapshotId = snapshotId;
    let nextRefId = 1;
    document.querySelectorAll('[data-grove-ref]').forEach((el) => {
      el.removeAttribute('data-grove-ref');
    });
    const isInteractive = (el: HTMLElement): boolean => {
      const tag = el.tagName.toLowerCase();
      if (['button', 'input', 'select', 'textarea', 'a'].includes(tag)) return true;
      if (el.getAttribute('role') === 'button' || el.getAttribute('onclick')) return true;
      if (window.getComputedStyle(el).cursor === 'pointer') return true;
      return false;
    };
    const assignRef = (el: HTMLElement): string => {
      const ref = `@${snapshotId}e${nextRefId++}`;
      el.setAttribute('data-grove-ref', ref);
      return ref;
    };
    const walk = (node: Node, depth: number): string => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        return text ? `${'  '.repeat(depth)}"${text}"\n` : '';
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'head', 'noscript', 'svg', 'path'].includes(tag)) return '';
      const isEl = isInteractive(el);
      const refStr = isEl ? ` [${assignRef(el)}]` : '';
      const role = el.getAttribute('role') || tag;
      // Use textContent rather than innerText — innerText forces a synchronous
      // layout pass per element, which is hundreds of ms on heavy pages.
      const rawName =
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.textContent?.split('\n')[0]?.trim() ||
        '';
      const nameStr = rawName
        ? rawName.length > 50
          ? ` "${rawName.substring(0, 50)}…"`
          : ` "${rawName}"`
        : '';
      let out = '';
      if (isEl || rawName) {
        out = `${'  '.repeat(depth)}<${role}${refStr}${nameStr}>\n`;
      }
      const childDepth = out ? depth + 1 : depth;
      for (let i = 0; i < el.childNodes.length; i++) {
        out += walk(el.childNodes[i], childDepth);
      }
      return out;
    };
    return { success: true, snapshotId, a11yTree: walk(document.body, 0) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function simulateInteractInjected(
  action: string,
  target: string,
  value: string | undefined,
): { success: boolean; error?: string } {
  try {
    let el: HTMLElement | null;
    if (target.startsWith('@')) {
      const expectedSnapshot = target.match(/^@(s[0-9a-f]+)e\d+$/)?.[1];
      const currentSnapshot = document.documentElement.dataset.groveSnapshotId;
      if (expectedSnapshot && expectedSnapshot !== currentSnapshot) {
        return { success: false, error: `STALE_ELEMENT_REFERENCE: ${target}` };
      }
      el = document.querySelector(`[data-grove-ref="${target}"]`) as HTMLElement | null;
    } else {
      el = document.querySelector(target) as HTMLElement | null;
    }
    if (!el) return { success: false, error: `Element not found for target: ${target}` };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    switch (action) {
      case 'click': {
        el.click();
        return { success: true };
      }
      case 'dblclick': {
        el.click();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
        return { success: true };
      }
      case 'fill':
      case 'type': {
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
        inputEl.focus();
        // React tracks input value via a wrapper around the native setter —
        // a plain `el.value = '...'` is invisible to it. Call the native
        // setter explicitly to bypass the framework wrapper.
        const proto =
          inputEl instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(inputEl, value || '');
        else inputEl.value = value || '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
      }
      case 'clear': {
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
        inputEl.focus();
        const proto = inputEl instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(inputEl, '');
        else inputEl.value = '';
        inputEl.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
      }
      case 'select': {
        const select = el as HTMLSelectElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (setter) setter.call(select, value || '');
        else select.value = value || '';
        select.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return { success: true };
      }
      case 'scroll': {
        const delta = Number(value || 0);
        if (Number.isFinite(delta) && delta !== 0) el.scrollBy({ top: delta, behavior: 'instant' });
        else el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        return { success: true };
      }
      case 'focus': {
        el.focus();
        return { success: true };
      }
      case 'hover': {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        return { success: true };
      }
      case 'check':
      case 'uncheck': {
        const checkbox = el as HTMLInputElement;
        const wantChecked = action === 'check';
        if (checkbox.checked !== wantChecked) checkbox.click();
        return { success: true };
      }
      case 'press': {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
        return { success: true };
      }
      default:
        return { success: false, error: `Unsupported interaction action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

function extractContentInjected(
  extractType: string,
  target: string | undefined,
): { success: boolean; data?: unknown; error?: string; truncated?: boolean } {
  try {
    let el: HTMLElement | null = null;
    if (target) {
      if (target.startsWith('@')) {
        const expectedSnapshot = target.match(/^@(s[0-9a-f]+)e\d+$/)?.[1];
        const currentSnapshot = document.documentElement.dataset.groveSnapshotId;
        if (expectedSnapshot && expectedSnapshot !== currentSnapshot) {
          return { success: false, error: `STALE_ELEMENT_REFERENCE: ${target}` };
        }
        el = document.querySelector(`[data-grove-ref="${target}"]`) as HTMLElement | null;
      } else {
        el = document.querySelector(target) as HTMLElement | null;
      }
    }
    // Cap extracted bodies at 1 MB — long Reddit threads or Gmail conversations
    // can return tens of MBs which choke the WS pipe back to grove and the
    // agent's context window.
    const MAX_BYTES = 1024 * 1024;
    const capped = (s: string) =>
      s.length > MAX_BYTES ? { value: s.slice(0, MAX_BYTES), truncated: true } : { value: s, truncated: false };
    switch (extractType) {
      case 'url':
        return { success: true, data: window.location.href };
      case 'title':
        return { success: true, data: document.title };
      case 'text': {
        // Use textContent rather than innerText for the same reason a11y tree
        // does — innerText forces a synchronous layout pass and on a long
        // page (huge thread, infinite feed) can block the main thread for
        // hundreds of ms. textContent walks the DOM cheaply.
        const raw = el
          ? el.textContent ?? ''
          : document.body.textContent ?? '';
        const { value, truncated } = capped(raw);
        return { success: true, data: value, truncated };
      }
      case 'html': {
        const raw = el ? el.outerHTML : document.documentElement.outerHTML;
        const { value, truncated } = capped(raw);
        return { success: true, data: value, truncated };
      }
      case 'value': {
        if (!el) return { success: false, error: 'No target element specified for value extraction' };
        const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        return { success: true, data: inputEl.value };
      }
      default:
        return { success: false, error: `Unsupported extraction type: ${extractType}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

type BrowserWaitCondition = {
  condition: 'load' | 'url' | 'selector' | 'text' | 'delay';
  target?: string;
  state?: string;
  value?: string;
};

type BrowserTabSummary = {
  tabId: number;
  url: string;
  title: string;
  status: string;
};

function chromeErrorMessage(fallback: string): string {
  return chrome.runtime.lastError?.message || fallback;
}

function getTabSummary(tabId: number): Promise<BrowserTabSummary> {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(new Error(`TAB_NOT_FOUND: ${chromeErrorMessage(String(tabId))}`));
        return;
      }
      resolve({
        tabId,
        url: tab.url || '',
        title: tab.title || '',
        status: tab.status || 'unknown',
      });
    });
  });
}

/** Register listeners before triggering navigation so fast pages cannot finish
 * between the Chrome API callback and listener installation. */
function navigateAndWait(
  tabId: number,
  trigger: () => void,
  timeoutMs: number,
): Promise<BrowserTabSummary> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawNavigationEvent = false;
    const finish = (error?: Error, tab?: BrowserTabSummary) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else if (tab) resolve(tab);
      else reject(new Error('PAGE_LOAD_FAILED: no tab result'));
    };
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading' || changeInfo.url) {
        sawNavigationEvent = true;
      }
      if (changeInfo.status !== 'complete') return;
      void getTabSummary(tabId).then((tab) => finish(undefined, tab), (error) => finish(error));
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(new Error(`TAB_NOT_FOUND: ${tabId} was closed`));
    };
    const timer = setTimeout(() => {
      finish(new Error(
        `PAGE_LOAD_TIMEOUT: tab ${tabId} did not complete within ${timeoutMs}ms; side_effect_started=true`,
      ));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    trigger();

    // Chrome occasionally coalesces loading+complete for cached pages. Check
    // after a short grace period, but never synchronously accept the old
    // pre-navigation `complete` state.
    setTimeout(() => {
      if (settled || sawNavigationEvent) return;
      void getTabSummary(tabId).then((tab) => {
        if (tab.status === 'complete') finish(undefined, tab);
      }, (error) => finish(error));
    }, 150);
  });
}

function checkDomWaitConditionInjected(
  condition: BrowserWaitCondition,
): { success: boolean; matched?: boolean; error?: string } {
  try {
    const resolveTarget = (target?: string): HTMLElement | null => {
      if (!target) return document.body;
      if (target.startsWith('@')) {
        const expectedSnapshot = target.match(/^@(s[0-9a-f]+)e\d+$/)?.[1];
        const currentSnapshot = document.documentElement.dataset.groveSnapshotId;
        if (expectedSnapshot && expectedSnapshot !== currentSnapshot) {
          throw new Error(`STALE_ELEMENT_REFERENCE: ${target}`);
        }
      }
      return target.startsWith('@')
        ? document.querySelector(`[data-grove-ref="${target}"]`)
        : document.querySelector(target);
    };
    const el = resolveTarget(condition.target) as HTMLElement | null;
    if (condition.condition === 'selector') {
      const state = condition.state || 'visible';
      if (state === 'attached') return { success: true, matched: !!el };
      if (state === 'detached') return { success: true, matched: !el };
      if (!el) return { success: true, matched: state === 'hidden' };
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0;
      return { success: true, matched: state === 'hidden' ? !visible : visible };
    }
    if (condition.condition === 'text') {
      const actual = el?.textContent || '';
      const expected = condition.value || '';
      const state = condition.state || 'contains';
      if (state === 'equals') return { success: true, matched: actual.trim() === expected };
      if (state === 'matches') {
        return { success: true, matched: new RegExp(expected).test(actual) };
      }
      if (state === 'hidden') return { success: true, matched: !actual.includes(expected) };
      return { success: true, matched: actual.includes(expected) };
    }
    return { success: false, error: `Unsupported DOM wait condition: ${condition.condition}` };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}

async function waitForCondition(
  tabId: number,
  condition: BrowserWaitCondition | undefined,
  timeoutMs: number,
): Promise<{ condition: string; durationMs: number }> {
  const startedAt = Date.now();
  const selected = condition || { condition: 'load' as const };
  if (selected.condition === 'delay') {
    const duration = Math.max(0, Math.min(Number(selected.value || 0), timeoutMs));
    await new Promise((resolve) => setTimeout(resolve, duration));
    return { condition: 'delay', durationMs: Date.now() - startedAt };
  }
  for (;;) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `WAIT_TIMEOUT: ${selected.condition} condition was not satisfied within ${timeoutMs}ms`,
      );
    }
    if (selected.condition === 'load') {
      const tab = await getTabSummary(tabId);
      if (tab.status === 'complete') {
        return { condition: 'load', durationMs: Date.now() - startedAt };
      }
    } else if (selected.condition === 'url') {
      const tab = await getTabSummary(tabId);
      const expected = selected.value || '';
      const state = selected.state || 'contains';
      const matched = state === 'equals'
        ? tab.url === expected
        : state === 'matches'
          ? new RegExp(expected).test(tab.url)
          : tab.url.includes(expected);
      if (matched) return { condition: 'url', durationMs: Date.now() - startedAt };
    } else {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: checkDomWaitConditionInjected,
        args: [selected],
      });
      const result = results[0]?.result;
      if (!result?.success) throw new Error(`WAIT_FAILED: ${result?.error || 'no_result'}`);
      if (result.matched) {
        return { condition: selected.condition, durationMs: Date.now() - startedAt };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ==========================================
// Connection settings are owned by the background worker so reconnects never
// silently replace a manually selected remote server with a local one.
const DEFAULT_ADDRESS = 'http://127.0.0.1:3001';
const GROVE_CONNECT_TIMEOUT_MS = 4000;
type ConnectionSettings = { address: string; passkey: string; autoDiscover: boolean };
let activeAddress = DEFAULT_ADDRESS;
let groveWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
let connectInFlight = false;
let connectionGeneration = 0;

async function settings(): Promise<ConnectionSettings> {
  const data = await chrome.storage.local.get(['grove_connection', 'grove_port']);
  if (data.grove_connection) return data.grove_connection as ConnectionSettings;
  return { address: `http://127.0.0.1:${data.grove_port || 3001}`, passkey: '', autoDiscover: true };
}

async function pingAddress(address: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`${address}/api/v1/auth/info`, { signal: controller.signal });
    if (!response.ok) return false;
    const info = await response.json();
    return typeof info.required === 'boolean' && typeof info.mode === 'string';
  } catch { return false; } finally { clearTimeout(timeout); }
}

async function signedSocketUrl(config: ConnectionSettings): Promise<string> {
  const url = new URL('/api/v1/extension/ws', config.address);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (config.passkey) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().replaceAll('-', '');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(config.passkey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}|${nonce}|GET|/api/v1/extension/ws`));
    const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
    url.search = new URLSearchParams({ ts: timestamp, nonce, sig: hex }).toString();
  }
  return url.toString();
}

async function connectToGrove() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (connectInFlight || groveWs?.readyState === WebSocket.OPEN || groveWs?.readyState === WebSocket.CONNECTING) return;
  connectInFlight = true;
  const generation = connectionGeneration;
  try {
    const config = await settings();
    if (config.autoDiscover && !(await pingAddress(config.address))) {
      const addresses = Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${3001 + i}`);
      const found = await Promise.all(addresses.map(pingAddress));
      config.address = addresses[found.findIndex(Boolean)] || config.address;
    }
    const url = await signedSocketUrl(config);
    if (generation !== connectionGeneration) return;
    activeAddress = config.address;
    const myWs = new WebSocket(url);
    groveWs = myWs;
    const connectTimeout = setTimeout(() => {
      if (groveWs === myWs && myWs.readyState === WebSocket.CONNECTING) myWs.close();
    }, GROVE_CONNECT_TIMEOUT_MS);
    myWs.onopen = () => {
      if (groveWs !== myWs) return;
      clearTimeout(connectTimeout);
      myWs.send(JSON.stringify({ type: 'COMPANION_HELLO', extensionVersion: chrome.runtime.getManifest().version, protocolVersion: COMPANION_PROTOCOL_VERSION, capabilities: COMPANION_CAPABILITIES }));
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        if (groveWs === myWs && myWs.readyState === WebSocket.OPEN) myWs.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    };
    myWs.onmessage = async (event) => {
      if (groveWs !== myWs) return;
      try { await handleGroveMessage(JSON.parse(event.data)); }
      catch (error) { console.error('[Grove Background] Invalid message:', error); }
    };
    myWs.onclose = () => {
      if (groveWs !== myWs) return;
      clearTimeout(connectTimeout);
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      groveWs = null;
      reconnectTimer = setTimeout(connectToGrove, 5000);
    };
    myWs.onerror = () => console.warn('[Grove Background] Connection failed.');
  } catch (error) {
    console.error('[Grove Background] Connection setup failed:', error);
    if (generation === connectionGeneration) reconnectTimer = setTimeout(connectToGrove, 5000);
  } finally {
    connectInFlight = false;
    if (generation !== connectionGeneration) void connectToGrove();
  }
}

// Helper to manage Chrome Tab Groups based on task/project name. Scopes the
// title-match to the tab's window — otherwise a same-named group in another
// window would silently yank the new tab into that window, which is jarring.
function groupTab(tabId: number, groupName?: string): Promise<number | null> {
  if (!groupName) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve(null);
        return;
      }
      chrome.tabGroups.query({ windowId: tab.windowId }, (groups) => {
        const match = groups.find((g) => g.title === groupName);
        if (match) {
          chrome.tabs.group({ tabIds: [tabId], groupId: match.id }, () => {
            resolve(match.id);
          });
        } else {
          chrome.tabs.group({ tabIds: [tabId] }, (newGroupId) => {
            chrome.tabGroups.update(newGroupId, { title: groupName, color: 'cyan' }, () => {
              resolve(newGroupId);
            });
          });
        }
      });
    });
  });
}

// Handle inbound requests from the Grove Agent
async function handleGroveMessage(msg: any) {
  if (!groveWs || groveWs.readyState !== WebSocket.OPEN) return;

  switch (msg.type) {
    case 'GET_ALL_TABS': {
      chrome.tabs.query({}, (tabs) => {
        const tabList = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
        groveWs?.send(JSON.stringify({
          type: 'ALL_TABS_RESPONSE',
          id: msg.id,
          data: tabList
        }));
      });
      break;
    }

    case 'PROXY_FETCH_TITLE': {
      const url = msg.url;
      try {
        // Limit to http(s) — file://, chrome://, chrome-extension://, ftp://
        // etc. should never round-trip through the extension's cookie jar.
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('invalid_url');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`scheme_not_allowed: ${parsed.protocol}`);
        }

        const response = await fetch(url);
        // Cap body to 256 KB. Reading the full body of an unbounded URL
        // (huge JSON dump, infinite stream) would OOM the service worker.
        const MAX_BYTES = 256 * 1024;
        const reader = response.body?.getReader();
        let html = '';
        if (reader) {
          const decoder = new TextDecoder('utf-8');
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (received >= MAX_BYTES) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
          html += decoder.decode();
        } else {
          html = await response.text();
        }
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        groveWs?.send(JSON.stringify({
          type: 'PROXY_FETCH_RESPONSE',
          id: msg.id,
          data: { url, title }
        }));
      } catch (err: any) {
        console.error('[Grove Background] Proxy fetch failed:', err);
        groveWs?.send(JSON.stringify({
          type: 'PROXY_FETCH_ERROR',
          id: msg.id,
          error: err.message
        }));
      }
      break;
    }

    case 'BROWSER_OPEN': {
      const url = msg.url;
      const groupName = msg.groupName;
      chrome.tabs.create({ url }, async (tab) => {
        if (tab && tab.id) {
          // Distinguish three cases so the caller can tell apart:
          //   - groupName not requested   → groupId omitted
          //   - groupName requested, OK    → groupId: <number>
          //   - groupName requested, fail  → groupError set
          const payload: {
            success: boolean;
            tabId: number;
            groupId?: number;
            groupError?: string;
          } = { success: true, tabId: tab.id };
          if (groupName) {
            const groupId = await groupTab(tab.id, groupName);
            if (groupId !== null) {
              payload.groupId = groupId;
            } else {
              payload.groupError = 'failed to assign tab to group';
            }
          }
          try {
            const timeoutMs = Math.max(100, Math.min(Number(msg.timeoutMs || 15000), 60000));
            const startedAt = Date.now();
            await waitForCondition(tab.id, { condition: 'load' }, timeoutMs);
            const wait = msg.waitFor
              ? await waitForCondition(
                  tab.id,
                  msg.waitFor,
                  Math.max(100, timeoutMs - (Date.now() - startedAt)),
                )
              : { condition: 'load', durationMs: Date.now() - startedAt };
            groveWs?.send(JSON.stringify({
              type: 'BROWSER_OPEN_RESPONSE',
              id: msg.id,
              data: { ...payload, tab: await getTabSummary(tab.id), wait },
            }));
          } catch (error) {
            groveWs?.send(JSON.stringify({
              type: 'BROWSER_OPEN_RESPONSE',
              id: msg.id,
              data: {
                ...payload,
                success: false,
                error: (error as Error).message,
                sideEffectStarted: true,
              },
            }));
          }
        } else {
          groveWs?.send(JSON.stringify({
            type: 'BROWSER_OPEN_RESPONSE',
            id: msg.id,
            data: { success: false, error: 'Failed to create tab' }
          }));
        }
      });
      break;
    }

    case 'BROWSER_RELOAD': {
      const tabId = msg.tabId;
      const timeoutMs = Math.max(100, Math.min(Number(msg.timeoutMs || 15000), 60000));
      const startedAt = Date.now();
      try {
        await getTabSummary(tabId);
        const tab = await navigateAndWait(tabId, () => {
          chrome.tabs.reload(tabId, { bypassCache: !!msg.bypassCache });
        }, timeoutMs);
        const wait = msg.waitFor
          ? await waitForCondition(
              tabId,
              msg.waitFor,
              Math.max(100, timeoutMs - (Date.now() - startedAt)),
            )
          : { condition: 'load', durationMs: 0 };
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_RELOAD_RESPONSE',
          id: msg.id,
          data: { success: true, tab, wait, refsInvalidated: true },
        }));
      } catch (error) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_RELOAD_RESPONSE',
          id: msg.id,
          data: { success: false, error: (error as Error).message },
        }));
      }
      break;
    }

    case 'BROWSER_NAVIGATE': {
      const tabId = msg.tabId;
      const timeoutMs = Math.max(100, Math.min(Number(msg.timeoutMs || 15000), 60000));
      const startedAt = Date.now();
      try {
        await getTabSummary(tabId);
        if (!['goto', 'back', 'forward'].includes(msg.action)) {
          throw new Error(`INVALID_ACTION: ${msg.action}`);
        }
        if (msg.action === 'goto' && !msg.url) {
          throw new Error('INVALID_INPUT: url is required for goto');
        }
        const tab = await navigateAndWait(tabId, () => {
          if (msg.action === 'goto') chrome.tabs.update(tabId, { url: msg.url });
          else if (msg.action === 'back') chrome.tabs.goBack(tabId);
          else chrome.tabs.goForward(tabId);
        }, timeoutMs);
        const wait = msg.waitFor
          ? await waitForCondition(
              tabId,
              msg.waitFor,
              Math.max(100, timeoutMs - (Date.now() - startedAt)),
            )
          : { condition: 'load', durationMs: 0 };
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_NAVIGATE_RESPONSE',
          id: msg.id,
          data: { success: true, tab, wait, refsInvalidated: true },
        }));
      } catch (error) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_NAVIGATE_RESPONSE',
          id: msg.id,
          data: { success: false, error: (error as Error).message },
        }));
      }
      break;
    }

    case 'BROWSER_CLOSE': {
      const tabId = msg.tabId;
      try {
        await getTabSummary(tabId);
        await new Promise<void>((resolve, reject) => {
          chrome.tabs.remove(tabId, () => {
            if (chrome.runtime.lastError) reject(new Error(`TAB_CLOSE_FAILED: ${chrome.runtime.lastError.message}`));
            else resolve();
          });
        });
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_CLOSE_RESPONSE',
          id: msg.id,
          data: { success: true, tabId, closed: true },
        }));
      } catch (error) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_CLOSE_RESPONSE',
          id: msg.id,
          data: { success: false, error: (error as Error).message },
        }));
      }
      break;
    }

    case 'BROWSER_WAIT': {
      const tabId = msg.tabId;
      const timeoutMs = Math.max(100, Math.min(Number(msg.timeoutMs || 15000), 60000));
      try {
        await getTabSummary(tabId);
        const wait = await waitForCondition(tabId, msg.waitFor, timeoutMs);
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_WAIT_RESPONSE',
          id: msg.id,
          data: { success: true, wait, tab: await getTabSummary(tabId) },
        }));
      } catch (error) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_WAIT_RESPONSE',
          id: msg.id,
          data: { success: false, error: (error as Error).message },
        }));
      }
      break;
    }

    case 'BROWSER_SNAPSHOT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SNAPSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: a11yTreeInjected,
        });
        const data = results[0]?.result ?? { success: false, error: 'no_result' };
        groveWs?.send(JSON.stringify({ type: 'BROWSER_SNAPSHOT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SNAPSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_INTERACT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_INTERACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: simulateInteractInjected,
          args: [msg.action, msg.target, msg.value],
        });
        const interaction = results[0]?.result ?? { success: false, error: 'no_result' };
        const data = interaction.success && msg.waitFor
          ? {
              ...interaction,
              wait: await waitForCondition(tabId, msg.waitFor, Number(msg.timeoutMs || 15000)),
            }
          : interaction;
        groveWs?.send(JSON.stringify({ type: 'BROWSER_INTERACT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_INTERACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_EXTRACT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_EXTRACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: extractContentInjected,
          args: [msg.extractType, msg.target],
        });
        const data = results[0]?.result ?? { success: false, error: 'no_result' };
        groveWs?.send(JSON.stringify({ type: 'BROWSER_EXTRACT_RESPONSE', id: msg.id, data }));
      } catch (err: any) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_EXTRACT_RESPONSE',
          id: msg.id,
          data: { success: false, error: `inject_failed: ${err?.message ?? String(err)}` },
        }));
      }
      break;
    }

    case 'BROWSER_SCREENSHOT': {
      const tabId = msg.tabId;
      if (typeof tabId !== 'number') {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SCREENSHOT_RESPONSE',
          id: msg.id,
          data: { success: false, error: 'tab_id required' }
        }));
        return;
      }
      try {
        const tab = await getTabSummary(tabId);
        const timeoutMs = Math.max(100, Math.min(Number(msg.timeoutMs || 15000), 60000));
        if (msg.waitFor) await waitForCondition(tabId, msg.waitFor, timeoutMs);
        const chromeTab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
          chrome.tabs.get(tabId, (value) => {
            if (chrome.runtime.lastError || !value) reject(new Error(chromeErrorMessage('TAB_NOT_FOUND')));
            else resolve(value);
          });
        });
        await chrome.tabs.update(tabId, { active: true });
        const screenshot = await chrome.tabs.captureVisibleTab(chromeTab.windowId, { format: 'png' });
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SCREENSHOT_RESPONSE', id: msg.id,
          data: { success: true, screenshot, mode: 'viewport', format: 'png', tab, activatedTab: true },
        }));
      } catch (error) {
        groveWs?.send(JSON.stringify({
          type: 'BROWSER_SCREENSHOT_RESPONSE', id: msg.id,
          data: { success: false, error: (error as Error).message },
        }));
      }
      break;
    }

    default:
      console.warn('[Grove Background] Unknown message type:', msg.type);
      if (msg.id) {
        groveWs?.send(JSON.stringify({
          type: 'UNSUPPORTED_COMMAND_RESPONSE',
          id: msg.id,
          data: {
            success: false,
            error: `UNSUPPORTED_COMMAND: Grove Companion does not recognize ${String(msg.type)}`,
          },
        }));
      }
  }
}

// Start local connection attempt on extension startup
// We try to connect, failing open if the server is not active
connectToGrove();

// MV3 service workers are aggressively suspended after ~30s idle. Without a
// wake-up source, our reconnect timer is destroyed when the SW dies and the
// WS stays disconnected until the user pokes the popup. Two safety nets:
//
//  1. `chrome.runtime.onStartup` / `onInstalled` → connect at browser boot
//     and immediately after install/upgrade.
//  2. `chrome.alarms` heartbeat every ~25s → re-runs the worker and checks
//     the WS state; reconnects if it's dropped.
chrome.runtime.onStartup.addListener(() => {
  connectToGrove();
});
chrome.runtime.onInstalled.addListener(() => {
  connectToGrove();
});
// 0.5 minute = 30s. Chrome's MV3 alarm minimum is enforced on most builds
// and at 0.4 (24s) Chrome may silently round up to 30s, putting the wake
// after the idle-kill instead of before. 0.5 lines up exactly with the
// idle limit — the alarm fires just in time to keep us alive.
chrome.alarms.create('grove-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'grove-keepalive') return;
  if (groveWs?.readyState === WebSocket.OPEN) {
    groveWs.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToGrove();
  }
});

// Keep editing state in the popup separate from actual connection state.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GROVE_CONNECTION_STATUS') {
    sendResponse({ connected: groveWs?.readyState === WebSocket.OPEN, connecting: connectInFlight || groveWs?.readyState === WebSocket.CONNECTING, address: activeAddress });
    return;
  }
  if (message?.type === 'GROVE_CONNECT') {
    void (async () => {
      await chrome.storage.local.set({ grove_connection: message.config });
      connectionGeneration++;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (groveWs) { const previous = groveWs; groveWs = null; previous.close(); }
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
      activeAddress = message.config.address;
      void connectToGrove();
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
});
