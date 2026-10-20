export type AudioAnalysis = {
  schemaVersion: 1;
  audio: { fileName: string; sha256: string; durationSeconds: number; analysisSampleRate: number };
  analysis: {
    model: string;
    checkpoint: string;
    beatThisVersion: string;
    device: string;
    librosaVersion: string;
    [key: string]: unknown;
  };
  beats: number[];
  downbeats: number[];
  tempoEstimates: { timeSeconds: number; bpm: number }[];
  features: { times: number[]; rms: number[]; brightness: number[]; onsetStrength: number[] };
};

function assertOrderedTimes(values: unknown, duration: number, label: string): asserts values is number[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${label} must be a list of finite timestamps.`);
  }
  let previous = -1;
  for (const value of values) {
    if (value < 0 || value > duration || value <= previous) {
      throw new Error(`${label} timestamps must be strictly ordered and within the track duration.`);
    }
    previous = value;
  }
}

export async function validateMatchingAnalysis(parsed: unknown, audio: File): Promise<AudioAnalysis> {
  if (!parsed || typeof parsed !== 'object') throw new Error('The analysis file is missing its data.');
  const data = parsed as Partial<AudioAnalysis>;
  if (data.schemaVersion !== 1 || !data.audio || !data.analysis || !data.features) {
    throw new Error('Unsupported analysis file or schema version.');
  }
  if (data.analysis.model !== 'Beat This!' || typeof data.analysis.checkpoint !== 'string') {
    throw new Error('The JSON does not contain Beat This! beat-tracker output.');
  }
  const duration = data.audio.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('Analysis file has an invalid track duration.');
  }
  const curves = data.features;
  assertOrderedTimes(curves.times, duration, 'Feature');
  for (const key of ['rms', 'brightness', 'onsetStrength'] as const) {
    const curve = curves[key];
    if (!Array.isArray(curve) || curve.length !== curves.times.length || curve.some((value) =>
      typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1
    )) {
      throw new Error(`Analysis feature curve “${key}” is malformed.`);
    }
  }
  assertOrderedTimes(data.beats, duration, 'Beat');
  assertOrderedTimes(data.downbeats, duration, 'Downbeat');
  if (!Array.isArray(data.tempoEstimates) || data.tempoEstimates.some((item) =>
    !item || !Number.isFinite(item.timeSeconds) || item.timeSeconds < 0 || item.timeSeconds > duration ||
    !Number.isFinite(item.bpm) || item.bpm <= 0
  ) || data.tempoEstimates.some((item, index, array) => index > 0 && item.timeSeconds <= array[index - 1].timeSeconds)) {
    throw new Error('Local tempo estimates must be ordered and within the track duration.');
  }
  if (!/^[a-f\d]{64}$/i.test(data.audio.sha256)) throw new Error('Analysis file has no valid audio hash.');

  const hashBuffer = await crypto.subtle.digest('SHA-256', await audio.arrayBuffer());
  const hash = Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash.toLowerCase() !== data.audio.sha256.toLowerCase()) {
    throw new Error('This analysis belongs to a different audio file. Load the matching audio, then its JSON analysis.');
  }
  return data as AudioAnalysis;
}

export function interpolateCurve(times: number[], values: number[], time: number): number {
  if (times.length === 0 || values.length !== times.length || time < times[0] || time > times[times.length - 1]) return 0;
  let low = 0;
  let high = times.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle;
    else high = middle;
  }
  const span = times[high] - times[low];
  if (span <= 0) return values[low];
  const amount = (time - times[low]) / span;
  return values[low] + (values[high] - values[low]) * amount;
}

export function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}
