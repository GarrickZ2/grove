import { useState } from 'react';
import wechatLogo from './assets/wechat.svg';
import { Button, Input } from '../../ui';
import { ManualCredentials, QrAuthorization } from './QrAuthorization';
import type { AuthorizationProps, SettingsProps } from './types';

export function WeixinAuthorization(props: AuthorizationProps) {
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitCode = async () => {
    setSubmitting(true);
    setError(null);
    try { await props.submit({ verify_code: code.trim() }); setCode(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubmitting(false); }
  };
  return <div className="space-y-5">
    <QrAuthorization {...props}>
      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Scan with WeChat and confirm the ClawBot connection. If WeChat shows a verification code, enter it here.</p>
      {props.flow?.state === 'waiting_for_input' && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submitCode(); }}>
        <Input label="WeChat verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={16} value={code} onChange={(event) => setCode(event.target.value)} />
        {(error || props.flow.error) && <p role="alert" className="text-xs text-[var(--color-error)]">{error || props.flow.error}</p>}
        <Button type="submit" disabled={props.busy || submitting || !/^\d{1,16}$/.test(code.trim())}>{submitting ? 'Verifying…' : 'Verify code'}</Button>
      </form>}
    </QrAuthorization>
    <ManualCredentials {...props} />
  </div>;
}

export function WeixinSettings({ busy, reauthorize }: SettingsProps) {
  return <section className="rounded-xl border border-[var(--color-border)] p-4">
    <p className="mb-3 text-xs text-[var(--color-text-muted)]">If the WeChat login expires, scan again. Your current Grove target is retained.</p>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reauthorize()}>Authorize WeChat again</Button>
  </section>;
}

export function WeixinMark({ size }: { size: number }) {
  return <div className="flex shrink-0 items-center justify-center" style={{ width: size + 12, height: size + 12 }}><img src={wechatLogo} alt="" width={size} height={size} /></div>;
}
