import { useKey } from "../hooks/useKey";

interface Props {
  analyser: AnalyserNode;
  sampleRate: number;
  fftSize: number;
}

export function KeyDisplay({ analyser, sampleRate, fftSize }: Props) {
  const est = useKey(analyser, sampleRate, fftSize);

  const hasKey = est != null && est.confidence > 0.05;
  const conf = est ? Math.max(0, Math.min(1, est.confidence)) : 0;
  const dim = !hasKey || conf < 0.35;

  return (
    <div className={`keybox ${dim ? "dim" : ""}`}>
      <div className="keybox-readout">
        <span className="keybox-name">{hasKey ? est!.name : "—"}</span>
        <span className="keybox-camelot">{hasKey ? est!.camelot : ""}</span>
      </div>
      <div
        className="keybox-conf"
        title={`Confidence: ${(conf * 100).toFixed(0)}%`}
      >
        <div className="keybox-conf-fill" style={{ width: `${conf * 100}%` }} />
      </div>
    </div>
  );
}
