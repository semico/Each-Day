"""H.264 MP4 video generation using bundled imageio-ffmpeg binary."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Callable

import imageio_ffmpeg
import numpy as np

from eachday.aligner import render_aligned_frame
from eachday.models import PhotoItem, RenderSettings


def export_timelapse_video(
    items: list[PhotoItem],
    settings: RenderSettings,
    output_path: str | Path,
    progress_cb: Callable[[int, int, str], None] | None = None,
) -> Path:
    """Render aligned frames and encode a crisp, universally playable H.264 MP4 video."""
    enabled_items = [it for it in items if it.enabled]
    if not enabled_items:
        raise ValueError("没有可导出的照片，请至少启用一张照片。")

    out_path = Path(output_path).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    canvas_w, canvas_h = settings.canvas_size()
    # Ensure even dimensions for yuv420p H.264
    canvas_w -= canvas_w % 2
    canvas_h -= canvas_h % 2

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    photo_fps = max(1.0, min(24.0, float(settings.fps)))

    # Output stream at 30fps so crossfades and hold-last-frame timing are silky smooth
    stream_fps = 30
    frames_per_photo = max(1, int(round(stream_fps / photo_fps)))
    blend_frames = max(1, min(frames_per_photo // 2, 4)) if settings.crossfade and frames_per_photo >= 3 else 0
    hold_extra_frames = max(0, int(round(settings.hold_last_sec * stream_fps)))

    cmd = [
        ffmpeg_exe,
        "-y",
        "-f",
        "rawvideo",
        "-vcodec",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{canvas_w}x{canvas_h}",
        "-r",
        str(stream_fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(out_path),
    ]

    first_ts = enabled_items[0].timestamp
    total = len(enabled_items)

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None

    prev_frame: np.ndarray | None = None
    try:
        for idx, item in enumerate(enabled_items):
            if progress_cb:
                progress_cb(idx, total, f"渲染视频帧 ({idx + 1}/{total}): {item.filename}")

            curr_frame = render_aligned_frame(
                item,
                settings=settings,
                sequence_index=idx + 1,
                first_timestamp=first_ts,
                canvas_size_override=(canvas_w, canvas_h),
            )

            if prev_frame is not None and blend_frames > 0:
                # Crossfade from prev_frame into curr_frame
                for b in range(1, blend_frames + 1):
                    alpha = b / (blend_frames + 1)
                    blended = (
                        prev_frame.astype(np.float32) * (1.0 - alpha)
                        + curr_frame.astype(np.float32) * alpha
                    ).astype(np.uint8)
                    proc.stdin.write(blended.tobytes())
                solid_count = max(1, frames_per_photo - blend_frames)
            else:
                solid_count = frames_per_photo

            raw_bytes = curr_frame.tobytes()
            for _ in range(solid_count):
                proc.stdin.write(raw_bytes)

            prev_frame = curr_frame

        # Hold the final frame nicely at the end
        if prev_frame is not None and hold_extra_frames > 0:
            raw_bytes = prev_frame.tobytes()
            for _ in range(hold_extra_frames):
                proc.stdin.write(raw_bytes)

        proc.stdin.close()
        stderr_out = proc.stderr.read().decode("utf-8", errors="ignore") if proc.stderr else ""
        ret = proc.wait(timeout=180)
        if ret != 0:
            raise RuntimeError(f"FFmpeg 编码失败 (code {ret}): {stderr_out[-400:]}")
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
        raise

    if progress_cb:
        progress_cb(total, total, f"视频导出完成: {out_path.name}")
    return out_path
