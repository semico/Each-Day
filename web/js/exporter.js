/**
 * 100% Local In-Browser H.264 MP4 Video Exporter using WebCodecs + mp4-muxer (with MediaRecorder fallback).
 * Supports milestone frame extra hold, smooth progress bar progression, crossfade, and Auto Color Match.
 */

import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs";
import { getCanvasSize, renderAlignedToCanvas } from "./renderer.js";

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

async function exportWithWebCodecs(enabledItems, settings, lang, batchColorTarget, onProgress) {
  const [rawW, rawH] = getCanvasSize(settings);
  const width = rawW - (rawW % 2);
  const height = rawH - (rawH % 2);
  const streamFps = 30;
  const bitrate = settings.resolution === "1080p" ? 8_000_000 : 4_500_000;

  const encoderConfig = await pickH264Config(width, height, bitrate, streamFps);
  if (!encoderConfig) return null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });

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

  muxer.finalize();
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    ext: "mp4",
  };
}

async function exportWithMediaRecorder(enabledItems, settings, lang, batchColorTarget, onProgress) {
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
    });
    await new Promise((r) => setTimeout(r, msPerPhoto + (item.milestone ? milestoneMs : 0)));
  }
  if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
  recorder.stop();
  return done;
}

export async function exportTimelapseLocal(items, settings, lang, batchColorTarget, onProgress) {
  const enabled = items.filter((it) => it.enabled);
  if (!enabled.length) throw new Error("No enabled photos to export.");

  const wc = await exportWithWebCodecs(enabled, settings, lang, batchColorTarget, onProgress);
  if (wc) return wc;
  return exportWithMediaRecorder(enabled, settings, lang, batchColorTarget, onProgress);
}
