import { useCallback, useEffect, useState } from "react";
import { getSkillDetail, type InstalledSkill, type SkillDetail } from "../../api";

/** The installed record limited to bindings that apply here: global ones and
 *  this project's (same rule as the Workbench skill drawer). */
export function scopedInstallRecord(installed: InstalledSkill[], repoKey: string, repoPath: string, projectPath: string | null): InstalledSkill | null {
  const record = installed.find((item) => item.repo_key === repoKey && item.repo_path === repoPath);
  if (!record) return null;
  return {
    ...record,
    agents: record.agents.filter((binding) => binding.scope === "global" || (binding.scope === "project" && binding.project_path === projectPath)),
  };
}

/** Parse allowed-tools: comma-delimited, or space-delimited keeping
 *  parenthesised groups together ("Bash(go test *)" is one tool). */
export function parseAllowedTools(raw: string): string[] {
  if (raw.includes(",")) return raw.split(",").map((tool) => tool.trim()).filter(Boolean);
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") { depth++; current += ch; }
    else if (ch === ")") { depth = Math.max(0, depth - 1); current += ch; }
    else if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function useSkillDetail(source: string, name: string) {
  const [state, setState] = useState<{ key: string; detail: SkillDetail | null; error: string | null }>({ key: "", detail: null, error: null });
  const key = `${source}/${name}`;
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    getSkillDetail(source, name)
      .then((detail) => { if (active) setState({ key, detail, error: null }); })
      .catch((cause) => { if (active) setState({ key, detail: null, error: cause instanceof Error ? cause.message : "Could not load this skill." }); });
    return () => { active = false; };
  }, [source, name, key, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  // A stale result from the previous skill never shows under the new one.
  const current = state.key === key ? state : { detail: null, error: null };
  return { detail: current.detail, error: current.error, loading: !current.detail && !current.error, reload };
}
