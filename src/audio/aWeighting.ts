// IEC 61672-1 A-weighting curve, expressed as per-bin dB offsets.
// Memoized by (sampleRate, fftSize).

const cache = new Map<string, Float32Array>();

function aWeightDb(f: number): number {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const num = 12194 * 12194 * f2 * f2;
  const den =
    (f2 + 20.6 * 20.6) *
    Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) *
    (f2 + 12194 * 12194);
  const ra = num / den;
  return 20 * Math.log10(ra) + 2.0;
}

export function getAWeightingOffsets(
  sampleRate: number,
  fftSize: number,
): Float32Array {
  const key = `${sampleRate}|${fftSize}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const bins = fftSize / 2;
  const offsets = new Float32Array(bins);
  const binHz = sampleRate / fftSize;
  for (let i = 0; i < bins; i++) {
    const f = i * binHz;
    offsets[i] = i === 0 ? -120 : aWeightDb(f);
  }
  cache.set(key, offsets);
  return offsets;
}
