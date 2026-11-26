/**
 * Self-calibrating multi-mode alignment engine (100% in-browser):
 *   - "body":   Full/upper body alignment (gym progress, OOTD, pregnancy, standing growth)
 *   - "face":   Eye-line & facial feature alignment (daily selfie, baby growth, skincare, hair/beard)
 *   - "points": Universal 2-point anchor alignment (pets, plants, renovations, art, any object)
 */

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) * 0.5 : sorted[mid];
}

function l2Normalize(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) + 1e-6;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

let headScratchCanvas = null;
let headScratchCtx = null;

/**
 * Extract a compact lighting-normalized head/face descriptor (YCbCr color histogram + 3x3x8 gradient HOG)
 * to distinguish the user from background people in multi-person photos.
 */
export function extractHeadDescriptor(srcCanvas, candidate) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const lm = candidate.landmarks;

  let x1, y1, x2, y2;
  if (candidate.faceBbox) {
    [x1, y1, x2, y2] = candidate.faceBbox;
  } else {
    const pts = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"]
      .map((k) => lm[k])
      .filter(Boolean);
    if (!pts.length) return null;
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const side = lm.neck
      ? Math.max(24, Math.hypot(cx - lm.neck.x, cy - lm.neck.y) * 1.8)
      : Math.max(24, (candidate.bbox[2] - candidate.bbox[0]) * 0.45);
    x1 = cx - side * 0.5;
    y1 = cy - side * 0.5;
    x2 = cx + side * 0.5;
    y2 = cy + side * 0.5;
  }

  const ix1 = Math.max(0, Math.round(x1));
  const iy1 = Math.max(0, Math.round(y1));
  const ix2 = Math.min(w, Math.round(x2));
  const iy2 = Math.min(h, Math.round(y2));
  if (ix2 - ix1 < 14 || iy2 - iy1 < 14) return null;

  if (!headScratchCanvas) {
    headScratchCanvas = document.createElement("canvas");
    headScratchCanvas.width = 48;
    headScratchCanvas.height = 48;
    headScratchCtx = headScratchCanvas.getContext("2d", { willReadFrequently: true });
  }
  headScratchCtx.drawImage(srcCanvas, ix1, iy1, ix2 - ix1, iy2 - iy1, 0, 0, 48, 48);
  const img = headScratchCtx.getImageData(0, 0, 48, 48).data;

  const histY = new Float32Array(8);
  const histCb = new Float32Array(16);
  const histCr = new Float32Array(16);
  const gray = new Float32Array(48 * 48);
  let graySum = 0;

  for (let i = 0, p = 0; i < 48 * 48; i++, p += 4) {
    const r = img[p];
    const g = img[p + 1];
    const b = img[p + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

    histY[Math.min(7, Math.max(0, Math.floor((y / 256) * 8)))] += 0.4;
    histCb[Math.min(15, Math.max(0, Math.floor((cb / 256) * 16)))] += 1;
    histCr[Math.min(15, Math.max(0, Math.floor((cr / 256) * 16)))] += 1;
    gray[i] = y;
    graySum += y;
  }

  const colorVec = new Float32Array(40);
  colorVec.set(histY, 0);
  colorVec.set(histCb, 8);
  colorVec.set(histCr, 24);
  l2Normalize(colorVec);

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

  const desc = new Float32Array(112);
  for (let i = 0; i < 40; i++) desc[i] = colorVec[i] * 0.55;
  for (let i = 0; i < 72; i++) desc[40 + i] = hogVec[i] * 0.45;
  return l2Normalize(desc);
}

