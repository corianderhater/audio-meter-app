// BPM detection from a stream of low-frequency power samples ("onset envelope").
// Pure functions; the React hook in useBpm.ts owns the buffers and timing.

export const HOP_HZ = 100;            // sample the onset envelope at 100 Hz
export const WINDOW_SEC = 8;          // analyse the last 8 seconds
export const WINDOW_LEN = HOP_HZ * WINDOW_SEC;
export const BPM_MIN = 60;
export const BPM_MAX = 200;

const LAG_MIN = Math.floor((60 * HOP_HZ) / BPM_MAX); // 30 samples = 200 BPM
const LAG_MAX = Math.ceil((60 * HOP_HZ) / BPM_MIN);  // 100 samples = 60 BPM

export function bassPower(
  freqDb: Float32Array,
  binHz: number,
  fLo = 20,
  fHi = 200,
): number {
  let p = 0;
  const iLo = Math.max(1, Math.floor(fLo / binHz));
  const iHi = Math.min(freqDb.length - 1, Math.ceil(fHi / binHz));
  for (let i = iLo; i <= iHi; i++) {
    const db = freqDb[i];
    if (db <= -120) continue;
    p += Math.pow(10, db / 10);
  }
  return p;
}

export interface BpmEstimate {
  bpm: number | null;
  confidence: number; // normalized autocorrelation peak in [0, 1]
}

export function estimateBpm(
  buf: Float32Array,
  startIdx: number,
  count: number,
): BpmEstimate {
  if (count < LAG_MAX + 10) {
    return { bpm: null, confidence: 0 };
  }

  // Copy ring buffer into a contiguous Float32Array, oldest first.
  const x = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = buf[(startIdx + i) % buf.length];
  }

  // Subtract mean (autocorrelation of zero-mean signal = covariance).
  let mean = 0;
  for (let i = 0; i < count; i++) mean += x[i];
  mean /= count;
  for (let i = 0; i < count; i++) x[i] -= mean;

  let r0 = 0;
  for (let i = 0; i < count; i++) r0 += x[i] * x[i];
  if (r0 <= 0) return { bpm: null, confidence: 0 };

  // Compute normalized autocorrelation across the BPM lag range.
  const lagCount = LAG_MAX - LAG_MIN + 1;
  const r = new Float32Array(lagCount);
  for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
    let s = 0;
    const limit = count - lag;
    for (let i = 0; i < limit; i++) s += x[i] * x[i + lag];
    r[lag - LAG_MIN] = s / r0;
  }

  // Find local maxima (lag with r > both neighbours).
  let bestLag = -1;
  let bestR = -Infinity;
  for (let i = 1; i < lagCount - 1; i++) {
    const v = r[i];
    if (v > r[i - 1] && v > r[i + 1] && v > bestR) {
      bestR = v;
      bestLag = i + LAG_MIN;
    }
  }
  if (bestLag < 0) return { bpm: null, confidence: 0 };

  // Octave correction: if half-lag has comparable strength, prefer the
  // higher tempo (avoids picking 64 BPM when the song is 128).
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= LAG_MIN) {
    const halfR = r[halfLag - LAG_MIN];
    if (halfR > bestR * 0.85) {
      bestLag = halfLag;
      bestR = halfR;
    }
  }

  // Refine peak with parabolic interpolation over the three points around bestLag.
  const idx = bestLag - LAG_MIN;
  let refinedLag = bestLag;
  if (idx > 0 && idx < lagCount - 1) {
    const a = r[idx - 1];
    const b = r[idx];
    const c = r[idx + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) {
      const delta = (0.5 * (a - c)) / denom;
      if (delta > -1 && delta < 1) refinedLag = bestLag + delta;
    }
  }

  const bpm = (60 * HOP_HZ) / refinedLag;
  if (!Number.isFinite(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
    return { bpm: null, confidence: 0 };
  }
  return { bpm, confidence: Math.max(0, Math.min(1, bestR)) };
}
