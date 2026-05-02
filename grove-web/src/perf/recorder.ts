import type { MemorySample, PerfEvent, PerfSnapshot } from "./types";

const EVENT_BUFFER_CAPACITY = 2000;
const MEMORY_BUFFER_CAPACITY = 60; // 5 min @ 5s sampling

class RingBuffer<T> {
  private buf: T[] = [];
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.buf.length >= this.capacity) {
      this.buf.shift();
    }
    this.buf.push(item);
  }

  snapshot(): T[] {
    return this.buf.slice();
  }

  clear(): void {
    this.buf = [];
  }

  get size(): number {
    return this.buf.length;
  }
}

type Listener = () => void;

class PerfRecorder {
  private events = new RingBuffer<PerfEvent>(EVENT_BUFFER_CAPACITY);
  private memory = new RingBuffer<MemorySample>(MEMORY_BUFFER_CAPACITY);
  private listeners = new Set<Listener>();
  private startedAt = performance.now();
  private fps = 0;
  private fpsFrameCount = 0;
  private fpsLastTick = performance.now();
  private rafId: number | null = null;
  private cachedSnapshot: PerfSnapshot | null = null;

  record(event: PerfEvent): void {
    this.events.push(event);
    this.cachedSnapshot = null;
    this.notify();
  }

  recordMemory(sample: MemorySample): void {
    this.memory.push(sample);
    this.cachedSnapshot = null;
    this.notify();
  }

  snapshot(): PerfSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      startedAt: this.startedAt,
      events: this.events.snapshot(),
      memory: this.memory.snapshot(),
      fps: this.fps,
    };
    return this.cachedSnapshot;
  }

  clear(): void {
    this.events.clear();
    this.memory.clear();
    this.startedAt = performance.now();
    this.cachedSnapshot = null;
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startFpsLoop(): void {
    if (this.rafId !== null) return;
    const tick = () => {
      this.fpsFrameCount += 1;
      const now = performance.now();
      const elapsed = now - this.fpsLastTick;
      if (elapsed >= 1000) {
        const next = Math.round((this.fpsFrameCount * 1000) / elapsed);
        if (next !== this.fps) {
          this.fps = next;
          this.cachedSnapshot = null;
          this.notify();
        }
        this.fpsFrameCount = 0;
        this.fpsLastTick = now;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopFpsLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // Notify listeners on next microtask to coalesce bursts of events.
  private notifyScheduled = false;
  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const l of this.listeners) l();
    });
  }
}

export const perfRecorder = new PerfRecorder();
