"""Core subject detection (YOLO11-Pose), cross-photo identity matching, alignment transform, and frame rendering."""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from eachday.images import load_rgb_image
from eachday.models import PersonCandidate, PhotoItem, RenderSettings, TransformParams

# COCO 17 keypoint index mapping used by YOLO-Pose
_COCO_KEYPOINTS = [
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
]

_MODEL_LOCK = threading.Lock()
_POSE_MODEL = None

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}
_MAC_FONT_CANDIDATES = [
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def _get_model_path() -> str:
    """Resolve local cached yolo11n-pose.pt path (prefer project models/ or ~/.cache/eachday/)."""
    project_model = Path(__file__).resolve().parent.parent.parent / "models" / "yolo11n-pose.pt"
    if project_model.exists():
        return str(project_model)
    cache_dir = Path.home() / ".cache" / "eachday"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_model = cache_dir / "yolo11n-pose.pt"
    if cache_model.exists():
        return str(cache_model)
    # Ultralytics will auto-download into project_model directory when passed a path or name
    project_model.parent.mkdir(parents=True, exist_ok=True)
    return str(project_model)


def _get_pose_model():
    global _POSE_MODEL
    if _POSE_MODEL is not None:
        return _POSE_MODEL
    with _MODEL_LOCK:
        if _POSE_MODEL is None:
            from ultralytics import YOLO

            model_path = _get_model_path()
            _POSE_MODEL = YOLO(model_path)
    return _POSE_MODEL


def _get_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _MAC_FONT_CANDIDATES:
        key = (path, size)
        if key in _FONT_CACHE:
            return _FONT_CACHE[key]
        if Path(path).exists():
            try:
                font = ImageFont.truetype(path, size=size)
                _FONT_CACHE[key] = font
                return font
            except Exception:
                continue
    return ImageFont.load_default()


def _extract_head_descriptor(img_rgb: np.ndarray, candidate: PersonCandidate) -> np.ndarray | None:
    """Compute a compact, lighting-normalized visual descriptor of a person's head/face region
    (LAB color histogram + downsampled normalized grayscale patch + edge orientation histogram)
    to distinguish the user from background gym-goers in multi-person photos.
    """
    h, w = img_rgb.shape[:2]
    lm = candidate.landmarks

    if candidate.face_bbox:
        x1, y1, x2, y2 = candidate.face_bbox
    else:
        head_pts = [lm[k] for k in ("nose", "left_eye", "right_eye", "left_ear", "right_ear") if k in lm]
        if not head_pts:
            return None
        cx = sum(p["x"] for p in head_pts) / len(head_pts)
        cy = sum(p["y"] for p in head_pts) / len(head_pts)
        neck = lm.get("neck")
        if neck:
            side = max(24.0, math.hypot(cx - neck["x"], cy - neck["y"]) * 1.8)
        else:
            bx1, _, bx2, _ = candidate.bbox
            side = max(24.0, (bx2 - bx1) * 0.45)
        x1, y1, x2, y2 = cx - side * 0.5, cy - side * 0.5, cx + side * 0.5, cy + side * 0.5

    ix1, iy1 = max(0, int(round(x1))), max(0, int(round(y1)))
    ix2, iy2 = min(w, int(round(x2))), min(h, int(round(y2)))
    if ix2 - ix1 < 14 or iy2 - iy1 < 14:
        return None

    crop = cv2.resize(img_rgb[iy1:iy2, ix1:ix2], (48, 48), interpolation=cv2.INTER_AREA)

    # 1. Normalized LAB chrominance histogram (captures skin tone & hair tone robustly)
    lab = cv2.cvtColor(crop, cv2.COLOR_RGB2LAB)
    hist_a = cv2.calcHist([lab], [1], None, [16], [0, 256]).flatten()
    hist_b = cv2.calcHist([lab], [2], None, [16], [0, 256]).flatten()
    hist_l = cv2.calcHist([lab], [0], None, [8], [0, 256]).flatten()
    color_vec = np.concatenate([hist_l * 0.4, hist_a, hist_b]).astype(np.float32)
    color_vec /= np.linalg.norm(color_vec) + 1e-6

    # 2. Gradient orientation structure (coarse 3x3 cells x 8 bins HOG-like facial structure)
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gray = (gray - gray.mean()) / (gray.std() + 1e-5)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    ang = (np.degrees(np.arctan2(gy, gx)) + 180.0) % 180.0
    hog_feats: list[np.ndarray] = []
    step = 16
    for r in range(0, 48, step):
        for c in range(0, 48, step):
            cell_m = mag[r : r + step, c : c + step]
            cell_a = ang[r : r + step, c : c + step]
            h_bins, _ = np.histogram(cell_a, bins=8, range=(0, 180), weights=cell_m)
            hog_feats.append(h_bins.astype(np.float32))
    hog_vec = np.concatenate(hog_feats)
    hog_vec /= np.linalg.norm(hog_vec) + 1e-6

    desc = np.concatenate([color_vec * 0.55, hog_vec * 0.45])
    desc /= np.linalg.norm(desc) + 1e-6
    return desc


def _prominence_score(
    landmarks: dict[str, dict[str, float]],
    bbox: list[float],
    det_conf: float,
    img_w: int,
    img_h: int,
) -> float:
    """Score favoring the foreground, upright, relatively centered mirror-selfie subject."""
    x1, y1, x2, y2 = bbox
    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)
    cx = (x1 + x2) * 0.5
    cy = (y1 + y2) * 0.5

    l_sh = landmarks.get("left_shoulder")
    r_sh = landmarks.get("right_shoulder")
    neck = landmarks.get("neck")
    root = landmarks.get("root")

    torso_scale = 0.0
    if l_sh and r_sh:
        torso_scale = max(torso_scale, math.hypot(l_sh["x"] - r_sh["x"], l_sh["y"] - r_sh["y"]) * 1.45)
    if neck and root:
        torso_scale = max(torso_scale, math.hypot(neck["x"] - root["x"], neck["y"] - root["y"]))
    if torso_scale <= 1.0:
        torso_scale = max(bw * 1.05, bh * 0.34)

    # Size score (foreground subject taking mirror selfie has large torso & bbox height)
    torso_norm = min(1.0, torso_scale / (min(img_w, img_h) * 0.48))
    height_norm = min(1.0, bh / (img_h * 0.72))
    size_score = 0.65 * torso_norm + 0.35 * height_norm

    # Horizontal centrality: mirror selfie subject is typically near the horizontal middle
    dx_norm = abs(cx / img_w - 0.5)
    center_score = max(0.0, 1.0 - dx_norm * 1.6)

    # Vertical sanity
    vert_score = 1.0 - min(0.5, abs(cy / img_h - 0.52))

    # Keypoint completeness for upper body
    key_names = ("neck", "left_shoulder", "right_shoulder", "nose", "root")
    conf_sum = sum(landmarks[k]["confidence"] for k in key_names if k in landmarks)
    completeness = min(1.0, conf_sum / 4.2)

    # Uprightness check: penalize people bending over / lying on floor in the gym background
    upright_bonus = 1.0
    if neck and root:
        if neck["y"] > root["y"]:
            upright_bonus = 0.25
        else:
            dx = abs(neck["x"] - root["x"])
            dy = max(1.0, root["y"] - neck["y"])
            if dx / dy > 0.65:
                upright_bonus = 0.5

    raw = (
        0.48 * size_score
        + 0.26 * center_score
        + 0.14 * completeness
        + 0.06 * vert_score
        + 0.06 * min(1.0, det_conf)
    ) * upright_bonus
    return float(raw)


