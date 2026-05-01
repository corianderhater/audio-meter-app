// Shared tap-to-pin probe used across every visualisation. Tap a point on
// the graph and a small tooltip pins there with the frequency at that
// position and the live dB SPL at that band. Tap × to dismiss, or tap
// somewhere else to move the pin.

import { type RefObject } from "react";

export interface ProbeData {
  cssX: number;
  cssY: number;
  freqHz: number;
  bandIndex: number;
}

export function formatFreq(hz: number): string {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  if (hz >= 100) return `${hz.toFixed(0)} Hz`;
  return `${hz.toFixed(1)} Hz`;
}

// Map a normalized x (0..1 across the plot area) to log-scaled frequency.
export function freqAtNormalized(t: number, fMin = 20, fMax = 20000): number {
  const lt = Math.min(1, Math.max(0, t));
  return Math.pow(
    10,
    Math.log10(fMin) + lt * (Math.log10(fMax) - Math.log10(fMin)),
  );
}

// Inverse: where on the normalized x axis does this frequency sit?
export function normalizedAtFreq(
  hz: number,
  fMin = 20,
  fMax = 20000,
): number {
  const lf = Math.log10(Math.max(fMin, Math.min(fMax, hz)));
  return (lf - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin));
}

// Find the band index whose [edge, edge] range contains this frequency.
// Layout edges are monotonically increasing — binary search.
export function bandFromFreq(freq: number, edges: Float32Array): number {
  if (freq < edges[0] || freq > edges[edges.length - 1]) return -1;
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (freq >= edges[mid + 1]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface ProbePinProps {
  data: ProbeData;
  dbRef: RefObject<HTMLDivElement>;
  onDismiss: () => void;
  // Optional ref to the outer wrapper. 3D views use this to update the
  // pin's CSS position every frame (projecting the tracked surface vertex
  // back into screen space) so the dot stays glued to the deforming mesh
  // even as the camera orbits.
  pinRef?: RefObject<HTMLDivElement>;
}

export function ProbePin({ data, dbRef, onDismiss, pinRef }: ProbePinProps) {
  return (
    <div
      ref={pinRef}
      className="probe-pin"
      style={{ left: data.cssX, top: data.cssY }}
    >
      <div className="probe-dot" />
      <div
        className="probe-tooltip"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="probe-freq">{formatFreq(data.freqHz)}</div>
        <div ref={dbRef} className="probe-db">
          — dB SPL
        </div>
        <button
          type="button"
          className="probe-close"
          onPointerDown={(e) => {
            // Halt before the wrapper's pointerdown handler can re-pin.
            e.stopPropagation();
            onDismiss();
          }}
          aria-label="Dismiss probe"
        >
          ×
        </button>
      </div>
    </div>
  );
}