export function extractAnchors(candidate) {
  const lm = candidate.landmarks;
  const anchors = {};

  const headSpecs = [
    ["nose", 1.2],
    ["left_eye", 1.0],
    ["right_eye", 1.0],
    ["left_ear", 0.6],
    ["right_ear", 0.6],
  ];
  let hx = 0,
    hy = 0,
    hw = 0;
  for (const [k, w] of headSpecs) {
    if (lm[k] && lm[k].confidence >= 0.3) {
      const wt = lm[k].confidence * w;
      hx += lm[k].x * wt;
      hy += lm[k].y * wt;
      hw += wt;
    }
  }
  if (hw > 0) {
    anchors.head = [hx / hw, hy / hw, Math.min(1, hw / 2.2)];
  }

  if (lm.left_shoulder && lm.left_shoulder.confidence >= 0.3) {
    anchors.l_shoulder = [lm.left_shoulder.x, lm.left_shoulder.y, lm.left_shoulder.confidence];
  }
  if (lm.right_shoulder && lm.right_shoulder.confidence >= 0.3) {
    anchors.r_shoulder = [lm.right_shoulder.x, lm.right_shoulder.y, lm.right_shoulder.confidence];
  }

  if (anchors.l_shoulder && anchors.r_shoulder) {
    anchors.neck = [
      (anchors.l_shoulder[0] + anchors.r_shoulder[0]) * 0.5,
      (anchors.l_shoulder[1] + anchors.r_shoulder[1]) * 0.5,
      Math.min(anchors.l_shoulder[2], anchors.r_shoulder[2]),
    ];
  } else if (lm.neck) {
    anchors.neck = [lm.neck.x, lm.neck.y, lm.neck.confidence];
  }

  if (lm.left_hip && lm.right_hip && lm.left_hip.confidence >= 0.3 && lm.right_hip.confidence >= 0.3) {
    anchors.hip = [
      (lm.left_hip[0] !== undefined ? lm.left_hip[0] : lm.left_hip.x) * 0.5 +
        (lm.right_hip[0] !== undefined ? lm.right_hip[0] : lm.right_hip.x) * 0.5,
      (lm.left_hip.y + lm.right_hip.y) * 0.5,
      Math.min(lm.left_hip.confidence, lm.right_hip.confidence),
    ];
  } else if (lm.root && lm.root.confidence >= 0.3) {
    anchors.hip = [lm.root.x, lm.root.y, lm.root.confidence];
  }

  return anchors;
}

export function calibrateBodyProportions(items) {
  const swRatios = [];
  const headRatios = [];
  const rollAngles = [];
  const earToEyeRatios = [];
  const noseToEyeRatios = [];

  for (const item of items) {
    if (!item.candidates.length || item.selectedCandidate >= item.candidates.length) continue;
    const cand = item.candidates[item.selectedCandidate];
    const lm = cand.landmarks;
    const anchors = extractAnchors(cand);

    // Body proportions
    if (anchors.neck && anchors.hip) {
      const dx = anchors.neck[0] - anchors.hip[0];
      const dy = anchors.neck[1] - anchors.hip[1];
      const torso = Math.hypot(dx, dy);
      if (torso >= 18) {
        if (dy < -12) rollAngles.push((Math.atan2(dx, -dy) * 180) / Math.PI);
        if (anchors.l_shoulder && anchors.r_shoulder) {
          const sw = Math.hypot(
            anchors.l_shoulder[0] - anchors.r_shoulder[0],
            anchors.l_shoulder[1] - anchors.r_shoulder[1]
          );
          const r = sw / torso;
          if (r >= 0.35 && r <= 1.25) swRatios.push(r);
        }
        if (anchors.head) {
          const hd = Math.hypot(anchors.head[0] - anchors.neck[0], anchors.head[1] - anchors.neck[1]);
          const r = hd / torso;
          if (r >= 0.15 && r <= 0.75) headRatios.push(r);
        }
      }
    }

    // Face proportions (eye distance vs ear distance & nose distance)
    if (lm.left_eye && lm.right_eye && lm.left_eye.confidence >= 0.35 && lm.right_eye.confidence >= 0.35) {
      const eyeDist = Math.hypot(lm.left_eye.x - lm.right_eye.x, lm.left_eye.y - lm.right_eye.y);
      if (eyeDist >= 8) {
        if (lm.left_ear && lm.right_ear) {
          const earDist = Math.hypot(lm.left_ear.x - lm.right_ear.x, lm.left_ear.y - lm.right_ear.y);
          const r = earDist / eyeDist;
          if (r >= 1.4 && r <= 3.2) earToEyeRatios.push(r);
        }
        if (lm.nose) {
          const emx = (lm.left_eye.x + lm.right_eye.x) * 0.5;
          const emy = (lm.left_eye.y + lm.right_eye.y) * 0.5;
          const nd = Math.hypot(lm.nose.x - emx, lm.nose.y - emy);
          const r = nd / eyeDist;
          if (r >= 0.25 && r <= 1.1) noseToEyeRatios.push(r);
        }
      }
    }
  }

  return {
    shoulderToTorso: swRatios.length ? median(swRatios) : 0.72,
    headToTorso: headRatios.length ? median(headRatios) : 0.34,
    naturalRollDeg: rollAngles.length >= 3 ? median(rollAngles) : 0,
    earToEye: earToEyeRatios.length ? median(earToEyeRatios) : 2.1,
    noseToEye: noseToEyeRatios.length ? median(noseToEyeRatios) : 0.58,
  };
}

