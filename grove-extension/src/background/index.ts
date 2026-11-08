/// <reference types="vite/client" />
// Grove Companion Background Script
// Maintains WebSocket connection to Grove Local App and listens for commands.

import { RELAY_CAPABILITY, closeAllSockets, handleRelayMessage, installRelay } from './cdpRelay';

console.log('[Grove Background] Started.');

const COMPANION_PROTOCOL_VERSION = 3;
const COMPANION_CAPABILITIES = [RELAY_CAPABILITY] as const;

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
      closeAllSockets();
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
  if (handleRelayMessage(msg)) return;

  switch (msg.type) {
    case 'GET_ALL_TABS': {
      chrome.tabs.query({}, async (tabs) => {
        const targets = await chrome.debugger.getTargets().catch(() => []);
        const targetOf = new Map(targets.map((target) => [target.tabId, target.id]));
        const tabList = tabs.map(t => ({
          id: t.id,
          targetId: t.id === undefined ? undefined : targetOf.get(t.id),
          title: t.title,
          url: t.url,
          favIconUrl: t.favIconUrl,
        }));
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

installRelay({
  send: (message) => groveWs?.send(JSON.stringify(message)),
  groupTab,
});

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
