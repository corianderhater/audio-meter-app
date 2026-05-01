import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useAudioAnalyser } from "./hooks/useAudioAnalyser";
import { useTheme } from "./hooks/useTheme";
import { Controls } from "./components/Controls";
import { SpectrumView } from "./components/SpectrumView";
import { LoudnessMeter } from "./components/LoudnessMeter";
import { Spectrogram } from "./components/Spectrogram";
import { Waterfall3D } from "./components/Waterfall3D";
import { BpmDisplay } from "./components/BpmDisplay";
import { KeyDisplay } from "./components/KeyDisplay";
import { Tuner } from "./components/Tuner";

// Wavefield + Globe pull in three.js (~500 KB unminified). Lazy-load both
// so the initial bundle stays small for users who never open a 3D view.
// They share the same `three` vendor chunk, so the second one to load only
// costs its own component code.
const Wavefield = lazy(() =>
  import("./components/Wavefield").then((m) => ({ default: m.Wavefield })),
);
const Globe = lazy(() =>
  import("./components/Globe").then((m) => ({ default: m.Globe })),
);

const CAL_KEY = "audioMeter.calibrationDb";
const MODE_KEY = "audioMeter.mode";

// Typical iPhone digital MEMS mics report ~-26 dBFS at 94 dB SPL, so the
// dBFS → dB SPL conversion needs roughly +120 dB. This is the out-of-box
// default so values look like real SPL immediately; users still need to
// fine-tune against a reference meter for accurate readings.
// Default ≈ iPhone 13 Pro internal-mic offset. Other devices vary; the
// banner below prompts the user to verify against a reference meter.
const DEFAULT_CALIBRATION_DB = 125;

type Mode = "meter" | "tuner";
type ViewMode = "spectrum" | "spectrogram" | "ridges" | "mesh" | "globe";

function loadCalibration(): number {
  try {
    const v = localStorage.getItem(CAL_KEY);
    if (v == null) return DEFAULT_CALIBRATION_DB;
    const n = Number(v);
    return Number.isFinite(n) ? n : DEFAULT_CALIBRATION_DB;
  } catch {
    return DEFAULT_CALIBRATION_DB;
  }
}

function loadMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "tuner" || v === "meter") return v;
  } catch {
    // ignore
  }
  return "meter";
}

