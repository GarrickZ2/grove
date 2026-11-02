/**
 * The first-launch chime, synthesized with WebAudio (no audio asset): a soft
 * low thump as the seed lands, a rising marimba-like arpeggio as the leaves
 * open, and a warm pad under the wordmark. Times are seconds from start.
 *
 * Browsers can't tell whether the system is muted, so it stays quiet (low
 * master gain); a muted system simply plays nothing. Where autoplay is
 * blocked the context never starts and the launch runs silently.
 */
const MASTER_GAIN = 0.12;

const NOTES: [freq: number, at: number, dur: number, type: OscillatorType, vol: number][] = [
  [98, 0.05, 0.5, "sine", 0.9],
  [392, 0.85, 0.8, "triangle", 0.35],
  [523.25, 0.95, 0.8, "triangle", 0.32],
  [659.25, 1.05, 0.9, "triangle", 0.3],
  [783.99, 1.15, 1.1, "sine", 0.22],
  [261.63, 1.25, 1.2, "sine", 0.18],
  [329.63, 1.25, 1.2, "sine", 0.12],
];

export interface LaunchSound {
  /** Fade out quickly (skip) and release the audio device. */
  stop: () => void;
}

export function playLaunchSound(): LaunchSound | null {
  const AC = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  let ctx: AudioContext;
  try { ctx = new AC(); } catch { return null; }
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(ctx.destination);
  for (const [freq, at, dur, type, vol] of NOTES) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.value = freq;
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(vol, now + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(now + at);
    osc.stop(now + at + dur + 0.05);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void ctx.close().catch(() => {});
  };
  const end = Math.max(...NOTES.map(([, at, dur]) => at + dur)) + 0.2;
  const timer = window.setTimeout(close, end * 1000);
  return {
    stop: () => {
      if (closed) return;
      window.clearTimeout(timer);
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
      } catch { /* already closing */ }
      window.setTimeout(close, 250);
    },
  };
}
