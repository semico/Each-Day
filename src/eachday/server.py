"""FastAPI backend for EachDay interactive alignment studio."""

from __future__ import annotations

import hashlib
import io
import subprocess
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from eachday.aligner import (
    BodyProportions,
    analyze_batch,
    compute_candidate_transform,
    render_aligned_frame,
)
from eachday.images import extract_image_metadata, is_supported_image, load_rgb_image, scan_folder
from eachday.models import PhotoItem, RenderSettings
from eachday.photos_app import (
    export_photos_album,
    is_macos,
    list_photos_albums,
    pick_folder_dialog,
)
from eachday.video import export_timelapse_video

STATIC_DIR = Path(__file__).parent / "static"


class _ImageCache:
    """Thread-safe bounded LRU cache of EXIF-transposed RGB images for snappy previews."""

    def __init__(self, max_items: int = 80) -> None:
        self._max = max_items
        self._lock = threading.Lock()
        self._data: OrderedDict[tuple[str, int | None], Image.Image] = OrderedDict()

    def get(self, path: str, max_side: int | None = 1400) -> Image.Image:
        key = (path, max_side)
        with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
                return self._data[key]
        img = load_rgb_image(path, max_side=max_side)
        with self._lock:
            self._data[key] = img
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)
        return img

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


class ProjectSession:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.source_label: str = ""
        self.source_dir: Path | None = None
        self.items: list[PhotoItem] = []
        self.proportions: BodyProportions = BodyProportions()
        self.settings: RenderSettings = RenderSettings()
        self.cache = _ImageCache(max_items=100)
        self.status: dict[str, Any] = {
            "state": "idle",
            "current": 0,
            "total": 0,
            "message": "",
            "error": None,
            "last_export": None,
        }
        self._version = 0

    def set_status(
        self,
        state: str,
        current: int = 0,
        total: int = 0,
        message: str = "",
        error: str | None = None,
        last_export: dict[str, Any] | None = None,
    ) -> None:
        with self.lock:
            self.status["state"] = state
            self.status["current"] = current
            self.status["total"] = total
            self.status["message"] = message
            self.status["error"] = error
            if last_export is not None:
                self.status["last_export"] = last_export

    def get_item(self, item_id: str) -> tuple[int, PhotoItem]:
        with self.lock:
            for idx, it in enumerate(self.items):
                if it.id == item_id:
                    return idx, it
        raise HTTPException(status_code=404, detail=f"找不到照片: {item_id}")

    def enabled_sequence_info(self, item_id: str) -> tuple[int, float]:
        with self.lock:
            enabled = [it for it in self.items if it.enabled]
            if not enabled:
                return 1, time.time()
            first_ts = enabled[0].timestamp
            seq = 1
            for idx, it in enumerate(enabled):
                if it.id == item_id:
                    seq = idx + 1
                    break
            else:
                # If currently disabled, compute approximate rank by timestamp
                target = next((it for it in self.items if it.id == item_id), None)
                if target:
                    seq = sum(1 for it in enabled if it.timestamp <= target.timestamp) + 1
            return seq, first_ts

    def load_paths_and_analyze(self, files: list[Path], source_label: str, source_dir: Path | None) -> None:
        with self.lock:
            if self.status["state"] in ("importing", "analyzing", "exporting"):
                raise HTTPException(status_code=409, detail="当前有任务正在进行，请稍候。")
            self._version += 1
            run_version = self._version
            self.source_label = source_label
            self.source_dir = source_dir
            self.items = []
            self.cache.clear()
            self.set_status("analyzing", 0, len(files), "读取照片信息与拍摄日期...")

        def worker() -> None:
            try:
                loaded: list[PhotoItem] = []
                total = len(files)
                for i, path in enumerate(files):
                    self.set_status("analyzing", i, total, f"读取 EXIF ({i + 1}/{total}): {path.name}")
                    try:
                        w, h, ts, date_str, date_src = extract_image_metadata(path)
                        item_id = hashlib.md5(str(path).encode("utf-8")).hexdigest()[:12]
                        loaded.append(
                            PhotoItem(
                                id=item_id,
                                filename=path.name,
                                path=str(path),
                                width=w,
                                height=h,
                                timestamp=ts,
                                date_str=date_str,
                                date_source=date_src,
                            )
                        )
                    except Exception:
                        continue

                loaded.sort(key=lambda it: (it.timestamp, it.filename.lower()))

                def on_progress(cur: int, tot: int, msg: str) -> None:
                    self.set_status("analyzing", cur, tot, msg)

                proportions = analyze_batch(loaded, progress_cb=on_progress)

                with self.lock:
                    if self._version != run_version:
                        return
                    self.items = loaded
                    self.proportions = proportions
                    self.set_status("idle", len(loaded), len(loaded), f"已完成 {len(loaded)} 张照片对齐分析")
            except Exception as exc:
                self.set_status("idle", 0, 0, "分析出错", error=str(exc))

        threading.Thread(target=worker, daemon=True).start()


