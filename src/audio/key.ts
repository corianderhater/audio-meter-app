// Musical key detection via chromagram + Krumhansl-Schmuckler key profiles.
// Outputs both standard musical notation and Camelot wheel position
// (the de-facto DJ standard for harmonic mixing).

const PITCH_NAMES = [
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

// Krumhansl-Schmuckler profiles (perception-derived weights for each scale
// degree). Rotated by root pitch class to score every candidate key.
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

// Camelot wheel: index = pitch class (0=C..11=B), value = "<n><A|B>"
// B-side = major keys, A-side = relative minor.
const CAMELOT_MAJOR: Record<number, string> = {
  0: "8B",   // C
  1: "3B",   // C#
  2: "10B",  // D
  3: "5B",   // D#/Eb
  4: "12B",  // E
  5: "7B",   // F
  6: "2B",   // F#
  7: "9B",   // G
  8: "4B",   // G#/Ab
  9: "11B",  // A
  10: "6B",  // A#/Bb
  11: "1B",  // B
};
const CAMELOT_MINOR: Record<number, string> = {
  0: "5A",   // Cm
  1: "12A",  // C#m
  2: "7A",   // Dm
  3: "2A",   // D#m
  4: "9A",   // Em
  5: "4A",   // Fm
  6: "11A",  // F#m
  7: "6A",   // Gm
  8: "1A",   // G#m
  9: "8A",   // Am
  10: "3A",  // A#m/Bbm
  11: "10A", // Bm
};

export interface KeyEstimate {
  pitchClass: number; // 0..11
  mode: "major" | "minor";
  name: string;       // e.g. "C major"
  camelot: string;    // e.g. "8B"
  confidence: number; // 0..1 (best correlation, clamped)
  margin: number;     // gap between best and second-best (0..1+)
}

const KEY_MIN_HZ = 80;
const KEY_MAX_HZ = 5000;

// Build a chromagram (12 pitch classes) from a frame of dBFS frequencies.
// Higher bins still belong to a pitch class, so power simply accumulates.
export function chromaFromFrame(
  freqDb: Float32Array,
  binHz: number,
  out: Float32Array,
): void {
  out.fill(0);
  const iLo = Math.max(1, Math.floor(KEY_MIN_HZ / binHz));
  const iHi = Math.min(freqDb.length - 1, Math.ceil(KEY_MAX_HZ / binHz));
  for (let i = iLo; i <= iHi; i++) {
    const db = freqDb[i];
    if (db <= -90) continue;
    const f = i * binHz;
    // MIDI: 69 + 12 * log2(f / 440); pitchClass = (midi mod 12).
    const midi = 69 + 12 * Math.log2(f / 440);
    let pc = Math.round(midi) % 12;
    if (pc < 0) pc += 12;
    out[pc] += Math.pow(10, db / 10);
  }
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < 12; i++) {
    mA += a[i];
    mB += b[i];
  }
  mA /= 12;
  mB /= 12;
  let num = 0;
  let dA = 0;
  let dB = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - mA;
    const y = b[i] - mB;
    num += x * y;
    dA += x * x;
    dB += y * y;
  }
  const denom = Math.sqrt(dA * dB);
  return denom > 0 ? num / denom : 0;
}

const rotated = new Float32Array(12);

function rotate(profile: number[], root: number): Float32Array {
  for (let i = 0; i < 12; i++) {
    rotated[i] = profile[(i - root + 12) % 12];
  }
  return rotated;
}

export function estimateKey(chroma: Float32Array): KeyEstimate | null {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (total <= 0) return null;

  let bestR = -Infinity;
  let secondR = -Infinity;
  let bestPc = 0;
  let bestMode: "major" | "minor" = "major";

  for (let root = 0; root < 12; root++) {
    const rMaj = pearson(chroma, rotate(MAJOR_PROFILE, root));
    if (rMaj > bestR) {
      secondR = bestR;
      bestR = rMaj;
      bestPc = root;
      bestMode = "major";
    } else if (rMaj > secondR) {
      secondR = rMaj;
    }
    const rMin = pearson(chroma, rotate(MINOR_PROFILE, root));
    if (rMin > bestR) {
      secondR = bestR;
      bestR = rMin;
      bestPc = root;
      bestMode = "minor";
    } else if (rMin > secondR) {
      secondR = rMin;
    }
  }

  const camelot =
    bestMode === "major" ? CAMELOT_MAJOR[bestPc] : CAMELOT_MINOR[bestPc];
  const name = `${PITCH_NAMES[bestPc]}${bestMode === "minor" ? " minor" : " major"}`;
  return {
    pitchClass: bestPc,
    mode: bestMode,
    name,
    camelot,
    confidence: Math.max(0, bestR),
    margin: bestR - Math.max(0, secondR),
  };
}
