/**
 * 100% Local In-Browser Media Exporters:
 *   1. H.264 MP4 Timelapse (WebCodecs VideoEncoder + optional WebCodecs AAC AudioEncoder BGM + mp4-muxer)
 *   2. Animated GIF Timelapse (gifenc pure-JS quantized encoder)
 *   3. Before / After Animated Curtain Wipe MP4 (30fps ease-in-out reveal)
 */

import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs";
import { getCanvasSize, renderAlignedToCanvas } from "./renderer.js";

let gifencPromise = null;
function loadGifenc() {
  if (!gifencPromise) {
    gifencPromise = import("https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js");
  }
  return gifencPromise;
}

let mediabunnyPromise = null;
async function loadMediabunnyWithWasmAac() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = (async () => {
      const [mb, aacExt] = await Promise.all([
        import("https://cdn.jsdelivr.net/npm/mediabunny/+esm"),
        import("https://cdn.jsdelivr.net/npm/@mediabunny/aac-encoder/+esm"),
      ]);
      if (typeof aacExt.registerAacEncoder === "function") {
        aacExt.registerAacEncoder();
      }
      // Guard against CDN peer-dependency module skew: if AAC still reports unsupported,
      // load both packages bound to the exact same mediabunny module via esm.sh ?deps=
      if (typeof mb.canEncodeAudio === "function" && !(await mb.canEncodeAudio("aac"))) {
        const [mb2, aacExt2] = await Promise.all([
          import("https://esm.sh/mediabunny@1.66.4"),
          import("https://esm.sh/@mediabunny/aac-encoder?deps=mediabunny@1.66.4"),
        ]);
        if (typeof aacExt2.registerAacEncoder === "function") {
          aacExt2.registerAacEncoder();
        }
        return mb2;
      }
      return mb;
    })();
  }
  return mediabunnyPromise;
}

async function renderBgmToAudioBuffer(audioBuffer, durationSec, volume = 0.8, startOffsetSec = 0, sampleRate = 48000) {
  const numChannels = 2;
  const totalSamples = Math.max(1024, Math.ceil(durationSec * sampleRate));
  const offline = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  const maxOffset = Math.max(0, audioBuffer.duration - 0.15);
  const offset = Math.max(0, Math.min(maxOffset, Number(startOffsetSec) || 0));
  src.loop = true;
  src.loopStart = offset;
  src.loopEnd = audioBuffer.duration;

  const gain = offline.createGain();
  const vol = Math.max(0.01, Math.min(1, Number(volume) || 0.8));
  gain.gain.setValueAtTime(vol, 0);
  const fadeDur = Math.min(0.65, durationSec * 0.25);
  gain.gain.setValueAtTime(vol, Math.max(0, durationSec - fadeDur));
  gain.gain.linearRampToValueAtTime(0.0001, durationSec);

  src.connect(gain);
  gain.connect(offline.destination);
  src.start(0, offset);
  return offline.startRendering();
}

async function pickH264Config(width, height, bitrate, framerate) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    return null;
  }
  const codecs = ["avc1.640028", "avc1.4d0028", "avc1.420028", "avc1.42E01F"];
  for (const codec of codecs) {
    const cfg = { codec, width, height, bitrate, framerate, avc: { format: "avc" } };
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup.supported) return cfg;
    } catch {
      // try next profile
    }
  }
  return null;
}

async function pickAudioEncoderConfig() {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") {
    return null;
  }
  // IMPORTANT: Only accept universal AAC-LC (mp4a.40.2) for MP4 containers!
  // Never mux Opus into MP4 here: Safari 18+/27 & Firefox report WebCodecs Opus as supported,
  // but Apple Safari <video>, QuickTime Player, and iOS silently refuse to play Opus inside MP4.
  // Returning null when native AAC is unavailable cleanly routes to our WASM AAC-LC encoder!
  const candidates = [
    {
      muxerCodec: "aac",
      config: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000, aac: { format: "aac" } },
    },
    {
      muxerCodec: "aac",
      config: { codec: "mp4a.40.2", sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000, aac: { format: "aac" } },
    },
    {
      muxerCodec: "aac",
      config: { codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
    },
  ];
  for (const item of candidates) {
    try {
      const sup = await AudioEncoder.isConfigSupported(item.config);
      if (sup && sup.supported) {
        return { muxerCodec: item.muxerCodec, config: sup.config || item.config };
      }
    } catch {
      // try next codec candidate
    }
  }
  return null;
}

function isSafariBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /safari/i.test(ua) && !/chrome|chromium|crios|edg|opr|fxios|android/i.test(ua);
}

/**
 * Render an AudioBuffer (starting at `startOffsetSec`, looped/trimmed to `durationSec`,
 * resampled to target sampleRate stereo with 0.65s fade-out) and feed it through WebCodecs AudioEncoder.
 */
