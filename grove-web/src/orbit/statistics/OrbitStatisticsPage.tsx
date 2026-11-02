import { BarChart3, RefreshCw } from "lucide-react";
import { useProject, useTheme } from "../../context";
import { RANGE_OPTIONS, RANGE_SECS, type RangeId } from "../../components/Stats/statsModel";
import { useStatisticsState } from "../../components/Stats/useStatisticsState";
import { resolveAgentIcon, usePersonaRegistry } from "../../utils/agentIcon";
import { Button, OrbitPage, OrbitPageHeader, Segmented, type PageHue } from "../ui";
import { AgentsCard, TopCard } from "./BreakdownCards";
import { HeatmapCard } from "./HeatmapCard";
import { KpiTiles } from "./KpiTiles";
import { MeasureMenu } from "./MeasureMenu";
import { UsageCard } from "./UsageCard";
import { buildChart, buildSlots } from "./statisticsView";
import "./orbit-statistics.css";

const HUE: PageHue = {
  from: "#fcd34d",
  to: "#b45309",
  strong: "rgba(180,83,9,.7)",
  glow: "color-mix(in oklab, #f59e0b 12%, transparent)",
};

/** Orbit Statistics: where agent time and tokens go, in one viewport. */
export function OrbitStatisticsPage() {
  const { selectedProject } = useProject();
  const { theme } = useTheme();
  usePersonaRegistry();
  const dark = !theme.isLight;
  const projectId = selectedProject?.id;
  const stats = useStatisticsState(projectId);
  const { scope, effectiveScope, range, bucket, metricType, unit, data, dataWindow, loading, error, averageRates } = stats;

  // The window the shown numbers belong to; lags the controls mid-fetch.
  const shownRange: RangeId = (dataWindow && RANGE_OPTIONS.find((option) => RANGE_SECS[option.id] === dataWindow.to - dataWindow.from)?.id) || range;
  const dataBucket = dataWindow?.bucket ?? bucket;

  // No columns until the first response says which window they cover.
  const slots = dataWindow ? buildSlots(dataWindow.from, dataWindow.to, dataWindow.bucket, data?.current.timeseries ?? []) : [];
  const chart = buildChart(slots, metricType, unit, averageRates, dark, (agent) => resolveAgentIcon(agent).label);

  const needsProject = scope === "project" && !projectId;
  const where = effectiveScope === "project" && selectedProject ? <> in <b title={selectedProject.name}>{selectedProject.name}</b></> : " across every project";

  return (
    <OrbitPage className={`ostat${dark ? " is-dark" : ""}`} hue={HUE}>
      <OrbitPageHeader
        raised
        icon={BarChart3}
        title="Statistics"
        subtitle={<>Agent time and tokens{where}</>}
        actions={(
          <>
            <Segmented
              ariaLabel="Scope"
              value={scope}
              onChange={stats.setScope}
              options={[
                { value: "project", label: "This project", disabled: !projectId, title: projectId ? undefined : "Select a project in the sidebar" },
                { value: "global", label: "All projects" },
              ]}
            />
            <Segmented
              ariaLabel="Range"
              value={range}
              onChange={stats.setRange}
              options={RANGE_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
            />
            <MeasureMenu metric={metricType} unit={unit} onMetric={stats.setMetricType} onUnit={stats.setUnit} />
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh"
              title="Refresh"
              disabled={loading}
              onClick={() => void stats.refresh()}
            >
              <RefreshCw className={loading ? "oui-spin" : undefined} />
            </Button>
          </>
        )}
      />

      {error ? (
        <div className="ostat-error" role="alert">
          <span>Couldn’t load statistics: {error}</span>
          <Button variant="secondary" size="sm" onClick={() => void stats.refresh()}>Retry</Button>
        </div>
      ) : null}

      {needsProject ? (
        <p className="oui-page-message">Select a project in the sidebar to see its statistics.</p>
      ) : (
        <>
          <KpiTiles
            current={data?.current.kpi}
            previous={data?.previous.kpi}
            range={shownRange}
            metric={metricType}
            unit={unit}
            averageRates={averageRates}
            dark={dark}
          />
          {/* Refetches keep the last frame, dimmed, instead of flashing empty. */}
          <div className={`ostat-grid${loading && data ? " is-loading" : ""}`} aria-busy={loading}>
            <UsageCard
              model={chart}
              dataBucket={dataBucket}
              bucket={bucket}
              allowedBuckets={stats.allowedBuckets}
              onBucket={stats.setBucket}
              metric={metricType}
              unit={unit}
            />
            <AgentsCard
              agents={data?.current.agent_share ?? []}
              models={data?.current.models ?? []}
              metric={metricType}
              unit={unit}
              averageRates={averageRates}
              dark={dark}
            />
            <HeatmapCard cells={data?.current.heatmap ?? []} />
            <TopCard
              scope={effectiveScope}
              items={data?.current.top ?? []}
              metric={metricType}
              unit={unit}
              averageRates={averageRates}
              dark={dark}
            />
          </div>
        </>
      )}
    </OrbitPage>
  );
}