/**
 * Mode 1: Body / Torso alignment (Gym, OOTD, Pregnancy, Full-Body Growth).
 */
export function computeBodyTransform(item, candidate, proportions) {
  const anchors = extractAnchors(candidate);
  const estimates = [];

  if (anchors.neck && anchors.hip) {
    const d = Math.hypot(anchors.neck[0] - anchors.hip[0], anchors.neck[1] - anchors.hip[1]);
    if (d > 12) estimates.push([d, 3.4 * Math.min(anchors.neck[2], anchors.hip[2])]);
  }
  if (anchors.head && anchors.hip) {
    const d = Math.hypot(anchors.head[0] - anchors.hip[0], anchors.head[1] - anchors.hip[1]);
    if (d > 18) {
      estimates.push([d / (1 + proportions.headToTorso), 2.8 * Math.min(anchors.head[2], anchors.hip[2])]);
    }
  }
  if (anchors.l_shoulder && anchors.r_shoulder) {
    const sw = Math.hypot(
      anchors.l_shoulder[0] - anchors.r_shoulder[0],
      anchors.l_shoulder[1] - anchors.r_shoulder[1]
    );
    if (sw > 10) {
      estimates.push([sw / proportions.shoulderToTorso, 2.0 * Math.min(anchors.l_shoulder[2], anchors.r_shoulder[2])]);
    }
  }
  if (anchors.head && anchors.neck) {
    const hd = Math.hypot(anchors.head[0] - anchors.neck[0], anchors.head[1] - anchors.neck[1]);
    if (hd > 8) {
      estimates.push([hd / proportions.headToTorso, 0.8 * Math.min(anchors.head[2], anchors.neck[2])]);
    }
  }

  let torsoPx;
  if (!estimates.length) {
    const [, by1, , by2] = candidate.bbox;
    torsoPx = Math.max(30, (by2 - by1) * 0.34);
  } else {
    const med = median(estimates.map((e) => e[0]));
    let num = 0,
      den = 0;
    for (const [v, w] of estimates) {
      if (Math.abs(v - med) <= med * 0.32) {
        num += v * w;
        den += w;
      }
    }
    if (den <= 0) {
      for (const [v, w] of estimates) {
        num += v * w;
        den += w;
      }
    }
    torsoPx = num / den;
  }

  let rawAngle = 0;
  if (anchors.neck && anchors.hip) {
    const dx = anchors.neck[0] - anchors.hip[0];
    const dy = anchors.neck[1] - anchors.hip[1];
    if (dy < -12) rawAngle = (Math.atan2(dx, -dy) * 180) / Math.PI;
  } else if (anchors.head && anchors.neck) {
    const dx = anchors.head[0] - anchors.neck[0];
    const dy = anchors.head[1] - anchors.neck[1];
    if (dy < -8) rawAngle = ((Math.atan2(dx, -dy) * 180) / Math.PI) * 0.7;
  }

  const angleDeg = Math.max(-8, Math.min(8, (rawAngle - proportions.naturalRollDeg) * 0.75));
  const rad = (angleDeg * Math.PI) / 180;
  const upX = Math.sin(rad);
  const upY = -Math.cos(rad);

  const preds = [];
  if (anchors.neck) preds.push([anchors.neck[0], anchors.neck[1], 3.2 * anchors.neck[2]]);
  if (anchors.head) {
    preds.push([
      anchors.head[0] - upX * (proportions.headToTorso * torsoPx),
      anchors.head[1] - upY * (proportions.headToTorso * torsoPx),
      2.2 * anchors.head[2],
    ]);
  }
  if (anchors.hip) {
    preds.push([anchors.hip[0] + upX * torsoPx, anchors.hip[1] + upY * torsoPx, 2.2 * anchors.hip[2]]);
  }

  let srcCx, srcCy;
  if (preds.length) {
    let sx = 0,
      sy = 0,
      sw = 0;
    for (const [px, py, w] of preds) {
      sx += px * w;
      sy += py * w;
      sw += w;
    }
    srcCx = sx / sw;
    srcCy = sy / sw;
  } else {
    const [bx1, by1, bx2, by2] = candidate.bbox;
    srcCx = (bx1 + bx2) * 0.5;
    srcCy = by1 + (by2 - by1) * 0.25;
  }

  const prev = item.transform || {};
  return {
    srcCx,
    srcCy,
    scale: 1 / Math.max(12, torsoPx),
    angleDeg,
    userDx: prev.userDx || 0,
    userDy: prev.userDy || 0,
    userScale: prev.userScale || 1,
    userAngleDeg: prev.userAngleDeg || 0,
  };
}

