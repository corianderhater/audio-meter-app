import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  createPinkNoiseBuffer,
  createWhiteNoiseBuffer,
} from "../audio/noise";
import { formatFreq } from "./ProbeTooltip";

const STORAGE_KEY = "audioMeter.noiseGen";
const NOISE_LOOP_SEC = 2;
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const LOG_MIN = Math.log10(FREQ_MIN);
const LOG_MAX = Math.log10(FREQ_MAX);
const DB_MIN = -40;
const DB_MAX = 6;
const RESPONSE_POINTS = 240;

type NoiseType = "white" | "pink";

interface PersistedState {
  noiseType: NoiseType;
  hpFreq: number;
  lpFreq: number;
  gain: number;
}

function defaultState(): PersistedState {
  return {
    noiseType: "pink",
    hpFreq: FREQ_MIN,
    lpFreq: FREQ_MAX,
    gain: 0.5,
  };
}

function loadState(): PersistedState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return defaultState();
    const p = JSON.parse(v);
    return {
      noiseType: p?.noiseType === "white" ? "white" : "pink",
      hpFreq: clampFreq(p?.hpFreq ?? FREQ_MIN),
      lpFreq: clampFreq(p?.lpFreq ?? FREQ_MAX),
      gain:
        typeof p?.gain === "number" && Number.isFinite(p.gain)
          ? Math.min(1, Math.max(0, p.gain))
          : 0.5,
    };
  } catch {
    return defaultState();
  }
}

function clampFreq(f: number): number {
  if (!Number.isFinite(f)) return FREQ_MIN;
  return Math.min(FREQ_MAX, Math.max(FREQ_MIN, f));
}

