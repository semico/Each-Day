"""CLI entrypoint for EachDay: launch interactive Web UI or run headless batch alignment."""

from __future__ import annotations

import argparse
import hashlib
import socket
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn

from eachday.aligner import analyze_batch
from eachday.images import extract_image_metadata, scan_folder
from eachday.models import PhotoItem, RenderSettings
from eachday.server import app, session
from eachday.video import export_timelapse_video


def _find_free_port(preferred: int = 8765) -> int:
    for port in (preferred, *range(8766, 8820)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return 0


def _run_headless(args: argparse.Namespace) -> None:
    folder = Path(args.folder).expanduser().resolve()
    files = scan_folder(folder, recursive=args.recursive)
    if not files:
        raise SystemExit(f"错误: 文件夹 {folder} 中未找到照片。")

    print(f"找到 {len(files)} 张照片，正在读取拍摄日期...")
    items: list[PhotoItem] = []
    for path in files:
        w, h, ts, date_str, date_src = extract_image_metadata(path)
        items.append(
            PhotoItem(
                id=hashlib.md5(str(path).encode()).hexdigest()[:12],
                filename=path.name,
                path=str(path),
                width=w,
                height=h,
                timestamp=ts,
                date_str=date_str,
                date_source=date_src,
            )
        )
    items.sort(key=lambda it: (it.timestamp, it.filename.lower()))

    analyze_batch(items, progress_cb=lambda i, n, m: print(f"[{i}/{n}] {m}"))

    settings = RenderSettings(
        aspect_ratio=args.aspect,
        resolution=args.resolution,
        fps=args.fps,
        fill_mode=args.fill,
        show_watermark=not args.no_watermark,
        crossfade=args.crossfade,
    )
    out = Path(args.output) if args.output else folder / f"eachday_gym_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
    exported = export_timelapse_video(items, settings, out, progress_cb=lambda i, n, m: print(f"[{i}/{n}] {m}"))
    print(f"\n视频已生成: {exported}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="eachday",
        description="EachDay — 自动对齐健身照片主体并生成延时视频",
    )
    parser.add_argument("--folder", "-f", type=str, default=None, help="启动时自动加载的照片文件夹路径")
    parser.add_argument("--recursive", "-r", action="store_true", help="递归扫描子文件夹")
    parser.add_argument("--port", "-p", type=int, default=8765, help="本地 Web 服务端口 (默认 8765)")
    parser.add_argument("--no-browser", action="store_true", help="启动服务但不自动打开浏览器")

    # Optional headless CLI mode
    parser.add_argument("--headless", action="store_true", help="纯命令行模式：直接对齐并导出视频，不启动网页界面")
    parser.add_argument("--output", "-o", type=str, default=None, help="headless 模式下的输出 MP4 路径")
    parser.add_argument("--aspect", choices=["9:16", "3:4", "4:5", "1:1", "4:3", "16:9"], default="9:16")
    parser.add_argument("--resolution", choices=["720p", "1080p"], default="1080p")
    parser.add_argument("--fps", type=float, default=6.0, help="每秒切换照片数 (默认 6)")
    parser.add_argument("--fill", choices=["blur", "black", "edge"], default="blur")
    parser.add_argument("--no-watermark", action="store_true", help="关闭日期/打卡天数水印")
    parser.add_argument("--crossfade", action="store_true", help="启用相邻帧淡入淡出过渡")

    args = parser.parse_args()

    if args.headless:
        if not args.folder:
            parser.error("--headless 模式必须指定 --folder")
        _run_headless(args)
        return

    if args.folder:
        folder = Path(args.folder).expanduser().resolve()
        files = scan_folder(folder, recursive=args.recursive)
        if files:
            session.register_startup_files(files, folder)

    port = _find_free_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print(f"\n  EachDay 本地工作台已启动: {url}\n  按 Ctrl+C 退出\n")

    if not args.no_browser:
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
