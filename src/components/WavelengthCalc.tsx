import { useEffect, useState, type ChangeEvent } from "react";

const STORAGE_KEY = "audioMeter.wavelength";
const FREQ_MIN = 1;
const FREQ_MAX = 20000;
// Speed of sound in air at 20°C, 1 atm. Pros calibrate around this; the
// exact value drifts ±1% per ±5°C but for practical room/speaker work
// this is the reference everyone uses.
const SPEED_OF_SOUND = 343;
const MULT_PRESETS: Array<{ label: string; value: number }> = [
  { label: "¼", value: 0.25 },
  { label: "½", value: 0.5 },
  { label: "1", value: 1 },
  { label: "2", value: 2 },
  { label: "4", value: 4 },
];

interface PersistedState {
  freqHz: number;
  multiplier: number;
}

function defaultState(): PersistedState {
  return { freqHz: 440, multiplier: 1 };
}

function loadState(): PersistedState {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return defaultState();
    const p = JSON.parse(v);
    return {
      freqHz:
        typeof p?.freqHz === "number" && Number.isFinite(p.freqHz)
          ? Math.min(FREQ_MAX, Math.max(FREQ_MIN, p.freqHz))
          : 440,
      multiplier:
        typeof p?.multiplier === "number" && Number.isFinite(p.multiplier)
          ? p.multiplier
          : 1,
    };
  } catch {
    return defaultState();
  }
}

// Wavelength calculator: λ = (c / f) × multiplier. Useful for acoustic
// design — quarter-wave traps, half-wave room modes, speaker placement.
export function WavelengthCalc() {
  const initial = loadState();
  const [freqHz, setFreqHz] = useState<number>(initial.freqHz);
  const [multiplier, setMultiplier] = useState<number>(initial.multiplier);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ freqHz, multiplier }),
      );
    } catch {
      // ignore
    }
  }, [freqHz, multiplier]);

  const baseLength = SPEED_OF_SOUND / freqHz;
  const length = baseLength * multiplier;
  const lengthMm = length * 1000;
  const lengthCm = length * 100;
  const lengthIn = length * 39.3701;
  const lengthFt = length * 3.28084;

  // Pick the most readable unit for the headline number. Anything below
  // 1 m reads better in cm/mm; >1 m reads cleanest in m.
  const headline =
    length >= 1
      ? { value: length, unit: "m", precision: 3 }
      : length >= 0.01
        ? { value: lengthCm, unit: "cm", precision: 2 }
        : { value: lengthMm, unit: "mm", precision: 2 };

  return (
    <div className="wavelength-tool">
      <div className="wavelength-inputs">
        <label className="wavelength-field">
          <span className="wavelength-field-label">frequency</span>
          <FreqInput
            value={freqHz}
            onChange={setFreqHz}
            min={FREQ_MIN}
            max={FREQ_MAX}
            unit="hz"
          />
        </label>

        <label className="wavelength-field">
          <span className="wavelength-field-label">multiplier</span>
          <NumberInput
            value={multiplier}
            onChange={setMultiplier}
            min={0.0001}
            max={1000}
            step={0.01}
          />
        </label>
      </div>

      <div className="wavelength-presets">
        {MULT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`wavelength-preset ${
              Math.abs(multiplier - p.value) < 1e-9 ? "active" : ""
            }`}
            onClick={() => setMultiplier(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="wavelength-result">
        <div className="wavelength-headline">
          <span className="wavelength-headline-value">
            {formatNumber(headline.value, headline.precision)}
          </span>
          <span className="wavelength-headline-unit">{headline.unit}</span>
        </div>
        <div className="wavelength-alts">
          <span>{formatNumber(lengthMm, 1)} mm</span>
          <span>·</span>
          <span>{formatNumber(lengthCm, 2)} cm</span>
          <span>·</span>
          <span>{formatNumber(length, 4)} m</span>
          <span>·</span>
          <span>{formatNumber(lengthIn, 2)} in</span>
          <span>·</span>
          <span>{formatNumber(lengthFt, 3)} ft</span>
        </div>
      </div>

      <div className="wavelength-formula">
        λ = ({SPEED_OF_SOUND} m/s ÷ {formatNumber(freqHz, 2)} hz) ×{" "}
        {formatNumber(multiplier, 4)}
      </div>
    </div>
  );
}

function formatNumber(n: number, precision: number): string {
  if (!Number.isFinite(n)) return "—";
  // Trim trailing zeros after the decimal so "0.7800" reads "0.78".
  const s = n.toFixed(precision);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function FreqInput({
  value,
  onChange,
  min,
  max,
  unit,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit: string;
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
    <div className="wavelength-input-wrap">
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        min={min}
        max={max}
        value={text}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const v = e.target.value;
          setText(v);
          if (v === "" || v === "." || v === "-") return;
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
      <span className="wavelength-input-unit">{unit}</span>
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
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
    <div className="wavelength-input-wrap">
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
          if (v === "" || v === "." || v === "-") return;
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
    </div>
  );
}
