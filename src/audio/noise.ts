// Shared white / pink noise buffer generators. Used by both the sound
// generator (per-slot type) and the noise generator (single source). Pre-
// rendered into AudioBuffers and looped via AudioBufferSourceNode rather
// than synthesised live in a ScriptProcessor — cheaper at runtime, plays
// nicely with iOS audio thread restrictions.

// White noise: each sample is independent uniform random in [-1, 1].
export function createWhiteNoiseBuffer(
  ctx: AudioContext,
  seconds: number,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

// Pink noise via Paul Kellet's filter — a real-time-safe approximation of
// the 1/f spectrum. Cheaper than spectral methods and runs in a single
// pass over the buffer.
export function createPinkNoiseBuffer(
  ctx: AudioContext,
  seconds: number,
): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buf;
}
