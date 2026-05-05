import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatFreq } from "./ProbeTooltip";

const STORAGE_KEY = "audioMeter.sweep";
const FREQ_MIN = 1;
const FREQ_MAX = 22000;
const DUR_MIN = 0.1;
const DUR_MAX = 600;

type SweepType = "log" | "linear";

interface PersistedState {
  startHz: number;
  endHz: number;
  durationSec: number;
  sweepType: SweepType;
  gain: number;
  loop: boolean;
}

function defaultState(): PersistedState {
  return {
    startHz: 20,
    endHz: 20000,
    durationSec: 10,
    sweepType: "log",
    gain: 0.5,
    loop: false,
  };
}

function clampFreq(f: number): number {
  if (!Number.isFinite(f)) return FREQ_MIN;
  return Math.min(FREQ_MAX, Math.max(FREQ_MIN, f));
}

function loadState(): PersistedState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return defaultState();
    const p = JSON.parse(v);
    const d = defaultState();
    return {
      startHz: clampFreq(p?.startHz ?? d.startHz),
      endHz: clampFreq(p?.endHz ?? d.endHz),
      durationSec:
        typeof p?.durationSec === "number" && Number.isFinite(p.durationSec)
          ? Math.min(DUR_MAX, Math.max(DUR_MIN, p.durationSec))
          : d.durationSec,
      sweepType: p?.sweepType === "linear" ? "linear" : "log",
      gain:
        typeof p?.gain === "number" && Number.isFinite(p.gain)
          ? Math.min(1, Math.max(0, p.gain))
          : d.gain,
      loop: !!p?.loop,
    };
  } catch {
    return defaultState();
  }
}

