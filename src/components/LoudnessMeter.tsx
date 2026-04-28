import { useEffect, useMemo, useRef, useState } from "react";
import { getAWeightingOffsets } from "../audio/aWeighting";
import { aWeightedOverallDb } from "../audio/loudness";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
  calibrationDb: number;
  onCalibrationChange: (v: number) => void;
}

export function LoudnessMeter({
  analyser,
  sampleRate,
  fftSize,
  calibrationDb,
  onCalibrationChange,
}: Props) {
  const numRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLSpanElement>(null);
  const calRef = useRef<number>(calibrationDb);
  calRef.current = calibrationDb;

  const weights = useMemo(
    () => getAWeightingOffsets(sampleRate, fftSize),
    [sampleRate, fftSize],
  );

  useEffect(() => {
    const freq = new Float32Array(fftSize / 2);
    let raf = 0;
    let lastDom = 0;
    let peakRaw = -Infinity;
    let peakHoldUntil = 0;

    const tick = (now: number) => {
      analyser.getFloatFrequencyData(freq);
      const raw = aWeightedOverallDb(freq, weights);

      if (raw > peakRaw) {
        peakRaw = raw;
        peakHoldUntil = now + 2000;
      } else if (now > peakHoldUntil) {
        peakRaw = Math.max(-Infinity, peakRaw - 0.2);
      }

      // Update DOM at ~20 fps to avoid flicker
      if (now - lastDom > 50) {
        lastDom = now;
        const cur = raw + calRef.current;
        const peak = peakRaw + calRef.current;
        if (numRef.current) {
          numRef.current.textContent = Number.isFinite(cur)
            ? cur.toFixed(1)
            : "—";
        }
        if (peakRef.current) {
          peakRef.current.textContent = Number.isFinite(peak)
            ? `peak ${peak.toFixed(1)}`
            : "peak —";
        }
        if (barRef.current) {
          // Map 0..130 dB SPL to 0..1 (threshold of hearing → pain).
          const t = Math.min(1, Math.max(0, cur / 130));
          barRef.current.style.width = `${(t * 100).toFixed(1)}%`;
          // Traffic-light tint + matching glow above hearing-safe levels.
          let color: string;
          if (cur >= 110) color = "#ff3b30";       // red — pain / damage risk
          else if (cur >= 90) color = "#ffcc00";   // yellow — high
          else color = "#34c759";                  // green — safe
          barRef.current.style.background = color;
          barRef.current.style.boxShadow =
            `0 0 6px ${color}, 0 0 14px ${color}80`;
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, fftSize, weights]);

  // Click APPROX to open a popover with the calibration offset input.
  const [showCalPopover, setShowCalPopover] = useState(false);
  const [calText, setCalText] = useState<string>(String(calibrationDb));
  const badgeBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mirror calibrationDb into the local string buffer when it changes from
  // outside (e.g. after a fresh page load or another input source).
  useEffect(() => {
    setCalText((prev) => {
      const parsed = Number(prev);
      return Number.isFinite(parsed) && parsed === calibrationDb
        ? prev
        : String(calibrationDb);
    });
  }, [calibrationDb]);

  // Outside-click closes the popover.
  useEffect(() => {
    if (!showCalPopover) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (
        popoverRef.current?.contains(t) ||
        badgeBtnRef.current?.contains(t)
      ) {
        return;
      }
      setShowCalPopover(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [showCalPopover]);

  // Auto-focus + select the input when the popover opens, so a single tap
  // on APPROX gets straight into editing.
  useEffect(() => {
    if (showCalPopover) {
      // microtask delay so the element is in the DOM
      queueMicrotask(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [showCalPopover]);

  return (
    <div className="loudness">
      <div className="loudness-readout">
        <span className="loudness-num" ref={numRef}>—</span>
        <span className="loudness-unit">dB SPL (A)</span>
        <span className="loudness-peak" ref={peakRef}>peak —</span>
      </div>
      <div className="loudness-bar">
        <div className="loudness-bar-fill" ref={barRef} />
      </div>
      <button
        ref={badgeBtnRef}
        type="button"
        className={`badge-uncal ${showCalPopover ? "active" : ""}`}
        onClick={() => setShowCalPopover((s) => !s)}
        aria-label="Open calibration offset"
        aria-expanded={showCalPopover}
        title="Tap to adjust calibration offset"
      >
        APPROX
      </button>

      {showCalPopover && (
        <div
          ref={popoverRef}
          className="cal-popover"
          role="dialog"
          aria-label="Calibration offset"
        >
          <div className="cal-popover-title">Calibration offset</div>
          <div className="cal-input">
            <input
              ref={inputRef}
              type="number"
              inputMode="decimal"
              step="0.1"
              value={calText}
              onChange={(e) => {
                const v = e.target.value;
                setCalText(v);
                if (v === "" || v === "-" || v === "." || v === "-.") return;
                const n = Number(v);
                if (Number.isFinite(n)) onCalibrationChange(n);
              }}
              onBlur={() => {
                const n = Number(calText);
                if (!Number.isFinite(n)) {
                  onCalibrationChange(0);
                  setCalText("0");
                } else {
                  setCalText(String(n));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                  setShowCalPopover(false);
                } else if (e.key === "Escape") {
                  setShowCalPopover(false);
                }
              }}
            />
            <span className="unit">dB</span>
          </div>
          <p className="cal-popover-hint">
            Current value matches a typical iPhone 13 Pro. Other devices vary
            by ±5 dB. For best accuracy, place a reference SPL meter next to
            the phone and adjust until both readings match.
          </p>
        </div>
      )}
    </div>
  );
}