def _estimate_face_bbox(landmarks: dict[str, dict[str, float]], img_w: int, img_h: int) -> list[float] | None:
    """Estimate head/face bounding box from nose/eyes/ears landmarks."""
    pts = [landmarks[k] for k in ("nose", "left_eye", "right_eye", "left_ear", "right_ear") if k in landmarks]
    if not pts:
        return None
    cx = sum(p["x"] for p in pts) / len(pts)
    cy = sum(p["y"] for p in pts) / len(pts)

    radius = 0.0
    if "left_ear" in landmarks and "right_ear" in landmarks:
        radius = max(
            radius,
            math.hypot(
                landmarks["left_ear"]["x"] - landmarks["right_ear"]["x"],
                landmarks["left_ear"]["y"] - landmarks["right_ear"]["y"],
            )
            * 0.72,
        )
    if "left_eye" in landmarks and "right_eye" in landmarks:
        radius = max(
            radius,
            math.hypot(
                landmarks["left_eye"]["x"] - landmarks["right_eye"]["x"],
                landmarks["left_eye"]["y"] - landmarks["right_eye"]["y"],
            )
            * 1.45,
        )
    if radius < 8.0 and "neck" in landmarks:
        radius = max(radius, math.hypot(cx - landmarks["neck"]["x"], cy - landmarks["neck"]["y"]) * 0.55)
    if radius < 8.0:
        return None

    return [
        max(0.0, cx - radius * 0.9),
        max(0.0, cy - radius * 1.15),
        min(float(img_w), cx + radius * 0.9),
        min(float(img_h), cy + radius * 0.95),
    ]


