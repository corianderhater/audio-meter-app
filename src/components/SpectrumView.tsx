import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { aggregateToBands, buildBands } from "../audio/bands";
import { getAWeightingOffsets } from "../audio/aWeighting";
import {
  bandFromFreq,
  freqAtNormalized,
  ProbePin,
  type ProbeData,
} from "./ProbeTooltip";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  theme: "light" | "dark";
}

// dB SPL range: full span from threshold of hearing (0) to threshold of
// pain (130). Visualisations map values into this range linearly.
const FLOOR_DB = 0;
const TOP_DB = 130;
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

  // Probe state — tap-to-pin tooltip. Lives in CSS-px coords inside the
  // wrapper div. The dB readout updates live every frame via dbRef so the
  // pin's value tracks the audio without re-rendering React.
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const probeDbRef = useRef<HTMLDivElement>(null);
  // Mirror probe.bandIndex into a ref so the rAF closure can read the
  // current value WITHOUT being a dep of the main effect (which would
  // tear down + restart the render loop on every tap).
  const probeBandRef = useRef<number | null>(null);
  useEffect(() => {
    probeBandRef.current = probe ? probe.bandIndex : null;
  }, [probe]);
  const calRef = useRef<number>(calibrationDb);
  calRef.current = calibrationDb;

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

      // Reserve a strip on the left for dB labels and one on the bottom for
      // frequency labels.
      const padLeft = 36 * dpr;
      const padBottom = 16 * dpr;
      const plotW = w - padLeft;
      const plotH = h - padBottom;

      // Horizontal grid lines + dB labels on the left, every 20 dB.
      ctx.strokeStyle = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
      ctx.lineWidth = 1;
      ctx.fillStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)";
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let db = FLOOR_DB; db <= TOP_DB; db += 20) {
        const y = plotH - ((db - FLOOR_DB) / (TOP_DB - FLOOR_DB)) * plotH;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        ctx.fillText(`${db}`, padLeft - 4 * dpr, y);
      }

      const gap = Math.max(1, Math.floor(plotW / BANDS / 6));
      const bw = (plotW - gap * (BANDS - 1)) / BANDS;
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
        const barH = t * plotH;
        const x = padLeft + i * (bw + gap);
        const y = plotH - barH;

        ctx.fillStyle = colorForLevel(t, dark);
        ctx.fillRect(x, y, bw, barH);

        if (Number.isFinite(peakDisplay)) {
          const pt = Math.min(
            1,
            Math.max(0, (peakDisplay - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
          );
          const py = plotH - pt * plotH - 1 * dpr;
          ctx.fillStyle = dark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.9)";
          ctx.fillRect(x, Math.max(0, py), bw, 2 * dpr);
        }
      }

      // frequency labels along the bottom
      ctx.fillStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)";
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "left";
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
        const x = padLeft + tx * plotW;
        ctx.fillText(
          label,
          Math.min(w - 24 * dpr, Math.max(padLeft + 2, x + 2)),
          h - 2,
        );
      }

      // Update probe live SPL readout (if pinned). probeBandRef avoids
      // making the probe a useEffect dep — keeps the loop running across
      // pin/unpin without restart.
      const pb = probeBandRef.current;
      if (pb != null && probeDbRef.current) {
        const v = bandDb[pb] + calRef.current;
        probeDbRef.current.textContent = Number.isFinite(v)
          ? `${v.toFixed(1)} dB SPL`
          : "— dB SPL";
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser, fftSize, layout, weights, calibrationDb, theme]);

  // Tap-to-pin handler. Maps the tap's CSS-pixel x into the canvas's plot
  // area (right of the dB axis labels), looks up the band, sets the probe.
  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = e.currentTarget;
    const rect = wrap.getBoundingClientRect();
    const padLeftCss = 36; // matches `padLeft = 36 * dpr` in canvas px
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < padLeftCss || x > rect.width - 4) {
      setProbe(null);
      return;
    }
    const t = (x - padLeftCss) / (rect.width - padLeftCss);
    const freqHz = freqAtNormalized(t);
    const bandIndex = bandFromFreq(freqHz, layout.edges);
    if (bandIndex < 0) {
      setProbe(null);
      return;
    }
    setProbe({ cssX: x, cssY: y, freqHz, bandIndex });
  };

  return (
    <div className="spectrum probe-host" onPointerDown={handlePointerDown}>
      <canvas className="vis-canvas" ref={canvasRef} />
      {probe && (
        <ProbePin
          data={probe}
          dbRef={probeDbRef}
          onDismiss={() => setProbe(null)}
        />
      )}
    </div>
  );
}
