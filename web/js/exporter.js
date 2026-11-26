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
    {
      muxerCodec: "opus",
      config: { codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 },
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

/**
 * Render an AudioBuffer (starting at `startOffsetSec`, looped/trimmed to `durationSec`,
 * resampled to target sampleRate stereo with 0.65s fade-out) and feed it through WebCodecs AudioEncoder.
 */
async function encodeBgmAudioTrack(muxer, audioSpec, audioBuffer, durationSec, volume = 0.8, startOffsetSec = 0) {
  if (!audioSpec || !audioBuffer || durationSec <= 0.1) return { ok: false, chunks: 0, error: "no_audio" };
  const sampleRate = audioSpec.config.sampleRate || 48000;
  const numChannels = audioSpec.config.numberOfChannels || 2;

  const totalSamples = Math.ceil(durationSec * sampleRate);
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

  const rendered = await offline.startRendering();
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
  const videoStream = canvas.captureStream(30);

  let combinedStream = videoStream;
  let audioCtx = null;
  let audioSrc = null;
  let audioIncluded = false;

  const hasBgm = !!(audioOptions && audioOptions.audioBuffer);
  if (hasBgm && typeof (window.AudioContext || window.webkitAudioContext) !== "undefined") {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      const dest = audioCtx.createMediaStreamDestination();
      audioSrc = audioCtx.createBufferSource();
      audioSrc.buffer = audioOptions.audioBuffer;
      const maxOff = Math.max(0, audioOptions.audioBuffer.duration - 0.15);
      const offset = Math.max(0, Math.min(maxOff, Number(audioOptions.startOffsetSec) || 0));
      audioSrc.loop = true;
      audioSrc.loopStart = offset;
      audioSrc.loopEnd = audioOptions.audioBuffer.duration;
      const gain = audioCtx.createGain();
      gain.gain.value = Math.max(0.01, Math.min(1, Number(audioOptions.volume) || 0.8));
      audioSrc.connect(gain);
      gain.connect(dest);
      combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
      audioSrc.start(0, offset);
      audioIncluded = true;
    } catch (err) {
      console.warn("MediaRecorder audio mix unavailable:", err);
    }
  }

  const mimeCandidates = [
    "video/mp4;codecs=avc1,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mimeType = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported(m)) || "";
  const recorder = new MediaRecorder(combinedStream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      if (audioSrc) {
        try { audioSrc.stop(); } catch {}
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch {}
      }
      const isMp4 = (mimeType || "").includes("mp4");
      resolve({
        blob: new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" }),
        ext: isMp4 ? "mp4" : "webm",
        audioIncluded,
        audioCodec: audioIncluded ? (isMp4 ? "aac" : "opus") : null,
      });
    };
  });

  const firstTs = enabledItems[0].timestamp;
  const totalEnabled = enabledItems.length;
  const msPerPhoto = Math.round(1000 / Math.max(1, Number(settings.fps) || 6));
  const milestoneMs = Math.round((Number(settings.milestoneHoldSec) || 0.8) * 1000);
  const holdMs = Math.round((Number(settings.holdLastSec) || 0) * 1000);
  const customDurations =
    audioOptions && Array.isArray(audioOptions.photoDurationsSec) && audioOptions.photoDurationsSec.length === totalEnabled
      ? audioOptions.photoDurationsSec
      : null;

  recorder.start();
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
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  recorder.stop();
  return done;
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
  return exportWithMediaRecorder(enabled, settings, lang, batchColorTarget, customStickerImg, audioOptions, onProgress);
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
  const audioSpec = hasBgm ? await pickAudioEncoderConfig() : null;
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
  };
}
