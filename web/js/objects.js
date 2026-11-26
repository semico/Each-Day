/**
 * 100% Local In-Browser 80-Class Object Detector (YOLO11n ONNX) + Multi-Scale Visual Template Tracker.
 * Supports pets (dog/cat/bird/...), plants (potted plant/vase), food/drinks, vehicles, home objects,
 * AND arbitrary user-drawn custom boxes via coarse-to-fine ZNCC appearance tracking.
 */

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
ort.env.wasm.numThreads = 1;

const OBJ_MODEL_URL = "./models/yolo11n.onnx";
const INPUT_SIZE = 640;

export const COCO_CLASSES = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
  "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
  "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

const CLASS_ZH = {
  person: "人物", bicycle: "自行车", car: "汽车", motorcycle: "摩托车", bird: "小鸟",
  cat: "猫咪", dog: "狗狗", horse: "马", sheep: "绵羊", cow: "奶牛", bear: "熊",
  backpack: "背包", umbrella: "雨伞", handbag: "手提包", suitcase: "行李箱",
  "sports ball": "球类", skateboard: "滑板", surfboard: "冲浪板", bottle: "水瓶",
  "wine glass": "酒杯", cup: "杯子/咖啡", bowl: "碗", banana: "香蕉", apple: "苹果",
  pizza: "披萨", donut: "甜甜圈", cake: "蛋糕", chair: "椅子", couch: "沙发",
  "potted plant": "盆栽植物", bed: "床", "dining table": "餐桌", tv: "屏幕/电视",
  laptop: "笔记本电脑", keyboard: "键盘", "cell phone": "手机", book: "书籍",
  clock: "时钟", vase: "花瓶", "teddy bear": "玩偶",
};

const CLASS_EMOJI = {
  person: "🧍", bicycle: "🚲", car: "🚗", motorcycle: "🏍️", bird: "🐦",
  cat: "🐱", dog: "🐶", horse: "🐴", bear: "🐻", backpack: "🎒",
  bottle: "🍾", "wine glass": "🍷", cup: "☕", bowl: "🥣", cake: "🎂",
  pizza: "🍕", chair: "🪑", couch: "🛋️", "potted plant": "🪴", bed: "🛏️",
  laptop: "💻", keyboard: "⌨️", "cell phone": "📱", book: "📖",
  clock: "⏰", vase: "🏺", "teddy bear": "🧸",
};

export function formatObjectLabel(cand, lang = "zh") {
  if (cand.isCustom) return lang === "en" ? "🎯 Custom Subject" : "🎯 自定义主体";
  const emoji = CLASS_EMOJI[cand.label] || "📦";
  const name = lang === "en" ? cand.label : CLASS_ZH[cand.label] || cand.label;
  return `${emoji} ${name}`;
}

let objSessionPromise = null;
let lbCanvas = null;
let lbCtx = null;