def detect_people_in_image(img: Image.Image) -> list[PersonCandidate]:
    """Detect all people and their 17 COCO pose keypoints in an EXIF-transposed RGB PIL Image."""
    orig_w, orig_h = img.size
    rgb = np.asarray(img)
    # YOLO expects BGR numpy array or PIL image; pass PIL directly (Ultralytics handles RGB cleanly)
    model = _get_pose_model()
    results = model.predict(img, imgsz=640, conf=0.22, verbose=False)

    candidates: list[PersonCandidate] = []
    if not results:
        return candidates

    res = results[0]
    if res.boxes is None or res.keypoints is None or len(res.boxes) == 0:
        return candidates

    boxes_xyxy = res.boxes.xyxy.cpu().numpy()
    boxes_conf = res.boxes.conf.cpu().numpy()
    kpts_xy = res.keypoints.xy.cpu().numpy()  # (N, 17, 2)
    kpts_conf = res.keypoints.conf.cpu().numpy() if res.keypoints.conf is not None else np.ones((len(boxes_xyxy), 17))

    for i in range(len(boxes_xyxy)):
        bx1, by1, bx2, by2 = [float(v) for v in boxes_xyxy[i]]
        det_conf = float(boxes_conf[i])
        if bx2 - bx1 < 12 or by2 - by1 < 20:
            continue

        landmarks: dict[str, dict[str, float]] = {}
        for k_idx, name in enumerate(_COCO_KEYPOINTS):
            kx, ky = float(kpts_xy[i, k_idx, 0]), float(kpts_xy[i, k_idx, 1])
            kc = float(kpts_conf[i, k_idx])
            if kc >= 0.25 and (kx > 0.5 or ky > 0.5):
                landmarks[name] = {"x": round(kx, 2), "y": round(ky, 2), "confidence": round(kc, 3)}

        # Synthesize `neck` (shoulder midpoint) and `root` (hip midpoint)
        if "left_shoulder" in landmarks and "right_shoulder" in landmarks:
            ls, rs = landmarks["left_shoulder"], landmarks["right_shoulder"]
            landmarks["neck"] = {
                "x": round((ls["x"] + rs["x"]) * 0.5, 2),
                "y": round((ls["y"] + rs["y"]) * 0.5, 2),
                "confidence": round(min(ls["confidence"], rs["confidence"]), 3),
            }
        if "left_hip" in landmarks and "right_hip" in landmarks:
            lh, rh = landmarks["left_hip"], landmarks["right_hip"]
            landmarks["root"] = {
                "x": round((lh["x"] + rh["x"]) * 0.5, 2),
                "y": round((lh["y"] + rh["y"]) * 0.5, 2),
                "confidence": round(min(lh["confidence"], rh["confidence"]), 3),
            }

        has_upper = any(k in landmarks for k in ("neck", "left_shoulder", "right_shoulder", "nose"))
        if not has_upper:
            continue

        face_bbox = _estimate_face_bbox(landmarks, orig_w, orig_h)
        bbox = [max(0.0, bx1), max(0.0, by1), min(float(orig_w), bx2), min(float(orig_h), by2)]
        score = _prominence_score(landmarks, bbox, det_conf, orig_w, orig_h)
        candidates.append(
            PersonCandidate(
                index=0,
                score=score,
                bbox=bbox,
                landmarks=landmarks,
                face_bbox=face_bbox,
            )
        )

    candidates.sort(key=lambda c: c.score, reverse=True)
    for idx, c in enumerate(candidates):
        c.index = idx
    return candidates


