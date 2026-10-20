import { interpolateCurve, lowerBound, type AudioAnalysis } from './analysis';

export type AudioFeatures = {
  bass: number;
  mid: number;
  high: number;
  beat: number;
  beatAge: number;
  beatPulse: number;
  downbeatPulse: number;
  beatPhase: number;
  rms: number;
  brightness: number;
  onsetStrength: number;
  playbackTime: number;
  analysisMapped: boolean;
};

const silent: AudioFeatures = {
  bass: 0, mid: 0, high: 0, beat: 0, beatAge: 10,
  beatPulse: 0, downbeatPulse: 0, beatPhase: 0,
  rms: 0, brightness: 0, onsetStrength: 0, playbackTime: 0, analysisMapped: false,
};

/** Local-only Web Audio analysis for a user-selected audio file. */
export class LocalAudioTrack {
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private source?: MediaElementAudioSourceNode;
  // Initialize with an ArrayBuffer-backed view so newer TypeScript DOM types
  // accept it in AnalyserNode.getByteFrequencyData.
  private bins = new Uint8Array(0);
  private previousBins = new Uint8Array(0);
  private url?: string;
  private fluxFloor = 0;
  private bandReference = { bass: 0, mid: 0, high: 0 };
  private hasBandReference = false;
  private beatCooldown = 0;
  private lastSampleTime = 0;
  private lastPublishTime = 0;
  private analysis?: AudioAnalysis;
  private lastAnalysisTime = 0;
  private analysisWasPlaying = false;
  private beatCursor = 0;
  private downbeatCursor = 0;
  private beatPulse = 0;
  private downbeatPulse = 0;
  private lastPulseSample = 0;
  private seekDetected = false;
  private features: AudioFeatures = { ...silent };

