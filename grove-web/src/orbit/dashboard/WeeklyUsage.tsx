import type { CSSProperties } from "react";
import type { StatisticsResponse } from "../../api/statistics";
import { summarizeWeeklyTokens } from "../../components/Dashboard/weeklyTokens";
import { computeDelta, formatTokens } from "../../components/Stats/formatters";
import { agentColor } from "../../components/Stats/agentColors";
import { resolveAgentIcon } from "../../utils/agentIcon";
import "./orbit-dashboard.css";

/**
 * Last-7-days token usage: total with trend, a per-agent stacked bar chart,
 * and the per-agent breakdown. The body of the Dashboard's Usage card, also
 * used by the Projects page detail.
 */
export function WeeklyUsage({ stats }: { stats: StatisticsResponse | null }) {
  const weekly = summarizeWeeklyTokens(stats);
  const trend = computeDelta(stats?.current.kpi.tokens_total, stats?.previous.kpi.tokens_total);
  const hasUsage = weekly.series.some((day) => day.total > 0);
  return (
    <>
      <div className="odb-use-num">
        <b>{formatTokens(weekly.total)}</b>
        <span>
          tokens · {formatTokens(Math.round(weekly.total / 7))} / day
          {trend.pct != null && trend.pct !== 0 ? (
            <em className={trend.direction > 0 ? "is-up" : "is-down"} title="Versus the previous 7 days">
              {trend.pct === Infinity ? "new" : `${trend.pct > 0 ? "+" : ""}${Math.round(trend.pct)}%`}
            </em>
          ) : null}
        </span>
      </div>
      <div className={`odb-chart${hasUsage ? "" : " is-empty"}`} role="img" aria-label={hasUsage ? `Daily tokens; busiest day ${weekly.dayLabels[weekly.peakIdx]}` : "No usage this week"}>
        {weekly.series.map((day, index) => (
          <div
            key={index}
            className={`odb-bar${index === 6 ? " is-today" : ""}`}
            title={`${weekly.dayLabels[index]} · ${day.total ? `${formatTokens(day.total)} tokens` : "no activity"}`}
          >
            <div className="odb-bar-track">
              <div
                className={`odb-bar-fill${day.total ? "" : " is-zero"}`}
                style={{ height: day.total ? `${Math.max(4, (day.total / weekly.peak) * 100)}%` : undefined, animationDelay: `${250 + index * 50}ms` }}
              >
                {day.segments.map((segment) => (
                  <span key={segment.agent} style={{ flexGrow: segment.tokens, background: agentColor(segment.agent) }} />
                ))}
              </div>
            </div>
            <small>{weekly.dayLabels[index]}</small>
          </div>
        ))}
      </div>
      {hasUsage ? (
        <div className="odb-use-break oui-scroll">
          <div className="odb-use-peak">
            Busiest day <b>{weekly.dayLabels[weekly.peakIdx]}</b> · {formatTokens(weekly.maxValue)} tokens
          </div>
          {weekly.agents.map((row, index) => {
            const info = resolveAgentIcon(row.agent);
            const AgentIcon = info.Component;
            const share = row.tokens / weekly.total;
            return (
              <div key={row.agent} className="odb-agent-row" style={{ "--odb-agent": agentColor(row.agent), animationDelay: `${300 + index * 50}ms` } as CSSProperties}>
                <span className="odb-agent-ic"><AgentIcon size={13} /></span>
                <span className="odb-agent-name oui-truncate" title={row.agent}>{info.label}</span>
                <span className="odb-agent-share" aria-hidden="true"><i style={{ width: `${Math.max(2, share * 100)}%` }} /></span>
                <span className="odb-agent-tok">{formatTokens(row.tokens)}</span>
                <span className="odb-agent-pct">{Math.round(share * 100)}%</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
