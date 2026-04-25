import { useEffect, useState } from "react";
import { chromaFromFrame, estimateKey, type KeyEstimate } from "../audio/key";

const SAMPLE_INTERVAL_MS = 100;     // sample chroma at 10 Hz
const WINDOW_SEC = 4;
const WINDOW_FRAMES = (WINDOW_SEC * 1000) / SAMPLE_INTERVAL_MS;
const ESTIMATE_INTERVAL_MS = 1000;

export function useKey(
  analyser: AnalyserNode | null,
  sampleRate: number,
  fftSize: number,
): KeyEstimate | null {
  const [state, setState] = useState<KeyEstimate | null>(null);

  useEffect(() => {
    if (!analyser) {
      setState(null);
      return;
    }

    const freq = new Float32Array(fftSize / 2);
    const frame = new Float32Array(12);
    // Ring buffer of recent chroma frames; we sum them for the estimate.
    const ring: Float32Array[] = Array.from(
      { length: WINDOW_FRAMES },
      () => new Float32Array(12),
    );
    let writeIdx = 0;
    let filled = 0;
    const sum = new Float32Array(12);
    const binHz = sampleRate / fftSize;

    let raf = 0;
    let acc = 0;
    let lastTs = performance.now();
    let lastEstimate = lastTs;

    const tick = (now: number) => {
      acc += now - lastTs;
      lastTs = now;

      while (acc >= SAMPLE_INTERVAL_MS) {
        acc -= SAMPLE_INTERVAL_MS;
        analyser.getFloatFrequencyData(freq);
        chromaFromFrame(freq, binHz, frame);

        // Subtract outgoing, add incoming.
        const slot = ring[writeIdx];
        if (filled === WINDOW_FRAMES) {
          for (let i = 0; i < 12; i++) sum[i] -= slot[i];
        } else {
          filled++;
        }
        for (let i = 0; i < 12; i++) {
          slot[i] = frame[i];
          sum[i] += frame[i];
        }
        writeIdx = (writeIdx + 1) % WINDOW_FRAMES;
      }

      if (now - lastEstimate >= ESTIMATE_INTERVAL_MS && filled > WINDOW_FRAMES / 2) {
        lastEstimate = now;
        const est = estimateKey(sum);
        if (est) setState(est);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, sampleRate, fftSize]);

  return state;
}
