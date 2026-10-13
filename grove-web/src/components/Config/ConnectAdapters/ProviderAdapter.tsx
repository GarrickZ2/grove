import { ManualCredentials, QrAuthorization } from './QrAuthorization';
import type { AuthorizationProps } from './types';
export function ProviderAuthorization(props: AuthorizationProps) {
  return <div className="space-y-5"><QrAuthorization {...props}><p className="text-xs leading-relaxed text-[var(--color-text-muted)]">Scan the code or open the authorization page, then approve access in {props.platform?.name ?? 'the provider'}. Grove saves the provider configuration returned after authorization.</p></QrAuthorization><ManualCredentials {...props} /></div>;
}