session = ProjectSession()

app = FastAPI(title="EachDay - 健身打卡主体对齐视频工具")
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class FolderImportRequest(BaseModel):
    folder: str
    recursive: bool = False


class AlbumImportRequest(BaseModel):
    album_name: str


class SettingsPatch(BaseModel):
    aspect_ratio: str | None = None
    resolution: str | None = None
    zoom: float | None = None
    vertical_shift: float | None = None
    auto_level: bool | None = None
    fill_mode: str | None = None
    show_watermark: bool | None = None
    watermark_style: str | None = None
    watermark_position: str | None = None
    fps: float | None = None
    hold_last_sec: float | None = None
    crossfade: bool | None = None


class ItemPatch(BaseModel):
    enabled: bool | None = None
    selected_candidate: int | None = None
    user_dx: float | None = None
    user_dy: float | None = None
    user_scale: float | None = None
    user_angle_deg: float | None = None
    reset_transform: bool = False


class SortRequest(BaseModel):
    mode: str = "date_asc"


class ExportRequest(BaseModel):
    output_dir: str | None = None
    filename: str | None = None


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    index_file = STATIC_DIR / "index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>EachDay UI not found</h1>", status_code=500)
    return HTMLResponse(index_file.read_text(encoding="utf-8"))


@app.get("/api/state")
def get_state() -> dict[str, Any]:
    with session.lock:
        return {
            "macos": is_macos(),
            "source_label": session.source_label,
            "items": [it.to_dict() for it in session.items],
            "settings": session.settings.to_dict(),
            "status": dict(session.status),
        }


@app.get("/api/status")
def get_status() -> dict[str, Any]:
    with session.lock:
        return dict(session.status)


@app.post("/api/pick-folder")
def api_pick_folder() -> dict[str, Any]:
    chosen = pick_folder_dialog()
    return {"path": chosen}


@app.post("/api/import/folder")
def api_import_folder(req: FolderImportRequest) -> dict[str, Any]:
    folder = Path(req.folder).expanduser().resolve()
    try:
        files = scan_folder(folder, recursive=req.recursive)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not files:
        raise HTTPException(status_code=400, detail="该文件夹下未找到支持的照片格式（JPG/PNG/HEIC/WEBP）。")

    session.load_paths_and_analyze(files, source_label=str(folder), source_dir=folder)
    return {"ok": True, "count": len(files)}


@app.post("/api/import/upload")
async def api_import_upload(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    if not files:
        raise HTTPException(status_code=400, detail="未选择任何文件。")

    upload_root = Path(tempfile.gettempdir()) / "eachday_uploads"
    upload_root.mkdir(parents=True, exist_ok=True)
    batch_dir = Path(tempfile.mkdtemp(prefix="batch_", dir=upload_root))

    saved: list[Path] = []
    for f in files:
        name = Path(f.filename or "photo.jpg").name
        dest = batch_dir / name
        content = await f.read()
        dest.write_bytes(content)
        if is_supported_image(dest):
            saved.append(dest)

    if not saved:
        raise HTTPException(status_code=400, detail="上传的文件中没有支持的图片格式（JPG/PNG/HEIC/WEBP）。")

    session.load_paths_and_analyze(saved, source_label=f"已上传 {len(saved)} 张照片", source_dir=batch_dir)
    return {"ok": True, "count": len(saved)}


@app.get("/api/photos/albums")
def api_list_photos_albums() -> dict[str, Any]:
    try:
        albums = list_photos_albums()
        return {"albums": albums}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/import/photos-album")
def api_import_photos_album(req: AlbumImportRequest) -> dict[str, Any]:
    album = req.album_name.strip()
    if not album:
        raise HTTPException(status_code=400, detail="请提供相簿名称。")
    with session.lock:
        if session.status["state"] in ("importing", "analyzing", "exporting"):
            raise HTTPException(status_code=409, detail="当前有任务正在进行，请稍候。")
        session.set_status("importing", 0, 0, f"正在从 macOS「照片」导出相簿「{album}」...")

    def worker() -> None:
        try:
            out_dir = export_photos_album(album)
            files = scan_folder(out_dir, recursive=True)
            if not files:
                session.set_status("idle", 0, 0, "", error=f"相簿「{album}」中未导出到可用照片。")
                return
            # Reset state to idle briefly so load_paths_and_analyze can take over cleanly
            session.set_status("idle", 0, 0, "")
            session.load_paths_and_analyze(files, source_label=f"照片相簿: {album}", source_dir=out_dir)
        except Exception as exc:
            session.set_status("idle", 0, 0, "", error=str(exc))

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True}


