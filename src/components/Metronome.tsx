import { useEffect, useRef, useState } from "react";

const BPM_KEY = "audioMeter.metronomeBpm";
const BPM_MIN = 30;
const BPM_MAX = 300;
const DEFAULT_BPM = 120;
const REC_MAX_MS = 1000;
const COUNTDOWN_STEP_MS = 1000;

function loadBpm(): number {
  try {
    const v = localStorage.getItem(BPM_KEY);
    if (v == null) return DEFAULT_BPM;
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_BPM;
    return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(n)));
  } catch {
    return DEFAULT_BPM;
  }
}

type RecState = "idle" | "countdown" | "recording" | "ready";

// Metronome with adjustable tempo, horizontal pendulum, and an optional
// 1-second user recording that replaces the default click. Recording flow:
//   1. tap "record click" → 3-2-1 countdown shown on the button
//   2. 1 s capture, live amplitude waveform painted across the button width
//      (full button width represents the full 1 s recording window)
//   3. truncated AudioBuffer is decoded and replaces the triangle-wave click
export function Metronome() {
  const [bpm, setBpm] = useState<number>(loadBpm);
  const [playing, setPlaying] = useState(false);
  const [recState, setRecState] = useState<RecState>("idle");
  const [countdown, setCountdown] = useState(0);
  const [useRecorded, setUseRecorded] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const bpmRef = useRef(bpm);
  bpmRef.current = bpm;
  const useRecordedRef = useRef(useRecorded);
  useRecordedRef.current = useRecorded;
  const recordedBufferRef = useRef<AudioBuffer | null>(null);

  const dotRef = useRef<HTMLDivElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const elapsedTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(BPM_KEY, String(bpm));
    } catch {
      // ignore
    }
  }, [bpm]);

  useEffect(() => {
    if (!playing) return;

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") ctx.resume().catch(() => undefined);

    const lookaheadMs = 25;
    const scheduleAheadSec = 0.1;
    const startTime = ctx.currentTime + 0.05;
    let nextBeatTime = startTime;

    const scheduleDefaultClick = (atTime: number) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(1000, atTime);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, atTime);
      gain.gain.exponentialRampToValueAtTime(0.6, atTime + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.035);
      osc.connect(gain).connect(ctx.destination);
      osc.start(atTime);
      osc.stop(atTime + 0.05);
    };

    const scheduleRecordedClick = (atTime: number, buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(atTime);
    };

    const scheduleClick = (atTime: number) => {
      const buf = recordedBufferRef.current;
      if (useRecordedRef.current && buf) {
        scheduleRecordedClick(atTime, buf);
      } else {
        scheduleDefaultClick(atTime);
      }
    };

    const scheduler = () => {
      while (nextBeatTime < ctx.currentTime + scheduleAheadSec) {
        scheduleClick(nextBeatTime);
        nextBeatTime += 60 / bpmRef.current;
      }
    };
    const interval = window.setInterval(scheduler, lookaheadMs);

    let raf = 0;
    const tick = () => {
      const dot = dotRef.current;
      if (dot) {
        const period = (2 * 60) / bpmRef.current;
        const phase = ((ctx.currentTime - startTime) % period) / period;
        const x = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
        dot.style.left = `${x * 100}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      window.clearInterval(interval);
      cancelAnimationFrame(raf);
      ctx.close().catch(() => undefined);
    };
  }, [playing]);

  // ─── recording ──────────────────────────────────────────────────
  const startRecording = async () => {
    if (recState === "countdown" || recState === "recording") return;
    setRecError(null);

    let stream: MediaStream;
    try {
      if (!window.isSecureContext) {
        throw new Error("microphone needs https");
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.name === "NotAllowedError"
            ? "microphone permission denied"
            : err.message
          : "could not access microphone";
      setRecError(msg);
      return;
    }

    // Live-amplitude analyser tap (separate from MediaRecorder).
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const tmpCtx = new Ctx();
    if (tmpCtx.state === "suspended") {
      await tmpCtx.resume().catch(() => undefined);
    }
    const source = tmpCtx.createMediaStreamSource(stream);
    const analyser = tmpCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    // ── countdown ──
    setRecState("countdown");
    for (let n = 3; n >= 1; n--) {
      setCountdown(n);
      await new Promise((r) => window.setTimeout(r, COUNTDOWN_STEP_MS));
    }
    setCountdown(0);

    // ── recording ──
    setRecState("recording");

    // Clear waveform canvas. Defer by a frame so the canvas is in the DOM
    // (we just transitioned to the recording UI).
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const canvas = waveCanvasRef.current;
    let cssBg = "#fff";
    if (canvas) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const cctx = canvas.getContext("2d");
      if (cctx) {
        cctx.clearRect(0, 0, canvas.width, canvas.height);
        cssBg = getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim() || "#fff";
      }
    }

    const td = new Float32Array(analyser.fftSize);
    const startMs = performance.now();
    let prevX = 0;
    let raf = 0;

    const drawTick = () => {
      const elapsed = performance.now() - startMs;
      const txt = elapsedTextRef.current;
      if (txt) txt.textContent = `${(elapsed / 1000).toFixed(2)} s`;

      analyser.getFloatTimeDomainData(td);
      let peak = 0;
      for (let i = 0; i < td.length; i++) {
        const a = Math.abs(td[i]);
        if (a > peak) peak = a;
      }
      // Soft compression so quiet sounds still register visibly.
      const v = Math.min(1, Math.pow(peak, 0.7));

      if (canvas) {
        const cctx = canvas.getContext("2d");
        if (cctx) {
          const w = canvas.width;
          const h = canvas.height;
          const x = Math.min(w, (elapsed / REC_MAX_MS) * w);
          // Continuous filled strip from previous frame's x to current x.
          // This makes the waveform read as one block of motion sweeping
          // left → right rather than scattered ticks.
          const segWidth = Math.max(1, x - prevX);
          const barH = v * h * 0.85;
          cctx.fillStyle = cssBg;
          cctx.fillRect(prevX, (h - barH) / 2, segWidth, barH);
          // Thin "playhead" line at the leading edge for a clear cursor.
          cctx.fillRect(x - 1, 0, 1, h);
          prevX = x;
        }
      }

      if (elapsed >= REC_MAX_MS) return;
      raf = requestAnimationFrame(drawTick);
    };
    raf = requestAnimationFrame(drawTick);

    // Capture audio with MediaRecorder in parallel.
    const mr = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mr.onstop = async () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      tmpCtx.close().catch(() => undefined);

      try {
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        const arrayBuf = await blob.arrayBuffer();
        const decodeCtx = new Ctx();
        const audioBuf = await decodeCtx.decodeAudioData(arrayBuf);
        decodeCtx.close().catch(() => undefined);

        const maxSamples = audioBuf.sampleRate;
        if (audioBuf.length > maxSamples) {
          const trimmed = new AudioBuffer({
            length: maxSamples,
            sampleRate: audioBuf.sampleRate,
            numberOfChannels: audioBuf.numberOfChannels,
          });
          for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
            trimmed.copyToChannel(
              audioBuf.getChannelData(ch).slice(0, maxSamples),
              ch,
            );
          }
          recordedBufferRef.current = trimmed;
        } else {
          recordedBufferRef.current = audioBuf;
        }
        setRecState("ready");
        setUseRecorded(true);
      } catch (err) {
        console.error("[metronome] decode failed:", err);
        setRecError("recording failed to decode");
        setRecState("idle");
      }
    };
    mr.start();
    window.setTimeout(() => {
      if (mr.state !== "inactive") mr.stop();
    }, REC_MAX_MS);
  };

  const discardRecording = () => {
    recordedBufferRef.current = null;
    setUseRecorded(false);
    setRecState("idle");
  };

  const clamp = (n: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, n));
  const isCapturing =
    recState === "countdown" || recState === "recording";

  return (
    <div className="metronome-tool">
      <div className="metronome-bpm">
        <span className="metronome-bpm-num">{bpm}</span>
        <span className="metronome-bpm-unit">bpm</span>
      </div>

      <div className="metronome-pendulum">
        <div className="metronome-pendulum-track" />
        <div className="metronome-pendulum-dot" ref={dotRef} />
      </div>

      <div className="bpm-controls">
        <button
          type="button"
          className="bpm-btn"
          onClick={() => setBpm((b) => clamp(b - 1))}
          aria-label="Decrease BPM"
        >
          −
        </button>
        <input
          type="range"
          min={BPM_MIN}
          max={BPM_MAX}
          step="1"
          value={bpm}
          onChange={(e) => setBpm(clamp(Number(e.target.value)))}
          className="bpm-slider"
          aria-label="BPM"
        />
        <button
          type="button"
          className="bpm-btn"
          onClick={() => setBpm((b) => clamp(b + 1))}
          aria-label="Increase BPM"
        >
          +
        </button>
      </div>
      <div className="bpm-range">
        <span>{BPM_MIN}</span>
        <span>{BPM_MAX}</span>
      </div>

      <div className="tool-play">
        <button
          type="button"
          className={`btn primary ${playing ? "stop" : ""}`}
          onClick={() => setPlaying((p) => !p)}
        >
          {playing ? "stop" : "play"}
        </button>
      </div>

      <div className="metronome-sound">
        {recState === "idle" && (
          <button
            type="button"
            className="rec-btn"
            onClick={startRecording}
            aria-label="Record click sound"
          >
            <span className="rec-dot" /> record click (1 s)
          </button>
        )}

        {isCapturing && (
          <button
            type="button"
            className={`rec-btn capturing ${
              recState === "recording" ? "recording" : "countdown"
            }`}
            disabled
            aria-live="polite"
          >
            <canvas ref={waveCanvasRef} className="rec-wave-canvas" />
            <span className="rec-btn-overlay">
              {recState === "countdown" ? (
                <strong className="rec-countdown-num">{countdown}</strong>
              ) : (
                <span className="rec-elapsed" ref={elapsedTextRef}>
                  0.00 s
                </span>
              )}
            </span>
          </button>
        )}

        {recState === "ready" && (
          <div className="rec-ready-row">
            <button
              type="button"
              className={`rec-toggle ${useRecorded ? "active" : ""}`}
              onClick={() => setUseRecorded((u) => !u)}
              aria-pressed={useRecorded}
            >
              {useRecorded ? "✓ your sound" : "default click"}
            </button>
            <button
              type="button"
              className="rec-redo"
              onClick={startRecording}
              aria-label="Re-record"
              title="Re-record"
            >
              <span className="rec-dot" />
            </button>
            <button
              type="button"
              className="rec-clear"
              onClick={discardRecording}
              aria-label="Discard recording"
              title="Discard recording"
            >
              ×
            </button>
          </div>
        )}

        {recError && <div className="rec-error">{recError}</div>}
      </div>
    </div>
  );
}
