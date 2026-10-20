export type CoverVisualProfile = {
  source: string;
  aspect: number;
  width: number;
  height: number;
  palette: string[];
  proportions: number[];
  dominantCount: number;
  luminance: Uint8Array;
  edges: Uint8Array;
  detail: Uint8Array;
};

const MAP_SIZE = 96;
export const PALETTE_LIMIT = 10;
const ACCENT_SLOTS = 2;

function toHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function accentHue(red: number, green: number, blue: number) {
  const maximum = Math.max(red, green, blue);
  const difference = maximum - Math.min(red, green, blue);
  if (maximum < 46 || difference / Math.max(1, maximum) < 0.38) return -1;
  const hue = maximum === red ? ((green - blue) / difference) % 6
    : maximum === green ? (blue - red) / difference + 2
      : (red - green) / difference + 4;
  return (((hue * 60) % 360) + 360) % 360;
}

function accentSector(red: number, green: number, blue: number) {
  const hue = accentHue(red, green, blue);
  return hue < 0 ? -1 : Math.floor(hue / 30);
}

function paletteFrom(pixels: Uint8ClampedArray) {
  const bins = new Map<number, { count: number; red: number; green: number; blue: number }>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    const bin = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bin.count += 1;
    bin.red += red;
    bin.green += green;
    bin.blue += blue;
    bins.set(key, bin);
  }

  const candidates = Array.from(bins.values(), (bin) => ({
    count: bin.count,
    red: bin.red / bin.count,
    green: bin.green / bin.count,
    blue: bin.blue / bin.count,
  }));
  const chosen: typeof candidates = [];
  const pickDominant = () => {
    let bestIndex = -1;
    let bestScore = -1;
    candidates.forEach((candidate, index) => {
      const max = Math.max(candidate.red, candidate.green, candidate.blue, 1);
      const min = Math.min(candidate.red, candidate.green, candidate.blue);
      const saturation = (max - min) / max;
      const separation = chosen.length === 0 ? 1 : Math.min(...chosen.map((color) => {
        const dr = candidate.red - color.red;
        const dg = candidate.green - color.green;
        const db = candidate.blue - color.blue;
        return Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
      }));
      const score = Math.sqrt(candidate.count) * (0.58 + saturation * 0.42)
        * (0.2 + separation * 0.8);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex < 0) return false;
    chosen.push(candidates.splice(bestIndex, 1)[0]);
    return true;
  };
  while (chosen.length < PALETTE_LIMIT - ACCENT_SLOTS && candidates.length > 0 && pickDominant()) {
    // Leave a few slots for small, distinct hue families.
  }
  const dominantCount = chosen.length;

  const hueCounts = new Uint32Array(12);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const sector = accentSector(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    if (sector >= 0) hueCounts[sector] += 1;
  }
  const minimumAccentPixels = Math.max(8, Math.floor(pixels.length / 4 * 0.006));
  for (let accent = 0; accent < ACCENT_SLOTS && chosen.length < PALETTE_LIMIT; accent += 1) {
    let bestIndex = -1;
    let bestScore = -1;
    candidates.forEach((candidate, index) => {
      const sector = accentSector(candidate.red, candidate.green, candidate.blue);
      const hue = accentHue(candidate.red, candidate.green, candidate.blue);
      if (sector < 0 || hueCounts[sector] < minimumAccentPixels || chosen.some((color) => {
        const existing = accentHue(color.red, color.green, color.blue);
        const distance = Math.abs(existing - hue);
        return existing >= 0 && Math.min(distance, 360 - distance) < 32;
      })) return;
      const separation = Math.min(...chosen.map((color) => Math.hypot(
        candidate.red - color.red, candidate.green - color.green, candidate.blue - color.blue,
      ) / 441.673));
      if (separation < 0.1) return;
      const maximum = Math.max(candidate.red, candidate.green, candidate.blue);
      const saturation = (maximum - Math.min(candidate.red, candidate.green, candidate.blue)) / maximum;
      const score = Math.sqrt(hueCounts[sector]) * Math.pow(saturation, 2)
        * Math.pow(candidate.count, 0.15) * separation * separation;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex < 0) break;
    chosen.push(candidates.splice(bestIndex, 1)[0]);
  }
  while (chosen.length < PALETTE_LIMIT && candidates.length > 0 && pickDominant()) {
    // Minimal covers can use more shades in place of distinct accents.
  }

  const proportions = new Array(chosen.length).fill(0) as number[];
  const representativeCount = Math.max(1, dominantCount);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    let closest = 0;
    let distance = Infinity;
    chosen.slice(0, representativeCount).forEach((color, index) => {
      const dr = red - color.red;
      const dg = green - color.green;
      const db = blue - color.blue;
      const next = dr * dr + dg * dg + db * db;
      if (next < distance) { distance = next; closest = index; }
    });
    proportions[closest] += 1;
  }
  const total = proportions.reduce((sum, count) => sum + count, 0) || 1;
  const accentWeights = chosen.map((color, index) => {
    if (index < dominantCount) return 0;
    const sector = accentSector(color.red, color.green, color.blue);
    return sector < 0 ? 0 : Math.min(0.025, hueCounts[sector] / (pixels.length / 4));
  });
  const accentTotal = Math.min(0.12, accentWeights.reduce((sum, weight) => sum + weight, 0));
  return {
    colors: chosen.map((color) => toHex(color.red, color.green, color.blue)),
    proportions: proportions.map((count, index) => index < dominantCount
      ? count / total * (1 - accentTotal) : accentWeights[index]),
    dominantCount,
  };
}

