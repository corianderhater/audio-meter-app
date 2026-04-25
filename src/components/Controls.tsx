import type { AudioStatus } from "../hooks/useAudioAnalyser";

interface Props {
  status: AudioStatus;
  onStart: () => void;
  onStop: () => void;
  view: "spectrum" | "spectrogram" | "ridges" | "mesh";
  onViewChange: (v: "spectrum" | "spectrogram" | "ridges" | "mesh") => void;
  calibrationDb: number;
  onCalibrationChange: (v: number) => void;
  onResetPeaks: () => void;
}

export function Controls({
  status,
  onStart,
  onStop,
  view,
  onViewChange,
  calibrationDb,
  onCalibrationChange,
  onResetPeaks,
}: Props) {
  const running = status === "running";
  return (
    <footer className="controls">
      <div className="controls-row">
        <button
          className={`btn primary ${running ? "stop" : ""}`}
          onClick={running ? onStop : onStart}
          disabled={status === "starting"}
        >
          {status === "starting" ? "…" : running ? "Stop" : "Start"}
        </button>

        <div className="seg">
          <button
            className={view === "spectrum" ? "active" : ""}
            onClick={() => onViewChange("spectrum")}
          >
            Spectrum
          </button>
          <button
            className={view === "spectrogram" ? "active" : ""}
            onClick={() => onViewChange("spectrogram")}
          >
            Waterfall
          </button>
          <button
            className={view === "ridges" ? "active" : ""}
            onClick={() => onViewChange("ridges")}
          >
            Ridges
          </button>
          <button
            className={view === "mesh" ? "active" : ""}
            onClick={() => onViewChange("mesh")}
          >
            Mesh
          </button>
        </div>

        <button className="btn" onClick={onResetPeaks} disabled={!running}>
          Reset peaks
        </button>
      </div>

      <div className="controls-row">
        <label className="cal">
          <span>Calibration offset</span>
          <div className="cal-input">
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              value={calibrationDb}
              onChange={(e) => {
                const n = Number(e.target.value);
                onCalibrationChange(Number.isFinite(n) ? n : 0);
              }}
            />
            <span className="unit">dB</span>
          </div>
        </label>
        <p className="cal-hint">
          Play a known reference (e.g. 94 dB at 1 kHz from a calibrator or
          another SPL meter) and adjust until this app matches.
        </p>
      </div>
    </footer>
  );
}
