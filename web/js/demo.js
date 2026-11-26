/**
 * Instant 1-Click Interactive Sample Demo Generator (100% Procedural & Offline).
 * Creates 8 crisp, varied-framing & varied-lighting progress photos with ground-truth pose/face/object
 * metadata so first-time visitors can test Body, Face, Object, Color Match, Privacy Stickers,
 * Before/After Wipe, Grid Poster, GIF & MP4 exports in <0.5s with zero photo upload.
 */

import { computePhotoColorStats } from "./color.js";

const DEMO_DAYS = [
  { date: "2026.01.05", ts: 1767571200, shiftX: -0.09, shiftY: 0.04, scale: 0.84, tilt: -3.5, warm: -18, bright: -20, shirt: "#475569", muscle: 0.0, bgPerson: true },
  { date: "2026.01.18", ts: 1768694400, shiftX: 0.08, shiftY: -0.05, scale: 1.08, tilt: 2.8, warm: 22, bright: 12, shirt: "#0f766e", muscle: 0.16, bgPerson: false },
  { date: "2026.02.02", ts: 1769990400, shiftX: -0.06, shiftY: 0.06, scale: 0.90, tilt: -2.0, warm: -8, bright: 18, shirt: "#1d4ed8", muscle: 0.32, bgPerson: true },
  { date: "2026.02.16", ts: 1771200000, shiftX: 0.10, shiftY: 0.02, scale: 1.14, tilt: 4.0, warm: 16, bright: -14, shirt: "#334155", muscle: 0.48, bgPerson: false },
  { date: "2026.03.03", ts: 1772496000, shiftX: -0.07, shiftY: -0.04, scale: 0.86, tilt: -1.5, warm: 6, bright: 8, shirt: "#047857", muscle: 0.65, bgPerson: true },
  { date: "2026.03.19", ts: 1773878400, shiftX: 0.05, shiftY: 0.05, scale: 1.05, tilt: 2.2, warm: -14, bright: -10, shirt: "#4338ca", muscle: 0.80, bgPerson: false },
  { date: "2026.04.04", ts: 1775260800, shiftX: -0.08, shiftY: -0.02, scale: 0.94, tilt: -3.0, warm: 20, bright: 16, shirt: "#0369a1", muscle: 0.92, bgPerson: true },
  { date: "2026.04.20", ts: 1776643200, shiftX: 0.03, shiftY: 0.01, scale: 1.12, tilt: 1.2, warm: 4, bright: 6, shirt: "#10b981", muscle: 1.0, bgPerson: false },
];

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgbTint(r, g, b, bright, warm) {
  return `rgb(${clamp255(r + bright + warm * 0.6)}, ${clamp255(g + bright + warm * 0.15)}, ${clamp255(b + bright - warm * 0.5)})`;
}