def _extract_anchors(candidate: PersonCandidate) -> dict[str, tuple[float, float, float]]:
    """Extract canonical anatomical anchor points: head, neck, l_shoulder, r_shoulder, hip."""
    lm = candidate.landmarks
    anchors: dict[str, tuple[float, float, float]] = {}

    head_pts: list[tuple[float, float, float]] = []
    for k, w in (("nose", 1.2), ("left_eye", 1.0), ("right_eye", 1.0), ("left_ear", 0.6), ("right_ear", 0.6)):
        if k in lm and lm[k]["confidence"] >= 0.3:
            head_pts.append((lm[k]["x"], lm[k]["y"], lm[k]["confidence"] * w))
    if head_pts:
        wsum = sum(p[2] for p in head_pts)
        anchors["head"] = (
            sum(p[0] * p[2] for p in head_pts) / wsum,
            sum(p[1] * p[2] for p in head_pts) / wsum,
            min(1.0, wsum / 2.2),
        )

    l_sh = lm.get("left_shoulder")
    r_sh = lm.get("right_shoulder")
    if l_sh and l_sh["confidence"] >= 0.3:
        anchors["l_shoulder"] = (l_sh["x"], l_sh["y"], l_sh["confidence"])
    if r_sh and r_sh["confidence"] >= 0.3:
        anchors["r_shoulder"] = (r_sh["x"], r_sh["y"], r_sh["confidence"])

    if "l_shoulder" in anchors and "r_shoulder" in anchors:
        mx = (anchors["l_shoulder"][0] + anchors["r_shoulder"][0]) * 0.5
        my = (anchors["l_shoulder"][1] + anchors["r_shoulder"][1]) * 0.5
        mc = min(anchors["l_shoulder"][2], anchors["r_shoulder"][2])
        anchors["neck"] = (mx, my, mc)
    elif "neck" in lm:
        anchors["neck"] = (lm["neck"]["x"], lm["neck"]["y"], lm["neck"]["confidence"])

    l_hip = lm.get("left_hip")
    r_hip = lm.get("right_hip")
    if l_hip and r_hip and l_hip["confidence"] >= 0.3 and r_hip["confidence"] >= 0.3:
        mx = (l_hip["x"] + r_hip["x"]) * 0.5
        my = (l_hip["y"] + r_hip["y"]) * 0.5
        mc = min(l_hip["confidence"], r_hip["confidence"])
        anchors["hip"] = (mx, my, mc)
    elif "root" in lm and lm["root"]["confidence"] >= 0.3:
        anchors["hip"] = (lm["root"]["x"], lm["root"]["y"], lm["root"]["confidence"])

    return anchors


@dataclass
class BodyProportions:
    """Self-calibrated body proportions across the user's photo collection."""
    shoulder_to_torso: float = 0.72
    head_to_torso: float = 0.34
    natural_roll_deg: float = 0.0


def calibrate_body_proportions(items: list[PhotoItem]) -> BodyProportions:
    """Estimate the user's natural body proportions and natural standing posture roll (median across confident detections)."""
    sw_ratios: list[float] = []
    head_ratios: list[float] = []
    roll_angles: list[float] = []

    for item in items:
        if not item.candidates or item.selected_candidate >= len(item.candidates):
            continue
        cand = item.candidates[item.selected_candidate]
        anchors = _extract_anchors(cand)
        if "neck" not in anchors or "hip" not in anchors:
            continue
        dx = anchors["neck"][0] - anchors["hip"][0]
        dy = anchors["neck"][1] - anchors["hip"][1]
        torso = math.hypot(dx, dy)
        if torso < 18.0:
            continue
        if dy < -12.0:
            roll_angles.append(math.degrees(math.atan2(dx, -dy)))
        if "l_shoulder" in anchors and "r_shoulder" in anchors:
            sw = math.hypot(
                anchors["l_shoulder"][0] - anchors["r_shoulder"][0],
                anchors["l_shoulder"][1] - anchors["r_shoulder"][1],
            )
            r = sw / torso
            if 0.35 <= r <= 1.25:
                sw_ratios.append(r)
        if "head" in anchors:
            hd = math.hypot(anchors["head"][0] - anchors["neck"][0], anchors["head"][1] - anchors["neck"][1])
            r = hd / torso
            if 0.15 <= r <= 0.75:
                head_ratios.append(r)

    return BodyProportions(
        shoulder_to_torso=float(np.median(sw_ratios)) if sw_ratios else 0.72,
        head_to_torso=float(np.median(head_ratios)) if head_ratios else 0.34,
        natural_roll_deg=float(np.median(roll_angles)) if len(roll_angles) >= 3 else 0.0,
    )


