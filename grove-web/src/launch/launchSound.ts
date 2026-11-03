/**
 * The launch hum, synthesized with WebAudio (no audio asset): detuned saws
 * through a slowly opening lowpass swell out of silence, a breath of filtered
 * noise rises with them, and glassy bell partials ring through a reverb when
 * the logo resolves at `bloom` seconds.
 *
 * Browsers can't tell whether the system is muted; a muted system simply plays
 * nothing. Where autoplay is blocked the context never starts and the launch
 * runs silently.
 */
const MASTER_GAIN = 0.22;

/** Drone voicing (A1 A2 E3 A3 C#4) and each voice's level. */
const DRONE: [freq: number, vol: number][] = [[55, 0.55], [110, 0.45], [164.81, 0.3], [220, 0.25], [277.18, 0.14]];
/** Bell partials at the bloom: frequency, level, decay seconds. */
const BELLS: [freq: number, vol: number, decay: number][] = [[440, 0.12, 2.6], [880, 0.16, 2.4], [1318.5, 0.1, 2], [1760, 0.07, 1.8], [2217.5, 0.04, 1.4]];

export interface LaunchSound {
  /** Fade out quickly (skip) and release the audio device. */
  stop: () => void;
}

function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return buffer;
}

export function playLaunchSound(bloom: number): LaunchSound | null {
  const AC = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  let ctx: AudioContext;
  try { ctx = new AC(); } catch { return null; }
  const t0 = ctx.currentTime + 0.05;
  const end = bloom + 4;

  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 3;
  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, 3.2, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.45;
  master.connect(comp);
  comp.connect(ctx.destination);
  master.connect(verb);
  verb.connect(wet);
  wet.connect(comp);

  // Drone: the lowpass opens as it swells, then settles back while it fades.
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.Q.value = 2.5;
  lowpass.frequency.setValueAtTime(90, t0);
  lowpass.frequency.exponentialRampToValueAtTime(1400, t0 + bloom);
  lowpass.frequency.exponentialRampToValueAtTime(500, t0 + bloom + 2.2);
  const drone = ctx.createGain();
  drone.gain.setValueAtTime(0.0001, t0);
  drone.gain.exponentialRampToValueAtTime(0.5, t0 + bloom * 0.85);
  drone.gain.exponentialRampToValueAtTime(0.7, t0 + bloom);
  drone.gain.setTargetAtTime(0.0001, t0 + bloom + 0.3, 0.7);
  lowpass.connect(drone);
  drone.connect(master);
  for (const [freq, vol] of DRONE) {
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      // A slight upward glide makes the swell feel like it is arriving.
      osc.detune.setValueAtTime(detune - 40, t0);
      osc.detune.linearRampToValueAtTime(detune, t0 + bloom);
      gain.gain.value = vol * 0.18;
      osc.connect(gain);
      gain.connect(lowpass);
      osc.start(t0);
      osc.stop(t0 + end);
    }
  }
  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.frequency.value = 55;
  subGain.gain.setValueAtTime(0.0001, t0);
  subGain.gain.exponentialRampToValueAtTime(0.35, t0 + bloom);
  subGain.gain.setTargetAtTime(0.0001, t0 + bloom + 0.2, 0.6);
  sub.connect(subGain);
  subGain.connect(master);
  sub.start(t0);
  sub.stop(t0 + end);

  // Air: band-passed noise rising with the drone, like a breath in.
  const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * (bloom + 1)), ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.Q.value = 1.2;
  bandpass.frequency.setValueAtTime(300, t0);
  bandpass.frequency.exponentialRampToValueAtTime(4000, t0 + bloom);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.06, t0 + bloom);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + bloom + 0.6);
  noise.connect(bandpass);
  bandpass.connect(noiseGain);
  noiseGain.connect(master);
  noise.start(t0);
  noise.stop(t0 + bloom + 1);

  // Bloom: bells as the logo resolves, mostly heard through the reverb.
  for (const [freq, vol, decay] of BELLS) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + bloom);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + bloom + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + bloom + decay);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0 + bloom);
    osc.stop(t0 + bloom + decay + 0.1);
  }

  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void ctx.close().catch(() => {});
  };
  const timer = window.setTimeout(close, (end + 0.5) * 1000);
  return {
    stop: () => {
      if (closed) return;
      window.clearTimeout(timer);
      try {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      } catch { /* already closing */ }
      window.setTimeout(close, 400);
    },
  };
}
