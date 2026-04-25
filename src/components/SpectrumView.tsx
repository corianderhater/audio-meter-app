import { useEffect, useMemo, useRef } from "react";
import { aggregateToBands, buildBands } from "../audio/bands";
import { getAWeightingOffsets } from "../audio/aWeighting";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  peakResetToken: number;
  theme: "light" | "dark";
}

const FLOOR_DB = -90;
const TOP_DB = 10;
const PEAK_HOLD_MS = 1500;
const PEAK_DECAY_DB_PER_SEC = 12;
const BANDS = 80;

function colorForLevel(t: number, dark: boolean): string {
  // In light mode: light grey → black. In dark mode: dark grey → white.
  const v = dark ? Math.round(35 + t * 220) : Math.round(220 - t * 220);
  return `rgb(${v}, ${v}, ${v})`;
}

export function SpectrumView({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  peakResetToken,
  theme,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const layout = useMemo(
    () => buildBands(sampleRate, fftSize, BANDS),
    [sampleRate, fftSize],
  );
  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  const peaksRef = useRef<{ db: Float32Array; holdUntil: Float64Array } | null>(
    null,
  );

  useEffect(() => {
    if (!peaksRef.current) return;
    peaksRef.current.db.fill(-Infinity);
    peaksRef.current.holdUntil.fill(0);
  }, [peakResetToken]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const freq = new Float32Array(fftSize / 2);
    const bandDb = new Float32Array(BANDS);
    if (
      !peaksRef.current ||
      peaksRef.current.db.length !== BANDS
    ) {
      peaksRef.current = {
        db: new Float32Array(BANDS).fill(-Infinity),
        holdUntil: new Float64Array(BANDS),
      };
    }
    const peaks = peaksRef.current;

    let raf = 0;
    let last = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = (now: number) => {
      const dtSec = Math.min(0.1, (now - last) / 1000);
      last = now;

      analyser.getFloatFrequencyData(freq);
      aggregateToBands(freq, weights, layout, bandDb);

      const dark = theme === "dark";
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = dark ? "#000000" : "#ffffff";
      ctx.fillRect(0, 0, w, h);

      // grid lines (every 10 dB, plus marker frequencies)
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
      ctx.lineWidth = 1;
      for (let db = TOP_DB; db >= FLOOR_DB; db -= 10) {
        const y = ((TOP_DB - db) / (TOP_DB - FLOOR_DB)) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const gap = Math.max(1, Math.floor(w / BANDS / 6));
      const bw = (w - gap * (BANDS - 1)) / BANDS;
      const decayDb = PEAK_DECAY_DB_PER_SEC * dtSec;

      for (let i = 0; i < BANDS; i++) {
        const raw = bandDb[i];
        const cur = raw + calibrationDb;

        if (raw > peaks.db[i]) {
          peaks.db[i] = raw;
          peaks.holdUntil[i] = now + PEAK_HOLD_MS;
        } else if (now > peaks.holdUntil[i]) {
          peaks.db[i] = Math.max(-Infinity, peaks.db[i] - decayDb);
        }
        const peakDisplay = peaks.db[i] + calibrationDb;

        const t = Math.min(
          1,
          Math.max(0, (cur - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
        );
        const barH = t * h;
        const x = i * (bw + gap);
        const y = h - barH;

        ctx.fillStyle = colorForLevel(t, dark);
        ctx.fillRect(x, y, bw, barH);

        if (Number.isFinite(peakDisplay)) {
          const pt = Math.min(
            1,
            Math.max(0, (peakDisplay - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
          );
          const py = h - pt * h - 1 * dpr;
          ctx.fillStyle = dark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.9)";
          ctx.fillRect(x, Math.max(0, py), bw, 2 * dpr);
        }
      }

      // frequency labels
      ctx.fillStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)";
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      const marks: Array<[number, string]> = [
        [20, "20"],
        [100, "100"],
        [1000, "1k"],
        [10000, "10k"],
        [20000, "20k"],
      ];
      const logMin = Math.log10(20);
      const logMax = Math.log10(20000);
      for (const [f, label] of marks) {
        const tx = (Math.log10(f) - logMin) / (logMax - logMin);
        const x = tx * w;
        ctx.fillText(label, Math.min(w - 20 * dpr, Math.max(2, x + 2)), h - 2);
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser, fftSize, layout, weights, calibrationDb, theme]);

  return <canvas className="spectrum" ref={canvasRef} />;
}