function drawRounded(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function generateDemoItems() {
  const W = 540;
  const H = 720;

  return DEMO_DAYS.map((d, idx) => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    // Background gym studio wall + sunny window + wood floor with realistic lighting variation
    const wallGrad = ctx.createLinearGradient(0, 0, 0, H * 0.72);
    wallGrad.addColorStop(0, rgbTint(48, 56, 72, d.bright, d.warm));
    wallGrad.addColorStop(1, rgbTint(72, 80, 96, d.bright, d.warm));
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, W, H * 0.72);

    // Tall window on right side
    ctx.fillStyle = rgbTint(195, 215, 235, d.bright * 0.8, d.warm * 0.7);
    ctx.fillRect(W * 0.62, H * 0.05, W * 0.32, H * 0.55);
    ctx.strokeStyle = rgbTint(50, 56, 68, d.bright, d.warm);
    ctx.lineWidth = 6;
    ctx.strokeRect(W * 0.62, H * 0.05, W * 0.32, H * 0.55);
    ctx.beginPath();
    ctx.moveTo(W * 0.78, H * 0.05);
    ctx.lineTo(W * 0.78, H * 0.60);
    ctx.moveTo(W * 0.62, H * 0.32);
    ctx.lineTo(W * 0.94, H * 0.32);
    ctx.stroke();

    // Warm wood floor
    const floorGrad = ctx.createLinearGradient(0, H * 0.70, 0, H);
    floorGrad.addColorStop(0, rgbTint(168, 134, 92, d.bright, d.warm));
    floorGrad.addColorStop(1, rgbTint(138, 106, 68, d.bright, d.warm));
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, H * 0.70, W, H * 0.30);

    // Gym mirror seam lines
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.22, 0);
    ctx.lineTo(W * 0.22, H * 0.70);
    ctx.stroke();

    // Optional background bystander (to showcase multi-person filtering + Bystander Blur!)
    const candidates = [];
    const objectCandidates = [];

    if (d.bgPerson) {
      const bx = W * 0.16;
      const by = H * 0.44;
      ctx.save();
      ctx.fillStyle = rgbTint(35, 38, 46, d.bright * 0.6, d.warm * 0.4);
      drawRounded(ctx, bx - 22, by + 24, 44, 96, 16);
      ctx.fill();
      ctx.fillStyle = rgbTint(222, 184, 154, d.bright * 0.7, d.warm * 0.5);
      ctx.beginPath();
      ctx.arc(bx, by, 18, 0, Math.PI * 2);
      ctx.fill();
      // Eyes on bystander
      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.arc(bx - 6, by - 2, 2.2, 0, Math.PI * 2);
      ctx.arc(bx + 6, by - 2, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const bgCand = {
        index: 1,
        score: 0.41,
        bbox: [bx - 30, by - 22, bx + 30, by + 165],
        faceBbox: [bx - 20, by - 20, bx + 20, by + 20],
        landmarks: {
          nose: { x: bx, y: by + 2, confidence: 0.85 },
          left_eye: { x: bx + 6, y: by - 2, confidence: 0.85 },
          right_eye: { x: bx - 6, y: by - 2, confidence: 0.85 },
          neck: { x: bx, y: by + 24, confidence: 0.85 },
          left_shoulder: { x: bx + 20, y: by + 26, confidence: 0.85 },
          right_shoulder: { x: bx - 20, y: by + 26, confidence: 0.85 },
          root: { x: bx, y: by + 95, confidence: 0.85 },
          left_hip: { x: bx + 14, y: by + 95, confidence: 0.85 },
          right_hip: { x: bx - 14, y: by + 95, confidence: 0.85 },
        },
      };
      candidates.push(bgCand);
      objectCandidates.push({
        index: 1,
        classId: 0,
        label: "person",
        detConf: 0.78,
        score: 0.42,
        bbox: bgCand.bbox,
        isCustom: false,
      });
    }

    // Main subject (with progressive athletic growth + varied camera shift/scale/tilt!)
    const cx = W * (0.5 + d.shiftX);
    const neckY = H * (0.31 + d.shiftY);
    const s = d.scale;
    const rad = (d.tilt * Math.PI) / 180;

    const toWorld = (lx, ly) => ({
      x: cx + (lx * Math.cos(rad) - ly * Math.sin(rad)) * s,
      y: neckY + (lx * Math.sin(rad) + ly * Math.cos(rad)) * s,
    });

    ctx.save();
    ctx.translate(cx, neckY);
    ctx.rotate(rad);
    ctx.scale(s, s);

    const shoulderHalf = 66 + d.muscle * 16;
    const waistHalf = 52 - d.muscle * 5;
    const torsoH = 175;
    const skin = rgbTint(232, 192, 160, d.bright * 0.7, d.warm * 0.5);

    // Legs
    ctx.fillStyle = skin;
    drawRounded(ctx, -40, torsoH + 46, 30, 150, 14);
    ctx.fill();
    drawRounded(ctx, 10, torsoH + 46, 30, 150, 14);
    ctx.fill();

    // Athletic shorts
    ctx.fillStyle = "#1e293b";
    drawRounded(ctx, -waistHalf - 4, torsoH - 12, (waistHalf + 4) * 2, 76, 16);
    ctx.fill();

    // Arms (gradually stronger across days!)
    const armW = 24 + d.muscle * 7;
    ctx.fillStyle = skin;
    drawRounded(ctx, -shoulderHalf - armW + 4, 8, armW, 138, 12);
    ctx.fill();
    drawRounded(ctx, shoulderHalf - 4, 8, armW, 118, 12);
    ctx.fill();

    // Tank top torso
    ctx.fillStyle = d.shirt;
    ctx.beginPath();
    ctx.moveTo(-shoulderHalf + 8, 0);
    ctx.lineTo(shoulderHalf - 8, 0);
    ctx.lineTo(waistHalf, torsoH);
    ctx.lineTo(-waistHalf, torsoH);
    ctx.closePath();
    ctx.fill();

    // Phone held in hand taking mirror selfie
    ctx.fillStyle = "#0f172a";
    drawRounded(ctx, 8, 42, 26, 48, 6);
    ctx.fill();
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(12, 48, 8, 8);

    // Neck & Head
    ctx.fillStyle = skin;
    drawRounded(ctx, -15, -24, 30, 32, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, -56, 34, 42, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hair
    ctx.fillStyle = "#1e293b";
    ctx.beginPath();
    ctx.ellipse(0, -82, 35, 20, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    // Facial features (eyes, nose, confident smile)
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(-13, -60, 4, 0, Math.PI * 2);
    ctx.arc(13, -60, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7c5840";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, -56);
    ctx.lineTo(0, -45);
    ctx.stroke();
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, -40, 12, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    ctx.restore();

    // Compute exact world landmarks for main subject
    const nose = toWorld(0, -50);
    const lEye = toWorld(13, -60);
    const rEye = toWorld(-13, -60);
    const lEar = toWorld(33, -58);
    const rEar = toWorld(-33, -58);
    const neck = toWorld(0, 0);
    const lSh = toWorld(shoulderHalf - 4, 8);
    const rSh = toWorld(-shoulderHalf + 4, 8);
    const root = toWorld(0, torsoH);
    const lHip = toWorld(waistHalf * 0.75, torsoH);
    const rHip = toWorld(-waistHalf * 0.75, torsoH);
    const topLeft = toWorld(-shoulderHalf - armW, -104);
    const botRight = toWorld(shoulderHalf + armW, torsoH + 190);
    const fTopLeft = toWorld(-38, -102);
    const fBotRight = toWorld(38, -12);

    const mainCand = {
      index: 0,
      score: 0.92,
      bbox: [
        Math.max(0, Math.min(topLeft.x, botRight.x)),
        Math.max(0, Math.min(topLeft.y, botRight.y)),
        Math.min(W, Math.max(topLeft.x, botRight.x)),
        Math.min(H, Math.max(topLeft.y, botRight.y)),
      ],
      faceBbox: [
        Math.max(0, Math.min(fTopLeft.x, fBotRight.x)),
        Math.max(0, Math.min(fTopLeft.y, fBotRight.y)),
        Math.min(W, Math.max(fTopLeft.x, fBotRight.x)),
        Math.min(H, Math.max(fTopLeft.y, fBotRight.y)),
      ],
      landmarks: {
        nose: { ...nose, confidence: 0.98 },
        left_eye: { ...lEye, confidence: 0.98 },
        right_eye: { ...rEye, confidence: 0.98 },
        left_ear: { ...lEar, confidence: 0.92 },
        right_ear: { ...rEar, confidence: 0.92 },
        neck: { ...neck, confidence: 0.98 },
        left_shoulder: { ...lSh, confidence: 0.98 },
        right_shoulder: { ...rSh, confidence: 0.98 },
        root: { ...root, confidence: 0.98 },
        left_hip: { ...lHip, confidence: 0.98 },
        right_hip: { ...rHip, confidence: 0.98 },
      },
    };
    candidates.unshift(mainCand);
    candidates.forEach((c, i) => { c.index = i; });

    objectCandidates.unshift({
      index: 0,
      classId: 0,
      label: "person",
      detConf: 0.96,
      score: 0.92,
      bbox: mainCand.bbox,
      isCustom: false,
    });
    objectCandidates.forEach((c, i) => { c.index = i; });

    // Generate compact source thumbnail
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = 270;
    thumbCanvas.height = 360;
    thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, 270, 360);

    return {
      id: `demo_${idx + 1}`,
      filename: `demo_day_${String(idx + 1).padStart(2, "0")}.jpg`,
      canvas,
      sourceThumbUrl: thumbCanvas.toDataURL("image/jpeg", 0.85),
      colorStats: computePhotoColorStats(canvas),
      width: W,
      height: H,
      timestamp: d.ts,
      dateStr: d.date,
      dateSource: "exif",
      enabled: true,
      milestone: idx === 0 || idx === DEMO_DAYS.length - 1,
      detected: true,
      poseAnalyzed: true,
      objectAnalyzed: true,
      selectedCandidate: 0,
      candidates,
      selectedObject: 0,
      objectCandidates,
      objectWarning: null,
      customPoints: [rSh, lSh],
      transform: { srcCx: cx, srcCy: neckY, scale: 1 / (torsoH * s), angleDeg: 0, userDx: 0, userDy: 0, userScale: 1, userAngleDeg: 0 },
      warning: null,
    };
  });
}
