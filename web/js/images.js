/** Browser-side image loading (JPG/PNG/WEBP/HEIC), EXIF orientation, and capture date extraction. */

import exifr from "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.js";

const SUPPORTED_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
  ".avif",
]);

const FILENAME_DATE_RE =
  /(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T]?([01]\d|2[0-3])[-_.]?([0-5]\d)(?:[-_.]?([0-5]\d))?)?(?!\d)/;

let heic2anyPromise = null;

function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (!heic2anyPromise) {
    heic2anyPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => reject(new Error("HEIC decoder failed to load"));
      document.head.appendChild(s);
    });
  }
  return heic2anyPromise;
}

export function isSupportedFile(file) {
  if (!file || !file.name || file.name.startsWith(".")) return false;
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SUPPORTED_EXTS.has(lower.slice(dot))) return true;
  return (file.type || "").startsWith("image/");
}

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

export async function extractCaptureDate(file) {
  // 1. Try EXIF (works for both JPEG and iPhone HEIC!)
  try {
    const meta = await exifr.parse(file, {
      pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"],
    });
    const dt = meta?.DateTimeOriginal || meta?.CreateDate || meta?.ModifyDate;
    if (dt instanceof Date && !Number.isNaN(dt.getTime()) && dt.getFullYear() >= 2000 && dt.getFullYear() <= 2100) {
      return {
        timestamp: dt.getTime() / 1000,
        dateStr: formatDateYMD(dt),
        dateSource: "exif",
      };
    }
  } catch {
    // Ignore EXIF read failures and fall back cleanly
  }

  // 2. Fallback to date pattern in filename (e.g., IMG_20250512_183022.jpg)
  const m = FILENAME_DATE_RE.exec(file.name);
  if (m) {
    const dt = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      m[4] ? Number(m[4]) : 12,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0
    );
    if (!Number.isNaN(dt.getTime())) {
      return {
        timestamp: dt.getTime() / 1000,
        dateStr: formatDateYMD(dt),
        dateSource: "filename",
      };
    }
  }

  // 3. Fallback to file lastModified
  const dt = new Date(file.lastModified || Date.now());
  return {
    timestamp: dt.getTime() / 1000,
    dateStr: formatDateYMD(dt),
    dateSource: "mtime",
  };
}

/**
 * Decode a File (including iPhone HEIC) into an EXIF-oriented HTMLCanvasElement / ImageBitmap
 * capped at `maxSide` so dozens of 12MP iPhone photos stay lightweight and fast in browser memory.
 */
export async function decodeImageFile(file, maxSide = 1600) {
  let blob = file;
  let bitmap = null;

  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    // If browser cannot natively decode HEIC/HEIF (e.g. desktop Chrome), convert locally via heic2any
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".heic") || lower.endsWith(".heif") || (file.type || "").includes("heic") || (file.type || "").includes("heif")) {
      const heic2any = await loadHeic2Any();
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      blob = Array.isArray(converted) ? converted[0] : converted;
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } else {
      throw new Error(`Unsupported or corrupted image: ${file.name}`);
    }
  }

  const origW = bitmap.width;
  const origH = bitmap.height;
  let w = origW;
  let h = origH;

  if (Math.max(w, h) > maxSide) {
    const ratio = maxSide / Math.max(w, h);
    w = Math.max(1, Math.round(w * ratio));
    h = Math.max(1, Math.round(h * ratio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // Also generate a compact source thumbnail for the right-panel candidate picker
  const thumbMax = 440;
  const tScale = Math.min(1, thumbMax / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * tScale));
  const th = Math.max(1, Math.round(h * tScale));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = tw;
  thumbCanvas.height = th;
  thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, tw, th);
  const sourceThumbUrl = thumbCanvas.toDataURL("image/jpeg", 0.82);

  return { canvas, width: w, height: h, sourceThumbUrl };
}
