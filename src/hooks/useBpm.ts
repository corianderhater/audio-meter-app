import { useEffect, useState } from "react";
import {
  HOP_HZ,
  WINDOW_LEN,
  bassPower,
  estimateBpm,
  type BpmEstimate,
} from "../audio/bpm";

const HOP_MS = 1000 / HOP_HZ;
const ESTIMATE_INTERVAL_MS = 750;
const MEDIAN_LEN = 5;

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function useBpm(
  analyser: AnalyserNode | null,
  sampleRate: number,
  fftSize: number,
): BpmEstimate {
  const [state, setState] = useState<BpmEstimate>({ bpm: null, confidence: 0 });

  useEffect(() => {
    if (!analyser) {
      setState({ bpm: null, confidence: 0 });
      return;
    }

    const freq = new Float32Array(fftSize / 2);
    const ring = new Float32Array(WINDOW_LEN);
    let writeIdx = 0;
    let filled = 0;
    let prev = 0;
    let acc = 0;
    let lastTs = performance.now();
    let lastEstimate = lastTs;
    const history: number[] = [];

    const binHz = sampleRate / fftSize;

    let raf = 0;
    const tick = (now: number) => {
      acc += now - lastTs;
      lastTs = now;

      // Decimate to a fixed 100 Hz hop. rAF runs faster on most devices, so we
      // pull multiple samples per frame; on a slow device we may skip one.
      while (acc >= HOP_MS) {
        acc -= HOP_MS;
        analyser.getFloatFrequencyData(freq);
        const power = bassPower(freq, binHz);
        // Half-wave rectified flux: positive change in bass energy → onset.
        const flux = Math.max(0, power - prev);
        prev = power;
        ring[writeIdx] = flux;
        writeIdx = (writeIdx + 1) % WINDOW_LEN;
        if (filled < WINDOW_LEN) filled++;
      }

      if (now - lastEstimate >= ESTIMATE_INTERVAL_MS) {
        lastEstimate = now;
        const startIdx = filled < WINDOW_LEN ? 0 : writeIdx;
        const est = estimateBpm(ring, startIdx, filled);
        if (est.bpm != null) {
          history.push(est.bpm);
          if (history.length > MEDIAN_LEN) history.shift();
          setState({ bpm: median(history), confidence: est.confidence });
        } else {
          // Keep last value but decay confidence so the UI can grey it out.
          setState((s) => ({ bpm: s.bpm, confidence: s.confidence * 0.7 }));
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [analyser, sampleRate, fftSize]);

  return state;
}
