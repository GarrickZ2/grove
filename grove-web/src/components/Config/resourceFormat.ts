import type { ProcessNode, ProcessSnapshot, StorageNode } from '../../api/resourceMonitor';

export type Metric = 'cpu' | 'memory' | 'storage';

export function bytes(value: number): string {
  if (value === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

export function memoryValue(value: number, unavailable = 0): string {
  return unavailable ? value > 0 ? `${bytes(value)} (partial)` : 'Unavailable' : bytes(value);
}
export function memoryLabel(processes: ProcessSnapshot | null): string {
  return processes?.memory_basis === 'physical_footprint' ? 'Memory footprint' : 'Memory (RSS sum)';
}

export function percent(value: number): string { return `${value.toFixed(1)}%`; }

export function message(error: unknown): string { return error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Could not load resource usage. Try again.'; }
export function valueOf(node: ProcessNode, metric: Metric) { return metric === 'cpu' ? node.cpu_percent ?? 0 : node.memory_bytes; }
export function storageKey(node: StorageNode) { return `${node.kind}:${node.detail}`; }
export function groupColor(key: string, palette: string[]) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}