def compute_candidate_transform(
    item: PhotoItem,
    candidate: PersonCandidate,
    proportions: BodyProportions,
) -> TransformParams:
    """Compute canonical normalized transform parameters for a candidate person.

    `scale` is stored in canonical units where `1.0 / scale` equals the detected torso height
    in source pixels (so rendering simply multiplies `scale * target_torso_px * zoom * user_scale`).
    """
    anchors = _extract_anchors(candidate)

    # 1. Estimate torso height in source pixels from all available geometric pairs
    estimates: list[tuple[float, float]] = []

    if "neck" in anchors and "hip" in anchors:
        d = math.hypot(anchors["neck"][0] - anchors["hip"][0], anchors["neck"][1] - anchors["hip"][1])
        if d > 12.0:
            estimates.append((d, 3.4 * min(anchors["neck"][2], anchors["hip"][2])))

    if "head" in anchors and "hip" in anchors:
        d = math.hypot(anchors["head"][0] - anchors["hip"][0], anchors["head"][1] - anchors["hip"][1])
        if d > 18.0:
            torso_est = d / (1.0 + proportions.head_to_torso)
            estimates.append((torso_est, 2.8 * min(anchors["head"][2], anchors["hip"][2])))

    if "l_shoulder" in anchors and "r_shoulder" in anchors:
        sw = math.hypot(
            anchors["l_shoulder"][0] - anchors["r_shoulder"][0],
            anchors["l_shoulder"][1] - anchors["r_shoulder"][1],
        )
        if sw > 10.0:
            torso_est = sw / proportions.shoulder_to_torso
            estimates.append((torso_est, 2.0 * min(anchors["l_shoulder"][2], anchors["r_shoulder"][2])))

    if "head" in anchors and "neck" in anchors:
        hd = math.hypot(anchors["head"][0] - anchors["neck"][0], anchors["head"][1] - anchors["neck"][1])
        if hd > 8.0:
            torso_est = hd / proportions.head_to_torso
            estimates.append((torso_est, 0.8 * min(anchors["head"][2], anchors["neck"][2])))

    if not estimates:
        bx1, by1, bx2, by2 = candidate.bbox
        torso_px = max(30.0, (by2 - by1) * 0.34)
    else:
        vals = np.array([e[0] for e in estimates], dtype=np.float64)
        wts = np.array([e[1] for e in estimates], dtype=np.float64)
        med = float(np.median(vals))
        keep = np.abs(vals - med) <= med * 0.32
        if np.any(keep):
            vals, wts = vals[keep], wts[keep]
        torso_px = float(np.sum(vals * wts) / np.sum(wts))

    # 2. Estimate relative roll correction from vertical spine axis (subtracting natural one-handed selfie posture bias)
    raw_angle = 0.0
    if "neck" in anchors and "hip" in anchors:
        dx = anchors["neck"][0] - anchors["hip"][0]
        dy = anchors["neck"][1] - anchors["hip"][1]
        if dy < -12.0:
            raw_angle = math.degrees(math.atan2(dx, -dy))
    elif "head" in anchors and "neck" in anchors:
        dx = anchors["head"][0] - anchors["neck"][0]
        dy = anchors["head"][1] - anchors["neck"][1]
        if dy < -8.0:
            raw_angle = math.degrees(math.atan2(dx, -dy)) * 0.7

    # Correct deviations from natural posture while keeping gym walls/floors level
    angle_deg = max(-8.0, min(8.0, (raw_angle - proportions.natural_roll_deg) * 0.75))

    # 3. Compute rock-steady neck anchor by combining predictions from neck, head, and hip
    rad = math.radians(angle_deg)
    up_x, up_y = math.sin(rad), -math.cos(rad)

    neck_preds: list[tuple[float, float, float]] = []
    if "neck" in anchors:
        neck_preds.append((anchors["neck"][0], anchors["neck"][1], 3.2 * anchors["neck"][2]))
    if "head" in anchors:
        px = anchors["head"][0] - up_x * (proportions.head_to_torso * torso_px)
        py = anchors["head"][1] - up_y * (proportions.head_to_torso * torso_px)
        neck_preds.append((px, py, 2.2 * anchors["head"][2]))
    if "hip" in anchors:
        px = anchors["hip"][0] + up_x * torso_px
        py = anchors["hip"][1] + up_y * torso_px
        neck_preds.append((px, py, 2.2 * anchors["hip"][2]))

    if neck_preds:
        wsum = sum(p[2] for p in neck_preds)
        src_cx = sum(p[0] * p[2] for p in neck_preds) / wsum
        src_cy = sum(p[1] * p[2] for p in neck_preds) / wsum
    else:
        bx1, by1, bx2, by2 = candidate.bbox
        src_cx = (bx1 + bx2) * 0.5
        src_cy = by1 + (by2 - by1) * 0.25

    return TransformParams(
        src_cx=round(src_cx, 2),
        src_cy=round(src_cy, 2),
        scale=round(1.0 / max(12.0, torso_px), 6),
        angle_deg=round(angle_deg, 2),
        user_dx=item.transform.user_dx,
        user_dy=item.transform.user_dy,
        user_scale=item.transform.user_scale,
        user_angle_deg=item.transform.user_angle_deg,
    )


