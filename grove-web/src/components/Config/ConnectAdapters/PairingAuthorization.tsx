import { useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Button, Input } from '../../ui';
import type { AuthorizationProps } from './types';

export interface TokenField { key: string; label: string; placeholder: string; valid: (value: string) => boolean }

/** Bring-your-own-bot setup: paste tokens, then prove ownership with a code. */
export function TokenForm({ fields, submit, busy, flow, children }: Pick<AuthorizationProps, 'submit' | 'busy' | 'flow'> & { fields: TokenField[]; children: ReactNode }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = fields.every((field) => field.valid((values[field.key] ?? '').trim()));
  const send = async () => {
    setSubmitting(true);
    setError(null);
    try { await submit(Object.fromEntries(fields.map((field) => [field.key, (values[field.key] ?? '').trim()]))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };
  return <form className="space-y-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); if (ready) void send(); }}>
    {children}
    <div className="space-y-4">{fields.map((field) => <Input key={field.key} label={field.label} type="password" autoComplete="off" spellCheck={false} placeholder={field.placeholder} value={values[field.key] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />)}</div>
    {(error || flow?.error) && <p role="alert" className="text-xs text-[var(--color-error)]">{error || flow?.error}</p>}
    <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy || submitting || !ready}>{submitting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Verifying…</> : 'Verify and continue'}</Button></div>
  </form>;
}

export function Steps({ steps }: { steps: ReactNode[] }) {
  return <ol className="space-y-2.5">{steps.map((step, index) => <li key={index} className="flex gap-3 text-xs leading-relaxed text-[var(--color-text-muted)]"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-highlight)]/12 text-[10px] font-semibold text-[var(--color-highlight)]">{index + 1}</span><span className="min-w-0 pt-0.5">{step}</span></li>)}</ol>;
}

export function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-[var(--color-highlight)] hover:underline">{children}<ExternalLink className="h-3 w-3" /></a>;
}

/** Pairing step without a QR code: show the code the owner must send. */
export function PairingCode({ flow, busy, refresh, openLabel, children }: Pick<AuthorizationProps, 'flow' | 'busy' | 'refresh'> & { openLabel: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = flow?.code ?? '';
  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* Clipboard may be unavailable; the code stays visible. */ } };
  return <div className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-5 sm:p-6">
    <div className="flex items-center gap-2 text-sm font-medium">{flow?.state === 'error' ? <span role="alert" className="text-[var(--color-error)]">{flow.error ?? 'Pairing failed'}</span> : <><Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-highlight)]" /><span className="text-[var(--color-text-muted)]">{flow?.state === 'authorized' ? 'Saving connection…' : 'Waiting for your message…'}</span></>}</div>
    {children}
    {code && <div className="flex items-center gap-3"><code className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5 font-mono text-lg font-semibold tracking-[0.2em] text-[var(--color-text)] select-all">{code}</code><Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</Button></div>}
    <div className="flex flex-wrap items-center gap-3">{flow && /^https:\/\//i.test(flow.verification_url) && <span className="text-xs"><ExternalAnchor href={flow.verification_url}>{openLabel}</ExternalAnchor></span>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Start over</Button></div>
  </div>;
}
