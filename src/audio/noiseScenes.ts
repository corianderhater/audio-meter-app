// Noise scenes for the noise generator. Each scene returns an AudioNode
// to plug into the rest of the chain (highpass → lowpass → master) and a
// stop() function for full teardown.
//
// Scenes are pure Web Audio synthesis — no samples, no recordings — so the
// bundle stays small and everything works fully offline. The trick for the
// nature scenes is layering: a filtered base loop for the steady ambience,
// plus a setTimeout-driven burst scheduler for transients (crackles in
// fire, droplets in water).

export type NoiseType = "white" | "pink" | "fire" | "forest" | "water";

export interface NoiseScene {
  output: AudioNode;
  stop: () => void;
}

export function buildNoiseScene(
  ctx: AudioContext,
  type: NoiseType,
  whiteBuffer: AudioBuffer,
  pinkBuffer: AudioBuffer,
): NoiseScene {
  switch (type) {
    case "white":
      return buildPlainScene(ctx, whiteBuffer);
    case "pink":
      return buildPlainScene(ctx, pinkBuffer);
    case "fire":
      return buildFireScene(ctx, pinkBuffer, whiteBuffer);
    case "forest":
      return buildForestScene(ctx, pinkBuffer);
    case "water":
      return buildWaterScene(ctx, whiteBuffer);
  }
}

function buildPlainScene(
  ctx: AudioContext,
  buffer: AudioBuffer,
): NoiseScene {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return {
    output: src,
    stop: () => {
      try {
        src.stop();
      } catch {
        // already stopped
      }
      try {
        src.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// Fire: low-passed pink noise for the warm wood rumble + random crackle
// bursts (short, high-passed, fast attack/decay). Crackle rate roughly
// 4–15 per second to evoke a burning fireplace.
function buildFireScene(
  ctx: AudioContext,
  pinkBuffer: AudioBuffer,
  whiteBuffer: AudioBuffer,
): NoiseScene {
  const out = ctx.createGain();
  out.gain.value = 1;

  // Steady warm rumble.
  const base = ctx.createBufferSource();
  base.buffer = pinkBuffer;
  base.loop = true;
  const baseLp = ctx.createBiquadFilter();
  baseLp.type = "lowpass";
  baseLp.frequency.value = 1400;
  baseLp.Q.value = 0.7;
  const baseGain = ctx.createGain();
  baseGain.gain.value = 0.55;
  base.connect(baseLp).connect(baseGain).connect(out);
  base.start();

  // Crackle scheduler.
  let stopped = false;
  let timeoutId: number | null = null;
  const schedule = () => {
    if (stopped) return;
    const burst = ctx.createBufferSource();
    burst.buffer = whiteBuffer;
    burst.loop = false;
    const offset = Math.random() * Math.max(0, whiteBuffer.duration - 0.1);

    const burstHp = ctx.createBiquadFilter();
    burstHp.type = "highpass";
    burstHp.frequency.value = 2200 + Math.random() * 2500;
    burstHp.Q.value = 1.2;

    const env = ctx.createGain();
    const peak = 0.35 + Math.random() * 0.45;
    const decay = 0.02 + Math.random() * 0.06;
    const t0 = ctx.currentTime;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.001);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.001 + decay);

    burst.connect(burstHp).connect(env).connect(out);
    burst.start(t0, offset);
    burst.stop(t0 + 0.001 + decay + 0.02);

    const nextDelay = 30 + Math.random() * 220;
    timeoutId = window.setTimeout(schedule, nextDelay);
  };
  timeoutId = window.setTimeout(schedule, 80);

  return {
    output: out,
    stop: () => {
      stopped = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        base.stop();
      } catch {
        // ignore
      }
      try {
        out.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// Forest: heavily low-passed pink noise (wind through canopy) with a
// slow LFO modulating the gain to give it gusts. A second higher-passed
// layer adds a quieter rustle on top.
function buildForestScene(
  ctx: AudioContext,
  pinkBuffer: AudioBuffer,
): NoiseScene {
  const out = ctx.createGain();
  out.gain.value = 1;

  // Wind layer.
  const wind = ctx.createBufferSource();
  wind.buffer = pinkBuffer;
  wind.loop = true;
  const windLp = ctx.createBiquadFilter();
  windLp.type = "lowpass";
  windLp.frequency.value = 450;
  windLp.Q.value = 0.7;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.7;
  wind.connect(windLp).connect(windGain).connect(out);
  wind.start();

  // Rustle layer (higher pink, narrower band) — gives the canopy character.
  const rustle = ctx.createBufferSource();
  rustle.buffer = pinkBuffer;
  rustle.loop = true;
  const rustleHp = ctx.createBiquadFilter();
  rustleHp.type = "highpass";
  rustleHp.frequency.value = 1500;
  const rustleLp = ctx.createBiquadFilter();
  rustleLp.type = "lowpass";
  rustleLp.frequency.value = 5500;
  const rustleGain = ctx.createGain();
  rustleGain.gain.value = 0.18;
  rustle.connect(rustleHp).connect(rustleLp).connect(rustleGain).connect(out);
  rustle.start();

  // Slow LFO for gusts (modulates the wind layer's gain around 0.7 ± 0.4).
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.08; // ~12s period
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.4;
  lfo.connect(lfoDepth).connect(windGain.gain);
  lfo.start();

  return {
    output: out,
    stop: () => {
      try {
        wind.stop();
      } catch {
        // ignore
      }
      try {
        rustle.stop();
      } catch {
        // ignore
      }
      try {
        lfo.stop();
      } catch {
        // ignore
      }
      try {
        out.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// Water: band-passed white noise around 2.5 kHz for the "shhh" of running
// water/rain, with occasional band-passed drop bursts on top.
function buildWaterScene(
  ctx: AudioContext,
  whiteBuffer: AudioBuffer,
): NoiseScene {
  const out = ctx.createGain();
  out.gain.value = 1;

  // Steady "shhh".
  const base = ctx.createBufferSource();
  base.buffer = whiteBuffer;
  base.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2500;
  bp.Q.value = 0.6;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 6500;
  const baseGain = ctx.createGain();
  baseGain.gain.value = 0.75;
  base.connect(bp).connect(lp).connect(baseGain).connect(out);
  base.start();

  // Drop scheduler.
  let stopped = false;
  let timeoutId: number | null = null;
  const schedule = () => {
    if (stopped) return;
    const drop = ctx.createBufferSource();
    drop.buffer = whiteBuffer;
    drop.loop = false;
    const offset = Math.random() * Math.max(0, whiteBuffer.duration - 0.1);

    const dropBp = ctx.createBiquadFilter();
    dropBp.type = "bandpass";
    dropBp.frequency.value = 700 + Math.random() * 2800;
    dropBp.Q.value = 6;

    const env = ctx.createGain();
    const peak = 0.25 + Math.random() * 0.35;
    const decay = 0.04 + Math.random() * 0.08;
    const t0 = ctx.currentTime;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.002 + decay);

    drop.connect(dropBp).connect(env).connect(out);
    drop.start(t0, offset);
    drop.stop(t0 + 0.002 + decay + 0.02);

    const nextDelay = 40 + Math.random() * 220;
    timeoutId = window.setTimeout(schedule, nextDelay);
  };
  timeoutId = window.setTimeout(schedule, 80);

  return {
    output: out,
    stop: () => {
      stopped = true;
      if (timeoutId != null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      try {
        base.stop();
      } catch {
        // ignore
      }
      try {
        out.disconnect();
      } catch {
        // ignore
      }
    },
  };
}
