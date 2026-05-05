import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  createPinkNoiseBuffer,
  createWhiteNoiseBuffer,
} from "../audio/noise";

const SLOTS_KEY = "audioMeter.soundgenSlots";
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const DEFAULT_FREQ = 440;
const NOISE_LOOP_SEC = 2;

type SlotType = "sine" | "white" | "pink";
const SLOT_TYPE_CYCLE: SlotType[] = ["sine", "white", "pink"];

interface Slot {
  type: SlotType;
  freqHz: number;
  gain: number;
  enabled: boolean;
}

function makeDefaultSlot(prev?: Slot): Slot {
  // New slots default to sine at the next octave above the last one (capped),
  // so adding several gives a nice harmonic stack out of the gate.
  const freq =
    prev && prev.type === "sine"
      ? Math.min(FREQ_MAX, Math.max(FREQ_MIN, prev.freqHz * 2))
      : DEFAULT_FREQ;
  return { type: "sine", freqHz: freq, gain: 0.5, enabled: false };
}

function loadSlots(): Slot[] {
  try {
    const v = localStorage.getItem(SLOTS_KEY);
    if (!v) return [makeDefaultSlot()];
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [makeDefaultSlot()];
    }
    return parsed.map((p) => ({
      type:
        p?.type === "white" || p?.type === "pink" || p?.type === "sine"
          ? p.type
          : "sine",
      freqHz:
        typeof p?.freqHz === "number" && Number.isFinite(p.freqHz)
          ? Math.min(FREQ_MAX, Math.max(FREQ_MIN, p.freqHz))
          : DEFAULT_FREQ,
      gain:
        typeof p?.gain === "number" && Number.isFinite(p.gain)
          ? Math.min(1, Math.max(0, p.gain))
          : 0.5,
      enabled: !!p?.enabled,
    }));
  } catch {
    return [makeDefaultSlot()];
  }
}

