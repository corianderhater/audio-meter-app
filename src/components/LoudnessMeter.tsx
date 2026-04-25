import { useEffect, useMemo, useRef } from "react";
import { getAWeightingOffsets } from "../audio/aWeighting";
import { aWeightedOverallDb } from "../audio/loudness";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
}

export function LoudnessMeter({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
}: Props) {
  const numRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const calRef = useRef<number>(calibrationDb);
  calRef.current = calibrationDb;

  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  useEffect(() => {
    const freq = new Float32Array(fftSize / 2);
    let raf = 0;
    let lastDom = 0;
    let peakRaw = -Infinity;
    let peakHoldUntil = 0;

    const tick = (now: number) => {
      analyser.getFloatFrequencyData(freq);
      const raw = aWeightedOverallDb(freq, weights);

      if (raw > peakRaw) {
        peakRaw = raw;
        peakHoldUntil = now + 2000;
      } else if (now > peakHoldUntil) {
        peakRaw = Math.max(-Infinity, peakRaw - 0.2);
      }

      // Update DOM at ~20 fps to avoid flicker
      if (now - lastDom > 50) {
        lastDom = now;
        const cur = raw + calRef.current;
        const peak = peakRaw + calRef.current;
        if (numRef.current) {
          numRef.current.textContent = Number.isFinite(cur)
            ? cur.toFixed(1)
            : "—";
        }
        if (peakRef.current) {
          peakRef.current.textContent = Number.isFinite(peak)
            ? `peak ${peak.toFixed(1)}`
            : "peak —";
        }
        if (barRef.current) {
          // Map -60..+10 to 0..1 for the bar
          const t = Math.min(1, Math.max(0, (cur + 60) / 70));
          barRef.current.style.width = `${(t * 100).toFixed(1)}%`;
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, fftSize, weights]);

  const uncalibrated = calibrationDb === 0;

  return (
    <div className="loudness">
      <div className="loudness-readout">
        <span className="loudness-num" ref={numRef}>—</span>
        <span className="loudness-unit">dB{uncalibrated ? "FS" : " SPL"} (A)</span>
        <span className="loudness-peak" ref={peakRef}>peak —</span>
      </div>
      <div className="loudness-bar">
        <div className="loudness-bar-fill" ref={barRef} />
      </div>
      {uncalibrated && (
        <div className="badge-uncal" title="Set a calibration offset to map this reading to real-world dB SPL.">
          UNCALIBRATED
        </div>
      )}
    </div>
  );
}
