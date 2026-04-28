interface Props {
  view: "spectrum" | "spectrogram" | "ridges" | "mesh";
  onViewChange: (v: "spectrum" | "spectrogram" | "ridges" | "mesh") => void;
}

export function Controls({ view, onViewChange }: Props) {
  return (
    <footer className="controls">
      <div className="controls-row">
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
      </div>
    </footer>
  );
}
