import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Download, CheckCircle2, Loader2, Tag, Settings2, Wrench, Scale, User, Monitor } from "lucide-react";
import { Button } from "../ui";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { InstallDialog } from "./InstallDialog";
import { getSkillDetail } from "../../api";
import type { SkillDetail, AgentDef, InstalledSkill } from "../../api";

interface SkillDetailPanelProps {
  selectedSkill: { source: string; name: string } | null;
  agents: AgentDef[];
  installed: InstalledSkill[];
  projectPath: string | null;
  onClose: () => void;
  onInstalled: () => Promise<void>;
}

export function SkillDetailPanel({ selectedSkill, agents, installed, projectPath, onClose, onInstalled }: SkillDetailPanelProps) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    if (!selectedSkill) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    getSkillDetail(selectedSkill.source, selectedSkill.name)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) console.error("Failed to load skill detail:", err); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedSkill]);

  // Escape key to close
  useEffect(() => {
    if (!selectedSkill) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showInstall) { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedSkill, showInstall, onClose]);

  const rawInstalledRecord = detail ? installed.find((i) => i.repo_key === detail.repo_key && i.repo_path === detail.repo_path) : null;
  // Filter agents to only show those relevant to current project context
  const installedRecord = rawInstalledRecord ? {
    ...rawInstalledRecord,
    agents: rawInstalledRecord.agents.filter((a) =>
      a.scope === "global" || (a.scope === "project" && a.project_path === projectPath)
    ),
  } : null;
  // Unique agent count (union of global + project)
  const uniqueInstalledCount = installedRecord
    ? new Set(installedRecord.agents.map((a) => a.agent_id)).size
    : 0;
  const hasInstall = uniqueInstalledCount > 0;

  /** Parse allowed-tools: comma-delimited or space-delimited (respecting parens) */
  const parseAllowedTools = (raw: string): string[] => {
    if (raw.includes(',')) return raw.split(',').map(t => t.trim()).filter(Boolean);
    // Space-delimited: group tokens with parentheses, e.g. "Bash(go test *)" → single item
    const tokens: string[] = [];
    let current = '';
    let depth = 0;
    for (const ch of raw) {
      if (ch === '(') { depth++; current += ch; }
      else if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; }
      else if (ch === ' ' && depth === 0) {
        if (current) tokens.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  };

  return (
    <AnimatePresence>
      {selectedSkill && (
        <>
          {/* Backdrop */}
          <motion.div
            key="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 z-40"
          />

          {/* Drawer */}
          <motion.div
            key="drawer-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed top-0 right-0 bottom-0 w-[520px] max-w-[90vw] z-50 flex flex-col bg-[var(--color-bg)] border-l border-[var(--color-border)] shadow-2xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
              <h3 className="text-base font-semibold text-[var(--color-text)] truncate">
                {detail?.name || "Loading..."}
              </h3>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            {isLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-[var(--color-highlight)]" />
              </div>
            ) : detail ? (
              <>
                <div className="flex-1 overflow-y-auto px-5 py-4">
                  {/* Description */}
                  {detail.description && (
                    <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">
                      {detail.description}
                    </p>
                  )}

                  {/* Official metadata info grid */}
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] mb-4 divide-y divide-[var(--color-border)]">
                    {/* Source */}
                    <div className="flex items-center gap-3 px-3.5 py-2.5">
                      <Tag className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                      <span className="text-xs text-[var(--color-text-muted)] w-24 flex-shrink-0">Source</span>
                      <span className="text-xs font-medium text-[var(--color-highlight)]">{detail.source}</span>
                    </div>

                    {/* Author (from metadata fields) */}
                    {detail.metadata.fields.author && (
                      <div className="flex items-center gap-3 px-3.5 py-2.5">
                        <User className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)] w-24 flex-shrink-0">Author</span>
                        <span className="text-xs text-[var(--color-text)]">{detail.metadata.fields.author}</span>
                      </div>
                    )}

                    {/* License */}
                    {detail.metadata.license && (
                      <div className="flex items-center gap-3 px-3.5 py-2.5">
                        <Scale className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)] w-24 flex-shrink-0">License</span>
                        <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-md bg-[var(--color-info)]/10 text-[var(--color-info)]">
                          {detail.metadata.license}
                        </span>
                      </div>
                    )}

                    {/* Compatibility */}
                    {detail.metadata.compatibility && (
                      <div className="flex items-center gap-3 px-3.5 py-2.5">
                        <Monitor className="w-3.5 h-3.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)] w-24 flex-shrink-0">Compatibility</span>
                        <div className="flex flex-wrap gap-1">
                          {detail.metadata.compatibility.split(',').map(c => c.trim()).filter(Boolean).map((compat) => (
                            <span key={compat} className="inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                              {compat}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Allowed tools */}
                    {detail.metadata.allowed_tools && (
                      <div className="flex items-start gap-3 px-3.5 py-2.5">
                        <Wrench className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)] w-24 flex-shrink-0">Tools</span>
                        <div className="flex flex-wrap gap-1">
                          {parseAllowedTools(detail.metadata.allowed_tools).map((tool) => (
                            <span key={tool} className="inline-flex px-1.5 py-0.5 text-[10px] font-mono rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text-secondary)]">
                              {tool}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Non-standard metadata fields (version, category, tags, etc.) — exclude author since it's shown above */}
                  {Object.keys(detail.metadata.fields).filter(k => k !== 'author').length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {Object.entries(detail.metadata.fields)
                        .filter(([key]) => key !== 'author')
                        .map(([key, value]) => (
                        <span
                          key={key}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
                        >
                          <span className="text-[var(--color-text-muted)]">{key}:</span> {value}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* SKILL.md body content (frontmatter stripped) */}
                  {detail.skill_md_content && (
                    <>
                      <div className="border-t border-[var(--color-border)] my-4" />
                      <MarkdownRenderer content={detail.skill_md_content} />
                    </>
                  )}
                </div>

                {/* Bottom Action */}
                <div className="px-5 py-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                  {hasInstall ? (
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="w-4 h-4 text-[var(--color-success)] flex-shrink-0" />
                      <span className="text-sm text-[var(--color-success)] font-medium">
                        Installed on {uniqueInstalledCount} agent{uniqueInstalledCount !== 1 ? "s" : ""}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setShowInstall(true)}
                      >
                        <Settings2 className="w-3.5 h-3.5 mr-1.5" />
                        Manage
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      className="w-full"
                      onClick={() => setShowInstall(true)}
                    >
                      <Download className="w-4 h-4 mr-1.5" />
                      Install
                    </Button>
                  )}
                </div>
              </>
            ) : null}

            {/* Install Dialog */}
            {detail && (
              <InstallDialog
                isOpen={showInstall}
                skillName={detail.name}
                sourceName={detail.source}
                repoKey={detail.repo_key}
                repoPath={detail.repo_path}
                relativePath={detail.relative_path}
                agents={agents}
                installedRecord={installedRecord || null}
                projectPath={projectPath}
                onClose={() => setShowInstall(false)}
                onInstalled={async () => {
                  setShowInstall(false);
                  await onInstalled();
                  // Reload detail
                  if (selectedSkill) {
                    const updated = await getSkillDetail(selectedSkill.source, selectedSkill.name);
                    setDetail(updated);
                  }
                }}
              />
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