export async function analyzeCover(source: string): Promise<CoverVisualProfile> {
  const image = new Image();
  image.decoding = 'async';
  image.src = source;
  await image.decode();

  const aspect = image.naturalWidth / image.naturalHeight;
  const width = aspect >= 1 ? MAP_SIZE : Math.max(1, Math.round(MAP_SIZE * aspect));
  const height = aspect < 1 ? MAP_SIZE : Math.max(1, Math.round(MAP_SIZE / aspect));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser could not analyze the cover image.');
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const count = width * height;
  const luminance = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    luminance[index] = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
  }

  const edgesRaw = new Float32Array(count);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = y * width + x;
      const gx = -luminance[at - width - 1] + luminance[at - width + 1]
        - 2 * luminance[at - 1] + 2 * luminance[at + 1]
        - luminance[at + width - 1] + luminance[at + width + 1];
      const gy = -luminance[at - width - 1] - 2 * luminance[at - width] - luminance[at - width + 1]
        + luminance[at + width - 1] + 2 * luminance[at + width] + luminance[at + width + 1];
      edgesRaw[at] = Math.hypot(gx, gy);
    }
  }
  const edgeScale = Math.max(1, Array.from(edgesRaw).sort((a, b) => a - b)[Math.floor(count * 0.96)] || 1);
  const edges = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) edges[i] = Math.round(Math.min(1, edgesRaw[i] / edgeScale) * 255);

  const detail = new Uint8Array(count);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let samples = 0;
      for (let oy = -2; oy <= 2; oy += 1) {
        for (let ox = -2; ox <= 2; ox += 1) {
          const sx = Math.max(0, Math.min(width - 1, x + ox));
          const sy = Math.max(0, Math.min(height - 1, y + oy));
          sum += edges[sy * width + sx];
          samples += 1;
        }
      }
      detail[y * width + x] = Math.round(sum / samples);
    }
  }

  const palette = paletteFrom(pixels);
  return {
    source,
    aspect,
    width,
    height,
    palette: palette.colors,
    proportions: palette.proportions,
    dominantCount: palette.dominantCount,
    luminance: Uint8Array.from(luminance, (value) => Math.round(value)),
    edges,
    detail,
  };
}
