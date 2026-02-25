// API client base configuration
// In dev mode, vite proxy forwards /api to backend
// In prod mode (served by grove web), use relative path
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export interface ApiError {
  status: number;
  message: string;
  // Parsed JSON body if available
  data?: unknown;
}

type ErrorPayload = { message: string; data?: unknown };

// ─── Secret Key management (HMAC-SHA256) ─────────────────────────────────────

const SK_KEY = 'grove_auth_sk';

export function getSecretKey(): string | null {
  return sessionStorage.getItem(SK_KEY);
}

export function setSecretKey(sk: string) {
  sessionStorage.setItem(SK_KEY, sk);
}

export function clearSecretKey() {
  sessionStorage.removeItem(SK_KEY);
}

/** Extract secret key from URL hash fragment: /#sk=xxx */
export function extractSkFromUrl(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const match = hash.match(/[#&]sk=([^&]*)/);
  return match ? match[1] : null;
}

// ─── HMAC-SHA256 signing ─────────────────────────────────────────────────────

import { hmacSha256Hex } from './hmac';

/** Compute HMAC-SHA256(sk, message) and return hex string. */
export async function computeHmac(message: string): Promise<string | null> {
  const sk = getSecretKey();
  if (!sk) return null;
  return hmacSha256Hex(sk, message);
}

/** Generate a random nonce (16 hex chars). */
function generateNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Sign a request and return {timestamp, nonce, signature}. */
async function signRequest(
  method: string,
  path: string,
): Promise<{ timestamp: string; nonce: string; signature: string } | null> {
  const sk = getSecretKey();
  if (!sk) return null;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();
  const message = `${timestamp}|${nonce}|${method}|${path}`;
  const signature = await computeHmac(message);
  if (!signature) return null;
  return { timestamp, nonce, signature };
}

/** Build HMAC auth headers for an HTTP request. */
async function getSignedHeaders(
  method: string,
  path: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const sig = await signRequest(method, path);
  if (sig) {
    headers['X-Timestamp'] = sig.timestamp;
    headers['X-Nonce'] = sig.nonce;
    headers['X-Signature'] = sig.signature;
  }
  return headers;
}

/** Append HMAC signature as query params to a WebSocket URL (async). */
export async function appendHmacToUrl(url: string): Promise<string> {
  // Extract the pathname for signing
  let pathname: string;
  try {
    const parsed = new URL(url, window.location.origin);
    pathname = parsed.pathname;
  } catch {
    // Fallback: extract path from ws:// URL
    const pathMatch = url.match(/wss?:\/\/[^/]+(\/[^?#]*)/);
    pathname = pathMatch ? pathMatch[1] : '/';
  }

  const sig = await signRequest('GET', pathname);
  if (!sig) return url;

  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}ts=${sig.timestamp}&nonce=${sig.nonce}&sig=${sig.signature}`;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

// Try to extract error message (and JSON body) from response
async function extractErrorPayload(response: Response): Promise<ErrorPayload> {
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        // Check common error message fields
        return {
          message: json.message || json.error || json.detail || text,
          data: json,
        };
      } catch {
        // Not JSON, return raw text
        return { message: text };
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return { message: response.statusText };
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: await getSignedHeaders('GET', path),
    });

    if (!response.ok) {
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    return response.json();
  }

  async patch<T, R>(path: string, data: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: await getSignedHeaders('PATCH', path),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    return response.json();
  }

  async post<T, R>(path: string, data?: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: await getSignedHeaders('POST', path),
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    return response.json();
  }

  async delete<T = void>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: await getSignedHeaders('DELETE', path),
    });

    if (!response.ok) {
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    // Try to parse JSON response, return undefined for void type
    const text = await response.text();
    if (text) {
      return JSON.parse(text) as T;
    }
    return undefined as T;
  }

  async put<T, R>(path: string, data: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: await getSignedHeaders('PUT', path),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    return response.json();
  }
}

// Default client instance
export const apiClient = new ApiClient();

/// Get the API host for WebSocket connections.
/// In dev mode (VITE_API_URL set), extract host from that URL.
/// In prod mode, use window.location.host.
export function getApiHost(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) {
    try {
      const url = new URL(envUrl, window.location.origin);
      return url.host;
    } catch {
      // fallback
    }
  }
  return window.location.host;
}
