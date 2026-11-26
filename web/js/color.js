/**
 * Photographic Auto Exposure & White-Balance Consistency Match (100% in-browser).
 * Computes central-region exposure & RGB statistics per photo, finds the batch median target,
 * and applies gentle soft-shoulder LUT gain adjustment to eliminate brightness/tint flicker.
 */

function median(arr) {
  if (!arr.length) return 128;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) * 0.5 : s[mid];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

let statCanvas = null;
let statCtx = null;

/**
 * Measure exposure & RGB tone statistics from the central 64% region of a decoded photo
 * (focusing on the subject rather than bright windows or dark borders).
 */
export function computePhotoColorStats(srcCanvas) {
  if (!statCanvas) {
    statCanvas = document.createElement("canvas");
    statCanvas.width = 64;
    statCanvas.height = 64;
    statCtx = statCanvas.getContext("2d", { willReadFrequently: true });
  }
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const sx = sw * 0.18;
  const sy = sh * 0.14;
  const cw = sw * 0.64;
  const ch = sh * 0.68;

  statCtx.drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, 64, 64);
  const data = statCtx.getImageData(0, 0, 64, 64).data;

  let sumR = 0,
    sumG = 0,
    sumB = 0,
    sumL = 0,
    count = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    // Ignore extreme blown-out highlights or pure black bars so subject exposure dominates
    if (l < 12 || l > 246) continue;
    sumR += r;
    sumG += g;
    sumB += b;
    sumL += l;
    count += 1;
  }

  if (count < 20) {
    return { meanR: 128, meanG: 128, meanB: 128, meanL: 128 };
  }
  return {
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    meanL: sumL / count,
  };
}

/**
 * Compute exposure & white-balance target: either from a chosen reference photo (`refItemId`)
 * or the median across all enabled photos in the batch.
 */
export function computeBatchColorTarget(items, refItemId = null) {
  if (refItemId) {
    const ref = items.find((it) => it.id === refItemId && it.colorStats);
    if (ref) {
      const st = ref.colorStats;
      return {
        targetR: st.meanR,
        targetG: st.meanG,
        targetB: st.meanB,
        targetL: st.meanL,
        sig: `ref_${ref.id}_${Math.round(st.meanL)}`,
        refItemId: ref.id,
      };
    }
  }

  const valid = items.filter((it) => it.enabled && it.colorStats);
  const pool = valid.length ? valid : items.filter((it) => it.colorStats);
  if (!pool.length) {
    return { targetR: 128, targetG: 128, targetB: 128, targetL: 128, sig: "default", refItemId: null };
  }

  const targetR = median(pool.map((it) => it.colorStats.meanR));
  const targetG = median(pool.map((it) => it.colorStats.meanG));
  const targetB = median(pool.map((it) => it.colorStats.meanB));
  const targetL = median(pool.map((it) => it.colorStats.meanL));
  const sig = `med_${Math.round(targetR)}_${Math.round(targetG)}_${Math.round(targetB)}_${Math.round(targetL)}`;
  return { targetR, targetG, targetB, targetL, sig, refItemId: null };
}

function buildSoftGainLut(gain) {
  const lut = new Uint8ClampedArray(256);
  // Soft highlight shoulder above 215 so brightening a dark shot never clips highlights harshly
  for (let v = 0; v < 256; v++) {
    let out = v * gain;
    if (out > 215 && gain > 1) {
      const excess = (out - 215) / 40;
      out = 215 + 40 * (1 - Math.exp(-excess));
    }
    lut[v] = Math.round(clamp(out, 0, 255));
  }
  return lut;
}

/**
 * Return the color-matched HTMLCanvasElement for `item` (cached so 60fps preview & export stay instant).
 */
export function getColorAdjustedCanvas(item, batchTarget, strength = 0.65) {
  if (!item.colorStats || !batchTarget || strength <= 0.01) {
    return item.canvas;
  }

  const s = clamp(Number(strength) || 0, 0, 1);
  const cacheKey = `${batchTarget.sig}_${Math.round(s * 100)}`;
  if (item._colorCacheKey === cacheKey && item._colorCanvas) {
    return item._colorCanvas;
  }

  const st = item.colorStats;
  // Separate overall luminance match from gentle white-balance tint correction
  const rawLumGain = clamp(batchTarget.targetL / Math.max(18, st.meanL), 0.72, 1.38);
  const wbR = clamp((batchTarget.targetR / Math.max(18, st.meanR)) / rawLumGain, 0.86, 1.16);
  const wbG = clamp((batchTarget.targetG / Math.max(18, st.meanG)) / rawLumGain, 0.88, 1.14);
  const wbB = clamp((batchTarget.targetB / Math.max(18, st.meanB)) / rawLumGain, 0.86, 1.16);

  const gainR = 1 + (rawLumGain * wbR - 1) * s;
  const gainG = 1 + (rawLumGain * wbG - 1) * s;
  const gainB = 1 + (rawLumGain * wbB - 1) * s;

  // Skip work if photo is already practically identical to target
  if (Math.abs(gainR - 1) < 0.015 && Math.abs(gainG - 1) < 0.015 && Math.abs(gainB - 1) < 0.015) {
    item._colorCacheKey = cacheKey;
    item._colorCanvas = item.canvas;
    return item.canvas;
  }

  const lutR = buildSoftGainLut(gainR);
  const lutG = buildSoftGainLut(gainG);
  const lutB = buildSoftGainLut(gainB);

  const w = item.canvas.width;
  const h = item.canvas.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(item.canvas, 0, 0);

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lutR[d[i]];
    d[i + 1] = lutG[d[i + 1]];
    d[i + 2] = lutB[d[i + 2]];
  }
  ctx.putImageData(imgData, 0, 0);

  item._colorCacheKey = cacheKey;
  item._colorCanvas = out;
  return out;
}
