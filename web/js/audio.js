/**
 * 100% Local In-Browser BGM Audio Manager:
 *   - Decodes local MP3 / M4A / WAV / OGG files via Web Audio API (zero uploads)
 *   - Syncs BGM playback with live timelapse preview
 *   - Supports Tap-BPM calculation and BPM beat-synced photo switching
 */

export class LocalAudioManager {
  constructor() {
    this.audioCtx = null;
    this.audioBuffer = null;
    this.filename = "";
    this.duration = 0;
    this.volume = 0.8;
    this._sourceNode = null;
    this._gainNode = null;
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
    }
    return this.audioCtx;
  }

  hasAudio() {
    return !!this.audioBuffer;
  }

  async loadFile(file) {
    const ctx = this._ensureCtx();
    const arrayBuf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    this.stop();
    this.audioBuffer = decoded;
    this.filename = file.name;
    this.duration = decoded.duration;
    return { filename: this.filename, duration: this.duration };
  }

  clear() {
    this.stop();
    this.audioBuffer = null;
    this.filename = "";
    this.duration = 0;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (this._gainNode && this.audioCtx) {
      this._gainNode.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);
    }
  }

  playLoop(startOffsetSec = 0) {
    if (!this.audioBuffer) return;
    this.stop();
    const ctx = this._ensureCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    const src = ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(this.volume, ctx.currentTime);

    src.connect(gain);
    gain.connect(ctx.destination);
    src.start(0, startOffsetSec % Math.max(0.1, this.audioBuffer.duration));
    this._sourceNode = src;
    this._gainNode = gain;
  }

  stop() {
    if (this._sourceNode) {
      try {
        this._sourceNode.stop();
        this._sourceNode.disconnect();
      } catch {
        // already stopped
      }
      this._sourceNode = null;
    }
    if (this._gainNode) {
      try {
        this._gainNode.disconnect();
      } catch {
        // ignore
      }
      this._gainNode = null;
    }
  }
}

/**
 * Helper to compute tapped BPM from an array of recent timestamps (ms).
 */
export function computeTappedBpm(tapTimes) {
  if (tapTimes.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) {
    const dt = tapTimes[i] - tapTimes[i - 1];
    if (dt >= 250 && dt <= 2000) intervals.push(dt);
  }
  if (!intervals.length) return null;
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return Math.max(50, Math.min(220, Math.round(60000 / avgMs)));
}
