import { getColorAdjustedCanvas } from "./color.js";

/**
 * Hardware-accelerated HTML5 Canvas renderer:
 *   - Multi-mode canonical targets (body / face / object / 2-point custom)
 *   - Optional Auto Exposure & Color Consistency Match
 *   - Optional Subject Depth-of-Field Background Bokeh Blur
 *   - Natural Gaussian blur edge fill with feathered borders
 *   - Automatic privacy face masks & stickers (self + bystanders: emoji/text/image/blur/mosaic)
 *   - 5 Editorial Label Themes (Pill, Magazine Cover, Minimal Bold, 35mm Film Stamp, Sports Tag)
 *   - Custom Label Template engine ({n}, {n2}, {day}, {date}, {yyyy}, {mm}, {dd}, {total}, {pct})
 *   - Sleek timeline progress bar overlay
 *   - High-resolution Before / After Comparison & Progress Grid Poster generators
 */

export function getCanvasSize(settings) {
  const base = settings.resolution === "1080p" ? 1080 : 720;
  const map = {
    "9:16": [base, Math.round((base * 16) / 9 / 2) * 2],
    "3:4": [base, Math.round((base * 4) / 3 / 2) * 2],
    "4:5": [base, Math.round((base * 5) / 4 / 2) * 2],
    "1:1": [base, base],
    "4:3": [Math.round((base * 4) / 3 / 2) * 2, base],
    "16:9": [Math.round((base * 16) / 9 / 2) * 2, base],
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

  if (mode === "object") {
    return {
      targetX: cw * 0.5,
      targetY: ch * (0.5 + settings.verticalShift),
      targetSpanPx: Math.min(cw, ch) * 0.58 * settings.zoom,
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
  if (aspect > 1.05) {
    neckYRatio = 0.27;
    torsoRatio = 0.34;
  } else if (aspect >= 0.85) {
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

export function formatWatermark(item, seqIndex, totalEnabled, firstTs, settings, lang = "zh") {
  if (!settings.showWatermark) return "";
  const elapsedDays = Math.max(1, Math.floor((item.timestamp - firstTs) / 86400) + 1);
  const seq2 = String(seqIndex).padStart(2, "0");
  const day2 = String(elapsedDays).padStart(2, "0");
  const parts = (item.dateStr || "2026.01.01").split(".");
  const yyyy = parts[0] || "2026";
  const mm = parts[1] || "01";
  const dd = parts[2] || "01";
  const pct = `${Math.round((seqIndex / Math.max(1, totalEnabled)) * 100)}%`;
  const stem = (item.filename || "").replace(/\.[^.]+$/, "");

  switch (settings.watermarkStyle) {
    case "template": {
      const tpl = (settings.labelTemplate || "Day {n2} · {date}").trim();
      if (!tpl) return "";
      return tpl
        .replace(/\{n2\}/gi, seq2)
        .replace(/\{n\}/gi, String(seqIndex))
        .replace(/\{day2\}/gi, day2)
        .replace(/\{day\}/gi, String(elapsedDays))
        .replace(/\{date\}/gi, item.dateStr)
        .replace(/\{yyyy\}/gi, yyyy)
        .replace(/\{yy\}/gi, yyyy.slice(-2))
        .replace(/\{mm\}/gi, mm)
        .replace(/\{dd\}/gi, dd)
        .replace(/\{total\}/gi, String(totalEnabled))
        .replace(/\{pct\}/gi, pct)
        .replace(/\{name\}/gi, stem);
    }
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
      return `Day ${day2}`;
    case "day_date":
    default:
      return `Day ${seq2}  ·  ${item.dateStr}`;
  }
}

// Reusable scratch canvases for blur-fill, bokeh depth-of-field, feathering, and privacy masking
let blurTinyCanvas = null;
let blurTinyCtx = null;
let fgScratchCanvas = null;
let fgScratchCtx = null;
let bokehBlurCanvas = null;
let bokehBlurCtx = null;
let bokehTinyCanvas = null;
let bokehTinyCtx = null;
let bokehMaskCanvas = null;
let bokehMaskCtx = null;
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

function splitHeadlineSub(text) {
  for (const sep of [" · ", "  ·  ", " | ", " // ", " - "]) {
    if (text.includes(sep)) {
      const idx = text.indexOf(sep);
      return [text.slice(0, idx).trim(), text.slice(idx + sep.length).trim()];
    }
  }
  return [text, ""];
}

function drawStyledLabel(ctx, cw, ch, text, settings, item) {
  if (!text) return;
  const theme = settings.labelTheme || "pill";
  const position = settings.watermarkPosition || "bottom_left";
  const shortSide = Math.min(cw, ch);

  if (theme === "magazine") {
    // Vogue / Kinfolk Editorial Magazine Cover Style
    const [head, sub] = splitHeadlineSub(text);
    const masthead = (settings.magazineTitle || "EACHDAY").trim().toUpperCase() || "EACHDAY";
    ctx.save();

    // Top subtle editorial dark vignette so masthead is ultra-legible
    const topGrad = ctx.createLinearGradient(0, 0, 0, ch * 0.24);
    topGrad.addColorStop(0, "rgba(0, 0, 0, 0.62)");
    topGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, cw, ch * 0.24);

    // Bottom subtle vignette for issue/date tagline
    const botGrad = ctx.createLinearGradient(0, ch * 0.78, 0, ch);
    botGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
    botGrad.addColorStop(1, "rgba(0, 0, 0, 0.68)");
    ctx.fillStyle = botGrad;
    ctx.fillRect(0, ch * 0.78, cw, ch * 0.22);

    // Thin inner magazine border frame
    const inset = Math.round(shortSide * 0.028);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = Math.max(1, Math.round(shortSide * 0.002));
    ctx.strokeRect(inset, inset, cw - inset * 2, ch - inset * 2);

    // Masthead serif headline at top center
    const titleSize = Math.max(24, Math.round(shortSide * 0.105));
    ctx.font = `800 ${titleSize}px Georgia, "Times New Roman", "Songti SC", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
    const spaced = masthead.split("").join(" ");
    ctx.fillText(spaced, cw * 0.5, inset + Math.round(shortSide * 0.028), cw - inset * 4);

    // Issue headline + date at bottom
    const mainSize = Math.max(18, Math.round(shortSide * 0.056));
    const subSize = Math.max(12, Math.round(shortSide * 0.028));
    const bottomY = ch - inset - Math.round(shortSide * 0.045);

    ctx.shadowBlur = 8;
    ctx.textBaseline = "bottom";
    if (sub) {
      ctx.font = `600 ${subSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif`;
      ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
      ctx.fillText(sub.toUpperCase(), cw * 0.5, bottomY);

      ctx.font = `700 ${mainSize}px Georgia, "Times New Roman", "Songti SC", serif`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(head.toUpperCase(), cw * 0.5, bottomY - subSize - Math.round(shortSide * 0.014));
    } else {
      ctx.font = `700 ${mainSize}px Georgia, "Times New Roman", "Songti SC", serif`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(head.toUpperCase(), cw * 0.5, bottomY);
    }
    ctx.restore();
    return;
  }

  if (theme === "film") {
    // Classic Retro 35mm Quartz Camera Timestamp (Kodak/Fuji amber glow)
    const fontSize = Math.max(15, Math.round(shortSide * 0.04));
    const marginX = Math.round(shortSide * 0.052);
    const marginY = Math.round(shortSide * 0.05);
    const [head, sub] = splitHeadlineSub(text);
    const parts = (item?.dateStr || "2026.01.01").split(".");
    const stamp = sub ? `'${(parts[0] || "26").slice(-2)} ${parts[1] || "01"} ${parts[2] || "01"}  ${head}` : text;

    ctx.save();
    ctx.font = `700 ${fontSize}px "Courier New", ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "middle";
    let tx = marginX;
    let ty = ch - marginY - fontSize * 0.5;
    if (position === "bottom_center") {
      ctx.textAlign = "center";
      tx = cw * 0.5;
    } else if (position === "top_left") {
      ctx.textAlign = "left";
      ty = marginY + fontSize * 0.5;
    } else if (position === "top_right") {
      ctx.textAlign = "right";
      tx = cw - marginX;
      ty = marginY + fontSize * 0.5;
    } else {
      ctx.textAlign = "left";
    }
    ctx.shadowColor = "rgba(255, 110, 0, 0.85)";
    ctx.shadowBlur = Math.max(6, fontSize * 0.35);
    ctx.fillStyle = "#ff8c2b";
    ctx.fillText(stamp, tx, ty);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffd08a";
    ctx.fillText(stamp, tx, ty);
    ctx.restore();
    return;
  }

  if (theme === "minimal") {
    // Clean Editorial Big Typography (zero background box)
    const [head, sub] = splitHeadlineSub(text);
    const bigSize = Math.max(18, Math.round(shortSide * 0.056));
    const smallSize = Math.max(12, Math.round(shortSide * 0.026));
    const marginX = Math.round(shortSide * 0.055);
    const marginY = Math.round(shortSide * 0.055);

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 2;

    let align = "left";
    let tx = marginX;
    let isTop = false;
    if (position === "bottom_center") {
      align = "center";
      tx = cw * 0.5;
    } else if (position === "top_left") {
      isTop = true;
    } else if (position === "top_right") {
      align = "right";
      tx = cw - marginX;
      isTop = true;
    }
    ctx.textAlign = align;

    if (isTop) {
      ctx.textBaseline = "top";
      ctx.font = `800 ${bigSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(head, tx, marginY);
      if (sub) {
        ctx.font = `500 ${smallSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.fillText(sub, tx, marginY + bigSize + 4);
      }
    } else {
      ctx.textBaseline = "bottom";
      if (sub) {
        ctx.font = `500 ${smallSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.fillText(sub, tx, ch - marginY);
        ctx.font = `800 ${bigSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(head, tx, ch - marginY - smallSize - 4);
      } else {
        ctx.font = `800 ${bigSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(head, tx, ch - marginY);
      }
    }
    ctx.restore();
    return;
  }

  if (theme === "sports") {
    // Sharp Athletic Neon Accent Bar Tag
    const fontSize = Math.max(13, Math.round(shortSide * 0.036));
    ctx.save();
    ctx.font = `800 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
    ctx.textBaseline = "middle";
    const display = text.toUpperCase();
    const tw = ctx.measureText(display).width;
    const stripeW = Math.max(4, Math.round(fontSize * 0.22));
    const padX = Math.round(fontSize * 0.65);
    const padY = Math.round(fontSize * 0.42);
    const boxW = Math.round(tw + padX * 2 + stripeW);
    const boxH = Math.round(fontSize * 1.15 + padY * 2);
    const marginX = Math.round(shortSide * 0.048);
    const marginY = Math.round(shortSide * 0.048);

    let px = marginX;
    let py = ch - marginY - boxH;
    if (position === "bottom_center") px = Math.round((cw - boxW) * 0.5);
    else if (position === "top_left") py = marginY;
    else if (position === "top_right") {
      px = cw - marginX - boxW;
      py = marginY;
    }

    drawRoundedRectPath(ctx, px, py, boxW, boxH, 6);
    ctx.fillStyle = "rgba(9, 13, 22, 0.78)";
    ctx.fill();

    // Vibrant emerald-blue accent stripe on left
    const stripeGrad = ctx.createLinearGradient(0, py, 0, py + boxH);
    stripeGrad.addColorStop(0, "#3b82f6");
    stripeGrad.addColorStop(1, "#10b981");
    ctx.fillStyle = stripeGrad;
    ctx.fillRect(px, py, stripeW, boxH);

    ctx.fillStyle = "#ffffff";
    ctx.fillText(display, px + stripeW + padX * 0.9, py + boxH * 0.53);
    ctx.restore();
    return;
  }

  // Default: "pill" (Signature Dark Frosted Pill)
  const fontSize = Math.max(13, Math.round(shortSide * 0.036));
  ctx.save();
  ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif`;
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(text);
  const tw = metrics.width;
  const padX = Math.round(fontSize * 0.72);
  const padY = Math.round(fontSize * 0.44);
  const pillW = Math.round(tw + padX * 2);
  const pillH = Math.round(fontSize * 1.15 + padY * 2);
  const marginX = Math.round(shortSide * 0.048);
  const marginY = Math.round(shortSide * 0.048);

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
  ctx.lineWidth = Math.max(1, shortSide / 720);
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

/**
 * Portrait Depth-of-Field Background Bokeh Blur:
 * Keeps the locked subject (pose silhouette / face / object) razor sharp while applying
 * creamy optical bokeh blur to the surrounding background.
 */
function applySubjectDepthOfField(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad) {
  if (!settings.bgBokeh) return;
  const strength = Math.max(0.15, Math.min(1.0, Number(settings.bgBokehStrength) || 0.6));
  const cw = targetCanvas.width;
  const ch = targetCanvas.height;

  // 1. Create softly blurred full-frame bokeh layer via multi-step downscale/upscale (zero Safari filter quirks)
  const blurScale = Math.max(0.045, 0.24 - strength * 0.17);
  const bw = Math.max(28, Math.round(cw * blurScale));
  const bh = Math.max(28, Math.round(ch * blurScale));

  if (!bokehTinyCanvas || bokehTinyCanvas.width !== bw || bokehTinyCanvas.height !== bh) {
    bokehTinyCanvas = document.createElement("canvas");
    bokehTinyCanvas.width = bw;
    bokehTinyCanvas.height = bh;
    bokehTinyCtx = bokehTinyCanvas.getContext("2d");
  }
  bokehTinyCtx.imageSmoothingEnabled = true;
  bokehTinyCtx.imageSmoothingQuality = "high";
  bokehTinyCtx.drawImage(targetCanvas, 0, 0, bw, bh);

  if (!bokehBlurCanvas || bokehBlurCanvas.width !== cw || bokehBlurCanvas.height !== ch) {
    bokehBlurCanvas = document.createElement("canvas");
    bokehBlurCanvas.width = cw;
    bokehBlurCanvas.height = ch;
    bokehBlurCtx = bokehBlurCanvas.getContext("2d");
  }
  bokehBlurCtx.imageSmoothingEnabled = true;
  bokehBlurCtx.imageSmoothingQuality = "high";
  bokehBlurCtx.drawImage(bokehTinyCanvas, 0, 0, bw, bh, 0, 0, cw, ch);

  // 2. Build soft feathered foreground focus mask around the locked subject
  if (!bokehMaskCanvas || bokehMaskCanvas.width !== cw || bokehMaskCanvas.height !== ch) {
    bokehMaskCanvas = document.createElement("canvas");
    bokehMaskCanvas.width = cw;
    bokehMaskCanvas.height = ch;
    bokehMaskCtx = bokehMaskCanvas.getContext("2d");
  }
  bokehMaskCtx.clearRect(0, 0, cw, ch);

  const drawSoftBlob = (cx, cy, rx, ry) => {
    const maxR = Math.max(12, Math.max(rx, ry));
    bokehMaskCtx.save();
    bokehMaskCtx.translate(cx, cy);
    bokehMaskCtx.scale(rx / maxR, ry / maxR);
    const grad = bokehMaskCtx.createRadialGradient(0, 0, maxR * 0.42, 0, 0, maxR);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.68, "rgba(255,255,255,0.92)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    bokehMaskCtx.fillStyle = grad;
    bokehMaskCtx.beginPath();
    bokehMaskCtx.arc(0, 0, maxR, 0, Math.PI * 2);
    bokehMaskCtx.fill();
    bokehMaskCtx.restore();
  };

  const t = item.transform;
  const mapPt = (sx, sy) => mapSourceToCanvas(sx, sy, t.srcCx, t.srcCy, dstCx, dstCy, totalScale, rotRad);
  const mode = settings.alignMode || "body";

  let hasFocusRegion = false;

  if (mode === "object" && item.objectCandidates && item.objectCandidates[item.selectedObject]) {
    const [x1, y1, x2, y2] = item.objectCandidates[item.selectedObject].bbox;
    const p1 = mapPt(x1, y1);
    const p2 = mapPt(x2, y2);
    const cx = (p1.x + p2.x) * 0.5;
    const cy = (p1.y + p2.y) * 0.5;
    const rx = Math.max(30, Math.abs(p2.x - p1.x) * 0.72);
    const ry = Math.max(30, Math.abs(p2.y - p1.y) * 0.72);
    drawSoftBlob(cx, cy, rx, ry);
    hasFocusRegion = true;
  } else if (item.candidates && item.candidates[item.selectedCandidate]) {
    const cand = item.candidates[item.selectedCandidate];
    const lm = cand.landmarks || {};
    const [bx1, by1, bx2, by2] = cand.bbox;
    const bwPx = Math.max(24, (bx2 - bx1) * totalScale);
    const bhPx = Math.max(40, (by2 - by1) * totalScale);

    // Organic multi-zone portrait matte following head + torso + hips/legs
    const face = getCandidateFaceCenterAndSize(cand);
    if (face) {
      const fp = mapPt(face.cx, face.cy);
      drawSoftBlob(fp.x, fp.y, face.w * totalScale * 0.92, face.h * totalScale * 0.95);
    }
    if (lm.neck && lm.root) {
      const np = mapPt(lm.neck.x, lm.neck.y);
      const rp = mapPt(lm.root.x, lm.root.y);
      const torsoLen = Math.hypot(np.x - rp.x, np.y - rp.y);
      const shWidth =
        lm.left_shoulder && lm.right_shoulder
          ? Math.hypot(lm.left_shoulder.x - lm.right_shoulder.x, lm.left_shoulder.y - lm.right_shoulder.y) * totalScale
          : bwPx * 0.55;
      // Upper chest & shoulders
      drawSoftBlob((np.x + rp.x) * 0.5, (np.y + rp.y) * 0.48, shWidth * 0.92, torsoLen * 0.85);
      // Hips & legs (extend below root smoothly)
      drawSoftBlob(rp.x, rp.y + torsoLen * 0.65, shWidth * 0.78, torsoLen * 1.15);
    } else {
      const p1 = mapPt(bx1, by1);
      const p2 = mapPt(bx2, by2);
      drawSoftBlob((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, bwPx * 0.68, bhPx * 0.68);
    }
    hasFocusRegion = true;
  }

  if (!hasFocusRegion) {
    // Graceful center portrait falloff for 2-point / fallback mode
    drawSoftBlob(dstCx, dstCy, Math.min(cw, ch) * 0.42, Math.min(cw, ch) * 0.52);
  }

  // 3. Cut out sharp subject area from bokehBlurCanvas (destination-out) and composite blurred background on top!
  bokehBlurCtx.save();
  bokehBlurCtx.globalCompositeOperation = "destination-out";
  bokehBlurCtx.drawImage(bokehMaskCanvas, 0, 0);
  bokehBlurCtx.restore();

  const ctx = targetCanvas.getContext("2d");
  ctx.drawImage(bokehBlurCanvas, 0, 0);
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

function isLikelyTextBadge(str) {
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(str);
}

function drawStickerAt(ctx, pos, dw, dh, stickerText, customImg) {
  if (customImg && customImg.width > 0 && customImg.height > 0) {
    const targetSize = Math.max(20, Math.max(dw, dh) * 1.18);
    const imgAspect = customImg.width / customImg.height;
    const drawW = imgAspect >= 1 ? targetSize : targetSize * imgAspect;
    const drawH = imgAspect >= 1 ? targetSize / imgAspect : targetSize;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(customImg, pos.x - drawW * 0.5, pos.y - drawH * 0.5, drawW, drawH);
    ctx.restore();
    return;
  }

  const txt = (stickerText || "😎").trim() || "😎";
  ctx.save();
  ctx.translate(pos.x, pos.y);
  if (isLikelyTextBadge(txt)) {
    const boxW = Math.max(26, dw * 1.15);
    const boxH = Math.max(22, dh * 0.72);
    const fontSize = Math.max(12, Math.min(boxH * 0.62, (boxW * 0.85) / Math.max(1, txt.length * 0.65)));
    drawRoundedRectPath(ctx, -boxW * 0.5, -boxH * 0.5, boxW, boxH, boxH * 0.45);
    ctx.fillStyle = "rgba(15, 20, 30, 0.92)";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, boxH * 0.05);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.stroke();
    ctx.font = `700 ${Math.round(fontSize)}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(txt, 0, 1);
  } else {
    const size = Math.max(16, Math.max(dw, dh) * 1.08);
    ctx.font = `${Math.round(size)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(txt, 0, size * 0.04);
  }
  ctx.restore();
}

function applyPrivacyMasks(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad, customStickerImg = null) {
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
      if (isSelf) {
        drawStickerAt(ctx, pos, dw, dh, settings.selfEmoji || "😎", customStickerImg);
      } else {
        drawStickerAt(ctx, pos, dw, dh, settings.bgEmoji || "😶", null);
      }
    } else if (mode === "blur" || mode === "mosaic") {
      applyOvalBlurOrMosaic(targetCanvas, pos.x, pos.y, dw * 0.56, dh * 0.62, mode);
    }
  }
}

function drawAlignmentGuides(ctx, cw, ch, targetX, targetY, targetSpanPx, mode) {
  ctx.save();
  ctx.strokeStyle = "rgba(96, 215, 255, 0.62)";
  ctx.lineWidth = Math.max(1, Math.min(cw, ch) / 540);

  if (mode === "face") {
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
  } else if (mode === "object") {
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    ctx.stroke();

    const half = targetSpanPx * 0.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(targetX - half, targetY - half, targetSpanPx, targetSpanPx);
    ctx.setLineDash([]);
  } else if (mode === "points") {
    ctx.beginPath();
    ctx.moveTo(targetX, 0);
    ctx.lineTo(targetX, ch);
    ctx.moveTo(0, targetY);
    ctx.lineTo(cw, targetY);
    ctx.stroke();

    const r = Math.max(6, Math.min(cw, ch) * 0.015);
    for (const sign of [-1, 1]) {
      const px = targetX + sign * targetSpanPx * 0.5;
      ctx.beginPath();
      ctx.arc(px, targetY, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
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
  const shortSide = Math.min(cw, ch);
  const barH = Math.max(4, Math.round(shortSide * 0.008));
  const padX = Math.round(shortSide * 0.045);
  const trackW = cw - padX * 2;
  const y = position === "bottom" ? ch - Math.round(shortSide * 0.018) - barH : Math.round(shortSide * 0.018);
  const fillW = Math.max(barH, Math.round(trackW * clamped));

  ctx.save();
  drawRoundedRectPath(ctx, padX, y, trackW, barH, barH * 0.5);
  ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
  ctx.fill();

  const grad = ctx.createLinearGradient(padX, 0, padX + trackW, 0);
  grad.addColorStop(0, "#3b82f6");
  grad.addColorStop(1, "#10b981");
  drawRoundedRectPath(ctx, padX, y, fillW, barH, barH * 0.5);
  ctx.fillStyle = grad;
  ctx.fill();

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
    customStickerImg = null,
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

  // Optional Portrait Depth-of-Field Background Bokeh Blur
  if (settings.bgBokeh) {
    applySubjectDepthOfField(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad);
  }

  // Automatic privacy face masks & stickers (self + bystanders)
  applyPrivacyMasks(targetCanvas, item, settings, dstCx, dstCy, totalScale, rotRad, customStickerImg);

  if (settings.showWatermark) {
    const text = formatWatermark(item, seqIndex, totalEnabled, firstTimestamp, settings, lang);
    drawStyledLabel(ctx, cw, ch, text, settings, item);
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
  batchColorTarget = null,
  customStickerImg = null
) {
  const [panelW, panelH] = getCanvasSize({ ...settings, resolution: "720p" });
  const gap = Math.max(8, Math.round(Math.min(panelW, panelH) * 0.014));
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
    totalEnabled: Math.max(leftSeq, rightSeq),
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
    customStickerImg,
  });

  const rightCanvas = document.createElement("canvas");
  rightCanvas.width = panelW;
  rightCanvas.height = panelH;
  renderAlignedToCanvas(rightCanvas, rightItem, noBarSettings, {
    seqIndex: rightSeq,
    totalEnabled: Math.max(leftSeq, rightSeq),
    firstTimestamp: firstTs,
    drawGuides: false,
    lang,
    batchColorTarget,
    customStickerImg,
  });

  ctx.drawImage(leftCanvas, 0, 0);
  ctx.drawImage(rightCanvas, panelW + gap, 0);

  const days = Math.max(0, Math.round(Math.abs(rightItem.timestamp - leftItem.timestamp) / 86400));
  const badgeText =
    days > 0
      ? lang === "en"
        ? `${days} Days Later`
        : `间隔 ${days} 天`
      : lang === "en"
      ? "BEFORE  →  AFTER"
      : "前后对比";

  const fontSize = Math.max(18, Math.round(Math.min(panelW, panelH) * 0.036));
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

/**
 * Render a gallery-style Progress Grid Collage Poster PNG (2x2, 3x2, 3x3, or 4x3).
 */
export function renderGridPosterCanvas(
  enabledItems,
  settings,
  { gridCount = 9, title = "EachDay Progress", lang = "zh", batchColorTarget = null, customStickerImg = null } = {}
) {
  const total = enabledItems.length;
  const targetN = Math.min(total, gridCount);
  const layouts = { 4: [2, 2], 6: [3, 2], 9: [3, 3], 12: [4, 3] };
  let [cols, rows] = layouts[gridCount] || [3, 3];
  if (targetN < cols * rows) {
    cols = Math.min(cols, targetN);
    rows = Math.ceil(targetN / cols);
  }

  const chosenIndices = [];
  if (targetN === 1) chosenIndices.push(0);
  else {
    for (let i = 0; i < targetN; i++) {
      chosenIndices.push(Math.round((i * (total - 1)) / (targetN - 1)));
    }
  }

  const [arW, arH] = settings.aspectRatio.split(":").map(Number);
  const cellW = Math.round(1440 / cols);
  const cellH = Math.round((cellW * arH) / arW);
  const pad = 28;
  const gap = 16;
  const headerH = 116;
  const footerH = 44;

  const out = document.createElement("canvas");
  out.width = pad * 2 + cols * cellW + (cols - 1) * gap;
  out.height = headerH + rows * cellH + (rows - 1) * gap + footerH;
  const ctx = out.getContext("2d");

  const bgGrad = ctx.createLinearGradient(0, 0, 0, out.height);
  bgGrad.addColorStop(0, "#10141e");
  bgGrad.addColorStop(1, "#090b10");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, out.width, out.height);

  const first = enabledItems[0];
  const last = enabledItems[total - 1];
  const spanDays = Math.max(1, Math.round(Math.abs(last.timestamp - first.timestamp) / 86400) + 1);
  const subtitle =
    lang === "en"
      ? `${first.dateStr}  →  ${last.dateStr}  ·  ${total} Check-ins (${spanDays} Days)`
      : `${first.dateStr}  →  ${last.dateStr}  ·  共 ${total} 次记录（跨度 ${spanDays} 天）`;

  ctx.save();
  ctx.fillStyle = "#f8fafc";
  ctx.font = `800 36px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((title || "EachDay").trim(), out.width * 0.5, 44);

  ctx.fillStyle = "#94a3b8";
  ctx.font = `500 18px -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif`;
  ctx.fillText(subtitle, out.width * 0.5, 84);
  ctx.restore();

  const cellCanvas = document.createElement("canvas");
  cellCanvas.width = cellW;
  cellCanvas.height = cellH;
  const cellSettings = { ...settings, showProgressBar: false };

  chosenIndices.forEach((itemIdx, pos) => {
    const r = Math.floor(pos / cols);
    const c = pos % cols;
    const x = pad + c * (cellW + gap);
    const y = headerH + r * (cellH + gap);

    renderAlignedToCanvas(cellCanvas, enabledItems[itemIdx], cellSettings, {
      seqIndex: itemIdx + 1,
      totalEnabled: total,
      firstTimestamp: first.timestamp,
      drawGuides: false,
      lang,
      batchColorTarget,
      customStickerImg,
    });

    ctx.save();
    drawRoundedRectPath(ctx, x, y, cellW, cellH, 14);
    ctx.clip();
    ctx.drawImage(cellCanvas, x, y);
    ctx.restore();

    ctx.save();
    drawRoundedRectPath(ctx, x, y, cellW, cellH, 14);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });

  ctx.save();
  ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
  ctx.font = `500 14px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Made locally with EachDay · Zero Upload", out.width * 0.5, out.height - footerH * 0.5);
  ctx.restore();

  return out;
}
