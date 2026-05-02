export type PerfEventKind =
  | "longtask"
  | "event"
  | "react-render"
  | "mark"
  | "measure"
  | "fetch"
  | "ws"
  | "memory";

export interface PerfEvent {
  ts: number;
  kind: PerfEventKind;
  name: string;
  duration: number;
  meta?: Record<string, unknown>;
}

export interface MemorySample {
  ts: number;
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface PerfSnapshot {
  startedAt: number;
  events: PerfEvent[];
  memory: MemorySample[];
  fps: number;
}
