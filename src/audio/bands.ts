// Logarithmically spaced visual bands across 20 Hz – 20 kHz, plus a mapping
// from FFT bin index to band index. We use *max* aggregation across bins
// inside a band to preserve peak character that pros expect on an analyzer.

export const F_MIN = 20;
export const F_MAX = 20000;

export interface BandLayout {
  count: number;
  centers: Float32Array;
  edges: Float32Array;     // length = count + 1
  binToBand: Int16Array;   // length = fftSize/2; -1 if out of range
}

export function buildBands(
  sampleRate: number,
  fftSize: number,
  count = 80,
): BandLayout {
  const edges = new Float32Array(count + 1);
  const centers = new Float32Array(count);
  const logMin = Math.log10(F_MIN);
  const logMax = Math.log10(F_MAX);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    edges[i] = Math.pow(10, logMin + (logMax - logMin) * t);
  }
  for (let i = 0; i < count; i++) {
    centers[i] = Math.sqrt(edges[i] * edges[i + 1]);
  }

  const bins = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const binToBand = new Int16Array(bins);
  for (let i = 0; i < bins; i++) {
    const f = i * binHz;
    if (f < edges[0] || f > edges[count]) {
      binToBand[i] = -1;
      continue;
    }
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f >= edges[mid + 1]) lo = mid + 1;
      else hi = mid;
    }
    binToBand[i] = lo;
  }

  return { count, centers, edges, binToBand };
}

export function aggregateToBands(
  freqDb: Float32Array,
  weightDbOffsets: Float32Array,
  layout: BandLayout,
  out: Float32Array,
): void {
  out.fill(-Infinity);
  const bins = freqDb.length;
  const map = layout.binToBand;
  for (let i = 0; i < bins; i++) {
    const b = map[i];
    if (b < 0) continue;
    const v = freqDb[i] + weightDbOffsets[i];
    if (v > out[b]) out[b] = v;
  }
}
