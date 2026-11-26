/**
 * 100% Local In-Browser BGM Audio Manager & Real Musical Beat ("卡点") Detector:
 *   - Decodes local MP3 / M4A / WAV / OGG files via Web Audio API (zero uploads)
 *   - Rock-solid playback (handles suspended AudioContext + HTMLAudio fallback + Audition)
 *   - Real onset/beat detection via dual-band (kick/bass + percussive transient) spectral energy flux
 *   - Exact beat-cut timeline scheduling shared across Live Preview, MP4 Export, and GIF Export
 *   - Visual waveform + beat marker canvas renderer
 */

export class LocalAudioManager {
  constructor() {
    this.audioCtx = null;
    this.audioBuffer = null;
    this.objectUrl = null;
    this.filename = "";
    this.duration = 0;
    this.volume = 0.8;
    this.waveformPeaks = [];
    this.beats = []; // [{ time: number, strength: number }]
    this.detectedBpm = 120;
    this.lastSensitivity = 0.55;

    this._sourceNode = null;
    this._gainNode = null;
    this._audioEl = null;
    this._playSeq = 0;
    this._isPlaying = false;
    this._startAudioCtxTime = 0;
    this._startPerfTime = 0;
    this._startOffsetSec = 0;
    this._usingHtmlAudio = false;
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
    }
    return this.audioCtx;
  }

  /**
   * Synchronously unlock/resume AudioContext inside a user-gesture handler
   * (critical for Safari before any async await!).
   */
  unlock() {
    const ctx = this._ensureCtx();
    if (ctx.state !== "running") {
      try {
        ctx.resume().catch(() => {});
      } catch {
        // ignore
      }
    }
    return ctx;
  }

  hasAudio() {
    return !!this.audioBuffer;
  }

  isPlaying() {
    return this._isPlaying;
  }

  async loadFile(file) {
    const ctx = this._ensureCtx();
    const arrayBuf = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
    this.stop();
    if (this._audioEl) {
      try {
        this._audioEl.pause();
        this._audioEl.removeAttribute("src");
        this._audioEl.load();
      } catch {
        // ignore
      }
      this._audioEl = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.objectUrl = URL.createObjectURL(file);
    // Pre-create & preload HTMLAudioElement for rock-solid synchronous Safari/iOS/Chrome playback
    const el = new Audio();
    el.preload = "auto";
    el.playsInline = true;
    el.src = this.objectUrl;
    el.volume = this.volume;
    el.addEventListener("ended", () => {
      if (this._isPlaying && this._usingHtmlAudio && this._audioEl === el) {
        try {
          el.currentTime = this._startOffsetSec;
          el.play().catch(() => {});
        } catch {
          // ignore
        }
      }
    });
    try {
      el.load();
    } catch {
      // ignore
    }
    this._audioEl = el;

    this.audioBuffer = decoded;
    this.filename = file.name;
    this.duration = decoded.duration;
    this.waveformPeaks = this._extractWaveformPeaks(decoded, 240);
    this.detectBeats(this.lastSensitivity);
    return {
      filename: this.filename,
      duration: this.duration,
      beatCount: this.beats.length,
      detectedBpm: this.detectedBpm,
    };
  }

  clear() {
    this.stop();
    if (this._audioEl) {
      try {
        this._audioEl.pause();
        this._audioEl.removeAttribute("src");
        this._audioEl.load();
      } catch {
        // ignore
      }
      this._audioEl = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.audioBuffer = null;
    this.filename = "";
    this.duration = 0;
    this.waveformPeaks = [];
    this.beats = [];
    this.detectedBpm = 120;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    if (this._gainNode && this.audioCtx) {
      try {
        this._gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.015);
      } catch {
        this._gainNode.gain.value = this.volume;
      }
    }
    if (this._audioEl) {
      this._audioEl.volume = this.volume;
    }
  }

  /**
   * Reliable synchronous audio playback across Safari (macOS/iOS), Chrome, and Firefox:
   * - Uses preloaded HTMLAudioElement.play() synchronously inside the click gesture
   *   (avoids Safari WebKit AudioContext suspended/interrupted silence bugs!)
   * - Automatically falls back to Web Audio BufferSource if HTMLAudioElement fails.
   */
  playLoop(startOffsetSec = 0) {
    if (!this.audioBuffer) return;
    this.stop();

    const seq = ++this._playSeq;
    const dur = Math.max(0.1, this.audioBuffer.duration);
    const offset = ((Number(startOffsetSec) || 0) % dur + dur) % dur;

    this._startOffsetSec = offset;
    this._startPerfTime = performance.now();
    this._isPlaying = true;

    // Primary live playback: synchronous HTMLAudioElement (100% reliable in Safari & Chrome!)
    if (this._audioEl && this.objectUrl) {
      try {
        const el = this._audioEl;
        el.muted = false;
        el.volume = this.volume;
        el.currentTime = offset;
        this._usingHtmlAudio = true;
        const p = el.play();
        if (p && typeof p.catch === "function") {
          p.catch((err) => {
            if (seq !== this._playSeq || !this._isPlaying) return;
            console.warn("HTMLAudio play failed, falling back to WebAudio:", err);
            this._usingHtmlAudio = false;
            this._playViaWebAudio(offset, dur, seq);
          });
        }
        return;
      } catch (err) {
        console.warn("HTMLAudio sync start failed, falling back to WebAudio:", err);
        this._usingHtmlAudio = false;
      }
    }

    this._playViaWebAudio(offset, dur, seq);
  }

  _playViaWebAudio(offset, dur, seq) {
    const ctx = this._ensureCtx();
    let resumePromise = null;
    if (ctx.state !== "running") {
      try {
        resumePromise = ctx.resume();
      } catch {
        resumePromise = Promise.resolve();
      }
    }

    const startNode = () => {
      if (seq !== this._playSeq || !this._isPlaying || !this.audioBuffer) return;
      const src = ctx.createBufferSource();
      src.buffer = this.audioBuffer;
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = dur;

      const gain = ctx.createGain();
      gain.gain.value = this.volume;

      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0, offset);

      this._sourceNode = src;
      this._gainNode = gain;
      this._usingHtmlAudio = false;
      this._startAudioCtxTime = ctx.currentTime;
      this._startPerfTime = performance.now();
    };

    if (resumePromise) {
      resumePromise.then(startNode).catch(() => {});
    } else {
      startNode();
    }
  }

  /**
   * Returns exact elapsed playback seconds since playLoop() began.
   */
  getPlaybackTime() {
    if (!this._isPlaying) return 0;
    if (this._usingHtmlAudio && this._audioEl && !this._audioEl.paused) {
      const elapsed = this._audioEl.currentTime - this._startOffsetSec;
      if (elapsed >= -0.05) return Math.max(0, elapsed);
    }
    if (this.audioCtx && this._sourceNode && this.audioCtx.state === "running") {
      return Math.max(0, this.audioCtx.currentTime - this._startAudioCtxTime);
    }
    return Math.max(0, (performance.now() - this._startPerfTime) / 1000);
  }

  /**
   * Returns current absolute timestamp inside the track (for waveform playhead).
   */
  getTrackPositionSec() {
    if (!this.duration) return 0;
    if (this._usingHtmlAudio && this._audioEl && !this._audioEl.paused) {
      return Math.max(0, Math.min(this.duration, this._audioEl.currentTime));
    }
    const elapsed = this.getPlaybackTime();
    const span = Math.max(0.1, this.duration - this._startOffsetSec);
    return this._startOffsetSec + (elapsed % span);
  }

  stop() {
    this._playSeq += 1;
    this._isPlaying = false;
    this._usingHtmlAudio = false;
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
    if (this._audioEl) {
      try {
        this._audioEl.pause();
      } catch {
        // ignore
      }
    }
  }

  _extractWaveformPeaks(buffer, numBins = 240) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const len = ch0.length;
    const binSize = Math.max(1, Math.floor(len / numBins));
    const peaks = new Float32Array(numBins);
    let maxPeak = 1e-4;
    const stride = Math.max(1, Math.floor(binSize / 64));

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(len, start + binSize);
      let pk = 0;
      for (let i = start; i < end; i += stride) {
        const s = ch1 ? 0.5 * (Math.abs(ch0[i]) + Math.abs(ch1[i])) : Math.abs(ch0[i]);
        if (s > pk) pk = s;
      }
      peaks[b] = pk;
      if (pk > maxPeak) maxPeak = pk;
    }

    const out = new Array(numBins);
    for (let b = 0; b < numBins; b++) out[b] = peaks[b] / maxPeak;
    return out;
  }

  /**
   * Real Musical Beat / Drum-Hit ("卡点") Onset Detection:
   * Combines low-frequency kick/bass energy flux (65%) + mid/high percussive transient flux (35%)
   * with a sliding local adaptive threshold and minimum inter-onset spacing.
   */
  detectBeats(sensitivity = 0.55) {
    this.lastSensitivity = Math.max(0.1, Math.min(0.95, Number(sensitivity) || 0.55));
    if (!this.audioBuffer) {
      this.beats = [];
      return this.beats;
    }

    const sr = this.audioBuffer.sampleRate;
    const ch0 = this.audioBuffer.getChannelData(0);
    const ch1 = this.audioBuffer.numberOfChannels > 1 ? this.audioBuffer.getChannelData(1) : null;
    const totalSamples = ch0.length;

    const winSize = 1024;
    const hopSize = 512;
    const numFrames = Math.floor((totalSamples - winSize) / hopSize);
    if (numFrames < 4) {
      this.beats = [];
      return this.beats;
    }

    // 1-pole low-pass filter (~260Hz) to isolate kick/bass punch vs snare/hi-hat transients
    const cutoffHz = 260;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sr;
    const lpAlpha = dt / (rc + dt);

    const lowAmp = new Float32Array(numFrames);
    const hiAmp = new Float32Array(numFrames);
    let lpState = 0;

    for (let f = 0; f < numFrames; f++) {
      const start = f * hopSize;
      let sumLow = 0;
      let sumHi = 0;
      // Step by 2 samples for speed while preserving full kick & transient energy
      for (let j = 0; j < winSize; j += 2) {
        const idx = start + j;
        const x = ch1 ? 0.5 * (ch0[idx] + ch1[idx]) : ch0[idx];
        lpState += lpAlpha * (x - lpState);
        const hi = x - lpState;
        sumLow += lpState * lpState;
        sumHi += hi * hi;
      }
      const n = winSize / 2;
      lowAmp[f] = Math.sqrt(sumLow / n);
      hiAmp[f] = Math.sqrt(sumHi / n);
    }

    // Half-wave rectified positive spectral-band onset flux
    const flux = new Float32Array(numFrames);
    let maxFlux = 1e-6;
    for (let f = 1; f < numFrames; f++) {
      const dLow = Math.max(0, lowAmp[f] - lowAmp[f - 1]);
      const dHi = Math.max(0, hiAmp[f] - hiAmp[f - 1]);
      const val = 0.65 * dLow + 0.35 * dHi;
      flux[f] = val;
      if (val > maxFlux) maxFlux = val;
    }

    // Local adaptive threshold over ±0.42s sliding window
    const frameDur = hopSize / sr;
    const halfWin = Math.max(6, Math.round(0.42 / frameDur));
    const sens = this.lastSensitivity;
    const stdMul = 2.05 - sens * 1.3; // low sens => 1.92 (strong drops only), high sens => 0.82
    const minGapFrames = Math.max(3, Math.round((0.44 - sens * 0.26) / frameDur));
    const noiseFloor = maxFlux * (0.16 - sens * 0.08);

    const detected = [];
    let lastPeakFrame = -minGapFrames;

    for (let f = 2; f < numFrames - 2; f++) {
      const cur = flux[f];
      if (cur < noiseFloor) continue;
      // Must be a local peak within ±2 frames
      if (cur < flux[f - 1] || cur < flux[f + 1] || cur < flux[f - 2] || cur < flux[f + 2]) continue;

      const wStart = Math.max(0, f - halfWin);
      const wEnd = Math.min(numFrames - 1, f + halfWin);
      let mean = 0;
      let count = wEnd - wStart + 1;
      for (let k = wStart; k <= wEnd; k++) mean += flux[k];
      mean /= count;

      let variance = 0;
      for (let k = wStart; k <= wEnd; k++) {
        const diff = flux[k] - mean;
        variance += diff * diff;
      }
      const std = Math.sqrt(variance / count);
      const thresh = mean + stdMul * std;

      if (cur > thresh) {
        if (f - lastPeakFrame >= minGapFrames) {
          detected.push({
            time: Number((f * frameDur).toFixed(3)),
            strength: Math.min(1, cur / maxFlux),
          });
          lastPeakFrame = f;
        } else if (detected.length > 0 && cur / maxFlux > detected[detected.length - 1].strength * 1.18) {
          // Replace weaker immediately-preceding transient with stronger main kick
          detected[detected.length - 1] = {
            time: Number((f * frameDur).toFixed(3)),
            strength: Math.min(1, cur / maxFlux),
          };
          lastPeakFrame = f;
        }
      }
    }

    this.beats = detected;

    // Estimate average BPM from median inter-beat interval
    if (detected.length >= 3) {
      const gaps = [];
      for (let i = 1; i < detected.length; i++) {
        const g = detected[i].time - detected[i - 1].time;
        if (g >= 0.22 && g <= 1.5) gaps.push(g);
      }
      if (gaps.length) {
        gaps.sort((a, b) => a - b);
        let med = gaps[Math.floor(gaps.length / 2)];
        let bpm = 60 / med;
        while (bpm < 70) bpm *= 2;
        while (bpm > 180) bpm /= 2;
        this.detectedBpm = Math.round(bpm);
      }
    }
    return this.beats;
  }

  /**
   * Build the exact per-photo timeline schedule (shared by Live Preview, MP4 Export, and GIF Export).
   * Supports:
   *   1. Real Audio Onset Beat-Cut ("真卡点"): switches each photo on actual detected musical beats!
   *   2. Uniform BPM Grid: switches on fixed BPM divisions
   *   3. Manual FPS Speed: fixed photos/sec + milestone extra hold
   */
  buildPhotoSchedule(enabledItems, settings) {
    const n = enabledItems.length;
    if (!n) return { durationsSec: [], startTimesSec: [], totalDurationSec: 0, mode: "fps" };

    const milestoneHold = Math.max(0, Number(settings.milestoneHoldSec) || 0.8);
    const beatMode = settings.beatMode || "onset";
    const beatDiv = Number(settings.beatDiv) || 1; // 0.5 = every 2 beats, 1 = every beat, 2 = 2x per beat
    const startOffset = Math.max(0, Number(settings.bgmStartSec) || 0);

    // Mode 1: Real Musical Onset Beat-Cut ("真卡点")
    if (settings.beatSync && beatMode === "onset" && this.hasAudio() && this.beats.length >= 2) {
      // Shift beats relative to bgmStartSec
      let relBeats = this.beats
        .map((b) => b.time - startOffset)
        .filter((t) => t >= 0.04);

      // If startOffset is near the end, wrap from start
      if (relBeats.length < 2) {
        relBeats = this.beats.map((b) => b.time).filter((t) => t >= 0.04);
      }

      if (relBeats.length >= 2) {
        // Apply beat division:
        // beatDiv === 0.5 => every 2nd detected beat (slower, punchy drops)
        // beatDiv === 1   => every detected beat
        // beatDiv === 2   => insert midpoint between consecutive beats (double-time fast cut)
        let cutPoints = [];
        if (beatDiv <= 0.6) {
          for (let i = 0; i < relBeats.length; i += 2) cutPoints.push(relBeats[i]);
        } else if (beatDiv >= 1.5) {
          for (let i = 0; i < relBeats.length; i++) {
            cutPoints.push(relBeats[i]);
            if (i + 1 < relBeats.length) {
              const mid = 0.5 * (relBeats[i] + relBeats[i + 1]);
              if (relBeats[i + 1] - relBeats[i] >= 0.28) cutPoints.push(mid);
            }
          }
        } else {
          cutPoints = relBeats.slice();
        }

        if (cutPoints.length < 2) cutPoints = relBeats.slice();

        // Compute interval list from detected beat cuts (wrapping cleanly if more photos than beats)
        const baseIntervals = [];
        // First interval: from t=0 to first beat (clamp if intro is long so photo 1 doesn't stall forever)
        const firstLead = cutPoints[0] <= 1.25 ? cutPoints[0] : Math.min(0.65, cutPoints[1] - cutPoints[0]);
        baseIntervals.push(Math.max(0.12, firstLead));
        for (let i = 1; i < cutPoints.length; i++) {
          const dt = Math.max(0.1, Math.min(2.2, cutPoints[i] - cutPoints[i - 1]));
          baseIntervals.push(dt);
        }

        const durationsSec = [];
        const startTimesSec = [];
        let cursor = 0;
        let beatCursor = 0;

        for (let i = 0; i < n; i++) {
          startTimesSec.push(cursor);
          let dur = baseIntervals[beatCursor % baseIntervals.length];
          beatCursor += 1;

          // Milestone frames hold across an extra beat (or two) so the NEXT cut STILL lands on a real beat!
          if (enabledItems[i].milestone && milestoneHold > 0.05) {
            let added = 0;
            while (added < milestoneHold * 0.75) {
              const nextDt = baseIntervals[beatCursor % baseIntervals.length];
              dur += nextDt;
              added += nextDt;
              beatCursor += 1;
              if (added > 2.4) break;
            }
          }

          durationsSec.push(dur);
          cursor += dur;
        }

        return {
          durationsSec,
          startTimesSec,
          totalDurationSec: cursor,
          mode: "onset",
        };
      }
    }

    // Mode 2: Uniform BPM Grid or Manual FPS
    let baseDur;
    if (settings.beatSync && beatMode === "bpm") {
      const bpm = Math.max(50, Math.min(220, Number(settings.bpm) || 120));
      baseDur = 60 / (bpm * beatDiv);
    } else {
      const fps = Math.max(1, Math.min(20, Number(settings.fps) || 6));
      baseDur = 1 / fps;
    }

    const durationsSec = [];
    const startTimesSec = [];
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      startTimesSec.push(cursor);
      const dur = baseDur + (enabledItems[i].milestone ? milestoneHold : 0);
      durationsSec.push(dur);
      cursor += dur;
    }

    return {
      durationsSec,
      startTimesSec,
      totalDurationSec: cursor,
      mode: settings.beatSync ? "bpm" : "fps",
    };
  }

  /**
   * Draw waveform + detected beat markers + start offset + live playhead onto a canvas.
   */
  renderWaveform(canvas, startOffsetSec = 0, playheadSec = -1) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0a0e17";
    ctx.fillRect(0, 0, w, h);

    const peaks = this.waveformPeaks;
    const dur = Math.max(0.1, this.duration);
    if (!peaks.length) return;

    const startX = Math.max(0, Math.min(w, (startOffsetSec / dur) * w));

    // Dimmed region before start offset
    if (startX > 1) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(0, 0, startX, h);
    }

    // Draw waveform bars
    const barW = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const x = i * barW;
      const amp = Math.max(0.06, peaks[i]);
      const barH = amp * (h * 0.78);
      const y = (h - barH) * 0.5;
      ctx.fillStyle = x < startX ? "rgba(100, 116, 139, 0.35)" : "rgba(59, 130, 246, 0.55)";
      ctx.fillRect(x, y, Math.max(1, barW - 0.6), barH);
    }

    // Draw detected real beat markers ("卡点")
    for (const b of this.beats) {
      const bx = (b.time / dur) * w;
      const isAfterStart = b.time >= startOffsetSec;
      ctx.fillStyle = isAfterStart
        ? `rgba(16, 185, 129, ${(0.45 + b.strength * 0.55).toFixed(2)})`
        : "rgba(148, 163, 184, 0.25)";
      ctx.fillRect(Math.round(bx), 0, isAfterStart ? 1.5 : 1, h);
    }

    // Start offset marker line
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(Math.round(startX), 0, 2, h);

    // Live playhead
    if (playheadSec >= 0 && playheadSec <= dur) {
      const px = (playheadSec / dur) * w;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.round(px), 0, 2, h);
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