@app.post("/api/settings")
def api_update_settings(patch: SettingsPatch) -> dict[str, Any]:
    with session.lock:
        s = session.settings
        if patch.aspect_ratio in ("9:16", "3:4", "4:5", "1:1"):
            s.aspect_ratio = patch.aspect_ratio  # type: ignore[assignment]
        if patch.resolution in ("720p", "1080p"):
            s.resolution = patch.resolution  # type: ignore[assignment]
        if patch.zoom is not None:
            s.zoom = max(0.55, min(1.8, float(patch.zoom)))
        if patch.vertical_shift is not None:
            s.vertical_shift = max(-0.22, min(0.22, float(patch.vertical_shift)))
        if patch.auto_level is not None:
            s.auto_level = bool(patch.auto_level)
        if patch.fill_mode in ("blur", "black", "edge"):
            s.fill_mode = patch.fill_mode  # type: ignore[assignment]
        if patch.show_watermark is not None:
            s.show_watermark = bool(patch.show_watermark)
        if patch.watermark_style in ("day_date", "count_date", "date_only", "day_only"):
            s.watermark_style = patch.watermark_style  # type: ignore[assignment]
        if patch.watermark_position in ("bottom_left", "bottom_center", "top_left", "top_right"):
            s.watermark_position = patch.watermark_position  # type: ignore[assignment]
        if patch.fps is not None:
            s.fps = max(1.0, min(20.0, float(patch.fps)))
        if patch.hold_last_sec is not None:
            s.hold_last_sec = max(0.0, min(5.0, float(patch.hold_last_sec)))
        if patch.crossfade is not None:
            s.crossfade = bool(patch.crossfade)
        return s.to_dict()


@app.patch("/api/items/{item_id}")
def api_patch_item(item_id: str, patch: ItemPatch) -> dict[str, Any]:
    with session.lock:
        _, item = session.get_item(item_id)
        if patch.enabled is not None:
            item.enabled = bool(patch.enabled)
        if patch.selected_candidate is not None:
            if 0 <= patch.selected_candidate < len(item.candidates):
                item.selected_candidate = patch.selected_candidate
                # Recompute automatic transform for newly selected person and clear manual tweaks
                item.transform.user_dx = 0.0
                item.transform.user_dy = 0.0
                item.transform.user_scale = 1.0
                item.transform.user_angle_deg = 0.0
                item.transform = compute_candidate_transform(
                    item, item.candidates[item.selected_candidate], session.proportions
                )
        if patch.reset_transform:
            item.transform.user_dx = 0.0
            item.transform.user_dy = 0.0
            item.transform.user_scale = 1.0
            item.transform.user_angle_deg = 0.0
        else:
            if patch.user_dx is not None:
                item.transform.user_dx = max(-0.5, min(0.5, float(patch.user_dx)))
            if patch.user_dy is not None:
                item.transform.user_dy = max(-0.5, min(0.5, float(patch.user_dy)))
            if patch.user_scale is not None:
                item.transform.user_scale = max(0.4, min(2.5, float(patch.user_scale)))
            if patch.user_angle_deg is not None:
                item.transform.user_angle_deg = max(-45.0, min(45.0, float(patch.user_angle_deg)))
        return item.to_dict()


@app.post("/api/items/reorder")
def api_reorder_items(req: SortRequest) -> dict[str, Any]:
    with session.lock:
        if req.mode == "date_desc":
            session.items.sort(key=lambda it: (it.timestamp, it.filename.lower()), reverse=True)
        elif req.mode == "filename_asc":
            session.items.sort(key=lambda it: it.filename.lower())
        else:
            session.items.sort(key=lambda it: (it.timestamp, it.filename.lower()))
        return {"items": [it.to_dict() for it in session.items]}


