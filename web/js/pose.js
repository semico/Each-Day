/** 100% Local In-Browser Multi-Person Pose Detection via ONNX Runtime Web + YOLO11n-Pose. */

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs";

// Single-threaded WASM SIMD runs cleanly on GitHub Pages without requiring COOP/COEP headers
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
ort.env.wasm.numThreads = 1;

const MODEL_URL = "./models/yolo11n-pose.onnx";
const INPUT_SIZE = 640;

const COCO_KEYPOINTS = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
];

let sessionPromise = null;
let letterboxCanvas = null;
let letterboxCtx = null;

export async function ensurePoseModel() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }
  return sessionPromise;
}

function getLetterboxCanvas() {
  if (!letterboxCanvas) {
    letterboxCanvas = document.createElement("canvas");
    letterboxCanvas.width = INPUT_SIZE;
    letterboxCanvas.height = INPUT_SIZE;
    letterboxCtx = letterboxCanvas.getContext("2d", { willReadFrequently: true });
  }
  return { canvas: letterboxCanvas, ctx: letterboxCtx };
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

function estimateFaceBbox(landmarks, imgW, imgH) {
  const names = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"];
  const pts = names.map((k) => landmarks[k]).filter(Boolean);
  if (!pts.length) return null;

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  let radius = 0;
  if (landmarks.left_ear && landmarks.right_ear) {
    radius = Math.max(
      radius,
      Math.hypot(
        landmarks.left_ear.x - landmarks.right_ear.x,
        landmarks.left_ear.y - landmarks.right_ear.y
      ) * 0.72
    );
  }
  if (landmarks.left_eye && landmarks.right_eye) {
    radius = Math.max(
      radius,
      Math.hypot(
        landmarks.left_eye.x - landmarks.right_eye.x,
        landmarks.left_eye.y - landmarks.right_eye.y
      ) * 1.45
    );
  }
  if (radius < 8 && landmarks.neck) {
    radius = Math.max(radius, Math.hypot(cx - landmarks.neck.x, cy - landmarks.neck.y) * 0.55);
  }
  if (radius < 8) return null;

  return [
    Math.max(0, cx - radius * 0.9),
    Math.max(0, cy - radius * 1.15),
    Math.min(imgW, cx + radius * 0.9),
    Math.min(imgH, cy + radius * 0.95),
  ];
}

function prominenceScore(landmarks, bbox, detConf, imgW, imgH) {
  const [x1, y1, x2, y2] = bbox;
  const bw = Math.max(1, x2 - x1);
  const bh = Math.max(1, y2 - y1);
  const cx = (x1 + x2) * 0.5;
  const cy = (y1 + y2) * 0.5;

  const lSh = landmarks.left_shoulder;
  const rSh = landmarks.right_shoulder;
  const neck = landmarks.neck;
  const root = landmarks.root;

  let torsoScale = 0;
  if (lSh && rSh) {
    torsoScale = Math.max(torsoScale, Math.hypot(lSh.x - rSh.x, lSh.y - rSh.y) * 1.45);
  }
  if (neck && root) {
    torsoScale = Math.max(torsoScale, Math.hypot(neck.x - root.x, neck.y - root.y));
  }
  if (torsoScale <= 1) {
    torsoScale = Math.max(bw * 1.05, bh * 0.34);
  }

  const torsoNorm = Math.min(1, torsoScale / (Math.min(imgW, imgH) * 0.48));
  const heightNorm = Math.min(1, bh / (imgH * 0.72));
  const sizeScore = 0.65 * torsoNorm + 0.35 * heightNorm;

  const dxNorm = Math.abs(cx / imgW - 0.5);
  const centerScore = Math.max(0, 1 - dxNorm * 1.6);
  const vertScore = 1 - Math.min(0.5, Math.abs(cy / imgH - 0.52));

  const keyNames = ["neck", "left_shoulder", "right_shoulder", "nose", "root"];
  let confSum = 0;
  for (const k of keyNames) {
    if (landmarks[k]) confSum += landmarks[k].confidence;
  }
  const completeness = Math.min(1, confSum / 4.2);

  let uprightBonus = 1.0;
  if (neck && root) {
    if (neck.y > root.y) {
      uprightBonus = 0.25;
    } else {
      const dx = Math.abs(neck.x - root.x);
      const dy = Math.max(1, root.y - neck.y);
      if (dx / dy > 0.65) uprightBonus = 0.5;
    }
  }

  return (
    (0.48 * sizeScore +
      0.26 * centerScore +
      0.14 * completeness +
      0.06 * vertScore +
      0.06 * Math.min(1, detConf)) *
    uprightBonus
  );
}

/**
 * Run YOLO11n-Pose locally on a decoded HTMLCanvasElement and return sorted PersonCandidates.
 */
export async function detectPeopleInCanvas(srcCanvas) {
  const session = await ensurePoseModel();
  const imgW = srcCanvas.width;
  const imgH = srcCanvas.height;

  // 1. Letterbox source image into 640x640 with YOLO gray (114, 114, 114)
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
  const dims = outTensor.dims; // [1, 56, 8400]

  const numChannels = dims[1];
  const numAnchors = dims[2];
  const confThresh = 0.22;

  // 2. Decode raw predictions above threshold
  const rawDets = [];
  for (let a = 0; a < numAnchors; a++) {
    const score = out[4 * numAnchors + a];
    if (score < confThresh) continue;

    const cx = out[0 * numAnchors + a];
    const cy = out[1 * numAnchors + a];
    const bw = out[2 * numAnchors + a];
    const bh = out[3 * numAnchors + a];

    const x1 = Math.max(0, (cx - bw * 0.5 - padX) / scale);
    const y1 = Math.max(0, (cy - bh * 0.5 - padY) / scale);
    const x2 = Math.min(imgW, (cx + bw * 0.5 - padX) / scale);
    const y2 = Math.min(imgH, (cy + bh * 0.5 - padY) / scale);
    if (x2 - x1 < 12 || y2 - y1 < 20) continue;

    rawDets.push({ anchor: a, score, bbox: [x1, y1, x2, y2] });
  }

  // 3. Greedy NMS
  rawDets.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const det of rawDets) {
    let overlap = false;
    for (const k of kept) {
      if (iou(det.bbox, k.bbox) > 0.45) {
        overlap = true;
        break;
      }
    }
    if (!overlap) kept.push(det);
  }

  // 4. Extract 17 COCO keypoints + synthesize neck/root
  const candidates = [];
  for (const det of kept) {
    const a = det.anchor;
    const landmarks = {};
    for (let k = 0; k < 17; k++) {
      const baseCh = 5 + k * 3;
      if (baseCh + 2 >= numChannels) break;
      const kx = (out[baseCh * numAnchors + a] - padX) / scale;
      const ky = (out[(baseCh + 1) * numAnchors + a] - padY) / scale;
      const kc = out[(baseCh + 2) * numAnchors + a];
      if (kc >= 0.25 && (kx > 0.5 || ky > 0.5)) {
        landmarks[COCO_KEYPOINTS[k]] = {
          x: Math.round(kx * 100) / 100,
          y: Math.round(ky * 100) / 100,
          confidence: Math.round(kc * 1000) / 1000,
        };
      }
    }

    if (landmarks.left_shoulder && landmarks.right_shoulder) {
      const ls = landmarks.left_shoulder;
      const rs = landmarks.right_shoulder;
      landmarks.neck = {
        x: Math.round(((ls.x + rs.x) * 0.5) * 100) / 100,
        y: Math.round(((ls.y + rs.y) * 0.5) * 100) / 100,
        confidence: Math.min(ls.confidence, rs.confidence),
      };
    }
    if (landmarks.left_hip && landmarks.right_hip) {
      const lh = landmarks.left_hip;
      const rh = landmarks.right_hip;
      landmarks.root = {
        x: Math.round(((lh.x + rh.x) * 0.5) * 100) / 100,
        y: Math.round(((lh.y + rh.y) * 0.5) * 100) / 100,
        confidence: Math.min(lh.confidence, rh.confidence),
      };
    }

    if (!landmarks.neck && !landmarks.left_shoulder && !landmarks.right_shoulder && !landmarks.nose) {
      continue;
    }

    const faceBbox = estimateFaceBbox(landmarks, imgW, imgH);
    const score = prominenceScore(landmarks, det.bbox, det.score, imgW, imgH);
    candidates.push({
      index: 0,
      score,
      bbox: det.bbox,
      landmarks,
      faceBbox,
      identityDistance: null,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, idx) => {
    c.index = idx;
  });
  return candidates;
}
