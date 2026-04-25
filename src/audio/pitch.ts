// YIN pitch detection (de Cheveigné & Kawahara, 2002).
// Operates on a time-domain buffer; returns fundamental frequency in Hz.

const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
] as const;

export interface PitchEstimate {
  freq: number;       // Hz
  clarity: number;    // 1 - CMNDF at chosen tau, in [0, 1]
  noteName: string;   // e.g. "A"
  octave: number;     // e.g. 4 for A4
  midi: number;       // floating MIDI number (so we can extract cents)
  cents: number;      // -50..+50 deviation from nearest equal-tempered note
}

/**
 * Detect the fundamental pitch of `buf` (mono, signed -1..+1 floats).
 * Returns null when no clear pitch is found.
 *
 * @param buf time-domain samples
 * @param sampleRate audio context sample rate
 * @param minHz lowest pitch to consider (default 30 Hz, ~B0)
 * @param maxHz highest pitch to consider (default 2000 Hz)
 * @param threshold YIN absolute threshold (default 0.15)
 * @param a4Hz reference A4 frequency (default 440)
 */
export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  minHz = 30,
  maxHz = 2000,
  threshold = 0.15,
  a4Hz = 440,
): PitchEstimate | null {
  const N = buf.length;
  const halfN = N >> 1;
  const maxPeriod = Math.min(halfN - 2, Math.floor(sampleRate / minHz));
  const minPeriod = Math.max(2, Math.floor(sampleRate / maxHz));

  // Quick energy check: silence -> no pitch.
  let energy = 0;
  for (let i = 0; i < N; i++) energy += buf[i] * buf[i];
  if (energy / N < 1e-6) return null;

  // 1. Difference function over the lag range we care about.
  const diff = new Float32Array(maxPeriod + 1);
  for (let tau = minPeriod; tau <= maxPeriod; tau++) {
    let sum = 0;
    const limit = halfN;
    for (let i = 0; i < limit; i++) {
      const d = buf[i] - buf[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // 2. Cumulative mean normalized difference function.
  const cmnd = new Float32Array(maxPeriod + 1);
  cmnd[minPeriod] = 1;
  let runningSum = 0;
  for (let tau = minPeriod + 1; tau <= maxPeriod; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = runningSum > 0 ? diff[tau] * (tau - minPeriod) / runningSum : 1;
  }

  // 3. Absolute threshold: first dip below threshold that's a local minimum.
  let tau = -1;
  for (let t = minPeriod + 1; t < maxPeriod; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < maxPeriod && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // Fallback: take the global minimum if it's still reasonably small.
    let bestTau = -1;
    let bestVal = Infinity;
    for (let t = minPeriod + 1; t < maxPeriod; t++) {
      if (cmnd[t] < bestVal) {
        bestVal = cmnd[t];
        bestTau = t;
      }
    }
    if (bestTau < 0 || bestVal > 0.5) return null;
    tau = bestTau;
  }

  // 4. Parabolic interpolation to refine the period.
  let refined = tau;
  if (tau > minPeriod && tau < maxPeriod) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (a - c)) / denom;
      if (delta > -1 && delta < 1) refined = tau + delta;
    }
  }

  const freq = sampleRate / refined;
  if (!Number.isFinite(freq) || freq < minHz || freq > maxHz) return null;

  const midi = 69 + 12 * Math.log2(freq / a4Hz);
  const nearest = Math.round(midi);
  const cents = (midi - nearest) * 100;
  const noteName = NOTE_NAMES[((nearest % 12) + 12) % 12];
  const octave = Math.floor(nearest / 12) - 1;

  return {
    freq,
    clarity: Math.max(0, Math.min(1, 1 - cmnd[tau])),
    noteName,
    octave,
    midi,
    cents,
  };
}