async function encodeBgmAudioTrack(muxer, audioSpec, audioBuffer, durationSec, volume = 0.8, startOffsetSec = 0) {
  if (!audioSpec || !audioBuffer || durationSec <= 0.1) return { ok: false, chunks: 0, error: "no_audio" };
  const sampleRate = audioSpec.config.sampleRate || 48000;
  const rendered = await renderBgmToAudioBuffer(audioBuffer, durationSec, volume, startOffsetSec, sampleRate);
  const ch0 = rendered.getChannelData(0);
  const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;

  let audioErr = null;
  let chunkCount = 0;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addAudioChunk(chunk, meta);
        chunkCount += 1;
      } catch (err) {
        audioErr = err;
      }
    },
    error: (err) => {
      audioErr = err;
    },
  });
  audioEncoder.configure(audioSpec.config);

  const chunkFrames = 1024;
  for (let samplePos = 0; samplePos < rendered.length; samplePos += chunkFrames) {
    if (audioErr) throw audioErr;
    while (audioEncoder.encodeQueueSize > 16) {
      await new Promise((r) => setTimeout(r, 4));
    }
    const count = Math.min(chunkFrames, rendered.length - samplePos);
    // f32-planar layout: all ch0 samples followed by all ch1 samples
    const planar = new Float32Array(count * 2);
    planar.set(ch0.subarray(samplePos, samplePos + count), 0);
    planar.set(ch1.subarray(samplePos, samplePos + count), count);

    const ad = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: 2,
      timestamp: Math.round((samplePos / sampleRate) * 1_000_000),
      data: planar,
    });
    audioEncoder.encode(ad);
    ad.close();
  }

  await audioEncoder.flush();
  audioEncoder.close();
  if (audioErr) throw audioErr;
  return { ok: chunkCount > 0, chunks: chunkCount, codec: audioSpec.muxerCodec };
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function blendCanvases(dstCanvas, prevCanvas, currCanvas, alpha) {
  const ctx = dstCanvas.getContext("2d");
  ctx.globalAlpha = 1;
  ctx.drawImage(prevCanvas, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(currCanvas, 0, 0);
  ctx.globalAlpha = 1;
}

async function exportWithWebCodecs(
  enabledItems,
  settings,
  lang,
  batchColorTarget,
  customStickerImg,
  audioOptions,
  onProgress
) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const streamFps = 30;
  const bitrate = settings.resolution === "1080p" ? 8_000_000 : 4_500_000;

  const encoderConfig = await pickH264Config(width, height, bitrate, streamFps);
  if (!encoderConfig) return null;

  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  const audioSpec = hasBgm ? await pickAudioEncoderConfig() : null;
  // If user added music but this browser lacks WebCodecs AudioEncoder (AAC/Opus),
  // return null so MediaRecorder fallback can mix and record the BGM track!
  if (hasBgm && !audioSpec) {
    console.warn("WebCodecs AudioEncoder unavailable; falling back to MediaRecorder with audio stream.");
    return null;
  }
  const canEncodeAudio = !!audioSpec;

  const target = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  };
  if (canEncodeAudio) {
    muxerOpts.audio = {
      codec: audioSpec.muxerCodec,
      numberOfChannels: audioSpec.config.numberOfChannels || 2,
      sampleRate: audioSpec.config.sampleRate || 48000,
    };
  }
  const muxer = new Muxer(muxerOpts);

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    },
  });
  encoder.configure(encoderConfig);

  const photoFps = Math.max(1, Math.min(20, Number(settings.fps) || 6));
  const defaultFramesPerPhoto = Math.max(1, Math.round(streamFps / photoFps));
  const milestoneExtraFrames = Math.max(0, Math.round((Number(settings.milestoneHoldSec) || 0.8) * streamFps));
  const holdExtraFrames = Math.max(0, Math.round((Number(settings.holdLastSec) || 0) * streamFps));
  const customDurations =
    audioOptions && Array.isArray(audioOptions.photoDurationsSec) && audioOptions.photoDurationsSec.length === enabledItems.length
      ? audioOptions.photoDurationsSec
      : null;

  const currCanvas = makeCanvas(width, height);
  const prevCanvas = makeCanvas(width, height);
  const mixCanvas = makeCanvas(width, height);

  const firstTs = enabledItems[0].timestamp;
  const totalEnabled = enabledItems.length;
  const frameDurationUs = Math.round(1_000_000 / streamFps);
  let frameIndex = 0;
  let cumEndSec = 0;

  const encodeCanvas = async (srcCanvas, repeatCount = 1) => {
    for (let r = 0; r < repeatCount; r++) {
      if (encodeError) throw encodeError;
      while (encoder.encodeQueueSize > 12) {
        await new Promise((res) => setTimeout(res, 8));
      }
      const vf = new VideoFrame(srcCanvas, {
        timestamp: frameIndex * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(vf, { keyFrame: frameIndex % (streamFps * 2) === 0 });
      vf.close();
      frameIndex += 1;
    }
  };

  for (let i = 0; i < totalEnabled; i++) {
    const item = enabledItems[i];
    if (onProgress) onProgress(i + 1, totalEnabled, "encoding");

    renderAlignedToCanvas(currCanvas, item, settings, {
      seqIndex: i + 1,
      totalEnabled,
      firstTimestamp: firstTs,
      drawGuides: false,
      lang,
      batchColorTarget,
      progressRatio: (i + 1) / totalEnabled,
      customStickerImg,
    });

    // Cumulative target frame calculation guarantees zero drift against real musical beat timestamps!
    let targetFramesForPhoto;
    if (customDurations) {
      cumEndSec += Math.max(0.06, customDurations[i]);
      targetFramesForPhoto = Math.max(1, Math.round(cumEndSec * streamFps) - frameIndex);
    } else {
      targetFramesForPhoto = defaultFramesPerPhoto + (item.milestone ? milestoneExtraFrames : 0);
    }

    const blendFrames =
      settings.crossfade && targetFramesForPhoto >= 3
        ? Math.max(1, Math.min(Math.floor(targetFramesForPhoto / 2), 4))
        : 0;

    if (i > 0 && blendFrames > 0) {
      for (let b = 1; b <= blendFrames; b++) {
        blendCanvases(mixCanvas, prevCanvas, currCanvas, b / (blendFrames + 1));
        await encodeCanvas(mixCanvas, 1);
      }
      await encodeCanvas(currCanvas, Math.max(1, targetFramesForPhoto - blendFrames));
    } else {
      await encodeCanvas(currCanvas, targetFramesForPhoto);
    }

    prevCanvas.getContext("2d").drawImage(currCanvas, 0, 0);
    await new Promise((res) => setTimeout(res, 0));
  }

  if (holdExtraFrames > 0) {
    await encodeCanvas(currCanvas, holdExtraFrames);
  }

  if (onProgress) onProgress(totalEnabled, totalEnabled, "finalizing");
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  let audioIncluded = false;
  let audioCodec = null;
  if (canEncodeAudio) {
    const totalDurationSec = frameIndex / streamFps;
    try {
      const res = await encodeBgmAudioTrack(
        muxer,
        audioSpec,
        audioOptions.audioBuffer,
        totalDurationSec,
        audioOptions.volume,
        audioOptions.startOffsetSec || 0
      );
      audioIncluded = !!res.ok;
      audioCodec = res.codec || null;
    } catch (err) {
      console.error("Audio muxing failed:", err);
      // If muxer was configured with an audio track that failed, return null so MediaRecorder fallback can include audio
      return null;
    }
  }

  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
    audioIncluded,
    audioCodec,
    engine: "webcodecs",
  };
}

