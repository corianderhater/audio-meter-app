import { useEffect, useState } from "react";
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

  // Local string buffer so the user can transiently empty the field, type
  // "-" before the digits, etc. Without this, parsing every keystroke and
  // falling back to 0 makes "0" stick: backspacing it instantly re-fills 0,
  // and "-" alone (start of a negative) is NaN → also forced back to 0.
  const [calText, setCalText] = useState<string>(String(calibrationDb));

  // Re-sync when the canonical value changes from outside (e.g. another tab,
  // load from localStorage, future device-preset picker).
  useEffect(() => {
    setCalText((prev) => {
      const parsed = Number(prev);
      return Number.isFinite(parsed) && parsed === calibrationDb
        ? prev
        : String(calibrationDb);
    });
  }, [calibrationDb]);

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
              value={calText}
              onChange={(e) => {
                const v = e.target.value;
                setCalText(v);
                // Don't push intermediate states (empty, lone "-" / ".")
                // upstream — they'd parse as NaN and snap back to 0.
                if (v === "" || v === "-" || v === "." || v === "-.") return;
                const n = Number(v);
                if (Number.isFinite(n)) onCalibrationChange(n);
              }}
              onBlur={() => {
                const n = Number(calText);
                if (!Number.isFinite(n)) {
                  // User left the field in a half-typed state; commit 0
                  // and normalize the visible text.
                  onCalibrationChange(0);
                  setCalText("0");
                } else {
                  setCalText(String(n));
                }
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
