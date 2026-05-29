import {
  loadKeymap,
  removeKeymapOverride,
  resetKeymap,
  setKeymapDisabled,
  setKeymapOverrides,
} from "../api/keymap";
import { userKeymapStore } from "./userKeymapStore";
import type { KeymapOverride } from "./types";

/**
 * Pull user keymap from server and populate local store. Called once
 * at app startup from main.tsx. Errors are logged but do not throw —
 * a freshly installed grove without a keymap row should boot normally.
 */
/**
 * Map of ContextKey names that were renamed in the catalog. User overrides
 * that froze the old name in their `when_ctx` field need to be migrated
 * so the binding keeps working after the catalog rename. Add entries
 * here whenever a context key is renamed.
 */
const CONTEXT_KEY_RENAMES: Record<string, string> = {
  selectedTask: "taskSelected",
};

function migrateOverride(o: KeymapOverride): KeymapOverride {
  if (!o.when_ctx) return o;
  let next = o.when_ctx;
  for (const [oldName, newName] of Object.entries(CONTEXT_KEY_RENAMES)) {
    // Word-boundary replace so we don't accidentally rewrite a substring
    // (e.g. someone uses "myselectedTask" as a custom key).
    next = next.replace(new RegExp(`\\b${oldName}\\b`, "g"), newName);
  }
  return next === o.when_ctx ? o : { ...o, when_ctx: next };
}

export async function initUserKeymap(): Promise<void> {
  try {
    const bundle = await loadKeymap();
    // Migrate any overrides that froze an old context-key name in
    // their when_ctx field. Persist the migrated rows back so the
    // server matches the in-memory state.
    const migrated: KeymapOverride[] = [];
    const toPersist: KeymapOverride[] = [];
    for (const o of bundle.overrides) {
      const next = migrateOverride(o);
      migrated.push(next);
      if (next !== o) toPersist.push(next);
    }
    userKeymapStore.load(migrated, bundle.disabled);
    if (toPersist.length > 0) {
      console.log(`[userKeymapSync] migrating ${toPersist.length} override(s) with renamed context keys`);
      // Group the full migrated set by command, then persist each command that
      // had any changed row using its COMPLETE binding set — the batch endpoint
      // replaces all rows for a command, so persisting one row at a time would
      // drop a multi-binding command's other bindings.
      const byCommand = new Map<string, KeymapOverride[]>();
      for (const o of migrated) {
        const arr = byCommand.get(o.command_id);
        if (arr) arr.push(o);
        else byCommand.set(o.command_id, [o]);
      }
      const changedCommands = new Set(toPersist.map((o) => o.command_id));
      for (const commandId of changedCommands) {
        // Fire-and-forget; if any single one fails we just skip it,
        // the local state has already been migrated.
        await setKeymapOverrides(commandId, byCommand.get(commandId) ?? []).catch((e) =>
          console.error(`[userKeymapSync] migration persist failed for ${commandId}:`, e),
        );
      }
    }
  } catch (err) {
    console.error("[userKeymapSync] failed to load keymap:", err);
  }
}

/**
 * Persist an override to the server, then update the local store. The
 * order matters: if the server PUT fails we don't touch the in-memory
 * state, so the user sees an accurate error and the UI stays in sync.
 */
export async function persistOverrides(
  commandId: string,
  bindings: KeymapOverride[],
): Promise<void> {
  await setKeymapOverrides(commandId, bindings);
  userKeymapStore.setOverrides(commandId, bindings);
}

/** Single-binding convenience wrapper (one key replaces the whole set). */
export async function persistOverride(override: KeymapOverride): Promise<void> {
  await persistOverrides(override.command_id, [override]);
}

export async function persistRemoveOverride(commandId: string): Promise<void> {
  await removeKeymapOverride(commandId);
  userKeymapStore.removeOverride(commandId);
}

export async function persistDisabled(commandId: string, disabled: boolean): Promise<void> {
  await setKeymapDisabled(commandId, disabled);
  userKeymapStore.setDisabled(commandId, disabled);
}

export async function persistResetAll(): Promise<void> {
  await resetKeymap();
  userKeymapStore.reset();
}
