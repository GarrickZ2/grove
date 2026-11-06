import { apiClient, getHomeApiBase } from "./client";

export type MachineIcon = "laptop" | "desktop" | "server" | "gpu" | "cloud" | "home";
export type MachineStatus = "online" | "offline" | "signed_out" | "needs_login";

export interface MachineProfile {
  id: string;
  name: string;
  description: string;
  icon: MachineIcon;
}

export interface PairedMachine extends MachineProfile {
  /** Null when that machine connected here: only it holds the address. */
  url: string | null;
  status: MachineStatus;
  version: string | null;
}

export interface MachinesOverview {
  /** The machine this window is showing. */
  current: string;
  /** This machine's own address; null when it isn't being used locally. */
  this: MachineProfile;
  machines: PairedMachine[];
}

export type MachineChanges = Partial<Pick<MachineProfile, "name" | "description" | "icon">>;

export function getMachines(signal?: AbortSignal): Promise<MachinesOverview> {
  return apiClient.get<MachinesOverview>("/api/v1/machines", signal);
}

export function pairMachine(url: string, passkey: string, headers: Record<string, string>): Promise<MachineProfile> {
  return apiClient.post<{ url: string; passkey: string; headers: Record<string, string> }, MachineProfile>(
    "/api/v1/machines",
    { url, passkey, headers },
  );
}

/** Pairing failed because something in front of the machine wants a sign-in. */
export function needsMachineLogin(error: unknown): boolean {
  return (error as { data?: { error?: string } })?.data?.error === "machine_login_required";
}

export function refreshMachineSession(id: string, cookie: string): Promise<void> {
  return apiClient.post<{ cookie: string }, void>(`/api/v1/machines/${encodeURIComponent(id)}/session`, { cookie });
}

export function updateMachine(id: string, changes: MachineChanges): Promise<void> {
  return apiClient.patch<MachineChanges, void>(`/api/v1/machines/${encodeURIComponent(id)}`, changes);
}

export function removeMachine(id: string): Promise<void> {
  return apiClient.delete(`/api/v1/machines/${encodeURIComponent(id)}`);
}

export async function openMachine(id: string): Promise<string> {
  const { url } = await apiClient.post<undefined, { url: string }>(`/api/v1/machines/${encodeURIComponent(id)}/open`);
  // A server without a local port answers with a path of its own.
  return url.startsWith("/") ? new URL(url, getHomeApiBase() || window.location.origin).href : url;
}
