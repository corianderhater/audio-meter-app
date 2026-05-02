type ViewMode = "spectrum" | "spectrogram" | "ridges" | "mesh" | "globe";

interface Props {
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
}

export function Controls({ view, onViewChange }: Props) {
  return (
    <footer className="controls">
      <label className="view-picker">
        <span className="view-picker-label">View</span>
        <select
          className="view-select"
          value={view}
          onChange={(e) => onViewChange(e.target.value as ViewMode)}
        >
          <option value="globe">Globe</option>
          <option value="mesh">Mesh</option>
          <option value="ridges">Ridges</option>
          <option value="spectrogram">Waterfall</option>
          <option value="spectrum">Spectrum</option>
        </select>
      </label>
    </footer>
  );
}
