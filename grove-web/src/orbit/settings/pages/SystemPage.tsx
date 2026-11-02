import { useState } from "react";
import { Cpu, HardDrive, LogOut, MemoryStick, Monitor, Pencil, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { DialogShell } from "../../../components/ui/DialogShell";
import { dateTime, deviceIsMobile, lastUsed, useLoginDevices } from "../../../components/Config/useLoginDevices";
import { useResourceMonitorData } from "../../../components/Config/useResourceMonitorData";
import { ResourceExplorer, ResourceNote, Sparkline } from "../../../components/Config/ResourceMonitor";
import { bytes, memoryLabel, memoryValue, percent, type Metric } from "../../../components/Config/resourceFormat";
import { useTheme } from "../../../context";
import { Block, Button, Group, Lead, Row, Segmented } from "../../ui";

function LoginDevices() {
  const {
    loading, busy, error, currentId, trustAvailable, showPorts, groups,
    editing, setEditing, name, setName,
    refresh, rename, signOut, trust,
  } = useLoginDevices();

  return (
    <>
      {loading ? (
        <Group title="Login devices" anchorId="devices">
          <Row title="Loading devices…" />
        </Group>
      ) : groups.map((group, index) => (
        <Group
          key={group.port ?? "all"}
          title={showPorts ? (group.port === undefined ? "Login devices · Other" : `Login devices · Port ${group.port}`) : "Login devices"}
          anchorId={index === 0 ? "devices" : undefined}
          actions={index === 0 ? (
            <Button variant="ghost" disabled={busy} onClick={() => void refresh()} aria-label="Refresh devices">
              <RefreshCw />
              Refresh
            </Button>
          ) : undefined}
          footnote={index === 0 && error ? <span className="ost-error" role="alert">{error}</span> : undefined}
        >
          {group.devices.map((device) => {
            const current = device.id === currentId;
            const Icon = deviceIsMobile(device) ? Smartphone : Monitor;
            return (
              <Row
                key={device.id}
                leading={<Lead><Icon /></Lead>}
                title={(
                  <>
                    <span className="ost-truncate" title={device.name}>{device.name}</span>
                    {current ? <span className="oui-count ost-badge-accent">This device</span> : null}
                  </>
                )}
                description={(
                  <>
                    {device.name !== device.client ? `${device.client} · ` : ""}
                    <span title={dateTime(device.last_used_at)}>Last used {lastUsed(device.last_used_at)}</span>
                    {` · ${device.trusted ? "Trusted" : "Session only"}`}
                  </>
                )}
              >
                {current && !device.trusted && trustAvailable ? (
                  <Button disabled={busy} onClick={() => void trust()} aria-label="Trust this device">
                    <ShieldCheck />
                    Trust
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  iconOnly
                  disabled={busy}
                  title="Rename"
                  aria-label={`Rename ${device.name}`}
                  onClick={() => { setEditing(device); setName(device.name); }}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  disabled={busy}
                  title="Sign out"
                  aria-label={`Sign out ${device.name}`}
                  className="ost-danger"
                  onClick={() => void signOut(device)}
                >
                  <LogOut />
                </Button>
              </Row>
            );
          })}
          {!group.devices.length && !error ? <Row title="No active device authorizations" /> : null}
        </Group>
      ))}

      <DialogShell isOpen={!!editing} onClose={() => { if (!busy) setEditing(null); }}>
        <form onSubmit={rename} className="orbit-ui ost-dialog">
          <div className="ost-dialog-head">
            <h2>Device name</h2>
            <Button variant="ghost" iconOnly aria-label="Close" disabled={busy} onClick={() => setEditing(null)}><X /></Button>
          </div>
          <input
            autoFocus
            aria-label="Device name"
            className="oui-field ost-dialog-field"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
          {error ? <p role="alert" className="ost-error">{error}</p> : null}
          <div className="ost-dialog-actions">
            <Button disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </DialogShell>
    </>
  );
}

function Resources() {
  const { theme } = useTheme();
  const palette = theme.accentPalette.length ? theme.accentPalette : ["var(--color-highlight)"];
  const { processes, storage, samples, processError, storageError, refreshing, refreshStorage } = useResourceMonitorData();
  const [metric, setMetric] = useState<Metric>("storage");
  const errors = [
    processError && `Processes: ${processError}`,
    (storageError || storage?.error) && `Storage: ${storageError || storage?.error}`,
  ].filter(Boolean).join(" · ");

  return (
    <Group
      title="Resources"
      hint={processes ? `${processes.process_count} processes · ${processError ? "last successful sample" : "updates every 10s"}` : "Connecting…"}
      anchorId="resources"
      footnote={(
        <>
          {errors ? <span className="ost-warn" role="alert">{errors} Previous measurements remain visible where available. </span> : null}
          <ResourceNote metric={metric} processes={processes} storage={storage} />
        </>
      )}
    >
      <Row
        leading={<Lead><Cpu /></Lead>}
        title={<>CPU <span className="ost-metric">{processes?.cpu_percent == null ? "—" : percent(processes.cpu_percent)}</span></>}
        description={processes?.cpu_percent == null ? "Collecting samples" : `Across ${processes.logical_cpus} logical cores`}
      >
        <span className="ost-spark"><Sparkline values={samples.flatMap((s) => s.cpu === null ? [] : [s.cpu])} color="var(--color-highlight)" /></span>
      </Row>
      <Row
        leading={<Lead><MemoryStick /></Lead>}
        title={<>{processes ? memoryLabel(processes) : "Memory"} <span className="ost-metric">{processes ? memoryValue(processes.memory_bytes, processes.memory_unavailable_count) : "—"}</span></>}
        description={processes?.memory_basis === "physical_footprint" ? "Process charges · includes compressed / swapped" : "Shared pages may be counted repeatedly"}
      >
        <span className="ost-spark"><Sparkline values={samples.flatMap((s) => s.memory === null ? [] : [s.memory])} color="var(--color-info)" /></span>
      </Row>
      <Row
        leading={<Lead><HardDrive /></Lead>}
        title={<>Storage <span className="ost-metric">{storage?.root ? bytes(storage.root.bytes) : "—"}</span></>}
        description={storage?.scanning ? "Scanning .grove…" : "All files in .grove"}
      />
      <Row title="Breakdown" description="Where resources go, by project and task.">
        <Segmented
          ariaLabel="Resource breakdown"
          value={metric}
          options={[
            { value: "cpu", label: "CPU" },
            { value: "memory", label: "Memory" },
            { value: "storage", label: "Storage" },
          ]}
          onChange={setMetric}
        />
      </Row>
      <Block>
        <div className="ost-legacy-embed">
          <ResourceExplorer
            key={metric}
            metric={metric}
            processes={processes}
            storage={storage}
            palette={palette}
            refreshing={refreshing}
            onRefresh={() => void refreshStorage()}
            processError={processError}
            storageError={storageError}
          />
        </div>
      </Block>
    </Group>
  );
}

export function SystemPage() {
  return (
    <>
      <LoginDevices />
      <Resources />
    </>
  );
}
