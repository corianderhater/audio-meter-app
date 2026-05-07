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
import { Metronome } from "./components/Metronome";
import { SoundGenerator } from "./components/SoundGenerator";
import { NoiseGenerator } from "./components/NoiseGenerator";
import { WavelengthCalc } from "./components/WavelengthCalc";
import { SweepGenerator } from "./components/SweepGenerator";

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

type Mode =
  | "meter"
  | "tuner"
  | "metronome"
  | "soundgen"
  | "noise"
  | "sweep"
  | "wavelength";
type ViewMode = "spectrum" | "spectrogram" | "ridges" | "mesh" | "globe";

// Previous build shipped 120 as the default; we now use 125. Treat any
// stored value that exactly matches the OLD default as "unchanged from
// default" and migrate it forward, so returning users see the new initial
// value. Anyone who explicitly customised (any other value) keeps theirs.
const PREVIOUS_DEFAULT_CALIBRATION_DB = 120;

function loadCalibration(): number {
  try {
    const v = localStorage.getItem(CAL_KEY);
    if (v == null) return DEFAULT_CALIBRATION_DB;
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_CALIBRATION_DB;
    if (n === PREVIOUS_DEFAULT_CALIBRATION_DB) return DEFAULT_CALIBRATION_DB;
    return n;
  } catch {
    return DEFAULT_CALIBRATION_DB;
  }
}

const VALID_MODES: readonly Mode[] = [
  "meter",
  "tuner",
  "metronome",
  "soundgen",
  "noise",
  "sweep",
  "wavelength",
];

function loadMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v && (VALID_MODES as readonly string[]).includes(v)) return v as Mode;
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
  const title = "v1.1";
  const subtitle =
    mode === "tuner"
      ? "chromatic · a4 = 440 hz"
      : mode === "metronome"
        ? "30–300 bpm"
        : mode === "soundgen"
          ? "oscillators · sine · noise"
          : mode === "noise"
            ? "white · pink · band-pass"
            : mode === "sweep"
              ? "sine · log · linear"
              : mode === "wavelength"
                ? "λ = c / f"
                : "20 hz – 20 khz";

  // Mic-using modes show a centered start circle inside the viz area when
  // not yet running. Other modes have their own internal play controls.
  const isMicMode = mode === "meter" || mode === "tuner";
  const showCenterStart = isMicMode && !running;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>{title}</h1>
          <span className="badge-range">{subtitle}</span>
        </div>
        <div className="header-actions">
          <select
            className="mode-select"
            value={mode}
            onChange={(e) => {
              const newMode = e.target.value as Mode;
              // Stop the mic when leaving a mic-using mode so it doesn't
              // keep running invisibly during metronome / sound generator.
              if (
                newMode !== "meter" &&
                newMode !== "tuner" &&
                running
              ) {
                audio.stop();
              }
              setMode(newMode);
            }}
            aria-label="Mode"
          >
            <option value="meter">meter</option>
            <option value="tuner">tuner</option>
            <option value="metronome">metronome</option>
            <option value="soundgen">sound generator</option>
            <option value="noise">noise</option>
            <option value="sweep">sweep</option>
            <option value="wavelength">wavelength</option>
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
          {showCenterStart && (
            <button
              type="button"
              className="viz-start-circle"
              onClick={audio.start}
              disabled={audio.status === "starting"}
              aria-label="Start"
            >
              {audio.status === "starting" ? "…" : "start"}
            </button>
          )}
          {!running && isMicMode && audio.status === "error" && audio.error && (
            <div className="viz-error">{audio.error}</div>
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
          {mode === "metronome" && <Metronome />}
          {mode === "soundgen" && <SoundGenerator />}
          {mode === "noise" && <NoiseGenerator />}
          {mode === "sweep" && <SweepGenerator />}
          {mode === "wavelength" && <WavelengthCalc />}

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