async function exportWithMediaRecorder(
  enabledItems,
  settings,
  lang,
  batchColorTarget,
  customStickerImg,
  audioOptions,
  onProgress
) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const canvas = makeCanvas(width, height);
  // Mount offscreen in DOM during MediaRecorder capture so Safari's compositor reliably flushes frames
  canvas.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0.01;pointer-events:none;";
  document.body.appendChild(canvas);

  const firstTs = enabledItems[0].timestamp;
  const totalEnabled = enabledItems.length;
  const msPerPhoto = Math.round(1000 / Math.max(1, Number(settings.fps) || 6));
  const milestoneMs = Math.round((Number(settings.milestoneHoldSec) || 0.8) * 1000);
  const holdMs = Math.round((Number(settings.holdLastSec) || 0) * 1000);
  const customDurations =
    audioOptions && Array.isArray(audioOptions.photoDurationsSec) && audioOptions.photoDurationsSec.length === totalEnabled
      ? audioOptions.photoDurationsSec
      : null;

  // Compute total recording duration for clean fade-out
  let totalMs = holdMs;
  for (let i = 0; i < totalEnabled; i++) {
    totalMs += customDurations
      ? Math.max(60, Math.round(customDurations[i] * 1000))
      : msPerPhoto + (enabledItems[i].milestone ? milestoneMs : 0);
  }
  const totalDurationSec = Math.max(0.2, totalMs / 1000);

  // Draw frame 0 BEFORE captureStream so Safari initializes video track dimensions immediately
  renderAlignedToCanvas(canvas, enabledItems[0], settings, {
    seqIndex: 1,
    totalEnabled,
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
    progressRatio: 1 / totalEnabled,
    customStickerImg,
  });

  const videoStream = canvas.captureStream(30);
  let combinedStream = videoStream;
  let audioCtx = null;
  let ownsAudioCtx = false;
  let audioSrc = null;
  let keepAliveOsc = null;
  let silentTap = null;
  let masterGain = null;
  let audioIncluded = false;

  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  if (hasBgm && typeof (window.AudioContext || window.webkitAudioContext) !== "undefined") {
    try {
      // Reuse the already gesture-unlocked AudioContext from LocalAudioManager (critical for Safari!)
      if (audioOptions.audioCtx && audioOptions.audioCtx.state !== "closed") {
        audioCtx = audioOptions.audioCtx;
      } else {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        ownsAudioCtx = true;
      }
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }

      const dest = audioCtx.createMediaStreamDestination();
      masterGain = audioCtx.createGain();
      const vol = Math.max(0.01, Math.min(1, Number(audioOptions.volume) || 0.8));
      const now = audioCtx.currentTime;
      masterGain.gain.setValueAtTime(vol, now);
      const fadeDur = Math.min(0.65, totalDurationSec * 0.25);
      masterGain.gain.setValueAtTime(vol, now + Math.max(0, totalDurationSec - fadeDur));
      masterGain.gain.linearRampToValueAtTime(0.0001, now + totalDurationSec);
      masterGain.connect(dest);

      // Safari WebKit quirk #1: Keep-alive sub-audible tone prevents AVAssetWriter from dropping
      // the audio track during quiet intros or pauses.
      keepAliveOsc = audioCtx.createOscillator();
      const keepGain = audioCtx.createGain();
      keepGain.gain.value = 0.00005;
      keepAliveOsc.connect(keepGain);
      keepGain.connect(dest);
      keepAliveOsc.start(now);

      // Safari WebKit quirk #2: Connecting a near-zero tap to audioCtx.destination ensures
      // CoreAudio's render thread actively pumps audio frames into MediaStreamAudioDestinationNode!
      silentTap = audioCtx.createGain();
      silentTap.gain.value = 0.00001;
      masterGain.connect(silentTap);
      silentTap.connect(audioCtx.destination);

      audioSrc = audioCtx.createBufferSource();
      audioSrc.buffer = audioOptions.audioBuffer;
      const maxOff = Math.max(0, audioOptions.audioBuffer.duration - 0.15);
      const offset = Math.max(0, Math.min(maxOff, Number(audioOptions.startOffsetSec) || 0));
      audioSrc.loop = true;
      audioSrc.loopStart = offset;
      audioSrc.loopEnd = audioOptions.audioBuffer.duration;
      audioSrc.connect(masterGain);

      combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      audioSrc.start(now, offset);
      audioIncluded = true;
      // Give WebKit 60ms so audio track is actively producing samples when MediaRecorder starts
      await new Promise((r) => setTimeout(r, 60));
    } catch (err) {
      console.warn("MediaRecorder audio mix unavailable:", err);
    }
  }

  // IMPORTANT for Safari: NEVER pass a video-only MIME string like "video/mp4;codecs=avc1"
  // when recording audio, because Safari will omit the AAC audio track!
  const mimeCandidates = audioIncluded
    ? [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm",
      ]
    : ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

  const mimeType = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported(m)) || "";
  const recOpts = mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 };
  let recorder;
  try {
    recorder = new MediaRecorder(combinedStream, recOpts);
  } catch {
    recorder = new MediaRecorder(combinedStream);
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      if (audioSrc) {
        try { audioSrc.stop(); audioSrc.disconnect(); } catch {}
      }
      if (keepAliveOsc) {
        try { keepAliveOsc.stop(); keepAliveOsc.disconnect(); } catch {}
      }
      if (masterGain) {
        try { masterGain.disconnect(); } catch {}
      }
      if (silentTap) {
        try { silentTap.disconnect(); } catch {}
      }
      if (audioCtx && ownsAudioCtx) {
        try { audioCtx.close(); } catch {}
      }
      if (canvas.parentNode) {
        try { canvas.parentNode.removeChild(canvas); } catch {}
      }
      const actualMime = recorder.mimeType || mimeType || "video/mp4";
      const isMp4 = actualMime.includes("mp4");
      resolve({
        blob: new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" }),
        ext: isMp4 ? "mp4" : "webm",
        audioIncluded,
        audioCodec: audioIncluded ? (isMp4 ? "aac" : "opus") : null,
        engine: "mediarecorder",
      });
    };
  });

  // Helper to wait while keeping canvas frames flowing for Safari's captureStream
  const waitWithFrameKeepAlive = async (waitMs) => {
    const endAt = performance.now() + waitMs;
    const ctx = canvas.getContext("2d");
    while (performance.now() < endAt) {
      const rem = endAt - performance.now();
      await new Promise((r) => setTimeout(r, Math.min(65, Math.max(10, rem))));
      // Re-stamp a 1px corner touch? No—re-draw image onto itself keeps Safari frame pump alive cleanly
      if (performance.now() < endAt) {
        ctx.save();
        ctx.globalAlpha = 0.001;
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 1, 1);
        ctx.restore();
      }
    }
  };

  // Use 250ms timeslice so Safari flushes interleaved audio+video chunks reliably
  recorder.start(250);
  for (let i = 0; i < totalEnabled; i++) {
    const item = enabledItems[i];
    if (onProgress) onProgress(i + 1, totalEnabled, "encoding");
    renderAlignedToCanvas(canvas, item, settings, {
      seqIndex: i + 1,
      totalEnabled,
      firstTimestamp: firstTs,
      drawGuides: false,
      lang,
      batchColorTarget,
      progressRatio: (i + 1) / totalEnabled,
      customStickerImg,
    });
    const waitMs = customDurations
      ? Math.max(60, Math.round(customDurations[i] * 1000))
      : msPerPhoto + (item.milestone ? milestoneMs : 0);
    await waitWithFrameKeepAlive(waitMs);
  }
  if (holdMs > 0) await waitWithFrameKeepAlive(holdMs);
  recorder.stop();
  return done;
}