def analyze_batch(
    items: list[PhotoItem],
    progress_cb: Callable[[int, int, str], None] | None = None,
) -> BodyProportions:
    """Run multi-person YOLO-Pose detection, cross-photo identity verification, and canonical alignment."""
    total = len(items)
    if progress_cb:
        progress_cb(0, total, "加载姿态识别模型...")
    _get_pose_model()

    ref_descriptors: list[tuple[float, np.ndarray]] = []
    multi_person_indices: list[int] = []
    candidate_descriptors: dict[int, list[np.ndarray | None]] = {}

    for idx, item in enumerate(items):
        if progress_cb:
            progress_cb(idx, total, f"分析姿态 ({idx + 1}/{total}): {item.filename}")
        try:
            img = load_rgb_image(item.path)
            item.width, item.height = img.size
            candidates = detect_people_in_image(img)
            item.candidates = candidates
            item.detected = len(candidates) > 0
            item.selected_candidate = 0
            item.warning = None if candidates else "未检测到人物，请手动调整或跳过"

            rgb = np.asarray(img)
            if len(candidates) == 1 and candidates[0].score >= 0.45:
                desc = _extract_head_descriptor(rgb, candidates[0])
                if desc is not None:
                    ref_descriptors.append((candidates[0].score + 0.3, desc))
            elif len(candidates) > 1:
                multi_person_indices.append(idx)
                descs = [_extract_head_descriptor(rgb, c) for c in candidates]
                candidate_descriptors[idx] = descs
                if candidates[0].score - candidates[1].score > 0.16 and descs[0] is not None:
                    ref_descriptors.append((candidates[0].score, descs[0]))
        except Exception as exc:
            item.candidates = []
            item.detected = False
            item.warning = f"分析失败: {exc}"

    # Verify multi-person selections using mean reference head descriptor
    if multi_person_indices and ref_descriptors:
        if progress_cb:
            progress_cb(total, total, "正在比对人物特征以排除背景路人...")
        ref_descriptors.sort(key=lambda x: x[0], reverse=True)
        top_refs = [d for _, d in ref_descriptors[:8]]
        mean_ref = np.mean(np.stack(top_refs, axis=0), axis=0)
        mean_ref /= np.linalg.norm(mean_ref) + 1e-6

        for idx in multi_person_indices:
            item = items[idx]
            descs = candidate_descriptors.get(idx, [])
            best_idx = 0
            best_combined = -1e9
            for c_idx, cand in enumerate(item.candidates):
                desc = descs[c_idx] if c_idx < len(descs) else None
                if desc is not None:
                    cos_sim = float(np.dot(desc, mean_ref))
                    dist = max(0.0, 1.0 - cos_sim)
                    cand.identity_distance = dist
                    combined = cand.score * 0.72 + max(0.0, cos_sim) * 0.28
                else:
                    combined = cand.score * 0.72
                if combined > best_combined:
                    best_combined = combined
                    best_idx = c_idx
            item.selected_candidate = best_idx

    proportions = calibrate_body_proportions(items)
    for item in items:
        if item.candidates and 0 <= item.selected_candidate < len(item.candidates):
            item.transform = compute_candidate_transform(
                item, item.candidates[item.selected_candidate], proportions
            )
        else:
            item.transform = TransformParams(
                src_cx=item.width * 0.5,
                src_cy=item.height * 0.32,
                scale=round(1.0 / max(60.0, item.height * 0.28), 6),
                angle_deg=0.0,
            )

    if progress_cb:
        progress_cb(total, total, "分析完成")
    return proportions


