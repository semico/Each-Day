<div align="center">

# EachDay

**Turn your daily photos into rock-steady timelapse videos — 100% locally in your browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Try Online: 100% Local](https://img.shields.io/badge/Live%20Web%20App-100%25%20Local%20%2F%20Zero%20Upload-10b981.svg)](https://semico.github.io/Each-Day/)
[![Python 3.10–3.12](https://img.shields.io/badge/Python-3.10%E2%80%933.12-3776AB.svg)](https://www.python.org/)

English | [简体中文](README.zh-CN.md)

</div>

---

> ### 🌐 Try It Instantly in Your Browser — 100% Local & Private
> **[Open EachDay Web Studio →](https://semico.github.io/Each-Day/)**
>
> **Zero uploads. Zero backend.** AI alignment (`YOLO11-Pose` via ONNX Runtime Web), face privacy stickers/blur, Before/After card generation, and MP4 encoding all run **100% locally inside your browser**. Your photos never leave your device—you can even disconnect Wi-Fi after loading the page.

Documenting **gym progress, daily selfies ("Photo a Day"), baby growth, OOTD outfits, pregnancy, skincare, pets, houseplants, or room renovations**? **EachDay** aligns every photo to the exact same scale, position, and angle, then exports a crisp H.264 MP4 timelapse or Before/After comparison card—all running **100% locally**.

<p align="center">
  <img src="docs/demo.gif" alt="EachDay aligned progress timelapse studio demo" width="640" />
</p>

## Features

- **4 Universal Alignment Modes + 1-Click Subject Auto-Tracking**
  - **🏋️ Body / Full-Body Mode** — Self-calibrating head/shoulder/torso alignment for gym progress, OOTD, pregnancy, and kids' height growth.
  - **🤳 Face / Eye-Line Mode** — Locks both eyes to the exact same horizontal line and scale across years of daily selfies, baby growth, skincare, braces, or haircut/beard changes.
  - **🐾 Pets / Plants / 80+ Objects Mode (`YOLO11n`)** — Automatically detects 80 everyday subject categories (dogs, cats, birds, potted plants, cups, cars, laptops, furniture, etc.) **or draw a custom box around ANY subject** (LEGO, painting, sourdough jar, watch) in one photo and click **🎯 Auto-Track Across All Photos** to track and align it across every frame automatically!
  - **🎯 2-Point Precision Mode** — Click any two reference points (`A → B`) for exact geometric alignment of rooms, renovations, or art.
  - **Cross-Photo Subject Lock**: In Body, Face, or Object mode, click any subject in one photo and hit **Auto-Track Across All Photos** to lock onto that exact person/pet/object across the entire sequence.
- **One-Click Automatic Face Privacy Mask & Stickers**  
  Auto-tracks faces across every frame to apply 14 built-in emoji stickers, **any custom typed emoji/text badge**, **any uploaded image/PNG sticker**, smooth blur, or pixelation to **your own face** and/or **background bystanders**—ready to share safely on social media.
- **One-Click Auto Exposure & Color Consistency Match**  
  Normalizes brightness and white balance across photos taken under different lighting conditions—matching either the **Batch Median** or **any chosen Reference Photo**—with soft highlight roll-off and adjustable strength.
- **Rich Local Export Formats (MP4 + GIF + Wipe Video + Grid Poster)**  
  - **H.264 MP4 Timelapse** (`9:16`, `3:4`, `4:5`, `1:1`, **`4:3`**, **`16:9`**; `1080p`/`720p`) with optional **Local BGM Audio (`MP3/M4A/WAV`) & BPM Beat-Sync** muxed straight into the MP4
  - **Animated GIF Export** (pure in-browser quantized GIF, ready for GitHub, WeChat, Discord & Notion)
  - **Before / After Side-by-Side PNG & Animated Curtain Wipe MP4**
  - **Progress Grid Collage Poster PNG** (`2×2`, `3×2`, `3×3`, `4×3` gallery layout with custom title & date span)
- **Built for Everyday Polish & Offline Use (PWA)**  
  - Offline-first **EXIF capture date reader** (JPEG / iPhone HEIC / PNG / WebP) + **manual date editor**, **Undo/Redo** (`Cmd/Ctrl+Z`), drag-to-reorder filmstrip, starred milestone frames (`M`), and **`.eachday.json`** project save/resume
  - **1-Click Sample Demo** for instant zero-setup tryout + **Installable Offline PWA** (add to desktop/home screen and run completely offline)
  - Optional local Python desktop version also supports direct **macOS Photos app album** import and headless CLI batch export.

## Installation

Requires **Python 3.10–3.12** and [`uv`](https://docs.astral.sh/uv/).

```bash
git clone https://github.com/semico/Each-Day.git
cd Each-Day
uv sync --python 3.10
```

> On first run, the lightweight `yolo11n-pose.pt` (~6 MB) pose model is automatically downloaded into `models/` and cached for offline use.

## Quick Start

### 1. Launch the Local Web Studio (Recommended)

```bash
uv run eachday
```

This starts the local studio at `http://127.0.0.1:8765` and opens it in your browser automatically.

You can also pre-load a folder on startup:

```bash
uv run eachday --folder ~/Pictures/Gym
```

### 2. Headless CLI Mode (Optional)

Run full auto-alignment and video export directly from the terminal without opening the browser:

```bash
uv run eachday --headless \
  --folder ~/Pictures/Gym \
  --output gym_progress.mp4 \
  --aspect 9:16 \
  --resolution 1080p \
  --fps 6
```

<details>
<summary>All CLI options</summary>

| Flag | Default | Description |
| --- | --- | --- |
| `-f, --folder` | — | Path to a local photo folder to load |
| `-r, --recursive` | `false` | Recursively scan subfolders |
| `-p, --port` | `8765` | Local web server port |
| `--no-browser` | `false` | Start the web server without auto-opening the browser |
| `--headless` | `false` | Skip web UI and export video directly |
| `-o, --output` | auto | Output `.mp4` path (headless mode) |
| `--aspect` | `9:16` | Aspect ratio: `9:16`, `3:4`, `4:5`, `1:1` |
| `--resolution` | `1080p` | Output resolution: `1080p`, `720p` |
| `--fps` | `6.0` | Photos per second |
| `--fill` | `blur` | Edge fill mode: `blur`, `black`, `edge` |
| `--no-watermark` | `false` | Disable date/day watermark overlay |
| `--crossfade` | `false` | Enable smooth crossfade between consecutive photos |

</details>

## Studio Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `←` / `→` | Previous / Next photo |
| `Space` | Play / Pause live timelapse preview |
| `G` | Toggle alignment guide lines |
| `O` | Toggle onion-skin overlay (compare with previous frame) |
| `X` | Include / Skip current frame |
| Drag / Scroll on preview | Fine-tune current frame position & zoom |

## macOS Photos App Import

Click **照片 App 相簿 (Photos Albums)** in the studio header to browse albums directly from the macOS Photos app and export originals with EXIF dates intact. On first use, macOS will ask for Automation permission to access Photos.

> Tip: Create a dedicated album (e.g., `Gym`) in macOS Photos and drop your post-workout photos into it for one-click imports.

## Privacy

All pose detection, image processing, and video encoding run **100% locally** on your computer. Your photos are never uploaded to any external server.

## License

Released under the [MIT License](LICENSE). Copyright © 2026 Yubo.