const xToFreq = (x: number, w: number): number => {
  const t = Math.min(1, Math.max(0, x / w));
  return Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
};
const freqToX = (f: number, w: number): number => {
  const t = (Math.log10(clampFreq(f)) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.min(w, Math.max(0, t * w));
};

// Noise generator: white or pink source piped through high-pass + low-pass
// biquad filters. Cutoffs are dragged on a live filter-response curve.
// Audio graph: source → highpass → lowpass → masterGain → compressor → out.
export function NoiseGenerator() {
  const initial = loadState();
  const [noiseType, setNoiseType] = useState<NoiseType>(initial.noiseType);
  const [hpFreq, setHpFreq] = useState<number>(initial.hpFreq);
  const [lpFreq, setLpFreq] = useState<number>(initial.lpFreq);
  const [gain, setGain] = useState<number>(initial.gain);
  const [playing, setPlaying] = useState(false);

  type AudioBundle = {
    ctx: AudioContext;
    source: AudioBufferSourceNode;
    hp: BiquadFilterNode;
    lp: BiquadFilterNode;
    master: GainNode;
    compressor: DynamicsCompressorNode;
    whiteBuffer: AudioBuffer;
    pinkBuffer: AudioBuffer;
    type: NoiseType;
  };
  const audioRef = useRef<AudioBundle | null>(null);

  // Persist state.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ noiseType, hpFreq, lpFreq, gain }),
      );
    } catch {
      // ignore
    }
  }, [noiseType, hpFreq, lpFreq, gain]);

  // Live-update audio params when state changes.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;
    a.hp.frequency.cancelScheduledValues(t);
    a.hp.frequency.setValueAtTime(a.hp.frequency.value, t);
    a.hp.frequency.linearRampToValueAtTime(hpFreq, t + 0.02);
  }, [hpFreq]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;
    a.lp.frequency.cancelScheduledValues(t);
    a.lp.frequency.setValueAtTime(a.lp.frequency.value, t);
    a.lp.frequency.linearRampToValueAtTime(lpFreq, t + 0.02);
  }, [lpFreq]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;
    a.master.gain.cancelScheduledValues(t);
    a.master.gain.setValueAtTime(a.master.gain.value, t);
    a.master.gain.linearRampToValueAtTime(gain, t + 0.05);
  }, [gain]);

  // Swap source on noise-type change while running.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.type === noiseType) return;
    try {
      a.source.disconnect();
    } catch {
      // ignore
    }
    try {
      a.source.stop();
    } catch {
      // ignore
    }
    const newSrc = a.ctx.createBufferSource();
    newSrc.buffer = noiseType === "white" ? a.whiteBuffer : a.pinkBuffer;
    newSrc.loop = true;
    newSrc.connect(a.hp);
    newSrc.start();
    a.source = newSrc;
    a.type = noiseType;
  }, [noiseType]);

  // Component unmount: tear everything down.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (!a) return;
      try {
        a.source.stop();
      } catch {
        // ignore
      }
      a.ctx.close().catch(() => undefined);
      audioRef.current = null;
    };
  }, []);

  const handlePlayPause = async () => {
    if (playing) {
      const a = audioRef.current;
      if (a) {
        const t = a.ctx.currentTime;
        a.master.gain.cancelScheduledValues(t);
        a.master.gain.setValueAtTime(a.master.gain.value, t);
        a.master.gain.linearRampToValueAtTime(0, t + 0.05);
        const ctxToClose = a.ctx;
        const src = a.source;
        window.setTimeout(() => {
          try {
            src.stop();
          } catch {
            // ignore
          }
          ctxToClose.close().catch(() => undefined);
        }, 80);
        audioRef.current = null;
      }
      setPlaying(false);
      return;
    }

    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const whiteBuffer = createWhiteNoiseBuffer(ctx, NOISE_LOOP_SEC);
      const pinkBuffer = createPinkNoiseBuffer(ctx, NOISE_LOOP_SEC);

      const source = ctx.createBufferSource();
      source.buffer = noiseType === "white" ? whiteBuffer : pinkBuffer;
      source.loop = true;

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.Q.setValueAtTime(0.707, ctx.currentTime);
      hp.frequency.setValueAtTime(hpFreq, ctx.currentTime);

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.setValueAtTime(0.707, ctx.currentTime);
      lp.frequency.setValueAtTime(lpFreq, ctx.currentTime);

      const master = ctx.createGain();
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.05);

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-24, ctx.currentTime);
      compressor.knee.setValueAtTime(30, ctx.currentTime);
      compressor.ratio.setValueAtTime(12, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);

      source.connect(hp).connect(lp).connect(master).connect(compressor)
        .connect(ctx.destination);
      source.start();

      audioRef.current = {
        ctx,
        source,
        hp,
        lp,
        master,
        compressor,
        whiteBuffer,
        pinkBuffer,
        type: noiseType,
      };
      setPlaying(true);
    } catch (err) {
      console.error("[noise] audio setup failed:", err);
    }
  };

  // ─── interactive filter canvas ──────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    handle: "hp" | "lp";
    pointerId: number;
  } | null>(null);

  // Offline filters used to compute the response when the audio graph
  // isn't running yet — getFrequencyResponse works on any biquad.
  type F32 = Float32Array<ArrayBuffer>;
  const offlineRef = useRef<{
    ctx: OfflineAudioContext;
    hp: BiquadFilterNode;
    lp: BiquadFilterNode;
    freqs: F32;
    hpMag: F32;
    lpMag: F32;
    phase: F32;
  } | null>(null);

  if (!offlineRef.current) {
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 0.707;
    const freqs = new Float32Array(new ArrayBuffer(RESPONSE_POINTS * 4)) as F32;
    for (let i = 0; i < RESPONSE_POINTS; i++) {
      const t = i / (RESPONSE_POINTS - 1);
      freqs[i] = Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
    }
    offlineRef.current = {
      ctx,
      hp,
      lp,
      freqs,
      hpMag: new Float32Array(new ArrayBuffer(RESPONSE_POINTS * 4)) as F32,
      lpMag: new Float32Array(new ArrayBuffer(RESPONSE_POINTS * 4)) as F32,
      phase: new Float32Array(new ArrayBuffer(RESPONSE_POINTS * 4)) as F32,
    };
  }

  // Redraw the filter response on every state change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      draw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const off = offlineRef.current!;
      off.hp.frequency.value = hpFreq;
      off.lp.frequency.value = lpFreq;
      off.hp.getFrequencyResponse(off.freqs, off.hpMag, off.phase);
      off.lp.getFrequencyResponse(off.freqs, off.lpMag, off.phase);

      const w = canvas.width;
      const h = canvas.height;
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--bg").trim() || "#fff";
      const ink = cs.getPropertyValue("--ink").trim() || "#000";
      const inkFaint =
        cs.getPropertyValue("--ink-faint").trim() || "rgba(0,0,0,0.2)";

      ctx2d.fillStyle = bg;
      ctx2d.fillRect(0, 0, w, h);

      // Vertical grid at decade frequencies.
      ctx2d.strokeStyle = inkFaint;
      ctx2d.lineWidth = 1;
      const decades = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      for (const f of decades) {
        const x = freqToX(f, w);
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }
      // Horizontal grid every 10 dB.
      for (let db = DB_MIN; db <= DB_MAX; db += 10) {
        const y = ((DB_MAX - db) / (DB_MAX - DB_MIN)) * h;
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(w, y);
        ctx2d.stroke();
      }

      // Combined response polyline + filled area.
      ctx2d.beginPath();
      const baseY = h;
      ctx2d.moveTo(0, baseY);
      for (let i = 0; i < RESPONSE_POINTS; i++) {
        const combined = off.hpMag[i] * off.lpMag[i];
        const db = 20 * Math.log10(Math.max(1e-6, combined));
        const yT = Math.min(
          h,
          Math.max(0, ((DB_MAX - db) / (DB_MAX - DB_MIN)) * h),
        );
        const x = (i / (RESPONSE_POINTS - 1)) * w;
        ctx2d.lineTo(x, yT);
      }
      ctx2d.lineTo(w, baseY);
      ctx2d.closePath();
      ctx2d.fillStyle = ink;
      ctx2d.globalAlpha = 0.18;
      ctx2d.fill();
      ctx2d.globalAlpha = 1;

      // Stroke the response curve cleanly on top.
      ctx2d.beginPath();
      for (let i = 0; i < RESPONSE_POINTS; i++) {
        const combined = off.hpMag[i] * off.lpMag[i];
        const db = 20 * Math.log10(Math.max(1e-6, combined));
        const yT = Math.min(
          h,
          Math.max(0, ((DB_MAX - db) / (DB_MAX - DB_MIN)) * h),
        );
        const x = (i / (RESPONSE_POINTS - 1)) * w;
        if (i === 0) ctx2d.moveTo(x, yT);
        else ctx2d.lineTo(x, yT);
      }
      ctx2d.strokeStyle = ink;
      ctx2d.lineWidth = 1.5 * dpr;
      ctx2d.stroke();

      // Handles.
      const handleR = 8 * dpr;
      const drawHandle = (f: number) => {
        const x = freqToX(f, w);
        ctx2d.strokeStyle = ink;
        ctx2d.lineWidth = 1 * dpr;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
        ctx2d.fillStyle = ink;
        ctx2d.beginPath();
        ctx2d.arc(x, h / 2, handleR, 0, 2 * Math.PI);
        ctx2d.fill();
        ctx2d.strokeStyle = bg;
        ctx2d.lineWidth = 2 * dpr;
        ctx2d.beginPath();
        ctx2d.arc(x, h / 2, handleR - 2 * dpr, 0, 2 * Math.PI);
        ctx2d.stroke();
      };
      drawHandle(hpFreq);
      drawHandle(lpFreq);

      // dB axis labels (left edge).
      ctx2d.fillStyle = ink;
      ctx2d.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx2d.textBaseline = "top";
      ctx2d.textAlign = "left";
      ctx2d.fillText(`+${DB_MAX}`, 4 * dpr, 4 * dpr);
      ctx2d.textBaseline = "bottom";
      ctx2d.fillText(`${DB_MIN}`, 4 * dpr, h - 4 * dpr);
    };

    resize();

    return () => {
      ro.disconnect();
    };
  }, [hpFreq, lpFreq, noiseType]);

  // ─── pointer handling ───────────────────────────────────────────
  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    const wCss = rect.width;
    const hpX = freqToX(hpFreq, wCss);
    const lpX = freqToX(lpFreq, wCss);
    const distHp = Math.abs(xCss - hpX);
    const distLp = Math.abs(xCss - lpX);
    const handle: "hp" | "lp" = distHp <= distLp ? "hp" : "lp";
    dragRef.current = { handle, pointerId: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    moveHandle(handle, xCss, wCss);
  };

  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xCss = e.clientX - rect.left;
    moveHandle(drag.handle, xCss, rect.width);
  };

  const onCanvasPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    const canvas = canvasRef.current;
    canvas?.releasePointerCapture(e.pointerId);
  };

  const moveHandle = (handle: "hp" | "lp", xCss: number, wCss: number) => {
    const f = clampFreq(xToFreq(xCss, wCss));
    if (handle === "hp") {
      // Push lp up if hp would cross it.
      if (f >= lpFreq) {
        setLpFreq(Math.min(FREQ_MAX, f * 1.1));
      }
      setHpFreq(f);
    } else {
      if (f <= hpFreq) {
        setHpFreq(Math.max(FREQ_MIN, f / 1.1));
      }
      setLpFreq(f);
    }
  };

  return (
    <div className="noise-tool">
      <div className="noise-type-row">
        <span className="noise-type-label">noise:</span>
        <div className="seg noise-type-seg">
          <button
            type="button"
            className={noiseType === "white" ? "active" : ""}
            onClick={() => setNoiseType("white")}
          >
            white
          </button>
          <button
            type="button"
            className={noiseType === "pink" ? "active" : ""}
            onClick={() => setNoiseType("pink")}
          >
            pink
          </button>
        </div>
      </div>

      <canvas
        ref={canvasRef}
        className="noise-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      />

      <div className="noise-axis-labels">
        <span>20 hz</span>
        <span>200</span>
        <span>1 k</span>
        <span>10 k</span>
        <span>20 k</span>
      </div>

      <div className="noise-readout">
        hp: {formatFreq(hpFreq)} · lp: {formatFreq(lpFreq)}
      </div>

      <div className="bpm-controls">
        <span className="noise-gain-label">gain</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={gain}
          onChange={(e) => setGain(Number(e.target.value))}
          className="bpm-slider"
          aria-label="Master gain"
        />
        <span className="noise-gain-readout">{Math.round(gain * 100)}</span>
      </div>

      <div className="tool-play">
        <button
          type="button"
          className={`btn primary ${playing ? "stop" : ""}`}
          onClick={handlePlayPause}
        >
          {playing ? "stop" : "play"}
        </button>
      </div>
    </div>
  );
}
