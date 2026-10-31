import { useCallback, useState } from "react";
import { Link2, Plus } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import { createBuddyConnect, listBuddyConnects, listBuddyConnectPlatforms } from "../../../api/buddyResources";
import { useBuddyResource } from "../../../hooks/useBuddyResource";
import { errorMessage } from "../../../utils/errorMessage";

export function BuddyConnects({ buddy }: { buddy: Buddy }) {
  const load = useCallback(() => listBuddyConnects(buddy), [buddy]);
  const { data, error, refresh } = useBuddyResource(load);
  const platforms = useBuddyResource(listBuddyConnectPlatforms);
  const [creating, setCreating] = useState(false);
  const [platformId, setPlatformId] = useState("");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const platform = platforms.data?.find((item) => item.id === platformId) ?? platforms.data?.find((item) => item.available);
  const submit = async () => {
    if (busy || !platform || !name.trim()) return;
    setBusy(true); setFailure(null);
    try { await createBuddyConnect(buddy, { name: name.trim(), platform: platform.id, domain: platform.id, adapter_config: values }); await refresh(); setCreating(false); setValues({}); setName(""); }
    catch (reason) { setFailure(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  return <section className="buddy-connects"><h3>IM connections</h3>
    {(error || failure || platforms.error) && <p role="alert">{error || failure || platforms.error}</p>}
    {data?.map((item) => <div key={item.id} className="buddy-connect-row"><Link2 size={16} /><span>{item.platform} · {item.name}<small>{item.runtime.state}</small></span></div>)}
    {data?.length === 0 && <p className="buddy-muted">No connections yet.</p>}
    {creating ? <form className="buddy-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><p className="buddy-muted">Messages go to {buddy.name}.</p>
      <label>Name<input required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <label>Platform<select value={platform?.id ?? ""} disabled={busy} onChange={(event) => { setPlatformId(event.target.value); setValues({}); }}>{platforms.data?.filter((item) => item.available).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {platform?.config_fields.map((field) => <label key={field.key}>{field.label}<input required={field.required} type={field.secret ? "password" : "text"} autoComplete="off" value={values[field.key] ?? ""} disabled={busy} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} /></label>)}
      <div className="buddy-actions"><button type="button" className="buddy-button" disabled={busy} onClick={() => { setCreating(false); setValues({}); }}>Cancel</button><button type="submit" className="buddy-button is-primary" disabled={busy || !platform}>Connect</button></div>
    </form> : <button type="button" className="buddy-button" onClick={() => setCreating(true)}><Plus size={15} />Add connection</button>}
  </section>;
}
