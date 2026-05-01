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

const FLOOR_DB = 0;
const TOP_DB = 130;
const ROWS = 240; // history length in pixel-rows
const BANDS = 160;

// Greyscale palettes for both themes — quiet = background, loud = ink.
const STOPS_LIGHT: Array<[number, [number, number, number]]> = [
  [0.0, [255, 255, 255]],
  [0.5, [160, 160, 160]],
  [1.0, [0, 0, 0]],
];
const STOPS_DARK: Array<[number, [number, number, number]]> = [
  [0.0, [0, 0, 0]],
  [0.5, [110, 110, 110]],
  [1.0, [255, 255, 255]],
];

function paletteRgb(
  t: number,
  stops: Array<[number, [number, number, number]]>,
  out: [number, number, number],
) {
  if (t <= 0) {
    out[0] = stops[0][1][0];
    out[1] = stops[0][1][1];
    out[2] = stops[0][1][2];
    return;
  }
  if (t >= 1) {
    const last = stops[stops.length - 1][1];
    out[0] = last[0];
    out[1] = last[1];
    out[2] = last[2];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      out[0] = Math.round(c0[0] + (c1[0] - c0[0]) * k);
      out[1] = Math.round(c0[1] + (c1[1] - c0[1]) * k);
      out[2] = Math.round(c0[2] + (c1[2] - c0[2]) * k);
      return;
    }
  }
}

export function Spectrogram({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  theme,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const calRef = useRef(calibrationDb);
  calRef.current = calibrationDb;

  // Probe — same pattern as SpectrumView. SPL is "current at this freq",
  // not the historical value of the touched pixel-row, since we don't keep
  // the raw band values in a separate history buffer here.
  const [probe, setProbe] = useState<ProbeData | null>(null);
  const probeDbRef = useRef<HTMLDivElement>(null);
  // Ref-mirrored band index so the rAF tick can read it without restart.
  const probeBandRef = useRef<number | null>(null);
  useEffect(() => {
    probeBandRef.current = probe ? probe.bandIndex : null;
  }, [probe]);

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

    // Fixed-resolution offscreen image: BANDS columns × ROWS rows.
    const off = document.createElement("canvas");
    off.width = BANDS;
    off.height = ROWS;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    const dark = theme === "dark";
    const stops = dark ? STOPS_DARK : STOPS_LIGHT;
    offCtx.fillStyle = dark ? "#000" : "#fff";
    offCtx.fillRect(0, 0, BANDS, ROWS);

    const rowImage = offCtx.createImageData(BANDS, 1);
    const freq = new Float32Array(fftSize / 2);
    const bandDb = new Float32Array(BANDS);
    const rgb: [number, number, number] = [0, 0, 0];

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = () => {
      analyser.getFloatFrequencyData(freq);
      aggregateToBands(freq, weights, layout, bandDb);

      // Build new row pixels
      for (let i = 0; i < BANDS; i++) {
        const v = bandDb[i] + calRef.current;
        const t = Math.min(
          1,
          Math.max(0, (v - FLOOR_DB) / (TOP_DB - FLOOR_DB)),
        );
        paletteRgb(t, stops, rgb);
        const o = i * 4;
        rowImage.data[o] = rgb[0];
        rowImage.data[o + 1] = rgb[1];
        rowImage.data[o + 2] = rgb[2];
        rowImage.data[o + 3] = 255;
      }

      // Scroll offscreen down by 1 row, write new row at top
      offCtx.drawImage(off, 0, 0, BANDS, ROWS - 1, 0, 1, BANDS, ROWS - 1);
      offCtx.putImageData(rowImage, 0, 0);

      // Reserve a strip on the left for the dB→colour legend.
      const padLeft = 36 * dpr;
      const w = canvas.width;
      const h = canvas.height;
      const plotW = w - padLeft;

      // Stretch the spectrogram onto the plot area (right of the legend).
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, padLeft, 0, plotW, h);

      // dB legend: vertical greyscale strip with labels every 20 dB.
      const legendW = 10 * dpr;
      const legendX = padLeft - legendW - 4 * dpr;
      // Top of strip = TOP_DB, bottom = FLOOR_DB.
      const legendImg = ctx.createImageData(1, Math.max(1, Math.floor(h)));
      for (let yi = 0; yi < legendImg.height; yi++) {
        const t = 1 - yi / Math.max(1, legendImg.height - 1);
        paletteRgb(t, stops, rgb);
        const o = yi * 4;
        legendImg.data[o] = rgb[0];
        legendImg.data[o + 1] = rgb[1];
        legendImg.data[o + 2] = rgb[2];
        legendImg.data[o + 3] = 255;
      }
      // Stamp the 1-pixel-wide gradient and stretch it horizontally.
      const legendOff = document.createElement("canvas");
      legendOff.width = 1;
      legendOff.height = legendImg.height;
      const legendCtx = legendOff.getContext("2d");
      if (legendCtx) {
        legendCtx.putImageData(legendImg, 0, 0);
        ctx.drawImage(legendOff, legendX, 0, legendW, h);
      }

      // dB labels along the legend.
      ctx.fillStyle = dark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.7)";
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (let db = FLOOR_DB; db <= TOP_DB; db += 20) {
        const y = h - ((db - FLOOR_DB) / (TOP_DB - FLOOR_DB)) * h;
        ctx.fillText(`${db}`, legendX - 2 * dpr, y);
      }

      // Frequency labels along the top of the plot area.
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
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
        ctx.fillText(label, Math.min(w - 28 * dpr, Math.max(padLeft + 2, x + 2)), 2);
      }

      // Probe SPL update via ref (not a dep — pinning shouldn't restart
      // the render loop, which would scroll history away).
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
  }, [analyser, fftSize, layout, weights, theme]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const wrap = e.currentTarget;
    const rect = wrap.getBoundingClientRect();
    const padLeftCss = 36;
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
    <div className="spectrogram probe-host" onPointerDown={handlePointerDown}>
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
