import { lazy, Suspense, useEffect, useState } from "react";
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

// Wavefield pulls in three.js (~500 KB unminified). Lazy-load it so the
// initial bundle stays small for users who never open the Mesh view.
const Wavefield = lazy(() =>
  import("./components/Wavefield").then((m) => ({ default: m.Wavefield })),
);

const CAL_KEY = "audioMeter.calibrationDb";
const MODE_KEY = "audioMeter.mode";

type Mode = "meter" | "tuner";
type ViewMode = "spectrum" | "spectrogram" | "ridges" | "mesh";

function loadCalibration(): number {
  try {
    const v = localStorage.getItem(CAL_KEY);
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
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
  const [peakResetToken, setPeakResetToken] = useState(0);

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
          <nav className="mode-switch" role="tablist" aria-label="Mode">
            <button
              role="tab"
              aria-selected={mode === "meter"}
              className={mode === "meter" ? "active" : ""}
              onClick={() => setMode("meter")}
            >
              Meter
            </button>
            <button
              role="tab"
              aria-selected={mode === "tuner"}
              className={mode === "tuner" ? "active" : ""}
              onClick={() => setMode("tuner")}
            >
              Tuner
            </button>
          </nav>
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

        {running && audio.analyser && mode === "meter" && (
          <>
            <div className="top-row">
              <LoudnessMeter
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
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
            {view === "spectrum" && (
              <SpectrumView
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
                peakResetToken={peakResetToken}
                theme={theme}
              />
            )}
            {view === "spectrogram" && (
              <Spectrogram
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
                theme={theme}
              />
            )}
            {view === "ridges" && (
              <Waterfall3D
                analyser={audio.analyser}
                sampleRate={audio.sampleRate}
                fftSize={audio.fftSize}
                calibrationDb={calibrationDb}
                theme={theme}
              />
            )}
            {view === "mesh" && (
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
          </>
        )}

        {running && audio.analyser && mode === "tuner" && (
          <Tuner analyser={audio.analyser} sampleRate={audio.sampleRate} />
        )}
      </main>

      {mode === "meter" && (
        <Controls
          status={audio.status}
          onStart={audio.start}
          onStop={audio.stop}
          view={view}
          onViewChange={setView}
          calibrationDb={calibrationDb}
          onCalibrationChange={setCalibrationDb}
          onResetPeaks={() => setPeakResetToken((n) => n + 1)}
        />
      )}
      {mode === "tuner" && (
        <footer className="controls controls-tuner">
          <button
            className={`btn primary ${running ? "stop" : ""}`}
            onClick={running ? audio.stop : audio.start}
            disabled={audio.status === "starting"}
          >
            {audio.status === "starting" ? "…" : running ? "Stop" : "Start"}
          </button>
          <p className="cal-hint">
            Whistle, sing or play a single sustained note. The detector tracks
            pitches from ~30 Hz (low B) to 2 kHz.
          </p>
        </footer>
      )}
    </div>
  );
}