// Sine sweep generator. Schedules a frequency ramp on a single
// OscillatorNode (exponential for log, linear otherwise). A rAF loop drives
// the progress bar + live frequency readout. iOS-safe: AudioContext is
// created inside the click handler, never at mount.
export function SweepGenerator() {
  const initial = loadState();
  const [startHz, setStartHz] = useState<number>(initial.startHz);
  const [endHz, setEndHz] = useState<number>(initial.endHz);
  const [durationSec, setDurationSec] = useState<number>(initial.durationSec);
  const [sweepType, setSweepType] = useState<SweepType>(initial.sweepType);
  const [gain, setGain] = useState<number>(initial.gain);
  const [loop, setLoop] = useState<boolean>(initial.loop);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [currentHz, setCurrentHz] = useState<number>(initial.startHz);

  type AudioBundle = {
    ctx: AudioContext;
    osc: OscillatorNode;
    gainNode: GainNode;
    compressor: DynamicsCompressorNode;
    sweepStartTime: number; // ctx.currentTime when sweep began
    sweepEndTime: number;
    sweepStartHz: number;
    sweepEndHz: number;
    type: SweepType;
    loopTimeoutId: number | null;
  };
  const audioRef = useRef<AudioBundle | null>(null);
  const rafRef = useRef<number | null>(null);

  // Mirrors of state for callbacks scheduled outside React.
  const settingsRef = useRef({
    startHz,
    endHz,
    durationSec,
    sweepType,
    gain,
    loop,
  });
  settingsRef.current = { startHz, endHz, durationSec, sweepType, gain, loop };

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          startHz,
          endHz,
          durationSec,
          sweepType,
          gain,
          loop,
        }),
      );
    } catch {
      // ignore
    }
  }, [startHz, endHz, durationSec, sweepType, gain, loop]);

  // Live-update gain while playing.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;
    a.gainNode.gain.cancelScheduledValues(t);
    a.gainNode.gain.setValueAtTime(a.gainNode.gain.value, t);
    a.gainNode.gain.linearRampToValueAtTime(gain, t + 0.05);
  }, [gain]);

  // Component unmount: tear everything down.
  useEffect(() => {
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopAll = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const a = audioRef.current;
    if (a) {
      if (a.loopTimeoutId != null) {
        window.clearTimeout(a.loopTimeoutId);
      }
      const t = a.ctx.currentTime;
      try {
        a.gainNode.gain.cancelScheduledValues(t);
        a.gainNode.gain.setValueAtTime(a.gainNode.gain.value, t);
        a.gainNode.gain.linearRampToValueAtTime(0, t + 0.05);
      } catch {
        // ignore
      }
      const ctxToClose = a.ctx;
      const osc = a.osc;
      window.setTimeout(() => {
        try {
          osc.stop();
        } catch {
          // ignore
        }
        ctxToClose.close().catch(() => undefined);
      }, 80);
      audioRef.current = null;
    }
  };

  const scheduleSweepRamp = (a: AudioBundle, ctxNow: number) => {
    const { startHz: s, endHz: e, durationSec: d, sweepType: t } =
      settingsRef.current;
    const startF = clampFreq(s);
    // Exponential ramp can't reach <= 0; clamp end the same way.
    const endF = clampFreq(e);

    a.osc.frequency.cancelScheduledValues(ctxNow);
    a.osc.frequency.setValueAtTime(startF, ctxNow);
    if (t === "log") {
      // exponentialRampToValueAtTime requires positive values; both
      // already clamped to >= FREQ_MIN.
      a.osc.frequency.exponentialRampToValueAtTime(endF, ctxNow + d);
    } else {
      a.osc.frequency.linearRampToValueAtTime(endF, ctxNow + d);
    }
    a.sweepStartTime = ctxNow;
    a.sweepEndTime = ctxNow + d;
    a.sweepStartHz = startF;
    a.sweepEndHz = endF;
    a.type = t;
  };

  const startTick = () => {
    const tick = () => {
      const a = audioRef.current;
      if (!a) {
        rafRef.current = null;
        return;
      }
      const elapsed = a.ctx.currentTime - a.sweepStartTime;
      const total = a.sweepEndTime - a.sweepStartTime;
      const t = total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 1;
      setProgress(t);

      let freq: number;
      if (a.type === "log") {
        const ratio = a.sweepEndHz / a.sweepStartHz;
        freq = a.sweepStartHz * Math.pow(ratio, t);
      } else {
        freq = a.sweepStartHz + (a.sweepEndHz - a.sweepStartHz) * t;
      }
      setCurrentHz(freq);

      // Sweep complete: either loop or stop.
      if (elapsed >= total) {
        if (settingsRef.current.loop) {
          // Restart at the next animation frame so React state settles.
          const ctxNow = a.ctx.currentTime;
          scheduleSweepRamp(a, ctxNow);
          rafRef.current = requestAnimationFrame(tick);
        } else {
          // One-shot done — stop everything.
          rafRef.current = null;
          stopAll();
          setPlaying(false);
          setProgress(1);
        }
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const handlePlayPause = async () => {
    if (playing) {
      stopAll();
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

      const osc = ctx.createOscillator();
      osc.type = "sine";

      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.03);

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-18, ctx.currentTime);
      compressor.knee.setValueAtTime(20, ctx.currentTime);
      compressor.ratio.setValueAtTime(8, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);

      osc.connect(gainNode).connect(compressor).connect(ctx.destination);

      const bundle: AudioBundle = {
        ctx,
        osc,
        gainNode,
        compressor,
        sweepStartTime: ctx.currentTime,
        sweepEndTime: ctx.currentTime,
        sweepStartHz: settingsRef.current.startHz,
        sweepEndHz: settingsRef.current.endHz,
        type: settingsRef.current.sweepType,
        loopTimeoutId: null,
      };
      audioRef.current = bundle;

      scheduleSweepRamp(bundle, ctx.currentTime);
      osc.start();
      setPlaying(true);
      setProgress(0);
      startTick();
    } catch (err) {
      console.error("[sweep] audio setup failed:", err);
    }
  };

  const swap = () => {
    setStartHz(endHz);
    setEndHz(startHz);
  };

  return (
    <div className="sweep-tool">
      <div className="sweep-type-row">
        <span className="sweep-label">type:</span>
        <div className="seg sweep-type-seg">
          <button
            type="button"
            className={sweepType === "log" ? "active" : ""}
            onClick={() => setSweepType("log")}
          >
            log
          </button>
          <button
            type="button"
            className={sweepType === "linear" ? "active" : ""}
            onClick={() => setSweepType("linear")}
          >
            linear
          </button>
        </div>
      </div>

      <div className="sweep-fields">
        <label className="sweep-field">
          <span className="sweep-field-label">start</span>
          <FreqField
            value={startHz}
            onChange={setStartHz}
            min={FREQ_MIN}
            max={FREQ_MAX}
            unit="hz"
          />
        </label>

        <button
          type="button"
          className="sweep-swap"
          onClick={swap}
          aria-label="Swap start and end"
          title="Swap"
        >
          ⇄
        </button>

        <label className="sweep-field">
          <span className="sweep-field-label">end</span>
          <FreqField
            value={endHz}
            onChange={setEndHz}
            min={FREQ_MIN}
            max={FREQ_MAX}
            unit="hz"
          />
        </label>

        <label className="sweep-field">
          <span className="sweep-field-label">duration</span>
          <FreqField
            value={durationSec}
            onChange={setDurationSec}
            min={DUR_MIN}
            max={DUR_MAX}
            unit="s"
            step={0.1}
          />
        </label>
      </div>

      <div className="sweep-progress-wrap">
        <div className="sweep-progress-track">
          <div
            className="sweep-progress-fill"
            style={{ width: `${progress * 100}%` }}
          />
          <div
            className="sweep-progress-dot"
            style={{ left: `${progress * 100}%` }}
          />
        </div>
        <div className="sweep-readout">
          {playing ? formatFreq(currentHz) : formatFreq(startHz)}
        </div>
      </div>

      <div className="bpm-controls sweep-gain-row">
        <span className="sweep-label">gain</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={gain}
          onChange={(e) => setGain(Number(e.target.value))}
          className="bpm-slider"
          aria-label="Sweep gain"
        />
        <span className="sweep-gain-readout">{Math.round(gain * 100)}</span>
      </div>

      <label className="sweep-loop">
        <input
          type="checkbox"
          checked={loop}
          onChange={(e) => setLoop(e.target.checked)}
        />
        <span>loop</span>
      </label>

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

function FreqField({
  value,
  onChange,
  min,
  max,
  unit,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit: string;
  step?: number;
}) {
  const [text, setText] = useState<string>(String(value));

  useEffect(() => {
    setText((prev) => {
      const parsed = Number(prev);
      return Number.isFinite(parsed) && parsed === value
        ? prev
        : String(value);
    });
  }, [value]);

  return (
    <div className="sweep-input-wrap">
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={text}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const v = e.target.value;
          setText(v);
          if (v === "" || v === ".") return;
          const n = Number(v);
          if (Number.isFinite(n) && n >= min && n <= max) {
            onChange(n);
          }
        }}
        onBlur={() => {
          const n = Number(text);
          if (!Number.isFinite(n) || n < min || n > max) {
            setText(String(value));
          } else {
            onChange(n);
            setText(String(n));
          }
        }}
      />
      <span className="sweep-input-unit">{unit}</span>
    </div>
  );
}
