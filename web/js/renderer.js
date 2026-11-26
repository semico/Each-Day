import { getColorAdjustedCanvas } from "./color.js";

/**
 * Hardware-accelerated HTML5 Canvas renderer:
 *   - Multi-mode canonical targets (body / face / 2-point custom)
 *   - Optional Auto Exposure & Color Consistency Match
 *   - Natural Gaussian blur fill with feathered borders
 *   - Automatic privacy face masks & emoji stickers (self + background strangers)
 *   - Customizable date / day / custom-prefix frosted pill watermarks
 *   - Sleek timeline progress bar overlay
 *   - High-resolution Before / After side-by-side comparison card generator
 */

export function getCanvasSize(settings) {
  const baseW = settings.resolution === "1080p" ? 1080 : 720;
  const map = {
    "9:16": [baseW, Math.round((baseW * 16) / 9 / 2) * 2],
    "3:4": [baseW, Math.round((baseW * 4) / 3 / 2) * 2],
    "4:5": [baseW, Math.round((baseW * 5) / 4 / 2) * 2],
    "1:1": [baseW, baseW],
  };
  return map[settings.aspectRatio] || map["9:16"];
}

export function getCanonicalTarget(cw, ch, settings) {
  const mode = settings.alignMode || "body";

  if (mode === "face") {
    return {
      targetX: cw * 0.5,
      targetY: ch * (0.41 + settings.verticalShift),
      targetSpanPx: Math.min(cw, ch) * 0.23 * settings.zoom,
    };
  }

  if (mode === "points") {
    return {
      targetX: cw * 0.5,
      targetY: ch * (0.5 + settings.verticalShift),
      targetSpanPx: Math.min(cw, ch) * 0.36 * settings.zoom,
    };
  }

  // Default: "body"
  const aspect = cw / ch;
  let neckYRatio = 0.295;
  let torsoRatio = 0.245;
  if (aspect >= 0.85) {
    neckYRatio = 0.28;
    torsoRatio = 0.33;
  } else if (aspect >= 0.65) {
    neckYRatio = 0.285;
    torsoRatio = 0.285;
  }
  return {
    targetX: cw * 0.5,
    targetY: ch * (neckYRatio + settings.verticalShift),
    targetSpanPx: ch * torsoRatio * settings.zoom,
  };
}

export function formatWatermark(item, seqIndex, firstTs, settings, lang = "zh") {
  if (!settings.showWatermark) return "";
  const elapsedDays = Math.max(1, Math.floor((item.timestamp - firstTs) / 86400) + 1);
  const seq2 = String(seqIndex).padStart(2, "0");

  switch (settings.watermarkStyle) {
    case "custom": {
      const prefix = (settings.customPrefix || "Day ").trimEnd();
      const counter = settings.customUseElapsed ? String(elapsedDays) : seq2;
      const sep = prefix.endsWith("#") || /[\u4e00-\u9fa5]$/.test(prefix) ? "" : " ";
      const label = prefix ? `${prefix}${sep}${counter}` : counter;
      return settings.customShowDate !== false ? `${label}  ·  ${item.dateStr}` : label;
    }
    case "count_date":
      return lang === "en" ? `#${seqIndex}  ·  ${item.dateStr}` : `第 ${seqIndex} 次  ·  ${item.dateStr}`;
    case "date_only":
      return item.dateStr;
    case "day_only":
      return `Day ${String(elapsedDays).padStart(2, "0")}`;
    case "day_date":
    default:
      return `Day ${seq2}  ·  ${item.dateStr}`;
  }
}

// Reusable scratch canvases for blur-fill, feathering, and face privacy masking
let blurTinyCanvas = null;
let blurTinyCtx = null;
let fgScratchCanvas = null;
let fgScratchCtx = null;
let maskPatchCanvas = null;
let maskPatchCtx = null;

