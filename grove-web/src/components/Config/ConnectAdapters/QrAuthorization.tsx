import type { ReactNode } from 'react';
import { ExternalLink, Loader2, RefreshCw, CheckCircle2 } from 'lucide-react';
import { Button, Input } from '../../ui';
import type { AuthorizationProps } from './types';

/** Shared visual primitives; each frontend adapter owns its instructions/input. */
export function QrAuthorization({ flow, busy, refresh, children }: Pick<AuthorizationProps, 'flow' | 'busy' | 'refresh'> & { children: ReactNode }) {
  return <div className="flex flex-col gap-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-4 sm:flex-row sm:p-6">
    <div className="relative mx-auto shrink-0 self-start sm:mx-0"><div className="absolute -inset-1.5 rounded-2xl bg-gradient-to-br from-[#3370ff]/25 to-[#5ed3ff]/10" /><div className="relative flex h-[200px] w-[200px] items-center justify-center rounded-xl bg-white p-3 shadow-inner [&_svg]:h-full [&_svg]:w-full">{flow?.qr_svg ? <div className="h-full w-full" dangerouslySetInnerHTML={{ __html: flow.qr_svg }} /> : <Loader2 className="h-6 w-6 animate-spin text-[#3370ff]" />}</div></div>
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-3 text-center sm:text-left">
      <div className="flex items-center justify-center gap-2 text-sm font-medium sm:justify-start">{flow?.state === 'error' ? <span role="alert" className="text-[var(--color-error)]">{flow.error ?? 'Registration failed'}</span> : <><Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-highlight)]" /><span className="text-[var(--color-text-muted)]">{flow?.state === 'authorized' ? 'Saving connection…' : flow?.state === 'waiting_for_input' ? 'Verification required' : 'Waiting for authorization…'}</span></>}</div>
      {children}
      <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">{flow && /^https?:\/\//i.test(flow.verification_url) && <a href={flow.verification_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-highlight)] hover:underline">Open in browser <ExternalLink className="h-3 w-3" /></a>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh QR</Button></div>
      <p className="text-[11px] text-[var(--color-text-muted)]">Refreshes automatically before it expires</p>
    </div>
  </div>;
}

export function ManualCredentials({ platform, draft, setDraft, busy, verifyManual }: AuthorizationProps) {
  if (!platform?.setup_modes.includes('manual')) return null;
  return <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5">
    <div className="mb-4 text-xs font-medium text-[var(--color-text-muted)]">Already have credentials?</div>
    <div className="grid gap-4 sm:grid-cols-2">{platform.config_fields.map((field) => <Input key={field.key} label={field.label} type={field.secret ? 'password' : 'text'} value={String(draft.adapter_config[field.key] ?? '')} onChange={(event) => setDraft((current) => ({ ...current, adapter_config: { ...current.adapter_config, [field.key]: event.target.value } }))} placeholder={field.placeholder} />)}</div>
    <div className="mt-4 flex items-center justify-end"><Button size="sm" disabled={busy || !platform.config_fields.filter((field) => field.required).every((field) => draft.adapter_config[field.key])} onClick={() => void verifyManual()}><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />Verify and continue</Button></div>
  </div>;
}
