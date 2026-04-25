import { useCallback, useEffect, useRef, useState } from "react";

export type AudioStatus = "idle" | "starting" | "running" | "error";

export interface AudioAnalyser {
  status: AudioStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  analyser: AnalyserNode | null;
  sampleRate: number;
  fftSize: number;
}

const FFT_SIZE = 8192;

export function useAudioAnalyser(): AudioAnalyser {
  const [status, setStatus] = useState<AudioStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [sampleRate, setSampleRate] = useState<number>(48000);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const stop = useCallback(() => {
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (ctxRef.current && ctxRef.current.state !== "closed") {
      ctxRef.current.close().catch(() => undefined);
    }
    ctxRef.current = null;
    setAnalyser(null);
    setStatus("idle");
    setError(null);
  }, []);

  const start = useCallback(async () => {
    setStatus("starting");
    setError(null);
    try {
      if (!window.isSecureContext) {
        throw new Error(
          "Microphone access requires a secure context (HTTPS). Open this page over https:// or on localhost.",
        );
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "This browser does not expose microphone access.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
        video: false,
      });
      streamRef.current = stream;

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      const node = ctx.createAnalyser();
      node.fftSize = FFT_SIZE;
      node.smoothingTimeConstant = 0.6;
      source.connect(node);

      setAnalyser(node);
      setSampleRate(ctx.sampleRate);
      setStatus("running");
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "NotAllowedError"
            ? "Microphone permission denied. Allow it in your browser to use the meter."
            : e.message
          : "Could not access the microphone.";
      setError(msg);
      setStatus("error");
      stop();
    }
  }, [stop]);

  useEffect(() => () => stop(), [stop]);

  return {
    status,
    error,
    start,
    stop,
    analyser,
    sampleRate,
    fftSize: FFT_SIZE,
  };
}