export function App() {
  const audio = useAudioAnalyser();
  const { theme, toggle: toggleTheme } = useTheme();
  const [calibrationDb, setCalibrationDb] = useState<number>(loadCalibration);
  const [view, setView] = useState<ViewMode>("spectrum");
  const [mode, setMode] = useState<Mode>(loadMode);
  const [vizFullscreen, setVizFullscreen] = useState(false);
  const vizAreaRef = useRef<HTMLDivElement>(null);

  // ESC exits fullscreen on desktop. Touch users tap the icon to exit.
  useEffect(() => {
    if (!vizFullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVizFullscreen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [vizFullscreen]);

  const toggleFullscreen = async () => {
    // Prefer the native Fullscreen API (true edge-to-edge, hides browser
    // chrome). Falls back to a CSS-based "fullscreen" class on iOS Safari
    // where the API isn't available for arbitrary elements.
    const el = vizAreaRef.current;
    if (!el) return;
    if (vizFullscreen || document.fullscreenElement) {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // ignore
      }
      setVizFullscreen(false);
      return;
    }
    try {
      await el.requestFullscreen();
      setVizFullscreen(true);
    } catch {
      setVizFullscreen(true); // CSS fallback
    }
  };

  // Keep state in sync if user exits via browser/OS controls.
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) setVizFullscreen(false);
    };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CAL_KEY, String(calibrationDb));
    } catch {
      // ignore
    }
  }, [calibrationDb]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore
    }
  }, [mode]);

  useEffect(() => {
    if (audio.status !== "running") return;
    let sentinel: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    nav.wakeLock?.request("screen").then((s) => {
      sentinel = s;
    }).catch(() => undefined);
    return () => {
      sentinel?.release().catch(() => undefined);
    };
  }, [audio.status]);

  const running = audio.status === "running" && audio.analyser != null;
  const title = mode === "tuner" ? "Tuner" : "Audio Meter";
  const subtitle =
    mode === "tuner" ? "Chromatic · A4 = 440 Hz" : "20 Hz – 20 kHz";

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>{title}</h1>
          <span className="badge-range">{subtitle}</span>
        </div>
        <div className="header-actions">
          <button
            className={`btn primary header-start ${running ? "stop" : ""}`}
            onClick={running ? audio.stop : audio.start}
            disabled={audio.status === "starting"}
            aria-label={running ? "Stop measuring" : "Start measuring"}
          >
            {audio.status === "starting" ? "…" : running ? "Stop" : "Start"}
          </button>
          <select
            className="mode-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
            aria-label="Mode"
          >
            <option value="meter">Meter</option>
            <option value="tuner">Tuner</option>
          </select>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <main className="main">
        {running && audio.analyser && mode === "meter" && (
          <div className="top-row">
            <LoudnessMeter
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
              calibrationDb={calibrationDb}
              onCalibrationChange={setCalibrationDb}
            />
            <BpmDisplay
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
            />
            <KeyDisplay
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
            />
          </div>
        )}

        <div
          className={`viz-area ${vizFullscreen ? "fullscreen" : ""}`}
          ref={vizAreaRef}
        >
          {!running && (
            <div className="placeholder">
              {audio.status === "idle" && (
                <>
                  <p>
                    Tap <strong>Start</strong> to begin{" "}
                    {mode === "tuner" ? "tuning" : "measuring"}.
                  </p>
                  <p className="hint">
                    You will be asked for microphone access. Audio is processed
                    on-device only and never leaves your phone.
                  </p>
                </>
              )}
              {audio.status === "starting" && <p>Starting…</p>}
              {audio.status === "error" && audio.error && (
                <p className="error">{audio.error}</p>
              )}
            </div>
          )}

          {running && audio.analyser && mode === "meter" && view === "spectrum" && (
            <SpectrumView
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
              calibrationDb={calibrationDb}
              theme={theme}
            />
          )}
          {running && audio.analyser && mode === "meter" && view === "spectrogram" && (
            <Spectrogram
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
              calibrationDb={calibrationDb}
              theme={theme}
            />
          )}
          {running && audio.analyser && mode === "meter" && view === "ridges" && (
            <Waterfall3D
              analyser={audio.analyser}
              sampleRate={audio.sampleRate}
              fftSize={audio.fftSize}
              calibrationDb={calibrationDb}
              theme={theme}
            />
          )}
          {running && audio.analyser && mode === "meter" && view === "mesh" && (
            <Suspense
              fallback={
                <div className="placeholder">
                  <p>Loading 3D…</p>
                </div>
              }
            >
              <Wavefield
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
                theme={theme}
              />
            </Suspense>
          )}
          {running && audio.analyser && mode === "meter" && view === "globe" && (
            <Suspense
              fallback={
                <div className="placeholder">
                  <p>Loading 3D…</p>
                </div>
              }
            >
              <Globe
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
                theme={theme}
              />
            </Suspense>
          )}
          {running && audio.analyser && mode === "tuner" && (
            <Tuner analyser={audio.analyser} sampleRate={audio.sampleRate} />
          )}

          <button
            type="button"
            className="viz-fullscreen-btn"
            onClick={toggleFullscreen}
            aria-label={vizFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={vizFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {vizFullscreen ? (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 4v5H4M15 4v5h5M15 20v-5h5M9 20v-5H4" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 9V4h5M20 9V4h-5M20 15v5h-5M4 15v5h5" />
              </svg>
            )}
          </button>
        </div>
      </main>

      {mode === "meter" && (
        <Controls view={view} onViewChange={setView} />
      )}
    </div>
  );
}
