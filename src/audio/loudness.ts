// Compute overall A-weighted level (dBFS, before calibration offset) from a
// frame of dBFS bin magnitudes. Sums power across A-weighted bins and
// converts back to dB.

export function aWeightedOverallDb(
  freqDb: Float32Array,
  weightDbOffsets: Float32Array,
): number {
  let powerSum = 0;
  const n = freqDb.length;
  for (let i = 1; i < n; i++) {
    const db = freqDb[i] + weightDbOffsets[i];
    if (db <= -120) continue;
    powerSum += Math.pow(10, db / 10);
  }
  if (powerSum <= 0) return -Infinity;
  return 10 * Math.log10(powerSum);
}
