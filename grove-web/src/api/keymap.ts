// User keymap API client. Mirrors the Rust handlers in
// src/api/handlers/keymap.rs. The frontend `userKeymapStore` calls
// `loadKeymap()` once on startup and PUT/DELETE incrementally as the
// user edits Settings.

import { apiClient } from "./client";
import type { KeymapOverride } from "../keyboard";

export interface KeymapBundle {
  overrides: KeymapOverride[];
  disabled: string[];
}

export async function loadKeymap(): Promise<KeymapBundle> {
  return apiClient.get<KeymapBundle>("/api/v1/keymap");
}

export async function setKeymapOverride(o: KeymapOverride): Promise<void> {
  await apiClient.put<KeymapOverride, void>("/api/v1/keymap/override", o);
}

/** Replace a command's full binding set (multi-binding, VSCode/Zed style). */
export async function setKeymapOverrides(
  commandId: string,
  bindings: readonly KeymapOverride[],
): Promise<void> {
  await apiClient.put<
    {
      command_id: string;
      bindings: { key: string; when_ctx?: string | null; scope?: string | null }[];
    },
    void
  >("/api/v1/keymap/overrides", {
    command_id: commandId,
    bindings: bindings.map((b) => ({
      key: b.key,
      when_ctx: b.when_ctx ?? null,
      scope: b.scope ?? null,
    })),
  });
}

export async function removeKeymapOverride(commandId: string): Promise<void> {
  await apiClient.delete<void>(
    `/api/v1/keymap/override/${encodeURIComponent(commandId)}`,
  );
}

export async function setKeymapDisabled(commandId: string, disabled: boolean): Promise<void> {
  await apiClient.put<{ command_id: string; disabled: boolean }, void>(
    "/api/v1/keymap/disabled",
    { command_id: commandId, disabled },
  );
}

export async function resetKeymap(): Promise<void> {
  await apiClient.delete<void>("/api/v1/keymap");
}
