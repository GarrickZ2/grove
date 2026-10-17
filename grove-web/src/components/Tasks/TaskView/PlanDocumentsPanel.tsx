import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { readFile } from "../../../api";
import { MarkdownRenderer, type MarkdownRendererProps } from "../../ui/MarkdownRenderer";
import { planDocumentTitle, planFilePath, type PlanDocument } from "./executionPlans";

export type PlanMarkdownOptions = Pick<MarkdownRendererProps, "onImageClick" | "onMermaidClick" | "onD2Click" | "sketchContext">;

function PlanContent({ plan, allowLocalFiles, onFileClick, markdownProps, fileContext }: {
  plan: PlanDocument;
  allowLocalFiles: boolean;
  markdownProps?: PlanMarkdownOptions;
  fileContext?: { projectId: string; taskId: string };
  onFileClick?: (path: string, line?: number) => Promise<boolean>;
}) {
  const uri = plan.type === "file" ? plan.uri : null;
  const [file, setFile] = useState<{ uri: string; content?: string; error?: string } | null>(null);
  useEffect(() => {
    const path = uri && allowLocalFiles ? planFilePath(uri) : null;
    if (!path || !uri) return;
    let cancelled = false;
    readFile(path).then((result) => {
      if (!cancelled) setFile({ uri, content: result.content });
    }).catch(() => {
      if (!cancelled) setFile({ uri, error: "The plan file could not be read." });
    });
    return () => { cancelled = true; };
  }, [uri, allowLocalFiles, plan]);

  if (plan.type === "items") return <ul className="space-y-1.5">{plan.entries.map((entry, index) => <li key={index} className="flex items-start gap-2 text-sm">
    {entry.status === "completed" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" /> : entry.status === "in_progress" ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-highlight)] motion-reduce:animate-none" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />}
    <span className={entry.status === "completed" ? "text-[var(--color-text-muted)] line-through" : ""}>{entry.content}</span>
  </li>)}</ul>;
  if (plan.type === "markdown") return <MarkdownRenderer content={plan.content} onFileClick={onFileClick} {...markdownProps} />;
  const path = planFilePath(plan.uri);
  const current = file?.uri === plan.uri ? file : null;
  return <div className="space-y-2">
    <p className="break-all font-mono text-[11px] text-[var(--color-text-muted)]">{plan.uri}</p>
    {!allowLocalFiles || !path ? <p className="text-xs text-[var(--color-text-muted)]">This plan references a file that is not available through this connection.</p>
      : current?.error ? <p className="text-xs text-[var(--color-text-muted)]">{current.error}</p>
      : current?.content !== undefined ? <MarkdownRenderer content={current.content} onFileClick={onFileClick} {...markdownProps} location={fileContext && path ? { projectId: fileContext.projectId, root: { kind: "task", taskId: fileContext.taskId }, path } : undefined} />
      : <p className="text-xs text-[var(--color-text-muted)]">Loading plan…</p>}
  </div>;
}

export function PlanDocumentsPanel({ plans, allowLocalFiles = false, onFileClick, markdownProps, fileContext }: {
  plans: PlanDocument[];
  allowLocalFiles?: boolean;
  markdownProps?: PlanMarkdownOptions;
  fileContext?: { projectId: string; taskId: string };
  onFileClick?: (path: string, line?: number) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(() => plans.at(-1)?.plan_id ?? null);
  const current = plans.find((plan) => plan.plan_id === selected) ?? plans.at(-1);
  if (!current) return null;
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-1.5">
      <BookOpen className="mr-1 h-3.5 w-3.5 text-[var(--color-text-muted)]" />
      {plans.map((plan, index) => <button key={plan.plan_id} type="button" aria-pressed={plan.plan_id === current.plan_id} title={planDocumentTitle(plan, index)} onClick={() => setSelected(plan.plan_id)} className={`max-w-64 truncate rounded-full border px-2.5 py-1 text-[11px] ${plan.plan_id === current.plan_id ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_12%,transparent)] text-[var(--color-text)]" : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>{planDocumentTitle(plan, index)}</button>)}
    </div>
    <PlanContent key={current.plan_id} plan={current} allowLocalFiles={allowLocalFiles} onFileClick={onFileClick} markdownProps={markdownProps} fileContext={fileContext} />
  </div>;
}
