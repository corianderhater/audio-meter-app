import { useEffect, useRef, useState } from "react";
import type { AudioAnalyser } from "../hooks/useAudioAnalyser";
import { useBpm } from "../hooks/useBpm";

const SUBMODE_KEY = "audioMeter.bpmSubMode";
// Reset the tap buffer if the user pauses for longer than this.
const TAP_RESET_MS = 2000;
// Keep the most recent N taps for a moving average. Larger = more stable
// but slower to follow tempo changes.
const TAP_BUFFER = 8;

type SubMode = "audio" | "tap";

function loadSubMode(): SubMode {
  try {
    const v = localStorage.getItem(SUBMODE_KEY);
    if (v === "audio" || v === "tap") return v;
  } catch {
    // ignore
  }
  return "tap";
}

interface Props {
  audio: AudioAnalyser;
}

export function BpmMeter({ audio }: Props) {
  const [subMode, setSubMode] = useState<SubMode>(loadSubMode);

  useEffect(() => {
    try {
      localStorage.setItem(SUBMODE_KEY, subMode);
    } catch {
      // ignore
    }
  }, [subMode]);

  return (
    <div className="bpm-tool">
      <div className="bpm-tool-toggle">
        <div className="seg bpm-tool-seg">
          <button
            type="button"
            className={subMode === "audio" ? "active" : ""}
            onClick={() => setSubMode("audio")}
          >
            audio
          </button>
          <button
            type="button"
            className={subMode === "tap" ? "active" : ""}
            onClick={() => setSubMode("tap")}
          >
            tap
          </button>
        </div>
      </div>

      {subMode === "audio" ? (
        <AudioBpmPanel audio={audio} />
      ) : (
        <TapBpmPanel />
      )}
    </div>
  );
}

function AudioBpmPanel({ audio }: { audio: AudioAnalyser }) {
  const running = audio.status === "running" && audio.analyser != null;

  if (!running) {
    return (
      <div className="bpm-tool-audio">
        <div className="bpm-tool-empty">
          <p className="bpm-tool-hint">
            point the mic at music to detect tempo
          </p>
          <button
            type="button"
            className="btn primary bpm-tool-start"
            onClick={audio.start}
            disabled={audio.status === "starting"}
          >
            {audio.status === "starting" ? "…" : "start"}
          </button>
          {audio.status === "error" && audio.error && (
            <div className="viz-error">{audio.error}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bpm-tool-audio">
      <AudioBpmReadout
        analyser={audio.analyser!}
        sampleRate={audio.sampleRate}
        fftSize={audio.fftSize}
      />
      <button
        type="button"
        className="btn primary stop bpm-tool-stop"
        onClick={audio.stop}
      >
        stop mic
      </button>
    </div>
  );
}

function AudioBpmReadout({
  analyser,
  sampleRate,
  fftSize,
}: {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
}) {
  const { bpm, confidence } = useBpm(analyser, sampleRate, fftSize);
  const display = bpm == null ? "—" : Math.round(bpm).toString();
  const conf = Math.max(0, Math.min(1, confidence));
  const dim = conf < 0.15;

  return (
    <div className={`bpm-tool-readout ${dim ? "dim" : ""}`}>
      <div className="bpm-tool-num">{display}</div>
      <div className="bpm-tool-unit">bpm</div>
      <div
        className="bpm-tool-conf"
        title={`confidence: ${(conf * 100).toFixed(0)}%`}
      >
        <div
          className="bpm-tool-conf-fill"
          style={{ width: `${conf * 100}%` }}
        />
      </div>
      <div className="bpm-tool-conf-label">
        confidence {(conf * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function TapBpmPanel() {
  const tapsRef = useRef<number[]>([]);
  const [bpm, setBpm] = useState<number | null>(null);
  const [tapCount, setTapCount] = useState(0);
  // Pulse flag triggers a brief CSS class so each tap visibly registers.
  const [pulse, setPulse] = useState(0);
  // Auto-reset timer: if no tap arrives within TAP_RESET_MS, the next tap
  // starts a new measurement.
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = () => {
    if (idleTimerRef.current != null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  const scheduleIdle = () => {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      // Soft reset: discard the buffer so the next tap restarts.
      tapsRef.current = [];
      idleTimerRef.current = null;
    }, TAP_RESET_MS);
  };

  useEffect(() => {
    return () => {
      clearIdleTimer();
    };
  }, []);

  const handleTap = () => {
    const now = performance.now();
    const taps = tapsRef.current;

    if (taps.length > 0 && now - taps[taps.length - 1] > TAP_RESET_MS) {
      tapsRef.current = [now];
      setTapCount(1);
      setBpm(null);
      setPulse((p) => p + 1);
      scheduleIdle();
      return;
    }

    taps.push(now);
    if (taps.length > TAP_BUFFER) taps.shift();
    setTapCount(taps.length);
    setPulse((p) => p + 1);

    if (taps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < taps.length; i++) {
        intervals.push(taps[i] - taps[i - 1]);
      }
      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const computed = 60000 / mean;
      if (Number.isFinite(computed) && computed > 0) {
        setBpm(computed);
      }
    }
    scheduleIdle();
  };

  const handleReset = () => {
    tapsRef.current = [];
    setBpm(null);
    setTapCount(0);
    clearIdleTimer();
  };

  const display = bpm == null ? "—" : Math.round(bpm).toString();

  return (
    <div className="bpm-tool-tap">
      <div className="bpm-tool-readout">
        <div className="bpm-tool-num">{display}</div>
        <div className="bpm-tool-unit">bpm</div>
        <div className="bpm-tool-tap-count">
          {tapCount === 0
            ? "tap to start"
            : `${tapCount} ${tapCount === 1 ? "tap" : "taps"}`}
        </div>
      </div>

      <button
        type="button"
        className="bpm-tool-tap-btn"
        onPointerDown={handleTap}
        // Allow space + enter to tap when focused.
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            handleTap();
          }
        }}
        aria-label="Tap to measure tempo"
        // Re-keying with the pulse counter forces the CSS animation to
        // restart on every tap — without this the second tap of a run
        // wouldn't visibly pulse.
        key={pulse}
      >
        tap
      </button>

      <button
        type="button"
        className="bpm-tool-reset"
        onClick={handleReset}
        disabled={tapCount === 0}
      >
        reset
      </button>
    </div>
  );
}
