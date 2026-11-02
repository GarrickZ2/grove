import { useState } from "react";
import { Blocks, Brain, ChevronRight, FileText, Plug } from "lucide-react";
import { Card, EmptyState } from "../ui";
import { tokenLabel, type AgentContextView, type ContextSource, type ContextSourceId } from "./useAgentContext";

const SOURCE_ICON: Record<ContextSourceId, typeof Brain> = { instructions: FileText, memory: Brain, mcp: Plug, skills: Blocks };

interface AgentContextCardProps {
  context: AgentContextView;
  onNavigate: (page: string) => void;
}

/** What every new task's agent session starts with, per source, with the estimated budget. */
export function AgentContextCard({ context, onNavigate }: AgentContextCardProps) {
  const [hot, setHot] = useState<ContextSourceId | null>(null);
  const budget = context.total !== null ? context.sources.filter((source) => (source.tokens ?? 0) > 0) : [];
  return (
    <Card className="odb-ctx oui-rise" style={{ animationDelay: "160ms" }} aria-label="Agent context" title="Agent context" hint="what every task starts with">
      {context.total !== null ? (
        <>
          <div className="odb-ctx-sum">
            <b>{tokenLabel(context.total, context.partial)}</b>
            <span>tokens loaded at session start</span>
          </div>
          {budget.length ? (
            <div className={`odb-budget${hot ? " is-hovering" : ""}`} aria-hidden="true">
              {budget.map((source, index) => (
                <span
                  key={source.id}
                  className={`odb-seg is-${source.id}${hot === source.id ? " is-hot" : ""}`}
                  style={{ flexGrow: source.tokens ?? 0, animationDelay: `${300 + index * 70}ms` }}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="oui-card-list oui-scroll" onMouseLeave={() => setHot(null)}>
        {!context.loaded ? (
          <div className="odb-ctx-loading" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
        ) : context.sources.length === 0 ? (
          <EmptyState>Context sources couldn’t be loaded.</EmptyState>
        ) : context.sources.map((source, index) => (
          <SourceRow
            key={source.id}
            source={source}
            index={index}
            hot={hot === source.id}
            onHover={() => setHot(source.id)}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </Card>
  );
}

function SourceRow({ source, index, hot, onHover, onNavigate }: {
  source: ContextSource;
  index: number;
  hot: boolean;
  onHover: () => void;
  onNavigate: (page: string) => void;
}) {
  const Icon = SOURCE_ICON[source.id];
  const label = source.tokens !== null ? tokenLabel(source.tokens, source.partial) : source.label;
  const content = (
    <>
      <span className="odb-src-ic"><Icon aria-hidden="true" /></span>
      <span className="odb-src-copy">
        <b>{source.name}{source.on ? null : <span className="odb-off">Off</span>}</b>
        <span title={source.detail}>{source.detail}</span>
      </span>
      {label ? <span className={`odb-tok${source.on ? "" : " is-dim"}`} title={source.tokens !== null ? "Estimated tokens" : undefined}>{label}</span> : null}
      {source.page ? <ChevronRight className="odb-chev" aria-hidden="true" /> : <span className="odb-chev-gap" aria-hidden="true" />}
    </>
  );
  const props = {
    className: `odb-src-row is-${source.id}${source.on ? "" : " is-off"}${hot ? " is-hot" : ""}`,
    style: { animationDelay: `${220 + index * 60}ms` },
    onMouseEnter: onHover,
    onFocus: onHover,
  };
  const page = source.page;
  return page ? (
    <button type="button" {...props} onClick={() => onNavigate(page)}>{content}</button>
  ) : (
    <div {...props} tabIndex={-1}>{content}</div>
  );
}
