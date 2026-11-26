/** Hardware-accelerated HTML5 Canvas frame renderer (blur fill, feathered edges, frosted pill watermark, guides). */

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
    targetTorsoPx: ch * torsoRatio * settings.zoom,
  };
}

export function formatWatermark(item, seqIndex, firstTs, settings, lang = "zh") {
  if (!settings.showWatermark) return "";
  const elapsedDays = Math.max(1, Math.floor((item.timestamp - firstTs) / 86400) + 1);
  const seq2 = String(seqIndex).padStart(2, "0");
  switch (settings.watermarkStyle) {
    case "count_date":
      return lang === "en" ? `Session ${seqIndex}  ·  ${item.dateStr}` : `第 ${seqIndex} 次  ·  ${item.dateStr}`;
    case "date_only":
      return item.dateStr;
    case "day_only":
      return `Day ${String(elapsedDays).padStart(2, "0")}`;
    case "day_date":
    default:
      return `Day ${seq2}  ·  ${item.dateStr}`;
  }
}

// Reusable scratch canvases for blur-fill & feathering (avoids GC churn during 60fps dragging)
let blurTinyCanvas = null;
let blurTinyCtx = null;
let fgScratchCanvas = null;
let fgScratchCtx = null;

function drawBlurBackground(ctx, srcCanvas, cw, ch) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const coverScale = Math.max(cw / sw, ch / sh);
  const cropW = Math.min(sw, cw / coverScale);
  const cropH = Math.min(sh, ch / coverScale);
  const sx = (sw - cropW) * 0.5;
  const sy = (sh - cropH) * 0.5;

  // Multi-step downsample -> smooth bilinear upscale yields a silky, cross-browser Gaussian-like blur in <1ms
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
  // Darken background slightly so aligned foreground pops cleanly
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
  ctx.fillStyle = "rgba(12, 14, 18, 0.62)";
  ctx.fill();
  ctx.lineWidth = Math.max(1, cw / 720);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.stroke();

  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillText(text, px + padX, py + pillH * 0.52 + 1);
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.fillText(text, px + padX, py + pillH * 0.52);
  ctx.restore();
}

function drawFeatheredSource(ctx, srcCanvas, dstCx, dstCy, srcCx, srcCy, totalScale, rotRad, cw, ch) {
  // Check if source image completely covers canvas; if not, render with softly feathered border on scratch canvas
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

  // Softly feather the 4 outer edges of the source photo in source-pixel space
  const featherSrc = Math.max(6, Math.min(sw, sh) * 0.018);
  fgScratchCtx.globalCompositeOperation = "destination-out";

  // Top edge
  let g = fgScratchCtx.createLinearGradient(0, 0, 0, featherSrc);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, -2, sw + 4, featherSrc + 2);

  // Bottom edge
  g = fgScratchCtx.createLinearGradient(0, sh - featherSrc, 0, sh);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, sh - featherSrc, sw + 4, featherSrc + 2);

  // Left edge
  g = fgScratchCtx.createLinearGradient(0, 0, featherSrc, 0);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(-2, -2, featherSrc + 2, sh + 4);

  // Right edge
  g = fgScratchCtx.createLinearGradient(sw - featherSrc, 0, sw, 0);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  fgScratchCtx.fillStyle = g;
  fgScratchCtx.fillRect(sw - featherSrc, -2, featherSrc + 2, sh + 4);

  fgScratchCtx.restore();
  ctx.drawImage(fgScratchCanvas, 0, 0);
}

/**
 * Render an aligned frame directly onto targetCanvas.
 */
export function renderAlignedToCanvas(
  targetCanvas,
  item,
  settings,
  { seqIndex = 1, firstTimestamp = item.timestamp, drawGuides = false, lang = "zh" } = {}
) {
  const cw = targetCanvas.width;
  const ch = targetCanvas.height;
  const ctx = targetCanvas.getContext("2d");

  const t = item.transform;
  const { targetX, targetY, targetTorsoPx } = getCanonicalTarget(cw, ch, settings);
  const dstCx = targetX + t.userDx * cw;
  const dstCy = targetY + t.userDy * ch;
  const totalScale = t.scale * targetTorsoPx * t.userScale;

  // Note: OpenCV positive angle = CCW; Canvas ctx.rotate positive = CW -> negate!
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
    ctx.drawImage(item.canvas, 0, 0);
    ctx.restore();
  } else if (settings.fillMode === "edge") {
    // Soft stretched cover background behind exact aligned image
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(item.canvas, 0, 0, cw, ch);
    ctx.translate(dstCx, dstCy);
    ctx.rotate(rotRad);
    ctx.scale(totalScale, totalScale);
    ctx.translate(-t.srcCx, -t.srcCy);
    ctx.drawImage(item.canvas, 0, 0);
    ctx.restore();
  } else {
    // Default: natural Gaussian blur fill with feathered edges
    drawBlurBackground(ctx, item.canvas, cw, ch);
    drawFeatheredSource(ctx, item.canvas, dstCx, dstCy, t.srcCx, t.srcCy, totalScale, rotRad, cw, ch);
  }

  if (settings.showWatermark) {
    const text = formatWatermark(item, seqIndex, firstTimestamp, settings, lang);
    drawWatermark(ctx, cw, ch, text, settings.watermarkPosition);
  }

  if (drawGuides) {
    ctx.save();
    ctx.strokeStyle = "rgba(96, 215, 255, 0.58)";
    ctx.lineWidth = Math.max(1, cw / 540);
    // Vertical centerline
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    // Neck horizontal line
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    // Hip horizontal tick
    const hipY = targetY + targetTorsoPx;
    ctx.moveTo(targetX - targetTorsoPx * 0.45, hipY);
    ctx.lineTo(targetX + targetTorsoPx * 0.45, hipY);
    ctx.stroke();

    // Head circle
    const headY = targetY - targetTorsoPx * 0.34;
    ctx.beginPath();
    ctx.arc(targetX, headY, Math.max(4, targetTorsoPx * 0.045), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
