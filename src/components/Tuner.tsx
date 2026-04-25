import { useEffect, useRef } from "react";
import { usePitch } from "../hooks/usePitch";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
}

const IN_TUNE_CENTS = 5;

export function Tuner({ analyser, sampleRate }: Props) {
  const pitch = usePitch(analyser, sampleRate);

  // Smooth the cents needle so it doesn't jitter between frames.
  const needleRef = useRef<HTMLDivElement>(null);
  const lastCentsRef = useRef<number>(0);
  useEffect(() => {
    if (!pitch || !needleRef.current) return;
    const target = Math.max(-50, Math.min(50, pitch.cents));
    const eased = lastCentsRef.current * 0.35 + target * 0.65;
    lastCentsRef.current = eased;
    // `eased` is in cents [-50..+50]; map directly to a percentage of the
    // track width so ±50¢ = the full left/right extent of the meter.
    needleRef.current.style.left = `${50 + eased}%`;
  }, [pitch]);

  const inTune = pitch != null && Math.abs(pitch.cents) <= IN_TUNE_CENTS;
  const sharp = pitch != null && pitch.cents > IN_TUNE_CENTS;
  const flat = pitch != null && pitch.cents < -IN_TUNE_CENTS;

  return (
    <div className="tuner">
      <div className="tuner-strip">
        <div className={`tuner-side ${flat ? "active" : ""}`}>♭</div>

        <div className="tuner-note">
          <span className="tuner-letter">
            {pitch ? pitch.noteName : "—"}
          </span>
          <span className="tuner-octave">{pitch ? pitch.octave : ""}</span>
        </div>

        <div className={`tuner-side ${sharp ? "active" : ""}`}>♯</div>
      </div>

      <div className={`tuner-status ${inTune ? "in-tune" : ""}`}>
        {pitch
          ? inTune
            ? "IN TUNE"
            : `${pitch.cents > 0 ? "+" : ""}${pitch.cents.toFixed(0)}¢`
          : "Listening…"}
      </div>

      <div className="tuner-meter" aria-hidden>
        <div className="tuner-ticks">
          {[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((c) => (
            <div
              key={c}
              className={`tuner-tick ${c === 0 ? "center" : ""}`}
              style={{ left: `${50 + c}%` }}
            />
          ))}
        </div>
        <div className="tuner-zero" />
        <div className="tuner-needle-track">
          <div className="tuner-needle" ref={needleRef} />
        </div>
      </div>

      <div className="tuner-readout">
        <span className="tuner-hz">
          {pitch ? `${pitch.freq.toFixed(1)} Hz` : "— Hz"}
        </span>
        <span className="tuner-ref">A4 = 440 Hz</span>
      </div>
    </div>
  );
}
