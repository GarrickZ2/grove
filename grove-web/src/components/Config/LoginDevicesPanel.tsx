import { Monitor, Smartphone, Pencil, LogOut, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { dateTime, deviceIsMobile, lastUsed, useLoginDevices } from './useLoginDevices';
import { DialogShell } from '../ui/DialogShell';
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { Button as OrbitButton } from "../../orbit/ui/Button";
import { DialogBody, DialogFoot, DialogHead, DialogPanel } from "../../orbit/ui/Dialog";

const buttonClass = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50';

export function LoginDevicesPanel() {
  const {
    loading, busy, error, currentId, trustAvailable, showPorts, groups,
    editing, setEditing, name, setName,
    refresh, rename, signOut, trust,
  } = useLoginDevices();
  const orbit = useOrbitInterface();

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" disabled={busy} onClick={() => { void refresh(); }} className={buttonClass} aria-label="Refresh devices">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-[var(--color-error)]">{error}</p>}
      {loading ? <p role="status" className="text-sm text-[var(--color-text-muted)]">Loading devices…</p> : (
        <div className="space-y-4">
          {groups.map(group => (
            <section key={group.port ?? 'all'} aria-label={showPorts ? (group.port === undefined ? 'Other' : `Port ${group.port}`) : undefined}>
              {showPorts && <h3 className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">{group.port === undefined ? 'Other' : `Port ${group.port}`}</h3>}
              <div className="@container divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
                {group.devices.map(device => {
                  const current = device.id === currentId;
                  const Icon = deviceIsMobile(device) ? Smartphone : Monitor;
                  return (
                    <div key={device.id} className="flex items-center gap-3 p-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                          <Icon className="h-4.5 w-4.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-[var(--color-text)]" title={device.name}>{device.name}</span>
                            {current && <span className="shrink-0 rounded-full bg-[var(--color-highlight)]/10 px-2 py-0.5 text-[10px] text-[var(--color-highlight)]">This device</span>}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
                            {device.name !== device.client && <span className="truncate">{device.client}</span>}
                            <span title={dateTime(device.last_used_at)}>Last used {lastUsed(device.last_used_at)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{device.trusted ? 'Trusted' : 'Session only'}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {current && !device.trusted && trustAvailable && (
                          <button type="button" disabled={busy} onClick={() => { void trust(); }} className={`${buttonClass} text-[var(--color-highlight)]`} aria-label="Trust this device" title="Trust this device">
                            <ShieldCheck className="h-3.5 w-3.5" /><span className="hidden @md:inline">Trust this device</span>
                          </button>
                        )}
                        <button type="button" disabled={busy} onClick={() => { setEditing(device); setName(device.name); }} className={buttonClass} aria-label={`Rename ${device.name}`} title="Rename">
                          <Pencil className="h-3.5 w-3.5" /><span className="hidden @md:inline">Rename</span>
                        </button>
                        <button type="button" disabled={busy} onClick={() => { void signOut(device); }} className={`${buttonClass} text-[var(--color-error)]`} aria-label={`Sign out ${device.name}`} title="Sign out">
                          <LogOut className="h-3.5 w-3.5" /><span className="hidden @md:inline">Sign out</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!group.devices.length && !error && <p className="p-3 text-sm text-[var(--color-text-muted)]">No active device authorizations.</p>}
              </div>
            </section>
          ))}
        </div>
      )}
      <DialogShell isOpen={!!editing} onClose={() => { if (!busy) setEditing(null); }}>
        {orbit ? (
          <DialogPanel onSubmit={rename}>
            <DialogHead title="Device name" />
            <DialogBody>
              <input autoFocus aria-label="Device name" value={name} onChange={event => setName(event.target.value)} maxLength={80} className="oui-field" />
              {error && <p role="alert" className="oui-dlg-error">{error}</p>}
            </DialogBody>
            <DialogFoot>
              <OrbitButton variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</OrbitButton>
              <OrbitButton type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</OrbitButton>
            </DialogFoot>
          </DialogPanel>
        ) : (
        <form onSubmit={rename} className="p-5 space-y-4 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center justify-between">
            <h2 className="font-medium text-[var(--color-text)]">Device name</h2>
            <button type="button" aria-label="Close" onClick={() => setEditing(null)} disabled={busy}><X className="h-4 w-4" /></button>
          </div>
          <input autoFocus aria-label="Device name" value={name} onChange={event => setName(event.target.value)} maxLength={80}
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)]" />
          {error && <p role="alert" className="text-xs text-[var(--color-error)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={busy} onClick={() => setEditing(null)} className={buttonClass}>Cancel</button>
            <button type="submit" disabled={busy || !name.trim()} className={`${buttonClass} bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]`}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
        )}
      </DialogShell>
    </div>
  );
}
