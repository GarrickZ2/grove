import type { Plugin } from "../../api/plugins";

/** Human-readable reasons must match the conditions used by Needs attention. */
export function pluginAttentionReasons(plugin?: Plugin): string[] {
  if (!plugin) return [];
  // When the folder is gone, build and SDK checks only reflect that absence.
  if (plugin.exists === false) return ["Plugin folder missing"];

  const reasons: string[] = [];
  if (plugin.built === false) reasons.push("Build required");
  if (plugin.runtime?.available === false) reasons.push(`${plugin.runtime.command} unavailable`);
  if (plugin.sdk_status === "outdated") reasons.push("SDK outdated");
  if (plugin.sdk_status === "missing") reasons.push("SDK missing");
  return reasons;
}
