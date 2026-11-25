/**
 * The servers the iOS app keeps, read and changed through the app's local
 * transport. Each server has its own local origin (its own sign-in and
 * storage); switching opens that origin.
 */
type IosServerMeta = { token?: string; id?: string | null; name?: string | null; server?: string | null; home?: string };

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
  if (!response.ok) {
    const { error, sign_in, server } = result as { error?: string; sign_in?: boolean; server?: string };
    if (sign_in && server) throw new IosSignInNeeded(server);
    throw new Error(error || 'Something went wrong');
  }
  return result as T;
}

/** Something in front of the server wants a person to sign in. */
export class IosSignInNeeded extends Error {
  readonly server: string;
  constructor(server: string) {
    super('This server is behind a sign-in page');
    this.server = server;
  }
}

const SIGN_IN_POLL_MS = 600;

/**
 * Shows the server's sign-in page and waits until it is through. The app may be
 * left for a code meanwhile, and calls fail while it is in the background: the
 * answer is asked for until there is one.
 */
export async function signInToIosServer(server: string): Promise<void> {
  // The focused field would bring its keyboard back over the sign-in page.
  (document.activeElement as HTMLElement | null)?.blur?.();
  const { id } = await call<{ id: number }>('/_grove/sign-in', { server });
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_MS));
    const now = await call<{ id: number; state: string; error?: string | null }>('/_grove/sign-in/state').catch(() => null);
    if (!now || (now.id === id && now.state === 'open')) continue;
    if (now.id === id && now.state === 'done') return;
    throw new Error(now.id === id && now.error ? now.error : 'Sign-in was closed');
  }
}

/** The server this page belongs to. */
export const thisIosServer = () => ({ name: meta().name ?? 'this server', server: meta().server ?? '' });

export const listIosServers = () => call<IosServers>('/_grove/servers');

export type IosReach = 'grove' | 'sign_in' | 'none';

export const probeIosServer = (server: string): Promise<IosReach> =>
  call<{ reachable: boolean; sign_in?: boolean }>('/_grove/probe', { server })
    .then((r): IosReach => (r.reachable ? 'grove' : r.sign_in ? 'sign_in' : 'none'))
    .catch((): IosReach => 'none');

export const renameIosServer = (id: string, name: string) => call('/_grove/rename', { id, name });

/** Removing the server this page belongs to leaves the page: back to the app's server list. */
export async function forgetIosServer(id: string) {
  await call('/_grove/forget', { id });
  if (id === meta().id) window.location.replace(`${meta().home ?? ''}/_grove/?pick=1`);
}

/** Opens a server (saving it first when new), through its sign-in page when it has one. Leaves this page when it answers. */
export async function openIosServer(server: string, name = '') {
  const connect = (to: string) => call<{ location: string }>('/_grove/connect', { server: to, name });
  const result = await connect(server).catch(async (error: unknown) => {
    if (!(error instanceof IosSignInNeeded)) throw error;
    await signInToIosServer(error.server);
    return connect(error.server);
  });
  window.location.replace(result.location);
}

/** An address inside a home or office network, where Grove is plain http on its own port. */
const isLocalHost = (host: string) =>
  !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[') || /\.(local|lan|home|internal|arpa|ts\.net)$/i.test(host);

/**
 * The short way people type an address: 192.168.1.10 means Grove's port 3001,
 * a public name means https.
 */
export function iosServerOrigin(value: string): string {
  let text = value.trim();
  if (!text) return '';
  const bare = !/^https?:\/\//i.test(text);
  if (bare) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (bare && !url.port) {
      if (isLocalHost(url.hostname)) url.port = '3001';
      else url.protocol = 'https:';
    }
    return url.origin;
  } catch {
    return text;
  }
}

export const iosServerHost = (server: string) => {
  try { return new URL(server).host; } catch { return server; }
};
