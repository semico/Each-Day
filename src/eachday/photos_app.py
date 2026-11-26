"""macOS Photos app integration via AppleScript (osascript)."""

from __future__ import annotations

import platform
import subprocess
import tempfile
from pathlib import Path


def is_macos() -> bool:
    return platform.system() == "Darwin"


def _run_applescript(script: str, timeout: int = 120) -> str:
    if not is_macos():
        raise RuntimeError("仅 macOS 支持读取「照片」App 相簿")

    proc = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout).strip()
        if "-1743" in err or "Not authorized" in err or "不允许" in err:
            raise PermissionError(
                "未获得访问「照片」App 的权限。请在 系统设置 -> 隐私与安全性 -> 自动化 中允许终端访问「照片」。"
            )
        raise RuntimeError(f"调用 macOS「照片」App 失败: {err}")
    return proc.stdout.strip()


def list_photos_albums() -> list[dict[str, object]]:
    """Return a list of user albums from macOS Photos app with photo counts."""
    script = """
tell application "Photos"
    set outLines to {}
    repeat with a in albums
        try
            set aName to name of a
            set aCount to count of media items of a
            if aCount > 0 then
                set end of outLines to aName & "\t" & (aCount as text)
            end if
        end try
    end repeat
    set AppleScript's text item delimiters to linefeed
    return outLines as text
end tell
"""
    raw = _run_applescript(script, timeout=30)
    albums: list[dict[str, object]] = []
    if not raw:
        return albums

    seen: set[str] = set()
    for line in raw.splitlines():
        if "\t" not in line:
            continue
        name, count_str = line.rsplit("\t", 1)
        name = name.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        try:
            count = int(count_str.strip())
        except ValueError:
            count = 0
        albums.append({"name": name, "count": count})

    albums.sort(key=lambda x: (-int(x["count"]), str(x["name"]).lower()))
    return albums


def export_photos_album(album_name: str, dest_dir: str | Path | None = None) -> Path:
    """Export all images from a macOS Photos album to a local directory and return the path."""
    if dest_dir is None:
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in album_name)[:40] or "album"
        base = Path(tempfile.gettempdir()) / "eachday_photos_exports"
        base.mkdir(parents=True, exist_ok=True)
        out_dir = Path(tempfile.mkdtemp(prefix=f"{safe_name}_", dir=base))
    else:
        out_dir = Path(dest_dir).expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)

    escaped_album = album_name.replace("\\", "\\\\").replace('"', '\\"')
    escaped_dir = str(out_dir).replace("\\", "\\\\").replace('"', '\\"')

    script = f'''
tell application "Photos"
    set targetAlbum to album "{escaped_album}"
    set itemList to media items of targetAlbum
    if (count of itemList) is 0 then
        error "相簿中没有照片"
    end if
    export itemList to POSIX file "{escaped_dir}" with using originals
    return (count of itemList) as text
end tell
'''
    _run_applescript(script, timeout=300)
    return out_dir


def pick_folder_dialog() -> str | None:
    """Open native macOS Finder folder picker dialog and return selected path."""
    if not is_macos():
        return None
    script = """
try
    set chosenFolder to choose folder with prompt "选择存放健身照片的文件夹"
    return POSIX path of chosenFolder
on error number -128
    return ""
end try
"""
    proc = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return None
    result = proc.stdout.strip()
    return result if result else None
