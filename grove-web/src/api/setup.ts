// First-run setup: the tools Grove needs from the computer it runs on.

import { apiClient } from "./client";

export type SetupToolId = "node" | "git";

export interface SetupTool {
  id: SetupToolId;
  installed: boolean;
  /** The install command, as the person would type it. */
  command: string | null;
  /** Grove can run `command` itself (it needs no password). */
  run: boolean;
  /** Where to download the tool when there is no command. */
  url: string | null;
  installing: boolean;
  /** The installer's latest line of output. */
  line: string;
  error: string | null;
  /** The system's own installer was opened and has to be finished there. */
  handed_over: boolean;
}

export async function getSetupTools(): Promise<SetupTool[]> {
  return (await apiClient.get<{ tools: SetupTool[] }>("/api/v1/setup/tools")).tools;
}

/** Starts the install on the machine; `getSetupTools` reports how it goes. */
export function installSetupTool(id: SetupToolId): Promise<void> {
  return apiClient.postNoContent(`/api/v1/setup/tools/${id}/install`);
}
