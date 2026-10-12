import { apiClient, clearDeviceSession, fetchWithAuthorization, extractErrorPayload, getApiBaseUrl, getDeviceId, getDeviceSigningKey, getSignedHeaders, setDeviceSession, rememberDeviceSession, forgetRememberedDeviceSession, withAuthTransition } from './client';
import { hmacSha256Hex } from './hmac';

export interface LoginDevice {
  id: string;
  name: string;
  client: string;
  trusted: boolean;
  created_at: number;
  last_used_at: number;
  port?: number;
}

export interface AuthInfo {
  required: boolean;
  remote?: boolean;
  device_sessions?: boolean;
  trusted_devices?: boolean;
  trusted_device_cookies?: boolean;
}

export class AuthRequestError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const apiOrigin = new URL(getApiBaseUrl() || window.location.origin, window.location.origin).origin;
const browserKey = `grove_auth_browser:${apiOrigin}`;
const logoutKey = `grove_auth_signed_out:${apiOrigin}`;
export const AUTH_LOGOUT_EVENT = 'grove-auth-logout';

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// This identifies browser storage, not hardware, and grants no access by itself.
function browserId() {
  const existing = localStorage.getItem(browserKey);
  if (existing && /^[a-f0-9]{64}$/i.test(existing)) return existing;
  const id = randomHex();
  localStorage.setItem(browserKey, id);
  return id;
}

async function rawRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithAuthorization(`${getApiBaseUrl()}${path}`, {
    cache: 'no-store', credentials: 'same-origin', ...init,
  });
  if (!response.ok) {
    const payload = await extractErrorPayload(response);
    throw new AuthRequestError(response.status, payload.message, payload.code);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function getAuthInfo() { return rawRequest<AuthInfo>('/api/v1/auth/info'); }

export async function getAuthSession() {
  const path = `/api/v1/auth/session?browser_id=${browserId()}`;
  return rawRequest<{ device: LoginDevice | null; required: boolean }>(path, { headers: await getSignedHeaders('GET', path) });
}

export function canTrustDevice(info: AuthInfo) {
  return !!info.device_sessions && !!info.trusted_devices;
}

export function canUseTrustedDeviceCookie(info: AuthInfo) {
  const api = new URL(getApiBaseUrl() || window.location.origin, window.location.origin);
  return !!(info.trusted_device_cookies ?? info.trusted_devices) && api.origin === window.location.origin && api.protocol === 'https:';
}

export function trustCurrentDevice(useCookie = window.location.protocol === 'https:') { return withAuthTransition(async () => {
  const path = `/api/v1/auth/trust?cookie=${useCookie}`;
  const previous = getDeviceId();
  const key = useCookie ? undefined : getDeviceSigningKey() ?? undefined;
  if (!useCookie && !key) throw new AuthRequestError(403, 'Sign in again to remember this device.');
  const device = await rawRequest<LoginDevice>(path, { method: 'POST', headers: await getSignedHeaders('POST', path) });
  setDeviceSession(device.id, key);
  const session = await getAuthSession();
  if (session.device?.id !== device.id) throw new AuthRequestError(403, 'This browser could not remember sign-in.');
  if (previous) forgetRememberedDeviceSession(previous);
  rememberDeviceSession(device.id, key);
  return device;
}); }

/** HTTP remembers only a revocable device signing key, never the master key.
 * HTTPS uses an HttpOnly cookie when the serving path supports it. */
export function loginDevice(secret: string, trusted: boolean, useCookie = window.location.protocol === 'https:') { return withAuthTransition(async () => {
  const id = randomHex();
  const previous = getDeviceId();
  const cookie = trusted && useCookie;
  const query = new URLSearchParams({ browser_id: browserId(), device_id: id, trusted: String(trusted) });
  if (trusted) query.set('cookie', String(cookie));
  if (previous) query.set('previous_device_id', previous);
  query.sort();
  const path = `/api/v1/auth/login?${query}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomHex();
  const signature = await hmacSha256Hex(secret, `${timestamp}|${nonce}|POST|${path}`);
  const device = await rawRequest<LoginDevice>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature },
    body: JSON.stringify({ standalone: window.matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone }),
  });
  const key = cookie ? undefined : await hmacSha256Hex(secret, `grove-device-key-v1|${id}`);
  setDeviceSession(device.id, key);
  // Validate the stored authorization before reporting successful sign-in.
  if (trusted) {
    const session = await getAuthSession();
    if (session.device?.id !== device.id) throw new AuthRequestError(403, 'This browser could not remember sign-in. Try connecting without trusting this device.');
  }
  if (previous) forgetRememberedDeviceSession(previous);
  if (trusted) rememberDeviceSession(device.id, key);
  return device;
}); }

/** A failed request leaves authorization and the UI intact. */
export async function logoutDevice() {
  const id = getDeviceId();
  const path = '/api/v1/auth/logout';
  await rawRequest<void>(path, { method: 'POST', headers: await getSignedHeaders('POST', path) });
  const stillCurrent = getDeviceId() === id;
  if (stillCurrent) clearDeviceSession();
  if (id) {
    // Broadcast only a confirmed revocation. This is never a pending operation.
    localStorage.setItem(logoutKey, JSON.stringify({ id, nonce: randomHex() }));
  }
  if (stillCurrent) window.dispatchEvent(new CustomEvent(AUTH_LOGOUT_EVENT, { detail: id }));
}

export function subscribeToLogout(callback: () => void) {
  const local = () => callback();
  const storage = (event: StorageEvent) => {
    if (event.key !== logoutKey || !event.newValue) return;
    try {
      const { id } = JSON.parse(event.newValue) as { id: string };
      if (id !== getDeviceId()) return;
      clearDeviceSession();
      callback();
    } catch { /* Ignore malformed notifications. */ }
  };
  window.addEventListener(AUTH_LOGOUT_EVENT, local);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(AUTH_LOGOUT_EVENT, local);
    window.removeEventListener('storage', storage);
  };
}

export const listLoginDevices = () => apiClient.get<{ devices: LoginDevice[]; current_device_id: string | null; required: boolean }>('/api/v1/auth/devices');
export const renameLoginDevice = (id: string, name: string) => apiClient.patch(`/api/v1/auth/devices/${id}`, { name });
export const revokeLoginDevice = (id: string) => apiClient.delete(`/api/v1/auth/devices/${id}`);
