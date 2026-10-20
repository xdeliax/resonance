import type { AudioFeatures } from './audio';

export type FlowMusic = {
  bassForce: number;
  beatCycle: number;
  beatAccent: number;
  downbeatAccent: number;
  fineActivity: number;
  intensity: number;
};

/** A small, bounded choreography layer between audio analysis and graphics. */
export class MusicChoreography {
  private smoothed = { bass: 0, brightness: 0, rms: 0 };
  private presence = 0;
  private beat = 0;
  private downbeat = 0;
  private downbeatCooldown = 0;
  private previousBeat = 0;
  private previousDownbeat = 0;

  update(features: AudioFeatures, deltaSeconds: number, enabled: boolean, influence: number): FlowMusic {
    const dt = Math.max(0, Math.min(deltaSeconds, 0.05));
    const mix = (current: number, target: number, response: number) =>
      current + (target - current) * (1 - Math.exp(-response * dt));
    this.beat *= Math.exp(-dt * 5.5);
    this.downbeat *= Math.exp(-dt * 2.4);
    this.downbeatCooldown = Math.max(0, this.downbeatCooldown - dt);
    const rawBeat = enabled ? features.beatPulse : 0;
    if (rawBeat > 0.72 && this.previousBeat <= 0.72) this.beat = 1;
    this.previousBeat = rawBeat;
    const rawDownbeat = enabled ? features.downbeatPulse : 0;
    if (rawDownbeat > 0.72 && this.previousDownbeat <= 0.72 && this.downbeatCooldown <= 0) {
      this.downbeat = 1;
      this.downbeatCooldown = 0.85;
    }
    this.previousDownbeat = rawDownbeat;

    this.presence = mix(this.presence, enabled ? 1 : 0, 4.5);
    const amount = this.presence * Math.max(0, Math.min(1.5, influence));
    this.smoothed.bass = mix(this.smoothed.bass, enabled ? features.bass : 0, 5.0);
    this.smoothed.brightness = mix(this.smoothed.brightness, enabled ? features.brightness : 0, 5.0);
    this.smoothed.rms = mix(this.smoothed.rms, enabled ? features.rms : 0, 4.0);
    return {
      bassForce: this.smoothed.bass * amount,
      beatCycle: enabled ? Math.sin(features.beatPhase * Math.PI * 2) * amount : 0,
      beatAccent: this.beat * amount,
      downbeatAccent: this.downbeat * amount,
      fineActivity: this.smoothed.brightness * amount + (enabled ? features.onsetStrength * 0.18 * amount : 0),
      intensity: this.smoothed.rms * amount,
    };
  }
}
