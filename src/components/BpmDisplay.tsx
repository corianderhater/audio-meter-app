import { useBpm } from "../hooks/useBpm";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
}

export function BpmDisplay({ analyser, sampleRate, fftSize }: Props) {
  const { bpm, confidence } = useBpm(analyser, sampleRate, fftSize);

  const display = bpm == null ? "—" : Math.round(bpm).toString();
  const conf = Math.max(0, Math.min(1, confidence));
  const dim = conf < 0.15;

  return (
    <div className={`bpm ${dim ? "dim" : ""}`}>
      <div className="bpm-readout">
        <span className="bpm-num">{display}</span>
        <span className="bpm-unit">BPM</span>
      </div>
      <div
        className="bpm-conf"
        title={`Confidence: ${(conf * 100).toFixed(0)}%`}
      >
        <div className="bpm-conf-fill" style={{ width: `${conf * 100}%` }} />
      </div>
    </div>
  );
}
