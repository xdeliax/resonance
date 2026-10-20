import type { AudioAnalysis } from './analysis';
import type { CoverVisualProfile } from './coverProfile';

type Levels = { rms: number; brightness: number; onset: number };

export type VisualCue = {
  time: number;
  palette: number;
  direction: number;
  currentScale: number;
  foldScale: number;
  swirl: number;
  sweep: number;
  centerX: number;
  centerY: number;
  motion: number;
  transition: number;
  reason: 'opening' | 'lift' | 'shift';
};

export type VisualState = {
  fromPalette: number;
  toPalette: number;
  blend: number;
  direction: number;
  currentScale: number;
  foldScale: number;
  swirl: number;
  sweep: number;
  centerX: number;
  centerY: number;
};

export type VisualScore = {
  palettes: number[][];
  cues: VisualCue[];
  sample: (playbackTime: number) => VisualState;
};

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const ease = (value: number) => { const x = clamp(value, 0, 1); return x * x * (3 - 2 * x); };

function paletteVariants(profile: CoverVisualProfile) {
  const count = Math.min(profile.palette.length, profile.dominantCount);
  const base = profile.palette.map((_, index) => index);
  const variants = [base];
  if (count < 2) return variants;
  const swatch = profile.palette.map((hex) => {
    const color = Number.parseInt(hex.slice(1), 16);
    const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
    const top = Math.max(r, g, b), bottom = Math.min(r, g, b);
    return { r, g, b, light: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
      saturation: (top - bottom) / Math.max(1, top) };
  });
  const choose = (indices: number[], score: (index: number) => number) =>
    indices.reduce((best, index) => score(index) > score(best) ? index : best, indices[0]);
  const main = Array.from({ length: count }, (_, index) => index);
  const warm = choose(main, (index) => {
    const { r, g, b, saturation } = swatch[index];
    return saturation * (r / 255) * (0.5 + (r - b) / 510) * (0.8 + g / 510);
  });
  const pale = choose(main, (index) => swatch[index].light - swatch[index].saturation * 0.13);
  const cool = choose(main, (index) => {
    const { r, g, b, saturation } = swatch[index];
    return saturation * ((g + b) / 510) * (1 - r / 510);
  });
  const dark = choose(main, (index) => 1 - swatch[index].light);
  const accents = Array.from({ length: profile.palette.length - count }, (_, index) => count + index);
  const accent = accents.length ? choose(accents, (index) =>
    swatch[index].saturation * (0.3 + (profile.proportions[index] ?? 0) * 7)) : dark;
  // A variant changes which cover pigment fills the broadest material band.
  // The other swatches remain available, and the original palette is retained.
  for (const focus of [warm, pale, cool, dark, accent]) {
    const next = [...base];
    next[count - 1] = focus;
    next[focus] = count - 1;
    if (!variants.some((variant) => variant.every((index, slot) => index === next[slot]))) variants.push(next);
  }
  return variants;
}