  constructor(private audio: HTMLAudioElement, private onFeatures?: (features: AudioFeatures) => void) {
    this.audio.addEventListener('seeking', this.handleSeeking);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  private handleSeeking = () => {
    this.seekDetected = true;
  };

  private handleVisibility = () => {
    if (document.hidden) {
      this.analysisWasPlaying = false;
      this.lastAnalysisTime = this.audio.currentTime || 0;
    }
  };

  load(file: File) {
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
    this.audio.load();
    this.fluxFloor = 0;
    this.bandReference = { bass: 0, mid: 0, high: 0 };
    this.hasBandReference = false;
    this.beatCooldown = 0;
    this.lastSampleTime = 0;
    this.setAnalysis(null);
    this.features = { ...silent };
    this.publish(true);
  }

  async play() {
    this.connect();
    await this.context?.resume();
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
    this.analysisWasPlaying = false;
  }

  get isPlaying() { return !this.audio.paused; }

  setAnalysis(analysis: AudioAnalysis | null) {
    this.analysis = analysis ?? undefined;
    this.analysisWasPlaying = false;
    this.lastAnalysisTime = this.audio.currentTime || 0;
    this.beatCursor = analysis ? lowerBound(analysis.beats, this.lastAnalysisTime) : 0;
    this.downbeatCursor = analysis ? lowerBound(analysis.downbeats, this.lastAnalysisTime) : 0;
    this.beatPulse = 0;
    this.downbeatPulse = 0;
    this.publish(true);
  }

  private connect() {
    if (this.analyser) return;
    const AudioContextConstructor = window.AudioContext;
    this.context = new AudioContextConstructor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.48;
    this.source = this.context.createMediaElementSource(this.audio);
    this.source.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.previousBins = new Uint8Array(this.analyser.frequencyBinCount);
  }

  /** Return current live spectrum features plus time-synchronized saved analysis. */
  sample(): AudioFeatures {
    const now = performance.now();
    const delta = this.lastSampleTime ? Math.min((now - this.lastSampleTime) / 1000, 0.05) : 1 / 60;
    this.lastSampleTime = now;
    if (!this.analyser || this.audio.paused) {
      this.features.bass *= 0.9;
      this.features.mid *= 0.9;
      this.features.high *= 0.9;
      this.features.beat *= 0.82;
      this.features.beatAge = 10;
    } else {
      this.analyser.getByteFrequencyData(this.bins);
      const nyquist = (this.context?.sampleRate ?? 44100) / 2;
      const energyBetween = (lowHz: number, highHz: number) => {
        const low = Math.max(0, Math.floor(lowHz / nyquist * this.bins.length));
        const high = Math.min(this.bins.length, Math.ceil(highHz / nyquist * this.bins.length));
        let total = 0;
        for (let i = low; i < high; i += 1) total += this.bins[i] / 255;
        return high > low ? total / (high - low) : 0;
      };

      const bassRaw = energyBetween(35, 180);
      const midRaw = energyBetween(180, 2400);
      const highRaw = energyBetween(2400, 9000);

    // Track each band's recent average and express motion relative to that
    // level. Fixed multipliers quickly pegged all three meters at 100% for
    // loud masters, leaving no visible room for musical dynamics.
      if (!this.hasBandReference) {
        this.bandReference = { bass: bassRaw, mid: midRaw, high: highRaw };
        this.hasBandReference = true;
      }
      const adaptReference = (reference: number, value: number) => reference + (value - reference) * (value < reference ? 0.035 : 0.012);
      const relativeLevel = (value: number, reference: number, minimumRange: number) =>
        Math.max(0, Math.min(1, 0.42 + (value - reference) / Math.max(reference * 0.32, minimumRange) * 0.48));
      const bassLevel = relativeLevel(bassRaw, this.bandReference.bass, 0.006);
      const midLevel = relativeLevel(midRaw, this.bandReference.mid, 0.006);
      const highLevel = relativeLevel(highRaw, this.bandReference.high, 0.004);
      this.bandReference = {
        bass: adaptReference(this.bandReference.bass, bassRaw),
        mid: adaptReference(this.bandReference.mid, midRaw),
        high: adaptReference(this.bandReference.high, highRaw),
      };

    // Spectral flux catches new low-frequency energy (kick and bass attacks)
    // instead of treating a sustained bass note as a stream of beats.
      const lowBin = Math.max(1, Math.floor(35 / nyquist * this.bins.length));
      const highBin = Math.min(this.bins.length, Math.ceil(220 / nyquist * this.bins.length));
      let flux = 0;
      for (let i = lowBin; i < highBin; i += 1) {
        flux += Math.max(0, (this.bins[i] - this.previousBins[i]) / 255);
        this.previousBins[i] = this.bins[i];
      }
      flux /= Math.max(1, highBin - lowBin);
      const beatHit = flux > Math.max(0.002, this.fluxFloor * 1.55) && this.beatCooldown <= 0;
      this.fluxFloor += (flux - this.fluxFloor) * (flux < this.fluxFloor ? 0.035 : 0.008);
      this.beatCooldown = beatHit ? 0.18 : Math.max(0, this.beatCooldown - delta);
      this.features.beatAge = beatHit ? 0 : this.features.beatAge + delta;

    const smooth = (old: number, next: number, amount: number) => old + (next - old) * amount;
      this.features = {
        ...this.features,
        bass: smooth(this.features.bass, bassLevel, 0.3),
        mid: smooth(this.features.mid, midLevel, 0.22),
        high: smooth(this.features.high, highLevel, 0.28),
        beat: Math.max(beatHit ? 1 : 0, this.features.beat * Math.exp(-delta * 5.5)),
        beatAge: this.features.beatAge,
      };
      this.previousBins.set(this.bins);
    }

    const saved = this.sampleSavedAnalysis(now);
    this.features = {
      ...this.features,
      ...saved,
      playbackTime: this.audio.currentTime || 0,
      analysisMapped: Boolean(this.analysis),
    };
    this.publish();
    return this.features;
  }

  private publish(force = false) {
    const now = performance.now();
    if (!force && now - this.lastPublishTime < 100) return;
    this.lastPublishTime = now;
    this.onFeatures?.({ ...this.features });
  }

  private sampleSavedAnalysis(now: number) {
    if (!this.analysis) {
      this.beatPulse = this.features.beat;
      this.downbeatPulse = 0;
      return {
        beatPulse: this.beatPulse,
        downbeatPulse: this.downbeatPulse,
        beatPhase: 0,
        rms: (this.features.bass + this.features.mid + this.features.high) / 3,
        brightness: this.features.high,
        onsetStrength: this.features.beat,
      };
    }

    const wallDelta = this.lastPulseSample ? Math.max(0, (now - this.lastPulseSample) / 1000) : 0;
    this.lastPulseSample = now;
    this.beatPulse *= Math.exp(-wallDelta / 0.12);
    this.downbeatPulse *= Math.exp(-wallDelta / 0.28);
    const time = this.audio.currentTime || 0;
    const playing = !this.audio.paused && !this.audio.seeking;
    const previousTime = this.lastAnalysisTime;
    const delta = time - previousTime;
    const discontinuity = !this.analysisWasPlaying || delta <= 0 || delta > 0.25 || this.audio.seeking;
    const seeking = discontinuity || this.seekDetected;
    this.seekDetected = false;

    if (!playing || seeking) {
      this.beatCursor = lowerBound(this.analysis.beats, time + 0.001);
      this.downbeatCursor = lowerBound(this.analysis.downbeats, time + 0.001);
      if (seeking) {
        this.beatPulse = 0;
        this.downbeatPulse = 0;
      }
    } else {
      while (this.beatCursor < this.analysis.beats.length && this.analysis.beats[this.beatCursor] <= time + 0.001) {
        const beatTime = this.analysis.beats[this.beatCursor++];
        if (beatTime > previousTime + 0.001) this.beatPulse = 1;
      }
      while (this.downbeatCursor < this.analysis.downbeats.length && this.analysis.downbeats[this.downbeatCursor] <= time + 0.001) {
        const downbeatTime = this.analysis.downbeats[this.downbeatCursor++];
        if (downbeatTime > previousTime + 0.001) {
          this.downbeatPulse = 1;
          this.beatPulse = Math.min(this.beatPulse, 0.48);
        }
      }
    }
    this.analysisWasPlaying = playing;
    this.lastAnalysisTime = time;

    // Shift the search by a tiny epsilon so phase is 0 exactly on a beat,
    // then rises toward 1 before the next detected beat.
    const beatIndex = lowerBound(this.analysis.beats, time + 1e-6);
    const previousBeat = this.analysis.beats[Math.max(0, beatIndex - 1)];
    const nextBeat = this.analysis.beats[beatIndex];
    const beatPhase = previousBeat !== undefined && nextBeat !== undefined && nextBeat > previousBeat
      ? Math.max(0, Math.min(1, (time - previousBeat) / (nextBeat - previousBeat)))
      : 0;
    const curves = this.analysis.features;
    return {
      beatPulse: this.beatPulse,
      downbeatPulse: this.downbeatPulse,
      beatPhase,
      rms: interpolateCurve(curves.times, curves.rms, time),
      brightness: interpolateCurve(curves.times, curves.brightness, time),
      onsetStrength: interpolateCurve(curves.times, curves.onsetStrength, time),
    };
  }

  dispose() {
    this.audio.pause();
    this.audio.removeEventListener('seeking', this.handleSeeking);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.source?.disconnect();
    this.analyser?.disconnect();
    void this.context?.close();
    this.url = undefined;
    this.onFeatures?.({ ...silent });
  }
}
