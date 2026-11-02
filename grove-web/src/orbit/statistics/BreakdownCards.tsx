import type { CSSProperties, KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { AgentShareItem, ModelItem, TopItem } from "../../api/statistics";
import type { AverageRates } from "../../components/Stats/components/pricing";
import { formatCost, formatNumber, formatTokens } from "../../components/Stats/formatters";
import { valueModels, valueTop, type MetricType, type Unit, type ValuedRow } from "../../components/Stats/statsModel";
import { resolveAgentIcon } from "../../utils/agentIcon";
import { Card } from "../ui";
import { METRIC_LABEL, chartAgentColor, topRowTarget, type TopTarget } from "./statisticsView";

const turnsText = (n: number) => `${formatNumber(n)} ${n === 1 ? "turn" : "turns"}`;
const fmtFor = (unit: Unit) => (unit === "cost" ? formatCost : formatTokens);

function splitTitle(row: ValuedRow, unit: Unit) {
  const fmt = fmtFor(unit);
  return `${fmt(row.v_in)} input · ${fmt(row.v_cached)} cached · ${fmt(row.v_out)} output`;
}

interface AgentsCardProps {
  agents: AgentShareItem[];
  models: ModelItem[];
  metric: MetricType;
  unit: Unit;
  averageRates: AverageRates;
  dark: boolean;
}

/** Agent share of the period, then each model the agents ran. */
export function AgentsCard({ agents, models, metric, unit, averageRates, dark }: AgentsCardProps) {
  const fmt = fmtFor(unit);
  // Same weighting as Workbench: reported cost, else tokens at the average rate.
  const valueFor = (item: AgentShareItem) => (unit === "cost" ? (item.cost > 0 ? item.cost : item.tokens * averageRates.total) : item.tokens);
  const rows = agents.map((item) => ({ item, value: valueFor(item) })).filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const modelRows = valueModels(models, metric, unit).filter((row) => row.displayValue > 0 || row.turns > 0);
  const modelMax = Math.max(0, ...modelRows.map((row) => row.displayValue));

  return (
    <Card className="oui-rise" style={{ animationDelay: "160ms" }} aria-label="By agent" title="By agent" hint={`share of ${unit === "cost" ? "cost" : "tokens"}`}>
      {total > 0 ? (
        <div className="ostat-stack" aria-hidden="true">
          {rows.map(({ item, value }, index) => (
            <i key={item.agent} style={{ flexGrow: (value / total) * 100, background: chartAgentColor(item.agent, dark), animationDelay: `${200 + index * 60}ms` }} />
          ))}
        </div>
      ) : null}
      <div className="ostat-list oui-scroll">
        {total > 0 ? rows.map(({ item, value }, index) => {
          const info = resolveAgentIcon(item.agent);
          const AgentIcon = info.Component;
          const pct = (value / total) * 100;
          return (
            <div
              key={item.agent}
              className="ostat-agent"
              title={info.label}
              style={{ "--ostat-agent": chartAgentColor(item.agent, dark), animationDelay: `${220 + index * 50}ms` } as CSSProperties}
            >
              <span className="ostat-agent-ic"><AgentIcon size={13} /></span>
              <span className="oui-truncate">{info.label}</span>
              <span className="ostat-num">{fmt(value)}</span>
              <span className="ostat-turns">{turnsText(item.turns)}</span>
              <span className="ostat-pct">{pct < 1 ? "<1" : Math.round(pct)}%</span>
            </div>
          );
        }) : <p className="ostat-empty">No agent turns in this range</p>}

        <div className="ostat-subhead">Models<small>{METRIC_LABEL[metric].toLowerCase()} {unit === "cost" ? "cost" : "tokens"}</small></div>
        {modelRows.length ? modelRows.map((row, index) => (
          <div key={`${row.model}-${row.agent}`} className="ostat-model" title={splitTitle(row, unit)} style={{ animationDelay: `${280 + index * 40}ms` }}>
            <div className="ostat-model-top">
              <span className="ostat-model-name oui-truncate">{row.model || "(unknown model)"}</span>
              <span className="ostat-model-agent oui-truncate">{resolveAgentIcon(row.agent).label}</span>
              <span className="ostat-num">{fmt(row.displayValue)}</span>
              <span className="ostat-turns">{turnsText(row.turns)}</span>
            </div>
            <span className="ostat-track" aria-hidden="true">
              <i style={{ width: `${modelMax > 0 ? Math.max(1.5, (row.displayValue / modelMax) * 100) : 0}%`, background: chartAgentColor(row.agent, dark) }} />
            </span>
          </div>
        )) : <p className="ostat-empty">No models reported</p>}
      </div>
    </Card>
  );
}

interface TopCardProps {
  scope: "global" | "project";
  items: TopItem[];
  metric: MetricType;
  unit: Unit;
  averageRates: AverageRates;
  dark: boolean;
  /** The project whose tasks the rows name (project scope). */
  project?: Parameters<typeof topRowTarget>[2];
  onOpenTask?: (projectId: string, taskId: string) => void;
}

/** The ten heaviest tasks (project scope) or projects (all projects). */
export function TopCard({ scope, items, metric, unit, averageRates, dark, project, onOpenTask }: TopCardProps) {
  const fmt = fmtFor(unit);
  const rows = valueTop(items, metric, unit, averageRates);
  const max = Math.max(0, ...rows.map((row) => row.displayValue));
  const noun = scope === "global" ? "project" : "task";

  return (
    <Card
      className="oui-rise"
      style={{ animationDelay: "240ms" }}
      aria-label={`By ${noun}`}
      title={`By ${noun}`}
      hint={`top spenders · ${METRIC_LABEL[metric].toLowerCase()} ${unit === "cost" ? "cost" : "tokens"}`}
    >
      <ol className="ostat-list oui-scroll ostat-top">
        {rows.length ? rows.map((row, index) => {
          const dominant = row.agent_split.reduce<{ agent: string; tokens: number } | null>((best, a) => (!best || a.tokens > best.tokens ? a : best), null);
          const target: TopTarget = onOpenTask ? topRowTarget(scope, row.id, project) : { kind: "none" };
          const open = target.kind === "task" ? () => onOpenTask?.(target.projectId, target.taskId) : undefined;
          const onKey = (event: KeyboardEvent<HTMLLIElement>) => {
            if (open && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              open();
            }
          };
          const detail = `${splitTitle(row, unit)}${dominant ? ` · mostly ${resolveAgentIcon(dominant.agent).label}` : ""}`;
          return (
            <li
              key={row.id}
              className={`ostat-top-row${open ? " is-link" : ""}`}
              title={target.kind === "none" && target.reason ? `${target.reason} · ${detail}` : detail}
              style={{ animationDelay: `${260 + index * 40}ms` }}
              {...(open ? { role: "button", tabIndex: 0, onClick: open, onKeyDown: onKey, "aria-label": `Open ${row.name}` } : {})}
            >
              <span className="ostat-rank">{index + 1}</span>
              <span className="ostat-top-main">
                <span className="oui-truncate">{row.name}</span>
                <span className="ostat-track" aria-hidden="true">
                  <i style={{ width: `${max > 0 ? Math.max(1.5, (row.displayValue / max) * 100) : 0}%`, background: dominant ? chartAgentColor(dominant.agent, dark) : "var(--o-muted)" }} />
                </span>
              </span>
              <span className="ostat-num">{fmt(row.displayValue)}</span>
              <span className="ostat-turns">{turnsText(row.turns)}</span>
              <span className="ostat-top-go" aria-hidden="true">{open ? <ChevronRight /> : null}</span>
            </li>
          );
        }) : <li className="ostat-empty">No {noun}s with agent turns in this range</li>}
      </ol>
    </Card>
  );
}
