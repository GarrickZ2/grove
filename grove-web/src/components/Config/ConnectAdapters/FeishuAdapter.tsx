import { useState } from 'react';
import { CheckCircle2, ChevronDown, Loader2, Settings2 } from 'lucide-react';
import { Button, Input } from '../../ui';
import { ManualCredentials, QrAuthorization } from './QrAuthorization';
import type { AuthorizationProps, SettingsProps } from './types';

import { ADVANCED_CONFIG_FIELDS } from './feishuConfig';

type AdvancedConfigKey = typeof ADVANCED_CONFIG_FIELDS[number]['key'];
type AdvancedDraft = Record<AdvancedConfigKey, string>;

function readAdvancedConfig(config: Record<string, unknown>): AdvancedDraft {
  return Object.fromEntries(ADVANCED_CONFIG_FIELDS.map(({ key }) => [key, String(config[key] ?? '')])) as AdvancedDraft;
}

export function FeishuAuthorization(props: AuthorizationProps) {
  return <div className="space-y-5"><QrAuthorization {...props}><p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Open {props.platform?.name ?? 'Feishu'} on your phone, scan the code, and confirm to create the Grove bot app.</p></QrAuthorization><ManualCredentials {...props} /></div>;
}

export function FeishuSettings({ item, draft, busy, save }: SettingsProps) {
  const routedDraft = draft;
  const [advancedState, setAdvancedState] = useState<{ itemId: string; values: AdvancedDraft }>({ itemId: item.id, values: readAdvancedConfig(item.adapter_config) });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedDraft = advancedState.itemId === item.id ? advancedState.values : readAdvancedConfig(item.adapter_config);
  const patchAdvanced = (key: AdvancedConfigKey, value: string) => setAdvancedState({ itemId: item.id, values: { ...advancedDraft, [key]: value } });
  const saveAdvanced = () => {
    const adapter_config = { ...draft.adapter_config };
    for (const { key } of ADVANCED_CONFIG_FIELDS) adapter_config[key] = advancedDraft[key].trim();
    void save({ ...routedDraft, adapter_config });
  };
  const resetAdvanced = () => setAdvancedState({ itemId: item.id, values: readAdvancedConfig({}) });
  const hasAdvancedOverrides = ADVANCED_CONFIG_FIELDS.some(({ key }) => advancedDraft[key].trim() !== '');
  return <section className="rounded-xl border border-[var(--color-border)]">
      <button type="button" onClick={() => setAdvancedOpen((open) => !open)} className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left hover:bg-[var(--color-bg-secondary)]/40">
        <Settings2 className="h-4 w-4 text-[var(--color-text-muted)]" />
        <span className="flex-1 text-sm font-medium text-[var(--color-text)]">Advanced connection settings</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${hasAdvancedOverrides ? 'bg-[var(--color-highlight)]/12 text-[var(--color-highlight)]' : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]'}`}>{hasAdvancedOverrides ? 'Custom' : 'Feishu defaults'}</span>
        <ChevronDown className={`h-4 w-4 text-[var(--color-text-muted)] transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
      </button>
      {advancedOpen && <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3.5">
        <p className="mb-4 text-xs leading-relaxed text-[var(--color-text-muted)]">Leave every field blank to use Feishu’s server-provided SDK defaults. Saving custom values restarts this connection.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          {ADVANCED_CONFIG_FIELDS.map(({ key, label, placeholder, min, description }) => <div key={key}>
            <Input type="number" min={min} step="1" className="appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" label={label} value={advancedDraft[key]} placeholder={placeholder} onChange={(event) => patchAdvanced(key, event.target.value)} />
            <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{description}</p>
          </div>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">Official defaults are applied when a field is empty.</p>
          <div className="flex items-center gap-2">
            {hasAdvancedOverrides && <Button variant="ghost" size="sm" onClick={resetAdvanced} disabled={busy}>Reset</Button>}
            <Button size="sm" onClick={saveAdvanced} disabled={busy}>{busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}Save settings</Button>
          </div>
        </div>
      </div>}
    </section>;
}
