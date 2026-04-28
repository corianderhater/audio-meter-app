import { useEffect, useMemo, useRef } from "react";
import { aggregateToBands, buildBands } from "../audio/bands";
import { getAWeightingOffsets } from "../audio/aWeighting";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  theme: "light" | "dark";
}

const FLOOR_DB = 0;
const TOP_DB = 130;
const BANDS = 96;
const ROWS = 128;           // history depth — denser stack
const SAMPLE_HZ = 30;       // new history row every ~33 ms (~4.3 s of history)

// "Unknown Pleasures" stacked ridge plot. Each row is one historical
// frame; the area between curve and baseline is filled with the background
// colour, then the curve is stroked on top. Drawing order is oldest-first
// (top of canvas) to newest-last (bottom), so newer rows' fills occlude the
// lower portions of older rows behind them — but tall peaks of older rows
// still rise above and stay visible. That's the 3D illusion.
export function Waterfall3D({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  theme,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const calRef = useRef(calibrationDb);
  calRef.current = calibrationDb;

  const layout = useMemo(
    () => buildBands(sampleRate, fftSize, BANDS),
    [sampleRate, fftSize],
  );
  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dark = theme === "dark";
    const bg = dark ? "#000000" : "#ffffff";
    const ink = dark ? "#ffffff" : "#000000";

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Ring buffer of historical frames.
    const history: Float32Array[] = Array.from(
      { length: ROWS },
      () => new Float32Array(BANDS).fill(-Infinity),
    );
    let writeIdx = 0;

    const freq = new Float32Array(fftSize / 2);
    const bandDb = new Float32Array(BANDS);

    const sampleIntervalMs = 1000 / SAMPLE_HZ;
    let acc = 0;
    let last = performance.now();

    // Per-row point buffers — allocated once, reused every row every frame.
    const pX = new Float32Array(BANDS);
    const pY = new Float32Array(BANDS);

    let raf = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;

      // Sample the analyser at a fixed rate, regardless of rAF jitter.
      while (acc >= sampleIntervalMs) {
        acc -= sampleIntervalMs;
        analyser.getFloatFrequencyData(freq);
        aggregateToBands(freq, weights, layout, bandDb);
        history[writeIdx].set(bandDb);
        writeIdx = (writeIdx + 1) % ROWS;
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Layout: baselines span from the very top edge (oldest) to just
      // above the labels (newest). Peaks can extend up to ~8 row spacings
      // above their own baseline — tall amplitudes, heavy occlusion. Top
      // row's tallest peaks may clip the canvas edge.
      const padTop = 2 * dpr;
      const padBottom = 24 * dpr;
      const padX = 12 * dpr;
      const usableW = w - padX * 2;
      const usableH = h - padTop - padBottom;
      const dy = usableH / Math.max(1, ROWS - 1);
      const maxRowH = dy * 48;
      const cal = calRef.current;

      // On narrow viewports (mobile), scale the stroke down to 0.3× so the
      // dense stack of ridges doesn't blob into a solid mass.
      const mobile =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 640px)").matches;
      ctx.lineWidth = (mobile ? 1.5 * 0.3 : 1.5) * dpr;
      ctx.lineJoin = "round";
      ctx.strokeStyle = ink;
      ctx.fillStyle = bg;

      // Trace a smooth curve through the precomputed points using
      // midpoint-based quadratic Beziers. Each interior point becomes a
      // control point; the curve passes through the midpoints between
      // consecutive points. Endpoints get a straight lineTo.
      const traceSmoothed = () => {
        ctx.moveTo(pX[0], pY[0]);
        for (let i = 1; i < BANDS - 1; i++) {
          const mx = (pX[i] + pX[i + 1]) * 0.5;
          const my = (pY[i] + pY[i + 1]) * 0.5;
          ctx.quadraticCurveTo(pX[i], pY[i], mx, my);
        }
        ctx.lineTo(pX[BANDS - 1], pY[BANDS - 1]);
      };

      // Iterate r=0 (oldest, top) to r=ROWS-1 (newest, bottom).
      //   1) closed polygon (smooth curve + sides + baseline) → fill with
      //      bg so newer rows occlude the lower portions of older rows.
      //   2) smooth curve path → stroke with ink.
      for (let r = 0; r < ROWS; r++) {
        const age = ROWS - 1 - r;
        const rowIdx = (writeIdx - 1 - age + ROWS * 2) % ROWS;
        const row = history[rowIdx];
        const baseY = padTop + r * dy;

        // Compute curve points once, reuse for fill + stroke.
        for (let j = 0; j < BANDS; j++) {
          const v = row[j] + cal;
          const t = Math.min(
            1,
            Math.max(0, (v - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
          );
          pX[j] = padX + (j / (BANDS - 1)) * usableW;
          pY[j] = baseY - t * maxRowH;
        }

        // Pass 1: filled polygon
        ctx.beginPath();
        traceSmoothed();
        ctx.lineTo(padX + usableW, baseY);
        ctx.lineTo(padX, baseY);
        ctx.closePath();
        ctx.fill();

        // Pass 2: stroked curve only
        ctx.beginPath();
        traceSmoothed();
        ctx.stroke();
      }

      // Frequency labels along the bottom.
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
        const x = padX + tx * usableW;
        ctx.fillText(
          label,
          Math.min(padX + usableW - 20 * dpr, Math.max(padX + 2, x + 2)),
          h - 6 * dpr,
        );
      }

      // Per-row amplitude scale: each row's curve climbs from baseline (0 dB)
      // up to maxRowH at TOP_DB SPL. Annotate at the top-left and bottom-left
      // so the user knows what amplitude any one ridge represents.
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(`${TOP_DB} dB SPL`, 6 * dpr, 4 * dpr);
      ctx.textBaseline = "bottom";
      ctx.fillText(`${FLOOR_DB} dB SPL`, 6 * dpr, h - 18 * dpr);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser, fftSize, layout, weights, theme]);

  return <canvas className="spectrum" ref={canvasRef} />;
}