/**
 * Mode 2: Face / Eyes alignment ("Photo a Day", Baby Growth, Skincare, Haircut, Braces).
 * Locks left_eye & right_eye onto exact horizontal target eye line.
 */
export function computeFaceTransform(item, candidate, proportions) {
  const lm = candidate.landmarks;
  const lEye = lm.left_eye;
  const rEye = lm.right_eye;
  const lEar = lm.left_ear;
  const rEar = lm.right_ear;
  const nose = lm.nose;

  const estimates = [];
  let angleDeg = 0;

  // Notice in COCO/image coordinates: person's right_eye is visually on the LEFT (smaller x),
  // person's left_eye is visually on the RIGHT (larger x). Sort by x so vector always points left -> right!
  if (lEye && rEye && lEye.confidence >= 0.25 && rEye.confidence >= 0.25) {
    const [leftPt, rightPt] = lEye.x <= rEye.x ? [lEye, rEye] : [rEye, lEye];
    const dx = rightPt.x - leftPt.x;
    const dy = rightPt.y - leftPt.y;
    const d = Math.hypot(dx, dy);
    if (d >= 6) {
      estimates.push([d, 4.0 * Math.min(lEye.confidence, rEye.confidence)]);
      // If right eye is lower (dy > 0), head tilts CW -> rotate CCW (+angleDeg) to level
      angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }

  if (lEar && rEar && lEar.confidence >= 0.25 && rEar.confidence >= 0.25) {
    const [leftPt, rightPt] = lEar.x <= rEar.x ? [lEar, rEar] : [rEar, lEar];
    const d = Math.hypot(rightPt.x - leftPt.x, rightPt.y - leftPt.y);
    if (d >= 12) {
      estimates.push([d / proportions.earToEye, 1.4 * Math.min(lEar.confidence, rEar.confidence)]);
      if (angleDeg === 0) {
        angleDeg = (Math.atan2(rightPt.y - leftPt.y, rightPt.x - leftPt.x) * 180) / Math.PI;
      }
    }
  }

  if (candidate.faceBbox) {
    const fw = candidate.faceBbox[2] - candidate.faceBbox[0];
    if (fw >= 14) estimates.push([fw * 0.44, 0.9]);
  }

  // Fallback if only shoulders visible
  if (!estimates.length && lm.left_shoulder && lm.right_shoulder) {
    const sw = Math.hypot(lm.left_shoulder.x - lm.right_shoulder.x, lm.left_shoulder.y - lm.right_shoulder.y);
    estimates.push([sw * 0.28, 0.6]);
  }

  let eyeDistPx;
  if (!estimates.length) {
    eyeDistPx = Math.max(20, Math.min(item.width, item.height) * 0.14);
  } else {
    const med = median(estimates.map((e) => e[0]));
    let num = 0,
      den = 0;
    for (const [v, w] of estimates) {
      if (Math.abs(v - med) <= med * 0.35) {
        num += v * w;
        den += w;
      }
    }
    eyeDistPx = den > 0 ? num / den : estimates[0][0];
  }

  angleDeg = Math.max(-22, Math.min(22, angleDeg * 0.9));

  // Eye-line center anchor
  let srcCx, srcCy;
  if (lEye && rEye) {
    srcCx = (lEye.x + rEye.x) * 0.5;
    srcCy = (lEye.y + rEye.y) * 0.5;
  } else if (nose) {
    const rad = (angleDeg * Math.PI) / 180;
    // Eyes sit slightly above nose along head-up axis
    srcCx = nose.x - Math.sin(rad) * eyeDistPx * proportions.noseToEye * 0.7;
    srcCy = nose.y - Math.cos(rad) * eyeDistPx * proportions.noseToEye * 0.7;
  } else if (candidate.faceBbox) {
    srcCx = (candidate.faceBbox[0] + candidate.faceBbox[2]) * 0.5;
    srcCy = candidate.faceBbox[1] + (candidate.faceBbox[3] - candidate.faceBbox[1]) * 0.42;
  } else {
    srcCx = item.width * 0.5;
    srcCy = item.height * 0.35;
  }

  const prev = item.transform || {};
  return {
    srcCx,
    srcCy,
    scale: 1 / Math.max(8, eyeDistPx),
    angleDeg,
    userDx: prev.userDx || 0,
    userDy: prev.userDy || 0,
    userScale: prev.userScale || 1,
    userAngleDeg: prev.userAngleDeg || 0,
  };
}

/**
 * Mode 3: Universal 2-Point Anchor alignment (Pets, Plants, Renovations, Sketches, Coffee Art, Any Object).
 * Aligns user-placed points A & B onto the canonical span, preserving the natural orientation of the reference frame
 * so horizontal, vertical, or diagonal point pairs all stay upright without awkward 45-degree tilts.
 */
export function computePointsTransform(item, referenceAngleDeg = null) {
  const prev = item.transform || {};
  const pts = item.customPoints;
  if (!pts || pts.length < 2) {
    return {
      srcCx: item.width * 0.5,
      srcCy: item.height * 0.5,
      scale: 1 / Math.max(40, Math.min(item.width, item.height) * 0.4),
      angleDeg: 0,
      userDx: prev.userDx || 0,
      userDy: prev.userDy || 0,
      userScale: prev.userScale || 1,
      userAngleDeg: prev.userAngleDeg || 0,
    };
  }

  const [pA, pB] = pts;
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const dist = Math.max(10, Math.hypot(dx, dy));
  const rawAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

  // Compute smallest signed angular difference relative to reference A->B angle (or nearest horizontal/vertical axis)
  let targetRef = referenceAngleDeg;
  if (targetRef === null || targetRef === undefined) {
    // Snap single/first photo to nearest cardinal axis (0, 90, -90, 180) only if already close, else keep upright (0 rotation)
    targetRef = rawAngle;
  }
  let diff = ((rawAngle - targetRef + 540) % 360) - 180;
  const angleDeg = Math.max(-35, Math.min(35, diff));

  return {
    srcCx: (pA.x + pB.x) * 0.5,
    srcCy: (pA.y + pB.y) * 0.5,
    scale: 1 / dist,
    angleDeg,
    userDx: prev.userDx || 0,
    userDy: prev.userDy || 0,
    userScale: prev.userScale || 1,
    userAngleDeg: prev.userAngleDeg || 0,
  };
}

export function getReferencePointsAngle(items) {
  for (const it of items) {
    if (it.customPoints && it.customPoints.length >= 2) {
      const [pA, pB] = it.customPoints;
      return (Math.atan2(pB.y - pA.y, pB.x - pA.x) * 180) / Math.PI;
    }
  }
  return null;
}

export function computeCandidateTransform(item, candidate, proportions, alignMode = "body", referenceAngleDeg = null) {
  if (alignMode === "points") {
    return computePointsTransform(item, referenceAngleDeg);
  }
  if (!candidate) {
    const prev = item.transform || {};
    return {
      srcCx: item.width * 0.5,
      srcCy: item.height * (alignMode === "face" ? 0.4 : 0.32),
      scale: 1 / Math.max(40, item.height * (alignMode === "face" ? 0.14 : 0.28)),
      angleDeg: 0,
      userDx: prev.userDx || 0,
      userDy: prev.userDy || 0,
      userScale: prev.userScale || 1,
      userAngleDeg: prev.userAngleDeg || 0,
    };
  }
  if (alignMode === "face") {
    return computeFaceTransform(item, candidate, proportions);
  }
  return computeBodyTransform(item, candidate, proportions);
}

/**
 * Recompute transforms for an entire batch when switching alignment mode (body / face / points)
 * without re-running pose inference.
 */
export function recomputeBatchTransforms(items, proportions, alignMode = "body") {
  const refPtsAngle = alignMode === "points" ? getReferencePointsAngle(items) : null;
  for (const item of items) {
    const cand =
      item.candidates.length && item.selectedCandidate < item.candidates.length
        ? item.candidates[item.selectedCandidate]
        : null;
    item.transform = computeCandidateTransform(item, cand, proportions, alignMode, refPtsAngle);
  }
}

/**
 * Cross-photo identity matching + body/face proportion calibration + transform computation.
 */
export function finalizeBatchAlignment(items, alignMode = "body") {
  const refDescriptors = [];
  const multiIndices = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.candidates.length === 1 && item.candidates[0].score >= 0.45) {
      const desc = extractHeadDescriptor(item.canvas, item.candidates[0]);
      if (desc) refDescriptors.push([item.candidates[0].score + 0.3, desc]);
    } else if (item.candidates.length > 1) {
      multiIndices.push(i);
      item._descs = item.candidates.map((c) => extractHeadDescriptor(item.canvas, c));
      if (item.candidates[0].score - item.candidates[1].score > 0.16 && item._descs[0]) {
        refDescriptors.push([item.candidates[0].score, item._descs[0]]);
      }
    }
  }

  if (multiIndices.length && refDescriptors.length) {
    refDescriptors.sort((a, b) => b[0] - a[0]);
    const top = refDescriptors.slice(0, 8);
    const meanRef = new Float32Array(112);
    for (const [, d] of top) {
      for (let j = 0; j < 112; j++) meanRef[j] += d[j] / top.length;
    }
    l2Normalize(meanRef);

    for (const idx of multiIndices) {
      const item = items[idx];
      const descs = item._descs || [];
      let bestIdx = 0;
      let bestCombined = -1e9;
      for (let c = 0; c < item.candidates.length; c++) {
        const cand = item.candidates[c];
        const desc = descs[c];
        let combined = cand.score * 0.72;
        if (desc) {
          let dot = 0;
          for (let j = 0; j < 112; j++) dot += desc[j] * meanRef[j];
          cand.identityDistance = Math.max(0, 1 - dot);
          combined += Math.max(0, dot) * 0.28;
        }
        if (combined > bestCombined) {
          bestCombined = combined;
          bestIdx = c;
        }
      }
      item.selectedCandidate = bestIdx;
      delete item._descs;
    }
  }

  const proportions = calibrateBodyProportions(items);
  recomputeBatchTransforms(items, proportions, alignMode);
  return proportions;
}
