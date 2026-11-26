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

async function pickAacConfig(sampleRate = 48000, numberOfChannels = 2) {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") {
    return null;
  }
  const cfg = { codec: "mp4a.40.2", sampleRate, numberOfChannels, bitrate: 128_000 };
  try {
    const sup = await AudioEncoder.isConfigSupported(cfg);
    if (sup.supported) return cfg;
  } catch {
    return null;
  }
  return null;
}

/**
 * Render an AudioBuffer (looped/trimmed to `durationSec`, resampled to 48kHz stereo with 0.6s fade-out)
 * and feed it through WebCodecs AudioEncoder into `muxer`.
 */
async function encodeBgmAudioTrack(muxer, audioBuffer, durationSec, volume = 0.8) {
  const sampleRate = 48000;
  const numChannels = 2;
  const aacCfg = await pickAacConfig(sampleRate, numChannels);
  if (!aacCfg || !audioBuffer || durationSec <= 0.1) return false;

  const totalSamples = Math.ceil(durationSec * sampleRate);
  const offline = new OfflineAudioContext(numChannels, totalSamples, sampleRate);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.loop = true;

  const gain = offline.createGain();
  const vol = Math.max(0.01, Math.min(1, Number(volume) || 0.8));
  gain.gain.setValueAtTime(vol, 0);
  const fadeDur = Math.min(0.65, durationSec * 0.25);
  gain.gain.setValueAtTime(vol, Math.max(0, durationSec - fadeDur));
  gain.gain.linearRampToValueAtTime(0.0001, durationSec);

  src.connect(gain);
  gain.connect(offline.destination);
  src.start(0);

  const rendered = await offline.startRendering();
  const ch0 = rendered.getChannelData(0);
  const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;

  let audioErr = null;
  const audioEncoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (err) => {
      audioErr = err;
    },
  });
  audioEncoder.configure(aacCfg);

  const chunkFrames = 1024;
  for (let offset = 0; offset < rendered.length; offset += chunkFrames) {
    if (audioErr) throw audioErr;
    const count = Math.min(chunkFrames, rendered.length - offset);
    // f32-planar layout: all ch0 samples followed by all ch1 samples
    const planar = new Float32Array(count * 2);
    planar.set(ch0.subarray(offset, offset + count), 0);
    planar.set(ch1.subarray(offset, offset + count), count);

    const ad = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: 2,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    audioEncoder.encode(ad);
    ad.close();
  }

  await audioEncoder.flush();
  audioEncoder.close();
  if (audioErr) throw audioErr;
  return true;
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
  const canEncodeAudio = hasBgm && !!(await pickAacConfig(48000, 2));

  const target = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  };
  if (canEncodeAudio) {
    muxerOpts.audio = { codec: "aac", numberOfChannels: 2, sampleRate: 48000 };
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
  const framesPerPhoto = Math.max(1, Math.round(streamFps / photoFps));
  const blendFrames =
    settings.crossfade && framesPerPhoto >= 3 ? Math.max(1, Math.min(Math.floor(framesPerPhoto / 2), 4)) : 0;
  const milestoneExtraFrames = Math.max(0, Math.round((Number(settings.milestoneHoldSec) || 0.8) * streamFps));
  const holdExtraFrames = Math.max(0, Math.round((Number(settings.holdLastSec) || 0) * streamFps));

  const currCanvas = makeCanvas(width, height);
  const prevCanvas = makeCanvas(width, height);
  const mixCanvas = makeCanvas(width, height);

  const firstTs = enabledItems[0].timestamp;
  const totalEnabled = enabledItems.length;
  const frameDurationUs = Math.round(1_000_000 / streamFps);
  let frameIndex = 0;

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

    const extraMilestone = item.milestone ? milestoneExtraFrames : 0;

    if (i > 0 && blendFrames > 0) {
      for (let b = 1; b <= blendFrames; b++) {
        blendCanvases(mixCanvas, prevCanvas, currCanvas, b / (blendFrames + 1));
        await encodeCanvas(mixCanvas, 1);
      }
      await encodeCanvas(currCanvas, Math.max(1, framesPerPhoto - blendFrames) + extraMilestone);
    } else {
      await encodeCanvas(currCanvas, framesPerPhoto + extraMilestone);
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
  if (canEncodeAudio) {
    const totalDurationSec = frameIndex / streamFps;
    try {
      audioIncluded = await encodeBgmAudioTrack(muxer, audioOptions.audioBuffer, totalDurationSec, audioOptions.volume);
    } catch (err) {
      console.warn("Audio muxing skipped:", err);
    }
  }

  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
    audioIncluded,
  };
}

async function exportWithMediaRecorder(enabledItems, settings, lang, batchColorTarget, customStickerImg, onProgress) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const canvas = makeCanvas(width, height);
  const stream = canvas.captureStream(30);

  const mimeCandidates = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported(m)) || "";
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      const isMp4 = (mimeType || "").includes("mp4");
      resolve({
        blob: new Blob(chunks, { type: isMp4 ? "video/mp4" : "video/webm" }),
        ext: isMp4 ? "mp4" : "webm",
        audioIncluded: false,
      });
    };
  });

  const firstTs = enabledItems[0].timestamp;
  const totalEnabled = enabledItems.length;
  const msPerPhoto = Math.round(1000 / Math.max(1, Number(settings.fps) || 6));
  const milestoneMs = Math.round((Number(settings.milestoneHoldSec) || 0.8) * 1000);
  const holdMs = Math.round((Number(settings.holdLastSec) || 0) * 1000);

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
    await new Promise((r) => setTimeout(r, msPerPhoto + (item.milestone ? milestoneMs : 0)));
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
  return exportWithMediaRecorder(enabled, settings, lang, batchColorTarget, customStickerImg, onProgress);
}

/**
 * 100% Local In-Browser Animated GIF Exporter via `gifenc` (ideal for GitHub, WeChat, Discord, Notion).
 */
export async function exportGifLocal(items, settings, lang, batchColorTarget, customStickerImg, onProgress) {
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

    let delay = baseDelayMs + (item.milestone ? milestoneMs : 0);
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
  const canEncodeAudio = hasBgm && !!(await pickAacConfig(48000, 2));

  const target = new ArrayBufferTarget();
  const muxerOpts = { target, video: { codec: "avc", width, height }, fastStart: "in-memory" };
  if (canEncodeAudio) {
    muxerOpts.audio = { codec: "aac", numberOfChannels: 2, sampleRate: 48000 };
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

  if (canEncodeAudio) {
    try {
      await encodeBgmAudioTrack(muxer, audioOptions.audioBuffer, totalFrames / streamFps, audioOptions.volume);
    } catch {
      // fallback silently to video-only
    }
  }

  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
  };
}
