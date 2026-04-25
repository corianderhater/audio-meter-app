import { useEffect, useState } from "react";
import { detectPitch, type PitchEstimate } from "../audio/pitch";

const ANALYSIS_INTERVAL_MS = 60;     // ~16 Hz updates
const ANALYSIS_LEN = 4096;           // covers down to ~12 Hz at 48k, plenty for low B
const CLARITY_GATE = 0.6;            // below this, treat as no-pitch
const HOLD_MS = 700;                 // keep last estimate visible after signal drops

export function usePitch(
  analyser: AnalyserNode | null,
  sampleRate: number,
): PitchEstimate | null {
  const [state, setState] = useState<PitchEstimate | null>(null);

  useEffect(() => {
    if (!analyser) {
      setState(null);
      return;
    }

    const sourceLen = analyser.fftSize;
    const time = new Float32Array(sourceLen);
    const window = new Float32Array(Math.min(ANALYSIS_LEN, sourceLen));

    let raf = 0;
    let lastRun = 0;
    let lastGoodAt = 0;

    const tick = (now: number) => {
      if (now - lastRun >= ANALYSIS_INTERVAL_MS) {
        lastRun = now;
        analyser.getFloatTimeDomainData(time);
        // Take the most recent samples (end of buffer) for lowest latency.
        for (let i = 0; i < window.length; i++) {
          window[i] = time[sourceLen - window.length + i];
        }
        const est = detectPitch(window, sampleRate);
        if (est && est.clarity >= CLARITY_GATE) {
          lastGoodAt = now;
          setState(est);
        } else if (now - lastGoodAt > HOLD_MS) {
          setState(null);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, sampleRate]);

  return state;
}
