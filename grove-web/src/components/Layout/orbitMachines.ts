import { Cloud, Cpu, House, Laptop, Monitor, Server, type LucideIcon } from "lucide-react";
import type { MachineIcon, MachineProfile, PairedMachine } from "../../api/machines";

export const MACHINE_ICONS: { id: MachineIcon; label: string; icon: LucideIcon }[] = [
  { id: "laptop", label: "Laptop", icon: Laptop },
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "server", label: "Server", icon: Server },
  { id: "gpu", label: "GPU", icon: Cpu },
  { id: "cloud", label: "Cloud", icon: Cloud },
  { id: "home", label: "Home", icon: House },
];

/** `Name: value` lines to a header map. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** The machine this Grove runs on, told apart from the ones paired to it. */
export function homeNote(machine: MachineProfile): string {
  return machine.description ? `This machine · ${machine.description}` : "This machine";
}

export function machineNote(machine: PairedMachine): string {
  if (machine.status === "signed_out") return "Signed out, connect again";
  if (machine.status === "needs_login") return "Sign in to reconnect";
  if (machine.status === "offline") return "Offline";
  if (!machine.url) return "Connected from there";
  return machine.description;
}

/** The address as the server will read it, for opening it in a window. */
export function machineAddress(text: string): string {
  const address = text.trim().replace(/\/+$/, "");
  return address.includes("://") ? address : `http://${address}`;
}