@app.get("/api/items/{item_id}/preview")
def api_item_preview(
    item_id: str,
    w: int = Query(default=480, ge=120, le=1080),
    guides: bool = Query(default=False),
) -> Response:
    _, item = session.get_item(item_id)
    with session.lock:
        settings = session.settings
        cw, ch = settings.canvas_size()
        scale = w / cw
        pw = max(120, int(round(cw * scale)))
        ph = max(120, int(round(ch * scale)))
        seq, first_ts = session.enabled_sequence_info(item_id)

    # Load cached source image (up to 1400px for snappy interactive preview; adjust transform if downscaled)
    src_img = session.cache.get(item.path, max_side=1400)
    sw, sh = src_img.size
    if sw != item.width and item.width > 0:
        ratio = sw / item.width
        # Create a shallow copy of PhotoItem with transform scaled to cached image coordinates
        from copy import deepcopy

        scaled_item = deepcopy(item)
        scaled_item.transform.src_cx *= ratio
        scaled_item.transform.src_cy *= ratio
        scaled_item.transform.scale /= ratio
    else:
        scaled_item = item

    frame = render_aligned_frame(
        scaled_item,
        settings=settings,
        sequence_index=seq,
        first_timestamp=first_ts,
        canvas_size_override=(pw, ph),
        draw_guides=guides,
        src_img_override=src_img,
    )

    buf = io.BytesIO()
    Image.fromarray(frame).save(buf, format="JPEG", quality=86)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


@app.get("/api/items/{item_id}/source")
def api_item_source(item_id: str, max_side: int = Query(default=720, ge=200, le=1400)) -> Response:
    _, item = session.get_item(item_id)
    src_img = session.cache.get(item.path, max_side=max_side)
    buf = io.BytesIO()
    src_img.save(buf, format="JPEG", quality=85)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


@app.post("/api/export")
def api_export_video(req: ExportRequest) -> dict[str, Any]:
    with session.lock:
        if session.status["state"] in ("importing", "analyzing", "exporting"):
            raise HTTPException(status_code=409, detail="当前有任务正在进行，请稍候。")
        enabled = [it for it in session.items if it.enabled]
        if not enabled:
            raise HTTPException(status_code=400, detail="没有启用的照片，无法导出视频。")

        if req.output_dir:
            out_dir = Path(req.output_dir).expanduser().resolve()
        elif session.source_dir and session.source_dir.exists() and "eachday_" not in str(session.source_dir):
            out_dir = session.source_dir
        else:
            out_dir = Path.home() / "Downloads"

        stamp = time.strftime("%Y%m%d_%H%M%S")
        fname = (req.filename or f"eachday_gym_{stamp}.mp4").strip()
        if not fname.lower().endswith(".mp4"):
            fname += ".mp4"
        out_path = out_dir / fname

        items_snapshot = list(session.items)
        settings_snapshot = RenderSettings(**{k: getattr(session.settings, k) for k in session.settings.__dataclass_fields__})
        session.set_status("exporting", 0, len(enabled), "准备导出视频...")

    def worker() -> None:
        try:
            def on_progress(cur: int, tot: int, msg: str) -> None:
                session.set_status("exporting", cur, tot, msg)

            exported = export_timelapse_video(
                items_snapshot,
                settings_snapshot,
                out_path,
                progress_cb=on_progress,
            )
            size_mb = round(exported.stat().st_size / (1024 * 1024), 2)
            session.set_status(
                "idle",
                len(enabled),
                len(enabled),
                f"导出完成: {exported.name} ({size_mb} MB)",
                last_export={
                    "path": str(exported),
                    "filename": exported.name,
                    "size_mb": size_mb,
                    "timestamp": time.time(),
                },
            )
        except Exception as exc:
            session.set_status("idle", 0, 0, "导出失败", error=str(exc))

    threading.Thread(target=worker, daemon=True).start()
    return {"ok": True, "output_path": str(out_path)}


@app.get("/api/export/download")
def api_download_export() -> FileResponse:
    with session.lock:
        last = session.status.get("last_export")
    if not last or not Path(last["path"]).exists():
        raise HTTPException(status_code=404, detail="尚未生成视频文件。")
    return FileResponse(last["path"], media_type="video/mp4", filename=last["filename"])


@app.post("/api/export/reveal")
def api_reveal_export() -> dict[str, Any]:
    with session.lock:
        last = session.status.get("last_export")
    if not last or not Path(last["path"]).exists():
        raise HTTPException(status_code=404, detail="尚未生成视频文件。")
    if is_macos():
        subprocess.Popen(["open", "-R", last["path"]])
    return {"ok": True, "path": last["path"]}
