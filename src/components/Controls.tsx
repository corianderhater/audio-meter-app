type ViewMode = "spectrum" | "spectrogram" | "ridges" | "mesh" | "globe";

interface Props {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
}

export function Controls({ view, onViewChange }: Props) {
  return (
    <footer className="controls">
      <label className="view-picker">
        <span className="view-picker-label">view</span>
        <select
          className="view-select"
          value={view}
          onChange={(e) => onViewChange(e.target.value as ViewMode)}
        >
          <option value="globe">globe</option>
          <option value="mesh">mesh</option>
          <option value="ridges">ridges</option>
          <option value="spectrogram">waterfall</option>
          <option value="spectrum">spectrum</option>
        </select>
      </label>
    </footer>
  );
}