def _canonical_target(canvas_w: int, canvas_h: int, settings: RenderSettings) -> tuple[float, float, float]:
    """Return (target_neck_x, target_neck_y, target_torso_px) for the output canvas."""
    aspect = canvas_w / canvas_h
    if aspect < 0.65:  # 9:16 tall portrait
        neck_y_ratio = 0.295
        torso_ratio = 0.245
    elif aspect < 0.85:  # 3:4 or 4:5 portrait
        neck_y_ratio = 0.285
        torso_ratio = 0.285
    else:  # 1:1 square
        neck_y_ratio = 0.28
        torso_ratio = 0.33

    target_x = canvas_w * 0.5
    target_y = canvas_h * (neck_y_ratio + settings.vertical_shift)
    target_torso_px = canvas_h * torso_ratio * settings.zoom
    return target_x, target_y, target_torso_px


def build_affine_matrix(
    item: PhotoItem,
    canvas_w: int,
    canvas_h: int,
    settings: RenderSettings,
) -> np.ndarray:
    """Build the 2x3 OpenCV warpAffine matrix mapping source image pixels to output canvas pixels."""
    t = item.transform
    dst_cx, dst_cy, target_torso_px = _canonical_target(canvas_w, canvas_h, settings)

    dst_cx += t.user_dx * canvas_w
    dst_cy += t.user_dy * canvas_h

    total_scale = t.scale * target_torso_px * t.user_scale
    total_angle = (t.angle_deg if settings.auto_level else 0.0) + t.user_angle_deg

    M = cv2.getRotationMatrix2D((t.src_cx, t.src_cy), total_angle, total_scale)
    M[0, 2] += dst_cx - t.src_cx
    M[1, 2] += dst_cy - t.src_cy
    return M