/**
 * Offline H.264 + WASM AAC-LC MP4 Exporter via Mediabunny + @mediabunny/aac-encoder.
 * Solves Safari (macOS & iOS) and Firefox where WebCodecs lacks native AAC AudioEncoder
 * and MediaRecorder drops Web Audio tracks! Runs 100% locally in-browser, faster than realtime.
 */
async function exportWithMediabunnyWasmAac(
  enabledItems,
  settings,
  lang,
  batchColorTarget,
  customStickerImg,
  audioOptions,
  onProgress
) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const streamFps = 30;
  const bitrate = settings.resolution === "1080p" ? 8_000_000 : 4_500_000;

  const encoderConfig = await pickH264Config(width, height, bitrate, streamFps);
  if (!encoderConfig) return null;

  const mb = await loadMediabunnyWithWasmAac();
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } = mb;

  const photoFps = Math.max(1, Math.min(20, Number(settings.fps) || 6));
  const defaultFramesPerPhoto = Math.max(1, Math.round(streamFps / photoFps));
  const milestoneExtraFrames = Math.max(0, Math.round((Number(settings.milestoneHoldSec) || 0.8) * streamFps));
  const holdExtraFrames = Math.max(0, Math.round((Number(settings.holdLastSec) || 0) * streamFps));
  const totalEnabled = enabledItems.length;
  const customDurations =
    audioOptions && Array.isArray(audioOptions.photoDurationsSec) && audioOptions.photoDurationsSec.length === totalEnabled
      ? audioOptions.photoDurationsSec
      : null;

  const drawCanvas = makeCanvas(width, height);
  const currCanvas = makeCanvas(width, height);
  const prevCanvas = makeCanvas(width, height);

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });

  const videoSource = new CanvasSource(drawCanvas, {
    codec: "avc",
    bitrate,
  });
  output.addVideoTrack(videoSource, { frameRate: streamFps });

  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  let audioSource = null;
  if (hasBgm) {
    audioSource = new AudioBufferSource({
      codec: "aac",
      bitrate: 128_000,
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const firstTs = enabledItems[0].timestamp;
  const frameDurSec = 1 / streamFps;
  let frameIndex = 0;
  let cumEndSec = 0;

  const pushCanvas = async (srcCanvas, repeatCount = 1) => {
    const drawCtx = drawCanvas.getContext("2d");
    drawCtx.drawImage(srcCanvas, 0, 0);
    for (let r = 0; r < repeatCount; r++) {
      await videoSource.add(frameIndex * frameDurSec, frameDurSec, {
        keyFrame: frameIndex % (streamFps * 2) === 0,
      });
      frameIndex += 1;
    }
  };

  for (let i = 0; i < totalEnabled; i++) {
    const item = enabledItems[i];
    if (onProgress) onProgress(i + 1, totalEnabled, "encoding");

    renderAlignedToCanvas(currCanvas, item, settings, {
      seqIndex: i + 1,
      totalEnabled,
      firstTimestamp: firstTs,
      drawGuides: false,
      lang,
      batchColorTarget,
      progressRatio: (i + 1) / totalEnabled,
      customStickerImg,
    });

    let targetFramesForPhoto;
    if (customDurations) {
      cumEndSec += Math.max(0.06, customDurations[i]);
      targetFramesForPhoto = Math.max(1, Math.round(cumEndSec * streamFps) - frameIndex);
    } else {
      targetFramesForPhoto = defaultFramesPerPhoto + (item.milestone ? milestoneExtraFrames : 0);
    }

    const blendFrames =
      settings.crossfade && targetFramesForPhoto >= 3
        ? Math.max(1, Math.min(Math.floor(targetFramesForPhoto / 2), 4))
        : 0;

    if (i > 0 && blendFrames > 0) {
      for (let b = 1; b <= blendFrames; b++) {
        blendCanvases(drawCanvas, prevCanvas, currCanvas, b / (blendFrames + 1));
        await videoSource.add(frameIndex * frameDurSec, frameDurSec, {
          keyFrame: frameIndex % (streamFps * 2) === 0,
        });
        frameIndex += 1;
      }
      await pushCanvas(currCanvas, Math.max(1, targetFramesForPhoto - blendFrames));
    } else {
      await pushCanvas(currCanvas, targetFramesForPhoto);
    }

    prevCanvas.getContext("2d").drawImage(currCanvas, 0, 0);
    await new Promise((res) => setTimeout(res, 0));
  }

  if (holdExtraFrames > 0) {
    await pushCanvas(currCanvas, holdExtraFrames);
  }
  videoSource.close();

  if (onProgress) onProgress(totalEnabled, totalEnabled, "finalizing");

  let audioIncluded = false;
  if (audioSource && hasBgm) {
    const totalDurationSec = frameIndex * frameDurSec;
    const renderedAudio = await renderBgmToAudioBuffer(
      audioOptions.audioBuffer,
      totalDurationSec,
      audioOptions.volume,
      audioOptions.startOffsetSec || 0,
      48000
    );
    await audioSource.add(renderedAudio);
    audioSource.close();
    audioIncluded = true;
  }

  await output.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
    audioIncluded,
    audioCodec: audioIncluded ? "aac" : null,
    engine: "wasm-aac",
  };
}

export async function exportTimelapseLocal(
  items,
  settings,
  lang,
  batchColorTarget,
  customStickerImg,
  audioOptions,
  onProgress
) {
  const enabled = items.filter((it) => it.enabled);
  if (!enabled.length) throw new Error("No enabled photos to export.");

  const forceWasmAac =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("forceWasmAac") === "1";
  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  const preferMediabunny = forceWasmAac || (hasBgm && isSafariBrowser());

  // 1. Primary path: Native WebCodecs H.264 + Native WebCodecs AAC (fastest on Chrome/Edge)
  if (!preferMediabunny) {
    const wc = await exportWithWebCodecs(
      enabled,
      settings,
      lang,
      batchColorTarget,
      customStickerImg,
      audioOptions,
      onProgress
    );
    if (wc) return wc;
  }

  // 2. Safari / Firefox path: Native WebCodecs H.264 + Mediabunny WASM AAC-LC encoder (100% offline, zero MediaRecorder quirks!)
  let wasmErrMsg = "";
  const origAudioEncoder = globalThis.AudioEncoder;
  const origAudioData = globalThis.AudioData;
  const maskNativeAudio = forceWasmAac || isSafariBrowser();
  try {
    if (maskNativeAudio) {
      // Guarantee Mediabunny uses the verified WASM AAC-LC encoder on Safari (bypassing Safari Opus/WebKit quirks!)
      globalThis.AudioEncoder = undefined;
      globalThis.AudioData = undefined;
    }
    const mbRes = await exportWithMediabunnyWasmAac(
      enabled,
      settings,
      lang,
      batchColorTarget,
      customStickerImg,
      audioOptions,
      onProgress
    );
    if (mbRes) return mbRes;
  } catch (err) {
    wasmErrMsg = String(err && err.message ? err.message : err);
    console.error("Mediabunny WASM AAC fallback failed, trying MediaRecorder:", err);
  } finally {
    if (maskNativeAudio) {
      globalThis.AudioEncoder = origAudioEncoder;
      globalThis.AudioData = origAudioData;
    }
  }

  // 3. Final legacy fallback: MediaRecorder
  const mrRes = await exportWithMediaRecorder(
    enabled,
    settings,
    lang,
    batchColorTarget,
    customStickerImg,
    audioOptions,
    onProgress
  );
  if (wasmErrMsg) mrRes.wasmErrMsg = wasmErrMsg;
  return mrRes;
}

/**
 * 100% Local In-Browser Animated GIF Exporter via `gifenc` (ideal for GitHub, WeChat, Discord, Notion).
 */
export async function exportGifLocal(items, settings, lang, batchColorTarget, customStickerImg, onProgress, photoDurationsSec = null) {
  const enabled = items.filter((it) => it.enabled);
  if (!enabled.length) throw new Error("No enabled photos to export.");

  const { GIFEncoder, quantize, applyPalette } = await loadGifenc();
  const [fullW, fullH] = getCanvasSize(settings);
  const maxGifSide = 480;
  const scale = maxGifSide / Math.max(fullW, fullH);
  const w = Math.max(160, Math.round(fullW * scale));
  const h = Math.max(160, Math.round(fullH * scale));

  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();

  const photoFps = Math.max(1, Math.min(20, Number(settings.fps) || 6));
  const baseDelayMs = Math.max(40, Math.round(1000 / photoFps));
  const milestoneMs = Math.round((Number(settings.milestoneHoldSec) || 0.8) * 1000);
  const holdLastMs = Math.round((Number(settings.holdLastSec) || 0) * 1000);
  const firstTs = enabled[0].timestamp;
  const total = enabled.length;
  const useCustomDur = Array.isArray(photoDurationsSec) && photoDurationsSec.length === total;

  for (let i = 0; i < total; i++) {
    const item = enabled[i];
    if (onProgress) onProgress(i + 1, total, "encoding");

    renderAlignedToCanvas(canvas, item, settings, {
      seqIndex: i + 1,
      totalEnabled: total,
      firstTimestamp: firstTs,
      drawGuides: false,
      lang,
      batchColorTarget,
      progressRatio: (i + 1) / total,
      customStickerImg,
    });

    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);

    let delay = useCustomDur
      ? Math.max(40, Math.round(photoDurationsSec[i] * 1000))
      : baseDelayMs + (item.milestone ? milestoneMs : 0);
    if (i === total - 1) delay += holdLastMs;

    gif.writeFrame(index, w, h, { palette, delay, repeat: 0 });
    await new Promise((r) => setTimeout(r, 0));
  }

  if (onProgress) onProgress(total, total, "finalizing");
  gif.finish();
  return {
    blob: new Blob([gif.bytes()], { type: "image/gif" }),
    ext: "gif",
  };
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 100% Local Before / After Animated Curtain Wipe Video (H.264 MP4).
 */
export async function exportWipeVideoLocal(
  leftItem,
  rightItem,
  leftSeq,
  rightSeq,
  firstTs,
  settings,
  lang,
  batchColorTarget,
  customStickerImg,
  audioOptions,
  onProgress
) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const streamFps = 30;
  const bitrate = settings.resolution === "1080p" ? 8_000_000 : 4_500_000;

  const encoderConfig = await pickH264Config(width, height, bitrate, streamFps);
  if (!encoderConfig) {
    throw new Error("Current browser does not support WebCodecs H.264 video encoding.");
  }

  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  const audioSpec = hasBgm && !isSafariBrowser() ? await pickAudioEncoderConfig() : null;

  // If Safari/Firefox lacks native AAC AudioEncoder and user added BGM, use Mediabunny WASM AAC for Wipe MP4 too!
  if (hasBgm && !audioSpec) {
    const origAE = globalThis.AudioEncoder;
    const origAD = globalThis.AudioData;
    try {
      if (isSafariBrowser()) {
        globalThis.AudioEncoder = undefined;
        globalThis.AudioData = undefined;
      }
      const mb = await loadMediabunnyWithWasmAac();
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } = mb;
      const noBarSettings = { ...settings, showProgressBar: false };
      const leftCanvas = makeCanvas(width, height);
      const rightCanvas = makeCanvas(width, height);
      const totalEst = Math.max(leftSeq, rightSeq, 1);
      renderAlignedToCanvas(leftCanvas, leftItem, noBarSettings, {
        seqIndex: leftSeq,
        totalEnabled: totalEst,
        firstTimestamp: firstTs,
        drawGuides: false,
        lang,
        batchColorTarget,
        customStickerImg,
      });
      renderAlignedToCanvas(rightCanvas, rightItem, noBarSettings, {
        seqIndex: rightSeq,
        totalEnabled: totalEst,
        firstTimestamp: firstTs,
        drawGuides: false,
        lang,
        batchColorTarget,
        customStickerImg,
      });

      const frameCanvas = makeCanvas(width, height);
      const ctx = frameCanvas.getContext("2d");
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
      const videoSource = new CanvasSource(frameCanvas, { codec: "avc", bitrate });
      output.addVideoTrack(videoSource, { frameRate: streamFps });
      const audioSource = new AudioBufferSource({ codec: "aac", bitrate: 128_000 });
      output.addAudioTrack(audioSource);
      await output.start();

      const totalFrames = 156;
      const frameDurSec = 1 / streamFps;
      for (let f = 0; f < totalFrames; f++) {
        if (f % 10 === 0 && onProgress) onProgress(f + 1, totalFrames, "encoding");
        let splitRatio;
        if (f < 15) splitRatio = 0;
        else if (f < 75) splitRatio = easeInOutCubic((f - 15) / 60);
        else if (f < 105) splitRatio = 1;
        else if (f < 135) splitRatio = 1 - 0.5 * easeInOutCubic((f - 105) / 30);
        else splitRatio = 0.5;

        const cutX = Math.round(width * splitRatio);
        ctx.drawImage(leftCanvas, 0, 0);
        if (cutX > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, cutX, height);
          ctx.clip();
          ctx.drawImage(rightCanvas, 0, 0);
          ctx.restore();
        }
        if (cutX > 2 && cutX < width - 2) {
          ctx.save();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
          ctx.lineWidth = Math.max(3, Math.round(width * 0.004));
          ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.moveTo(cutX, 0);
          ctx.lineTo(cutX, height);
          ctx.stroke();
          const hr = Math.max(16, Math.round(Math.min(width, height) * 0.028));
          ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
          ctx.beginPath();
          ctx.arc(cutX, height * 0.5, hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = "#ffffff";
          ctx.font = `700 ${Math.round(hr * 0.85)}px -apple-system, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("⇆", cutX, height * 0.5 + 1);
          ctx.restore();
        }
        await videoSource.add(f * frameDurSec, frameDurSec, { keyFrame: f % 60 === 0 });
      }
      videoSource.close();
      if (onProgress) onProgress(totalFrames, totalFrames, "finalizing");
      const renderedAudio = await renderBgmToAudioBuffer(
        audioOptions.audioBuffer,
        totalFrames * frameDurSec,
        audioOptions.volume,
        audioOptions.startOffsetSec || 0,
        48000
      );
      await audioSource.add(renderedAudio);
      audioSource.close();
      await output.finalize();
      return {
        blob: new Blob([target.buffer], { type: "video/mp4" }),
        ext: "mp4",
        audioIncluded: true,
        audioCodec: "aac",
      };
    } catch (err) {
      console.warn("Mediabunny Wipe audio failed:", err);
    } finally {
      if (isSafariBrowser()) {
        globalThis.AudioEncoder = origAE;
        globalThis.AudioData = origAD;
      }
    }
  }

  const canEncodeAudio = !!audioSpec;

  const target = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  };
  if (canEncodeAudio) {
    muxerOpts.audio = {
      codec: audioSpec.muxerCodec,
      numberOfChannels: audioSpec.config.numberOfChannels || 2,
      sampleRate: audioSpec.config.sampleRate || 48000,
    };
  }
  const muxer = new Muxer(muxerOpts);

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    },
  });
  encoder.configure(encoderConfig);

  const noBarSettings = { ...settings, showProgressBar: false };
  const leftCanvas = makeCanvas(width, height);
  const rightCanvas = makeCanvas(width, height);
  const totalEst = Math.max(leftSeq, rightSeq, 1);
  renderAlignedToCanvas(leftCanvas, leftItem, noBarSettings, {
    seqIndex: leftSeq,
    totalEnabled: totalEst,
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
    customStickerImg,
  });
  renderAlignedToCanvas(rightCanvas, rightItem, noBarSettings, {
    seqIndex: rightSeq,
    totalEnabled: totalEst,
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
    customStickerImg,
  });

  const frameCanvas = makeCanvas(width, height);
  const ctx = frameCanvas.getContext("2d");

  // Timeline: 0.5s hold Before -> 1.8s smooth wipe to After -> 1.0s hold After -> 1.2s wipe back to 50/50 split -> 0.8s hold split (5.3s total)
  const totalFrames = 156;
  const frameDurationUs = Math.round(1_000_000 / streamFps);

  for (let f = 0; f < totalFrames; f++) {
    if (encodeError) throw encodeError;
    if (f % 10 === 0 && onProgress) onProgress(f + 1, totalFrames, "encoding");

    let splitRatio; // fraction of canvas showing `rightItem` (from right or left — sweep left-to-right revealing After!)
    if (f < 15) {
      splitRatio = 0; // pure Before
    } else if (f < 75) {
      splitRatio = easeInOutCubic((f - 15) / 60); // sweep 0 -> 1 revealing After
    } else if (f < 105) {
      splitRatio = 1; // hold pure After
    } else if (f < 135) {
      splitRatio = 1 - 0.5 * easeInOutCubic((f - 105) / 30); // sweep back to 50/50 split finale!
    } else {
      splitRatio = 0.5;
    }

    const cutX = Math.round(width * splitRatio);
    ctx.drawImage(leftCanvas, 0, 0);
    if (cutX > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cutX, height);
      ctx.clip();
      ctx.drawImage(rightCanvas, 0, 0);
      ctx.restore();
    }

    // Crisp glowing curtain divider line + subtle handle when wiping
    if (cutX > 2 && cutX < width - 2) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = Math.max(3, Math.round(width * 0.004));
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(cutX, 0);
      ctx.lineTo(cutX, height);
      ctx.stroke();

      // Center pill handle
      const hr = Math.max(16, Math.round(Math.min(width, height) * 0.028));
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.beginPath();
      ctx.arc(cutX, height * 0.5, hr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.round(hr * 0.85)}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("⇆", cutX, height * 0.5 + 1);
      ctx.restore();
    }

    while (encoder.encodeQueueSize > 12) {
      await new Promise((r) => setTimeout(r, 8));
    }
    const vf = new VideoFrame(frameCanvas, {
      timestamp: f * frameDurationUs,
      duration: frameDurationUs,
    });
    encoder.encode(vf, { keyFrame: f % 60 === 0 });
    vf.close();
  }

  if (onProgress) onProgress(totalFrames, totalFrames, "finalizing");
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;

  let audioIncluded = false;
  let audioCodec = null;
  if (canEncodeAudio) {
    try {
      const res = await encodeBgmAudioTrack(
        muxer,
        audioSpec,
        audioOptions.audioBuffer,
        totalFrames / streamFps,
        audioOptions.volume,
        audioOptions.startOffsetSec || 0
      );
      audioIncluded = !!res.ok;
      audioCodec = res.codec || null;
    } catch (err) {
      console.error("Wipe audio muxing failed:", err);
    }
  }

  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
    audioIncluded,
    audioCodec,
    engine: "webcodecs",
  };
}
