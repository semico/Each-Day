"""Data models for EachDay photo alignment and video export."""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal


@dataclass
class Point2D:
    x: float
    y: float
    confidence: float = 1.0

    def to_dict(self) -> dict[str, float]:
        return {"x": round(self.x, 2), "y": round(self.y, 2), "confidence": round(self.confidence, 3)}


@dataclass
class PersonCandidate:
    """A detected person in an image with body pose landmarks."""
    index: int
    score: float
    bbox: list[float]  # [x1, y1, x2, y2] in pixels
    landmarks: dict[str, dict[str, float]]  # joint_name -> {x, y, confidence}
    face_bbox: list[float] | None = None  # [x1, y1, x2, y2] in pixels
    identity_distance: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "score": round(self.score, 4),
            "bbox": [round(v, 1) for v in self.bbox],
            "landmarks": self.landmarks,
            "face_bbox": [round(v, 1) for v in self.face_bbox] if self.face_bbox else None,
            "identity_distance": round(self.identity_distance, 4) if self.identity_distance is not None else None,
        }


@dataclass
class TransformParams:
    """Similarity transform parameters mapping source image to canonical output canvas.

    The transform maps source point (x, y) as:
      1. Translate anchor (src_cx, src_cy) to origin
      2. Scale by `scale` and rotate by `angle_deg` (counter-clockwise in image coords? No: OpenCV convention, positive = CCW)
      3. Translate to output anchor (dst_cx + offset_x, dst_cy + offset_y)

    Manual adjustments (`user_dx`, `user_dy`, `user_scale`, `user_angle_deg`) are layered
    cleanly on top of the auto-computed transform so the user can tweak or reset at any time.
    """
    src_cx: float = 0.0
    src_cy: float = 0.0
    scale: float = 1.0
    angle_deg: float = 0.0
    # Normalized user overrides (dx/dy as fraction of canvas width/height)
    user_dx: float = 0.0
    user_dy: float = 0.0
    user_scale: float = 1.0
    user_angle_deg: float = 0.0

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass
class PhotoItem:
    id: str
    filename: str
    path: str
    width: int
    height: int
    timestamp: float  # Unix timestamp for sorting
    date_str: str  # YYYY.MM.DD
    date_source: str  # "exif", "filename", "mtime"
    enabled: bool = True
    detected: bool = False
    selected_candidate: int = 0
    candidates: list[PersonCandidate] = field(default_factory=list)
    transform: TransformParams = field(default_factory=TransformParams)
    warning: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "filename": self.filename,
            "path": self.path,
            "width": self.width,
            "height": self.height,
            "timestamp": self.timestamp,
            "date_str": self.date_str,
            "date_source": self.date_source,
            "enabled": self.enabled,
            "detected": self.detected,
            "selected_candidate": self.selected_candidate,
            "candidates": [c.to_dict() for c in self.candidates],
            "transform": self.transform.to_dict(),
            "warning": self.warning,
        }


@dataclass
class RenderSettings:
    aspect_ratio: Literal["9:16", "3:4", "4:5", "1:1"] = "9:16"
    resolution: Literal["720p", "1080p"] = "1080p"
    zoom: float = 1.0  # Global framing zoom (0.65 .. 1.5)
    vertical_shift: float = 0.0  # Global vertical framing offset (-0.15 .. +0.15)
    auto_level: bool = True  # Auto-correct slight tilt based on spine axis
    fill_mode: Literal["blur", "black", "edge"] = "blur"
    show_watermark: bool = True
    watermark_style: Literal["day_date", "count_date", "date_only", "day_only"] = "day_date"
    watermark_position: Literal["bottom_left", "bottom_center", "top_left", "top_right"] = "bottom_left"
    fps: float = 6.0  # Photos per second (e.g., 2 to 15)
    hold_last_sec: float = 1.2  # Hold final frame at the end
    crossfade: bool = False  # Smooth crossfade between consecutive photos

    def canvas_size(self) -> tuple[int, int]:
        base_w = 1080 if self.resolution == "1080p" else 720
        ratios = {
            "9:16": (base_w, int(round(base_w * 16 / 9 / 2) * 2)),
            "3:4": (base_w, int(round(base_w * 4 / 3 / 2) * 2)),
            "4:5": (base_w, int(round(base_w * 5 / 4 / 2) * 2)),
            "1:1": (base_w, base_w),
        }
        return ratios.get(self.aspect_ratio, (base_w, int(round(base_w * 16 / 9 / 2) * 2)))

    def to_dict(self) -> dict[str, Any]:
        w, h = self.canvas_size()
        d = asdict(self)
        d["canvas_width"] = w
        d["canvas_height"] = h
        return d
