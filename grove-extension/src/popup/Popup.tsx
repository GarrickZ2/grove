import { useEffect, useState } from 'react';
import { CheckCircle2, Radio, RefreshCw } from 'lucide-react';
import './popup.css';

type Status = { connected: boolean; connecting: boolean; address: string };
type Config = { address: string; passkey: string; autoDiscover: boolean };
const DEFAULT_ADDRESS = 'http://127.0.0.1:3001';

export default function Popup() {
  const [status, setStatus] = useState<Status>({ connected: false, connecting: true, address: DEFAULT_ADDRESS });
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [passkey, setPasskey] = useState('');
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [found, setFound] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await chrome.runtime.sendMessage({ type: 'GROVE_CONNECTION_STATUS' }) as Status;
        if (alive && next) setStatus(next);
      } catch { if (alive) setStatus(s => ({ ...s, connected: false, connecting: false })); }
    };
    void chrome.storage.local.get(['grove_connection', 'grove_port']).then(data => {
      if (!alive) return;
      const config = data.grove_connection as Config | undefined;
      setAddress(config?.address || `http://127.0.0.1:${data.grove_port || 3001}`);
      setPasskey(config?.passkey || '');
    });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const scan = async () => {
    setEditing(true); setScanning(true); setError(''); setFound([]);
    const addresses = Array.from({ length: 10 }, (_, i) => `http://127.0.0.1:${3001 + i}`);
    const results = await Promise.all(addresses.map(async candidate => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 800);
      try {
        const response = await fetch(`${candidate}/api/v1/auth/info`, { signal: controller.signal });
        if (!response.ok) return null;
        const info = await response.json();
        return typeof info.required === 'boolean' && typeof info.mode === 'string' ? candidate : null;
      } catch { return null; } finally { window.clearTimeout(timeout); }
    }));
    const matches = results.filter((item): item is string => item !== null);
    setFound(matches);
    if (!matches.length) setError('No local Grove servers found on ports 3001–3010.');
    setScanning(false);
  };

  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    let normalized: string;
    try {
      const url = new URL(address.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      normalized = url.origin;
    } catch { setError('Enter a valid HTTP or HTTPS address, for example http://192.168.1.10:3001.'); return; }
    setAddress(normalized); setConnecting(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GROVE_CONNECT', config: { address: normalized, passkey, autoDiscover: false } });
      if (!result?.ok) throw new Error('Could not update connection.');
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 300));
        const next = await chrome.runtime.sendMessage({ type: 'GROVE_CONNECTION_STATUS' }) as Status;
        setStatus(next);
        if (next.address === normalized && next.connected) { setEditing(false); setConnecting(false); return; }
      }
      setError('Could not connect. Check the address, passkey, network, and Grove server.');
    } catch { setError('Could not connect. Check the address, passkey, network, and Grove server.'); }
    setConnecting(false);
  };

  return <main className="popup">
    <header className="header">
      <div className="brand"><img src="/icons/32.png" alt="" /><div><h1>Grove Companion</h1><span>v{chrome.runtime.getManifest().version}</span></div></div>
      <div className={`status ${status.connected ? 'online' : ''}`}><Radio size={14} />{status.connected ? 'Connected' : status.connecting ? 'Connecting' : 'Offline'}</div>
    </header>
    <section className="connection">
      <div className="connection-heading"><div className="connection-title"><CheckCircle2 size={16} className={status.connected ? 'online-icon' : 'offline-icon'} /><strong>{status.connected ? 'Connected to Grove' : 'Grove connection'}</strong></div>
        {!editing && <button className="link" onClick={() => { setEditing(true); setAddress(status.address); setError(''); }}>Change</button>}
      </div>
      {!editing ? <><div className="address">{status.address}</div>{!status.connected && <p className="hint">Choose an address to connect to a local or remote Grove server.</p>}</> :
        <form onSubmit={connect}>
          <label htmlFor="address">Grove address</label>
          <input id="address" type="url" required value={address} onChange={e => setAddress(e.target.value)} placeholder="http://127.0.0.1:3001" autoFocus />
          <p className="hint">Use the full address, including http:// or https:// and port.</p>
          <label htmlFor="passkey">Passkey <span>optional</span></label>
          <input id="passkey" type="password" value={passkey} onChange={e => setPasskey(e.target.value)} placeholder="For password-protected Grove" autoComplete="off" />
          <p className="hint">For Grove mobile authentication. Saved locally in this browser.</p>
          {found.length > 0 && <div className="results"><span>Local servers</span>{found.map(item => <button type="button" key={item} onClick={() => { setAddress(item); setPasskey(''); setFound([]); }}>{item}</button>)}</div>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions"><button type="button" className="secondary" onClick={scan} disabled={scanning || connecting}><RefreshCw size={14} className={scanning ? 'spin' : ''} />{scanning ? 'Scanning…' : 'Scan local ports'}</button><div className="action-right">{status.connected && <button type="button" className="secondary" onClick={() => { setEditing(false); setError(''); }}>Cancel</button>}<button className="primary" type="submit" disabled={connecting || scanning}>{connecting ? 'Connecting…' : 'Connect'}</button></div></div>
        </form>}
    </section>
    <footer>Control this browser from your connected Grove.</footer>
  </main>;
}