// Sound generator: dynamic list of oscillator slots, each can be sine, white
// noise or pink noise. Starts with 1 slot; users can add (+) or delete (×)
// individual slots. Enabling any slot for the first time creates the
// AudioContext + shared noise buffers inside the user-gesture handler (so
// iOS Safari accepts it).
export function SoundGenerator() {
  const [slots, setSlots] = useState<Slot[]>(loadSlots);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  type SlotNode = {
    source: OscillatorNode | AudioBufferSourceNode;
    gain: GainNode;
    type: SlotType;
  };
  type AudioBundle = {
    ctx: AudioContext;
    nodes: SlotNode[];
    compressor: DynamicsCompressorNode;
    whiteBuffer: AudioBuffer;
    pinkBuffer: AudioBuffer;
  };
  const audioRef = useRef<AudioBundle | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
    } catch {
      // ignore
    }
  }, [slots]);

  // Live-update the running graph when slots change. Adds/removes nodes to
  // match the current slot count, swaps source types if changed, and ramps
  // gain/frequency to follow the UI.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.ctx.currentTime;

    // Trim extra nodes if slots were removed.
    while (a.nodes.length > slots.length) {
      const removed = a.nodes.pop();
      if (!removed) break;
      try {
        removed.source.stop();
      } catch {
        // ignore
      }
      try {
        removed.source.disconnect();
      } catch {
        // ignore
      }
      try {
        removed.gain.disconnect();
      } catch {
        // ignore
      }
    }

    // Add new nodes for new slots.
    while (a.nodes.length < slots.length) {
      const idx = a.nodes.length;
      const slot = slots[idx];
      const source = makeSourceForSlot(a.ctx, slot, a.whiteBuffer, a.pinkBuffer);
      const gain = a.ctx.createGain();
      gain.gain.setValueAtTime(0, a.ctx.currentTime);
      source.connect(gain).connect(a.compressor);
      source.start();
      a.nodes.push({ source, gain, type: slot.type });
    }

    slots.forEach((slot, i) => {
      const node = a.nodes[i];
      if (!node) return;

      // Type changed → swap the source. AudioBufferSourceNode and
      // OscillatorNode can't change type after creation, so we tear down
      // the old one and stand up a new one connected to the same gain.
      if (node.type !== slot.type) {
        try {
          node.source.disconnect();
        } catch {
          // ignore
        }
        try {
          node.source.stop();
        } catch {
          // ignore
        }
        const next = makeSourceForSlot(a.ctx, slot, a.whiteBuffer, a.pinkBuffer);
        next.connect(node.gain);
        next.start();
        node.source = next;
        node.type = slot.type;
      } else if (slot.type === "sine") {
        // Frequency only applies to sine.
        const osc = node.source as OscillatorNode;
        osc.frequency.cancelScheduledValues(t);
        osc.frequency.setValueAtTime(osc.frequency.value, t);
        osc.frequency.linearRampToValueAtTime(slot.freqHz, t + 0.02);
      }

      const target = slot.enabled ? slot.gain : 0;
      node.gain.gain.cancelScheduledValues(t);
      node.gain.gain.setValueAtTime(node.gain.gain.value, t);
      node.gain.gain.linearRampToValueAtTime(target, t + 0.05);
    });
  }, [slots]);

  // Component unmount: tear everything down.
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (!a) return;
      a.nodes.forEach(({ source }) => {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      });
      a.ctx.close().catch(() => undefined);
      audioRef.current = null;
    };
  }, []);

  const ensureAudio = async () => {
    if (audioRef.current) return audioRef.current;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-24, ctx.currentTime);
    compressor.knee.setValueAtTime(30, ctx.currentTime);
    compressor.ratio.setValueAtTime(12, ctx.currentTime);
    compressor.attack.setValueAtTime(0.003, ctx.currentTime);
    compressor.release.setValueAtTime(0.25, ctx.currentTime);
    compressor.connect(ctx.destination);

    const whiteBuffer = createWhiteNoiseBuffer(ctx, NOISE_LOOP_SEC);
    const pinkBuffer = createPinkNoiseBuffer(ctx, NOISE_LOOP_SEC);

    const nodes = slotsRef.current.map<SlotNode>((slot) => {
      const source = makeSourceForSlot(ctx, slot, whiteBuffer, pinkBuffer);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      source.connect(gain).connect(compressor);
      source.start();
      return { source, gain, type: slot.type };
    });

    audioRef.current = { ctx, nodes, compressor, whiteBuffer, pinkBuffer };
    return audioRef.current;
  };

  const toggleSlot = async (i: number) => {
    const current = slotsRef.current[i];
    const newEnabled = !current.enabled;

    if (newEnabled && !audioRef.current) {
      try {
        await ensureAudio();
      } catch (err) {
        console.error("[soundgen] audio setup failed:", err);
        return;
      }
    }

    setSlots((prev) =>
      prev.map((s, j) => (j === i ? { ...s, enabled: newEnabled } : s)),
    );
  };

  const updateSlot = (i: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  const cycleType = (i: number) => {
    const cur = slotsRef.current[i].type;
    const idx = SLOT_TYPE_CYCLE.indexOf(cur);
    const next = SLOT_TYPE_CYCLE[(idx + 1) % SLOT_TYPE_CYCLE.length];
    updateSlot(i, { type: next });
  };

  const addSlot = () => {
    setSlots((prev) => [...prev, makeDefaultSlot(prev[prev.length - 1])]);
  };

  const removeSlot = (i: number) => {
    setSlots((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, j) => j !== i);
    });
  };

  return (
    <div className="soundgen-tool">
      <div className="soundgen-slots">
        {slots.map((slot, i) => (
          <div className="soundgen-slot" key={i}>
            <div className="soundgen-slot-head">
              <span className="soundgen-num">{i + 1}</span>
              {slots.length > 1 && (
                <button
                  type="button"
                  className="soundgen-remove"
                  onClick={() => removeSlot(i)}
                  aria-label={`Remove slot ${i + 1}`}
                  title="Remove"
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              className={`soundgen-type type-${slot.type}`}
              onClick={() => cycleType(i)}
              aria-label={`Slot ${i + 1} type, currently ${slot.type}`}
              title="Cycle sound type"
            >
              {slot.type}
            </button>
            {slot.type === "sine" ? (
              <FreqInput
                value={slot.freqHz}
                onChange={(v) => updateSlot(i, { freqHz: v })}
              />
            ) : (
              <div className="soundgen-freq-placeholder" aria-hidden />
            )}
            <div className="soundgen-fader-wrap">
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={slot.gain}
                onChange={(e) =>
                  updateSlot(i, { gain: Number(e.target.value) })
                }
                className="soundgen-fader"
                aria-label={`Slot ${i + 1} gain`}
                aria-orientation="vertical"
              />
            </div>
            <span className="soundgen-gain-readout">
              {Math.round(slot.gain * 100)}
            </span>
            <button
              type="button"
              className={`soundgen-mute ${slot.enabled ? "active" : ""}`}
              onClick={() => toggleSlot(i)}
              aria-label={slot.enabled ? "Turn off slot" : "Turn on slot"}
              aria-pressed={slot.enabled}
            >
              {slot.enabled ? "on" : "off"}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="soundgen-add"
          onClick={addSlot}
          aria-label="Add oscillator"
          title="Add oscillator"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Build a source node appropriate for the slot's current type.
function makeSourceForSlot(
  ctx: AudioContext,
  slot: Slot,
  whiteBuf: AudioBuffer,
  pinkBuf: AudioBuffer,
): OscillatorNode | AudioBufferSourceNode {
  if (slot.type === "sine") {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(slot.freqHz, ctx.currentTime);
    return osc;
  }
  const src = ctx.createBufferSource();
  src.buffer = slot.type === "white" ? whiteBuf : pinkBuf;
  src.loop = true;
  return src;
}

// Frequency input with the same string-buffer pattern used in the
// calibration field — lets the user backspace, type intermediate states,
// etc. without snap-back to the canonical numeric value.
function FreqInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
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
    <label className="soundgen-freq">
      <input
        type="number"
        inputMode="numeric"
        step="1"
        min={FREQ_MIN}
        max={FREQ_MAX}
        value={text}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const v = e.target.value;
          setText(v);
          if (v === "" || v === ".") return;
          const n = Number(v);
          if (Number.isFinite(n) && n >= FREQ_MIN && n <= FREQ_MAX) {
            onChange(n);
          }
        }}
        onBlur={() => {
          const n = Number(text);
          if (!Number.isFinite(n) || n < FREQ_MIN || n > FREQ_MAX) {
            setText(String(value));
          } else {
            const clamped = Math.min(FREQ_MAX, Math.max(FREQ_MIN, n));
            onChange(clamped);
            setText(String(clamped));
          }
        }}
      />
      <span className="soundgen-freq-unit">hz</span>
    </label>
  );
}
