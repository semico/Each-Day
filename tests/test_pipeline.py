"""End-to-end verification tests for EachDay alignment, FastAPI routes (in-process ASGI), and MP4 export."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from eachday.aligner import analyze_batch, render_aligned_frame
from eachday.images import extract_image_metadata, scan_folder
from eachday.models import PhotoItem, RenderSettings
from eachday.server import app
from eachday.video import export_timelapse_video


def asgi_request(method: str, url: str, json_body: dict[str, Any] | None = None) -> tuple[int, dict[str, str], bytes]:
    """Call the FastAPI ASGI app directly in-process without opening any network sockets."""
    parts = urlsplit(url)
    body = json.dumps(json_body).encode("utf-8") if json_body is not None else b""
    headers = [(b"host", b"testserver")]
    if json_body is not None:
        headers.append((b"content-type", b"application/json"))
        headers.append((b"content-length", str(len(body)).encode()))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": parts.path,
        "raw_path": parts.path.encode(),
        "query_string": parts.query.encode(),
        "headers": headers,
        "client": ("127.0.0.1", 0),
        "server": ("testserver", 80),
    }

    sent_body = False
    status_code = 500
    resp_headers: dict[str, str] = {}
    chunks: list[bytes] = []

    async def receive() -> dict[str, Any]:
        nonlocal sent_body
        if not sent_body:
            sent_body = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        nonlocal status_code
        if message["type"] == "http.response.start":
            status_code = int(message["status"])
            for k, v in message.get("headers", []):
                resp_headers[k.decode().lower()] = v.decode()
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))

    asyncio.run(app(scope, receive, send))
    return status_code, resp_headers, b"".join(chunks)


def run_verification(sample_folder: Path, out_mp4: Path) -> None:
    files = scan_folder(sample_folder)
    assert len(files) >= 3, f"Expected sample images in {sample_folder}"

    # 1. Metadata & alignment batch test
    items: list[PhotoItem] = []
    for i, f in enumerate(files):
        w, h, ts, date_str, src = extract_image_metadata(f)
        items.append(
            PhotoItem(
                id=f"item_{i:02d}",
                filename=f.name,
                path=str(f),
                width=w,
                height=h,
                timestamp=ts + i * 86400,
                date_str=date_str,
                date_source=src,
            )
        )

    props = analyze_batch(items)
    detected_count = sum(1 for it in items if it.detected)
    assert detected_count == len(items), f"Expected all {len(items)} detected, got {detected_count}"
    assert 0.35 <= props.shoulder_to_torso <= 1.2

    # 2. Render frame checks (blur, black, edge, watermark)
    for fill in ("blur", "black", "edge"):
        frame = render_aligned_frame(
            items[0],
            RenderSettings(aspect_ratio="9:16", resolution="720p", fill_mode=fill),
            sequence_index=1,
            first_timestamp=items[0].timestamp,
            canvas_size_override=(360, 640),
        )
        assert frame.shape == (640, 360, 3)

    # 3. Export MP4 video test
    exported = export_timelapse_video(
        items,
        RenderSettings(aspect_ratio="9:16", resolution="720p", fps=6.0, crossfade=True),
        out_mp4,
    )
    assert exported.exists() and exported.stat().st_size > 10_000

    # 4. In-process FastAPI ASGI route end-to-end test
    code, _, data = asgi_request("GET", "/")
    assert code == 200 and b"EachDay" in data

    code, _, _ = asgi_request("POST", "/api/import/folder", {"folder": str(sample_folder)})
    assert code == 200

    for _ in range(160):
        code, _, raw = asgi_request("GET", "/api/status")
        st = json.loads(raw)
        if st["state"] == "idle":
            assert st["error"] is None, f"Analysis error: {st['error']}"
            break
        time.sleep(0.15)
    else:
        raise TimeoutError("Background analysis timed out")

    _, _, raw = asgi_request("GET", "/api/state")
    full_state = json.loads(raw)
    assert len(full_state["items"]) == len(files)
    first_id = full_state["items"][0]["id"]

    code, _, raw = asgi_request("POST", "/api/settings", {"aspect_ratio": "3:4", "zoom": 1.1, "fill_mode": "blur"})
    assert code == 200 and json.loads(raw)["aspect_ratio"] == "3:4"

    code, hdrs, prev_bytes = asgi_request("GET", f"/api/items/{first_id}/preview?w=360&guides=1")
    assert code == 200 and hdrs.get("content-type") == "image/jpeg" and len(prev_bytes) > 2000

    code, hdrs, src_bytes = asgi_request("GET", f"/api/items/{first_id}/source?max_side=400")
    assert code == 200 and hdrs.get("content-type") == "image/jpeg" and len(src_bytes) > 2000

    code, _, raw = asgi_request("PATCH", f"/api/items/{first_id}", {"user_dx": 0.05, "user_scale": 1.05})
    assert code == 200 and abs(json.loads(raw)["transform"]["user_dx"] - 0.05) < 1e-4

    code, _, _ = asgi_request(
        "POST",
        "/api/export",
        {"output_dir": str(out_mp4.parent), "filename": "api_test.mp4"},
    )
    assert code == 200
    for _ in range(160):
        _, _, raw = asgi_request("GET", "/api/status")
        st = json.loads(raw)
        if st["state"] == "idle":
            assert st["error"] is None, f"Export error: {st['error']}"
            assert st["last_export"] is not None
            break
        time.sleep(0.15)
    else:
        raise TimeoutError("Background export timed out")

    code, _, mp4_bytes = asgi_request("GET", "/api/export/download")
    assert code == 200 and len(mp4_bytes) > 10_000
    print(f"ALL VERIFICATION CHECKS PASSED! ({len(files)} images, API + MP4 verified)")


if __name__ == "__main__":
    tiles = Path("/Users/yubohu/.gemini/antigravity/brain/b0796300-7bc2-4d80-b857-fbd5db9831a6/scratch/grid_test/tiles")
    out = Path("/Users/yubohu/.gemini/antigravity/brain/b0796300-7bc2-4d80-b857-fbd5db9831a6/scratch/grid_test/verified_api.mp4")
    run_verification(tiles, out)