function drawBlurBackground(ctx, srcCanvas, cw, ch) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const coverScale = Math.max(cw / sw, ch / sh);
  const cropW = Math.min(sw, cw / coverScale);
  const cropH = Math.min(sh, ch / coverScale);
  const sx = (sw - cropW) * 0.5;
  const sy = (sh - cropH) * 0.5;

  const tinyW = 36;
  const tinyH = Math.max(24, Math.round((tinyW * ch) / cw));
  if (!blurTinyCanvas || blurTinyCanvas.width !== tinyW || blurTinyCanvas.height !== tinyH) {
    blurTinyCanvas = document.createElement("canvas");
    blurTinyCanvas.width = tinyW;
    blurTinyCanvas.height = tinyH;
    blurTinyCtx = blurTinyCanvas.getContext("2d");
  }

  blurTinyCtx.imageSmoothingEnabled = true;
  blurTinyCtx.imageSmoothingQuality = "high";
  blurTinyCtx.drawImage(srcCanvas, sx, sy, cropW, cropH, 0, 0, tinyW, tinyH);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(blurTinyCanvas, 0, 0, tinyW, tinyH, 0, 0, cw, ch);
  ctx.fillStyle = "rgba(0, 0, 0, 0.34)";
  ctx.fillRect(0, 0, cw, ch);
  ctx.restore();
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawWatermark(ctx, cw, ch, text, position) {
  if (!text) return;
  const fontSize = Math.max(13, Math.round(cw * 0.036));
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif`;
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(text);
  const tw = metrics.width;
  const padX = Math.round(fontSize * 0.72);
  const padY = Math.round(fontSize * 0.44);
  const pillW = Math.round(tw + padX * 2);
  const pillH = Math.round(fontSize * 1.15 + padY * 2);
  const marginX = Math.round(cw * 0.048);
  const marginY = Math.round(ch * 0.045);

  let px = marginX;
  let py = ch - marginY - pillH;
  if (position === "bottom_center") {
    px = Math.round((cw - pillW) * 0.5);
  } else if (position === "top_left") {
    py = marginY;
  } else if (position === "top_right") {
    px = cw - marginX - pillW;
    py = marginY;
  }

  drawRoundedRectPath(ctx, px, py, pillW, pillH, pillH * 0.5);
  ctx.fillStyle = "rgba(12, 14, 18, 0.64)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, cw / 720);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.stroke();

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillText(text, px + padX, py + pillH * 0.52 + 1);
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.fillText(text, px + padX, py + pillH * 0.52);
  ctx.restore();
}

function drawFeatheredSource(ctx, srcCanvas, dstCx, dstCy, srcCx, srcCy, totalScale, rotRad, cw, ch) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  if (!fgScratchCanvas || fgScratchCanvas.width !== cw || fgScratchCanvas.height !== ch) {
    fgScratchCanvas = document.createElement("canvas");
    fgScratchCanvas.width = cw;
    fgScratchCanvas.height = ch;
    fgScratchCtx = fgScratchCanvas.getContext("2d");
  }

  fgScratchCtx.clearRect(0, 0, cw, ch);
  fgScratchCtx.save();
  fgScratchCtx.imageSmoothingEnabled = true;
  fgScratchCtx.imageSmoothingQuality = "high";
  fgScratchCtx.translate(dstCx, dstCy);
  fgScratchCtx.rotate(rotRad);
  fgScratchCtx.scale(totalScale, totalScale);
  fgScratchCtx.translate(-srcCx, -srcCy);
  fgScratchCtx.drawImage(srcCanvas, 0, 0);

  const featherSrc = Math.max(6, Math.min(sw, sh) * 0.018);
  fgScratchCtx.globalCompositeOperation = "destination-out";

  let g = fgScratchCtx.createLinearGradient(0, 0, 0, featherSrc);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, -2, sw + 4, featherSrc + 2);

  g = fgScratchCtx.createLinearGradient(0, sh - featherSrc, 0, sh);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, sh - featherSrc, sw + 4, featherSrc + 2);

  g = fgScratchCtx.createLinearGradient(0, 0, featherSrc, 0);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, -2, featherSrc + 2, sh + 4);

  g = fgScratchCtx.createLinearGradient(sw - featherSrc, 0, sw, 0);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(sw - featherSrc, -2, featherSrc + 2, sh + 4);

  fgScratchCtx.restore();
  ctx.drawImage(fgScratchCanvas, 0, 0);
}

function getCandidateFaceCenterAndSize(cand) {
  if (cand.faceBbox) {
    const [x1, y1, x2, y2] = cand.faceBbox;
    return {
      cx: (x1 + x2) * 0.5,
      cy: (y1 + y2) * 0.5,
      w: Math.max(12, x2 - x1),
      h: Math.max(12, y2 - y1),
    };
  }
  const lm = cand.landmarks || {};
  const pts = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"].map((k) => lm[k]).filter(Boolean);
  if (!pts.length) return null;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const side = lm.neck
    ? Math.max(18, Math.hypot(cx - lm.neck.x, cy - lm.neck.y) * 1.15)
    : Math.max(18, (cand.bbox[2] - cand.bbox[0]) * 0.32);
  return { cx, cy, w: side, h: side * 1.15 };
}

function mapSourceToCanvas(sx, sy, srcCx, srcCy, dstCx, dstCy, totalScale, rotRad) {
  const dx = (sx - srcCx) * totalScale;
  const dy = (sy - srcCy) * totalScale;
  const cos = Math.cos(rotRad);
  const sin = Math.sin(rotRad);
  return {
    x: dstCx + dx * cos - dy * sin,
    y: dstCy + dx * sin + dy * cos,
  };
}

function applyOvalBlurOrMosaic(targetCanvas, cx, cy, rx, ry, mode) {
  const cw = targetCanvas.width;
  const ch = targetCanvas.height;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const x1 = Math.min(cw, Math.ceil(cx + rx));
  const y1 = Math.min(ch, Math.ceil(cy + ry));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw < 6 || bh < 6) return;

  const sampleSize = mode === "mosaic" ? 7 : 9;
  if (!maskPatchCanvas) {
    maskPatchCanvas = document.createElement("canvas");
    maskPatchCtx = maskPatchCanvas.getContext("2d");
  }
  maskPatchCanvas.width = sampleSize;
  maskPatchCanvas.height = sampleSize;
  maskPatchCtx.imageSmoothingEnabled = true;
  maskPatchCtx.drawImage(targetCanvas, x0, y0, bw, bh, 0, 0, sampleSize, sampleSize);

  const ctx = targetCanvas.getContext("2d");
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingEnabled = mode !== "mosaic";
  if (mode !== "mosaic") ctx.imageSmoothingQuality = "high";
  ctx.drawImage(maskPatchCanvas, 0, 0, sampleSize, sampleSize, x0, y0, bw, bh);
  ctx.restore();
}

function applyPrivacyMasks(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad) {
  const selfMask = settings.selfMask || "none";
  const bgMask = settings.bgMask || "none";
  if (selfMask === "none" && bgMask === "none") return;
  if (!item.candidates || !item.candidates.length) return;

  const t = item.transform;
  const scaleMul = Number(settings.maskScale) || 1.15;
  const ctx = targetCanvas.getContext("2d");

  for (const cand of item.candidates) {
    const isSelf = cand.index === item.selectedCandidate;
    const mode = isSelf ? selfMask : bgMask;
    if (!mode || mode === "none") continue;

    const face = getCandidateFaceCenterAndSize(cand);
    if (!face) continue;

    const pos = mapSourceToCanvas(face.cx, face.cy, t.srcCx, t.srcCy, dstCx, dstCy, totalScale, rotRad);
    const dw = face.w * totalScale * scaleMul;
    const dh = face.h * totalScale * scaleMul;

    if (pos.x + dw < 0 || pos.x - dw > targetCanvas.width || pos.y + dh < 0 || pos.y - dh > targetCanvas.height) {
      continue;
    }

    if (mode === "emoji") {
      const emoji = settings.selfEmoji || "😎";
      const size = Math.max(16, Math.max(dw, dh) * 1.08);
      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.font = `${Math.round(size)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emoji, 0, size * 0.04);
      ctx.restore();
    } else if (mode === "blur" || mode === "mosaic") {
      applyOvalBlurOrMosaic(targetCanvas, pos.x, pos.y, dw * 0.56, dh * 0.62, mode);
    }
  }
}

