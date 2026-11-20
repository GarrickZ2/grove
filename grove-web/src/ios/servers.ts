/**
 * The servers the iOS app keeps, read and changed through the app's local
 * transport. Each server has its own local origin (its own sign-in and
 * storage); switching opens that origin.
 */
type IosServerMeta = { token?: string; id?: string | null; name?: string | null; home?: string };

export interface IosServer {
  id: string;
  name: string;
  server: string;
}

export interface IosServers {
  servers: IosServer[];
  current: string | null;
}

const meta = (): IosServerMeta =>
  (window as Window & { __GROVE_IOS_SERVER__?: IosServerMeta }).__GROVE_IOS_SERVER__ ?? {};

async function call<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Grove-Setup': meta().token ?? '' },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return {} as T;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { error?: string }).error || 'Something went wrong');
  return result as T;
}

export const listIosServers = () => call<IosServers>('/_grove/servers');

export const probeIosServer = (server: string) =>
  call<{ reachable: boolean }>('/_grove/probe', { server }).then((r) => r.reachable).catch(() => false);

export const renameIosServer = (id: string, name: string) => call('/_grove/rename', { id, name });

/** Removing the server this page belongs to leaves the page: back to the app's server list. */
export async function forgetIosServer(id: string) {
  await call('/_grove/forget', { id });
  if (id === meta().id) window.location.replace(`${meta().home ?? ''}/_grove/?pick=1`);
}

/** Opens a server (saving it first when new). Leaves this page when it answers. */
export async function openIosServer(server: string, name = '') {
  const result = await call<{ location: string }>('/_grove/connect', { server, name });
  window.location.replace(result.location);
}

/** The short way people type an address: 192.168.1.10 or host:port means Grove's port 3001. */
export function iosServerOrigin(value: string): string {
  let text = value.trim();
  if (!text) return '';
  const bare = !/^https?:\/\//i.test(text);
  if (bare) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (bare && !url.port) url.port = '3001';
    return url.origin;
  } catch {
    return text;
  }
}

export const iosServerHost = (server: string) => {
  try { return new URL(server).host; } catch { return server; }
};
