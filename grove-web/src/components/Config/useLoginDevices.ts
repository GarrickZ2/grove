import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  listLoginDevices, logoutDevice, renameLoginDevice, revokeLoginDevice,
  type LoginDevice,
  canTrustDevice, canUseTrustedDeviceCookie, getAuthInfo, trustCurrentDevice,
} from '../../api/auth';

export function lastUsed(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - timestamp) / 60));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

export const dateTime = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();

export const deviceIsMobile = (device: LoginDevice) => /iPhone|iPad|Android/.test(device.client);

/** Login device list + rename / sign-out / trust actions, grouped by port when several are in use. */
export function useLoginDevices() {
  const [devices, setDevices] = useState<LoginDevice[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LoginDevice | null>(null);
  const [name, setName] = useState('');
  const [trustAvailable, setTrustAvailable] = useState(false);
  const [cookieTrustAvailable, setCookieTrustAvailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const info = await getAuthInfo();
      if (!info.device_sessions) {
        setError('Device management requires an updated Grove backend. Rebuild and restart Grove, then refresh.');
        return;
      }
      setTrustAvailable(canTrustDevice(info));
      setCookieTrustAvailable(canUseTrustedDeviceCookie(info));
      const result = await listLoginDevices();
      setDevices(result.devices);
      setCurrentId(result.current_device_id);
      setError(null);
    } catch { setError('Unable to load devices. Please try again.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !name.trim() || busy) return;
    setBusy(true);
    try {
      await renameLoginDevice(editing.id, name.trim());
      setEditing(null);
      await refresh();
    } catch { setError('Unable to rename this device. Please try again.'); }
    finally { setBusy(false); }
  };

  const signOut = async (target: LoginDevice) => {
    if (busy) return;
    setBusy(true);
    try {
      if (target.id === currentId) { await logoutDevice(); return; }
      else await revokeLoginDevice(target.id);
      await refresh();
    } catch { setError('Unable to sign out. Please try again.'); }
    finally { setBusy(false); }
  };

  const trust = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await trustCurrentDevice(cookieTrustAvailable);
      await refresh();
    } catch { setError('Unable to trust this device. Please try again.'); }
    finally { setBusy(false); }
  };

  const ports = [...new Set(devices.map(device => device.port))];
  const showPorts = ports.filter(port => port !== undefined).length > 1;
  const groups = showPorts
    ? ports.sort((a, b) => (a ?? Infinity) - (b ?? Infinity))
      .map(port => ({ port, devices: devices.filter(device => device.port === port) }))
    : [{ port: undefined, devices }];

  return {
    loading, busy, error, currentId, trustAvailable, showPorts, groups,
    editing, setEditing, name, setName,
    refresh, rename, signOut, trust,
  };
}
