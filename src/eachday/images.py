"""Image loading (including HEIC/HEIF), EXIF orientation, and capture date extraction."""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Iterable

from PIL import ExifTags, Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except ImportError:
    HEIF_SUPPORTED = False

SUPPORTED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".bmp",
    ".tiff",
    ".tif",
    ".heic",
    ".heif",
}

# Build reverse lookup for EXIF tag names
_EXIF_TAGS = {v: k for k, v in ExifTags.TAGS.items()}
_DATE_TAG_IDS = [
    _EXIF_TAGS.get("DateTimeOriginal", 36867),
    _EXIF_TAGS.get("DateTimeDigitized", 36868),
    _EXIF_TAGS.get("DateTime", 306),
]

# Match dates in filenames such as IMG_20250412_183022.jpg or 2025-04-12.png
_FILENAME_DATE_RE = re.compile(
    r"(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])"
    r"(?:[-_ T]?([01]\d|2[0-3])[-_.]?([0-5]\d)(?:[-_.]?([0-5]\d))?)?(?!\d)"
)


def is_supported_image(path: Path) -> bool:
    return path.is_file() and not path.name.startswith(".") and path.suffix.lower() in SUPPORTED_EXTENSIONS


def scan_folder(folder: str | Path, recursive: bool = False) -> list[Path]:
    """Return all supported image paths in a directory."""
    root = Path(folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"文件夹不存在: {root}")

    iterator: Iterable[Path] = root.rglob("*") if recursive else root.iterdir()
    files = [p for p in iterator if is_supported_image(p)]
    files.sort(key=lambda p: p.name.lower())
    return files


def load_rgb_image(path: str | Path, max_side: int | None = None) -> Image.Image:
    """Open an image (including HEIC), apply EXIF transpose, convert to RGB."""
    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")
        if max_side and max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        return img.copy()


def _parse_exif_datetime(raw: str) -> datetime | None:
    raw = str(raw).strip().replace("\x00", "")
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y:%m:%d"):
        try:
            dt = datetime.strptime(raw[:19], fmt)
            if 2000 <= dt.year <= 2100:
                return dt
        except ValueError:
            continue
    return None


def extract_image_metadata(path: str | Path) -> tuple[int, int, float, str, str]:
    """Return (width, height, timestamp, date_str 'YYYY.MM.DD', date_source)."""
    p = Path(path)
    dt: datetime | None = None
    source = "mtime"

    with Image.open(p) as img:
        exif = img.getexif()
        # Account for EXIF orientation tag (274) when reporting visual width/height
        orientation = exif.get(274, 1) if exif else 1
        w, h = img.size
        if orientation in (5, 6, 7, 8):
            w, h = h, w

        if exif:
            # Check primary IFD and Exif sub-IFD (34665)
            sub_ifd = exif.get_ifd(0x8769) if hasattr(exif, "get_ifd") else {}
            for tag_id in _DATE_TAG_IDS:
                val = sub_ifd.get(tag_id) if isinstance(sub_ifd, dict) else None
                if not val:
                    val = exif.get(tag_id)
                if val:
                    parsed = _parse_exif_datetime(str(val))
                    if parsed:
                        dt = parsed
                        source = "exif"
                        break

    if dt is None:
        m = _FILENAME_DATE_RE.search(p.stem)
        if m:
            year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
            hour = int(m.group(4)) if m.group(4) else 12
            minute = int(m.group(5)) if m.group(5) else 0
            second = int(m.group(6)) if m.group(6) else 0
            try:
                dt = datetime(year, month, day, hour, minute, second)
                source = "filename"
            except ValueError:
                dt = None

    if dt is None:
        stat = os.stat(p)
        ts = getattr(stat, "st_birthtime", None) or stat.st_mtime
        dt = datetime.fromtimestamp(ts)
        source = "mtime"

    return w, h, dt.timestamp(), dt.strftime("%Y.%m.%d"), source