export async function ensureObjectModel() {
  if (!objSessionPromise) {
    objSessionPromise = ort.InferenceSession.create(OBJ_MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
  return objSessionPromise;
}

function getLetterboxCanvas() {
  if (!lbCanvas) {
    lbCanvas = document.createElement("canvas");
    lbCanvas.width = INPUT_SIZE;
    lbCanvas.height = INPUT_SIZE;
    lbCtx = lbCanvas.getContext("2d", { willReadFrequently: true });
  }
  return { canvas: lbCanvas, ctx: lbCtx };
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

function objectProminence(bbox, detConf, imgW, imgH) {
  const [x1, y1, x2, y2] = bbox;
  const bw = Math.max(1, x2 - x1);
  const bh = Math.max(1, y2 - y1);
  const cx = (x1 + x2) * 0.5;
  const cy = (y1 + y2) * 0.5;
  const areaRatio = Math.min(1, (bw * bh) / (imgW * imgH * 0.45));
  const distCenter = Math.hypot(cx / imgW - 0.5, cy / imgH - 0.5);
  const centerScore = Math.max(0, 1 - distCenter * 1.45);
  return 0.42 * areaRatio + 0.34 * centerScore + 0.24 * Math.min(1, detConf);
}

/**
 * Run YOLO11n (80 COCO classes) locally on a decoded HTMLCanvasElement.
 */
export async function detectObjectsInCanvas(srcCanvas) {
  const session = await ensureObjectModel();
  const imgW = srcCanvas.width;
  const imgH = srcCanvas.height;

  const scale = Math.min(INPUT_SIZE / imgW, INPUT_SIZE / imgH);
  const newW = Math.round(imgW * scale);
  const newH = Math.round(imgH * scale);
  const padX = Math.floor((INPUT_SIZE - newW) / 2);
  const padY = Math.floor((INPUT_SIZE - newH) / 2);

  const { ctx } = getLetterboxCanvas();
  ctx.fillStyle = "rgb(114, 114, 114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(srcCanvas, 0, 0, imgW, imgH, padX, padY, newW, newH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  const inputArr = new Float32Array(3 * planeSize);
  for (let i = 0, p = 0; i < planeSize; i++, p += 4) {
    inputArr[i] = data[p] / 255.0;
    inputArr[i + planeSize] = data[p + 1] / 255.0;
    inputArr[i + 2 * planeSize] = data[p + 2] / 255.0;
  }

  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor("float32", inputArr, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await session.run({ [inputName]: tensor });
  const outTensor = outputs[session.outputNames[0]];
  const out = outTensor.data;
  const [, numChannels, numAnchors] = outTensor.dims; // [1, 84, 8400]
  const numClasses = numChannels - 4;
  const confThresh = 0.22;

  const rawDets = [];
  for (let a = 0; a < numAnchors; a++) {
    let bestCls = -1;
    let bestScore = confThresh;
    for (let c = 0; c < numClasses; c++) {
      const s = out[(4 + c) * numAnchors + a];
      if (s > bestScore) {
        bestScore = s;
        bestCls = c;
      }
    }
    if (bestCls < 0) continue;

    const cx = out[0 * numAnchors + a];
    const cy = out[1 * numAnchors + a];
    const bw = out[2 * numAnchors + a];
    const bh = out[3 * numAnchors + a];

    const x1 = Math.max(0, (cx - bw * 0.5 - padX) / scale);
    const y1 = Math.max(0, (cy - bh * 0.5 - padY) / scale);
    const x2 = Math.min(imgW, (cx + bw * 0.5 - padX) / scale);
    const y2 = Math.min(imgH, (cy + bh * 0.5 - padY) / scale);
    if (x2 - x1 < 14 || y2 - y1 < 14) continue;

    rawDets.push({ classId: bestCls, detConf: bestScore, bbox: [x1, y1, x2, y2] });
  }

  // Class-aware NMS
  rawDets.sort((a, b) => b.detConf - a.detConf);
  const kept = [];
  for (const det of rawDets) {
    let suppress = false;
    for (const k of kept) {
      if (k.classId === det.classId && iou(det.bbox, k.bbox) > 0.45) {
        suppress = true;
        break;
      }
    }
    if (!suppress) kept.push(det);
    if (kept.length >= 24) break;
  }

  const candidates = kept.map((d) => {
    const label = COCO_CLASSES[d.classId] || `obj_${d.classId}`;
    return {
      index: 0,
      classId: d.classId,
      label,
      detConf: d.detConf,
      score: objectProminence(d.bbox, d.detConf, imgW, imgH),
      bbox: d.bbox,
      isCustom: false,
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, idx) => {
    c.index = idx;
  });
  return candidates;
}

function l2Normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) + 1e-6;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

let descCanvas = null;
let descCtx = null;

/**
 * Extract a rich 139-dim appearance descriptor (YCbCr color histogram + 3x3 spatial color grid + 3x3x8 HOG)
 * for matching ANY subject (person, pet, plant, cup, custom box) across photos.
 */
export function extractBoxDescriptor(srcCanvas, bbox) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const ix1 = Math.max(0, Math.round(bbox[0]));
  const iy1 = Math.max(0, Math.round(bbox[1]));
  const ix2 = Math.min(w, Math.round(bbox[2]));
  const iy2 = Math.min(h, Math.round(bbox[3]));
  if (ix2 - ix1 < 10 || iy2 - iy1 < 10) return null;

  if (!descCanvas) {
    descCanvas = document.createElement("canvas");
    descCanvas.width = 48;
    descCanvas.height = 48;
    descCtx = descCanvas.getContext("2d", { willReadFrequently: true });
  }
  descCtx.drawImage(srcCanvas, ix1, iy1, ix2 - ix1, iy2 - iy1, 0, 0, 48, 48);
  const data = descCtx.getImageData(0, 0, 48, 48).data;

  const histY = new Float32Array(8);
  const histCb = new Float32Array(16);
  const histCr = new Float32Array(16);
  const spatialRgb = new Float32Array(27); // 3x3 cells x 3 channels
  const gray = new Float32Array(48 * 48);
  let graySum = 0;

  for (let r = 0; r < 48; r++) {
    const crIdx = Math.floor(r / 16);
    for (let c = 0; c < 48; c++) {
      const ccIdx = Math.floor(c / 16);
      const i = r * 48 + c;
      const p = i * 4;
      const R = data[p];
      const G = data[p + 1];
      const B = data[p + 2];
      const Y = 0.299 * R + 0.587 * G + 0.114 * B;
      const Cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      const Cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;

      histY[Math.min(7, Math.max(0, Math.floor((Y / 256) * 8)))] += 0.4;
      histCb[Math.min(15, Math.max(0, Math.floor((Cb / 256) * 16)))] += 1;
      histCr[Math.min(15, Math.max(0, Math.floor((Cr / 256) * 16)))] += 1;

      const sBase = (crIdx * 3 + ccIdx) * 3;
      spatialRgb[sBase] += R / 255;
      spatialRgb[sBase + 1] += G / 255;
      spatialRgb[sBase + 2] += B / 255;

      gray[i] = Y;
      graySum += Y;
    }
  }

  const colorVec = new Float32Array(40);
  colorVec.set(histY, 0);
  colorVec.set(histCb, 8);
  colorVec.set(histCr, 24);
  l2Normalize(colorVec);
  l2Normalize(spatialRgb);

  const mean = graySum / (48 * 48);
  let varSum = 0;
  for (let i = 0; i < gray.length; i++) {
    const d = gray[i] - mean;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / gray.length) + 1e-5;
  for (let i = 0; i < gray.length; i++) gray[i] = (gray[i] - mean) / std;

  const hogVec = new Float32Array(72);
  for (let r = 1; r < 47; r++) {
    const cellR = Math.floor(r / 16);
    for (let c = 1; c < 47; c++) {
      const cellC = Math.floor(c / 16);
      const gx = gray[r * 48 + (c + 1)] - gray[r * 48 + (c - 1)];
      const gy = gray[(r + 1) * 48 + c] - gray[(r - 1) * 48 + c];
      const mag = Math.hypot(gx, gy);
      const ang = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
      const bin = Math.min(7, Math.floor((ang / 180) * 8));
      hogVec[(cellR * 3 + cellC) * 8 + bin] += mag;
    }
  }
  l2Normalize(hogVec);

  const out = new Float32Array(139);
  for (let i = 0; i < 40; i++) out[i] = colorVec[i] * 0.45;
  for (let i = 0; i < 27; i++) out[40 + i] = spatialRgb[i] * 0.25;
  for (let i = 0; i < 72; i++) out[67 + i] = hogVec[i] * 0.30;
  return l2Normalize(out);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Multi-scale coarse-to-fine ZNCC visual template tracker (works on ANY user-selected subject,
 * even non-COCO objects like LEGO builds, paintings, sourdough jars, watches, or close-up plants).
 */
export function trackTemplateInCanvas(targetCanvas, refCanvas, refBbox) {
  const rw = refCanvas.width;
  const rh = refCanvas.height;
  const rx1 = Math.max(0, refBbox[0]);
  const ry1 = Math.max(0, refBbox[1]);
  const rx2 = Math.min(rw, refBbox[2]);
  const ry2 = Math.min(rh, refBbox[3]);
  const boxW = Math.max(12, rx2 - rx1);
  const boxH = Math.max(12, ry2 - ry1);
  const boxAspect = boxW / boxH;

  // Downsample target image to a compact search pyramid (max side ~144px) for ~20ms search
  const tw = targetCanvas.width;
  const th = targetCanvas.height;
  const pyrScale = Math.min(1, 144 / Math.max(tw, th));
  const pw = Math.max(24, Math.round(tw * pyrScale));
  const ph = Math.max(24, Math.round(th * pyrScale));

  const pyrCanvas = document.createElement("canvas");
  pyrCanvas.width = pw;
  pyrCanvas.height = ph;
  const pyrCtx = pyrCanvas.getContext("2d", { willReadFrequently: true });
  pyrCtx.drawImage(targetCanvas, 0, 0, pw, ph);
  const pyrRgba = pyrCtx.getImageData(0, 0, pw, ph).data;

  // Pre-extract 3 normalized feature planes (Y, Cb, Cr) for the pyramid image
  const pyrN = pw * ph;
  const pY = new Float32Array(pyrN);
  const pCb = new Float32Array(pyrN);
  const pCr = new Float32Array(pyrN);
  for (let i = 0, p = 0; i < pyrN; i++, p += 4) {
    const R = pyrRgba[p], G = pyrRgba[p + 1], B = pyrRgba[p + 2];
    pY[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    pCb[i] = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
    pCr[i] = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
  }

  // Reference normalized size relative to image size
  const baseFracW = boxW / rw;
  const baseFracH = boxH / rh;
  const basePw = Math.max(12, Math.min(pw - 2, Math.round(baseFracW * pw)));
  const basePh = Math.max(12, Math.min(ph - 2, Math.round(baseFracH * ph)));

  const tplCanvas = document.createElement("canvas");
  const tplCtx = tplCanvas.getContext("2d", { willReadFrequently: true });

  const makeTemplate = (w, h) => {
    tplCanvas.width = w;
    tplCanvas.height = h;
    tplCtx.drawImage(refCanvas, rx1, ry1, boxW, boxH, 0, 0, w, h);
    const d = tplCtx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const tY = new Float32Array(n);
    const tCb = new Float32Array(n);
    const tCr = new Float32Array(n);
    let mY = 0, mCb = 0, mCr = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const R = d[p], G = d[p + 1], B = d[p + 2];
      tY[i] = 0.299 * R + 0.587 * G + 0.114 * B;
      tCb[i] = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      tCr[i] = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      mY += tY[i]; mCb += tCb[i]; mCr += tCr[i];
    }
    mY /= n; mCb /= n; mCr /= n;
    let normY = 0, normCb = 0, normCr = 0;
    for (let i = 0; i < n; i++) {
      tY[i] -= mY; normY += tY[i] * tY[i];
      tCb[i] -= mCb; normCb += tCb[i] * tCb[i];
      tCr[i] -= mCr; normCr += tCr[i] * tCr[i];
    }
    return {
      w, h, tY, tCb, tCr, mY, mCb, mCr,
      stdY: Math.sqrt(normY / n),
      invY: 1 / (Math.sqrt(normY) + 1e-5),
      invCb: 1 / (Math.sqrt(normCb) + 1e-5),
      invCr: 1 / (Math.sqrt(normCr) + 1e-5),
    };
  };

  // Reference box normalized center (gentle spatial prior when visual scores are close)
  const refNormCx = ((rx1 + rx2) * 0.5) / rw;
  const refNormCy = ((ry1 + ry2) * 0.5) / rh;

  const scorePatch = (tpl, x0, y0, sampleStep) => {
    const { w, h, tY, tCb, tCr } = tpl;
    let sumY = 0, sumCb = 0, sumCr = 0, cnt = 0;
    for (let dy = 0; dy < h; dy += sampleStep) {
      const rowP = (y0 + dy) * pw + x0;
      for (let dx = 0; dx < w; dx += sampleStep) {
        const pi = rowP + dx;
        sumY += pY[pi]; sumCb += pCb[pi]; sumCr += pCr[pi];
        cnt += 1;
      }
    }
    const meanY = sumY / cnt, meanCb = sumCb / cnt, meanCr = sumCr / cnt;
    let dotY = 0, dotCb = 0, dotCr = 0;
    let varY = 0, varCb = 0, varCr = 0;
    let tVarY = 0, tVarCb = 0, tVarCr = 0;

    for (let dy = 0; dy < h; dy += sampleStep) {
      const rowP = (y0 + dy) * pw + x0;
      const rowT = dy * w;
      for (let dx = 0; dx < w; dx += sampleStep) {
        const pi = rowP + dx;
        const ti = rowT + dx;
        const vy = pY[pi] - meanY;
        const vcb = pCb[pi] - meanCb;
        const vcr = pCr[pi] - meanCr;
        dotY += vy * tY[ti]; varY += vy * vy; tVarY += tY[ti] * tY[ti];
        dotCb += vcb * tCb[ti]; varCb += vcb * vcb; tVarCb += tCb[ti] * tCb[ti];
        dotCr += vcr * tCr[ti]; varCr += vcr * vcr; tVarCr += tCr[ti] * tCr[ti];
      }
    }

    // Reject flat blank walls/ceilings when the tracked object has clear visual texture
    const patchStdY = Math.sqrt(varY / cnt);
    if (tpl.stdY > 12 && patchStdY < tpl.stdY * 0.28) {
      return -1.5;
    }

    const nccY = dotY / (Math.sqrt(varY * tVarY) + 1e-5);
    const nccCb = dotCb / (Math.sqrt(varCb * tVarCb) + 1e-5);
    const nccCr = dotCr / (Math.sqrt(varCr * tVarCr) + 1e-5);
    const structScore = 0.56 * nccY + 0.22 * nccCb + 0.22 * nccCr;

    // Absolute chrominance similarity (prevents matching a white wall to a colored subject)
    const chromaDiff = (Math.abs(meanCb - tpl.mCb) + Math.abs(meanCr - tpl.mCr)) / 48.0;
    const chromaScore = Math.max(-0.5, 1.0 - chromaDiff);

    // Gentle spatial proximity prior
    const candCx = (x0 + w * 0.5) / pw;
    const candCy = (y0 + h * 0.5) / ph;
    const spatialPenalty = 0.08 * Math.hypot(candCx - refNormCx, candCy - refNormCy);

    return 0.62 * structScore + 0.38 * chromaScore - spatialPenalty;
  };

  // Coarse search across 7 scales
  const scales = [0.68, 0.80, 0.90, 1.00, 1.12, 1.26, 1.42];
  let best = { score: -2, x: 0, y: 0, w: basePw, h: basePh, tpl: null };

  for (const s of scales) {
    const sw = Math.max(10, Math.min(pw - 1, Math.round(basePw * s)));
    const sh = Math.max(10, Math.min(ph - 1, Math.round(sw / boxAspect)));
    if (sw >= pw || sh >= ph) continue;

    const tpl = makeTemplate(sw, sh);
    const sampleStep = Math.max(1, Math.floor(Math.min(sw, sh) / 14));
    const stride = Math.max(2, Math.round(Math.min(sw, sh) * 0.14));

    for (let y = 0; y <= ph - sh; y += stride) {
      for (let x = 0; x <= pw - sw; x += stride) {
        const sc = scorePatch(tpl, x, y, sampleStep);
        if (sc > best.score) {
          best = { score: sc, x, y, w: sw, h: sh, tpl };
        }
      }
    }
  }

  // Fine local refinement around best coarse match (1px stride)
  if (best.tpl) {
    const { w: sw, h: sh, tpl } = best;
    const xMin = Math.max(0, best.x - 5);
    const xMax = Math.min(pw - sw, best.x + 5);
    const yMin = Math.max(0, best.y - 5);
    const yMax = Math.min(ph - sh, best.y + 5);
    const fineStep = Math.max(1, Math.floor(Math.min(sw, sh) / 20));
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const sc = scorePatch(tpl, x, y, fineStep);
        if (sc > best.score) {
          best.score = sc;
          best.x = x;
          best.y = y;
        }
      }
    }
  }

  return {
    bbox: [
      Math.max(0, best.x / pyrScale),
      Math.max(0, best.y / pyrScale),
      Math.min(tw, (best.x + best.w) / pyrScale),
      Math.min(th, (best.y + best.h) / pyrScale),
    ],
    similarity: best.score,
  };
}