def _make_blur_background(src_rgb: np.ndarray, canvas_w: int, canvas_h: int) -> np.ndarray:
    """Create a cover-scaled, heavily blurred, slightly dimmed background layer."""
    sh, sw = src_rgb.shape[:2]
    scale = max(canvas_w / sw, canvas_h / sh)

    work_scale = min(1.0, 280.0 / max(canvas_w, canvas_h))
    bw = max(32, int(round(canvas_w * work_scale)))
    bh = max(32, int(round(canvas_h * work_scale)))

    crop_w = max(1, int(round(canvas_w / scale)))
    crop_h = max(1, int(round(canvas_h / scale)))
    x0 = max(0, (sw - crop_w) // 2)
    y0 = max(0, (sh - crop_h) // 2)
    cropped = src_rgb[y0 : y0 + crop_h, x0 : x0 + crop_w]
    small = cv2.resize(cropped, (bw, bh), interpolation=cv2.INTER_AREA)

    ksize = max(15, int(round(min(bw, bh) * 0.16)) | 1)
    blurred = cv2.GaussianBlur(small, (ksize, ksize), 0)
    bg = cv2.resize(blurred, (canvas_w, canvas_h), interpolation=cv2.INTER_LINEAR)
    bg = (bg.astype(np.float32) * 0.68).astype(np.uint8)
    return bg


def _draw_watermark(
    frame_rgb: np.ndarray,
    text: str,
    position: str,
) -> np.ndarray:
    """Draw a sleek frosted dark pill watermark with crisp typography."""
    if not text:
        return frame_rgb

    h, w = frame_rgb.shape[:2]
    pil_img = Image.fromarray(frame_rgb).convert("RGBA")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    font_size = max(14, int(round(w * 0.036)))
    font = _get_font(font_size)

    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    pad_x = int(round(font_size * 0.72))
    pad_y = int(round(font_size * 0.42))
    pill_w = tw + pad_x * 2
    pill_h = th + pad_y * 2
    margin = int(round(w * 0.048))
    bottom_margin = int(round(h * 0.045))

    if position == "bottom_center":
        px = (w - pill_w) // 2
        py = h - bottom_margin - pill_h
    elif position == "top_left":
        px = margin
        py = bottom_margin
    elif position == "top_right":
        px = w - margin - pill_w
        py = bottom_margin
    else:
        px = margin
        py = h - bottom_margin - pill_h

    radius = max(8, pill_h // 2)
    draw.rounded_rectangle(
        [px, py, px + pill_w, py + pill_h],
        radius=radius,
        fill=(12, 14, 18, 152),
        outline=(255, 255, 255, 42),
        width=max(1, w // 720),
    )

    tx = px + pad_x - bbox[0]
    ty = py + pad_y - bbox[1]
    draw.text((tx, ty + 1), text, font=font, fill=(0, 0, 0, 140))
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 242))

    composited = Image.alpha_composite(pil_img, overlay).convert("RGB")
    return np.asarray(composited)


def format_watermark_text(
    item: PhotoItem,
    sequence_index: int,
    first_timestamp: float,
    settings: RenderSettings,
) -> str:
    if not settings.show_watermark:
        return ""
    elapsed_days = max(1, int((item.timestamp - first_timestamp) // 86400) + 1)
    if settings.watermark_style == "day_date":
        return f"Day {sequence_index:02d}  ·  {item.date_str}"
    if settings.watermark_style == "count_date":
        return f"第 {sequence_index} 次  ·  {item.date_str}"
    if settings.watermark_style == "date_only":
        return item.date_str
    if settings.watermark_style == "day_only":
        return f"Day {elapsed_days:02d}"
    return f"Day {sequence_index:02d}  ·  {item.date_str}"


def render_aligned_frame(
    item: PhotoItem,
    settings: RenderSettings,
    sequence_index: int = 1,
    first_timestamp: float | None = None,
    canvas_size_override: tuple[int, int] | None = None,
    draw_guides: bool = False,
    src_img_override: Image.Image | None = None,
) -> np.ndarray:
    """Render a single aligned RGB uint8 frame (H, W, 3)."""
    canvas_w, canvas_h = canvas_size_override or settings.canvas_size()
    pil_src = src_img_override if src_img_override is not None else load_rgb_image(item.path)
    src_rgb = np.asarray(pil_src)
    sh, sw = src_rgb.shape[:2]

    M = build_affine_matrix(item, canvas_w, canvas_h, settings)
    interp = cv2.INTER_LANCZOS4 if canvas_w >= 720 else cv2.INTER_LINEAR

    if settings.fill_mode == "edge":
        frame = cv2.warpAffine(
            src_rgb,
            M,
            (canvas_w, canvas_h),
            flags=interp,
            borderMode=cv2.BORDER_REPLICATE,
        )
    elif settings.fill_mode == "black":
        frame = cv2.warpAffine(
            src_rgb,
            M,
            (canvas_w, canvas_h),
            flags=interp,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0),
        )
    else:
        warped = cv2.warpAffine(
            src_rgb,
            M,
            (canvas_w, canvas_h),
            flags=interp,
            borderMode=cv2.BORDER_REPLICATE,
        )
        mask_src = np.full((sh, sw), 255, dtype=np.uint8)
        warped_mask = cv2.warpAffine(
            mask_src,
            M,
            (canvas_w, canvas_h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        if np.all(warped_mask >= 250):
            frame = warped
        else:
            bg = _make_blur_background(src_rgb, canvas_w, canvas_h)
            feather = max(5, int(round(canvas_w * 0.014)) | 1)
            kernel = np.ones((max(3, feather // 2), max(3, feather // 2)), np.uint8)
            eroded = cv2.erode(warped_mask, kernel, iterations=1)
            alpha = cv2.GaussianBlur(eroded, (feather, feather), 0).astype(np.float32) / 255.0
            alpha_3 = alpha[:, :, None]
            frame = (warped.astype(np.float32) * alpha_3 + bg.astype(np.float32) * (1.0 - alpha_3)).astype(np.uint8)

    if settings.show_watermark:
        wm_text = format_watermark_text(
            item,
            sequence_index=sequence_index,
            first_timestamp=first_timestamp if first_timestamp is not None else item.timestamp,
            settings=settings,
        )
        frame = _draw_watermark(frame, wm_text, settings.watermark_position)

    if draw_guides:
        dst_cx, dst_cy, target_torso = _canonical_target(canvas_w, canvas_h, settings)
        cx, cy = int(round(dst_cx)), int(round(dst_cy))
        overlay = frame.copy()
        guide_color = (96, 215, 255)
        cv2.line(overlay, (cx, 0), (cx, canvas_h), guide_color, 1, cv2.LINE_AA)
        cv2.line(overlay, (0, cy), (canvas_w, cy), guide_color, 1, cv2.LINE_AA)
        hip_y = int(round(cy + target_torso))
        head_y = int(round(cy - target_torso * 0.34))
        cv2.line(overlay, (int(cx - target_torso * 0.45), hip_y), (int(cx + target_torso * 0.45), hip_y), guide_color, 1, cv2.LINE_AA)
        cv2.circle(overlay, (cx, head_y), max(4, int(target_torso * 0.04)), guide_color, 1, cv2.LINE_AA)
        frame = cv2.addWeighted(overlay, 0.55, frame, 0.45, 0)

    return frame