function drawAlignmentGuides(ctx, cw, ch, targetX, targetY, targetSpanPx, mode) {
  ctx.save();
  ctx.strokeStyle = "rgba(96, 215, 255, 0.62)";
  ctx.lineWidth = Math.max(1, cw / 540);

  if (mode === "face") {
    // Centerline + Eye Line + Left/Right Eye Targets
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    ctx.stroke();

    const r = Math.max(5, targetSpanPx * 0.14);
    for (const sign of [-1, 1]) {
      const ex = targetX + sign * targetSpanPx * 0.5;
      ctx.beginPath();
      ctx.arc(ex, targetY, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (mode === "points") {
    // Centerline + Horizontal A <-> B Anchor Targets
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    ctx.stroke();

    const r = Math.max(6, cw * 0.015);
    ctx.fillStyle = "rgba(16, 185, 129, 0.9)";
    for (const sign of [-1, 1]) {
      const px = targetX + sign * targetSpanPx * 0.5;
      ctx.beginPath();
      ctx.arc(px, targetY, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    // Body mode: Centerline + Neck Line + Hip Line + Head Circle
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    const hipY = targetY + targetSpanPx;
    ctx.moveTo(targetX - targetSpanPx * 0.45, hipY);
    ctx.lineTo(targetX + targetSpanPx * 0.45, hipY);
    ctx.stroke();

    const headY = targetY - targetSpanPx * 0.34;
    ctx.beginPath();
    ctx.arc(targetX, headY, Math.max(4, targetSpanPx * 0.045), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawProgressBar(ctx, cw, ch, ratio, position = "top") {
  const clamped = Math.max(0.01, Math.min(1, Number(ratio) || 0));
  const barH = Math.max(4, Math.round(cw * 0.008));
  const padX = Math.round(cw * 0.045);
  const trackW = cw - padX * 2;
  const y = position === "bottom" ? ch - Math.round(ch * 0.018) - barH : Math.round(ch * 0.018);
  const fillW = Math.max(barH, Math.round(trackW * clamped));

  ctx.save();
  // Translucent dark track
  drawRoundedRectPath(ctx, padX, y, trackW, barH, barH * 0.5);
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fill();

  // Gradient progress fill
  const grad = ctx.createLinearGradient(padX, 0, padX + trackW, 0);
  grad.addColorStop(0, "#3b82f6");
  grad.addColorStop(1, "#10b981");
  drawRoundedRectPath(ctx, padX, y, fillW, barH, barH * 0.5);
  ctx.fillStyle = grad;
  ctx.fill();

  // Subtle glowing indicator dot at the tip
  ctx.beginPath();
  ctx.arc(padX + fillW, y + barH * 0.5, barH * 0.72, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
}

/**
 * Render an aligned frame directly onto targetCanvas.
 */
export function renderAlignedToCanvas(
  targetCanvas,
  item,
  settings,
  {
    seqIndex = 1,
    totalEnabled = 1,
    firstTimestamp = item.timestamp,
    drawGuides = false,
    lang = "zh",
    batchColorTarget = null,
    progressRatio = null,
  } = {}
) {
  const cw = targetCanvas.width;
  const ch = targetCanvas.height;
  const ctx = targetCanvas.getContext("2d");

  const srcCanvas =
    settings.autoColorMatch && batchColorTarget
      ? getColorAdjustedCanvas(item, batchColorTarget, settings.colorMatchStrength)
      : item.canvas;

  const t = item.transform;
  const { targetX, targetY, targetSpanPx } = getCanonicalTarget(cw, ch, settings);
  const dstCx = targetX + t.userDx * cw;
  const dstCy = targetY + t.userDy * ch;
  const totalScale = t.scale * targetSpanPx * t.userScale;

  const totalAngleDeg = (settings.autoLevel ? t.angleDeg : 0) + t.userAngleDeg;
  const rotRad = (-totalAngleDeg * Math.PI) / 180;

  if (settings.fillMode === "black") {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(dstCx, dstCy);
    ctx.rotate(rotRad);
    ctx.scale(totalScale, totalScale);
    ctx.translate(-t.srcCx, -t.srcCy);
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.restore();
  } else if (settings.fillMode === "edge") {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(srcCanvas, 0, 0, cw, ch);
    ctx.translate(dstCx, dstCy);
    ctx.rotate(rotRad);
    ctx.scale(totalScale, totalScale);
    ctx.translate(-t.srcCx, -t.srcCy);
    ctx.drawImage(srcCanvas, 0, 0);
    ctx.restore();
  } else {
    drawBlurBackground(ctx, srcCanvas, cw, ch);
    drawFeatheredSource(ctx, srcCanvas, dstCx, dstCy, t.srcCx, t.srcCy, totalScale, rotRad, cw, ch);
  }

  // Apply automatic privacy face masks / stickers before watermark
  applyPrivacyMasks(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad);

  if (settings.showWatermark) {
    const text = formatWatermark(item, seqIndex, firstTimestamp, settings, lang);
    drawWatermark(ctx, cw, ch, text, settings.watermarkPosition);
  }

  if (settings.showProgressBar) {
    const ratio = progressRatio !== null ? progressRatio : seqIndex / Math.max(1, totalEnabled);
    drawProgressBar(ctx, cw, ch, ratio, settings.progressBarPos || "top");
  }

  if (drawGuides) {
    drawAlignmentGuides(ctx, cw, ch, targetX, targetY, targetSpanPx, settings.alignMode || "body");
  }
}

/**
 * Render a crisp high-resolution side-by-side Before / After comparison card.
 */
export function renderComparisonCanvas(
  leftItem,
  rightItem,
  leftSeq,
  rightSeq,
  firstTs,
  settings,
  lang = "zh",
  batchColorTarget = null
) {
  const [panelW, panelH] = getCanvasSize({ ...settings, resolution: "720p" });
  const gap = Math.max(8, Math.round(panelW * 0.014));
  const out = document.createElement("canvas");
  out.width = panelW * 2 + gap;
  out.height = panelH;
  const ctx = out.getContext("2d");

  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, out.width, out.height);

  const noBarSettings = { ...settings, showProgressBar: false };

  const leftCanvas = document.createElement("canvas");
  leftCanvas.width = panelW;
  leftCanvas.height = panelH;
  renderAlignedToCanvas(leftCanvas, leftItem, noBarSettings, {
    seqIndex: leftSeq,
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
  });

  const rightCanvas = document.createElement("canvas");
  rightCanvas.width = panelW;
  rightCanvas.height = panelH;
  renderAlignedToCanvas(rightCanvas, rightItem, noBarSettings, {
    seqIndex: rightSeq,
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
  });

  ctx.drawImage(leftCanvas, 0, 0);
  ctx.drawImage(rightCanvas, panelW + gap, 0);

  // Center elapsed-days badge
  const days = Math.max(0, Math.round(Math.abs(rightItem.timestamp - leftItem.timestamp) / 86400));
  const badgeText =
    days > 0
      ? lang === "en"
        ? `${days} Days Later`
        : `间隔 ${days} 天`
      : lang === "en"
      ? "BEFORE  →  AFTER"
      : "前后对比";

  const fontSize = Math.max(18, Math.round(panelW * 0.036));
  ctx.save();
  ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(badgeText).width;
  const padX = Math.round(fontSize * 0.85);
  const padY = Math.round(fontSize * 0.45);
  const bw = Math.round(tw + padX * 2);
  const bh = Math.round(fontSize * 1.15 + padY * 2);
  const bx = Math.round((out.width - bw) * 0.5);
  const by = Math.round(panelH * 0.045);

  drawRoundedRectPath(ctx, bx, by, bw, bh, bh * 0.5);
  ctx.fillStyle = "rgba(12, 14, 18, 0.78)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(badgeText, bx + padX, by + bh * 0.52);
  ctx.restore();

  return out;
}