function curveAverages(analysis: AudioAnalysis) {
  const { times, rms, brightness, onsetStrength } = analysis.features;
  const prefix = (values: number[]) => {
    const sums = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i += 1) sums[i + 1] = sums[i] + values[i];
    return sums;
  };
  const sums = { rms: prefix(rms), brightness: prefix(brightness), onset: prefix(onsetStrength) };
  const lowerBound = (time: number) => {
    let low = 0, high = times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (times[middle] < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (start: number, end: number): Levels => {
    const first = lowerBound(Math.max(0, start));
    const last = lowerBound(Math.min(analysis.audio.durationSeconds, end));
    const count = Math.max(1, last - first);
    return { rms: (sums.rms[last] - sums.rms[first]) / count,
      brightness: (sums.brightness[last] - sums.brightness[first]) / count,
      onset: (sums.onset[last] - sums.onset[first]) / count };
  };
}

/** Build a repeatable, song-time score. Cues use detected downbeats when available. */
export function buildVisualScore(analysis: AudioAnalysis, profile: CoverVisualProfile): VisualScore {
  const palettes = paletteVariants(profile);
  const average = curveAverages(analysis);
  const duration = analysis.audio.durationSeconds;
  const cues: VisualCue[] = [{ time: 0, palette: 0, direction: 0, currentScale: 1, foldScale: 1,
    swirl: 0, sweep: 0, centerX: 0.5, centerY: 0.5, motion: 0,
    transition: 0, reason: 'opening' }];
  const musicalAnchors = analysis.downbeats.length > 1 ? analysis.downbeats
    : analysis.beats.length > 1 ? analysis.beats
      : Array.from({ length: Math.floor(duration / 2) }, (_, index) => (index + 1) * 2);
  const strongArrivals = new Set(musicalAnchors.filter((time) => {
    if (time < 7 || time > duration - 4) return false;
    const before = average(time - 3, time - 0.4);
    const arrival = average(time, time + 1.5);
    return (arrival.rms - before.rms) * 1.5 + (arrival.onset - before.onset) * 0.6 > 0.16
      && arrival.rms > 0.34;
  }));
  for (const time of musicalAnchors) {
    if (time < 7 || time > duration - 4) continue;
    const previous = cues[cues.length - 1];
    const gap = time - previous.time;
    if (gap < 7.5) continue;
    const before = average(time - 3, time - 0.4);
    const after = average(time + 0.5, time + 6);
    const contrast = Math.abs(after.rms - before.rms) + Math.abs(after.brightness - before.brightness) * 0.5
      + Math.abs(after.onset - before.onset) * 0.6;
    const lift = strongArrivals.has(time) && gap >= 8;
    const approachingLift = !lift && musicalAnchors.some((anchor) =>
      anchor > time && anchor - time <= 6 && strongArrivals.has(anchor));
    if (approachingLift) continue;
    if (!lift && !(gap >= 13 && contrast > 0.13) && gap < 22) continue;

    // Musical energy chooses the broad pigment emphasis. A steady passage still
    // develops at phrase boundaries; it never locks into one look indefinitely.
    let palette = 0;
    if (palettes.length > 1) {
      const normalized = clamp(after.rms * 0.45 + after.brightness * 0.28 + after.onset * 0.27, 0, 0.999);
      palette = 1 + Math.min(palettes.length - 2, Math.floor(normalized * (palettes.length - 1)));
      if (lift) palette = palettes.length - 1;
      if (palette === previous.palette) palette = palette % (palettes.length - 1) + 1;
    }
    const section = cues.length;
    let motion = lift ? 3 : after.rms < 0.34 ? 0 : after.onset > 0.56 ? 1 : 2;
    if (motion === previous.motion) motion = lift ? 1 : (motion + 1) % 4;
    const motions = [
      { swirl: 0.14, sweep: 0.22 }, // broad meander
      { swirl: 1.0, sweep: 0.12 },  // eddy
      { swirl: 0.22, sweep: 1.0 },  // crossing current
      { swirl: 0.74, sweep: 0.68 }, // lift and release
    ];
    let direction = clamp((after.brightness - 0.5) * 1.55 + (after.onset - after.rms) * 1.15
      + Math.sin(section * 2.15) * 0.85, -1.35, 1.35);
    if (Math.abs(direction - previous.direction) < 0.38) {
      direction = clamp(direction + (section % 2 ? 0.56 : -0.56), -1.35, 1.35);
    }
    cues.push({ time, palette, direction,
      currentScale: clamp(0.8 + after.brightness * 0.45 + after.onset * 0.25 + (lift ? 0.1 : 0), 0.78, 1.45),
      foldScale: clamp(0.78 + after.onset * 0.44 + after.rms * 0.3 + (lift ? 0.12 : 0), 0.78, 1.5),
      swirl: motions[motion].swirl, sweep: motions[motion].sweep,
      centerX: clamp(0.25 + after.brightness * 0.5 + Math.sin(section * 1.7) * 0.1, 0.2, 0.8),
      centerY: clamp(0.25 + after.rms * 0.5 + Math.cos(section * 1.3) * 0.1, 0.2, 0.8),
      motion,
      transition: lift ? 1.7 : 3.4, reason: lift ? 'lift' : 'shift' });
  }

  const sample = (playbackTime: number): VisualState => {
    const time = clamp(playbackTime, 0, duration);
    let index = 0;
    let low = 0, high = cues.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cues[middle].time <= time) low = middle + 1;
      else high = middle;
    }
    index = Math.max(0, low - 1);
    const current = cues[index];
    const prior = cues[Math.max(0, index - 1)];
    const blend = current.transition > 0 ? ease((time - current.time) / current.transition) : 1;
    const mix = (a: number, b: number) => a + (b - a) * blend;
    return { fromPalette: prior.palette, toPalette: current.palette, blend,
      direction: mix(prior.direction, current.direction),
      currentScale: mix(prior.currentScale, current.currentScale),
      foldScale: mix(prior.foldScale, current.foldScale),
      swirl: mix(prior.swirl, current.swirl), sweep: mix(prior.sweep, current.sweep),
      centerX: mix(prior.centerX, current.centerX), centerY: mix(prior.centerY, current.centerY) };
  };
  return { palettes, cues, sample };
}
